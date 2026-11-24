import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import {
  actorOf, authenticate, clientIp, issueApprovalToken, issueSession, revokeToken, verifyPassword, verifyPin, can,
  type ApprovalAction,
} from '../auth.js';
import { audit } from '../audit.js';
import { query } from '../db.js';
import { ApiError } from '../errors.js';
import { getAllSettings } from '../settings.js';
import type { Actor } from '../types.js';

export const router = Router();

const loginLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => clientIp(req) ?? 'unknown',
  handler: (_req, res) => res.status(429).type('application/problem+json').json({ status: 429, code: 'RATE_LIMITED', message: 'Too many login attempts — wait a minute' }),
});

async function sessionPayload(user: { id: number; name: string; username: string; role: string }, terminalId: number | null) {
  const session = await issueSession(user, terminalId);
  await query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
  return { ...session, user: { id: user.id, name: user.name, username: user.username, role: user.role } };
}

const userActor = (base: Actor, userId: number): Actor => ({ ...base, actorType: 'USER', actorId: userId });

/** PIN tiles for the shared-terminal login screen. */
router.get('/auth/users', async (_req, res) => {
  const { rows } = await query(`SELECT id, name, role::text FROM users WHERE active AND pin_hash IS NOT NULL ORDER BY role, name`);
  res.json({ data: rows });
});

router.post('/auth/login', loginLimiter, async (req, res) => {
  const b = z.object({ username: z.string().min(1).max(40), password: z.string().min(1).max(200) }).parse(req.body);
  const u = await verifyPassword(b.username, b.password);
  await audit(userActor(actorOf(req), u.id), 'auth.login', { entityType: 'user', entityId: u.id, payload: { method: 'password' } });
  res.json(await sessionPayload(u, req.terminal?.id ?? null));
});

router.post('/auth/pin-login', loginLimiter, async (req, res) => {
  const b = z.object({ pin: z.string().regex(/^\d{4,8}$/, 'PIN must be 4–8 digits'), user_id: z.number().int().positive().optional() }).parse(req.body);
  const u = await verifyPin(b.pin, { userId: b.user_id });
  await audit(userActor(actorOf(req), u.id), 'auth.login', { entityType: 'user', entityId: u.id, payload: { method: 'pin' } });
  res.json(await sessionPayload(u, req.terminal?.id ?? null));
});

router.post('/auth/logout', authenticate, async (req, res) => {
  const token = req.get('authorization')?.slice(7);
  if (token) revokeToken(token);
  await audit(actorOf(req), 'auth.logout', { entityType: 'user', entityId: req.user!.id });
  res.json({ ok: true });
});

router.get('/auth/me', authenticate, async (req, res) => {
  const s = await getAllSettings();
  res.json({
    user: { id: req.user!.id, name: req.user!.name, username: req.user!.username, role: req.user!.role, permissions: [...req.user!.perms] },
    terminal: req.terminal ?? null,
    business: { slug: req.business!.slug, name: req.business!.name },
    settings: { general: s.general, security: s.security, printer: s.printer, receipt: s.receipt, loyalty: s.loyalty },
  });
});

/**
 * Manager step-up. The approver enters their PIN on the same screen; the
 * returned short-lived token (120 s) is sent as X-Approval-Token on retry.
 */
router.post('/auth/approve', authenticate, loginLimiter, async (req, res) => {
  const b = z
    .object({
      pin: z.string().regex(/^\d{4,8}$/),
      action: z.enum(['void', 'adjust', 'archive', 'refund', 'large_amount', 'reverse', 'restore', 'erase', 'delete', 'bulk_void']),
      approver_id: z.number().int().positive().optional(),
    })
    .parse(req.body);
  const approverRoles = (await query<{ role: string }>(`SELECT DISTINCT role::text FROM role_permissions WHERE permission IN ('approve', '*')`)).rows.map((r) => r.role);
  const approver = await verifyPin(b.pin, { userId: b.approver_id, roles: approverRoles });
  const token = issueApprovalToken(approver.id, b.action as ApprovalAction, req.user!.id);
  await audit(actorOf(req), 'approval.granted', { entityType: 'user', entityId: approver.id, payload: { action: b.action, approver: approver.name, requester: req.user!.name } });
  res.json({ approval_token: token, approver: { id: approver.id, name: approver.name }, expires_in: 120 });
});

/** Activity-lock unlock: re-verify the current user's PIN without a new session. */
router.post('/auth/unlock', authenticate, loginLimiter, async (req, res) => {
  const b = z.object({ pin: z.string().regex(/^\d{4,8}$/) }).parse(req.body);
  try {
    await verifyPin(b.pin, { userId: req.user!.id });
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(401, 'PIN_INVALID', 'Incorrect PIN');
  }
  res.json({ ok: true, can_approve: can(req.user, 'approve') });
});
