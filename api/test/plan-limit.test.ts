/** Plans: FREE 50 · EXTRA 1,000 · PREMIER 10,000 gift cards per salon. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { one, pool, query, runAsBusiness } from '../src/db.js';
import { key } from './helpers.js';

let app: Express;
let bizId = 0;
let h: Record<string, string> = {};
let ptok = '';
const SLUG = `limit-${Date.now().toString(36)}`;
const issue = () => request(app).post('/api/v1/cards').set(h).set('Idempotency-Key', key()).send({ face_value_cents: 2000 });

beforeAll(async () => {
  app = createApp();
  const r = await request(app).post('/api/v1/signup').send({ salon_name: 'Limit Test', slug: SLUG, owner_name: 'Lim', email: 'lim@example.com', username: 'owner', password: 'correct-horse-1', pin: '7531' });
  expect(r.status).toBe(201);
  bizId = r.body.business.id;
  h = { Authorization: `Bearer ${r.body.token}`, 'X-Terminal-Key': r.body.terminal_key };
  ptok = (await request(app).post('/api/v1/platform/login').send({ password: 'platform-test-pw' })).body.token;
});
afterAll(async () => {
  await pool.end();
});

describe('plan card limit', () => {
  it('new salons start on Free: 50 cards', async () => {
    const me = await request(app).get('/api/v1/auth/me').set(h);
    expect(me.body.plan).toMatchObject({ tier: 'FREE', limit: 50, used: 0 });
    expect(me.body.plan.contact.email).toBe('jimmyvu@unijv.com');
  });

  it('the 51st card is refused with a contact message', async () => {
    // fill up to the limit quickly, straight through the card function
    await runAsBusiness(bizId, () => query('SELECT fn_issue_card(NULL, 1000) FROM generate_series(1, 49)'));
    expect((await issue()).status).toBe(201); // #50 through the API
    const over = await issue();
    expect(over.status).toBe(403);
    expect(over.body.code).toBe('CARD_LIMIT_REACHED');
    expect(over.body.message).toContain('Free plan includes 50 gift cards');
    expect(over.body.message).toContain('jimmyvu@unijv.com');
    expect(over.body.message).toContain('(346) 672-9523');
    expect(over.body.details).toMatchObject({ plan: 'FREE', limit: 50, used: 50 });
    const me = await request(app).get('/api/v1/auth/me').set(h);
    expect(me.body.plan.used).toBe(50);
  });

  it('splitting a card counts too; replacing a lost card does not', async () => {
    const card = (await runAsBusiness(bizId, () => one<{ id: number }>(`SELECT min(id) AS id FROM gift_cards`)))!;
    await expect(runAsBusiness(bizId, () => query('SELECT fn_split($1, 100)', [card.id]))).rejects.toThrow(/Card limit reached/);
    const replaced = await runAsBusiness(bizId, () => one<{ id: number }>('SELECT (fn_replace_lost_card($1, NULL)).id AS id', [card.id]));
    expect(replaced!.id).toBeGreaterThan(card.id);
    const used = await runAsBusiness(bizId, () => one<{ n: number }>('SELECT fn_card_usage() AS n'));
    expect(used!.n).toBe(50);
  });

  it('platform admin can move a salon to Extra / Premier', async () => {
    const p = { Authorization: `Bearer ${ptok}` };
    const list = await request(app).get('/api/v1/platform/businesses').set(p);
    expect(list.body.data.find((b: any) => b.id === bizId)).toMatchObject({ plan: 'FREE', card_limit: 50, cards_counted: 50 });

    expect((await request(app).post(`/api/v1/platform/businesses/${bizId}/plan`).set(p).send({ plan: 'GOLD' })).status).toBe(400);
    expect((await request(app).post(`/api/v1/platform/businesses/${bizId}/plan`).set(h).send({ plan: 'PREMIER' })).status).toBe(401); // salons can't upgrade themselves

    const up = await request(app).post(`/api/v1/platform/businesses/${bizId}/plan`).set(p).send({ plan: 'EXTRA' });
    expect(up.status).toBe(200);
    expect(up.body).toMatchObject({ plan: 'EXTRA', card_limit: 1000 });
    expect((await issue()).status).toBe(201);
    expect((await request(app).get('/api/v1/auth/me').set(h)).body.plan).toMatchObject({ tier: 'EXTRA', limit: 1000, used: 51 });

    const prem = await request(app).post(`/api/v1/platform/businesses/${bizId}/plan`).set(p).send({ plan: 'PREMIER' });
    expect(prem.body.card_limit).toBe(10000);

    // back down to Free: existing cards stay, new ones are refused
    await request(app).post(`/api/v1/platform/businesses/${bizId}/plan`).set(p).send({ plan: 'FREE' });
    expect((await issue()).status).toBe(403);
    const cardsOk = await request(app).get('/api/v1/cards?status=all').set(h);
    expect(cardsOk.status).toBe(200);
  });
});
