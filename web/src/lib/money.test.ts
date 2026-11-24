import { describe, expect, it } from 'vitest';
import { formatCents, keypadAppend, parseToCents, signedCents } from './money';
import { normaliseScan } from './scanner';
import { STATUS } from './status';
import { statusFor } from '../features/cards/cache';

describe('money', () => {
  it('formats cents', () => {
    expect(formatCents(63500)).toBe('$635.00');
    expect(formatCents(-2000)).toBe('-$20.00');
    expect(signedCents(5000)).toBe('+$50.00');
    expect(formatCents(null)).toBe('—');
  });
  it('parses user input exactly', () => {
    expect(parseToCents('22')).toBe(2200);
    expect(parseToCents('$1,234.5')).toBe(123450);
    expect(parseToCents('0.07')).toBe(7);
    expect(parseToCents('1.234')).toBeNull();
    expect(parseToCents('abc')).toBeNull();
    expect(parseToCents('')).toBeNull();
  });
  it('keypad shifts digits in from the right', () => {
    let c = 0;
    for (const k of ['2', '5', '0', '0']) c = keypadAppend(c, k);
    expect(c).toBe(2500);
    expect(keypadAppend(c, 'back')).toBe(250);
    expect(keypadAppend(25, '00')).toBe(2500);
    expect(keypadAppend(999, '9', 1000)).toBe(999); // respects max
  });
});

describe('status mirrors the DB rule', () => {
  it('0 → CLOSED, >= face → ACTIVE, else PARTIALUSED', () => {
    expect(statusFor(0, 5000)).toBe('CLOSED');
    expect(statusFor(5000, 5000)).toBe('ACTIVE');
    expect(statusFor(2200, 5000)).toBe('PARTIALUSED');
  });
  it('every status has a non-colour cue', () => {
    for (const s of Object.values(STATUS)) {
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.glyph.length).toBeGreaterThan(0);
    }
  });
});

describe('scanner input', () => {
  it('normalises magstripe & QR payloads', () => {
    expect(normaliseScan(';3460010?')).toBe('3460010');
    expect(normaliseScan(' 3460 010 ')).toBe('3460010');
    expect(normaliseScan('https://salon.example/kiosk?t=2s.abcDEF')).toBe('QR:2s.abcDEF');
  });
});
