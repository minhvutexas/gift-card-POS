import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { currentBusinessId, one, query, withTx } from '../db.js';
import { ApiError } from '../errors.js';
import { audit } from '../audit.js';
import { invalidateSettings } from '../settings.js';
import { invalidatePermissions, invalidateUser } from '../auth.js';
import type { Actor } from '../types.js';

/** Dependency order (parents first). */
export const BACKUP_TABLES = [
  'role_permissions',
  'users',
  'settings',
  'terminals',
  'customers',
  'card_tags',
  'message_templates',
  'gift_cards',
  'gift_card_tags',
  'gift_card_transactions',
  'audit_log',
  'message_log',
  'import_jobs',
  'backups',
] as const;

const ORDER: Record<string, string> = { role_permissions: 'role, permission', settings: 'key', gift_card_tags: 'card_id, tag_id' };

export async function dumpAll(opts: { includeSecrets?: boolean } = { includeSecrets: true }) {
  const tables: Record<string, unknown[]> = {};
  for (const t of BACKUP_TABLES) {
    const r = await one<{ rows: unknown[] | null }>(`SELECT json_agg(t ORDER BY ${ORDER[t] ?? 'id'}) AS rows FROM ${t} t`);
    tables[t] = r?.rows ?? [];
  }
  if (!opts.includeSecrets) {
    tables.users = (tables.users as any[]).map((u) => ({ ...u, pin_hash: null, password_hash: '[redacted]' }));
    tables.terminals = (tables.terminals as any[]).map((t) => ({ ...t, api_key_hash: '[redacted]' }));
    tables.gift_cards = (tables.gift_cards as any[]).map((c) => ({ ...c, pin_hash: c.pin_hash ? '[redacted]' : null }));
  }
  return { format: 'giftcard-pos-backup', version: 1, app_version: config.version, created_at: new Date().toISOString(), tables };
}

/** Each salon's backup files live in their own folder. */
function salonBackupDir() {
  const bid = currentBusinessId();
  if (bid === null) throw new ApiError(400, 'BUSINESS_REQUIRED', 'Backups belong to a salon');
  return path.join(config.backupDir, `salon-${bid}`);
}

export async function createBackup(actor: Actor) {
  const data = JSON.stringify(await dumpAll({ includeSecrets: true }));
  const sha256 = createHash('sha256').update(data).digest('hex');
  const dir = salonBackupDir();
  mkdirSync(dir, { recursive: true });
  const filename = `backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  writeFileSync(path.join(dir, filename), data, { mode: 0o600 });
  const row = await one<{ id: number; created_at: string }>(
    `INSERT INTO backups (kind, filename, size_bytes, sha256, created_by) VALUES ('JSON', $1, $2, $3, $4) RETURNING id, created_at`,
    [filename, Buffer.byteLength(data), sha256, actor.actorId],
  );
  await audit(actor, 'data.backup_created', { entityType: 'backup', entityId: row!.id, payload: { filename, sha256 } });
  return { id: row!.id, filename, size_bytes: Buffer.byteLength(data), sha256, created_at: row!.created_at };
}

export function readBackupFile(filename: string) {
  if (!/^backup-[\w-]+\.json$/.test(filename)) throw new ApiError(400, 'VALIDATION', 'Bad backup filename');
  const p = path.join(salonBackupDir(), filename);
  if (!existsSync(p)) throw new ApiError(404, 'NOT_FOUND', 'Backup file is missing on disk');
  return readFileSync(p);
}

/**
 * Restores a JSON backup into an EMPTY database (fresh `db:migrate` with
 * SKIP_DEMO_SEED=true). Refuses to run when any card/ledger/audit rows
 * exist — the ledger is append-only, so we never merge into live data.
 */
export async function restoreBackup(actor: Actor, backup: any, expectedSha?: string) {
  if (backup?.format !== 'giftcard-pos-backup' || typeof backup.tables !== 'object') throw new ApiError(400, 'VALIDATION', 'Not a gift card POS backup file');
  if (expectedSha) {
    const actual = createHash('sha256').update(JSON.stringify(backup)).digest('hex');
    if (actual !== expectedSha) throw new ApiError(400, 'CHECKSUM_MISMATCH', 'Backup checksum does not match');
  }
  const counts = await one<{ n: number }>(`SELECT (SELECT COUNT(*) FROM gift_cards) + (SELECT COUNT(*) FROM gift_card_transactions) + (SELECT COUNT(*) FROM audit_log) AS n`);
  if ((counts?.n ?? 0) > 0) {
    throw new ApiError(409, 'RESTORE_TARGET_NOT_EMPTY', 'Restore only into an empty database: create a new DB, run db:migrate with SKIP_DEMO_SEED=true, then restore.');
  }
  const restored: Record<string, number> = {};
  const bid = currentBusinessId();
  if (bid === null) throw new ApiError(400, 'BUSINESS_REQUIRED', 'Restore must run inside a salon');
  await withTx(async (c) => {
    await c.query(`SELECT set_config('gc.write_path', 'restore', true)`);
    // Reference tables may hold defaults — replace them wholesale.
    for (const t of ['role_permissions', 'settings', 'message_templates', 'card_tags', 'terminals', 'users', 'customers']) await c.query(`DELETE FROM ${t}`);
    for (const t of BACKUP_TABLES) {
      let rows = (backup.tables[t] ?? []) as any[];
      if (!rows.length) continue;
      if (t === 'gift_cards') rows = rows.map((r) => ({ ...r, replaced_by_card_id: null }));
      // Rows land in the salon doing the restore, whatever salon id the file carries.
      rows = rows.map((r) => ({ ...r, business_id: bid }));
      await c.query(`INSERT INTO ${t} SELECT * FROM json_populate_recordset(NULL::${t}, $1::json)`, [JSON.stringify(rows)]);
      restored[t] = rows.length;
    }
    for (const r of (backup.tables.gift_cards ?? []) as any[]) {
      if (r.replaced_by_card_id) await c.query('UPDATE gift_cards SET replaced_by_card_id = $2 WHERE id = $1', [r.id, r.replaced_by_card_id]);
    }
    for (const t of BACKUP_TABLES) {
      if (t === 'role_permissions' || t === 'settings' || t === 'gift_card_tags') continue;
      await c.query(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), GREATEST(COALESCE((SELECT MAX(id) FROM ${t}), 0), 1))`);
    }
    await c.query(`SELECT setval('gift_card_number_seq', GREATEST(3460011, COALESCE((SELECT MAX(card_number::bigint) + 1 FROM gift_cards WHERE card_number ~ '^[0-9]{1,15}$'), 0)), false)`);
    // Sanity: every card balance must equal the ledger's last balance_after.
    const bad = await one<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM gift_cards c
       WHERE c.balance <> COALESCE((SELECT t.balance_after FROM gift_card_transactions t WHERE t.card_id = c.id ORDER BY t.id DESC LIMIT 1), 0)`,
      [],
      c,
    );
    if (bad?.n) throw new ApiError(422, 'RESTORE_INCONSISTENT', `${bad.n} card balances do not match their ledger — restore aborted`);
  }, { isolation: 'READ COMMITTED', retries: 0 });
  invalidateSettings();
  invalidatePermissions();
  invalidateUser();
  await audit({ ...actor, actorId: null }, 'data.backup_restored', { entityType: 'backup', payload: { restored, source_created_at: backup.created_at } });
  return { restored };
}

export async function listBackups() {
  const { rows } = await query(`SELECT b.id, b.kind, b.filename, b.size_bytes, b.sha256, b.created_at, u.name AS created_by FROM backups b LEFT JOIN users u ON u.id = b.created_by ORDER BY b.id DESC LIMIT 100`);
  return rows;
}
