/**
 * Zero-install Postgres for local dev (no Docker needed).
 * Starts PostgreSQL on port 5433 with data in api/.pgdata, creates the
 * `giftcard` database, applies schema + demo seed, and keeps running.
 *
 *   npm run db:embedded
 *   DATABASE_URL=postgres://postgres:postgres@localhost:5433/giftcard npm run dev
 */
import EmbeddedPostgres from 'embedded-postgres';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { migrate } from './migrate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(here, '..', '.pgdata');
const port = Number(process.env.EMBEDDED_PG_PORT ?? 5433);

const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'postgres',
  password: 'postgres',
  port,
  persistent: true,
  initdbFlags: ['--encoding=UTF8', '--locale=C'],
  onLog: () => {},
});

if (!existsSync(path.join(dataDir, 'PG_VERSION'))) await pg.initialise();
await pg.start();
try {
  await pg.createDatabase('giftcard');
} catch {
  /* already exists */
}
const url = `postgres://postgres:postgres@localhost:${port}/giftcard`;
await migrate(url);
console.log(`\n✓ Embedded Postgres ready: ${url}\n  Ctrl+C to stop.`);

const stop = async () => {
  await pg.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
