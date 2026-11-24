import PDFDocument from 'pdfkit';
import { formatCents } from '../money.js';
import { getAllSettings } from '../settings.js';
import type { Card, Txn } from './cards.js';

function toBuffer(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

function table(doc: PDFKit.PDFDocument, cols: { label: string; width: number; align?: 'left' | 'right' }[], rows: string[][]) {
  const x0 = doc.page.margins.left;
  const drawRow = (cells: string[], bold = false) => {
    if (doc.y > doc.page.height - doc.page.margins.bottom - 20) doc.addPage();
    const y = doc.y;
    let x = x0;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
    let h = 0;
    cells.forEach((c, i) => {
      doc.text(c, x + 2, y, { width: cols[i].width - 4, align: cols[i].align ?? 'left' });
      h = Math.max(h, doc.y - y);
      x += cols[i].width;
    });
    doc.y = y + h + 4;
    doc.x = x0;
  };
  drawRow(cols.map((c) => c.label), true);
  doc.moveTo(x0, doc.y - 2).lineTo(x0 + cols.reduce((s, c) => s + c.width, 0), doc.y - 2).strokeColor('#999').stroke();
  rows.forEach((r) => drawRow(r));
}

export async function cardStatementPdf(card: Card, txns: Txn[]): Promise<Buffer> {
  const s = await getAllSettings();
  const tz = s.general.timezone;
  const doc = new PDFDocument({ size: 'LETTER', margin: 50, info: { Title: `Statement ${card.card_number}` } });
  doc.font('Helvetica-Bold').fontSize(18).text(s.general.business_name);
  doc.font('Helvetica').fontSize(9).fillColor('#555').text([s.general.address, s.general.phone].filter(Boolean).join(' · '));
  doc.moveDown().fillColor('#000').font('Helvetica-Bold').fontSize(14).text(`Gift card statement — ${card.card_number}`);
  doc.font('Helvetica').fontSize(10).moveDown(0.5);
  const holder = card.customer && !card.customer.erased ? [card.customer.first_name, card.customer.last_name].filter(Boolean).join(' ') : '—';
  const fmtDate = (d: string | null) => (d ? new Date(d).toLocaleString('en-US', { timeZone: tz }) : '—');
  [
    ['Status', card.status],
    ['Current balance', formatCents(card.balance_cents, card.currency)],
    ['Face value', formatCents(card.face_value_cents, card.currency)],
    ['Holder', holder],
    ['Issued', fmtDate(card.created_at)],
    ['Expires', fmtDate(card.expires_at)],
    ['Generated', new Date().toLocaleString('en-US', { timeZone: tz })],
  ].forEach(([k, v]) => doc.text(`${k}: ${v}`));
  doc.moveDown();
  table(
    doc,
    [
      { label: 'Date', width: 120 },
      { label: 'Type', width: 95 },
      { label: 'Amount', width: 70, align: 'right' },
      { label: 'Balance', width: 70, align: 'right' },
      { label: 'Ref / memo', width: 157 },
    ],
    [...txns].reverse().map((t) => [
      new Date(t.created_at).toLocaleString('en-US', { timeZone: tz }),
      t.txn_type + (t.reversed ? ' (reversed)' : ''),
      (t.amount_cents > 0 ? '+' : '') + formatCents(t.amount_cents, card.currency),
      formatCents(t.balance_after_cents, card.currency),
      [t.external_ref, t.memo].filter(Boolean).join(' — '),
    ]),
  );
  return toBuffer(doc);
}

export async function historyPdf(rows: any[], title: string): Promise<Buffer> {
  const s = await getAllSettings();
  const tz = s.general.timezone;
  const doc = new PDFDocument({ size: 'LETTER', layout: 'landscape', margin: 36, info: { Title: title } });
  doc.font('Helvetica-Bold').fontSize(14).text(`${s.general.business_name} — ${title}`);
  doc.font('Helvetica').fontSize(8).fillColor('#555').text(`Generated ${new Date().toLocaleString('en-US', { timeZone: tz })} · ${rows.length} rows`).fillColor('#000');
  doc.moveDown(0.5);
  table(
    doc,
    [
      { label: 'When', width: 110 },
      { label: 'Actor', width: 80 },
      { label: 'Card', width: 70 },
      { label: 'Action', width: 120 },
      { label: 'Amount', width: 65, align: 'right' },
      { label: 'Balance', width: 65, align: 'right' },
      { label: 'Ref', width: 70 },
      { label: 'Terminal', width: 70 },
      { label: 'Note', width: 70 },
    ],
    rows.map((r) => [
      new Date(r.occurred_at).toLocaleString('en-US', { timeZone: tz }),
      r.actor_name ?? r.actor_type,
      r.card_number ?? '',
      r.action,
      r.amount_cents == null ? '' : formatCents(r.amount_cents),
      r.balance_after_cents == null ? '' : formatCents(r.balance_after_cents),
      r.reference ?? '',
      r.terminal_code ?? '',
      r.note ?? '',
    ]),
  );
  return toBuffer(doc);
}
