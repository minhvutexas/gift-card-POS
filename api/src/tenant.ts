import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { createHash } from 'node:crypto';
import { config } from './config.js';
import { one, runAsBusiness, runAsSystem } from './db.js';
import { ApiError, unauthorized } from './errors.js';
import type { BusinessInfo, TerminalInfo } from './types.js';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

// ---------------------------------------------------------------- business lookup (short cache)
const TTL_MS = 15_000;
const byId = new Map<number, { at: number; b: BusinessInfo | null }>();
const bySlug = new Map<string, { at: number; b: BusinessInfo | null }>();

async function loadBusiness(where: 'id' | 'slug', value: number | string): Promise<BusinessInfo | null> {
  const cache = where === 'id' ? byId : bySlug;
  const hit = cache.get(value as never);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.b;
  const b =
    (await runAsSystem(() =>
      one<BusinessInfo>(`SELECT id, lpad(cid::text, 5, '0') AS cid, slug, name, status FROM businesses WHERE ${where} = $1`, [value]),
    )) ?? null;
  cache.set(value as never, { at: Date.now(), b });
  return b;
}

export const businessById = (id: number) => loadBusiness('id', id);
export const businessBySlug = (slug: string) => loadBusiness('slug', slug.toLowerCase());

export function invalidateBusiness() {
  byId.clear();
  bySlug.clear();
}

// ---------------------------------------------------------------- per-request tenant
function slugFrom(req: Request): string | undefined {
  const raw =
    req.get('x-business') ??
    (typeof req.query.business === 'string' ? req.query.business : undefined) ??
    (req.body && typeof req.body.business === 'string' ? req.body.business : undefined);
  return raw?.trim().toLowerCase() || undefined;
}

function sessionBid(req: Request): number | null | undefined {
  const header = req.get('authorization');
  const token = header?.startsWith('Bearer ') ? header.slice(7) : typeof req.query.access_token === 'string' ? req.query.access_token : undefined;
  if (!token) return undefined;
  try {
    const c = jwt.verify(token, config.jwtSecret) as { bid?: number };
    return typeof c.bid === 'number' ? c.bid : null;
  } catch {
    return undefined; // authenticate() reports the bad session later
  }
}

/**
 * Works out which salon a request belongs to, then runs the rest of the
 * request inside that salon's database context. Sources, strongest first:
 *   1. X-Terminal-Key   — every paired device belongs to exactly one salon
 *   2. session JWT      — signed `bid` claim
 *   3. Salon ID (slug)  — X-Business header, ?business=, or body.business
 *   4. DEFAULT_BUSINESS — single-salon/dev installs only
 * Two sources that disagree → 401, so a token or key from salon A can never
 * be used against salon B.
 */
export async function resolveTenant(req: Request, _res: Response, next: NextFunction) {
  try {
    let bid: number | null = null;

    const key = req.get('x-terminal-key') ?? (typeof req.query.terminal_key === 'string' ? req.query.terminal_key : undefined);
    if (key) {
      const t = await runAsSystem(() =>
        one<TerminalInfo & { business_id: number }>(
          'SELECT id, code, name, kind, business_id FROM terminals WHERE api_key_hash = $1 AND active',
          [sha256(key)],
        ),
      );
      if (!t) return next(unauthorized('Unknown or disabled terminal key', 'TERMINAL_INVALID'));
      const { business_id, ...terminal } = t;
      req.terminal = terminal;
      bid = business_id;
    }

    const sb = sessionBid(req);
    if (sb === null) return next(unauthorized('Session is from an older version — please log in again', 'SESSION_INVALID'));
    if (sb !== undefined) {
      if (bid !== null && bid !== sb) return next(unauthorized('Session belongs to another salon', 'SESSION_INVALID'));
      bid = sb;
    }

    const named = slugFrom(req);
    const slug = named ?? (bid === null ? config.defaultBusiness || undefined : undefined);
    req.businessFromDefault = !named && bid === null && !!slug;
    let business: BusinessInfo | null = null;
    if (slug) {
      if (!SLUG_RE.test(slug)) return next(new ApiError(400, 'VALIDATION', 'Salon ID is not valid', 'business'));
      business = await businessBySlug(slug);
      if (!business) return next(new ApiError(404, 'BUSINESS_NOT_FOUND', 'No salon with that Salon ID', 'business'));
      if (bid !== null && bid !== business.id) return next(unauthorized('This device or session belongs to another salon', 'SESSION_INVALID'));
      bid = business.id;
    } else if (bid !== null) {
      business = await businessById(bid);
    }

    if (bid === null) return next();
    if (!business) return next(unauthorized('Salon not found', 'SESSION_INVALID'));
    if (business.status !== 'ACTIVE') return next(new ApiError(403, 'BUSINESS_SUSPENDED', 'This salon account is suspended. Contact support.'));
    req.business = business;
    runAsBusiness(business.id, () => next());
  } catch (e) {
    next(e);
  }
}

/** Everything below this needs a salon: terminal key, session, or Salon ID. */
export function requireBusiness(req: Request, _res: Response, next: NextFunction) {
  if (!req.business) return next(new ApiError(400, 'BUSINESS_REQUIRED', 'Enter your Salon ID to continue', 'business'));
  next();
}
