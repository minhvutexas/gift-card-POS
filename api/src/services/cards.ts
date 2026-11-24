import type pg from 'pg';
import { one, query, withTx, type Db, pool } from '../db.js';
import { ApiError, notFound, toApiError } from '../errors.js';
import { audit } from '../audit.js';
import { getSetting } from '../settings.js';
import { formatCents } from '../money.js';
import type { Actor } from '../types.js';
import { notifyAfterTxn } from './messaging.js';

// ---------------------------------------------------------------- shapes
export interface Card {
  id: number;
  card_number: string;
  status: string;
  balance_cents: number;
  face_value_cents: number;
  currency: string;
  label: string | null;
  color_tag: string | null;
  issue_channel: string;
  activation_date: string | null;
  expires_at: string | null;
  last_used_at: string | null;
  frozen_at: string | null;
  freeze_reason: string | null;
  voided_at: string | null;
  void_reason: string | null;
  replaced_by_card_id: number | null;
  notes: string | null;
  has_pin: boolean;
  archived_at: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  customer: { id: number; first_name: string | null; last_name: string | null; phone: string | null; email: string | null; erased: boolean } | null;
  tags: { id: number; name: string; color: string }[];
}

export interface Txn {
  id: number;
  card_id: number;
  txn_type: string;
  amount_cents: number;
  balance_after_cents: number;
  memo: string | null;
  external_ref: string | null;
  related_card_id: number | null;
  reverses_txn_id: number | null;
  actor_type: string;
  actor_id: number | null;
  actor_name: string | null;
  approved_by: number | null;
  terminal_id: number | null;
  created_at: string;
  reversed: boolean;
}

export const CARD_SELECT = `
SELECT c.id, c.card_number, c.status::text AS status,
       (c.balance * 100)::bigint AS balance_cents, (c.face_value * 100)::bigint AS face_value_cents,
       c.currency::text AS currency, c.label, c.color_tag, c.issue_channel::text AS issue_channel,
       c.activation_date, c.expires_at, c.last_used_at, c.frozen_at, c.freeze_reason, c.voided_at,
       c.void_reason, c.replaced_by_card_id, c.notes, (c.pin_hash IS NOT NULL) AS has_pin,
       c.archived_at, c.deleted_at, c.created_at, c.updated_at,
       CASE WHEN cu.id IS NULL THEN NULL ELSE json_build_object(
         'id', cu.id, 'first_name', cu.first_name, 'last_name', cu.last_name,
         'phone', cu.phone, 'email', cu.email, 'erased', cu.erased_at IS NOT NULL) END AS customer,
       COALESCE((SELECT json_agg(json_build_object('id', t.id, 'name', t.name, 'color', t.color) ORDER BY t.name)
                 FROM gift_card_tags gt JOIN card_tags t ON t.id = gt.tag_id WHERE gt.card_id = c.id), '[]'::json) AS tags
FROM gift_cards c
LEFT JOIN customers cu ON cu.id = c.customer_id`;

export const TXN_SELECT = `
SELECT t.id, t.card_id, t.txn_type::text AS txn_type, (t.amount * 100)::bigint AS amount_cents,
       (t.balance_after * 100)::bigint AS balance_after_cents, t.memo, t.external_ref, t.related_card_id,
       t.reverses_txn_id, t.actor_type::text AS actor_type, t.actor_id, u.name AS actor_name,
       t.approved_by, t.terminal_id, t.created_at,
       EXISTS (SELECT 1 FROM gift_card_transactions r WHERE r.reverses_txn_id = t.id) AS reversed
FROM gift_card_transactions t
LEFT JOIN users u ON u.id = t.actor_id`;

export async function getCard(id: number, db: Db = pool, opts: { includeDeleted?: boolean } = {}): Promise<Card> {
  const card = await one<Card>(`${CARD_SELECT} WHERE c.id = $1 ${opts.includeDeleted ? '' : 'AND c.deleted_at IS NULL'}`, [id], db);
  if (!card) throw new ApiError(404, 'CARD_NOT_FOUND', `Gift card ${id} not found`);
  return card;
}

export async function getCardByNumber(number: string, db: Db = pool): Promise<Card> {
  const card = await one<Card>(`${CARD_SELECT} WHERE c.card_number = upper(trim($1)) AND c.deleted_at IS NULL`, [number], db);
  if (!card) throw new ApiError(404, 'CARD_NOT_FOUND', `Card ${number} not found`);
  return card;
}

export async function getTxn(id: number, db: Db = pool): Promise<Txn> {
  const t = await one<Txn>(`${TXN_SELECT} WHERE t.id = $1`, [id], db);
  if (!t) throw notFound('Transaction not found');
  return t;
}

export async function cardTxns(cardId: number, limit = 100, db: Db = pool): Promise<Txn[]> {
  const { rows } = await query<Txn>(`${TXN_SELECT} WHERE t.card_id = $1 ORDER BY t.created_at DESC, t.id DESC LIMIT $2`, [cardId, limit], db);
  return rows;
}

// ---------------------------------------------------------------- list
export const STATUS_FILTERS: Record<string, string> = {
  all: 'TRUE',
  active: `c.status = 'ACTIVE'`,
  partial: `c.status = 'PARTIALUSED'`,
  zero: `c.balance = 0`,
  frozen: `c.status = 'FROZEN'`,
  voided: `c.status = 'VOIDED'`,
  pending: `c.status = 'PENDING_ACTIVATION'`,
  expired: `c.status = 'EXPIRED'`,
  closed: `c.status = 'CLOSED'`,
  live: `c.status IN ('ACTIVE','PARTIALUSED')`,
};

export const SORTS: Record<string, string> = {
  balance_desc: 'c.balance DESC, c.id DESC',
  balance_asc: 'c.balance ASC, c.id DESC',
  created_desc: 'c.created_at DESC, c.id DESC',
  created_asc: 'c.created_at ASC, c.id ASC',
  last_used_desc: 'c.last_used_at DESC NULLS LAST, c.id DESC',
  status: `array_position(ARRAY['ACTIVE','PARTIALUSED','PENDING_ACTIVATION','FROZEN','CLOSED','EXPIRED','VOIDED','LOST_REPLACED']::card_status[], c.status), c.balance DESC`,
  label: 'LOWER(c.label) ASC NULLS LAST, c.card_number ASC',
  number: 'c.card_number ASC',
};

export interface ListParams {
  status?: string;
  q?: string;
  sort?: string;
  page?: number;
  per_page?: number;
  archived?: 'exclude' | 'include' | 'only';
  customer_id?: number;
  tag_id?: number;
  ids?: number[];
}

export async function listCards(p: ListParams) {
  const where: string[] = ['c.deleted_at IS NULL'];
  const params: unknown[] = [];
  const add = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  where.push(STATUS_FILTERS[p.status ?? 'all'] ?? 'TRUE');
  if (p.archived === 'only') where.push('c.archived_at IS NOT NULL');
  else if (p.archived !== 'include') where.push('c.archived_at IS NULL');
  if (p.customer_id) where.push(`c.customer_id = ${add(p.customer_id)}`);
  if (p.tag_id) where.push(`EXISTS (SELECT 1 FROM gift_card_tags gt WHERE gt.card_id = c.id AND gt.tag_id = ${add(p.tag_id)})`);
  if (p.ids?.length) where.push(`c.id = ANY(${add(p.ids)})`);
  if (p.q?.trim()) {
    const like = add(`%${p.q.trim().replace(/[%_\\]/g, (m) => '\\' + m)}%`);
    const digits = p.q.replace(/\D/g, '');
    where.push(`(c.card_number ILIKE ${like} OR c.label ILIKE ${like} OR cu.email ILIKE ${like}
      OR (COALESCE(cu.first_name,'') || ' ' || COALESCE(cu.last_name,'')) ILIKE ${like}
      ${digits.length >= 3 ? `OR regexp_replace(COALESCE(cu.phone,''), '\\D', '', 'g') LIKE ${add(`%${digits}%`)}` : ''}
      OR EXISTS (SELECT 1 FROM gift_card_tags gt JOIN card_tags t ON t.id = gt.tag_id WHERE gt.card_id = c.id AND t.name ILIKE ${like}))`);
  }
  const perPage = Math.min(Math.max(p.per_page ?? 50, 1), 500);
  const page = Math.max(p.page ?? 1, 1);
  const order = SORTS[p.sort ?? 'balance_desc'] ?? SORTS.balance_desc;
  const whereSql = where.join(' AND ');

  const [rows, count, liab] = await Promise.all([
    query<Card>(`${CARD_SELECT} WHERE ${whereSql} ORDER BY ${order} LIMIT ${perPage} OFFSET ${(page - 1) * perPage}`, params),
    one<{ n: number }>(`SELECT COUNT(*)::int AS n FROM gift_cards c LEFT JOIN customers cu ON cu.id = c.customer_id WHERE ${whereSql}`, params),
    outstanding(),
  ]);
  return {
    data: rows.rows,
    meta: {
      page,
      per_page: perPage,
      total: count?.n ?? 0,
      outstanding_total_cents: liab.total_cents,
      outstanding_card_count: liab.card_count,
    },
  };
}

export async function outstanding(db: Db = pool) {
  return (await one<{ total_cents: number; card_count: number }>('SELECT total_cents, card_count FROM v_outstanding_liability', [], db))!;
}

// ---------------------------------------------------------------- money ops
export interface TxnOpts {
  memo?: string | null;
  externalRef?: string | null;
  idempotencyKey?: string | null;
  approvedBy?: number | null;
  relatedCardId?: number | null;
  reversesTxnId?: number | null;
}

export interface MutationResult {
  card: Card;
  transaction?: Txn;
  balance_cents: number;
  status: string;
  outstanding_total_cents: number;
}

async function result(c: pg.PoolClient, cardId: number, txnId?: number): Promise<MutationResult> {
  const card = await getCard(cardId, c, { includeDeleted: true });
  const transaction = txnId ? await getTxn(txnId, c) : undefined;
  const liab = await outstanding(c);
  return { card, transaction, balance_cents: card.balance_cents, status: card.status, outstanding_total_cents: liab.total_cents };
}

const ALERT_FOR: Record<string, string> = {
  CARD_FROZEN: 'alert.frozen_card_used',
  INSUFFICIENT_FUNDS: 'alert.insufficient_funds',
  CARD_EXPIRED: 'alert.expired_card_used',
  CARD_VOIDED: 'alert.voided_card_used',
};

/** Records an alert row for blocked attempts so the dashboard can surface them. */
async function alertOnFailure(err: unknown, actor: Actor, cardId: number, extra: Record<string, unknown>) {
  const e = toApiError(err);
  const action = ALERT_FOR[e.code];
  // Awaited (so the dashboard sees it immediately) but never masks the original error.
  if (action) await audit(actor, action, { cardId, payload: { ...extra, message: e.message } }).catch((x) => console.error('alert audit failed', x.message));
}

export async function applyTxn(actor: Actor, cardId: number, type: string, amountCents: number | null, opts: TxnOpts = {}): Promise<MutationResult> {
  try {
    const res = await withTx(async (c) => {
      const t = await one<{ id: number }>(
        `SELECT (fn_apply_txn($1, $2::txn_type, $3, $4, $5, $6::actor_type, $7, $8, $9::inet, $10, $11, $12, $13, $14)).id AS id`,
        [cardId, type, amountCents, opts.memo ?? null, opts.externalRef ?? null, actor.actorType, actor.actorId, actor.terminalId, actor.ip, actor.ua,
          opts.idempotencyKey ?? null, opts.relatedCardId ?? null, opts.reversesTxnId ?? null, opts.approvedBy ?? null],
        c,
      );
      if (type === 'REDEEM' || type === 'TIP_FROM_CARD') await awardLoyalty(c, actor, cardId, -(amountCents ?? 0), t!.id);
      return result(c, cardId, t!.id);
    });
    notifyAfterTxn(res.card, res.transaction!).catch((e) => console.error('notify failed', e.message));
    return res;
  } catch (err) {
    await alertOnFailure(err, actor, cardId, { txn_type: type, amount_cents: amountCents });
    throw err;
  }
}

/**
 * Redeem (+ optional tip paid from the card) atomically: both debits commit
 * together or not at all, so "service + tip" can never overdraw.
 */
export async function redeem(actor: Actor, cardId: number, amountCents: number, tipCents: number, opts: TxnOpts = {}): Promise<MutationResult & { tip_transaction?: Txn }> {
  try {
    const res = await withTx(async (c) => {
      const call = (type: string, cents: number, key: string | null) =>
        one<{ id: number }>(
          `SELECT (fn_apply_txn($1, $2::txn_type, $3, $4, $5, $6::actor_type, $7, $8, $9::inet, $10, $11, NULL, NULL, $12)).id AS id`,
          [cardId, type, -cents, opts.memo ?? null, opts.externalRef ?? null, actor.actorType, actor.actorId, actor.terminalId, actor.ip, actor.ua, key, opts.approvedBy ?? null],
          c,
        );
      const t = await call('REDEEM', amountCents, opts.idempotencyKey ?? null);
      const tip = tipCents > 0 ? await call('TIP_FROM_CARD', tipCents, opts.idempotencyKey ? `${opts.idempotencyKey}:tip` : null) : null;
      await awardLoyalty(c, actor, cardId, amountCents, t!.id);
      const r = await result(c, cardId, t!.id);
      return { ...r, tip_transaction: tip ? await getTxn(tip.id, c) : undefined };
    });
    notifyAfterTxn(res.card, res.tip_transaction ?? res.transaction!).catch((e) => console.error('notify failed', e.message));
    return res;
  } catch (err) {
    await alertOnFailure(err, actor, cardId, { txn_type: 'REDEEM', amount_cents: amountCents, tip_cents: tipCents });
    throw err;
  }
}

async function awardLoyalty(c: pg.PoolClient, actor: Actor, cardId: number, spentCents: number, txnId: number) {
  const loyalty = await getSetting('loyalty', c);
  if (!loyalty.enabled || loyalty.points_per_dollar <= 0 || spentCents <= 0) return;
  const row = await one<{ customer_id: number | null }>('SELECT customer_id FROM gift_cards WHERE id = $1', [cardId], c);
  if (!row?.customer_id) return;
  // Idempotent per txn: only award once.
  const already = await one(`SELECT 1 FROM audit_log WHERE action = 'loyalty.points_earned' AND payload->>'txn_id' = $1`, [String(txnId)], c);
  if (already) return;
  const points = Math.floor(spentCents / 100) * loyalty.points_per_dollar;
  if (points <= 0) return;
  await query('UPDATE customers SET loyalty_points = loyalty_points + $2 WHERE id = $1 AND erased_at IS NULL', [row.customer_id, points], c);
  await audit(actor, 'loyalty.points_earned', { entityType: 'customer', entityId: row.customer_id, cardId, payload: { txn_id: txnId, points } }, c);
}

export interface IssueInput {
  card_number?: string | null;
  face_value_cents: number;
  initial_balance_cents?: number | null;
  activate?: boolean;
  customer_id?: number | null;
  label?: string | null;
  color_tag?: string | null;
  expires_at?: string | null;
  pin_hash?: string | null;
  channel?: 'POS' | 'KIOSK' | 'ONLINE' | 'IMPORT';
  external_ref?: string | null;
  tag_ids?: number[];
}

export async function issueCard(actor: Actor, input: IssueInput, idempotencyKey?: string | null, db?: pg.PoolClient): Promise<MutationResult> {
  const run = async (c: pg.PoolClient) => {
    const row = await one<{ id: number }>(
      `SELECT (fn_issue_card($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9, $10::channel, $11::actor_type, $12, $13, $14::inet, $15, $16, $17)).id AS id`,
      [input.card_number ?? null, input.face_value_cents, input.activate ?? true, input.initial_balance_cents ?? null, input.customer_id ?? null,
        input.label ?? null, input.color_tag ?? null, input.expires_at ?? null, input.pin_hash ?? null, input.channel ?? 'POS',
        actor.actorType, actor.actorId, actor.terminalId, actor.ip, actor.ua, idempotencyKey ?? null, input.external_ref ?? null],
      c,
    );
    if (input.tag_ids?.length) {
      await query('INSERT INTO gift_card_tags (card_id, tag_id) SELECT $1, unnest($2::bigint[]) ON CONFLICT DO NOTHING', [row!.id, input.tag_ids], c);
    }
    const txn = await one<{ id: number }>(`SELECT id FROM gift_card_transactions WHERE card_id = $1 AND txn_type = 'ISSUE'`, [row!.id], c);
    return result(c, row!.id, txn?.id);
  };
  const res = db ? await run(db) : await withTx(run);
  if (res.transaction) notifyAfterTxn(res.card, res.transaction).catch(() => {});
  return res;
}

export async function setFrozen(actor: Actor, cardId: number, frozen: boolean, reason: string | null) {
  return withTx(async (c) => {
    await query(`SELECT fn_set_frozen($1, $2, $3, $4::actor_type, $5, $6, $7::inet, $8)`, [cardId, frozen, reason, actor.actorType, actor.actorId, actor.terminalId, actor.ip, actor.ua], c);
    return result(c, cardId);
  });
}

export async function transfer(actor: Actor, fromId: number, toId: number, amountCents: number, memo: string | null, key: string | null) {
  try {
    return await withTx(async (c) => {
      const r = await one<{ out_txn_id: number; in_txn_id: number }>(
        `SELECT * FROM fn_transfer($1, $2, $3, $4, $5, $6, $7::inet, $8, $9, $10::actor_type)`,
        [fromId, toId, amountCents, actor.actorId, memo, actor.terminalId, actor.ip, actor.ua, key, actor.actorType],
        c,
      );
      return { from: await result(c, fromId, r!.out_txn_id), to: await result(c, toId, r!.in_txn_id) };
    });
  } catch (err) {
    await alertOnFailure(err, actor, fromId, { txn_type: 'TRANSFER_OUT', amount_cents: amountCents });
    throw err;
  }
}

export async function merge(actor: Actor, fromId: number, toId: number, key: string | null) {
  return withTx(async (c) => {
    const r = await one<{ out_txn_id: number; in_txn_id: number }>(
      `SELECT * FROM fn_merge($1, $2, $3, $4, $5::inet, $6, $7, $8::actor_type)`,
      [fromId, toId, actor.actorId, actor.terminalId, actor.ip, actor.ua, key, actor.actorType],
      c,
    );
    return { from: await result(c, fromId, r!.out_txn_id), to: await result(c, toId, r!.in_txn_id) };
  });
}

export async function split(actor: Actor, fromId: number, amountCents: number, newNumber: string | null, key: string | null) {
  return withTx(async (c) => {
    const r = await one<{ id: number }>(`SELECT (fn_split($1, $2, $3, $4, $5, $6::inet, $7, $8)).id AS id`, [fromId, amountCents, newNumber, actor.actorId, actor.terminalId, actor.ip, actor.ua, key], c);
    return { from: await result(c, fromId), to: await result(c, r!.id) };
  });
}

export async function replaceLost(actor: Actor, oldId: number, newNumber: string | null, reason: string | null, key: string | null) {
  return withTx(async (c) => {
    const r = await one<{ id: number }>(`SELECT (fn_replace_lost_card($1, $2, $3, $4, $5::inet, $6, $7, $8)).id AS id`, [oldId, newNumber, actor.actorId, actor.terminalId, actor.ip, actor.ua, key, reason ?? 'Reported lost'], c);
    return { old: await result(c, oldId), new: await result(c, r!.id) };
  });
}

export async function reverseTxn(actor: Actor, txnId: number, reason: string | null, key: string | null, approvedBy: number | null) {
  return withTx(async (c) => {
    const t = await one<{ id: number; card_id: number }>(
      `SELECT (r).id, (r).card_id FROM (SELECT fn_reverse_txn($1, $2, $3, $4, $5::inet, $6, $7, $8) AS r) s`,
      [txnId, reason, actor.actorId, actor.terminalId, actor.ip, actor.ua, key, approvedBy],
      c,
    );
    return result(c, t!.card_id, t!.id);
  });
}

// ---------------------------------------------------------------- archive (Clear Zero-Balance)
export async function archiveZero(actor: Actor, dryRun: boolean) {
  return withTx(async (c) => {
    const { rows } = await query<{ card_id: number; card_number: string; status: string; face_value: string }>(
      `SELECT card_id, card_number, status::text, face_value FROM fn_archive_zero_balance($1, $2, $3, $4::inet)`,
      [dryRun, actor.actorId, actor.terminalId, actor.ip],
      c,
    );
    const faceCents = rows.reduce((s, r) => s + toCentsStr(r.face_value), 0);
    return {
      dry_run: dryRun,
      count: rows.length,
      face_value_total_cents: faceCents,
      card_ids: rows.map((r) => r.card_id),
      cards: rows.map((r) => ({ id: r.card_id, card_number: r.card_number, status: r.status, face_value_cents: toCentsStr(r.face_value) })),
      undo_until: dryRun ? null : new Date(Date.now() + 30 * 86400_000).toISOString(),
    };
  });
}

function toCentsStr(v: string) {
  const [d, f = ''] = v.split('.');
  return Number.parseInt(d, 10) * 100 + Number.parseInt(f.padEnd(2, '0').slice(0, 2), 10);
}

export async function restoreArchived(actor: Actor, ids: number[]) {
  const r = await one<{ n: number }>('SELECT fn_restore_archived($1::bigint[], $2, $3) AS n', [ids, actor.actorId, actor.terminalId]);
  return { restored: r?.n ?? 0 };
}

// ---------------------------------------------------------------- edits
export interface CardPatch {
  label?: string | null;
  color_tag?: string | null;
  expires_at?: string | null;
  customer_id?: number | null;
  pin_hash?: string | null;
}

export async function updateCard(actor: Actor, id: number, patch: CardPatch) {
  return withTx(async (c) => {
    const before = await getCard(id, c);
    const sets: string[] = [];
    const params: unknown[] = [id];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      params.push(v);
      sets.push(`${k} = $${params.length}${k === 'expires_at' ? '::timestamptz' : ''}`);
    }
    if (patch.expires_at && new Date(patch.expires_at).getTime() <= Date.now()) {
      throw new ApiError(400, 'VALIDATION', 'Expiry must be in the future', 'expires_at');
    }
    if (['VOIDED', 'EXPIRED', 'LOST_REPLACED'].includes(before.status) && patch.expires_at !== undefined) {
      throw new ApiError(409, 'STATE_CONFLICT', `Cannot change expiry of a ${before.status} card`);
    }
    // A new/cleared PIN also lifts any kiosk lockout from wrong guesses.
    if (patch.pin_hash !== undefined) sets.push('kiosk_failed_attempts = 0', 'kiosk_locked_until = NULL');
    if (sets.length) await query(`UPDATE gift_cards SET ${sets.join(', ')} WHERE id = $1`, params, c);
    const changed = Object.fromEntries(
      Object.entries(patch)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, k === 'pin_hash' ? (v ? 'set' : 'cleared') : v]),
    );
    await audit(actor, 'card.updated', { cardId: id, payload: { changed, before: { label: before.label, expires_at: before.expires_at, customer_id: before.customer?.id ?? null } } }, c);
    return result(c, id);
  });
}

export async function addNote(actor: Actor, id: number, note: string, userName: string) {
  return withTx(async (c) => {
    await getCard(id, c);
    const line = `[${new Date().toISOString().slice(0, 16).replace('T', ' ')} ${userName}] ${note}`;
    await query(`UPDATE gift_cards SET notes = CASE WHEN notes IS NULL OR notes = '' THEN $2 ELSE notes || E'\\n' || $2 END WHERE id = $1`, [id, line], c);
    await audit(actor, 'card.note_added', { cardId: id, payload: { note } }, c);
    return result(c, id);
  });
}

export async function setTags(actor: Actor, id: number, tagIds: number[]) {
  return withTx(async (c) => {
    await getCard(id, c);
    await query('DELETE FROM gift_card_tags WHERE card_id = $1', [id], c);
    if (tagIds.length) await query('INSERT INTO gift_card_tags (card_id, tag_id) SELECT $1, unnest($2::bigint[]) ON CONFLICT DO NOTHING', [id, tagIds], c);
    await audit(actor, 'card.tags_set', { cardId: id, payload: { tag_ids: tagIds } }, c);
    return result(c, id);
  });
}

export async function softDelete(actor: Actor, id: number, reason: string) {
  return withTx(async (c) => {
    const card = await getCard(id, c);
    if (card.balance_cents !== 0) {
      throw new ApiError(409, 'STATE_CONFLICT', `Card still holds ${formatCents(card.balance_cents, card.currency)} — void it first so the liability is recorded`);
    }
    await query('UPDATE gift_cards SET deleted_at = now() WHERE id = $1', [id], c);
    await audit(actor, 'card.deleted', { cardId: id, payload: { reason } }, c);
    return { deleted: true, id };
  });
}
