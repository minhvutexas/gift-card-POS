/** Email/SMS are off until the platform admin turns them on. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { one, pool } from '../src/db.js';
import { key, num } from './helpers.js';

let app: Express;
let tok = '';
let ptok = '';
let cardId = 0;
const as = () => ({ Authorization: `Bearer ${tok}` });
const post = (url: string, body: unknown) => request(app).post(`/api/v1${url}`).set(as()).set('Idempotency-Key', key()).send(body as object);
const logCount = async () => (await one<{ n: number }>('SELECT count(*)::int AS n FROM message_log WHERE card_id = $1', [cardId]))!.n;

beforeAll(async () => {
  app = createApp();
  tok = (await request(app).post('/api/v1/auth/pin-login').send({ pin: '1111' })).body.token;
  ptok = (await request(app).post('/api/v1/platform/login').send({ password: 'platform-test-pw' })).body.token;
  const cust = await post('/customers', { first_name: 'Mia', email: 'mia@example.com', phone: '5551239876' });
  const card = await post('/cards', { card_number: num(), face_value_cents: 5000, customer_id: cust.body.id ?? cust.body.customer?.id });
  expect(card.status).toBe(201);
  cardId = card.body.card.id;
});

afterAll(async () => {
  await request(app).put('/api/v1/platform/settings').set({ Authorization: `Bearer ${ptok}` }).send({ messaging: false });
  await pool.end();
});

describe('messaging switch', () => {
  it('is off by default and the app is told so', async () => {
    const me = await request(app).get('/api/v1/auth/me').set(as());
    expect(me.body.features).toEqual({ messaging: false });
  });

  it('blocks manual sends and skips automatic messages while off', async () => {
    const r = await post(`/cards/${cardId}/send`, { channel: 'EMAIL' });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('MESSAGING_DISABLED');
    expect((await post(`/cards/${cardId}/reload`, { amount_cents: 1000 })).status).toBe(200); // the sale still works
    expect(await logCount()).toBe(0);
  });

  it('only the platform admin can flip it', async () => {
    expect((await request(app).put('/api/v1/platform/settings').set(as()).send({ messaging: true })).status).toBe(401);
    expect((await request(app).put('/api/v1/platform/settings').set({ Authorization: `Bearer ${ptok}` }).send({ bogus: 1 })).status).toBe(400);
  });

  it('works for every salon once turned on', async () => {
    const r = await request(app).put('/api/v1/platform/settings').set({ Authorization: `Bearer ${ptok}` }).send({ messaging: true });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ messaging: true });
    expect((await request(app).get('/api/v1/platform/settings').set({ Authorization: `Bearer ${ptok}` })).body.messaging).toBe(true);
    const me = await request(app).get('/api/v1/auth/me').set(as());
    expect(me.body.features.messaging).toBe(true);
    const send = await post(`/cards/${cardId}/send`, { channel: 'EMAIL' });
    expect(send.status).toBe(200);
    expect(await logCount()).toBe(1);
  });
});
