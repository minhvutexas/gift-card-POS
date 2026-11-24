import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

/**
 * Signed, unguessable token printed as a QR code on receipts. It lets a
 * customer open their balance page without typing the number + PIN, but
 * cannot be derived from a card number (prevents enumeration).
 */
const sig = (id: number) => createHmac('sha256', config.qrSecret).update(`gc:${id}`).digest('base64url').slice(0, 22);

export const qrToken = (cardId: number) => `${cardId.toString(36)}.${sig(cardId)}`;

export function verifyQrToken(token: string): number | null {
  const m = /^([0-9a-z]{1,12})\.([A-Za-z0-9_-]{22})$/.exec(token);
  if (!m) return null;
  const id = Number.parseInt(m[1], 36);
  const expected = Buffer.from(sig(id));
  const given = Buffer.from(m[2]);
  return expected.length === given.length && timingSafeEqual(expected, given) ? id : null;
}

export const kioskUrl = (cardId: number) => `${config.publicUrl.replace(/\/$/, '')}/kiosk?t=${qrToken(cardId)}`;

export const maskNumber = (n: string) => (n.length <= 4 ? n : `${'•'.repeat(Math.min(n.length - 4, 6))}${n.slice(-4)}`);
