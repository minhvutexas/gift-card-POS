import { useEffect, useRef } from 'react';

/**
 * USB/Bluetooth barcode scanners behave like keyboards that type very fast
 * and finish with Enter. This hook catches such bursts anywhere on the page
 * (when no text field has focus) and hands the code to `onScan`.
 * Human typing (>50 ms between keys) is ignored.
 */
export function useScanner(onScan: (code: string) => void, opts: { enabled?: boolean; minLength?: number } = {}) {
  const buf = useRef('');
  const last = useRef(0);
  const cb = useRef(onScan);
  cb.current = onScan;
  const { enabled = true, minLength = 4 } = opts;

  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      if (typing && !t!.dataset.scanner) return; // let real form fields work normally
      if (document.querySelector('[role="dialog"][aria-modal="true"]') && !t?.dataset.scanner) return;
      const now = performance.now();
      if (now - last.current > 50) buf.current = '';
      last.current = now;
      if (e.key === 'Enter') {
        const code = buf.current.trim();
        buf.current = '';
        if (code.length >= minLength) {
          e.preventDefault();
          cb.current(code);
        }
        return;
      }
      if (e.key.length === 1) buf.current += e.key; // keep URL chars too (QR codes encode the kiosk link)
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [enabled, minLength]);
}

/** Card numbers may arrive as a kiosk URL (QR) or with a track prefix; normalise. */
export function normaliseScan(code: string): string {
  const s = code.trim().toUpperCase();
  const qr = /[?&]T=([^&]+)/i.exec(code);
  if (qr) return `QR:${qr[1]}`;
  return s.replace(/^[%;]|[?]$/g, '').replace(/\s/g, '');
}
