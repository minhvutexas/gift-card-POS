/**
 * Money helpers. Internally everything is integer cents (JS number, always
 * an integer, |x| < 2^53). Never use floats for arithmetic.
 */

export type Cents = number;

const MAX_CENTS = 9_999_999_999; // NUMERIC(12,2) upper bound

/** Parse "12", "12.3", "12.34", "$1,234.50" → cents. Throws on >2 decimals or junk. */
export function parseMoney(input: string | number): Cents {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new Error('Invalid amount');
    input = String(input); // 12.34 → "12.34"; float noise like 0.30000000000000004 is rejected below
  }
  const s = input.trim().replace(/[$,\s]/g, '');
  const m = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw new Error(`Invalid amount: "${input}"`);
  const cents = Number.parseInt(m[2], 10) * 100 + Number.parseInt((m[3] ?? '0').padEnd(2, '0'), 10);
  if (cents > MAX_CENTS) throw new Error('Amount too large');
  return m[1] ? -cents : cents;
}

/** Postgres NUMERIC string ("98.00") → cents, exactly. */
export function numericToCents(v: string | null | undefined): Cents {
  if (v === null || v === undefined) return 0;
  return parseMoney(v);
}

export function assertCents(v: unknown, field = 'amount_cents'): Cents {
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw new Error(`${field} must be an integer number of cents`);
  if (Math.abs(v) > MAX_CENTS) throw new Error(`${field} is too large`);
  return v;
}

/** 63500 → "$635.00", -2000 → "-$20.00" */
export function formatCents(c: Cents, currency = 'USD'): string {
  const sign = c < 0 ? '-' : '';
  const abs = Math.abs(c);
  const dollars = Math.trunc(abs / 100).toLocaleString('en-US');
  const symbol = currency === 'USD' || currency === 'CAD' || currency === 'AUD' ? '$' : currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : '';
  return `${sign}${symbol}${dollars}.${String(abs % 100).padStart(2, '0')}`;
}

/** Tax in cents with banker-safe integer rounding (half up). rate in basis points (825 = 8.25%). */
export function taxCents(amount: Cents, rateBps: number): Cents {
  return Math.floor((amount * rateBps + 5000) / 10000);
}
