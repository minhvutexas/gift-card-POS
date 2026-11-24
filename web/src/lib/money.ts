/** UI money helpers — integer cents only. */

export function formatCents(c: number | null | undefined, currency = 'USD'): string {
  if (c === null || c === undefined) return '—';
  const sign = c < 0 ? '-' : '';
  const abs = Math.abs(c);
  const symbol = currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : '$';
  return `${sign}${symbol}${Math.trunc(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
}

/** "+$50.00" / "-$20.00" */
export const signedCents = (c: number, currency = 'USD') => (c > 0 ? '+' : '') + formatCents(c, currency);

/** "12.5" → 1250; returns null if not a valid non-negative amount with ≤2 decimals. */
export function parseToCents(input: string): number | null {
  const s = input.trim().replace(/[$,\s]/g, '');
  const m = /^(\d{0,9})(?:\.(\d{0,2}))?$/.exec(s);
  if (!m || (m[1] === '' && (m[2] ?? '') === '')) return null;
  return Number.parseInt(m[1] || '0', 10) * 100 + Number.parseInt((m[2] ?? '').padEnd(2, '0') || '0', 10);
}

/** POS-style keypad entry: digits shift in from the right (2,5,0,0 → $25.00). */
export function keypadAppend(cents: number, key: string, max = 99_999_999): number {
  if (key === 'back') return Math.floor(cents / 10);
  if (key === 'clear') return 0;
  const digits = key === '00' ? 2 : 1;
  const next = cents * 10 ** digits + (key === '00' ? 0 : Number(key));
  return next > max ? cents : next;
}
