import { describe, expect, it } from 'vitest';
import { formatCents, parseMoney, taxCents } from '../src/money.js';
import { csvCell, toCsv, centsToDecimal } from '../src/util/csv.js';
import { render } from '../src/services/messaging.js';
import { EscPos, encodeReceipt } from '../src/services/printing.js';
import { qrToken, verifyQrToken, maskNumber } from '../src/services/qr.js';

describe('money (integer cents)', () => {
  it.each([
    ['12', 1200],
    ['12.3', 1230],
    ['12.34', 1234],
    ['$1,234.50', 123450],
    ['0.01', 1],
    ['-20', -2000],
    [98, 9800],
    [0.1, 10],
  ])('parseMoney(%s) = %d', (input, cents) => {
    expect(parseMoney(input as any)).toBe(cents);
  });

  it('rejects >2 decimals, junk and float noise', () => {
    expect(() => parseMoney('1.234')).toThrow();
    expect(() => parseMoney('abc')).toThrow();
    expect(() => parseMoney(0.1 + 0.2)).toThrow();
    expect(() => parseMoney('99999999999')).toThrow();
  });

  it('formats', () => {
    expect(formatCents(63500)).toBe('$635.00');
    expect(formatCents(-2000)).toBe('-$20.00');
    expect(formatCents(5)).toBe('$0.05');
    expect(formatCents(123456789)).toBe('$1,234,567.89');
    expect(centsToDecimal(-2201)).toBe('-22.01');
  });

  it('tax rounds half-up in integer math', () => {
    expect(taxCents(10000, 825)).toBe(825);
    expect(taxCents(1, 5000)).toBe(1); // 0.5¢ → 1¢
    expect(taxCents(999, 825)).toBe(82); // 82.4175
  });
});

describe('csv', () => {
  it('escapes and neutralises formulas', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('-20.00')).toBe('-20.00');
    expect(toCsv(['a'], [[1], [null]])).toBe('a\r\n1\r\n\r\n');
  });
});

describe('templates, receipts, QR', () => {
  it('renders template variables', () => {
    expect(render('Hi {{first_name}}, {{ balance }} left{{missing}}', { first_name: 'Ann', balance: '$5.00' })).toBe('Hi Ann, $5.00 left');
  });

  it('ESC/POS Code 128: set B for odd-length numbers, set C for even-length', () => {
    const b = new EscPos(48).code128('3460010', { paperDots: 576 }).build();
    const i = b.indexOf(Buffer.from([0x1d, 0x6b, 73]));
    expect(i).toBeGreaterThan(0);
    expect(b[i + 3]).toBe(9); // "{B" + 7 chars
    expect(b.subarray(i + 4, i + 13).toString('ascii')).toBe('{B3460010');
    const c = new EscPos(48).code128('34600100', { paperDots: 576 }).build();
    const j = c.indexOf(Buffer.from([0x1d, 0x6b, 73]));
    expect([...c.subarray(j + 3, j + 10)]).toEqual([6, 0x7b, 0x43, 34, 60, 1, 0]); // "{C" + digit pairs
    // Module width shrinks to fit 58 mm paper for long numbers
    const w = new EscPos(32).code128('ABCDEFGHIJKLMNOPQRST', { paperDots: 384 }).build();
    expect(w[w.indexOf(Buffer.from([0x1d, 0x77])) + 2]).toBe(1);
    expect(() => new EscPos(32).code128('ünicode', { paperDots: 384 })).toThrow();
  });

  it('ESC/POS output starts with init and ends with cut; pads columns', () => {
    const buf = encodeReceipt({ title: 'Amazing Salon', header: [], lines: [{ left: 'Balance', right: '$22.00', bold: true }], barcode: '3460010', footer: ['Thanks'], paper_width_mm: 58 });
    expect(buf.includes(Buffer.from('{B3460010', 'ascii'))).toBe(true);
    expect(buf.includes(Buffer.from([0x1d, 0x28, 0x6b]))).toBe(false); // no QR command any more
    expect([...buf.subarray(0, 2)]).toEqual([0x1b, 0x40]);
    expect([...buf.subarray(-4)]).toEqual([0x1d, 0x56, 0x42, 0x00]);
    expect(buf.toString('latin1')).toContain('Balance' + ' '.repeat(32 - 7 - 6) + '$22.00');
    expect(new EscPos(48).pair('x'.repeat(60), '$1.00').build().toString('latin1')).toContain('$1.00');
  });

  it('QR tokens verify and cannot be forged from a card id', () => {
    const t = qrToken(42);
    expect(verifyQrToken(t)).toBe(42);
    expect(verifyQrToken(t.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')))).toBeNull();
    expect(verifyQrToken('16.' + 'A'.repeat(22))).toBeNull();
    expect(maskNumber('3460010')).toBe('•••0010');
  });
});
