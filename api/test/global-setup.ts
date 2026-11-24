/**
 * Boots a throwaway PostgreSQL (embedded binaries — no Docker needed), or uses
 * TEST_DATABASE_URL (a superuser/admin connection to an existing server).
 *
 * Either way the tests run as a NON-superuser that owns a fresh database —
 * exactly like production. Superusers bypass row-level security, so testing
 * as one would hide every salon-isolation bug.
 */
import EmbeddedPostgres from 'embedded-postgres';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { migrate } from '../scripts/migrate.js';

let pg_: EmbeddedPostgres | null = null;
let dir = '';
let adminUrl = '';
let dbName = '';

const ROLE = 'giftcard_test';
const PASSWORD = 'giftcard_test';

export async function setup() {
  if (process.env.TEST_DATABASE_URL) {
    adminUrl = process.env.TEST_DATABASE_URL;
  } else {
    dir = mkdtempSync(path.join(tmpdir(), 'gcpos-test-'));
    const port = 55000 + Math.floor(Math.random() * 2000);
    pg_ = new EmbeddedPostgres({ databaseDir: dir, port, user: 'postgres', password: 'postgres', persistent: true, initdbFlags: ['--encoding=UTF8', '--locale=C'], onLog: () => {} });
    await pg_.initialise();
    await pg_.start();
    adminUrl = `postgres://postgres:postgres@localhost:${port}/postgres`;
  }

  dbName = `giftcard_test_${Date.now().toString(36)}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    const exists = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [ROLE]);
    if (!exists.rowCount) await admin.query(`CREATE ROLE ${ROLE} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${PASSWORD}'`);
    await admin.query(`CREATE DATABASE ${dbName} OWNER ${ROLE}`);
  } finally {
    await admin.end();
  }

  const u = new URL(adminUrl);
  u.username = ROLE;
  u.password = PASSWORD;
  u.pathname = `/${dbName}`;
  process.env.DATABASE_URL = u.toString();

  await migrate(process.env.DATABASE_URL, { quiet: true });
  // Idempotency of the schema itself: applying twice must be a no-op.
  await migrate(process.env.DATABASE_URL, { quiet: true });
}

export async function teardown() {
  if (!pg_ && adminUrl && dbName) {
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {});
    await admin.end().catch(() => {});
  }
  if (pg_) {
    await pg_.stop();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows may hold file locks briefly */
    }
  }
}
