import { query, type Db, pool } from './db.js';
import type { Actor } from './types.js';

/** Non-money audit event (freeze/print/export/login/settings...). Append-only table. */
export async function audit(
  actor: Actor,
  action: string,
  opts: { entityType?: string; entityId?: string | number | null; cardId?: number | null; payload?: Record<string, unknown> } = {},
  db: Db = pool,
) {
  await query(
    `SELECT fn_audit($1::actor_type, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::inet, $10)`,
    [
      actor.actorType,
      actor.actorId,
      actor.terminalId,
      opts.entityType ?? (opts.cardId ? 'gift_card' : 'system'),
      opts.entityId != null ? String(opts.entityId) : opts.cardId != null ? String(opts.cardId) : null,
      opts.cardId ?? null,
      action,
      JSON.stringify(opts.payload ?? {}),
      actor.ip,
      actor.ua,
    ],
    db,
  );
}

/** Best-effort audit (never throws) — used for alerts after a failed operation. */
export function auditQuiet(actor: Actor, action: string, opts: Parameters<typeof audit>[2] = {}) {
  audit(actor, action, opts).catch((e) => console.error('audit failed', action, e.message));
}
