import { useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import JsBarcode from 'jsbarcode';
import { api, ApiError } from '../lib/api';
import { useToast } from '../lib/toast';
import type { Receipt } from '../lib/types';

/** Printed barcode box: fixed width per paper size, height ≈ ¼ of the width (bars + number). */
const BARCODE_WIDTH_MM = { 58: 44, 80: 56 } as const;
const BARCODE_ASPECT = 0.25;
const TEXT_PX = 22; // human-readable number under the bars (font + margin)

/**
 * Renders a Code 128 barcode to an SVG string. Bar height is chosen so the
 * whole symbol keeps the same proportions on every card number length, so it
 * always fits the receipt column.
 */
export function code128Svg(data: string): string {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const opts = { format: 'CODE128', width: 2, margin: 0, displayValue: true, font: 'monospace', fontSize: 16, textMargin: 4, background: '#ffffff', lineColor: '#000000' };
  JsBarcode(svg, data, { ...opts, height: 60 }); // pass 1: measure the natural width
  const naturalWidth = Number.parseFloat(svg.getAttribute('width') ?? '0') || 200;
  JsBarcode(svg, data, { ...opts, height: Math.max(30, Math.round(naturalWidth * BARCODE_ASPECT - TEXT_PX)) });
  // viewBox lets CSS scale the symbol to the mm box without distorting it.
  // JsBarcode writes width/height with "px" units — strip them for a valid viewBox.
  const w = Number.parseFloat(svg.getAttribute('width') ?? '0');
  const h = Number.parseFloat(svg.getAttribute('height') ?? '0');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `Barcode ${data}`);
  return svg.outerHTML;
}

/**
 * Receipt printing.
 *  - Printer mode "network": the API sends ESC/POS (native Code 128) to the thermal printer.
 *  - Printer mode "browser": we render the receipt into a print-only node
 *    sized to 58/80 mm and call window.print() (AirPrint / OS driver).
 */
export function usePrinter() {
  const toast = useToast();
  const [job, setJob] = useState<{ receipt: Receipt; barcodeSvg: string | null } | null>(null);

  const print = useCallback(
    async (cardId: number, txnId?: number) => {
      try {
        const r = await api<{ mode: string; receipt: Receipt }>(`/cards/${cardId}/print`, { body: txnId ? { txn_id: txnId } : {} });
        if (r.mode === 'network') {
          toast.push({ kind: 'success', title: 'Sent to printer' });
          return;
        }
        if (r.mode === 'disabled') return;
        const barcodeSvg = r.receipt.barcode ? code128Svg(r.receipt.barcode) : null;
        setJob({ receipt: r.receipt, barcodeSvg });
        // Let React paint the print node, then open the dialog.
        await new Promise((res) => setTimeout(res, 50));
        window.print();
        setTimeout(() => setJob(null), 500);
      } catch (e) {
        const msg = e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'Printer error';
        toast.push({ kind: 'error', title: 'Print failed', message: msg, action: { label: 'Retry', onClick: () => print(cardId, txnId) } });
        if (!(e instanceof ApiError && e.code === 'PRINT_FAILED')) api(`/cards/${cardId}/print-failed`, { body: { message: msg } }).catch(() => {});
      }
    },
    [toast],
  );

  const node = job
    ? createPortal(
        <div id="print-receipt" style={{ width: job.receipt.paper_width_mm === 58 ? '48mm' : '72mm' }}>
          <div style={{ textAlign: 'center', fontWeight: 700, fontSize: 16 }}>{job.receipt.title}</div>
          {job.receipt.header.map((h, i) => (
            <div key={i} style={{ textAlign: 'center' }}>
              {h}
            </div>
          ))}
          <hr />
          {job.receipt.lines.map((l, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontWeight: l.bold ? 700 : 400 }}>
              <span>{l.left}</span>
              <span>{l.right}</span>
            </div>
          ))}
          <hr />
          {job.barcodeSvg && (
            <div
              className="receipt-barcode"
              style={{ width: `${BARCODE_WIDTH_MM[job.receipt.paper_width_mm]}mm`, margin: '2mm auto' }}
              // SVG produced locally by JsBarcode from the card number — no user HTML.
              dangerouslySetInnerHTML={{ __html: job.barcodeSvg }}
            />
          )}
          {job.receipt.footer.map((f, i) => (
            <div key={i} style={{ textAlign: 'center', fontSize: 10, marginTop: 4 }}>
              {f}
            </div>
          ))}
        </div>,
        document.body,
      )
    : null;

  return { print, printNode: node };
}
