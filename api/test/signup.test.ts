import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { pool } from '../src/db.js';
import { DEMO_SLUG } from './helpers.js';

let app: Express;
beforeAll(() => {
  app = createApp();
});
afterAll(async () => {
  await pool.end();
});

const SLUG = `lotus-${Date.now().toString(36)}`;
const signup = (over: Record<string, unknown> = {}) =>
  request(app)
    .post('/api/v1/signup')
    .send({ salon_name: 'Lotus Nails', slug: SLUG, owner_name: 'Linh', email: 'linh@example.com', password: 'correct-horse-1', pin: '2468', ...over });

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
    expect(biz.body).toEqual({ slug: SLUG, name: 'Lotus Nails' });
    const general = await request(app).get('/api/v1/settings/general').set(h);
    expect(JSON.stringify(general.body)).toContain('Lotus Nails');
    const cards = await request(app).get('/api/v1/cards?status=all').set(h);
    expect(cards.body.data).toEqual([]); // nothing from the demo salon
    const tags = await request(app).get('/api/v1/tags').set(h);
    expect(tags.body.data.length).toBeGreaterThan(0); // defaults seeded for the new salon
  });

  it('refuses a taken Salon ID', async () => {
    const r = await signup({ email: 'other@example.com' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('SLUG_TAKEN');
  });

  it('owner can log in with Salon ID + password or PIN', async () => {
    const pw = await request(app).post('/api/v1/auth/login').set('X-Business', SLUG).send({ username: 'owner', password: 'correct-horse-1' });
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
    expect(r.body.username).toBe('owner');
    const login = await request(app).post('/api/v1/auth/login').set('X-Business', SLUG).send({ username: 'owner', password: r.body.temporary_password });
    expect(login.status).toBe(200);
    expect((await request(app).post('/api/v1/auth/login').set('X-Business', SLUG).send({ username: 'owner', password: 'correct-horse-1' })).status).toBe(401);

    const k = await request(app).post(`/api/v1/platform/businesses/${bizId}/terminal-key`).set(asP()).send({});
    expect(k.status).toBe(201);
    const viaKey = await request(app).post('/api/v1/auth/pin-login').set('X-Terminal-Key', k.body.api_key).send({ pin: '2468' });
    expect(viaKey.status).toBe(200);
  });

  it('unknown salon id → 404', async () => {
    expect((await request(app).post('/api/v1/platform/businesses/999999/reset-owner').set(asP()).send({})).status).toBe(404);
  });
});
