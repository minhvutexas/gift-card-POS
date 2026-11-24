import { createApp } from './app.js';
import { config } from './config.js';
import { one, pool } from './db.js';
import { startListener, stopListener } from './events.js';
import { startScheduler } from './jobs.js';

// Row-level security is the salon wall. Superusers and BYPASSRLS roles walk
// straight through it, so the API must never run as one.
const role = await one<{ name: string; bypass: boolean }>(
  'SELECT current_user AS name, (rolsuper OR rolbypassrls) AS bypass FROM pg_roles WHERE rolname = current_user',
);
if (role?.bypass) {
  const msg = `DB role "${role.name}" bypasses row-level security — salons would see each other's data.`;
  if (config.env === 'production') throw new Error(`${msg} Connect as the non-superuser owner role.`);
  console.warn(`  ⚠ ${msg} OK for local dev only.`);
}

const app = createApp();
await startListener();
const task = config.jobsEnabled ? await startScheduler() : null;

const server = app.listen(config.port, () => {
  console.info(`Gift Card POS API v${config.version} listening on :${config.port} (${config.env})`);
  console.info(`  docs:   http://localhost:${config.port}/api/docs`);
  if (!config.requireTerminalKey) console.warn('  ⚠ REQUIRE_TERMINAL_KEY is off — any device can reach the staff API after login');
});

async function shutdown(signal: string) {
  console.info(`${signal} received, shutting down…`);
  task?.stop();
  server.close();
  await stopListener();
  await pool.end();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
