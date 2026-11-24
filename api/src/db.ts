import pg from 'pg';
import { config } from './config.js';

// int8 → JS number (safe: cents and ids stay far below 2^53)
pg.types.setTypeParser(20, (v) => Number.parseInt(v, 10));

export let pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

/** Tests swap the pool to point at their embedded database. */
export function setPool(p: pg.Pool) {
  pool = p;
}

export type Db = pg.PoolClient | pg.Pool;

export async function query<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = [], db: Db = pool) {
  return db.query<T>(text, params as any[]);
}

export async function one<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = [], db: Db = pool) {
  const r = await db.query<T>(text, params as any[]);
  return r.rows[0] as T | undefined;
}

const RETRYABLE = new Set(['40001', '40P01']); // serialization_failure, deadlock_detected

/**
 * Runs `fn` in a SERIALIZABLE transaction and retries on serialization
 * failures / deadlocks. All balance-changing work goes through here.
 */
export async function withTx<T>(fn: (c: pg.PoolClient) => Promise<T>, opts: { retries?: number; isolation?: string } = {}): Promise<T> {
  const retries = opts.retries ?? 5;
  const isolation = opts.isolation ?? 'SERIALIZABLE';
  for (let attempt = 0; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      if (RETRYABLE.has(err?.code) && attempt < retries) {
        await new Promise((r) => setTimeout(r, 15 * 2 ** attempt + Math.random() * 20));
        continue;
      }
      throw err;
    } finally {
      client.release();
    }
  }
}
