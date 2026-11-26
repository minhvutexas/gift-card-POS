import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, onAuthError, store } from './api';
import type { Me } from './types';

interface SessionCtx {
  me: Me | null;
  loading: boolean;
  locked: boolean;
  can: (perm: string) => boolean;
  loginPin: (pin: string, userId?: number) => Promise<void>;
  loginPassword: (cid: string, username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  unlock: (pin: string) => Promise<void>;
  lock: () => void;
  refresh: () => Promise<void>;
  authError: string | null;
}

const Ctx = createContext<SessionCtx | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(!!store.token);
  const [locked, setLocked] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const lastActivity = useRef(Date.now());

  const refresh = useCallback(async () => {
    if (!store.token) {
      setMe(null);
      setLoading(false);
      return;
    }
    try {
      setMe(await api<Me>('/auth/me'));
    } catch {
      store.token = null;
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(
    () =>
      onAuthError((code) => {
        store.token = null;
        setMe(null);
        qc.clear();
        setAuthError(code === 'TERMINAL_REQUIRED' || code === 'TERMINAL_INVALID' ? code : 'SESSION_EXPIRED');
      }),
    [qc],
  );

  const accept = async (r: { token: string }) => {
    store.token = r.token;
    setAuthError(null);
    setLocked(false);
    lastActivity.current = Date.now();
    await refresh();
  };

  const loginPin = async (pin: string, userId?: number) => accept(await api('/auth/pin-login', { body: { pin, user_id: userId } }));
  const loginPassword = async (cid: string, username: string, password: string) => accept(await api('/auth/login', { body: { cid, username, password } }));
  const logout = async () => {
    try {
      await api('/auth/logout', { method: 'POST', body: {} });
    } catch {
      /* already gone */
    }
    store.token = null;
    setMe(null);
    setLocked(false);
    qc.clear();
  };
  const unlock = async (pin: string) => {
    await api('/auth/unlock', { body: { pin } });
    lastActivity.current = Date.now();
    setLocked(false);
  };

  // Activity lock: after N idle minutes, require the PIN again (session stays alive).
  useEffect(() => {
    if (!me) return;
    const mins = me.settings.security.activity_lock_min;
    if (!mins) return;
    const bump = () => (lastActivity.current = Date.now());
    const evs = ['pointerdown', 'keydown', 'touchstart'] as const;
    evs.forEach((e) => window.addEventListener(e, bump, { passive: true }));
    const iv = setInterval(() => {
      if (Date.now() - lastActivity.current > mins * 60_000) setLocked(true);
    }, 5_000);
    return () => {
      evs.forEach((e) => window.removeEventListener(e, bump));
      clearInterval(iv);
    };
  }, [me]);

  const can = useCallback((perm: string) => !!me && (me.user.permissions.includes('*') || me.user.permissions.includes(perm)), [me]);

  return (
    <Ctx.Provider value={{ me, loading, locked, can, loginPin, loginPassword, logout, unlock, lock: () => setLocked(true), refresh, authError }}>
      {children}
    </Ctx.Provider>
  );
}

export function useSession() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useSession outside SessionProvider');
  return c;
}
