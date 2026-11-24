import type { Request, Response } from 'express';
import pg from 'pg';
import { config } from './config.js';

/**
 * Real-time fan-out: Postgres NOTIFY (from fn_apply_txn / fn_set_frozen) →
 * this process → Server-Sent Events to every connected terminal. Works with
 * several API instances because each one LISTENs independently.
 */
const clients = new Set<Response>();
let listener: pg.Client | null = null;

export function broadcast(event: Record<string, unknown>) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) res.write(data);
}

export async function startListener(connectionString = config.databaseUrl) {
  if (listener) return;
  const c = new pg.Client({ connectionString });
  c.on('notification', (msg) => {
    if (!msg.payload) return;
    try {
      broadcast(JSON.parse(msg.payload));
    } catch {
      /* ignore malformed */
    }
  });
  c.on('error', (e) => {
    console.error('LISTEN connection lost, reconnecting in 5s', e.message);
    listener = null;
    setTimeout(() => startListener(connectionString).catch(() => {}), 5000);
  });
  await c.connect();
  await c.query('LISTEN gc_events');
  listener = c;
}

export async function stopListener() {
  await listener?.end().catch(() => {});
  listener = null;
  for (const res of clients) res.end();
  clients.clear();
}

export function sseHandler(req: Request, res: Response) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`retry: 3000\ndata: ${JSON.stringify({ type: 'hello', at: new Date().toISOString() })}\n\n`);
  clients.add(res);
  const ping = setInterval(() => res.write(`: ping\n\n`), 25_000);
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(res);
  });
}
