import { Router } from 'express';
import { z } from 'zod';
import { actorOf, requirePerm } from '../auth.js';
import { audit } from '../audit.js';
import { one, query } from '../db.js';
import { ApiError, notFound } from '../errors.js';
import { BACKUP_TABLES, createBackup, dumpAll, listBackups, readBackupFile } from '../services/backup.js';
import { parseCsv, runImport, suggestMapping, IMPORT_FIELDS } from '../services/importer.js';
import { toCsv } from '../util/csv.js';

export const router = Router();

// ------------------------------------------------------------------ import
router.post('/import/csv', requirePerm('import.run'), async (req, res) => {
  const b = z
    .object({
      filename: z.string().trim().min(1).max(200).default('import.csv'),
      csv: z.string().min(1, 'CSV is empty').max(10_000_000, 'CSV is larger than 10 MB'),
      mapping: z.record(z.enum(IMPORT_FIELDS), z.string()).optional(),
      dry_run: z.boolean().default(true),
    })
    .parse(req.body);
  const { headers, records } = parseCsv(b.csv);
  const mapping = b.mapping ?? suggestMapping(headers);
  if (!b.mapping) {
    // Step 1 of the wizard: return headers + suggested mapping + a sample.
    res.json({ step: 'mapping', headers, suggested_mapping: mapping, sample: records.slice(0, 5), rows_total: records.length, fields: IMPORT_FIELDS });
    return;
  }
  const out = await runImport(actorOf(req), { filename: b.filename, csv: b.csv, mapping, dry_run: b.dry_run });
  await audit(actorOf(req), b.dry_run ? 'import.dry_run' : 'import.committed', { entityType: 'import_job', entityId: out.job_id, payload: { rows_ok: out.rows_ok, rows_failed: out.rows_failed, filename: b.filename } });
  res.json({ step: b.dry_run ? 'preview' : 'done', ...out });
});

router.get('/import/jobs', requirePerm('import.run'), async (_req, res) => {
  const { rows } = await query(`SELECT j.id, j.filename, j.dry_run, j.rows_total, j.rows_ok, j.rows_failed, j.status, j.started_at, j.finished_at, u.name AS started_by
                                FROM import_jobs j LEFT JOIN users u ON u.id = j.started_by ORDER BY j.id DESC LIMIT 50`);
  res.json({ data: rows });
});

// ------------------------------------------------------------------ export
router.get('/data/export.json', requirePerm('data.export'), async (req, res) => {
  const dump = await dumpAll({ includeSecrets: false });
  await audit(actorOf(req), 'data.exported', { payload: { format: 'json' } });
  res.attachment(`giftcard-export-${new Date().toISOString().slice(0, 10)}.json`).type('application/json').send(JSON.stringify(dump, null, 2));
});

const CSV_TABLES = ['gift_cards', 'gift_card_transactions', 'customers', 'audit_log', 'message_log', 'card_tags', 'gift_card_tags', 'import_jobs'] as const;

router.get('/data/export/:file', requirePerm('data.export'), async (req, res) => {
  const table = String(req.params.file).replace(/\.csv$/, '');
  if (!(CSV_TABLES as readonly string[]).includes(table)) throw notFound(`Exportable tables: ${CSV_TABLES.join(', ')}`);
  const { rows, fields } = await query(`SELECT * FROM ${table} ORDER BY 1`);
  const cols = fields.map((f) => f.name).filter((n) => !/(pin_hash|password_hash|api_key_hash|pan_token)$/.test(n));
  await audit(actorOf(req), 'data.exported', { payload: { format: 'csv', table, rows: rows.length } });
  res.type('text/csv').attachment(`${table}-${new Date().toISOString().slice(0, 10)}.csv`).send(toCsv(cols, rows.map((r) => cols.map((c) => r[c]))));
});

// ------------------------------------------------------------------ backups
router.get('/data/backups', requirePerm('data.backup'), async (_req, res) => {
  res.json({ data: await listBackups(), tables: BACKUP_TABLES });
});

router.post('/data/backups', requirePerm('data.backup'), async (req, res) => {
  res.status(201).json(await createBackup(actorOf(req)));
});

router.get('/data/backups/:id/download', requirePerm('data.backup'), async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const b = await one<{ filename: string; sha256: string }>('SELECT filename, sha256 FROM backups WHERE id = $1', [id]);
  if (!b) throw notFound('Backup not found');
  const buf = readBackupFile(b.filename);
  await audit(actorOf(req), 'data.backup_downloaded', { entityType: 'backup', entityId: id });
  res.setHeader('X-Checksum-SHA256', b.sha256);
  res.attachment(b.filename).type('application/json').send(buf);
});

router.post('/data/restore', requirePerm('data.backup'), async () => {
  throw new ApiError(
    405,
    'RESTORE_VIA_CLI',
    'For safety, restores run from the server console into a fresh database: `npm run db:restore -- <backup.json>` (see README › Restore a backup).',
  );
});
