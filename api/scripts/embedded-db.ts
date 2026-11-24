/**
 * Zero-install Postgres for local dev (no Docker needed).
 * Starts PostgreSQL on port 5433 with data in api/.pgdata, creates the
 * `giftcard` database, applies schema + demo seed, and keeps running.
 *
 *   npm run db:embedded
 *   DATABASE_URL=postgres://giftcard:giftcard@localhost:5433/giftcard DEFAULT_BUSINESS=amazing-salon npm run dev
 */
import EmbeddedPostgres from 'embedded-postgres';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pgClient from 'pg';
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

// The app must NOT connect as the superuser: superusers bypass row-level
// security (the wall between salons). Create a normal owner role and hand it
// the database — including databases made by older versions as `postgres`.
const admin = new pgClient.Client({ connectionString: `postgres://postgres:postgres@localhost:${port}/postgres` });
await admin.connect();
try {
  if (!(await admin.query(`SELECT 1 FROM pg_roles WHERE rolname = 'giftcard'`)).rowCount) {
    await admin.query(`CREATE ROLE giftcard LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD 'giftcard'`);
  }
  const db = await admin.query(`SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = 'giftcard'`);
  if (!db.rowCount) await admin.query(`CREATE DATABASE giftcard OWNER giftcard`);
  else if (db.rows[0].owner !== 'giftcard') {
    console.log('→ moving database ownership to role "giftcard"');
    await admin.query(`ALTER DATABASE giftcard OWNER TO giftcard`);
    const g = new pgClient.Client({ connectionString: `postgres://postgres:postgres@localhost:${port}/giftcard` });
    await g.connect();
    await g.query(`DO $$ DECLARE r RECORD; BEGIN
      FOR r IN SELECT format('ALTER TABLE public.%I OWNER TO giftcard', tablename) AS q FROM pg_tables WHERE schemaname = 'public'
         UNION ALL SELECT format('ALTER VIEW public.%I OWNER TO giftcard', viewname) FROM pg_views WHERE schemaname = 'public'
         UNION ALL SELECT format('ALTER SEQUENCE public.%I OWNER TO giftcard', c.relname) FROM pg_class c
                   JOIN pg_namespace n ON n.oid = c.relnamespace
                   WHERE n.nspname = 'public' AND c.relkind = 'S' AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype IN ('a','i'))
         UNION ALL SELECT format('ALTER FUNCTION %s OWNER TO giftcard', p.oid::regprocedure) FROM pg_proc p
                   JOIN pg_namespace n ON n.oid = p.pronamespace
                   WHERE n.nspname = 'public' AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
         UNION ALL SELECT format('ALTER TYPE public.%I OWNER TO giftcard', t.typname) FROM pg_type t
                   JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typtype = 'e'
      LOOP EXECUTE r.q; END LOOP; END $$`);
    await g.end();
  }
} finally {
  await admin.end();
}

const url = `postgres://giftcard:giftcard@localhost:${port}/giftcard`;
await migrate(url);
console.log(`\n✓ Embedded Postgres ready: ${url}\n  Ctrl+C to stop.`);

const stop = async () => {
  await pg.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
