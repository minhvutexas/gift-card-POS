import { Router, type Request } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { config } from '../config.js';
import { clientIp } from '../auth.js';
import { auditQuiet } from '../audit.js';
import { one, query } from '../db.js';
import { ApiError } from '../errors.js';
import type { Actor } from '../types.js';
import * as cards from '../services/cards.js';
import { maskNumber, verifyQrToken } from '../services/qr.js';

/**
 * Public customer self-service. Hardening against enumeration:
 *  - 5 req/min/IP rate limit (configurable) on every kiosk route
 *  - number + PIN *or* signed QR token required; one generic error for
 *    "no such card", "wrong PIN" and "no PIN set"
 *  - bcrypt compare always runs (dummy hash when card missing) → flat timing
 *  - per-card lockout after 5 bad PINs (15 min), stored in DB
 *  - response exposes masked number, balance, last 5 txns — no PII, no ids
 */
export const router = Router();

export const kioskLimiter = () =>
  rateLimit({
    windowMs: 60_000,
    limit: config.kioskRatePerMin,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: (req) => clientIp(req) ?? 'unknown',
    handler: (_req, res) =>
      res.status(429).type('application/problem+json').json({ status: 429, code: 'RATE_LIMITED', message: 'Too many attempts. Please wait a minute and try again.' }),
  });

const GENERIC = 'Card number or PIN is incorrect.';
const DUMMY_HASH = '$2a$10$CwTycUXWue0Thq9StjUM0uJ8.qdSBPPQNkuz.3ZNPcSjyU6qNkhd6';
const LOCK_AFTER = 5;
const LOCK_MIN = 15;

const kioskActor = (req: Request): Actor => ({
  actorType: 'KIOSK',
  actorId: null,
  terminalId: req.terminal?.id ?? null,
  ip: clientIp(req),
  ua: req.get('user-agent')?.slice(0, 300) ?? null,
});

const TYPE_LABEL: Record<string, string> = {
  ISSUE: 'Card purchased',
  ACTIVATE: 'Activated',
  RELOAD: 'Reload',
  REDEEM: 'Purchase',
  TIP_FROM_CARD: 'Tip',
  REFUND_TO_CARD: 'Refund',
  ADJUSTMENT: 'Adjustment',
  TRANSFER_IN: 'Transfer in',
  TRANSFER_OUT: 'Transfer out',
  MERGE_IN: 'Combined in',
  MERGE_OUT: 'Combined out',
  REPLACE_IN: 'Replacement',
  REPLACE_OUT: 'Replaced',
  VOID: 'Voided',
  EXPIRE: 'Expired',
  REVERSAL: 'Correction',
};

async function publicView(cardId: number) {
  const card = await cards.getCard(cardId);
  const txns = await cards.cardTxns(cardId, 5);
  return {
    card_masked: maskNumber(card.card_number),
    status: card.status,
    balance_cents: card.balance_cents,
    currency: card.currency,
    expires_at: card.expires_at,
    can_report_lost: ['ACTIVE', 'PARTIALUSED'].includes(card.status),
    transactions: txns.map((t) => ({ date: t.created_at, type: TYPE_LABEL[t.txn_type] ?? t.txn_type, amount_cents: t.amount_cents })),
  };
}

/** Resolves a card from number+PIN or QR token; throws the generic error otherwise. */
async function resolve(req: Request, input: { number?: string; pin?: string; token?: string }): Promise<number> {
  if (input.token) {
    const id = verifyQrToken(input.token);
    const ok = id ? await one('SELECT 1 FROM gift_cards WHERE id = $1 AND deleted_at IS NULL', [id]) : null;
    if (!id || !ok) throw new ApiError(401, 'KIOSK_LOOKUP_FAILED', 'This QR code is not valid. Please ask the front desk.');
    return id;
  }
  const number = (input.number ?? '').toUpperCase().replace(/[\s-]/g, '');
  const pin = input.pin ?? '';
  const card = /^[0-9A-Z]{4,20}$/.test(number)
    ? await one<{ id: number; pin_hash: string | null; kiosk_failed_attempts: number; kiosk_locked_until: Date | null }>(
        'SELECT id, pin_hash, kiosk_failed_attempts, kiosk_locked_until FROM gift_cards WHERE card_number = $1 AND deleted_at IS NULL',
        [number],
      )
    : undefined;
  const pinOk = await bcrypt.compare(pin, card?.pin_hash ?? DUMMY_HASH);
  const locked = !!card?.kiosk_locked_until && card.kiosk_locked_until.getTime() > Date.now();
  if (!card || !card.pin_hash || !/^\d{4,8}$/.test(pin) || !pinOk || locked) {
    if (card && card.pin_hash && !locked) {
      const n = card.kiosk_failed_attempts + 1;
      await query(
        `UPDATE gift_cards SET kiosk_failed_attempts = $2, kiosk_locked_until = CASE WHEN $3 THEN now() + make_interval(mins => ${LOCK_MIN}) ELSE kiosk_locked_until END WHERE id = $1`,
        [card.id, n >= LOCK_AFTER ? 0 : n, n >= LOCK_AFTER],
      );
      if (n >= LOCK_AFTER) auditQuiet(kioskActor(req), 'alert.kiosk_pin_lockout', { cardId: card.id, payload: { message: `Kiosk locked after ${LOCK_AFTER} wrong PINs` } });
    }
    throw new ApiError(401, 'KIOSK_LOOKUP_FAILED', GENERIC);
  }
  if (card.kiosk_failed_attempts) await query('UPDATE gift_cards SET kiosk_failed_attempts = 0 WHERE id = $1', [card.id]);
  return card.id;
}

const lookupBody = z.object({ number: z.string().max(30).optional(), pin: z.string().max(10).optional(), token: z.string().max(60).optional() });

// Spec form: GET /kiosk/cards/:number?pin=  (prefer POST /kiosk/lookup so the PIN stays out of URLs/logs)
router.get('/kiosk/cards/:number', async (req, res) => {
  const id = await resolve(req, { number: String(req.params.number), pin: typeof req.query.pin === 'string' ? req.query.pin : '' });
  res.json(await publicView(id));
});

router.post('/kiosk/lookup', async (req, res) => {
  const b = lookupBody.parse(req.body ?? {});
  res.json(await publicView(await resolve(req, b)));
});

router.get('/kiosk/qr/:token', async (req, res) => {
  res.json(await publicView(await resolve(req, { token: String(req.params.token) })));
});

router.post('/kiosk/report-lost', async (req, res) => {
  const b = lookupBody.parse(req.body ?? {});
  const id = await resolve(req, b);
  const card = await cards.getCard(id);
  if (['ACTIVE', 'PARTIALUSED'].includes(card.status)) {
    await cards.setFrozen(kioskActor(req), id, true, 'Reported lost by customer (kiosk)');
    auditQuiet(kioskActor(req), 'alert.card_reported_lost', { cardId: id, payload: { message: 'Customer reported card lost — card frozen' } });
  }
  res.json({ ok: true, message: 'Your card is frozen. Visit the front desk with ID to get a replacement with your balance.', ...(await publicView(id)) });
});

// No reload at the kiosk: money can only be added by staff at the front desk.
