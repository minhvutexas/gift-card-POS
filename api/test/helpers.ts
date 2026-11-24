import { randomUUID } from 'node:crypto';
import { one, pool } from '../src/db.js';
import { issueCard } from '../src/services/cards.js';
import type { Actor } from '../src/types.js';

let seq = 0;
/** Unique card number per test run (letters keep them clear of seed/auto numbers). */
export const num = () => `T${Date.now().toString(36).toUpperCase().slice(-6)}${(seq++).toString(36).toUpperCase()}`.slice(0, 20);
export const key = () => randomUUID();

export async function ownerActor(): Promise<Actor> {
  const u = await one<{ id: number }>(`SELECT id FROM users WHERE username = 'owner'`);
  return { actorType: 'USER', actorId: u!.id, terminalId: null, ip: '127.0.0.1', ua: 'vitest' };
}

export async function newCard(actor: Actor, faceCents: number, extra: Partial<Parameters<typeof issueCard>[1]> = {}) {
  const r = await issueCard(actor, { card_number: num(), face_value_cents: faceCents, ...extra }, key());
  return r.card;
}

export async function ledgerConsistent(cardId: number) {
  const r = await one<{ bal: string; last: string | null; sum: string | null }>(
    `SELECT c.balance AS bal,
            (SELECT balance_after FROM gift_card_transactions WHERE card_id = c.id ORDER BY id DESC LIMIT 1) AS last,
            (SELECT SUM(amount) FROM gift_card_transactions WHERE card_id = c.id) AS sum
     FROM gift_cards c WHERE c.id = $1`,
    [cardId],
  );
  return r!.bal === (r!.last ?? '0.00') && r!.bal === (r!.sum ?? '0.00');
}

export { pool };
