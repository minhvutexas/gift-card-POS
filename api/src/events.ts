import type { Request, Response } from 'express';
import pg from 'pg';
import { config } from './config.js';

/**
 * Real-time fan-out: Postgres NOTIFY (from fn_apply_txn / fn_set_frozen) →
 * this process → Server-Sent Events to every connected terminal. Works with
 * several API instances because each one LISTENs independently.
 */
const clients = new Map<Response, number>(); // response → salon id
let listener: pg.Client | null = null;

/** Events go only to terminals of the salon that produced them. */
export function broadcast(event: Record<string, unknown>) {
  const { business_id, ...rest } = event;
  if (typeof business_id !== 'number') return;
  const data = `data: ${JSON.stringify(rest)}\n\n`;
  for (const [res, bid] of clients) if (bid === business_id) res.write(data);
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
  for (const res of clients.keys()) res.end();
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
  if (!req.business) {
    res.end();
    return;
  }
  clients.set(res, req.business.id);
  const ping = setInterval(() => res.write(`: ping\n\n`), 25_000);
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(res);
  });
}
