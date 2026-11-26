import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { config } from '../config.js';
import { clientIp, issueSession, sha256 } from '../auth.js';
import { one, runAsBusiness, runAsSystem, withTx } from '../db.js';
import { ApiError } from '../errors.js';
import { audit } from '../audit.js';
import { SLUG_RE, invalidateBusiness } from '../tenant.js';

/**
 * Public, salon-less routes: create a salon, check a Salon ID.
 * Mounted BEFORE tenant resolution, so nothing here can read salon data
 * except through the explicit system steps below.
 */
export const router = Router();

/** Salon IDs that would collide with app paths or look official. */
const RESERVED = new Set(['admin', 'api', 'app', 'help', 'k', 'kiosk', 'login', 'platform', 'root', 'signup', 'support', 'system', 'www', 'demo', 'test']);

const limiter = () =>
  rateLimit({
    windowMs: 60 * 60_000,
    limit: config.signupPerHour,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: (req) => clientIp(req) ?? 'unknown',
    handler: (_req, res) =>
      res.status(429).type('application/problem+json').json({ status: 429, code: 'RATE_LIMITED', message: 'Too many sign-ups from this network. Try again in an hour.' }),
  });

export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(SLUG_RE, 'Salon ID: 3–40 letters, numbers or dashes (no dash at the start or end)')
  .refine((s) => !RESERVED.has(s), 'That Salon ID is reserved — pick another');

async function slugTaken(slug: string) {
  return !!(await runAsSystem(() => one('SELECT 1 FROM businesses WHERE slug = $1', [slug])));
}

const checkLimiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false, keyGenerator: (req) => clientIp(req) ?? 'unknown' });

router.get('/signup/slug-available', checkLimiter, async (req, res) => {
  const parsed = slugSchema.safeParse(String(req.query.slug ?? ''));
  if (!parsed.success) return res.json({ available: false, reason: parsed.error.issues[0]?.message });
  const taken = await slugTaken(parsed.data);
  res.json({ available: !taken, slug: parsed.data, reason: taken ? 'That Salon ID is taken' : undefined });
});

const signupBody = z.object({
  salon_name: z.string().trim().min(2, 'Salon name is too short').max(80),
  slug: slugSchema,
  owner_name: z.string().trim().min(1, 'Your name is required').max(80),
  email: z.string().trim().toLowerCase().email('Enter a valid email').max(120),
  username: z.string().trim().regex(/^[A-Za-z0-9._-]{2,40}$/, 'Username: 2–40 letters, numbers, . _ -'),
  password: z.string().min(10, 'Password must be at least 10 characters').max(200),
  /** Optional: staff PINs (and the owner's own) are set later in Settings › Security. */
  pin: z.string().regex(/^\d{4,8}$/, 'PIN must be 4–8 digits').optional(),
  timezone: z.string().trim().min(1).max(60).optional(),
});

router.post('/signup', limiter(), async (req, res) => {
  if (!config.signupEnabled) throw new ApiError(403, 'SIGNUP_CLOSED', 'New salon sign-ups are closed. Contact support.');
  const b = signupBody.parse(req.body);
  if (await slugTaken(b.slug)) throw new ApiError(409, 'SLUG_TAKEN', 'That Salon ID is taken', 'slug');

  const [passwordHash, pinHash] = await Promise.all([bcrypt.hash(b.password, 10), b.pin ? bcrypt.hash(b.pin, 10) : Promise.resolve(null)]);
  const terminalKey = `gct_${randomBytes(24).toString('base64url')}`;

  // One transaction: platform step (create the salon), then everything else
  // inside that salon only (SET LOCAL reverts when the transaction ends).
  const created = await runAsSystem(() =>
    withTx(
      async (c) => {
        const biz = await one<{ id: number; cid: string; slug: string; name: string }>(
          `INSERT INTO businesses (slug, name, owner_email) VALUES ($1, $2, $3) ON CONFLICT (slug) DO NOTHING RETURNING id, lpad(cid::text, 5, '0') AS cid, slug, name`,
          [b.slug, b.salon_name, b.email],
          c,
        );
        if (!biz) throw new ApiError(409, 'SLUG_TAKEN', 'That Salon ID is taken', 'slug');
        await c.query(`SELECT set_config('app.system', '', true), set_config('app.business_id', $1, true)`, [String(biz.id)]);
        await c.query('SELECT fn_seed_business($1, $2)', [biz.id, b.salon_name]);
        if (b.timezone) {
          await c.query(`UPDATE settings SET value = jsonb_set(value, '{timezone}', to_jsonb($1::text)) WHERE key = 'general'`, [b.timezone]);
        }
        const user = await one<{ id: number }>(
          `INSERT INTO users (name, username, role, password_hash, pin_hash) VALUES ($1, $2, 'OWNER', $3, $4) RETURNING id`,
          [b.owner_name, b.username, passwordHash, pinHash],
          c,
        );
        const terminal = await one<{ id: number }>(
          `INSERT INTO terminals (code, name, kind, api_key_hash) VALUES ('FRONT-DESK-1', 'Front desk', 'POS', $1) RETURNING id`,
          [sha256(terminalKey)],
          c,
        );
        return { business: biz, userId: user!.id, terminalId: terminal!.id };
      },
      { isolation: 'READ COMMITTED', retries: 0 },
    ),
  );
  invalidateBusiness();

  const session = await runAsBusiness(created.business.id, async () => {
    await audit(
      { actorType: 'USER', actorId: created.userId, terminalId: created.terminalId, ip: clientIp(req), ua: req.get('user-agent')?.slice(0, 300) ?? null },
      'business.created',
      { entityType: 'business', entityId: created.business.id, payload: { slug: created.business.slug } },
    );
    return issueSession({ id: created.userId }, created.terminalId);
  });

  res.status(201).json({
    business: created.business,
    terminal_key: terminalKey,
    note: 'This device is now paired. Save the terminal key — it is shown only once.',
    ...session,
  });
});

/** Salon name for login screens / kiosk headers (needs a salon in context). */
export const businessInfo = Router();
businessInfo.get('/business', (req, res) => {
  res.json({ cid: req.business!.cid, slug: req.business!.slug, name: req.business!.name });
});

