import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const bool = (v: string | undefined, d: boolean) => (v === undefined ? d : /^(1|true|yes|on)$/i.test(v));
const int = (v: string | undefined, d: number) => (v === undefined || v === '' ? d : Number.parseInt(v, 10));

const here = path.dirname(fileURLToPath(import.meta.url));
// src/ (tsx) or dist/src/ (compiled) — walk up to the api/ package root
export const API_ROOT = here.includes(`${path.sep}dist${path.sep}`) ? path.resolve(here, '..', '..') : path.resolve(here, '..');

function readVersion(): string {
  try {
    return JSON.parse(readFileSync(path.join(API_ROOT, 'package.json'), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
}

const nodeEnv = process.env.NODE_ENV ?? 'development';

export const config = {
  env: nodeEnv,
  version: readVersion(),
  port: int(process.env.PORT, 4000),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/giftcard',
  jwtSecret: process.env.JWT_SECRET ?? (nodeEnv === 'production' ? '' : 'dev-only-insecure-jwt-secret-change-me'),
  qrSecret: process.env.QR_SECRET ?? process.env.JWT_SECRET ?? 'dev-only-qr-secret',
  requireTerminalKey: bool(process.env.REQUIRE_TERMINAL_KEY, nodeEnv === 'production'),
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:5173').split(',').map((s) => s.trim()).filter(Boolean),
  publicUrl: process.env.PUBLIC_URL ?? 'http://localhost:5173',
  jobsEnabled: bool(process.env.JOBS_ENABLED, true),
  kioskRatePerMin: int(process.env.KIOSK_RATE_PER_MIN, 5),
  gatewayMode: (process.env.GATEWAY_MODE ?? 'sandbox') as 'sandbox' | 'disabled',
  backupDir: process.env.BACKUP_DIR ?? path.join(API_ROOT, 'backups'),
  trustProxy: process.env.TRUST_PROXY ?? 'loopback',
  /** Salon ID used when a request names none (single-salon installs, dev, tests). */
  defaultBusiness: (process.env.DEFAULT_BUSINESS ?? '').trim().toLowerCase(),
  /** Public self-service salon sign-up (POST /signup). */
  signupEnabled: bool(process.env.SIGNUP_ENABLED, true),
  signupPerHour: int(process.env.SIGNUP_PER_HOUR, 5),
  /** Platform admin (/platform). Empty = platform admin disabled. */
  platformAdminPassword: process.env.PLATFORM_ADMIN_PASSWORD ?? '',
  twilio: {
    sid: process.env.TWILIO_ACCOUNT_SID ?? '',
    token: process.env.TWILIO_AUTH_TOKEN ?? '',
  },
  sendgridKey: process.env.SENDGRID_API_KEY ?? '',
};

if (!config.jwtSecret) {
  throw new Error('JWT_SECRET must be set in production');
}
