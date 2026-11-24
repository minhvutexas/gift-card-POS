import { Router } from 'express';
import { z } from 'zod';
import { actorOf, requireApproval, requirePerm } from '../auth.js';
import { audit } from '../audit.js';
import { one, query } from '../db.js';
import { ApiError, notFound } from '../errors.js';
import type { Actor } from '../types.js';

export const router = Router();

const normPhone = (p: string) => {
  const d = p.replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  return d ? `+${d}` : '';
};

export const customerInput = z
  .object({
    first_name: z.string().trim().max(60).optional().nullable(),
    last_name: z.string().trim().max(60).optional().nullable(),
    phone: z
      .string()
      .trim()
      .max(25)
      .optional()
      .nullable()
      .transform((v) => (v ? normPhone(v) || null : null))
      .refine((v) => !v || /^\+\d{7,15}$/.test(v), 'Enter a valid phone number'),
    email: z
      .string()
      .trim()
      .toLowerCase()
      .max(120)
      .optional()
      .nullable()
      .transform((v) => v || null)
      .refine((v) => !v || z.string().email().safeParse(v).success, 'Enter a valid email'),
    marketing_opt_in: z.boolean().optional(),
    notes: z.string().max(1000).optional().nullable(),
  })
  .refine((c) => c.first_name || c.last_name || c.phone || c.email, 'Enter at least a name, phone or email');

export type CustomerInput = z.infer<typeof customerInput>;

/** Reuse an existing customer when phone or email matches (dedupe at the desk). */
export async function findOrCreateCustomer(actor: Actor, c: CustomerInput): Promise<number> {
  if (c.phone || c.email) {
    const hit = await one<{ id: number }>(
      `SELECT id FROM customers WHERE erased_at IS NULL AND ((phone IS NOT NULL AND phone = $1) OR (email IS NOT NULL AND lower(email) = $2)) ORDER BY id LIMIT 1`,
      [c.phone, c.email],
    );
    if (hit) return hit.id;
  }
  const row = await one<{ id: number }>(
    `INSERT INTO customers (first_name, last_name, phone, email, marketing_opt_in, notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [c.first_name || null, c.last_name || null, c.phone, c.email, c.marketing_opt_in ?? false, c.notes ?? null],
  );
  await audit(actor, 'customer.created', { entityType: 'customer', entityId: row!.id });
  return row!.id;
}

const CUSTOMER_SELECT = `
SELECT cu.id, cu.first_name, cu.last_name, cu.phone, cu.email, cu.marketing_opt_in, cu.loyalty_points, cu.notes,
       cu.created_at, cu.erased_at,
       COUNT(c.id) FILTER (WHERE c.deleted_at IS NULL)::int AS card_count,
       (COALESCE(SUM(c.balance) FILTER (WHERE c.status IN ('ACTIVE','PARTIALUSED') AND c.deleted_at IS NULL), 0) * 100)::bigint AS balance_cents
FROM customers cu LEFT JOIN gift_cards c ON c.customer_id = cu.id`;

router.get('/customers', requirePerm('customers.read'), async (req, res) => {
  const p = z
    .object({ q: z.string().max(100).optional(), page: z.coerce.number().int().min(1).default(1), per_page: z.coerce.number().int().min(1).max(200).default(50) })
    .parse(req.query);
  const params: unknown[] = [];
  let where = 'cu.erased_at IS NULL';
  if (p.q?.trim()) {
    params.push(`%${p.q.trim()}%`);
    const digits = p.q.replace(/\D/g, '');
    where += ` AND ((COALESCE(cu.first_name,'') || ' ' || COALESCE(cu.last_name,'')) ILIKE $1 OR cu.email ILIKE $1 OR cu.phone ILIKE $1`;
    if (digits.length >= 3) {
      params.push(`%${digits}%`);
      where += ` OR regexp_replace(COALESCE(cu.phone,''), '\\D', '', 'g') LIKE $2`;
    }
    where += ')';
  }
  const { rows } = await query(
    `${CUSTOMER_SELECT} WHERE ${where} GROUP BY cu.id ORDER BY cu.last_name NULLS LAST, cu.first_name, cu.id LIMIT ${p.per_page} OFFSET ${(p.page - 1) * p.per_page}`,
    params,
  );
  const total = await one<{ n: number }>(`SELECT COUNT(*)::int AS n FROM customers cu WHERE ${where}`, params);
  res.json({ data: rows, meta: { page: p.page, per_page: p.per_page, total: total?.n ?? 0 } });
});

router.post('/customers', requirePerm('customers.write'), async (req, res) => {
  const b = customerInput.parse(req.body);
  const actor = actorOf(req);
  if (b.phone) {
    const dup = await one('SELECT id FROM customers WHERE phone = $1', [b.phone]);
    if (dup) throw new ApiError(409, 'DUPLICATE', 'A customer with this phone already exists', 'phone', { customer_id: dup.id });
  }
  const id = await findOrCreateCustomer(actor, b);
  res.status(201).json(await one(`${CUSTOMER_SELECT} WHERE cu.id = $1 GROUP BY cu.id`, [id]));
});

router.get('/customers/:id', requirePerm('customers.read'), async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const c = await one(`${CUSTOMER_SELECT} WHERE cu.id = $1 GROUP BY cu.id`, [id]);
  if (!c) throw notFound('Customer not found');
  const cardsRes = await query(
    `SELECT id, card_number, status::text, (balance*100)::bigint AS balance_cents, expires_at, created_at FROM gift_cards WHERE customer_id = $1 AND deleted_at IS NULL ORDER BY id DESC`,
    [id],
  );
  res.json({ customer: c, cards: cardsRes.rows });
});

router.patch('/customers/:id', requirePerm('customers.write'), async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const b = customerInput.parse(req.body);
  const r = await query(
    `UPDATE customers SET first_name = $2, last_name = $3, phone = $4, email = $5, marketing_opt_in = COALESCE($6, marketing_opt_in), notes = COALESCE($7, notes)
     WHERE id = $1 AND erased_at IS NULL`,
    [id, b.first_name || null, b.last_name || null, b.phone, b.email, b.marketing_opt_in ?? null, b.notes ?? null],
  );
  if (!r.rowCount) throw notFound('Customer not found');
  await audit(actorOf(req), 'customer.updated', { entityType: 'customer', entityId: id });
  res.json(await one(`${CUSTOMER_SELECT} WHERE cu.id = $1 GROUP BY cu.id`, [id]));
});

/** GDPR right-to-be-forgotten: blanks PII, keeps the money ledger intact. */
router.post('/customers/:id/erase', requirePerm('customers.erase'), async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  z.object({ confirm: z.literal('ERASE', { errorMap: () => ({ message: 'Type ERASE to confirm' }) }) }).parse(req.body);
  const approvedBy = await requireApproval(req, 'erase');
  await query('SELECT fn_erase_customer($1, $2)', [id, req.user!.id]);
  await audit(actorOf(req), 'customer.erase_approved', { entityType: 'customer', entityId: id, payload: { approved_by: approvedBy } });
  res.json({ erased: true, id });
});
