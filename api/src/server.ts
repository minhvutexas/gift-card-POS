import { createApp } from './app.js';
import { config } from './config.js';
import { pool } from './db.js';
import { startListener, stopListener } from './events.js';
import { startScheduler } from './jobs.js';

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
