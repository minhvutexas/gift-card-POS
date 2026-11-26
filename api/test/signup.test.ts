import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { one, pool, query, runAsSystem } from '../src/db.js';
import { DEMO_SLUG } from './helpers.js';

let app: Express;
beforeAll(() => {
  app = createApp();
});
afterAll(async () => {
  await pool.end();
});

const SLUG = `lotus-${Date.now().toString(36)}`;
const OWNER = `linh-${Date.now().toString(36)}`;
const signup = (over: Record<string, unknown> = {}) =>
  request(app)
    .post('/api/v1/signup')
    .send({ salon_name: 'Lotus Nails', slug: SLUG, owner_name: 'Linh', email: 'linh@example.com', username: OWNER, password: 'correct-horse-1', pin: '2468', ...over });

let token = '';
let terminalKey = '';
let bizId = 0;

describe('signup', () => {
  it('checks Salon IDs', async () => {
    const check = async (s: string) => (await request(app).get(`/api/v1/signup/slug-available?slug=${encodeURIComponent(s)}`)).body;
    expect(await check(DEMO_SLUG)).toMatchObject({ available: false });
    expect(await check('admin')).toMatchObject({ available: false });
    expect(await check('A!')).toMatchObject({ available: false });
    expect(await check(SLUG)).toMatchObject({ available: true, slug: SLUG });
  });

  it('rejects bad input with field errors', async () => {
    const r = await signup({ password: 'short', pin: '12' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('VALIDATION');
  });

  it('creates a salon, owner, paired terminal and session', async () => {
    const r = await signup();
    expect(r.status).toBe(201);
    expect(r.body.business).toMatchObject({ slug: SLUG, name: 'Lotus Nails' });
    expect(r.body.terminal_key).toMatch(/^gct_/);
    token = r.body.token;
    terminalKey = r.body.terminal_key;
    bizId = r.body.business.id;

    const h = { Authorization: `Bearer ${token}`, 'X-Terminal-Key': terminalKey };
    const me = await request(app).get('/api/v1/auth/me').set(h);
    expect(me.body.user).toMatchObject({ name: 'Linh', role: 'OWNER' });
    const biz = await request(app).get('/api/v1/business').set(h);
    expect(biz.body).toMatchObject({ slug: SLUG, name: 'Lotus Nails' });
    expect(biz.body.cid).toMatch(/^\d{5}$/);
    expect(r.body.business.cid).toBe(biz.body.cid);
    expect(me.body.business.cid).toBe(biz.body.cid);
    const general = await request(app).get('/api/v1/settings/general').set(h);
    expect(JSON.stringify(general.body)).toContain('Lotus Nails');
    const cards = await request(app).get('/api/v1/cards?status=all').set(h);
    expect(cards.body.data).toEqual([]); // nothing from the demo salon
    const tags = await request(app).get('/api/v1/tags').set(h);
    expect(tags.body.data.length).toBeGreaterThan(0); // defaults seeded for the new salon
  });

  it('refuses a taken Salon ID', async () => {
    const r = await signup({ email: 'other@example.com', username: `${OWNER}-2` });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('SLUG_TAKEN');
  });

  it('lets the owner pick their own username', async () => {
    const slug = `own-${Date.now().toString(36)}`;
    const r = await signup({ slug, email: 'mai@example.com', username: 'Mai.Nguyen' });
    expect(r.status).toBe(201);
    const ok = await request(app).post('/api/v1/auth/login').set('X-Business', slug).send({ username: 'mai.nguyen', password: 'correct-horse-1' });
    expect(ok.status).toBe(200);
    expect(ok.body.user.username).toBe('Mai.Nguyen');
    const bad = await signup({ slug: `${slug}-x`, username: 'has space' });
    expect(bad.status).toBe(400);
    const taken = await signup({ slug: `${slug}-y`, username: 'MAI.NGUYEN' }); // owner usernames are unique across salons
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe('USERNAME_TAKEN');
    expect(bad.status).toBe(400);
  });

  it('owner signs in with just username + password (no Salon ID), PIN is optional at sign-up', async () => {
    const slug = `nopin-${Date.now().toString(36)}`;
    const user = `nopin.${Date.now().toString(36)}`;
    const r = await signup({ slug, username: user, pin: undefined });
    expect(r.status).toBe(201);
    const login = await request(app).post('/api/v1/auth/login').send({ username: user.toUpperCase(), password: 'correct-horse-1' });
    expect(login.status).toBe(200);
    const biz = await request(app).get('/api/v1/business').set({ Authorization: `Bearer ${login.body.token}` });
    expect(biz.body.slug).toBe(slug);
    expect((await request(app).post('/api/v1/auth/login').send({ username: user, password: 'wrong-password' })).status).toBe(401);
    expect((await request(app).post('/api/v1/auth/login').send({ username: 'nobody-here', password: 'whatever-123' })).status).toBe(401);
  });

  it('only owners may use a password', async () => {
    // demo salon's manager has a password (manager123) but is not an owner
    const r = await request(app).post('/api/v1/auth/login').set('X-Business', DEMO_SLUG).send({ username: 'manager', password: 'manager123' });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('PASSWORD_LOGIN_OWNER_ONLY');
    const any = await request(app).post('/api/v1/auth/login').send({ username: 'manager', password: 'manager123' });
    expect(any.status).toBe(403);
  });

  it('username availability check', async () => {
    expect((await request(app).get(`/api/v1/signup/username-available?username=${OWNER}`)).body.available).toBe(false);
    expect((await request(app).get(`/api/v1/signup/username-available?username=free-${Date.now()}`)).body.available).toBe(true);
  });

  it('owner can log in with Salon ID + password or PIN', async () => {
    const pw = await request(app).post('/api/v1/auth/login').set('X-Business', SLUG).send({ username: OWNER, password: 'correct-horse-1' });
    expect(pw.status).toBe(200);
    const pin = await request(app).post('/api/v1/auth/pin-login').set('X-Terminal-Key', terminalKey).send({ pin: '2468' });
    expect(pin.status).toBe(200);
  });
});

describe('platform admin', () => {
  let ptok = '';
  const asP = () => ({ Authorization: `Bearer ${ptok}` });

  it('needs the platform password', async () => {
    expect((await request(app).post('/api/v1/platform/login').send({ password: 'nope' })).status).toBe(401);
    expect((await request(app).get('/api/v1/platform/businesses')).status).toBe(401);
    const r = await request(app).post('/api/v1/platform/login').send({ password: 'platform-test-pw' });
    expect(r.status).toBe(200);
    ptok = r.body.token;
  });

  it('salon and platform tokens do not cross', async () => {
    expect((await request(app).get('/api/v1/platform/businesses').set({ Authorization: `Bearer ${token}` })).status).toBe(401);
    expect((await request(app).get('/api/v1/cards').set(asP()).set('X-Business', SLUG)).status).toBe(401);
  });

  it('lists salons with counts', async () => {
    const r = await request(app).get('/api/v1/platform/businesses').set(asP());
    expect(r.status).toBe(200);
    const mine = r.body.data.find((b: any) => b.slug === SLUG);
    // every salon has a unique 5-digit CID
    const cids = r.body.data.map((b: any) => b.cid);
    expect(cids.every((c: string) => /^\d{5}$/.test(c))).toBe(true);
    expect(new Set(cids).size).toBe(cids.length);
    expect(mine).toMatchObject({ name: 'Lotus Nails', status: 'ACTIVE', users: 1, cards: 0 });
    const demo = r.body.data.find((b: any) => b.slug === DEMO_SLUG);
    expect(demo.cards).toBeGreaterThan(0);
  });

  it('suspends and reactivates a salon', async () => {
    const h = { Authorization: `Bearer ${token}`, 'X-Terminal-Key': terminalKey };
    expect((await request(app).post(`/api/v1/platform/businesses/${bizId}/status`).set(asP()).send({ status: 'SUSPENDED' })).status).toBe(200);
    const s = await request(app).get('/api/v1/cards').set(h);
    expect(s.status).toBe(403);
    expect(s.body.code).toBe('BUSINESS_SUSPENDED');
    expect((await request(app).post('/api/v1/signup').send({})).status).not.toBe(403); // signup unaffected
    expect((await request(app).post(`/api/v1/platform/businesses/${bizId}/status`).set(asP()).send({ status: 'ACTIVE' })).status).toBe(200);
    expect((await request(app).get('/api/v1/cards').set(h)).status).toBe(200);
  });

  it('resets a locked-out owner and issues a recovery terminal key', async () => {
    const r = await request(app).post(`/api/v1/platform/businesses/${bizId}/reset-owner`).set(asP()).send({});
    expect(r.status).toBe(200);
    expect(r.body.username).toBe(OWNER);
    const login = await request(app).post('/api/v1/auth/login').set('X-Business', SLUG).send({ username: OWNER, password: r.body.temporary_password });
    expect(login.status).toBe(200);
    expect((await request(app).post('/api/v1/auth/login').set('X-Business', SLUG).send({ username: OWNER, password: 'correct-horse-1' })).status).toBe(401);

    const k = await request(app).post(`/api/v1/platform/businesses/${bizId}/terminal-key`).set(asP()).send({});
    expect(k.status).toBe(201);
    const viaKey = await request(app).post('/api/v1/auth/pin-login').set('X-Terminal-Key', k.body.api_key).send({ pin: '2468' });
    expect(viaKey.status).toBe(200);
  });

  it('reset can use a password the admin chooses', async () => {
    const short = await request(app).post(`/api/v1/platform/businesses/${bizId}/reset-owner`).set(asP()).send({ password: 'short' });
    expect(short.status).toBe(400);
    const r = await request(app).post(`/api/v1/platform/businesses/${bizId}/reset-owner`).set(asP()).send({ password: 'admin-picked-pass-1' });
    expect(r.status).toBe(200);
    expect(r.body.temporary_password).toBeUndefined();
    const login = await request(app).post('/api/v1/auth/login').set('X-Business', SLUG).send({ username: OWNER, password: 'admin-picked-pass-1' });
    expect(login.status).toBe(200);
  });

  it('admin can rename the owner login (keeping or changing the password) and sees it in the list', async () => {
    const list = await request(app).get('/api/v1/platform/businesses').set(asP());
    expect(list.body.data.find((b: any) => b.id === bizId).owner_username).toBe(OWNER);

    const newName = `${OWNER}-renamed`;
    const r = await request(app).post(`/api/v1/platform/businesses/${bizId}/reset-owner`).set(asP()).send({ username: newName, keep_password: true });
    expect(r.status).toBe(200);
    expect(r.body.username).toBe(newName);
    expect(r.body.temporary_password).toBeUndefined();
    expect((await request(app).post('/api/v1/auth/login').send({ username: newName, password: 'admin-picked-pass-1' })).status).toBe(200);
    expect((await request(app).post('/api/v1/auth/login').send({ username: OWNER, password: 'admin-picked-pass-1' })).status).toBe(401);

    const taken = await request(app).post(`/api/v1/platform/businesses/${bizId}/reset-owner`).set(asP()).send({ username: 'MAI.NGUYEN', keep_password: true });
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe('USERNAME_TAKEN');

    // put it back for the tests below
    expect((await request(app).post(`/api/v1/platform/businesses/${bizId}/reset-owner`).set(asP()).send({ username: OWNER, keep_password: true })).status).toBe(200);
  });

  it('deletes a salon and only that salon', async () => {
    const demoBefore = await runAsSystem(() => one<{ n: number }>(`SELECT count(*)::int AS n FROM gift_card_transactions t JOIN businesses b ON b.id = t.business_id WHERE b.slug = $1`, [DEMO_SLUG]));

    // give the doomed salon some real data first
    const login = await request(app).post('/api/v1/auth/login').set('X-Business', SLUG).send({ username: OWNER, password: 'admin-picked-pass-1' });
    const h = { Authorization: `Bearer ${login.body.token}` };
    const card = await request(app).post('/api/v1/cards').set(h).set('Idempotency-Key', `del-card-${SLUG}`).send({ card_number: 'DEL0001', face_value_cents: 2500 });
    expect(card.status).toBe(201);

    const wrong = await request(app).post(`/api/v1/platform/businesses/${bizId}/delete`).set(asP()).send({ confirm: 'nope' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.code).toBe('CONFIRM_MISMATCH');

    const r = await request(app).post(`/api/v1/platform/businesses/${bizId}/delete`).set(asP()).send({ confirm: SLUG.toUpperCase() });
    expect(r.status).toBe(200);
    expect(r.body.rows.gift_cards).toBe(1);
    expect(r.body.rows.gift_card_transactions).toBeGreaterThanOrEqual(1);

    // gone everywhere
    const left = await runAsSystem(() =>
      one<{ n: number }>(`SELECT (SELECT count(*) FROM users WHERE business_id = $1) + (SELECT count(*) FROM gift_cards WHERE business_id = $1)
                          + (SELECT count(*) FROM audit_log WHERE business_id = $1) + (SELECT count(*) FROM businesses WHERE id = $1) AS n`, [bizId]),
    );
    expect(Number(left!.n)).toBe(0);
    expect((await request(app).get('/api/v1/cards').set(h)).status).toBe(401);
    expect((await request(app).post('/api/v1/auth/login').set('X-Business', SLUG).send({ username: OWNER, password: 'admin-picked-pass-1' })).status).toBe(404);

    // other salons untouched; ledger still append-only for everyone else
    const demoAfter = await runAsSystem(() => one<{ n: number }>(`SELECT count(*)::int AS n FROM gift_card_transactions t JOIN businesses b ON b.id = t.business_id WHERE b.slug = $1`, [DEMO_SLUG]));
    expect(demoAfter!.n).toBe(demoBefore!.n);
    await expect(query('DELETE FROM gift_card_transactions WHERE id = (SELECT min(id) FROM gift_card_transactions)')).rejects.toThrow(/append-only/);
  });

  it('unknown salon id → 404', async () => {
    expect((await request(app).post('/api/v1/platform/businesses/999999/reset-owner').set(asP()).send({})).status).toBe(404);
  });
});
