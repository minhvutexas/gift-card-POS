/**
 * REQUIRE_TERMINAL_KEY=true (production): PIN sign-in only on paired devices,
 * password sign-in (owner/manager at home, on a phone) from any device.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { pool } from '../src/db.js';
import { DEMO_SLUG } from './helpers.js';

let app: Express;
const was = config.requireTerminalKey;
const KEY = 'dev-frontdesk-key'; // demo salon's paired front desk

beforeAll(() => {
  config.requireTerminalKey = true;
  app = createApp();
});
afterAll(async () => {
  config.requireTerminalKey = was;
  await pool.end();
});

const biz = { 'X-Business': DEMO_SLUG };

describe('unpaired device', () => {
  it('cannot use PIN sign-in or see the staff list', async () => {
    const pin = await request(app).post('/api/v1/auth/pin-login').set(biz).send({ pin: '1111' });
    expect(pin.status).toBe(401);
    expect(pin.body.code).toBe('TERMINAL_REQUIRED');
    const tiles = await request(app).get('/api/v1/auth/users').set(biz);
    expect(tiles.status).toBe(401);
  });

  it('can sign in with username + password and then use the app', async () => {
    const r = await request(app).post('/api/v1/auth/login').set(biz).send({ username: 'owner', password: 'owner123' });
    expect(r.status).toBe(200);
    const h = { Authorization: `Bearer ${r.body.token}` };
    const me = await request(app).get('/api/v1/auth/me').set(h);
    expect(me.status).toBe(200);
    expect(me.body.terminal).toBeNull();
    expect((await request(app).get('/api/v1/cards').set(h)).status).toBe(200);
    expect((await request(app).get('/api/v1/business').set(h)).body.slug).toBe(DEMO_SLUG);

    // logout kills it, even without a terminal key
    expect((await request(app).post('/api/v1/auth/logout').set(h).set('Idempotency-Key', 'logout-remote-1').send({})).status).toBe(200);
    expect((await request(app).get('/api/v1/cards').set(h)).status).toBe(401);
  });

  it('wrong password still fails', async () => {
    const r = await request(app).post('/api/v1/auth/login').set(biz).send({ username: 'owner', password: 'nope-nope' });
    expect(r.status).toBe(401);
  });

  it("a PIN session from the front desk can't be carried to an unpaired device", async () => {
    const pin = await request(app).post('/api/v1/auth/pin-login').set('X-Terminal-Key', KEY).send({ pin: '1111' });
    expect(pin.status).toBe(200);
    const elsewhere = await request(app).get('/api/v1/cards').set({ Authorization: `Bearer ${pin.body.token}` });
    expect(elsewhere.status).toBe(401);
    expect(elsewhere.body.code).toBe('TERMINAL_REQUIRED');
    // …but works on the paired device
    expect((await request(app).get('/api/v1/cards').set({ Authorization: `Bearer ${pin.body.token}`, 'X-Terminal-Key': KEY })).status).toBe(200);
  });

  it('a password session from a paired device is tied to that device', async () => {
    const r = await request(app).post('/api/v1/auth/login').set('X-Terminal-Key', KEY).send({ username: 'owner', password: 'owner123' });
    expect(r.status).toBe(200);
    expect((await request(app).get('/api/v1/cards').set({ Authorization: `Bearer ${r.body.token}` })).status).toBe(401);
  });
});
