import { Router, type NextFunction, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { config } from '../config.js';
import { clientIp, invalidateUser, sha256 } from '../auth.js';
import { one, query, runAsBusiness, runAsSystem } from '../db.js';
import { ApiError, unauthorized } from '../errors.js';
import { audit } from '../audit.js';
import { invalidateBusiness } from '../tenant.js';

/**
 * Platform admin (the person running the server, not a salon). One password
 * from PLATFORM_ADMIN_PASSWORD. Can list salons, suspend/reactivate them and
 * recover an owner who is locked out — never browse a salon's cards.
 * Mounted BEFORE tenant resolution; every DB step here is an explicit
 * system or single-salon step.
 */
export const router = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => clientIp(req) ?? 'unknown',
  handler: (_req, res) => res.status(429).type('application/problem+json').json({ status: 429, code: 'RATE_LIMITED', message: 'Too many attempts. Wait 15 minutes.' }),
});

const digest = (s: string) => createHash('sha256').update(s).digest();

function requirePlatform(req: Request, _res: Response, next: NextFunction) {
  if (!config.platformAdminPassword) return next(new ApiError(404, 'NOT_FOUND', 'Platform admin is not enabled on this server'));
  const h = req.get('authorization');
  const token = h?.startsWith('Bearer ') ? h.slice(7) : undefined;
  if (!token) return next(unauthorized());
  try {
    const c = jwt.verify(token, config.jwtSecret) as { typ?: string };
    if (c.typ !== 'platform') throw new Error('wrong token type');
  } catch {
    return next(unauthorized('Platform session expired — log in again', 'SESSION_INVALID'));
  }
  next();
}

router.post('/platform/login', loginLimiter, async (req, res) => {
  if (!config.platformAdminPassword) throw new ApiError(404, 'NOT_FOUND', 'Platform admin is not enabled on this server');
  const { password } = z.object({ password: z.string().min(1).max(200) }).parse(req.body);
  if (!timingSafeEqual(digest(password), digest(config.platformAdminPassword))) {
    throw new ApiError(401, 'LOGIN_INVALID', 'Wrong platform password');
  }
  const expires_in = 8 * 3600;
  const token = jwt.sign({ typ: 'platform' }, config.jwtSecret, { expiresIn: expires_in, jwtid: randomUUID(), subject: 'platform' });
  res.json({ token, expires_in });
});

router.use('/platform', requirePlatform);

router.get('/platform/businesses', async (_req, res) => {
  const { rows } = await runAsSystem(() =>
    query(`
      SELECT b.id, b.slug, b.name, b.status, b.owner_email, b.created_at,
             (SELECT count(*)::int FROM users u WHERE u.business_id = b.id AND u.active) AS users,
             (SELECT count(*)::int FROM gift_cards c WHERE c.business_id = b.id AND c.deleted_at IS NULL) AS cards,
             (SELECT COALESCE(sum(c.balance), 0)::numeric(14,2) FROM gift_cards c
               WHERE c.business_id = b.id AND c.status IN ('ACTIVE','PARTIALUSED') AND c.deleted_at IS NULL) AS outstanding,
             (SELECT max(t.created_at) FROM gift_card_transactions t WHERE t.business_id = b.id) AS last_activity_at
      FROM businesses b ORDER BY b.created_at DESC, b.id DESC`),
  );
  res.json({ data: rows });
});

const bizId = (req: Request) => z.coerce.number().int().positive().parse(req.params.id);

async function mustExist(id: number) {
  const b = await runAsSystem(() => one<{ id: number; slug: string; name: string; status: string }>('SELECT id, slug, name, status FROM businesses WHERE id = $1', [id]));
  if (!b) throw new ApiError(404, 'NOT_FOUND', 'Salon not found');
  return b;
}

const platformActor = (req: Request) => ({ actorType: 'SYSTEM' as const, actorId: null, terminalId: null, ip: clientIp(req), ua: req.get('user-agent')?.slice(0, 300) ?? null });

router.post('/platform/businesses/:id/status', async (req, res) => {
  const id = bizId(req);
  const { status } = z.object({ status: z.enum(['ACTIVE', 'SUSPENDED']) }).parse(req.body);
  await mustExist(id);
  const b = await runAsSystem(() => one('UPDATE businesses SET status = $2 WHERE id = $1 RETURNING id, slug, name, status', [id, status]));
  invalidateBusiness();
  await runAsBusiness(id, () => audit(platformActor(req), status === 'SUSPENDED' ? 'business.suspended' : 'business.reactivated', { entityType: 'business', entityId: id }));
  res.json(b);
});

/** Owner locked out (no email in v1): set a one-off password the admin passes on by phone. */
router.post('/platform/businesses/:id/reset-owner', async (req, res) => {
  const id = bizId(req);
  await mustExist(id);
  const password = randomBytes(9).toString('base64url'); // 12 chars
  const hash = await bcrypt.hash(password, 10);
  const owner = await runAsBusiness(id, async () => {
    const u = await one<{ id: number; username: string; name: string }>(
      `UPDATE users SET password_hash = $1, active = TRUE, failed_pin_attempts = 0, locked_until = NULL
       WHERE id = (SELECT id FROM users WHERE role = 'OWNER' ORDER BY active DESC, id LIMIT 1)
       RETURNING id, username, name`,
      [hash],
    );
    if (!u) throw new ApiError(404, 'NOT_FOUND', 'This salon has no owner account');
    invalidateUser(u.id);
    await audit(platformActor(req), 'user.password_reset_by_platform', { entityType: 'user', entityId: u.id });
    return u;
  });
  res.json({ username: owner.username, name: owner.name, temporary_password: password, note: 'Give this to the owner. Ask them to change it after logging in.' });
});

/** Owner lost every paired device: issue a fresh POS terminal key. */
router.post('/platform/businesses/:id/terminal-key', async (req, res) => {
  const id = bizId(req);
  await mustExist(id);
  const key = `gct_${randomBytes(24).toString('base64url')}`;
  const t = await runAsBusiness(id, async () => {
    const n = await one<{ n: number }>(`SELECT count(*)::int + 1 AS n FROM terminals WHERE code LIKE 'RECOVERY-%'`);
    const row = await one<{ id: number; code: string }>(
      `INSERT INTO terminals (code, name, kind, api_key_hash) VALUES ($1, 'Recovery device', 'POS', $2) RETURNING id, code`,
      [`RECOVERY-${n!.n}`, sha256(key)],
    );
    await audit(platformActor(req), 'terminal.created_by_platform', { entityType: 'terminal', entityId: row!.id });
    return row!;
  });
  res.status(201).json({ ...t, api_key: key, note: 'Shown once. The owner enters it under Pair device.' });
});
