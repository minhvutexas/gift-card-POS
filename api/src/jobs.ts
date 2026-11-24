import cron from 'node-cron';
import { currentBusinessId, one, pool, query, runAsBusiness, runAsSystem } from './db.js';
import { getAllSettings } from './settings.js';
import { purgeIdempotencyKeys } from './idempotency.js';
import { sendExpiryWarnings } from './services/messaging.js';
import { getCard } from './services/cards.js';

/** Expire due cards (EXPIRE txn → breakage). Idempotent: keys are "expire:<id>". */
export async function runExpiry() {
  const r = await one<{ n: number }>('SELECT fn_expire_due_cards() AS n');
  return r?.n ?? 0;
}

/** Active salons (or just the current one when called inside a salon). */
async function salonIds(): Promise<number[]> {
  const bid = currentBusinessId();
  if (bid !== null) return [bid];
  const { rows } = await runAsSystem(() => query<{ id: number }>(`SELECT id FROM businesses WHERE status = 'ACTIVE' ORDER BY id`));
  return rows.map((r) => r.id);
}

export async function runNightly() {
  // fn_expire_due_cards walks every salon itself when none is set.
  const expired = await runExpiry();
  let warned = 0;
  for (const bid of await salonIds()) {
    await runAsBusiness(bid, async () => {
      try {
        warned += await sendExpiryWarnings((id) => getCard(id));
        await purgeIdempotencyKeys();
      } catch (e) {
        console.error(`[jobs] nightly failed for salon ${bid}`, e);
      }
    });
  }
  console.info(`[jobs] nightly: expired=${expired} expiry_warnings=${warned}`);
  return { expired, warned };
}

/**
 * App-side scheduler (used when pg_cron isn't installed). Safe to run on
 * several API instances: fn_expire_due_cards is idempotent per card and
 * guarded by pg_try_advisory_lock so only one instance does the work.
 */
export async function startScheduler() {
  const tz = (await getAllSettings()).general.timezone;
  const task = cron.schedule(
    '5 0 * * *',
    async () => {
      // Session-level advisory lock must be taken and released on the same connection.
      const conn = await pool.connect();
      try {
        const lock = await one<{ ok: boolean }>('SELECT pg_try_advisory_lock(424242) AS ok', [], conn);
        if (!lock?.ok) return;
        try {
          await runNightly();
        } finally {
          await one('SELECT pg_advisory_unlock(424242)', [], conn);
        }
      } catch (e) {
        console.error('[jobs] nightly failed', e);
      } finally {
        conn.release();
      }
    },
    { timezone: tz },
  );
  // Catch up at boot in case the server was off at midnight.
  runExpiry().catch((e) => console.error('[jobs] boot expiry failed', e.message));
  return task;
}
