import net from 'node:net';
import { formatCents } from '../money.js';
import { getAllSettings } from '../settings.js';
import type { Card, Txn } from './cards.js';
import { maskNumber } from './qr.js';

// ---------------------------------------------------------------- receipt model (shared by ESC/POS + browser print)
export interface Receipt {
  title: string;
  header: string[];
  lines: { left: string; right?: string; bold?: boolean }[];
  /** Card number printed as a Code 128 barcode (scannable at the front desk). */
  barcode: string | null;
  footer: string[];
  paper_width_mm: 58 | 80;
}

const TXN_LABEL: Record<string, string> = {
  ISSUE: 'Gift card sold',
  ACTIVATE: 'Card activated',
  RELOAD: 'Reload',
  REDEEM: 'Redeemed',
  REFUND_TO_CARD: 'Refund to card',
  TIP_FROM_CARD: 'Tip paid from card',
  ADJUSTMENT: 'Balance adjustment',
  TRANSFER_OUT: 'Transfer out',
  TRANSFER_IN: 'Transfer in',
  MERGE_OUT: 'Merged out',
  MERGE_IN: 'Merged in',
  VOID: 'Card voided',
  EXPIRE: 'Card expired',
  REPLACE_OUT: 'Replaced (lost)',
  REPLACE_IN: 'Replacement card',
  REVERSAL: 'Reversal',
};

export async function buildReceipt(card: Card, txn?: Txn | null): Promise<Receipt> {
  const s = await getAllSettings();
  const tz = s.general.timezone;
  const when = new Date(txn?.created_at ?? Date.now()).toLocaleString('en-US', { timeZone: tz });
  const lines: Receipt['lines'] = [
    { left: 'Card', right: maskNumber(card.card_number) },
    { left: 'Date', right: when },
  ];
  if (txn) {
    lines.push({ left: TXN_LABEL[txn.txn_type] ?? txn.txn_type, right: formatCents(txn.amount_cents, card.currency), bold: true });
    if (txn.external_ref) lines.push({ left: 'Ref', right: txn.external_ref });
    lines.push({ left: 'Txn #', right: String(txn.id) });
  }
  if (s.receipt.show_balance_after || !txn) lines.push({ left: 'Balance', right: formatCents(card.balance_cents, card.currency), bold: true });
  if (card.expires_at) lines.push({ left: 'Expires', right: new Date(card.expires_at).toLocaleDateString('en-US', { timeZone: tz }) });

  const footer = s.receipt.footer.split('\n').filter(Boolean);
  if (s.receipt.show_terms && s.receipt.terms) footer.push(s.receipt.terms);
  return {
    title: s.general.business_name,
    header: [...s.receipt.header.split('\n').filter(Boolean), s.general.address, s.general.phone].filter(Boolean),
    lines,
    barcode: s.receipt.show_barcode ? card.card_number : null,
    footer,
    paper_width_mm: s.printer.paper_width_mm,
  };
}

// ---------------------------------------------------------------- ESC/POS encoder
const ESC = 0x1b;
const GS = 0x1d;

export class EscPos {
  private chunks: Buffer[] = [];
  constructor(public cols: number) {
    this.raw(ESC, 0x40); // initialize
  }
  raw(...bytes: number[]) {
    this.chunks.push(Buffer.from(bytes));
    return this;
  }
  text(s: string) {
    // Thermal printers default to CP437; keep to printable ASCII for portability.
    this.chunks.push(Buffer.from(s.normalize('NFKD').replace(/[^\x20-\x7e\n]/g, ''), 'ascii'));
    return this;
  }
  line(s = '') {
    return this.text(s + '\n');
  }
  align(a: 'left' | 'center' | 'right') {
    return this.raw(ESC, 0x61, a === 'left' ? 0 : a === 'center' ? 1 : 2);
  }
  bold(on: boolean) {
    return this.raw(ESC, 0x45, on ? 1 : 0);
  }
  size(double: boolean) {
    return this.raw(GS, 0x21, double ? 0x11 : 0x00);
  }
  pair(left: string, right = '') {
    const room = Math.max(1, this.cols - right.length);
    const l = left.length > room - 1 ? left.slice(0, room - 1) : left;
    return this.line(l + ' '.repeat(this.cols - l.length - right.length) + right);
  }
  rule() {
    return this.line('-'.repeat(this.cols));
  }
  wrap(s: string) {
    const words = s.split(/\s+/);
    let cur = '';
    for (const w of words) {
      if ((cur + ' ' + w).trim().length > this.cols) {
        this.line(cur);
        cur = w;
      } else cur = (cur + ' ' + w).trim();
    }
    if (cur) this.line(cur);
    return this;
  }
  /**
   * Native Code 128 (GS k, m=73) with the human-readable number printed below.
   * Code set C (2 digits per symbol) for even-length numeric data, else set B.
   * Module width is the widest (1–4 dots) that still fits the paper.
   */
  code128(data: string, opts: { paperDots: number; heightDots?: number }) {
    if (!/^[\x20-\x7e]{1,40}$/.test(data)) throw new Error('Code 128 data must be 1–40 printable ASCII characters');
    const setC = /^\d+$/.test(data) && data.length % 2 === 0;
    const payload = setC
      ? Buffer.from([0x7b, 0x43, ...(data.match(/\d\d/g) ?? []).map(Number)]) // "{C" + digit pairs
      : Buffer.concat([Buffer.from('{B', 'ascii'), Buffer.from(data, 'ascii')]);
    const symbols = setC ? data.length / 2 : data.length;
    const modules = 11 * (symbols + 3) + 2 + 20; // start + check + stop, 10-module quiet zones
    const width = Math.max(1, Math.min(4, Math.floor(opts.paperDots / modules)));
    this.raw(GS, 0x48, 0x02); // HRI text below the bars
    this.raw(GS, 0x66, 0x00); // HRI font A
    this.raw(GS, 0x68, opts.heightDots ?? 80); // bar height (80 dots ≈ 10 mm at 203 dpi)
    this.raw(GS, 0x77, width); // module width
    this.raw(GS, 0x6b, 73, payload.length);
    this.chunks.push(payload);
    return this.line();
  }
  feed(n = 3) {
    return this.raw(ESC, 0x64, n);
  }
  cut() {
    return this.raw(GS, 0x56, 0x42, 0x00); // partial cut with feed
  }
  /** Kick cash drawer pin 2 (optional). */
  drawer() {
    return this.raw(ESC, 0x70, 0x00, 0x19, 0xfa);
  }
  build() {
    return Buffer.concat(this.chunks);
  }
}

export function encodeReceipt(r: Receipt): Buffer {
  const p = new EscPos(r.paper_width_mm === 58 ? 32 : 48);
  p.align('center').bold(true).size(true).line(r.title).size(false).bold(false);
  for (const h of r.header) p.line(h);
  p.align('left').rule();
  for (const l of r.lines) {
    if (l.bold) p.bold(true);
    p.pair(l.left, l.right ?? '');
    if (l.bold) p.bold(false);
  }
  p.rule();
  // Printable width: 384 dots on 58 mm, 576 dots on 80 mm (203 dpi heads).
  if (r.barcode) p.align('center').code128(r.barcode, { paperDots: r.paper_width_mm === 58 ? 384 : 576, heightDots: r.paper_width_mm === 58 ? 64 : 80 });
  p.align('center');
  for (const f of r.footer) p.wrap(f);
  return p.feed(3).cut().build();
}

/** Raw TCP to port 9100 (JetDirect) — Epson TM-T20/T88, Star TSP, most LAN thermal printers. */
export function sendToNetworkPrinter(host: string, port: number, data: Buffer, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`Printer ${host}:${port} timed out`));
    }, timeoutMs);
    sock.on('connect', () => sock.end(data));
    sock.on('close', (hadErr) => {
      clearTimeout(timer);
      if (!hadErr) resolve();
    });
    sock.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`Printer ${host}:${port}: ${e.message}`));
    });
  });
}

/**
 * Prints according to Settings › Printer.
 *  - network: ESC/POS over TCP from the API host.
 *  - browser: returns the receipt; the web app renders + window.print().
 */
export async function printReceipt(card: Card, txn?: Txn | null) {
  const s = (await getAllSettings()).printer;
  const receipt = await buildReceipt(card, txn);
  if (s.mode === 'network') {
    if (!s.host) throw new Error('Printer host is not configured');
    const data = encodeReceipt(receipt);
    for (let i = 0; i < s.copies; i++) await sendToNetworkPrinter(s.host, s.port, data);
    return { mode: 'network' as const, receipt, bytes: data.length };
  }
  return { mode: s.mode, receipt };
}
