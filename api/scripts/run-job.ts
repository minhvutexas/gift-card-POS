/** Run a scheduled job once (cron/Task Scheduler alternative): npm run jobs:expire */
import { runExpiry, runNightly } from '../src/jobs.js';
import { pool } from '../src/db.js';

const job = process.argv[2] ?? 'nightly';
try {
  const out = job === 'expire' ? { expired: await runExpiry() } : await runNightly();
  console.log(`✓ ${job}`, out);
} finally {
  await pool.end();
}
