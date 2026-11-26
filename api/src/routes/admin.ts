import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { actorOf, assertOwnerUsernameFree, can, invalidatePermissions, invalidateUser, requirePerm, sha256 } from '../auth.js';
import { audit } from '../audit.js';
import { config } from '../config.js';
import { one, query } from '../db.js';
import { ApiError, forbidden, notFound } from '../errors.js';
import { getAllSettings, invalidateSettings, isSettingKey, settingSchemas } from '../settings.js';
import { encodeReceipt, sendToNetworkPrinter, type Receipt } from '../services/printing.js';

export const router = Router();

// ------------------------------------------------------------------ settings
router.get('/settings', requirePerm('settings.read'), async (_req, res) => {
  res.json(await getAllSettings());
});

router.get('/settings/:key', requirePerm('settings.read'), async (req, res) => {
  const key = String(req.params.key);
  if (!isSettingKey(key)) throw notFound(`Unknown setting "${key}"`);
  res.json({ key, value: (await getAllSettings())[key] });
});

router.put('/settings/:key', requirePerm('settings.write'), async (req, res) => {
  const key = String(req.params.key);
  if (!isSettingKey(key)) throw notFound(`Unknown setting "${key}"`);
  if (key === 'security' && !can(req.user, '*')) throw forbidden('Only the owner can change security settings');
  const value = settingSchemas[key].parse(req.body?.value ?? req.body);
  const before = (await getAllSettings())[key];
  await query(
    `INSERT INTO settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (business_id, key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [key, JSON.stringify(value), req.user!.id],
  );
  invalidateSettings();
  await audit(actorOf(req), 'settings.changed', { entityType: 'settings', entityId: key, payload: { before, after: value } });
  res.json({ key, value });
});

// ------------------------------------------------------------------ message templates
router.get('/templates', requirePerm('settings.read'), async (_req, res) => {
  const { rows } = await query(`SELECT id, key, channel::text, subject, body, active, updated_at FROM message_templates ORDER BY key, channel`);
  res.json({ data: rows });
});

router.put('/templates/:id', requirePerm('settings.write'), async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const b = z.object({ subject: z.string().max(160).nullable().optional(), body: z.string().min(1).max(1600), active: z.boolean().default(true) }).parse(req.body);
  const row = await one(
    `UPDATE message_templates SET subject = $2, body = $3, active = $4, updated_at = now() WHERE id = $1 RETURNING id, key, channel::text, subject, body, active, updated_at`,
    [id, b.subject ?? null, b.body, b.active],
  );
  if (!row) throw notFound('Template not found');
  await audit(actorOf(req), 'template.updated', { entityType: 'message_template', entityId: id });
  res.json(row);
});

// ------------------------------------------------------------------ tags
router.get('/tags', requirePerm('cards.read'), async (_req, res) => {
  const { rows } = await query(`SELECT t.id, t.name, t.color, COUNT(gt.card_id)::int AS card_count FROM card_tags t LEFT JOIN gift_card_tags gt ON gt.tag_id = t.id GROUP BY t.id ORDER BY t.name`);
  res.json({ data: rows });
});

router.post('/tags', requirePerm('cards.edit'), async (req, res) => {
  const b = z.object({ name: z.string().trim().min(1).max(40), color: z.string().trim().max(20).default('slate') }).parse(req.body);
  const row = await one('INSERT INTO card_tags (name, color) VALUES ($1, $2) RETURNING id, name, color', [b.name, b.color]);
  await audit(actorOf(req), 'tag.created', { entityType: 'tag', entityId: row!.id, payload: b });
  res.status(201).json(row);
});

router.delete('/tags/:id', requirePerm('settings.write'), async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const r = await query('DELETE FROM card_tags WHERE id = $1', [id]);
  if (!r.rowCount) throw new ApiError(404, 'NOT_FOUND', 'Tag not found');
  await audit(actorOf(req), 'tag.deleted', { entityType: 'tag', entityId: id });
  res.json({ deleted: true });
});

// ------------------------------------------------------------------ terminals
router.get('/terminals', requirePerm('settings.read'), async (_req, res) => {
  const { rows } = await query(`SELECT id, code, name, kind, last_seen_at, active, created_at FROM terminals ORDER BY id`);
  res.json({ data: rows });
});

const newKey = () => `gct_${randomBytes(24).toString('base64url')}`;

router.post('/terminals', requirePerm('settings.write'), async (req, res) => {
  const b = z.object({ code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{2,40}$/), name: z.string().trim().min(1).max(80), kind: z.enum(['POS', 'KIOSK']).default('POS') }).parse(req.body);
  const key = newKey();
  const row = await one(`INSERT INTO terminals (code, name, kind, api_key_hash) VALUES ($1,$2,$3,$4) RETURNING id, code, name, kind, active, created_at`, [b.code, b.name, b.kind, sha256(key)]);
  await audit(actorOf(req), 'terminal.created', { entityType: 'terminal', entityId: row!.id, payload: { code: b.code } });
  res.status(201).json({ ...row, api_key: key, note: 'Copy this key now — it is shown only once.' });
});

router.post('/terminals/:id/rotate-key', requirePerm('settings.write'), async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const key = newKey();
  const row = await one(`UPDATE terminals SET api_key_hash = $2 WHERE id = $1 RETURNING id, code`, [id, sha256(key)]);
  if (!row) throw notFound('Terminal not found');
  await audit(actorOf(req), 'terminal.key_rotated', { entityType: 'terminal', entityId: id });
  res.json({ ...row, api_key: key });
});

router.patch('/terminals/:id', requirePerm('settings.write'), async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const b = z.object({ name: z.string().trim().min(1).max(80).optional(), active: z.boolean().optional() }).parse(req.body);
  if (req.terminal?.id === id && b.active === false) throw new ApiError(409, 'STATE_CONFLICT', 'You cannot disable the terminal you are using');
  const row = await one(`UPDATE terminals SET name = COALESCE($2, name), active = COALESCE($3, active) WHERE id = $1 RETURNING id, code, name, kind, active, last_seen_at`, [id, b.name ?? null, b.active ?? null]);
  if (!row) throw notFound('Terminal not found');
  await audit(actorOf(req), 'terminal.updated', { entityType: 'terminal', entityId: id, payload: b });
  res.json(row);
});

router.post('/terminals/test-connection', requirePerm('settings.read'), async (_req, res) => {
  const t = (await getAllSettings()).terminal;
  const started = Date.now();
  // Gateway is a stub: report config completeness + API round-trip.
  const ok = t.gateway === 'stub' || !!t.gateway_public_key;
  res.json({
    ok,
    gateway: t.gateway,
    mode: t.gateway_mode,
    latency_ms: Date.now() - started,
    message: t.gateway === 'stub' ? `Stub gateway (${config.gatewayMode}) — online reloads are simulated.` : ok ? 'Gateway keys present.' : 'Gateway public key missing.',
  });
});

router.post('/printer/test', requirePerm('cards.print'), async (req, res) => {
  const s = await getAllSettings();
  const receipt: Receipt = {
    title: s.general.business_name,
    header: ['Printer test'],
    lines: [
      { left: 'Paper', right: `${s.printer.paper_width_mm}mm` },
      { left: 'Time', right: new Date().toLocaleString('en-US', { timeZone: s.general.timezone }) },
    ],
    barcode: s.receipt.show_barcode ? '3460010' : null,
    footer: ['If you can read this, printing works.'],
    paper_width_mm: s.printer.paper_width_mm,
  };
  if (s.printer.mode === 'network') {
    if (!s.printer.host) throw new ApiError(400, 'VALIDATION', 'Set the printer IP/host first', 'host');
    try {
      await sendToNetworkPrinter(s.printer.host, s.printer.port, encodeReceipt(receipt));
    } catch (e: any) {
      await audit(actorOf(req), 'alert.print_failed', { payload: { message: e.message, test: true } });
      throw new ApiError(502, 'PRINT_FAILED', e.message);
    }
  }
  res.json({ ok: true, mode: s.printer.mode, receipt });
});

// ------------------------------------------------------------------ users & roles
const ALL_PERMISSIONS = [
  'dashboard.read', 'cards.read', 'cards.issue', 'cards.reload', 'cards.redeem', 'cards.freeze', 'cards.refund', 'cards.adjust',
  'cards.void', 'cards.transfer', 'cards.merge', 'cards.replace', 'cards.edit', 'cards.delete', 'cards.archive', 'cards.export',
  'cards.print', 'cards.send', 'cards.reverse', 'history.read', 'history.export', 'customers.read', 'customers.write',
  'customers.erase', 'settings.read', 'settings.write', 'import.run', 'data.export', 'data.backup', 'approve', 'users.manage',
  'kiosk.lookup',
];

router.get('/users', requirePerm('settings.read'), async (_req, res) => {
  const { rows } = await query(`SELECT id, name, username, role::text, active, (pin_hash IS NOT NULL) AS has_pin, (password_hash IS NOT NULL) AS has_password, created_at, last_login_at, locked_until FROM users ORDER BY active DESC, role, name`);
  res.json({ data: rows });
});

const userBody = z.object({
  name: z.string().trim().min(1).max(80),
  username: z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{2,40}$/),
  role: z.string().regex(/^[A-Z_]{2,30}$/),
  pin: z.string().regex(/^\d{4,8}$/).optional(),
  password: z.string().min(8).max(200).optional(),
});

router.post('/users', requirePerm('users.manage'), async (req, res) => {
  const b = userBody.refine((u) => u.pin || u.password, 'Set a PIN or a password').parse(req.body);
  if (b.role === 'OWNER' && !can(req.user, '*')) throw forbidden('Only an owner can create owners');
  if (b.role === 'OWNER') await assertOwnerUsernameFree(b.username);
  if (b.pin) await assertPinUnique(b.pin);
  const row = await one(
    `INSERT INTO users (name, username, role, pin_hash, password_hash) VALUES ($1,$2,$3::role_name,$4,$5) RETURNING id, name, username, role::text, active`,
    [b.name, b.username, b.role, b.pin ? await bcrypt.hash(b.pin, 10) : null, b.password ? await bcrypt.hash(b.password, 10) : null],
  );
  await audit(actorOf(req), 'user.created', { entityType: 'user', entityId: row!.id, payload: { username: b.username, role: b.role } });
  res.status(201).json(row);
});

/** PIN-only login needs unique PINs; we check against all active users. */
async function assertPinUnique(pin: string, exceptId?: number) {
  const { rows } = await query<{ id: number; pin_hash: string }>('SELECT id, pin_hash FROM users WHERE active AND pin_hash IS NOT NULL');
  for (const r of rows) {
    if (r.id !== exceptId && (await bcrypt.compare(pin, r.pin_hash))) throw new ApiError(409, 'DUPLICATE', 'That PIN is already used by someone else', 'pin');
  }
}

router.patch('/users/:id', requirePerm('users.manage'), async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const b = userBody.partial().extend({ active: z.boolean().optional() }).parse(req.body);
  if (id === req.user!.id && (b.active === false || (b.role && b.role !== req.user!.role))) throw new ApiError(409, 'STATE_CONFLICT', 'You cannot disable or demote yourself');
  if (b.role === 'OWNER' && !can(req.user, '*')) throw forbidden('Only an owner can grant OWNER');
  if (b.username || b.role === 'OWNER') {
    const cur = await one<{ username: string; role: string }>('SELECT username, role::text FROM users WHERE id = $1', [id]);
    if (cur && (b.role ?? cur.role) === 'OWNER') await assertOwnerUsernameFree(b.username ?? cur.username, id);
  }
  if (b.pin) await assertPinUnique(b.pin, id);
  const row = await one(
    `UPDATE users SET name = COALESCE($2, name), username = COALESCE($3, username), role = COALESCE($4::role_name, role),
       pin_hash = COALESCE($5, pin_hash), password_hash = COALESCE($6, password_hash), active = COALESCE($7, active),
       failed_pin_attempts = 0, locked_until = NULL
     WHERE id = $1 RETURNING id, name, username, role::text, active`,
    [id, b.name ?? null, b.username ?? null, b.role ?? null, b.pin ? await bcrypt.hash(b.pin, 10) : null, b.password ? await bcrypt.hash(b.password, 10) : null, b.active ?? null],
  );
  if (!row) throw notFound('User not found');
  invalidateUser(id);
  await audit(actorOf(req), 'user.updated', { entityType: 'user', entityId: id, payload: { ...b, pin: b.pin ? 'changed' : undefined, password: b.password ? 'changed' : undefined } });
  res.json(row);
});

router.get('/roles', requirePerm('settings.read'), async (_req, res) => {
  const roles = (await query<{ r: string }>(`SELECT unnest(enum_range(NULL::role_name))::text AS r`)).rows.map((x) => x.r);
  const { rows } = await query<{ role: string; permission: string }>(`SELECT role::text, permission FROM role_permissions ORDER BY role, permission`);
  const matrix: Record<string, string[]> = Object.fromEntries(roles.map((r) => [r, []]));
  for (const r of rows) matrix[r.role]?.push(r.permission);
  res.json({ roles, permissions: ALL_PERMISSIONS, matrix });
});

router.put('/roles/:role', requirePerm('users.manage'), async (req, res) => {
  if (!can(req.user, '*')) throw forbidden('Only the owner can edit role permissions');
  const role = z.string().regex(/^[A-Z_]{2,30}$/).parse(req.params.role);
  if (role === 'OWNER') throw new ApiError(409, 'STATE_CONFLICT', 'OWNER always has every permission');
  const b = z.object({ permissions: z.array(z.enum(ALL_PERMISSIONS as [string, ...string[]])).max(ALL_PERMISSIONS.length) }).parse(req.body);
  await query('DELETE FROM role_permissions WHERE role = $1::role_name', [role]);
  if (b.permissions.length) await query('INSERT INTO role_permissions (role, permission) SELECT $1::role_name, unnest($2::text[])', [role, b.permissions]);
  invalidatePermissions();
  invalidateUser();
  await audit(actorOf(req), 'role.permissions_changed', { entityType: 'role', entityId: role, payload: { permissions: b.permissions } });
  res.json({ role, permissions: b.permissions });
});

// ------------------------------------------------------------------ about
router.get('/about', requirePerm('settings.read'), async (_req, res) => {
  const stats = await one(`SELECT
      pg_database_size(current_database()) AS db_bytes,
      (SELECT COUNT(*) FROM gift_cards)::int AS cards,
      (SELECT COUNT(*) FROM gift_cards WHERE archived_at IS NOT NULL)::int AS archived_cards,
      (SELECT COUNT(*) FROM gift_card_transactions)::int AS transactions,
      (SELECT COUNT(*) FROM audit_log)::int AS audit_events,
      (SELECT COUNT(*) FROM customers WHERE erased_at IS NULL)::int AS customers,
      (SELECT pg_total_relation_size('gift_card_transactions')) AS ledger_bytes,
      (SELECT pg_total_relation_size('audit_log')) AS audit_bytes,
      version() AS postgres`);
  res.json({ app: 'Gift Card POS', version: config.version, license: 'Proprietary — licensed to the business operating this installation', node: process.version, env: config.env, ...stats });
});
