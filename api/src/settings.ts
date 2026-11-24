import { z } from 'zod';
import { currentBusinessId, query, type Db, pool } from './db.js';

const cents = z.number().int().min(0).max(100_000_000);

export const settingSchemas = {
  general: z.object({
    business_name: z.string().min(1).max(80),
    address: z.string().max(200).default(''),
    phone: z.string().max(30).default(''),
    logo_url: z.string().max(500).default(''),
    timezone: z.string().min(1).max(60),
    currency: z.enum(['USD', 'CAD', 'EUR', 'GBP', 'AUD']),
    tax_rate_bps: z.number().int().min(0).max(5000),
    tax_on_card_sale: z.boolean().default(false),
  }),
  receipt: z.object({
    header: z.string().max(400),
    footer: z.string().max(400),
    show_balance_after: z.boolean(),
    show_terms: z.boolean(),
    terms: z.string().max(1000).default(''),
    show_barcode: z.boolean(),
  }),
  printer: z.object({
    mode: z.enum(['browser', 'network', 'disabled']),
    host: z.string().max(100).default(''),
    port: z.number().int().min(1).max(65535).default(9100),
    paper_width_mm: z.union([z.literal(58), z.literal(80)]),
    auto_print: z.object({ issue: z.boolean(), redeem: z.boolean(), reload: z.boolean(), refund: z.boolean() }),
    copies: z.number().int().min(1).max(3).default(1),
  }),
  messaging: z.object({
    email_provider: z.enum(['log', 'sendgrid']),
    sms_provider: z.enum(['log', 'twilio']),
    from_email: z.string().max(120).default(''),
    from_sms: z.string().max(30).default(''),
    low_balance_threshold_cents: cents,
    expiry_warning_days: z.array(z.number().int().min(1).max(90)).max(5),
    send_low_balance: z.boolean(),
    send_reload_thanks: z.boolean(),
  }),
  terminal: z.object({
    gateway: z.enum(['stub', 'stripe', 'square']),
    gateway_public_key: z.string().max(200).default(''),
    gateway_mode: z.enum(['sandbox', 'live']),
  }),
  security: z.object({
    session_timeout_min: z.number().int().min(5).max(1440),
    activity_lock_min: z.number().int().min(0).max(120),
    approval_threshold_cents: cents,
    dual_control_refunds: z.boolean(),
    dual_control_voids: z.boolean(),
    pin_max_attempts: z.number().int().min(3).max(20),
    pin_lockout_min: z.number().int().min(1).max(1440),
    undo_window_sec: z.number().int().min(0).max(120),
    offline_max_redeem_cents: cents,
  }),
  loyalty: z.object({
    enabled: z.boolean(),
    points_per_dollar: z.number().int().min(0).max(100),
  }),
} as const;

export type SettingKey = keyof typeof settingSchemas;
export type Settings = { [K in SettingKey]: z.infer<(typeof settingSchemas)[K]> };

export const DEFAULTS: Settings = {
  general: { business_name: 'Amazing Salon', address: '', phone: '', logo_url: '', timezone: 'America/Chicago', currency: 'USD', tax_rate_bps: 0, tax_on_card_sale: false },
  receipt: { header: 'Amazing Salon', footer: 'Gift cards are not redeemable for cash.', show_balance_after: true, show_terms: true, terms: '', show_barcode: true },
  printer: { mode: 'browser', host: '', port: 9100, paper_width_mm: 80, auto_print: { issue: true, redeem: true, reload: true, refund: false }, copies: 1 },
  messaging: { email_provider: 'log', sms_provider: 'log', from_email: '', from_sms: '', low_balance_threshold_cents: 1000, expiry_warning_days: [7, 3, 1], send_low_balance: true, send_reload_thanks: true },
  terminal: { gateway: 'stub', gateway_public_key: '', gateway_mode: 'sandbox' },
  security: { session_timeout_min: 480, activity_lock_min: 5, approval_threshold_cents: 50000, dual_control_refunds: true, dual_control_voids: true, pin_max_attempts: 5, pin_lockout_min: 15, undo_window_sec: 10, offline_max_redeem_cents: 10000 },
  loyalty: { enabled: false, points_per_dollar: 1 },
};

export const isSettingKey = (k: string): k is SettingKey => k in settingSchemas;

const caches = new Map<number, { at: number; values: Settings }>();
const TTL_MS = 5_000;

export function invalidateSettings() {
  const bid = currentBusinessId();
  if (bid === null) caches.clear();
  else caches.delete(bid);
}

export async function getAllSettings(db: Db = pool): Promise<Settings> {
  const bid = currentBusinessId() ?? 0;
  const cache = caches.get(bid);
  if (cache && Date.now() - cache.at < TTL_MS) return cache.values;
  const { rows } = await query<{ key: string; value: any }>('SELECT key, value FROM settings', [], db);
  const values = structuredClone(DEFAULTS) as Settings;
  for (const r of rows) {
    if (!isSettingKey(r.key)) continue;
    const v = { ...r.value };
    // Receipts switched from QR to Code 128: carry the old toggle over.
    if (r.key === 'receipt' && 'show_qr' in v) {
      v.show_barcode ??= v.show_qr;
      delete v.show_qr;
    }
    (values as any)[r.key] = { ...(DEFAULTS as any)[r.key], ...v };
  }
  if (bid) caches.set(bid, { at: Date.now(), values });
  return values;
}

export async function getSetting<K extends SettingKey>(key: K, db: Db = pool): Promise<Settings[K]> {
  return (await getAllSettings(db))[key];
}
