import { Router } from 'express';
import { z } from 'zod';
import { actorOf, requirePerm } from '../auth.js';
import { audit } from '../audit.js';
import { one, query } from '../db.js';
import { historyPdf } from '../services/pdf.js';
import { centsToDecimal, toCsv } from '../util/csv.js';

export const router = Router();

const filters = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  actor_id: z.coerce.number().int().positive().optional(),
  actor_type: z.enum(['USER', 'KIOSK', 'GATEWAY', 'SYSTEM', 'IMPORT']).optional(),
  action: z.string().max(200).optional(), // comma-separated: REDEEM,RELOAD,card.frozen
  card: z.string().max(20).optional(), // card number (exact) or id
  card_id: z.coerce.number().int().positive().optional(),
  kind: z.enum(['TXN', 'AUDIT']).optional(),
  q: z.string().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(500).default(100),
});

function build(p: z.infer<typeof filters>) {
  const where: string[] = ['TRUE'];
  const params: unknown[] = [];
  const add = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (p.from) where.push(`h.occurred_at >= ${add(p.from)}`);
  if (p.to) where.push(`h.occurred_at < ${add(p.to)}`);
  if (p.actor_id) where.push(`h.actor_id = ${add(p.actor_id)}`);
  if (p.actor_type) where.push(`h.actor_type = ${add(p.actor_type)}::actor_type`);
  if (p.kind) where.push(`h.kind = ${add(p.kind)}`);
  if (p.action) where.push(`h.action = ANY(${add(p.action.split(',').map((s) => s.trim()).filter(Boolean))})`);
  if (p.card_id) where.push(`h.card_id = ${add(p.card_id)}`);
  if (p.card) where.push(`h.card_number = upper(${add(p.card.trim())})`);
  if (p.q) {
    const like = add(`%${p.q}%`);
    where.push(`(h.note ILIKE ${like} OR h.reference ILIKE ${like} OR h.card_number ILIKE ${like} OR h.actor_name ILIKE ${like})`);
  }
  return { where: where.join(' AND '), params };
}

const SELECT = `SELECT h.id, h.kind, h.occurred_at, h.actor_type::text AS actor_type, h.actor_id, h.actor_name, h.card_id, h.card_number,
  h.action, (h.amount * 100)::bigint AS amount_cents, (h.balance_after * 100)::bigint AS balance_after_cents, h.reference,
  h.terminal_id, h.terminal_code, host(h.ip) AS ip, h.note FROM v_history h`;

router.get('/history', requirePerm('history.read'), async (req, res) => {
  const p = filters.parse(req.query);
  const { where, params } = build(p);
  const [rows, count] = await Promise.all([
    query(`${SELECT} WHERE ${where} ORDER BY h.occurred_at DESC, h.id DESC LIMIT ${p.per_page} OFFSET ${(p.page - 1) * p.per_page}`, params),
    one<{ n: number }>(`SELECT COUNT(*)::int AS n FROM v_history h WHERE ${where}`, params),
  ]);
  res.json({ data: rows.rows, meta: { page: p.page, per_page: p.per_page, total: count?.n ?? 0 } });
});

router.get('/history/actions', requirePerm('history.read'), async (_req, res) => {
  const { rows } = await query(`SELECT DISTINCT action FROM v_history ORDER BY action`);
  res.json({ data: rows.map((r) => r.action) });
});

async function exportRows(q: unknown) {
  const p = filters.parse(q);
  const { where, params } = build(p);
  const { rows } = await query(`${SELECT} WHERE ${where} ORDER BY h.occurred_at DESC, h.id DESC LIMIT 50000`, params);
  return { rows, p };
}

router.get('/history/export.csv', requirePerm('history.export'), async (req, res) => {
  const { rows, p } = await exportRows(req.query);
  await audit(actorOf(req), 'history.exported', { payload: { format: 'csv', count: rows.length, filters: p } });
  res
    .type('text/csv')
    .attachment(`history-${new Date().toISOString().slice(0, 10)}.csv`)
    .send(
      toCsv(
        ['id', 'kind', 'occurred_at', 'actor_type', 'actor', 'card_number', 'action', 'amount', 'balance_after', 'reference', 'terminal', 'ip', 'note'],
        rows.map((r) => [r.id, r.kind, r.occurred_at, r.actor_type, r.actor_name, r.card_number, r.action, centsToDecimal(r.amount_cents), centsToDecimal(r.balance_after_cents), r.reference, r.terminal_code, r.ip, r.note]),
      ),
    );
});

router.get('/history/export.pdf', requirePerm('history.export'), async (req, res) => {
  const { rows, p } = await exportRows(req.query);
  const capped = rows.slice(0, 5000);
  await audit(actorOf(req), 'history.exported', { payload: { format: 'pdf', count: capped.length, filters: p } });
  const pdf = await historyPdf(capped, 'History log');
  res.type('application/pdf').setHeader('Content-Disposition', `attachment; filename="history-${new Date().toISOString().slice(0, 10)}.pdf"`);
  res.send(pdf);
});
