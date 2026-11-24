/**
 * Offline-tolerant redemptions.
 *
 * When the network is down, a redemption can be queued locally IF it is
 * within the last known balance and under the offline cap
 * (security.offline_max_redeem_cents). Each queued item keeps its
 * Idempotency-Key, so replaying it after reconnect can never double-charge.
 * If the server rejects a replay (e.g. the card was spent elsewhere while we
 * were offline), the item moves to `failed` and the desk is alerted.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { api, ApiError, uuid } from './api';

export interface QueuedRedeem {
  key: string;
  card_id: number;
  card_number: string;
  amount_cents: number;
  tip_cents: number;
  ref?: string;
  queued_at: string;
  last_known_balance_cents: number;
  error?: string;
}

const Q = 'gc.offline.queue';
const F = 'gc.offline.failed';
const listeners = new Set<() => void>();

function read(k: string): QueuedRedeem[] {
  try {
    return JSON.parse(localStorage.getItem(k) ?? '[]');
  } catch {
    return [];
  }
}
function write(k: string, v: QueuedRedeem[]) {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* storage full / private mode */
  }
  snapshot = { pending: read(Q), failed: read(F) };
  listeners.forEach((l) => l());
}

let snapshot = { pending: read(Q), failed: read(F) };

export function enqueueRedeem(item: Omit<QueuedRedeem, 'key' | 'queued_at'> & { key?: string }) {
  const q = read(Q);
  const pendingForCard = q.filter((x) => x.card_id === item.card_id).reduce((s, x) => s + x.amount_cents + x.tip_cents, 0);
  if (pendingForCard + item.amount_cents + item.tip_cents > item.last_known_balance_cents) {
    throw new ApiError(422, 'INSUFFICIENT_FUNDS', 'Offline: amount exceeds the last known balance');
  }
  const full: QueuedRedeem = { ...item, key: item.key ?? uuid(), queued_at: new Date().toISOString() };
  write(Q, [...q, full]);
  return full;
}

let flushing = false;
export async function flushQueue(): Promise<{ sent: number; failed: QueuedRedeem[] }> {
  if (flushing || !navigator.onLine) return { sent: 0, failed: [] };
  flushing = true;
  let sent = 0;
  const newlyFailed: QueuedRedeem[] = [];
  try {
    for (const item of read(Q)) {
      try {
        await api(`/cards/${item.card_id}/redeem`, {
          body: { amount_cents: item.amount_cents, tip_cents: item.tip_cents, ref: item.ref, memo: `Offline redemption queued ${item.queued_at}` },
          idempotencyKey: item.key,
        });
        sent++;
        write(Q, read(Q).filter((x) => x.key !== item.key));
      } catch (e) {
        if (e instanceof ApiError && e.code === 'NETWORK') break; // still offline; keep order
        if (e instanceof ApiError && e.code === 'APPROVAL_CANCELLED') break;
        const failed = { ...item, error: e instanceof Error ? e.message : String(e) };
        newlyFailed.push(failed);
        write(Q, read(Q).filter((x) => x.key !== item.key));
        write(F, [...read(F), failed]);
      }
    }
  } finally {
    flushing = false;
  }
  return { sent, failed: newlyFailed };
}

export const dismissFailed = (key: string) => write(F, read(F).filter((x) => x.key !== key));

export function useOfflineQueue() {
  const s = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => snapshot,
  );
  return s;
}

export function useOnline() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}
