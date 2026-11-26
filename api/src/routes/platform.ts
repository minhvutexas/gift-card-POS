import { Router, type NextFunction, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { rmSync } from 'node:fs';
import path from 'node:path';
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
      SELECT b.id, lpad(b.cid::text, 5, '0') AS cid, b.slug, b.name, b.status, b.owner_email, b.created_at,
             (SELECT count(*)::int FROM users u WHERE u.business_id = b.id AND u.active) AS users,
             (SELECT u.username FROM users u WHERE u.business_id = b.id AND u.role = 'OWNER' ORDER BY u.active DESC, u.id LIMIT 1) AS owner_username,
             (SELECT count(*)::int FROM gift_cards c WHERE c.business_id = b.id AND c.deleted_at IS NULL) AS cards,
             (SELECT COALESCE(sum(c.balance), 0)::numeric(14,2) FROM gift_cards c
               WHERE c.business_id = b.id AND c.status IN ('ACTIVE','PARTIALUSED') AND c.deleted_at IS NULL) AS outstanding,
             (SELECT max(t.created_at) FROM gift_card_transactions t WHERE t.business_id = b.id) AS last_activity_at
      FROM businesses b ORDER BY b.cid DESC`),
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
  const b = await runAsSystem(() => one(`UPDATE businesses SET status = $2 WHERE id = $1 RETURNING id, lpad(cid::text, 5, '0') AS cid, slug, name, status`, [id, status]));
  invalidateBusiness();
  await runAsBusiness(id, () => audit(platformActor(req), status === 'SUSPENDED' ? 'business.suspended' : 'business.reactivated', { entityType: 'business', entityId: id }));
  res.json(b);
});

/**
 * Owner locked out (no email in v1). The admin either types the new password
 * or lets the server make one, then passes it on by phone.
 */
router.post('/platform/businesses/:id/reset-owner', async (req, res) => {
  const id = bizId(req);
  const b = z
    .object({
      /** new sign-in name (unique inside the salon) — omit to keep */
      username: z.string().trim().regex(/^[A-Za-z0-9._-]{2,40}$/, 'Username: 2–40 letters, numbers, . _ -').optional(),
      /** new password — omit to generate one (unless keep_password) */
      password: z.string().min(10, 'Password must be at least 10 characters').max(200).optional(),
      keep_password: z.boolean().optional(),
    })
    .parse(req.body ?? {});
  await mustExist(id);
  const owner0 = await runAsBusiness(id, () =>
    one<{ id: number; username: string }>(`SELECT id, username FROM users WHERE role = 'OWNER' ORDER BY active DESC, id LIMIT 1`),
  );
  if (!owner0) throw new ApiError(404, 'NOT_FOUND', 'This salon has no owner account');
  if (b.username && b.username.toLowerCase() !== owner0.username.toLowerCase()) {
    const clash = await runAsBusiness(id, () => one('SELECT 1 FROM users WHERE lower(username) = lower($1) AND id <> $2', [b.username, owner0.id]));
    if (clash) throw new ApiError(409, 'USERNAME_TAKEN', 'Someone in this salon already has that username', 'username');
  }

  const keep = !!b.keep_password && b.password === undefined;
  const chosen = b.password !== undefined;
  const password = keep ? null : (b.password ?? randomBytes(9).toString('base64url')); // generated: 12 chars
  const hash = password ? await bcrypt.hash(password, 10) : null;
  const owner = await runAsBusiness(id, async () => {
    const u = await one<{ id: number; username: string; name: string }>(
      `UPDATE users SET username = COALESCE($2, username), password_hash = COALESCE($3, password_hash),
              active = TRUE, failed_pin_attempts = 0, locked_until = NULL
       WHERE id = $1 RETURNING id, username, name`,
      [owner0.id, b.username ?? null, hash],
    );
    invalidateUser(u!.id);
    await audit(platformActor(req), 'user.login_changed_by_platform', {
      entityType: 'user',
      entityId: u!.id,
      payload: { username_changed: !!b.username && b.username !== owner0.username, password: keep ? 'kept' : chosen ? 'set' : 'generated' },
    });
    return u!;
  });
  res.json({
    username: owner.username,
    name: owner.name,
    ...(password && !chosen ? { temporary_password: password } : {}),
    note: keep ? 'Username changed. Password unchanged.' : chosen ? 'Password changed.' : 'Give this to the owner. Ask them to change it after logging in.',
  });
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

/**
 * Delete a salon and ALL its data (cards, ledger, customers, staff, devices,
 * settings, backups). Cannot be undone. The admin must type the Salon ID.
 */
router.post('/platform/businesses/:id/delete', async (req, res) => {
  const id = bizId(req);
  const { confirm } = z.object({ confirm: z.string().trim().toLowerCase() }).parse(req.body ?? {});
  const b = await mustExist(id);
  if (confirm !== b.slug) throw new ApiError(400, 'CONFIRM_MISMATCH', `Type the Salon ID "${b.slug}" exactly to confirm`, 'confirm');
  const r = await runAsSystem(() => one<{ deleted: Record<string, number> }>('SELECT fn_purge_business($1) AS deleted', [id]));
  invalidateBusiness();
  rmSync(path.join(config.backupDir, `salon-${id}`), { recursive: true, force: true });
  console.warn(`[platform] salon ${b.slug} (#${id}) deleted from ${clientIp(req)}`);
  res.json({ deleted: true, slug: b.slug, name: b.name, rows: r?.deleted ?? {} });
});
