import { parse } from 'csv-parse/sync';
import bcrypt from 'bcryptjs';
import type pg from 'pg';
import { one, query, withTx } from '../db.js';
import { ApiError } from '../errors.js';
import { parseMoney } from '../money.js';
import type { Actor } from '../types.js';
import { issueCard } from './cards.js';

export const IMPORT_FIELDS = ['card_number', 'balance', 'face_value', 'label', 'first_name', 'last_name', 'phone', 'email', 'expires_at', 'pin', 'notes'] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];
export type Mapping = Partial<Record<ImportField, string>>;

export interface ImportRowResult {
  row: number;
  card_number: string | null;
  balance_cents: number | null;
  face_value_cents: number | null;
  holder: string | null;
  status: 'ok' | 'error' | 'duplicate' | 'skipped';
  message?: string;
  card_id?: number;
}

/** Guess a mapping from common legacy-export header names. */
export function suggestMapping(headers: string[]): Mapping {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');
  const rules: [ImportField, RegExp][] = [
    ['card_number', /^(card(no|num|number)?|giftcard(no|number)?|number|code|cardid)$/],
    ['balance', /^(balance|currentbalance|remaining|amountleft|bal)$/],
    ['face_value', /^(facevalue|value|originalamount|initialamount|amount|loaded)$/],
    ['label', /^(label|tag|note|description)$/],
    ['first_name', /^(firstname|first|givenname)$/],
    ['last_name', /^(lastname|last|surname|familyname)$/],
    ['phone', /^(phone|mobile|cell|phonenumber)$/],
    ['email', /^(email|emailaddress|mail)$/],
    ['expires_at', /^(expires|expiry|expiration|expiresat|expirydate|expirationdate)$/],
    ['pin', /^(pin|cardpin|securitycode)$/],
    ['notes', /^(notes|comments|memo)$/],
  ];
  const m: Mapping = {};
  for (const h of headers) {
    const hit = rules.find(([f, re]) => !m[f] && re.test(norm(h)));
    if (hit) m[hit[0]] = h;
  }
  return m;
}

export function parseCsv(csv: string): { headers: string[]; records: Record<string, string>[] } {
  try {
    const records = parse(csv, { columns: true, skip_empty_lines: true, trim: true, bom: true, relax_column_count: true }) as Record<string, string>[];
    const headers = records.length ? Object.keys(records[0]) : (parse(csv.split(/\r?\n/)[0] ?? '', { bom: true })[0] ?? []);
    return { headers, records };
  } catch (e: any) {
    throw new ApiError(400, 'CSV_INVALID', `Could not parse CSV: ${e.message}`, 'csv');
  }
}

const normPhone = (p: string) => {
  const d = p.replace(/\D/g, '');
  return d.length === 10 ? `+1${d}` : d.length === 11 && d.startsWith('1') ? `+${d}` : d ? `+${d}` : '';
};

async function findOrCreateCustomer(c: pg.PoolClient, f: Record<string, string>) {
  const phone = f.phone ? normPhone(f.phone) : null;
  const email = f.email?.toLowerCase() || null;
  if (!phone && !email && !f.first_name && !f.last_name) return null;
  const existing = await one<{ id: number }>(
    'SELECT id FROM customers WHERE erased_at IS NULL AND ((phone IS NOT NULL AND phone = $1) OR (email IS NOT NULL AND lower(email) = $2)) LIMIT 1',
    [phone, email],
    c,
  );
  if (existing) return existing.id;
  const row = await one<{ id: number }>('INSERT INTO customers (first_name, last_name, phone, email) VALUES ($1,$2,$3,$4) RETURNING id', [f.first_name || null, f.last_name || null, phone || null, email], c);
  return row!.id;
}

export async function runImport(actor: Actor, input: { filename: string; csv: string; mapping: Mapping; dry_run: boolean }) {
  const { records } = parseCsv(input.csv);
  if (!input.mapping.card_number || !input.mapping.balance) throw new ApiError(400, 'VALIDATION', 'Map at least "card_number" and "balance"', 'mapping');
  if (records.length > 20000) throw new ApiError(413, 'TOO_LARGE', 'Import is limited to 20,000 rows per file');

  const job = await one<{ id: number }>('INSERT INTO import_jobs (filename, dry_run, rows_total, started_by) VALUES ($1,$2,$3,$4) RETURNING id', [
    input.filename,
    input.dry_run,
    records.length,
    actor.actorId,
  ]);

  const existing = new Set(
    (await query<{ card_number: string }>('SELECT card_number FROM gift_cards')).rows.map((r) => r.card_number),
  );
  const seen = new Set<string>();
  const results: ImportRowResult[] = [];

  // Validation pass (shared by dry-run and commit)
  const prepared: { idx: number; f: Record<string, string>; number: string; bal: number; face: number; expires: string | null }[] = [];
  records.forEach((rec, i) => {
    const f = Object.fromEntries(IMPORT_FIELDS.map((k) => [k, input.mapping[k] ? (rec[input.mapping[k]!] ?? '').trim() : ''])) as Record<string, string>;
    const number = f.card_number.toUpperCase().replace(/\s/g, '');
    const holder = [f.first_name, f.last_name].filter(Boolean).join(' ') || null;
    const base = { row: i + 2, card_number: number || null, holder };
    try {
      if (!/^[0-9A-Z-]{4,20}$/.test(number)) throw new Error('Card number must be 4–20 letters/digits');
      const bal = parseMoney(f.balance || '0');
      const face = f.face_value ? parseMoney(f.face_value) : bal;
      if (bal < 0 || face < 0) throw new Error('Amounts cannot be negative');
      if (face < bal) throw new Error('Face value is lower than balance');
      let expires: string | null = null;
      if (f.expires_at) {
        const d = new Date(f.expires_at);
        if (Number.isNaN(d.getTime())) throw new Error(`Bad expiry date "${f.expires_at}"`);
        if (d.getTime() <= Date.now()) throw new Error('Card already expired');
        expires = d.toISOString();
      }
      if (f.pin && !/^\d{4,8}$/.test(f.pin)) throw new Error('PIN must be 4–8 digits');
      if (seen.has(number)) {
        results.push({ ...base, balance_cents: bal, face_value_cents: face, status: 'duplicate', message: 'Duplicate within this file' });
        return;
      }
      seen.add(number);
      if (existing.has(number)) {
        results.push({ ...base, balance_cents: bal, face_value_cents: face, status: 'duplicate', message: 'Card already exists — skipped' });
        return;
      }
      if (bal === 0) {
        results.push({ ...base, balance_cents: 0, face_value_cents: face, status: 'skipped', message: 'Zero balance — nothing to import' });
        return;
      }
      prepared.push({ idx: results.length, f, number, bal, face, expires });
      results.push({ ...base, balance_cents: bal, face_value_cents: face, status: 'ok' });
    } catch (e: any) {
      results.push({ ...base, balance_cents: null, face_value_cents: null, status: 'error', message: e.message });
    }
  });

  if (!input.dry_run && prepared.length) {
    await withTx(async (c) => {
      for (const p of prepared) {
        await c.query('SAVEPOINT row_sp');
        try {
          const customerId = await findOrCreateCustomer(c, p.f);
          const res = await issueCard(
            { ...actor, actorType: 'IMPORT' },
            {
              card_number: p.number,
              face_value_cents: p.face,
              initial_balance_cents: p.bal,
              activate: true,
              customer_id: customerId,
              label: p.f.label || null,
              expires_at: p.expires,
              pin_hash: p.f.pin ? await bcrypt.hash(p.f.pin, 10) : null,
              channel: 'IMPORT',
              external_ref: `IMPORT-${job!.id}`,
            },
            `import-${job!.id}-${p.number}`,
            c,
          );
          if (p.f.notes) await c.query('UPDATE gift_cards SET notes = $2 WHERE id = $1', [res.card.id, p.f.notes]);
          results[p.idx].card_id = res.card.id;
          await c.query('RELEASE SAVEPOINT row_sp');
        } catch (e: any) {
          await c.query('ROLLBACK TO SAVEPOINT row_sp');
          results[p.idx].status = 'error';
          results[p.idx].message = e.message;
        }
      }
    }, { isolation: 'READ COMMITTED' });
  }

  const ok = results.filter((r) => r.status === 'ok').length;
  const failed = results.filter((r) => r.status === 'error').length;
  const errors = results.filter((r) => r.status !== 'ok').slice(0, 500);
  await query(`UPDATE import_jobs SET rows_ok = $2, rows_failed = $3, errors = $4, status = 'DONE', finished_at = now() WHERE id = $1`, [job!.id, ok, failed, JSON.stringify(errors)]);

  return {
    job_id: job!.id,
    dry_run: input.dry_run,
    rows_total: records.length,
    rows_ok: ok,
    rows_failed: failed,
    rows_skipped: results.length - ok - failed,
    total_balance_cents: results.filter((r) => r.status === 'ok').reduce((s, r) => s + (r.balance_cents ?? 0), 0),
    preview: results.slice(0, 300),
  };
}
