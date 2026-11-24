import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { createHash, randomUUID } from 'node:crypto';
import { config } from './config.js';
import { one, query } from './db.js';
import { ApiError, forbidden, unauthorized } from './errors.js';
import { getSetting } from './settings.js';
import type { Actor, AuthUser, TerminalInfo } from './types.js';

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// ---------------------------------------------------------------- actor
export function clientIp(req: Request): string | null {
  const ip = req.ip ?? req.socket.remoteAddress ?? null;
  return ip?.startsWith('::ffff:') ? ip.slice(7) : ip;
}

export function actorOf(req: Request): Actor {
  return {
    actorType: req.user ? 'USER' : req.terminal?.kind === 'KIOSK' ? 'KIOSK' : 'SYSTEM',
    actorId: req.user?.id ?? null,
    terminalId: req.terminal?.id ?? null,
    ip: clientIp(req),
    ua: req.get('user-agent')?.slice(0, 300) ?? null,
  };
}

// ---------------------------------------------------------------- terminal key
const lastSeenWritten = new Map<number, number>();

export async function terminalMiddleware(req: Request, _res: Response, next: NextFunction) {
  const key = req.get('x-terminal-key') ?? (typeof req.query.terminal_key === 'string' ? req.query.terminal_key : undefined);
  if (key) {
    const t = await one<TerminalInfo>('SELECT id, code, name, kind FROM terminals WHERE api_key_hash = $1 AND active', [sha256(key)]);
    if (!t) return next(unauthorized('Unknown or disabled terminal key', 'TERMINAL_INVALID'));
    req.terminal = t;
    const last = lastSeenWritten.get(t.id) ?? 0;
    if (Date.now() - last > 60_000) {
      lastSeenWritten.set(t.id, Date.now());
      query('UPDATE terminals SET last_seen_at = now() WHERE id = $1', [t.id]).catch(() => {});
    }
  } else if (config.requireTerminalKey) {
    return next(unauthorized('This device is not paired. Enter the terminal key in Settings › Terminal.', 'TERMINAL_REQUIRED'));
  }
  next();
}

// ---------------------------------------------------------------- permissions
let permCache: { at: number; map: Map<string, Set<string>> } | null = null;

export function invalidatePermissions() {
  permCache = null;
}

export async function permissionsFor(role: string): Promise<Set<string>> {
  if (!permCache || Date.now() - permCache.at > 60_000) {
    const { rows } = await query<{ role: string; permission: string }>('SELECT role::text, permission FROM role_permissions');
    const map = new Map<string, Set<string>>();
    for (const r of rows) {
      if (!map.has(r.role)) map.set(r.role, new Set());
      map.get(r.role)!.add(r.permission);
    }
    permCache = { at: Date.now(), map };
  }
  return permCache.map.get(role) ?? new Set();
}

export const can = (user: AuthUser | undefined, perm: string) => !!user && (user.perms.has('*') || user.perms.has(perm));

export const requirePerm = (perm: string) => (req: Request, _res: Response, next: NextFunction) => {
  if (!req.user) return next(unauthorized());
  if (!can(req.user, perm)) return next(forbidden(`Your role (${req.user.role}) cannot perform "${perm}"`));
  next();
};

// ---------------------------------------------------------------- sessions (JWT)
interface SessionClaims {
  sub: string;
  typ: 'session';
  tid: number | null;
}

export async function issueSession(user: { id: number }, terminalId: number | null) {
  const { session_timeout_min } = await getSetting('security');
  const token = jwt.sign({ typ: 'session', tid: terminalId } satisfies Omit<SessionClaims, 'sub'>, config.jwtSecret, {
    subject: String(user.id),
    expiresIn: session_timeout_min * 60,
    jwtid: randomUUID(),
  });
  return { token, expires_in: session_timeout_min * 60 };
}

const revoked = new Map<string, number>(); // jti → exp (logout)

const userCache = new Map<number, { at: number; user: AuthUser | null }>();

async function loadUser(id: number): Promise<AuthUser | null> {
  const hit = userCache.get(id);
  if (hit && Date.now() - hit.at < 15_000) return hit.user;
  const row = await one<{ id: number; name: string; username: string; role: string }>(
    'SELECT id, name, username, role::text FROM users WHERE id = $1 AND active',
    [id],
  );
  const user = row ? { ...row, perms: await permissionsFor(row.role) } : null;
  userCache.set(id, { at: Date.now(), user });
  return user;
}

export function invalidateUser(id?: number) {
  if (id === undefined) userCache.clear();
  else userCache.delete(id);
}

export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  const header = req.get('authorization');
  const token = header?.startsWith('Bearer ') ? header.slice(7) : typeof req.query.access_token === 'string' ? req.query.access_token : undefined;
  if (!token) return next(unauthorized());
  let claims: SessionClaims & { jti?: string };
  try {
    claims = jwt.verify(token, config.jwtSecret) as any;
  } catch (e: any) {
    return next(unauthorized(e?.name === 'TokenExpiredError' ? 'Session expired — please log in again' : 'Invalid session', 'SESSION_INVALID'));
  }
  if (claims.typ !== 'session' || (claims.jti && revoked.has(claims.jti))) return next(unauthorized('Invalid session', 'SESSION_INVALID'));
  if (claims.tid && req.terminal && claims.tid !== req.terminal.id) return next(unauthorized('Session belongs to another terminal', 'SESSION_INVALID'));
  const user = await loadUser(Number(claims.sub));
  if (!user) return next(unauthorized('User disabled', 'SESSION_INVALID'));
  req.user = user;
  next();
}

export function revokeToken(token: string) {
  const decoded = jwt.decode(token) as { jti?: string; exp?: number } | null;
  if (decoded?.jti) revoked.set(decoded.jti, (decoded.exp ?? 0) * 1000);
  for (const [k, exp] of revoked) if (exp < Date.now()) revoked.delete(k);
}

// ---------------------------------------------------------------- PIN check w/ lockout
interface UserRow {
  id: number;
  name: string;
  username: string;
  role: string;
  pin_hash: string | null;
  password_hash: string | null;
  failed_pin_attempts: number;
  locked_until: Date | null;
}

export async function verifyPin(pin: string, opts: { userId?: number; roles?: string[] } = {}): Promise<UserRow> {
  const sec = await getSetting('security');
  const params: unknown[] = [];
  let where = 'active AND pin_hash IS NOT NULL';
  if (opts.userId) {
    params.push(opts.userId);
    where += ` AND id = $${params.length}`;
  }
  if (opts.roles?.length) {
    params.push(opts.roles);
    where += ` AND role::text = ANY($${params.length})`;
  }
  const { rows } = await query<UserRow>(`SELECT id, name, username, role::text, pin_hash, password_hash, failed_pin_attempts, locked_until FROM users WHERE ${where} ORDER BY id`, params);
  const now = Date.now();
  for (const u of rows) {
    if (u.locked_until && u.locked_until.getTime() > now) {
      if (opts.userId) throw new ApiError(423, 'PIN_LOCKED', 'This user is temporarily locked — try again later', 'pin');
      continue;
    }
    if (await bcrypt.compare(pin, u.pin_hash!)) {
      if (u.failed_pin_attempts) await query('UPDATE users SET failed_pin_attempts = 0, locked_until = NULL WHERE id = $1', [u.id]);
      return u;
    }
  }
  // Wrong PIN: only attributable when a specific user was chosen.
  if (opts.userId && rows[0]) {
    const u = rows[0];
    const attempts = u.failed_pin_attempts + 1;
    const lock = attempts >= sec.pin_max_attempts;
    await query(
      `UPDATE users SET failed_pin_attempts = $2, locked_until = CASE WHEN $3 THEN now() + make_interval(mins => $4) END WHERE id = $1`,
      [u.id, lock ? 0 : attempts, lock, sec.pin_lockout_min],
    );
    if (lock) throw new ApiError(423, 'PIN_LOCKED', `Too many attempts. Locked for ${sec.pin_lockout_min} minutes.`, 'pin');
  }
  throw new ApiError(401, 'PIN_INVALID', 'Incorrect PIN', 'pin');
}

export async function verifyPassword(username: string, password: string): Promise<UserRow> {
  const u = await one<UserRow>(
    'SELECT id, name, username, role::text, pin_hash, password_hash, failed_pin_attempts, locked_until FROM users WHERE lower(username) = lower($1) AND active',
    [username],
  );
  // Compare against a dummy hash when the user is missing to keep timing flat.
  const ok = await bcrypt.compare(password, u?.password_hash ?? '$2a$10$CwTycUXWue0Thq9StjUM0uJ8.qdSBPPQNkuz.3ZNPcSjyU6qNkhd6');
  if (!u || !u.password_hash || !ok) throw new ApiError(401, 'LOGIN_INVALID', 'Incorrect username or password');
  return u;
}

// ---------------------------------------------------------------- manager step-up approvals
export type ApprovalAction = 'void' | 'adjust' | 'archive' | 'refund' | 'large_amount' | 'reverse' | 'restore' | 'erase' | 'delete' | 'bulk_void';

interface ApprovalClaims {
  typ: 'approval';
  act: ApprovalAction;
  req: number;
  sub: string;
  jti: string;
}
const usedApprovals = new Map<string, number>();

export function issueApprovalToken(approverId: number, action: ApprovalAction, requesterId: number) {
  return jwt.sign({ typ: 'approval', act: action, req: requesterId }, config.jwtSecret, {
    subject: String(approverId),
    expiresIn: 120,
    jwtid: randomUUID(),
  });
}

/**
 * Enforces manager step-up. Returns the approving user id (or the actor
 * themselves when they are a manager and dual control does not apply).
 * Throws 403 APPROVAL_REQUIRED so the client can show the PIN pad and retry.
 */
export async function requireApproval(req: Request, action: ApprovalAction, opts: { dualControl?: boolean } = {}): Promise<number> {
  const user = req.user!;
  const isManager = can(user, 'approve');
  const token = req.get('x-approval-token');
  if (!token) {
    if (isManager && !opts.dualControl) return user.id;
    throw new ApiError(403, 'APPROVAL_REQUIRED', opts.dualControl ? 'A second manager must approve this action' : 'Manager approval required', undefined, {
      action,
      dual_control: !!opts.dualControl,
    });
  }
  let claims: ApprovalClaims;
  try {
    claims = jwt.verify(token, config.jwtSecret) as any;
  } catch {
    throw new ApiError(403, 'APPROVAL_INVALID', 'Approval expired — ask the manager to re-enter their PIN');
  }
  if (claims.typ !== 'approval' || claims.req !== user.id) throw new ApiError(403, 'APPROVAL_INVALID', 'Approval was issued for someone else');
  if (claims.act !== action && claims.act !== 'large_amount') throw new ApiError(403, 'APPROVAL_INVALID', `Approval was for "${claims.act}", not "${action}"`);
  if (opts.dualControl && Number(claims.sub) === user.id) throw new ApiError(403, 'APPROVAL_INVALID', 'Dual control: approver must be a different person');
  // Single use — but the same request retried with the same idempotency key must still succeed.
  const usedBy = usedApprovals.get(claims.jti);
  if (usedBy !== undefined && req.idempotencyKey && usedBy !== hashKey(req.idempotencyKey)) {
    throw new ApiError(403, 'APPROVAL_INVALID', 'Approval token was already used');
  }
  usedApprovals.set(claims.jti, req.idempotencyKey ? hashKey(req.idempotencyKey) : -1);
  if (usedApprovals.size > 5000) usedApprovals.clear();
  return Number(claims.sub);
}

function hashKey(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}
