/**
 * Applies db/schema.sql (idempotent) and then any db/migrations/NNN_*.sql
 * files that are not yet recorded in schema_migrations.
 *
 *   npm run db:migrate                 # schema + migrations + demo seed
 *   SKIP_DEMO_SEED=true npm run db:migrate
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));

export function findDbDir(): string {
  const candidates = [
    process.env.DB_DIR,
    path.resolve(here, '..', '..', 'db'), // repo layout: api/scripts → db
    path.resolve(here, '..', '..', '..', 'db'), // compiled: api/dist/scripts → db
    path.resolve(here, '..', 'db'), // docker image: /app/db
    path.resolve(here, '..', '..', 'db'),
  ].filter(Boolean) as string[];
  const hit = candidates.find((d) => existsSync(path.join(d, 'schema.sql')));
  if (!hit) throw new Error(`schema.sql not found (looked in ${candidates.join(', ')})`);
  return hit;
}

export async function migrate(databaseUrl: string, opts: { skipDemoSeed?: boolean; quiet?: boolean } = {}) {
  const dbDir = findDbDir();
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const log = (m: string) => !opts.quiet && console.log(m);
  try {
    if (opts.skipDemoSeed) await client.query(`SET gc.skip_demo_seed = 'on'`);
    log(`→ applying ${path.join(dbDir, 'schema.sql')}`);
    await client.query(readFileSync(path.join(dbDir, 'schema.sql'), 'utf8'));

    const migDir = path.join(dbDir, 'migrations');
    if (existsSync(migDir)) {
      const files = readdirSync(migDir).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
      for (const f of files) {
        const { rowCount } = await client.query('SELECT 1 FROM schema_migrations WHERE version = $1', [f]);
        if (rowCount) continue;
        log(`→ migration ${f}`);
        await client.query('BEGIN');
        try {
          await client.query(readFileSync(path.join(migDir, f), 'utf8'));
          await client.query('INSERT INTO schema_migrations(version) VALUES ($1)', [f]);
          await client.query('COMMIT');
        } catch (e) {
          await client.query('ROLLBACK');
          throw e;
        }
      }
    }
    log('✓ database is up to date');
  } finally {
    await client.end();
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const url = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/giftcard';
  migrate(url, { skipDemoSeed: /^(1|true)$/i.test(process.env.SKIP_DEMO_SEED ?? '') }).catch((e) => {
    console.error('✗ migration failed:', e.message);
    process.exit(1);
  });
}
