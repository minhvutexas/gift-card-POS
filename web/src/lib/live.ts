import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { API_BASE, store } from './api';

export type LiveState = 'connecting' | 'live' | 'offline';

/**
 * Subscribes to the API's SSE stream (Postgres NOTIFY fan-out) so every
 * terminal sees balance/status changes from other terminals in ~real time.
 */
export function useLiveEvents(enabled: boolean): LiveState {
  const qc = useQueryClient();
  const [state, setState] = useState<LiveState>('connecting');
  const timer = useRef<number | null>(null);
  const pendingCards = useRef(new Set<number>());

  useEffect(() => {
    if (!enabled || !store.token) return;
    const params = new URLSearchParams({ access_token: store.token });
    if (store.terminalKey) params.set('terminal_key', store.terminalKey);
    const es = new EventSource(`${API_BASE}/events?${params}`);
    es.onopen = () => setState('live');
    es.onerror = () => setState(navigator.onLine ? 'connecting' : 'offline');
    es.onmessage = (m) => {
      try {
        const ev = JSON.parse(m.data);
        if (ev.type === 'hello') return setState('live');
        if (ev.card_id) pendingCards.current.add(ev.card_id);
      } catch {
        return;
      }
      // Coalesce bursts (bulk ops) into one refetch.
      if (timer.current) return;
      timer.current = window.setTimeout(() => {
        timer.current = null;
        qc.invalidateQueries({ queryKey: ['cards'] });
        qc.invalidateQueries({ queryKey: ['outstanding'] });
        qc.invalidateQueries({ queryKey: ['dashboard'] });
        qc.invalidateQueries({ queryKey: ['history'] });
        pendingCards.current.forEach((id) => qc.invalidateQueries({ queryKey: ['card', id] }));
        pendingCards.current.clear();
      }, 300);
    };
    const off = () => setState('offline');
    const on = () => setState('connecting');
    window.addEventListener('offline', off);
    window.addEventListener('online', on);
    return () => {
      es.close();
      window.removeEventListener('offline', off);
      window.removeEventListener('online', on);
    };
  }, [enabled, qc]);

  return enabled ? state : 'offline';
}

export function useClock(intervalMs = 1000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const iv = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(iv);
  }, [intervalMs]);
  return now;
}
