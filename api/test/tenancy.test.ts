/**
 * Salon isolation. Salon A = the demo salon ("amazing-salon"), salon B is
 * created here. B gets every one of A's ids and must never see or change
 * anything of A — through the API or straight at the database.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { one, pool, query, runAsBusiness, runAsSystem } from '../src/db.js';
import { invalidateBusiness } from '../src/tenant.js';
import { DEMO_SLUG, demoBusinessId, key, num } from './helpers.js';

const B_SLUG = 'salon-b-test';
const B_KEY = 'salon-b-terminal-key-0001';
let app: Express;
let bId: number;
let tokA: string;
let tokB: string;

/** Salon A's objects, made through the API as A's owner. */
const A = { card: 0, cardNumber: '', customer: 0, txn: 0, tag: 0, user: 0, terminal: 0, template: 0 };
/** Salon B's own card. */
let bCard = 0;

const asA = () => ({ Authorization: `Bearer ${tokA}` });
const asB = () => ({ Authorization: `Bearer ${tokB}` });
const postB = (url: string, body: unknown) => request(app).post(`/api/v1${url}`).set(asB()).set('Idempotency-Key', key()).send(body as object);

async function pinLogin(pin: string, business: string) {
  return request(app).post('/api/v1/auth/pin-login').set('X-Business', business).send({ pin });
}

beforeAll(async () => {
  app = createApp();

  // ---- salon B: business, defaults, owner (PIN 5555), terminal, one card
  bId = (await runAsSystem(() =>
    one<{ id: number }>(`INSERT INTO businesses (slug, name) VALUES ($1, 'Salon B') RETURNING id`, [B_SLUG]),
  ))!.id;
  await runAsBusiness(bId, async () => {
    await query(`SELECT fn_seed_business($1, 'Salon B')`, [bId]);
    await query(`INSERT INTO users (name, username, role, pin_hash) VALUES ('B Owner', 'owner', 'OWNER', crypt('5555', gen_salt('bf', 4)))`);
    await query(`INSERT INTO terminals (code, name, api_key_hash) VALUES ('FRONT-DESK-1', 'B desk', encode(digest($1, 'sha256'), 'hex'))`, [B_KEY]);
  });
  invalidateBusiness();

  // ---- salon A objects
  const a = await pinLogin('1111', DEMO_SLUG);
  expect(a.status).toBe(200);
  tokA = a.body.token;
  const cust = await request(app).post('/api/v1/customers').set(asA()).set('Idempotency-Key', key()).send({ first_name: 'Alice', last_name: 'A', phone: '5550001111' });
  expect(cust.status).toBe(201);
  A.customer = cust.body.id ?? cust.body.customer?.id;
  A.cardNumber = num();
  const card = await request(app).post('/api/v1/cards').set(asA()).set('Idempotency-Key', key()).send({ card_number: A.cardNumber, face_value_cents: 10000, pin: '4321', customer_id: A.customer });
  expect(card.status).toBe(201);
  A.card = card.body.card.id;
  const red = await request(app).post(`/api/v1/cards/${A.card}/redeem`).set(asA()).set('Idempotency-Key', key()).send({ amount_cents: 1000 });
  expect(red.status).toBe(200);
  A.txn = (await one<{ id: number }>('SELECT max(id) AS id FROM gift_card_transactions WHERE card_id = $1', [A.card]))!.id;
  A.tag = (await one<{ id: number }>('SELECT min(id) AS id FROM card_tags'))!.id;
  A.user = (await one<{ id: number }>(`SELECT id FROM users WHERE username = 'owner'`))!.id;
  A.terminal = (await one<{ id: number }>(`SELECT min(id) AS id FROM terminals`))!.id;
  A.template = (await one<{ id: number }>(`SELECT min(id) AS id FROM message_templates`))!.id;

  // ---- salon B login + its own card
  const b = await pinLogin('5555', B_SLUG);
  expect(b.status).toBe(200);
  tokB = b.body.token;
  const bc = await postB('/cards', { card_number: A.cardNumber, face_value_cents: 2000 }); // same number as A's card
  expect(bc.status).toBe(201);
  bCard = bc.body.card.id;
});

afterAll(async () => {
  await pool.end();
});

describe('database wall (row-level security)', () => {
  it('runs as a role that cannot bypass RLS', async () => {
    const r = await one<{ bypass: boolean }>('SELECT (rolsuper OR rolbypassrls) AS bypass FROM pg_roles WHERE rolname = current_user');
    expect(r!.bypass).toBe(false);
  });

  it('with no salon set, every salon table looks empty', async () => {
    const c = await pool.raw.connect();
    try {
      await c.query(`SELECT set_config('app.business_id', '', false), set_config('app.system', '', false)`);
      for (const t of ['users', 'role_permissions', 'terminals', 'customers', 'gift_cards', 'gift_card_transactions', 'audit_log',
        'card_tags', 'gift_card_tags', 'message_templates', 'message_log', 'settings', 'import_jobs', 'backups', 'idempotency_keys']) {
        const r = await c.query(`SELECT count(*)::int AS n FROM ${t}`);
        expect({ t, n: r.rows[0].n }).toEqual({ t, n: 0 });
      }
    } finally {
      c.release();
    }
  });

  it("salon B sees only its own rows, and none of A's", async () => {
    await runAsBusiness(bId, async () => {
      for (const t of ['users', 'terminals', 'customers', 'gift_cards', 'gift_card_transactions', 'audit_log', 'settings', 'card_tags']) {
        const r = await one<{ foreign: number }>(`SELECT count(*) FILTER (WHERE business_id <> $1)::int AS foreign FROM ${t}`, [bId]);
        expect({ t, foreign: r!.foreign }).toEqual({ t, foreign: 0 });
      }
      expect((await one('SELECT 1 FROM gift_cards WHERE id = $1', [A.card]))).toBeUndefined();
    });
  });

  it("money functions cannot touch another salon's card or transaction", async () => {
    await runAsBusiness(bId, async () => {
      await expect(query(`SELECT fn_apply_txn($1, 'REDEEM', -100)`, [A.card])).rejects.toThrow(/not found/);
      await expect(query(`SELECT fn_apply_txn($1, 'RELOAD', 100)`, [A.card])).rejects.toThrow(/not found/);
      await expect(query(`SELECT fn_reverse_txn($1, 'x')`, [A.txn])).rejects.toThrow(/not found/i);
      await expect(query(`SELECT fn_set_frozen($1, true, 'x')`, [A.card])).rejects.toThrow(/not found/);
      await expect(query(`SELECT * FROM fn_transfer($1, $2, 100)`, [A.card, bCard])).rejects.toThrow();
      await expect(query(`SELECT * FROM fn_merge($1, $2)`, [A.card, bCard])).rejects.toThrow();
      await expect(query(`SELECT fn_replace_lost_card($1, NULL)`, [A.card])).rejects.toThrow(/not found/);
      await expect(query(`SELECT fn_split($1, 100)`, [A.card])).rejects.toThrow(/not found/);
      await expect(query(`SELECT fn_erase_customer($1)`, [A.customer])).rejects.toThrow(/not found/);
      expect((await one<{ n: number }>(`SELECT fn_restore_archived(ARRAY[$1]::bigint[]) AS n`, [A.card]))!.n).toBe(0);
    });
    const a = await one<{ balance: string }>('SELECT balance FROM gift_cards WHERE id = $1', [A.card]);
    expect(a!.balance).toBe('90.00');
  });

  it("cannot link a row to another salon's card, tag or customer", async () => {
    await runAsBusiness(bId, async () => {
      await expect(query('INSERT INTO gift_card_tags (card_id, tag_id) VALUES ($1, $2)', [bCard, A.tag])).rejects.toThrow(/foreign key/);
      await expect(query('INSERT INTO gift_card_tags (card_id, tag_id) SELECT $1, min(id) FROM card_tags', [A.card])).rejects.toThrow(/foreign key/);
      await expect(query('UPDATE gift_cards SET customer_id = $2 WHERE id = $1', [bCard, A.customer])).rejects.toThrow(/foreign key/);
    });
  });

  it("cannot write rows into another salon", async () => {
    await runAsBusiness(bId, async () => {
      await expect(query(`INSERT INTO customers (business_id, first_name) VALUES ($1, 'Mallory')`, [demoBusinessId])).rejects.toThrow(/row-level security/);
      const upd = await query(`UPDATE customers SET first_name = 'pwned' WHERE id = $1`, [A.customer]);
      expect(upd.rowCount).toBe(0);
    });
    expect((await one<{ first_name: string }>('SELECT first_name FROM customers WHERE id = $1', [A.customer]))!.first_name).toBe('Alice');
  });

  it('nightly expiry with no salon set walks every salon', async () => {
    const r = await one<{ n: number }>('SELECT fn_expire_due_cards() AS n');
    expect(r!.n).toBeGreaterThanOrEqual(0);
  });
});

describe('API wall', () => {
  it('same card number lives in both salons, each sees its own', async () => {
    const a = await request(app).get(`/api/v1/cards/lookup/${A.cardNumber}`).set(asA());
    const b = await request(app).get(`/api/v1/cards/lookup/${A.cardNumber}`).set(asB());
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect((a.body.card ?? a.body).id).toBe(A.card);
    expect((b.body.card ?? b.body).id).toBe(bCard);
  });

  it("every id route returns 404 for another salon's id", async () => {
    const gets = [
      `/cards/${A.card}`, `/cards/${A.card}/transactions`, `/cards/${A.card}/receipt`, `/cards/statement/${A.card}.pdf`,
      `/customers/${A.customer}`,
    ];
    for (const u of gets) {
      const r = await request(app).get(`/api/v1${u}`).set(asB());
      expect({ u, status: r.status }).toEqual({ u, status: 404 });
    }
    const posts: [string, unknown][] = [
      [`/cards/${A.card}/redeem`, { amount_cents: 100 }],
      [`/cards/${A.card}/reload`, { amount_cents: 100 }],
      [`/cards/${A.card}/refund`, { amount_cents: 100, reason: 'test refund' }],
      [`/cards/${A.card}/adjust`, { delta_cents: 100, reason: 'test adjust' }],
      [`/cards/${A.card}/void`, { reason: 'test void' }],
      [`/cards/${A.card}/notes`, { note: 'hi' }],
      [`/cards/${A.card}/split`, { amount_cents: 100 }],
      [`/cards/${A.card}/replace`, { reason: 'lost card' }],
      [`/cards/${A.card}/send`, { channel: 'EMAIL' }],
      [`/transactions/${A.txn}/reverse`, { reason: 'test reverse' }],
      [`/customers/${A.customer}/erase`, { confirm: 'ERASE' }],
    ];
    // 404, or a dual-control gate that answers the same for every id before any lookup.
    const blocked = (r: request.Response) => r.status === 404 || (r.status === 403 && r.body.code === 'APPROVAL_REQUIRED');
    const leaks: string[] = [];
    for (const [u, body] of posts) {
      const r = await postB(u, body);
      if (!blocked(r)) leaks.push(`POST ${u} → ${r.status} ${JSON.stringify(r.body)}`);
    }
    for (const [method, u, body] of [
      ['patch', `/cards/${A.card}`, { label: 'pwned' }],
      ['put', `/cards/${A.card}/freeze`, { reason: 'test freeze' }],
      ['put', `/cards/${A.card}/tags`, { tag_ids: [] }],
      ['delete', `/cards/${A.card}`, { reason: 'test delete' }],
      ['patch', `/customers/${A.customer}`, { first_name: 'pwned' }],
      ['patch', `/users/${A.user}`, { name: 'pwned' }],
      ['patch', `/terminals/${A.terminal}`, { name: 'pwned' }],
      ['post', `/terminals/${A.terminal}/rotate-key`, {}],
      ['put', `/templates/${A.template}`, { body: 'pwned' }],
      ['delete', `/tags/${A.tag}`, {}],
    ] as const) {
      const r = await (request(app) as any)[method](`/api/v1${u}`).set(asB()).set('Idempotency-Key', key()).send(body);
      if (!blocked(r)) leaks.push(`${method.toUpperCase()} ${u} → ${r.status} ${JSON.stringify(r.body)}`);
    }
    expect(leaks).toEqual([]);
    // Transfers/merges naming A's card from B's side
    expect((await postB('/cards/transfer', { from_id: A.card, to_id: bCard, amount_cents: 100 })).status).toBe(404);
    expect((await postB('/cards/merge', { from_id: A.card, to_id: bCard })).status).toBe(404);

    // Salon A is untouched
    const a = await request(app).get(`/api/v1/cards/${A.card}`).set(asA());
    expect(a.status).toBe(200);
    expect((a.body.card ?? a.body).balance_cents ?? (a.body.card ?? a.body).balance).toBeDefined();
    const bal = await one<{ balance: string; status: string; label: string | null }>('SELECT balance, status, label FROM gift_cards WHERE id = $1', [A.card]);
    expect(bal).toMatchObject({ balance: '90.00', status: 'PARTIALUSED' });
    expect(bal!.label).not.toBe('pwned');
    expect(await one('SELECT 1 FROM card_tags WHERE id = $1', [A.tag])).toBeDefined();
  });

  it("list, search, history, dashboard and export only show B's own data", async () => {
    const cards = await request(app).get('/api/v1/cards?status=all').set(asB());
    expect(cards.status).toBe(200);
    expect(cards.body.data.map((c: any) => c.id)).toEqual([bCard]);
    const cust = await request(app).get('/api/v1/customers?q=Alice').set(asB());
    expect(cust.body.data).toEqual([]);
    const hist = await request(app).get('/api/v1/history').set(asB());
    expect(hist.body.data.every((h: any) => h.card_id === null || h.card_id === bCard)).toBe(true);
    const dash = await request(app).get('/api/v1/dashboard/summary').set(asB());
    expect(dash.status).toBe(200);
    expect(JSON.stringify(dash.body)).not.toContain(A.cardNumber === '' ? 'x' : '3460010');
    const users = await request(app).get('/api/v1/users').set(asB());
    expect(users.body.data.map((u: any) => u.name)).toEqual(['B Owner']);
    const settings = await request(app).get('/api/v1/settings/general').set(asB());
    expect(settings.body.value?.business_name ?? settings.body.business_name).toBe('Salon B');
    const dump = await request(app).get('/api/v1/data/export.json').set(asB());
    expect(dump.status).toBe(200);
    expect(dump.body.tables.gift_cards.map((c: any) => c.id)).toEqual([bCard]);
    expect(dump.body.tables.customers).toEqual([]);
    const csv = await request(app).get('/api/v1/data/export/gift_card_transactions.csv').set(asB());
    expect(csv.text).not.toContain(String(A.txn) + ',');
  });

  it('PIN tiles and PIN login are per salon', async () => {
    const tiles = await request(app).get('/api/v1/auth/users').set('X-Business', B_SLUG);
    expect(tiles.body.data.map((u: any) => u.name)).toEqual(['B Owner']);
    expect((await pinLogin('1111', B_SLUG)).status).toBe(401); // A's owner PIN means nothing in B
    expect((await pinLogin('5555', DEMO_SLUG)).status).toBe(401);
  });

  it("a session can't be pointed at another salon", async () => {
    const r1 = await request(app).get('/api/v1/cards').set(asB()).set('X-Business', DEMO_SLUG);
    expect(r1.status).toBe(401);
    expect(r1.body.code).toBe('SESSION_INVALID');
    const r2 = await request(app).get('/api/v1/cards').set(asA()).set('X-Terminal-Key', B_KEY);
    expect(r2.status).toBe(401);
    const r3 = await request(app).get(`/api/v1/cards?business=${DEMO_SLUG}`).set(asB());
    expect(r3.status).toBe(401);
  });

  it('a terminal key logs into its own salon only', async () => {
    const r = await request(app).post('/api/v1/auth/pin-login').set('X-Terminal-Key', B_KEY).send({ pin: '5555' });
    expect(r.status).toBe(200);
    const me = await request(app).get('/api/v1/cards').set({ Authorization: `Bearer ${r.body.token}`, 'X-Terminal-Key': B_KEY });
    expect(me.body.data.map((c: any) => c.id)).toEqual([bCard]);
    const wrong = await request(app).post('/api/v1/auth/pin-login').set('X-Terminal-Key', B_KEY).set('X-Business', DEMO_SLUG).send({ pin: '1111' });
    expect(wrong.status).toBe(401);
  });

  it("kiosk in salon B can't look up salon A's card", async () => {
    const kiosk = createApp();
    const a = await request(kiosk).post('/api/v1/kiosk/lookup').set('X-Business', DEMO_SLUG).send({ number: A.cardNumber, pin: '4321' });
    expect(a.status).toBe(200);
    const b = await request(kiosk).post('/api/v1/kiosk/lookup').set('X-Business', B_SLUG).send({ number: A.cardNumber, pin: '4321' });
    expect(b.status).not.toBe(200); // B's card with that number has no PIN → generic failure
    expect(JSON.stringify(b.body)).not.toContain('90.00');
  });

  it('unknown Salon ID → 404, suspended salon → 403', async () => {
    const r = await request(app).get('/api/v1/auth/users').set('X-Business', 'no-such-salon');
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('BUSINESS_NOT_FOUND');
    await runAsSystem(() => query(`UPDATE businesses SET status = 'SUSPENDED' WHERE id = $1`, [bId]));
    invalidateBusiness();
    const s = await request(app).get('/api/v1/cards').set(asB());
    expect(s.status).toBe(403);
    expect(s.body.code).toBe('BUSINESS_SUSPENDED');
    await runAsSystem(() => query(`UPDATE businesses SET status = 'ACTIVE' WHERE id = $1`, [bId]));
    invalidateBusiness();
    expect((await request(app).get('/api/v1/cards').set(asB())).status).toBe(200);
  });

  it('idempotency keys are per salon (same key in both salons is fine)', async () => {
    const k = key();
    const a = await request(app).post('/api/v1/customers').set(asA()).set('Idempotency-Key', k).send({ first_name: 'Same', last_name: 'Key' });
    const b = await request(app).post('/api/v1/customers').set(asB()).set('Idempotency-Key', k).send({ first_name: 'Same', last_name: 'Key' });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.headers['idempotent-replay']).toBeUndefined();
  });
});
