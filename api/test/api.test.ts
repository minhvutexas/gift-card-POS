import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { one, query } from '../src/db.js';
import { key, num, pool } from './helpers.js';

let app: Express;
const tokens: Record<string, string> = {};

async function login(pin: string) {
  const r = await request(app).post('/api/v1/auth/pin-login').send({ pin });
  expect(r.status).toBe(200);
  return r.body.token as string;
}

const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
const post = (who: string, url: string, body: unknown, extra: Record<string, string> = {}) =>
  request(app).post(`/api/v1${url}`).set(as(who)).set('Idempotency-Key', extra['Idempotency-Key'] ?? key()).set(extra).send(body as object);

async function issue(faceCents = 5000) {
  const r = await post('owner', '/cards', { card_number: num(), face_value_cents: faceCents, pin: '4321' });
  expect(r.status).toBe(201);
  return r.body.card as { id: number; card_number: string };
}

beforeAll(async () => {
  app = createApp();
  tokens.owner = await login('1111');
  tokens.manager = await login('2222');
  tokens.staff = await login('3333');
  // Make dual-control & threshold deterministic for these tests.
  await query(`UPDATE settings SET value = value || '{"dual_control_voids": true, "dual_control_refunds": true, "approval_threshold_cents": 50000}'::jsonb WHERE key = 'security'`);
});

afterAll(async () => {
  await pool.end();
});

describe('auth & RBAC', () => {
  it('rejects a wrong PIN with a problem+json body', async () => {
    const r = await request(app).post('/api/v1/auth/pin-login').send({ pin: '9999' });
    expect(r.status).toBe(401);
    expect(r.headers['content-type']).toContain('application/problem+json');
    expect(r.body).toMatchObject({ status: 401, code: 'PIN_INVALID', field: 'pin' });
  });

  it('requires a session', async () => {
    const r = await request(app).get('/api/v1/cards');
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('UNAUTHENTICATED');
  });

  it('GET /auth/me returns permissions', async () => {
    const r = await request(app).get('/api/v1/auth/me').set(as('staff'));
    expect(r.body.user.role).toBe('STAFF');
    expect(r.body.user.permissions).toContain('cards.redeem');
    expect(r.body.user.permissions).not.toContain('cards.void');
  });

  it('staff cannot void or adjust', async () => {
    const c = await issue();
    expect((await post('staff', `/cards/${c.id}/void`, { reason: 'nope nope' })).status).toBe(403);
    expect((await post('staff', `/cards/${c.id}/adjust`, { delta_cents: 100, reason: 'nope nope' })).body.code).toBe('FORBIDDEN');
  });
});

describe('cards API', () => {
  it('lists with meta.outstanding_total matching the liability view', async () => {
    const r = await request(app).get('/api/v1/cards?status=all&sort=balance_desc').set(as('staff'));
    expect(r.status).toBe(200);
    const v = await one<{ total_cents: number }>('SELECT total_cents FROM v_outstanding_liability');
    expect(r.body.meta.outstanding_total_cents).toBe(v!.total_cents);
    const seed = r.body.data.filter((c: any) => c.card_number.startsWith('346000') || c.card_number === '3460010');
    expect(seed.map((c: any) => [c.card_number, c.status, c.balance_cents])).toEqual(
      expect.arrayContaining([
        ['3460010', 'ACTIVE', 50000],
        ['3460002', 'PARTIALUSED', 9800],
        ['3460003', 'PARTIALUSED', 2200],
        ['3460001', 'PARTIALUSED', 1500],
      ]),
    );
  });

  it('search finds by card number and filter chips work', async () => {
    const c = await issue(1234);
    const r = await request(app).get(`/api/v1/cards?q=${c.card_number}`).set(as('staff'));
    expect(r.body.data).toHaveLength(1);
    const frozen = await request(app).get('/api/v1/cards?status=frozen').set(as('staff'));
    expect(frozen.body.data.every((x: any) => x.status === 'FROZEN')).toBe(true);
  });

  it('mutations require Idempotency-Key', async () => {
    const c = await issue();
    const r = await request(app).post(`/api/v1/cards/${c.id}/redeem`).set(as('staff')).send({ amount_cents: 100 });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED', field: 'Idempotency-Key' });
  });

  it('redeem returns updated balance + status; replay is identical; different body same key → 409', async () => {
    const c = await issue(5000);
    const k = key();
    const a = await post('staff', `/cards/${c.id}/redeem`, { amount_cents: 1250, ref: 'T-9' }, { 'Idempotency-Key': k });
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ balance_cents: 3750, status: 'PARTIALUSED' });
    expect(a.body.transaction).toMatchObject({ txn_type: 'REDEEM', amount_cents: -1250, external_ref: 'T-9' });
    const b = await post('staff', `/cards/${c.id}/redeem`, { amount_cents: 1250, ref: 'T-9' }, { 'Idempotency-Key': k });
    expect(b.headers['idempotent-replay']).toBe('true');
    expect(b.body.transaction.id).toBe(a.body.transaction.id);
    const d = await post('staff', `/cards/${c.id}/redeem`, { amount_cents: 999 }, { 'Idempotency-Key': k });
    expect(d.status).toBe(409);
    expect(d.body.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('over-balance redeem → 422 with available amount', async () => {
    const c = await issue(2200);
    const r = await post('staff', `/cards/${c.id}/redeem`, { amount_cents: 2500 });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ code: 'INSUFFICIENT_FUNDS', message: 'Insufficient: $22.00 available', details: { available_cents: 2200 } });
  });

  it('validation errors name the field', async () => {
    const c = await issue();
    const r = await post('staff', `/cards/${c.id}/redeem`, { amount_cents: 12.5 });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ code: 'VALIDATION', field: 'amount_cents' });
  });

  it('auto-numbers when no card number is given', async () => {
    const r = await post('staff', '/cards', { face_value_cents: 2500 });
    expect(r.status).toBe(201);
    expect(r.body.card.card_number).toMatch(/^\d{7,}$/);
    expect(r.body.status).toBe('ACTIVE');
  });

  it('GET /cards/lookup/:number for scanners', async () => {
    const c = await issue(1000);
    const r = await request(app).get(`/api/v1/cards/lookup/${c.card_number}`).set(as('staff'));
    expect(r.body.card.id).toBe(c.id);
    expect(r.body.transactions[0].txn_type).toBe('ISSUE');
  });

  it('staff undo within the window reverses their own redemption', async () => {
    const c = await issue(5000);
    const red = await post('staff', `/cards/${c.id}/redeem`, { amount_cents: 1000 });
    const undo = await post('staff', `/transactions/${red.body.transaction.id}/reverse`, {});
    expect(undo.status).toBe(200);
    expect(undo.body.balance_cents).toBe(5000);
  });

  it('PDF statement and CSV export', async () => {
    const c = await issue(1000);
    const pdf = await request(app).get(`/api/v1/cards/statement/${c.id}.pdf`).set(as('staff'));
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    const csv = await request(app).get('/api/v1/cards/export.csv').set(as('owner'));
    expect(csv.text.split('\r\n')[0]).toContain('card_number,status,balance');
    expect(csv.text).toContain('3460010,ACTIVE,500.00');
  });
});

describe('manager step-up & dual control', () => {
  it('void needs a second manager; self-approval is refused', async () => {
    const c = await issue(3000);
    const k = key();
    const first = await post('manager', `/cards/${c.id}/void`, { reason: 'Sold in error' }, { 'Idempotency-Key': k });
    expect(first.status).toBe(403);
    expect(first.body).toMatchObject({ code: 'APPROVAL_REQUIRED', details: { action: 'void', dual_control: true } });

    const self = await request(app).post('/api/v1/auth/approve').set(as('manager')).send({ pin: '2222', action: 'void' });
    const selfTry = await post('manager', `/cards/${c.id}/void`, { reason: 'Sold in error' }, { 'Idempotency-Key': k, 'X-Approval-Token': self.body.approval_token });
    expect(selfTry.body.code).toBe('APPROVAL_INVALID');

    const appr = await request(app).post('/api/v1/auth/approve').set(as('manager')).send({ pin: '1111', action: 'void' });
    expect(appr.status).toBe(200);
    const ok = await post('manager', `/cards/${c.id}/void`, { reason: 'Sold in error' }, { 'Idempotency-Key': k, 'X-Approval-Token': appr.body.approval_token });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'VOIDED', balance_cents: 0 });
    expect(ok.body.transaction.approved_by).toBe(appr.body.approver.id);
  });

  it('staff PIN cannot approve', async () => {
    const r = await request(app).post('/api/v1/auth/approve').set(as('staff')).send({ pin: '3333', action: 'adjust' });
    expect(r.status).toBe(401);
  });

  it('redeem above the threshold needs approval', async () => {
    const c = await issue(80000);
    const r = await post('staff', `/cards/${c.id}/redeem`, { amount_cents: 60000 });
    expect(r.body.code).toBe('APPROVAL_REQUIRED');
    const appr = await request(app).post('/api/v1/auth/approve').set(as('staff')).send({ pin: '2222', action: 'large_amount' });
    const k = key();
    const ok = await post('staff', `/cards/${c.id}/redeem`, { amount_cents: 60000 }, { 'Idempotency-Key': k, 'X-Approval-Token': appr.body.approval_token });
    expect(ok.status).toBe(200);
    expect(ok.body.balance_cents).toBe(20000);
  });

  it('archive-zero: dry run is free, commit needs approval', async () => {
    const dry = await post('staff', '/cards/archive-zero', { dry_run: true });
    expect(dry.status).toBe(403); // staff lacks cards.archive
    const mDry = await post('manager', '/cards/archive-zero', { dry_run: true });
    expect(mDry.status).toBe(200);
    expect(mDry.body).toHaveProperty('count');
    const commit = await post('manager', '/cards/archive-zero', { dry_run: false });
    expect(commit.status).toBe(200); // manager self-approves (no dual control for archive)
    expect(commit.body.undo_until).toBeTruthy();
  });
});

describe('kiosk (public)', () => {
  it('shows masked balance with number+PIN, no admin data', async () => {
    const kioskApp = createApp();
    const c = await issue(4200);
    const r = await request(kioskApp).post('/api/v1/kiosk/lookup').send({ number: c.card_number, pin: '4321' });
    expect(r.status).toBe(200);
    expect(r.body.balance_cents).toBe(4200);
    expect(r.body.card_masked).not.toContain(c.card_number.slice(0, 3));
    expect(Object.keys(r.body).sort()).toEqual(['balance_cents', 'can_report_lost', 'card_masked', 'currency', 'expires_at', 'status', 'transactions']);
    // Reload is front-desk only — the kiosk endpoint no longer exists.
    const reload = await request(kioskApp).post('/api/v1/kiosk/reload').set('Idempotency-Key', key()).send({ number: c.card_number, pin: '4321', amount_cents: 1000 });
    expect([401, 404]).toContain(reload.status); // unknown public route → falls through to staff auth
    expect((await one<{ n: number }>(`SELECT COUNT(*)::int AS n FROM gift_card_transactions WHERE card_id = $1 AND txn_type = 'RELOAD'`, [c.id]))!.n).toBe(0);
    expect(Object.keys(r.body.transactions[0]).sort()).toEqual(['amount_cents', 'date', 'type']);
  });

  it('same generic error for unknown card and wrong PIN', async () => {
    const kioskApp = createApp();
    const c = await issue(1000);
    const a = await request(kioskApp).post('/api/v1/kiosk/lookup').send({ number: '9999999', pin: '1234' });
    const b = await request(kioskApp).post('/api/v1/kiosk/lookup').send({ number: c.card_number, pin: '0000' });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body).toEqual(b.body);
  });

  it('rate limits to 5/min/IP', async () => {
    const kioskApp = createApp();
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await request(kioskApp).get('/api/v1/kiosk/cards/0000000?pin=0000')).status);
    expect(codes.slice(0, 5).every((s) => s === 401)).toBe(true);
    expect(codes.slice(5)).toEqual([429, 429]);
  });

  it('staff PIN reset unlocks a kiosk-locked card and the new PIN works', async () => {
    const c = await issue(3000); // PIN 4321
    for (let i = 0; i < 5; i++) await request(createApp()).post('/api/v1/kiosk/lookup').send({ number: c.card_number, pin: '0000' });
    const locked = await request(createApp()).post('/api/v1/kiosk/lookup').send({ number: c.card_number, pin: '4321' });
    expect(locked.status).toBe(401); // locked out even with the right PIN

    const reset = await request(app).patch(`/api/v1/cards/${c.id}`).set(as('staff')).set('Idempotency-Key', key()).send({ pin: '8642' });
    expect(reset.status).toBe(200);
    expect(reset.body.card.has_pin).toBe(true);

    const ok = await request(createApp()).post('/api/v1/kiosk/lookup').send({ number: c.card_number, pin: '8642' });
    expect(ok.status).toBe(200);
    expect(ok.body.balance_cents).toBe(3000);
    expect((await request(createApp()).post('/api/v1/kiosk/lookup').send({ number: c.card_number, pin: '4321' })).status).toBe(401);
    const audit = await one(`SELECT payload FROM audit_log WHERE card_id = $1 AND action = 'card.updated' ORDER BY id DESC LIMIT 1`, [c.id]);
    expect(audit!.payload.changed.pin_hash).toBe('set'); // logged, hash never stored in audit
  });

  it('QR token lookup + report lost freezes the card', async () => {
    const kioskApp = createApp();
    const c = await issue(1500);
    const { qrToken } = await import('../src/services/qr.js');
    const r = await request(kioskApp).get(`/api/v1/kiosk/qr/${qrToken(c.id)}`);
    expect(r.body.balance_cents).toBe(1500);
    const lost = await request(kioskApp).post('/api/v1/kiosk/report-lost').send({ token: qrToken(c.id) });
    expect(lost.body.status).toBe('FROZEN');
  });
});

describe('history, import, settings', () => {
  it('history filters by card and action, exports CSV', async () => {
    const c = await issue(3000);
    await post('staff', `/cards/${c.id}/redeem`, { amount_cents: 500 });
    await request(app).put(`/api/v1/cards/${c.id}/freeze`).set(as('staff')).set('Idempotency-Key', key()).send({ reason: 'Testing freeze' });
    const r = await request(app).get(`/api/v1/history?card=${c.card_number}`).set(as('owner'));
    expect(r.body.data.map((h: any) => h.action)).toEqual(expect.arrayContaining(['ISSUE', 'REDEEM', 'card.frozen', 'card.issued']));
    const redeem = r.body.data.find((h: any) => h.action === 'REDEEM');
    expect(redeem).toMatchObject({ amount_cents: -500, balance_after_cents: 2500, actor_name: 'Front Desk' });
    const only = await request(app).get(`/api/v1/history?card=${c.card_number}&action=REDEEM`).set(as('owner'));
    expect(only.body.data).toHaveLength(1);
    const csv = await request(app).get(`/api/v1/history/export.csv?card=${c.card_number}`).set(as('owner'));
    expect(csv.text).toContain('REDEEM');
  });

  it('CSV import: mapping step → dry run (dedupe) → commit', async () => {
    const n1 = num();
    const n2 = num();
    const csv = `Card #,Balance,Value,First Name,Phone\n${n1},25.00,50.00,Ann,555-123-4567\n${n2},10,,Bob,\n${n1},5,5,Dup,\n3460010,1,1,Exists,\nBAD!,1,1,x,\n`;
    const step1 = await post('owner', '/import/csv', { filename: 'legacy.csv', csv });
    expect(step1.body.step).toBe('mapping');
    expect(step1.body.suggested_mapping).toMatchObject({ card_number: 'Card #', balance: 'Balance', face_value: 'Value', first_name: 'First Name', phone: 'Phone' });

    const dry = await post('owner', '/import/csv', { filename: 'legacy.csv', csv, mapping: step1.body.suggested_mapping, dry_run: true });
    expect(dry.body).toMatchObject({ step: 'preview', rows_total: 5, rows_ok: 2, rows_failed: 1, rows_skipped: 2, total_balance_cents: 3500 });
    expect((await one('SELECT 1 FROM gift_cards WHERE card_number = $1', [n1]))).toBeUndefined();

    const done = await post('owner', '/import/csv', { filename: 'legacy.csv', csv, mapping: step1.body.suggested_mapping, dry_run: false });
    expect(done.body.rows_ok).toBe(2);
    const c1 = await one<{ status: string; balance: string; issue_channel: string }>(`SELECT status::text, balance::text, issue_channel::text FROM gift_cards WHERE card_number = $1`, [n1]);
    expect(c1).toEqual({ status: 'PARTIALUSED', balance: '25.00', issue_channel: 'IMPORT' });
  });

  it('settings are validated; security is owner-only', async () => {
    const bad = await request(app).put('/api/v1/settings/general').set(as('manager')).set('Idempotency-Key', key()).send({ value: { business_name: '' } });
    expect(bad.status).toBe(400);
    const sec = await request(app).get('/api/v1/settings/security').set(as('manager'));
    const denied = await request(app).put('/api/v1/settings/security').set(as('manager')).set('Idempotency-Key', key()).send({ value: sec.body.value });
    expect(denied.status).toBe(403);
    const ok = await request(app).put('/api/v1/settings/security').set(as('owner')).set('Idempotency-Key', key()).send({ value: sec.body.value });
    expect(ok.status).toBe(200);
  });

  it('dashboard summary has the widgets', async () => {
    const r = await request(app).get('/api/v1/dashboard/summary').set(as('staff'));
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('outstanding_total_cents');
    expect(r.body.today).toHaveProperty('revenue_recognized_cents');
    expect(r.body.series).toHaveLength(14);
    expect(r.body.alerts.length).toBeGreaterThan(0); // insufficient-funds attempts above
  });
});
