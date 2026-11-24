/**
 * Boots a throwaway PostgreSQL (embedded binaries — no Docker needed),
 * applies db/schema.sql incl. demo seed, and exposes DATABASE_URL to tests.
 * Set TEST_DATABASE_URL to run against an existing empty database instead.
 */
import EmbeddedPostgres from 'embedded-postgres';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { migrate } from '../scripts/migrate.js';

let pg: EmbeddedPostgres | null = null;
let dir = '';

export async function setup() {
  if (process.env.TEST_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  } else {
    dir = mkdtempSync(path.join(tmpdir(), 'gcpos-test-'));
    const port = 55000 + Math.floor(Math.random() * 2000);
    pg = new EmbeddedPostgres({ databaseDir: dir, port, user: 'postgres', password: 'postgres', persistent: true, initdbFlags: ['--encoding=UTF8', '--locale=C'], onLog: () => {} });
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('giftcard_test');
    process.env.DATABASE_URL = `postgres://postgres:postgres@localhost:${port}/giftcard_test`;
  }
  await migrate(process.env.DATABASE_URL!, { quiet: true });
  // Idempotency of the schema itself: applying twice must be a no-op.
  await migrate(process.env.DATABASE_URL!, { quiet: true });
}

export async function teardown() {
  if (pg) {
    await pg.stop();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows may hold file locks briefly */
    }
  }
}
