import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';
import { config } from './config.js';

// int8 → JS number (safe: cents and ids stay far below 2^53)
pg.types.setTypeParser(20, (v) => Number.parseInt(v, 10));

// ---------------------------------------------------------------- tenant context
/**
 * Which salon the current request acts for. Every connection handed out by
 * `pool` first runs `set_config('app.business_id', …)`, and Postgres row-level
 * security (FORCE'd on every salon table) hides all other salons' rows.
 * `system` is for the few platform paths (signup, terminal-key lookup,
 * platform admin) and must never be set for a salon request.
 */
export interface TenantContext {
  businessId: number | null;
  system?: boolean;
}

const tenantStore = new AsyncLocalStorage<TenantContext>();
let testFallback: TenantContext | null = null;

export const currentTenant = (): TenantContext | null => tenantStore.getStore() ?? testFallback;
export const currentBusinessId = (): number | null => currentTenant()?.businessId ?? null;

export function runAsBusiness<T>(businessId: number, fn: () => T): T {
  return tenantStore.run({ businessId }, fn);
}

export function runAsSystem<T>(fn: () => T): T {
  return tenantStore.run({ businessId: null, system: true }, fn);
}

/** Tests only: default salon for code that runs outside a request. */
export function setTestTenant(businessId: number | null) {
  if (config.env !== 'test') throw new Error('setTestTenant is only for tests');
  testFallback = businessId === null ? null : { businessId };
}

const applied = new WeakMap<pg.PoolClient, string>();

async function applyTenant(c: pg.PoolClient) {
  const ctx = currentTenant();
  const bid = ctx?.businessId != null ? String(ctx.businessId) : '';
  const sys = ctx?.system ? 'on' : '';
  const sig = `${bid}|${sys}`;
  if (applied.get(c) === sig) return;
  await c.query(`SELECT set_config('app.business_id', $1, false), set_config('app.system', $2, false)`, [bid, sys]);
  applied.set(c, sig);
}

/** pg.Pool wrapper: every checkout is pinned to the caller's salon. */
export class TenantPool {
  constructor(readonly raw: pg.Pool) {}

  async connect(): Promise<pg.PoolClient> {
    const c = await this.raw.connect();
    try {
      await applyTenant(c);
    } catch (e) {
      applied.delete(c);
      c.release(e as Error);
      throw e;
    }
    return c;
  }

  async query<T extends pg.QueryResultRow = any>(text: string, params?: unknown[]): Promise<pg.QueryResult<T>> {
    const c = await this.connect();
    try {
      return await c.query<T>(text, params as any[]);
    } finally {
      c.release();
    }
  }

  end() {
    return this.raw.end();
  }
}

export let pool = new TenantPool(new pg.Pool({ connectionString: config.databaseUrl, max: 10 }));

/** Tests swap the pool to point at their embedded database. */
export function setPool(p: pg.Pool) {
  pool = new TenantPool(p);
}

export type Db = pg.PoolClient | TenantPool;

const run = <T extends pg.QueryResultRow>(db: Db, text: string, params: unknown[]): Promise<pg.QueryResult<T>> =>
  db instanceof TenantPool ? db.query<T>(text, params) : db.query<T>(text, params as any[]);

export async function query<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = [], db: Db = pool) {
  return run<T>(db, text, params);
}

export async function one<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = [], db: Db = pool) {
  const r = await run<T>(db, text, params);
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
