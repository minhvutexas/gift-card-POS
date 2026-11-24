import { beforeAll, describe, expect, it } from 'vitest';
import { code128Svg } from './Receipt';

// jsdom has no canvas; JsBarcode only uses it to measure the number text.
beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = (() => ({ font: '', measureText: (s: string) => ({ width: s.length * 9 }) })) as any;
});

const box = (svg: string) => {
  const el = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;
  const [, , w, h] = (el.getAttribute('viewBox') ?? '').split(' ').map(Number);
  return { el, w, h };
};

describe('receipt Code 128 barcode', () => {
  it('encodes the card number with human-readable text', () => {
    const { el } = box(code128Svg('3460010'));
    expect(el.getAttribute('aria-label')).toBe('Barcode 3460010');
    expect(el.textContent).toContain('3460010');
    expect(el.querySelectorAll('rect').length).toBeGreaterThan(20); // bars
  });

  it('keeps the same proportions (≈ width × 0.25) for short and long numbers', () => {
    for (const n of ['3460010', 'GIFT-2026-000123456']) {
      const { w, h } = box(code128Svg(n));
      expect(w).toBeGreaterThan(0);
      expect(h / w).toBeGreaterThan(0.2);
      expect(h / w).toBeLessThan(0.45);
    }
  });
});
