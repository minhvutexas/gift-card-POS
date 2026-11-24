import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { one, query } from '../src/db.js';
import { toApiError } from '../src/errors.js';
import * as cards from '../src/services/cards.js';
import type { Actor } from '../src/types.js';
import { key, ledgerConsistent, newCard, num, ownerActor, pool } from './helpers.js';

let actor: Actor;
beforeAll(async () => {
  actor = await ownerActor();
});
afterAll(async () => {
  await pool.end();
});

/** Runs fn and returns the API error code it threw (or 'OK'). */
async function code(fn: () => Promise<unknown>) {
  try {
    await fn();
    return 'OK';
  } catch (e) {
    return toApiError(e).code;
  }
}

describe('seed data (source POS screenshot)', () => {
  it('reproduces the 4 cards exactly', async () => {
    const { rows } = await query(`SELECT card_number, status::text, balance::text FROM gift_cards WHERE card_number IN ('3460001','3460002','3460003','3460010') ORDER BY card_number`);
    expect(rows).toEqual([
      { card_number: '3460001', status: 'PARTIALUSED', balance: '15.00' },
      { card_number: '3460002', status: 'PARTIALUSED', balance: '98.00' },
      { card_number: '3460003', status: 'PARTIALUSED', balance: '22.00' },
      { card_number: '3460010', status: 'ACTIVE', balance: '500.00' },
    ]);
    const seedSum = await one<{ s: string }>(`SELECT SUM(balance)::text AS s FROM gift_cards WHERE card_number IN ('3460001','3460002','3460003','3460010')`);
    expect(seedSum!.s).toBe('635.00');
  });
});

describe('lifecycle transitions', () => {
  it('ISSUE → ACTIVE, partial REDEEM → PARTIALUSED, exact-balance REDEEM → CLOSED', async () => {
    const c = await newCard(actor, 5000);
    expect(c.status).toBe('ACTIVE');
    expect(c.balance_cents).toBe(5000);

    let r = await cards.applyTxn(actor, c.id, 'REDEEM', -1999, { idempotencyKey: key() });
    expect(r.status).toBe('PARTIALUSED');
    expect(r.balance_cents).toBe(3001);

    r = await cards.applyTxn(actor, c.id, 'REDEEM', -3001, { idempotencyKey: key() }); // exact balance
    expect(r.status).toBe('CLOSED');
    expect(r.balance_cents).toBe(0);
    expect(await ledgerConsistent(c.id)).toBe(true);
  });

  it('rejects redemption greater than balance with a clear message, balance untouched', async () => {
    const c = await newCard(actor, 2200);
    const err = await cards.applyTxn(actor, c.id, 'REDEEM', -2201, { idempotencyKey: key() }).catch(toApiError);
    expect(err).toMatchObject({ code: 'INSUFFICIENT_FUNDS', message: 'Insufficient: $22.00 available', details: { available_cents: 2200, requested_cents: 2201 } });
    expect((await cards.getCard(c.id)).balance_cents).toBe(2200);
    const alert = await one(`SELECT 1 FROM audit_log WHERE card_id = $1 AND action = 'alert.insufficient_funds'`, [c.id]);
    expect(alert).toBeTruthy();
  });

  it('redeem on a CLOSED card says insufficient; RELOAD reopens it', async () => {
    const c = await newCard(actor, 1000);
    await cards.applyTxn(actor, c.id, 'REDEEM', -1000, { idempotencyKey: key() });
    expect(await code(() => cards.applyTxn(actor, c.id, 'REDEEM', -1, { idempotencyKey: key() }))).toBe('INSUFFICIENT_FUNDS');
    const r = await cards.applyTxn(actor, c.id, 'RELOAD', 500, { idempotencyKey: key() });
    expect(r.status).toBe('PARTIALUSED'); // below face value
    const r2 = await cards.applyTxn(actor, c.id, 'RELOAD', 1000, { idempotencyKey: key() });
    expect(r2.status).toBe('ACTIVE'); // at/above face value
    expect(r2.balance_cents).toBe(1500);
  });

  it('rejects zero / wrong-sign amounts', async () => {
    const c = await newCard(actor, 1000);
    expect(await code(() => cards.applyTxn(actor, c.id, 'REDEEM', 0))).toBe('VALIDATION');
    expect(await code(() => cards.applyTxn(actor, c.id, 'REDEEM', 500))).toBe('VALIDATION');
    expect(await code(() => cards.applyTxn(actor, c.id, 'RELOAD', -500))).toBe('VALIDATION');
  });

  it('PENDING_ACTIVATION cannot be redeemed until ACTIVATE', async () => {
    const r = await cards.issueCard(actor, { card_number: num(), face_value_cents: 2500, activate: false }, key());
    expect(r.card.status).toBe('PENDING_ACTIVATION');
    expect(r.card.balance_cents).toBe(0);
    expect(await code(() => cards.applyTxn(actor, r.card.id, 'REDEEM', -100))).toBe('STATE_CONFLICT');
    const a = await cards.applyTxn(actor, r.card.id, 'ACTIVATE', 2500, { idempotencyKey: key() });
    expect(a.status).toBe('ACTIVE');
    expect(a.card.activation_date).not.toBeNull();
  });
});

describe('freeze / expiry / void', () => {
  it('redeem on a FROZEN card fails and raises an alert; unfreeze restores status', async () => {
    const c = await newCard(actor, 4000);
    await cards.applyTxn(actor, c.id, 'REDEEM', -1000, { idempotencyKey: key() });
    const f = await cards.setFrozen(actor, c.id, true, 'Suspicious use');
    expect(f.status).toBe('FROZEN');
    const err = await cards.applyTxn(actor, c.id, 'REDEEM', -100, { idempotencyKey: key() }).catch(toApiError);
    expect(err.code).toBe('CARD_FROZEN');
    expect(err.status).toBe(423);
    expect(await one(`SELECT 1 FROM audit_log WHERE card_id = $1 AND action = 'alert.frozen_card_used'`, [c.id])).toBeTruthy();
    expect(await code(() => cards.applyTxn(actor, c.id, 'RELOAD', 100))).toBe('CARD_FROZEN');
    const u = await cards.setFrozen(actor, c.id, false, null);
    expect(u.status).toBe('PARTIALUSED');
    expect(u.card.frozen_at).toBeNull();
  });

  it('expired card (by date) cannot be redeemed even before the nightly job; job expires it as breakage', async () => {
    const c = await newCard(actor, 3000);
    await query(`UPDATE gift_cards SET expires_at = now() - interval '1 minute' WHERE id = $1`, [c.id]);
    expect(await code(() => cards.applyTxn(actor, c.id, 'REDEEM', -100, { idempotencyKey: key() }))).toBe('CARD_EXPIRED');

    const n = await one<{ n: number }>('SELECT fn_expire_due_cards() AS n');
    expect(n!.n).toBeGreaterThanOrEqual(1);
    const after = await cards.getCard(c.id);
    expect(after.status).toBe('EXPIRED');
    expect(after.balance_cents).toBe(0);
    const t = await one<{ amount: string }>(`SELECT amount::text FROM gift_card_transactions WHERE card_id = $1 AND txn_type = 'EXPIRE'`, [c.id]);
    expect(t!.amount).toBe('-30.00');
    // Running the job again is a no-op for this card.
    await query('SELECT fn_expire_due_cards()');
    expect((await query(`SELECT 1 FROM gift_card_transactions WHERE card_id = $1 AND txn_type = 'EXPIRE'`, [c.id])).rowCount).toBe(1);
    expect(await code(() => cards.applyTxn(actor, c.id, 'RELOAD', 100))).toBe('CARD_EXPIRED');
  });

  it('VOID drains the balance, is terminal, and is recorded with reason', async () => {
    const c = await newCard(actor, 7500);
    const r = await cards.applyTxn(actor, c.id, 'VOID', null, { memo: 'Sold in error', idempotencyKey: key() });
    expect(r.status).toBe('VOIDED');
    expect(r.balance_cents).toBe(0);
    expect(r.card.void_reason).toBe('Sold in error');
    expect(r.transaction!.amount_cents).toBe(-7500);
    expect(await code(() => cards.applyTxn(actor, c.id, 'RELOAD', 100))).toBe('CARD_VOIDED');
    expect(await code(() => cards.setFrozen(actor, c.id, true, 'x'))).toBe('STATE_CONFLICT');
  });
});

describe('idempotency (double scan)', () => {
  it('same key twice → exactly one ledger row, same txn returned', async () => {
    const c = await newCard(actor, 5000);
    const k = key();
    const a = await cards.applyTxn(actor, c.id, 'REDEEM', -1500, { idempotencyKey: k });
    const b = await cards.applyTxn(actor, c.id, 'REDEEM', -1500, { idempotencyKey: k });
    expect(b.transaction!.id).toBe(a.transaction!.id);
    expect(b.balance_cents).toBe(3500);
    expect((await query(`SELECT 1 FROM gift_card_transactions WHERE card_id = $1 AND txn_type = 'REDEEM'`, [c.id])).rowCount).toBe(1);
  });

  it('same key, different amount → IDEMPOTENCY_CONFLICT', async () => {
    const c = await newCard(actor, 5000);
    const k = key();
    await cards.applyTxn(actor, c.id, 'REDEEM', -1500, { idempotencyKey: k });
    expect(await code(() => cards.applyTxn(actor, c.id, 'REDEEM', -1600, { idempotencyKey: k }))).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('5 concurrent requests with the same key → one debit', async () => {
    const c = await newCard(actor, 5000);
    const k = key();
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => cards.applyTxn(actor, c.id, 'REDEEM', -1000, { idempotencyKey: k })));
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect((await cards.getCard(c.id)).balance_cents).toBe(4000);
    expect((await query(`SELECT 1 FROM gift_card_transactions WHERE card_id = $1 AND txn_type = 'REDEEM'`, [c.id])).rowCount).toBe(1);
  });
});

describe('concurrency', () => {
  it('concurrent redeems totaling more than the balance: extras fail cleanly, never negative', async () => {
    const c = await newCard(actor, 10000);
    const attempts = 10; // 10 × $30 against $100
    const results = await Promise.allSettled(Array.from({ length: attempts }, () => cards.applyTxn(actor, c.id, 'REDEEM', -3000, { idempotencyKey: key() })));
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(3);
    expect(failed).toHaveLength(7);
    for (const f of failed) expect(toApiError(f.reason).code).toBe('INSUFFICIENT_FUNDS');
    const after = await cards.getCard(c.id);
    expect(after.balance_cents).toBe(1000);
    expect(await ledgerConsistent(c.id)).toBe(true);
  });

  it('two concurrent redeems of $60 on $100 → exactly one succeeds', async () => {
    const c = await newCard(actor, 10000);
    const [a, b] = await Promise.allSettled([
      cards.applyTxn(actor, c.id, 'REDEEM', -6000, { idempotencyKey: key() }),
      cards.applyTxn(actor, c.id, 'REDEEM', -6000, { idempotencyKey: key() }),
    ]);
    expect([a.status, b.status].sort()).toEqual(['fulfilled', 'rejected']);
    expect((await cards.getCard(c.id)).balance_cents).toBe(4000);
  });

  it('redeem + tip is atomic: tip that would overdraw rolls back the redeem too', async () => {
    const c = await newCard(actor, 5000);
    const err = await cards.redeem(actor, c.id, 4500, 1000, { idempotencyKey: key() }).catch(toApiError);
    expect(err.code).toBe('INSUFFICIENT_FUNDS');
    expect((await cards.getCard(c.id)).balance_cents).toBe(5000);
    const ok = await cards.redeem(actor, c.id, 4000, 1000, { idempotencyKey: key() });
    expect(ok.balance_cents).toBe(0);
    expect(ok.status).toBe('CLOSED');
    expect(ok.tip_transaction!.txn_type).toBe('TIP_FROM_CARD');
  });
});

describe('transfer / merge / split / replace / reversal', () => {
  it('transfer moves value and conserves the total', async () => {
    const a = await newCard(actor, 5000);
    const b = await newCard(actor, 2000);
    const r = await cards.transfer(actor, a.id, b.id, 1250, null, key());
    expect(r.from.balance_cents).toBe(3750);
    expect(r.to.balance_cents).toBe(3250);
    expect(await code(() => cards.transfer(actor, a.id, b.id, 999999, null, key()))).toBe('INSUFFICIENT_FUNDS');
    expect(await code(() => cards.transfer(actor, a.id, a.id, 100, null, key()))).toBe('VALIDATION');
  });

  it('merge drains source into destination and closes the source', async () => {
    const a = await newCard(actor, 3000);
    const b = await newCard(actor, 1000);
    const r = await cards.merge(actor, a.id, b.id, key());
    expect(r.from.status).toBe('CLOSED');
    expect(r.from.balance_cents).toBe(0);
    expect(r.to.balance_cents).toBe(4000);
    expect(await code(() => cards.merge(actor, a.id, b.id, key()))).toBe('STATE_CONFLICT');
  });

  it('split carves a new ACTIVE card off an existing one', async () => {
    const a = await newCard(actor, 10000);
    const r = await cards.split(actor, a.id, 2500, null, key());
    expect(r.from.balance_cents).toBe(7500);
    expect(r.to.balance_cents).toBe(2500);
    expect(r.to.status).toBe('ACTIVE');
    expect(r.to.card.card_number).toMatch(/^\d+$/); // auto-numbered
  });

  it('replace lost card moves balance, keeps the audit link, old card is terminal', async () => {
    const a = await newCard(actor, 8000);
    await cards.applyTxn(actor, a.id, 'REDEEM', -3000, { idempotencyKey: key() });
    await cards.setFrozen(actor, a.id, true, 'Customer lost card');
    const newNumber = num();
    const r = await cards.replaceLost(actor, a.id, newNumber, 'Lost in parking lot', key());
    expect(r.old.status).toBe('LOST_REPLACED');
    expect(r.old.balance_cents).toBe(0);
    expect(r.old.card.replaced_by_card_id).toBe(r.new.card.id);
    expect(r.new.card.card_number).toBe(newNumber);
    expect(r.new.balance_cents).toBe(5000);
    expect(r.new.status).toBe('PARTIALUSED');
    expect(await code(() => cards.applyTxn(actor, a.id, 'RELOAD', 100))).toBe('CARD_VOIDED');
  });

  it('reversal restores balance once; second reversal is rejected', async () => {
    const c = await newCard(actor, 5000);
    const r = await cards.applyTxn(actor, c.id, 'REDEEM', -2000, { idempotencyKey: key() });
    const rev = await cards.reverseTxn(actor, r.transaction!.id, 'Undo', key(), null);
    expect(rev.balance_cents).toBe(5000);
    expect(rev.status).toBe('ACTIVE');
    expect(await code(() => cards.reverseTxn(actor, r.transaction!.id, 'again', key(), null))).toBe('ALREADY_REVERSED');
    expect(await code(() => cards.reverseTxn(actor, rev.transaction!.id, 'reverse a reversal', key(), null))).toBe('STATE_CONFLICT');
  });
});

describe('ledger integrity', () => {
  it('ledger rows cannot be updated or deleted; balance cannot be written directly', async () => {
    const c = await newCard(actor, 1000);
    expect(await code(() => query(`UPDATE gift_card_transactions SET amount = 999 WHERE card_id = $1`, [c.id]))).toBe('STATE_CONFLICT');
    expect(await code(() => query(`DELETE FROM gift_card_transactions WHERE card_id = $1`, [c.id]))).toBe('STATE_CONFLICT');
    expect(await code(() => query(`DELETE FROM audit_log WHERE card_id = $1`, [c.id]))).toBe('STATE_CONFLICT');
    expect(await code(() => query(`UPDATE gift_cards SET balance = 1000000 WHERE id = $1`, [c.id]))).toBe('STATE_CONFLICT');
    expect(await code(() => query(`UPDATE gift_cards SET status = 'ACTIVE' WHERE id = $1`, [c.id]))).toBe('OK'); // unchanged value is fine
    expect(await code(() => query(`INSERT INTO gift_cards (card_number, face_value, balance, status) VALUES ($1, 10, 10, 'ACTIVE')`, [num()]))).toBe('STATE_CONFLICT');
  });

  it('every card balance equals its ledger (sum and last balance_after)', async () => {
    const bad = await one<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM gift_cards c
       WHERE c.balance <> COALESCE((SELECT SUM(amount) FROM gift_card_transactions t WHERE t.card_id = c.id), 0)
          OR c.balance <> COALESCE((SELECT balance_after FROM gift_card_transactions t WHERE t.card_id = c.id ORDER BY id DESC LIMIT 1), 0)`,
    );
    expect(bad!.n).toBe(0);
    const neg = await one<{ n: number }>(`SELECT COUNT(*)::int AS n FROM gift_cards WHERE balance < 0`);
    expect(neg!.n).toBe(0);
  });

  it('outstanding liability view = sum of ACTIVE + PARTIALUSED balances', async () => {
    const v = await cards.outstanding();
    const s = await one<{ c: number }>(`SELECT (COALESCE(SUM(balance),0)*100)::bigint AS c FROM gift_cards WHERE status IN ('ACTIVE','PARTIALUSED') AND deleted_at IS NULL`);
    expect(v.total_cents).toBe(s!.c);
  });
});

describe('Clear Zero-Balance archive', () => {
  it('dry run lists, commit archives, restore within 30 days brings them back', async () => {
    const c = await newCard(actor, 1000);
    await cards.applyTxn(actor, c.id, 'REDEEM', -1000, { idempotencyKey: key() });
    const live = await newCard(actor, 1000);

    const dry = await cards.archiveZero(actor, true);
    expect(dry.card_ids).toContain(c.id);
    expect(dry.card_ids).not.toContain(live.id);
    expect((await cards.getCard(c.id)).archived_at).toBeNull();

    const done = await cards.archiveZero(actor, false);
    expect(done.count).toBe(dry.count);
    expect(done.face_value_total_cents).toBeGreaterThanOrEqual(1000);
    expect((await cards.getCard(c.id)).archived_at).not.toBeNull();
    const list = await cards.listCards({ q: c.card_number });
    expect(list.data.find((x) => x.id === c.id)).toBeUndefined();

    const restored = await cards.restoreArchived(actor, [c.id]);
    expect(restored.restored).toBe(1);
    expect((await cards.getCard(c.id)).archived_at).toBeNull();
    // history retained throughout
    expect((await cards.cardTxns(c.id)).length).toBe(2);
  });
});
