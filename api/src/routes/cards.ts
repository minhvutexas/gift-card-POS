import { Router, type Request } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { actorOf, can, requireApproval, requirePerm } from '../auth.js';
import { audit, auditQuiet } from '../audit.js';
import { one, query } from '../db.js';
import { ApiError, forbidden, toApiError } from '../errors.js';
import { getAllSettings } from '../settings.js';
import * as cards from '../services/cards.js';
import { printReceipt, buildReceipt } from '../services/printing.js';
import { sendTemplate, TEMPLATE_KEYS } from '../services/messaging.js';
import { cardStatementPdf } from '../services/pdf.js';
import { verifyQrToken } from '../services/qr.js';
import { toCsv, centsToDecimal } from '../util/csv.js';
import { findOrCreateCustomer, customerInput } from './customers.js';

export const router = Router();

const cents = z.number({ invalid_type_error: 'Amount must be a number of cents' }).int('Amount must be whole cents').positive('Amount must be greater than $0.00').max(100_000_000, 'Amount is too large');
const id = z.coerce.number().int().positive();
const reason = z.string().trim().min(3, 'Please give a reason (3+ characters)').max(500);
const cardNumber = z.string().trim().toUpperCase().regex(/^[0-9A-Z-]{4,20}$/, 'Card number must be 4–20 letters/digits');
const ref = z.string().trim().max(80).optional().nullable();
const memo = z.string().trim().max(500).optional().nullable();
const pin = z.string().regex(/^\d{4,8}$/, 'PIN must be 4–8 digits');

const cardId = (req: Request) => id.parse(req.params.id);

async function approvalForAmount(req: Request, amountCents: number) {
  const { approval_threshold_cents } = (await getAllSettings()).security;
  if (approval_threshold_cents > 0 && amountCents > approval_threshold_cents) return requireApproval(req, 'large_amount');
  return null;
}

// ------------------------------------------------------------------ reads
const listQuery = z.object({
  status: z.enum(['all', 'active', 'partial', 'zero', 'frozen', 'voided', 'pending', 'expired', 'closed', 'live']).default('all'),
  q: z.string().max(100).optional(),
  sort: z.enum(['balance_desc', 'balance_asc', 'created_desc', 'created_asc', 'last_used_desc', 'status', 'label', 'number']).default('balance_desc'),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(500).default(50),
  archived: z.enum(['exclude', 'include', 'only']).default('exclude'),
  customer_id: z.coerce.number().int().positive().optional(),
  tag_id: z.coerce.number().int().positive().optional(),
});

router.get('/cards', requirePerm('cards.read'), async (req, res) => {
  res.json(await cards.listCards(listQuery.parse(req.query)));
});

router.get('/cards/export.csv', requirePerm('cards.export'), async (req, res) => {
  const p = listQuery.extend({ ids: z.string().optional() }).parse(req.query);
  const ids = p.ids ? p.ids.split(',').map((s) => id.parse(s)) : undefined;
  const { data } = await cards.listCards({ ...p, ids, page: 1, per_page: 500 });
  // listCards caps at 500/page — page through for full exports
  let all = data;
  for (let page = 2; all.length === (page - 1) * 500; page++) all = all.concat((await cards.listCards({ ...p, ids, page, per_page: 500 })).data);
  await audit(actorOf(req), 'cards.exported', { payload: { count: all.length, filter: p.status, q: p.q ?? null } });
  res
    .type('text/csv')
    .attachment(`gift-cards-${new Date().toISOString().slice(0, 10)}.csv`)
    .send(
      toCsv(
        ['card_number', 'status', 'balance', 'face_value', 'currency', 'label', 'tags', 'holder', 'phone', 'email', 'expires_at', 'last_used_at', 'created_at'],
        all.map((c) => [
          c.card_number, c.status, centsToDecimal(c.balance_cents), centsToDecimal(c.face_value_cents), c.currency, c.label,
          c.tags.map((t) => t.name).join('|'), [c.customer?.first_name, c.customer?.last_name].filter(Boolean).join(' '),
          c.customer?.phone, c.customer?.email, c.expires_at, c.last_used_at, c.created_at,
        ]),
      ),
    );
});

router.get('/cards/lookup/:number', requirePerm('cards.read'), async (req, res) => {
  const card = await cards.getCardByNumber(cardNumber.parse(req.params.number));
  res.json({ card, transactions: await cards.cardTxns(card.id, 5) });
});

// Staff scanning a customer's receipt QR (kiosk link) resolves to the card.
router.get('/cards/lookup-qr/:token', requirePerm('cards.read'), async (req, res) => {
  const cid = verifyQrToken(String(req.params.token));
  if (!cid) throw new ApiError(404, 'CARD_NOT_FOUND', 'QR code not recognised');
  const card = await cards.getCard(cid);
  res.json({ card, transactions: await cards.cardTxns(card.id, 5) });
});

router.get('/cards/statement/:file', requirePerm('cards.read'), async (req, res) => {
  const m = /^(\d+)(\.pdf)?$/.exec(String(req.params.file));
  if (!m) throw new ApiError(400, 'VALIDATION', 'Use /cards/statement/{id}.pdf');
  const card = await cards.getCard(Number(m[1]));
  const pdf = await cardStatementPdf(card, await cards.cardTxns(card.id, 5000));
  await audit(actorOf(req), 'card.statement_exported', { cardId: card.id });
  res.type('application/pdf').setHeader('Content-Disposition', `inline; filename="statement-${card.card_number}.pdf"`);
  res.send(pdf);
});

router.get('/cards/:id', requirePerm('cards.read'), async (req, res) => {
  const card = await cards.getCard(cardId(req));
  const [transactions, events, messages] = await Promise.all([
    cards.cardTxns(card.id, 200),
    query(`SELECT a.id, a.action, a.payload, a.created_at, u.name AS actor_name, a.actor_type::text FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
           WHERE a.card_id = $1 AND a.action NOT LIKE 'txn.%' ORDER BY a.id DESC LIMIT 100`, [card.id]),
    query(`SELECT id, template_key, channel::text, recipient, status, error, sent_at FROM message_log WHERE card_id = $1 ORDER BY id DESC LIMIT 50`, [card.id]),
  ]);
  const replaced_from = await one(`SELECT id, card_number FROM gift_cards WHERE replaced_by_card_id = $1`, [card.id]);
  res.json({ card, transactions, events: events.rows, messages: messages.rows, replaced_from: replaced_from ?? null });
});

router.get('/cards/:id/transactions', requirePerm('cards.read'), async (req, res) => {
  res.json({ data: await cards.cardTxns(cardId(req), 1000) });
});

router.get('/cards/:id/receipt', requirePerm('cards.read'), async (req, res) => {
  const card = await cards.getCard(cardId(req));
  const txnId = req.query.txn_id ? id.parse(req.query.txn_id) : null;
  const txn = txnId ? await cards.getTxn(txnId) : null;
  if (txn && txn.card_id !== card.id) throw new ApiError(400, 'VALIDATION', 'Transaction belongs to a different card', 'txn_id');
  res.json(await buildReceipt(card, txn));
});

// ------------------------------------------------------------------ issue
const issueBody = z.object({
  card_number: cardNumber.optional().nullable(),
  face_value_cents: cents,
  activate: z.boolean().default(true),
  customer_id: z.number().int().positive().optional().nullable(),
  customer: customerInput.optional().nullable(),
  label: z.string().trim().max(60).optional().nullable(),
  color_tag: z.string().trim().max(20).optional().nullable(),
  expires_at: z.string().datetime({ offset: true }).optional().nullable(),
  pin: pin.optional().nullable(),
  tag_ids: z.array(z.number().int().positive()).max(20).optional(),
  external_ref: ref,
});

router.post('/cards', requirePerm('cards.issue'), async (req, res) => {
  const b = issueBody.parse(req.body);
  const approvedBy = await approvalForAmount(req, b.face_value_cents);
  const actor = actorOf(req);
  let customerId = b.customer_id ?? null;
  if (!customerId && b.customer) customerId = await findOrCreateCustomer(actor, b.customer);
  const result = await cards.issueCard(
    actor,
    {
      card_number: b.card_number ?? null,
      face_value_cents: b.face_value_cents,
      activate: b.activate,
      customer_id: customerId,
      label: b.label,
      color_tag: b.color_tag,
      expires_at: b.expires_at,
      pin_hash: b.pin ? await bcrypt.hash(b.pin, 10) : null,
      tag_ids: b.tag_ids,
      external_ref: b.external_ref,
    },
    req.idempotencyKey,
  );
  if (approvedBy && approvedBy !== req.user!.id) await audit(actor, 'approval.used', { cardId: result.card.id, payload: { action: 'issue', approved_by: approvedBy } });
  res.status(201).json(result);
});

// ------------------------------------------------------------------ edits
router.patch('/cards/:id', requirePerm('cards.edit'), async (req, res) => {
  const b = z
    .object({
      label: z.string().trim().max(60).nullable().optional(),
      color_tag: z.string().trim().max(20).nullable().optional(),
      expires_at: z.string().datetime({ offset: true }).nullable().optional(),
      customer_id: z.number().int().positive().nullable().optional(),
      pin: pin.nullable().optional(),
    })
    .strict()
    .parse(req.body);
  const { pin: newPin, ...rest } = b;
  const patch: cards.CardPatch = { ...rest };
  if (newPin !== undefined) patch.pin_hash = newPin === null ? null : await bcrypt.hash(newPin, 10);
  res.json(await cards.updateCard(actorOf(req), cardId(req), patch));
});

router.post('/cards/:id/notes', requirePerm('cards.edit'), async (req, res) => {
  const { note } = z.object({ note: z.string().trim().min(1).max(1000) }).parse(req.body);
  res.json(await cards.addNote(actorOf(req), cardId(req), note, req.user!.name));
});

router.put('/cards/:id/tags', requirePerm('cards.edit'), async (req, res) => {
  const { tag_ids } = z.object({ tag_ids: z.array(z.number().int().positive()).max(20) }).parse(req.body);
  res.json(await cards.setTags(actorOf(req), cardId(req), tag_ids));
});

router.put('/cards/:id/freeze', requirePerm('cards.freeze'), async (req, res) => {
  const b = z.object({ reason: reason }).parse(req.body);
  res.json(await cards.setFrozen(actorOf(req), cardId(req), true, b.reason));
});

router.put('/cards/:id/unfreeze', requirePerm('cards.freeze'), async (req, res) => {
  const b = z.object({ reason: z.string().trim().max(500).optional() }).parse(req.body ?? {});
  res.json(await cards.setFrozen(actorOf(req), cardId(req), false, b.reason ?? null));
});

// ------------------------------------------------------------------ money
router.post('/cards/:id/activate', requirePerm('cards.issue'), async (req, res) => {
  const b = z.object({ amount_cents: cents.optional(), external_ref: ref }).parse(req.body ?? {});
  const card = await cards.getCard(cardId(req));
  const amount = b.amount_cents ?? card.face_value_cents;
  const approvedBy = await approvalForAmount(req, amount);
  res.json(await cards.applyTxn(actorOf(req), card.id, 'ACTIVATE', amount, { externalRef: b.external_ref, idempotencyKey: req.idempotencyKey, approvedBy, memo: 'Card activated' }));
});

router.post('/cards/:id/reload', requirePerm('cards.reload'), async (req, res) => {
  const b = z.object({ amount_cents: cents, external_ref: ref, memo }).parse(req.body);
  const approvedBy = await approvalForAmount(req, b.amount_cents);
  res.json(await cards.applyTxn(actorOf(req), cardId(req), 'RELOAD', b.amount_cents, { memo: b.memo ?? 'Reload', externalRef: b.external_ref, idempotencyKey: req.idempotencyKey, approvedBy }));
});

router.post('/cards/:id/redeem', requirePerm('cards.redeem'), async (req, res) => {
  const b = z
    .object({
      amount_cents: cents,
      tip_cents: z.number().int().min(0).max(100_000_000).default(0),
      external_ref: ref,
      ref: ref, // alias from the spec: {amount, ref, idempotency_key}
      memo,
      idempotency_key: z.string().optional(), // accepted in body for legacy clients; header wins
    })
    .parse(req.body);
  const approvedBy = await approvalForAmount(req, b.amount_cents + b.tip_cents);
  res.json(
    await cards.redeem(actorOf(req), cardId(req), b.amount_cents, b.tip_cents, {
      memo: b.memo,
      externalRef: b.external_ref ?? b.ref,
      idempotencyKey: req.idempotencyKey,
      approvedBy,
    }),
  );
});

router.post('/cards/:id/refund', requirePerm('cards.refund'), async (req, res) => {
  const b = z.object({ amount_cents: cents, reason, external_ref: ref }).parse(req.body);
  const sec = (await getAllSettings()).security;
  const approvedBy = await requireApproval(req, 'refund', { dualControl: sec.dual_control_refunds });
  res.json(await cards.applyTxn(actorOf(req), cardId(req), 'REFUND_TO_CARD', b.amount_cents, { memo: b.reason, externalRef: b.external_ref, idempotencyKey: req.idempotencyKey, approvedBy }));
});

router.post('/cards/:id/adjust', requirePerm('cards.adjust'), async (req, res) => {
  const b = z
    .object({ delta_cents: z.number().int().refine((v) => v !== 0, 'Adjustment cannot be $0.00').refine((v) => Math.abs(v) <= 100_000_000, 'Too large'), reason })
    .parse(req.body);
  const approvedBy = await requireApproval(req, 'adjust');
  res.json(await cards.applyTxn(actorOf(req), cardId(req), 'ADJUSTMENT', b.delta_cents, { memo: b.reason, idempotencyKey: req.idempotencyKey, approvedBy }));
});

router.post('/cards/:id/void', requirePerm('cards.void'), async (req, res) => {
  const b = z.object({ reason }).parse(req.body);
  const sec = (await getAllSettings()).security;
  const approvedBy = await requireApproval(req, 'void', { dualControl: sec.dual_control_voids });
  res.json(await cards.applyTxn(actorOf(req), cardId(req), 'VOID', null, { memo: b.reason, idempotencyKey: req.idempotencyKey, approvedBy }));
});

router.post('/cards/:id/replace', requirePerm('cards.replace'), async (req, res) => {
  const b = z.object({ new_number: cardNumber.optional().nullable(), reason: z.string().trim().max(500).optional() }).parse(req.body ?? {});
  res.json(await cards.replaceLost(actorOf(req), cardId(req), b.new_number ?? null, b.reason ?? null, req.idempotencyKey ?? null));
});

router.post('/cards/:id/split', requirePerm('cards.transfer'), async (req, res) => {
  const b = z.object({ amount_cents: cents, new_number: cardNumber.optional().nullable() }).parse(req.body);
  res.status(201).json(await cards.split(actorOf(req), cardId(req), b.amount_cents, b.new_number ?? null, req.idempotencyKey ?? null));
});

router.post('/cards/transfer', requirePerm('cards.transfer'), async (req, res) => {
  const b = z.object({ from_id: z.number().int().positive(), to_id: z.number().int().positive(), amount_cents: cents, memo }).parse(req.body);
  await approvalForAmount(req, b.amount_cents);
  res.json(await cards.transfer(actorOf(req), b.from_id, b.to_id, b.amount_cents, b.memo ?? null, req.idempotencyKey ?? null));
});

router.post('/cards/merge', requirePerm('cards.merge'), async (req, res) => {
  const b = z.object({ from_id: z.number().int().positive(), to_id: z.number().int().positive() }).parse(req.body);
  res.json(await cards.merge(actorOf(req), b.from_id, b.to_id, req.idempotencyKey ?? null));
});

router.post('/transactions/:id/reverse', requirePerm('cards.reverse'), async (req, res) => {
  const txnId = id.parse(req.params.id);
  const b = z.object({ reason: z.string().trim().max(500).optional() }).parse(req.body ?? {});
  const txn = await cards.getTxn(txnId);
  const sec = (await getAllSettings()).security;
  // Self-service undo: the same user, within the undo window (+30s grace for slow networks).
  const ageSec = (Date.now() - new Date(txn.created_at).getTime()) / 1000;
  const selfUndo = txn.actor_id === req.user!.id && ageSec <= sec.undo_window_sec + 30 && ['REDEEM', 'TIP_FROM_CARD', 'RELOAD'].includes(txn.txn_type);
  const approvedBy = selfUndo ? null : await requireApproval(req, 'reverse');
  res.json(await cards.reverseTxn(actorOf(req), txnId, b.reason ?? (selfUndo ? 'Undo' : null), req.idempotencyKey ?? null, approvedBy));
});

// ------------------------------------------------------------------ print / deliver
router.post('/cards/:id/print', requirePerm('cards.print'), async (req, res) => {
  const b = z.object({ txn_id: z.number().int().positive().optional() }).parse(req.body ?? {});
  const card = await cards.getCard(cardId(req));
  const txn = b.txn_id ? await cards.getTxn(b.txn_id) : null;
  const actor = actorOf(req);
  try {
    const out = await printReceipt(card, txn);
    await audit(actor, 'card.printed', { cardId: card.id, payload: { mode: out.mode, txn_id: b.txn_id ?? null } });
    res.json(out);
  } catch (e: any) {
    auditQuiet(actor, 'alert.print_failed', { cardId: card.id, payload: { message: e.message } });
    throw new ApiError(502, 'PRINT_FAILED', e.message);
  }
});

router.post('/cards/:id/print-failed', requirePerm('cards.print'), async (req, res) => {
  // Browser-mode printing reports failures back so the dashboard can alert.
  const b = z.object({ message: z.string().max(300) }).parse(req.body);
  await audit(actorOf(req), 'alert.print_failed', { cardId: cardId(req), payload: { message: b.message } });
  res.json({ ok: true });
});

router.post('/cards/:id/send', requirePerm('cards.send'), async (req, res) => {
  const b = z.object({ channel: z.enum(['EMAIL', 'SMS']), template_key: z.enum(TEMPLATE_KEYS).default('card_delivered'), to: z.string().trim().max(120).optional() }).parse(req.body);
  if (b.to && b.channel === 'EMAIL' && !z.string().email().safeParse(b.to).success) throw new ApiError(400, 'VALIDATION', 'Enter a valid email', 'to');
  if (b.to && b.channel === 'SMS' && !/^\+?[\d\s().-]{7,20}$/.test(b.to)) throw new ApiError(400, 'VALIDATION', 'Enter a valid phone number', 'to');
  const card = await cards.getCard(cardId(req));
  const out = await sendTemplate(card, b.template_key, b.channel, { to: b.to });
  await audit(actorOf(req), b.channel === 'EMAIL' ? 'card.emailed' : 'card.sms_sent', { cardId: card.id, payload: { template: b.template_key, status: out.status } });
  if (out.status === 'FAILED') throw new ApiError(502, 'DELIVERY_FAILED', out.error ?? 'Delivery failed');
  res.json(out);
});

// ------------------------------------------------------------------ delete / archive / bulk
router.delete('/cards/:id', requirePerm('cards.delete'), async (req, res) => {
  const b = z.object({ reason }).parse(req.body ?? {});
  await requireApproval(req, 'delete');
  res.json(await cards.softDelete(actorOf(req), cardId(req), b.reason));
});

router.post('/cards/archive-zero', requirePerm('cards.archive'), async (req, res) => {
  const b = z.object({ dry_run: z.boolean().default(true) }).parse(req.body ?? {});
  if (!b.dry_run) await requireApproval(req, 'archive');
  res.json(await cards.archiveZero(actorOf(req), b.dry_run));
});

router.post('/cards/archive-restore', requirePerm('cards.archive'), async (req, res) => {
  const b = z.object({ card_ids: z.array(z.number().int().positive()).min(1).max(10000) }).parse(req.body);
  res.json(await cards.restoreArchived(actorOf(req), b.card_ids));
});

router.post('/cards/bulk', requirePerm('cards.read'), async (req, res) => {
  const b = z
    .object({ action: z.enum(['freeze', 'unfreeze', 'void']), ids: z.array(z.number().int().positive()).min(1).max(500), reason: z.string().trim().max(500).optional() })
    .parse(req.body);
  const perm = b.action === 'void' ? 'cards.void' : 'cards.freeze';
  if (!can(req.user, perm)) throw forbidden(`Your role cannot ${b.action} cards`);
  if ((b.action === 'void' || b.action === 'freeze') && (!b.reason || b.reason.length < 3)) throw new ApiError(400, 'VALIDATION', 'Please give a reason', 'reason');
  let approvedBy: number | null = null;
  if (b.action === 'void') {
    const sec = (await getAllSettings()).security;
    approvedBy = await requireApproval(req, 'bulk_void', { dualControl: sec.dual_control_voids });
  }
  const actor = actorOf(req);
  const results: { id: number; ok: boolean; status?: string; balance_cents?: number; error?: string; code?: string }[] = [];
  for (const cid of b.ids) {
    try {
      const r =
        b.action === 'void'
          ? await cards.applyTxn(actor, cid, 'VOID', null, { memo: b.reason, approvedBy, idempotencyKey: req.idempotencyKey ? `${req.idempotencyKey}:${cid}` : null })
          : await cards.setFrozen(actor, cid, b.action === 'freeze', b.reason ?? null);
      results.push({ id: cid, ok: true, status: r.status, balance_cents: r.balance_cents });
    } catch (e: any) {
      const err = toApiError(e);
      results.push({ id: cid, ok: false, error: err.message, code: err.code });
    }
  }
  const liab = await cards.outstanding();
  res.json({ action: b.action, ok: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results, outstanding_total_cents: liab.total_cents });
});
