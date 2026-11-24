import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { KeyRound, MonitorSmartphone } from 'lucide-react';
import { api, ApiError, store } from '../../lib/api';
import { useSession } from '../../lib/session';
import { PinPad } from '../../components/Keypad';
import { Button, Field, inputCls } from '../../components/ui';

/** Shared-terminal login: tap your name → PIN. Password login for owners/remote. */
export function LoginPage() {
  const { loginPin, loginPassword, authError } = useSession();
  const users = useQuery({ queryKey: ['login-users'], queryFn: () => api<{ data: { id: number; name: string; role: string }[] }>('/auth/users'), retry: false });
  const [userId, setUserId] = useState<number | undefined>();
  const [pin, setPin] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'pin' | 'password' | 'pair'>(authError === 'TERMINAL_REQUIRED' || authError === 'TERMINAL_INVALID' ? 'pair' : 'pin');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [terminalKey, setTerminalKey] = useState(store.terminalKey ?? '');
  const needsPairing = users.error instanceof ApiError && users.error.code.startsWith('TERMINAL');

  const submitPin = async (p: string) => {
    setBusy(true);
    setErr(null);
    try {
      await loginPin(p, userId);
    } catch (e) {
      setPin('');
      setErr(e instanceof ApiError ? e.message : 'Login failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-brand-50 to-slate-100 p-4 dark:from-slate-950 dark:to-slate-900">
      <div className="w-full max-w-md rounded-3xl bg-white p-6 shadow-xl dark:bg-slate-900">
        <div className="mb-4 text-center">
          <div className="text-5xl" aria-hidden>
            🎁
          </div>
          <h1 className="mt-2 text-2xl font-bold">Gift Card POS</h1>
          {authError === 'SESSION_EXPIRED' && <p className="mt-1 text-sm text-amber-700">Your session ended — please sign in again.</p>}
        </div>

        {(mode === 'pair' || needsPairing) && (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              store.terminalKey = terminalKey.trim() || null;
              window.location.reload();
            }}
          >
            <p className="flex items-center gap-2 font-semibold">
              <MonitorSmartphone className="h-5 w-5" /> Pair this device
            </p>
            <p className="text-sm text-slate-600 dark:text-slate-300">Enter the terminal key from Settings › Terminal (shown once when the terminal was created).</p>
            <Field label="Terminal key" htmlFor="tk">
              <input id="tk" className={`${inputCls} font-mono`} value={terminalKey} onChange={(e) => setTerminalKey(e.target.value)} autoComplete="off" />
            </Field>
            <Button type="submit" className="w-full" disabled={!terminalKey.trim()}>
              Save & continue
            </Button>
            {!needsPairing && (
              <Button variant="ghost" className="w-full" onClick={() => setMode('pin')}>
                Back
              </Button>
            )}
          </form>
        )}

        {mode === 'pin' && !needsPairing && (
          <>
            {!!users.data?.data.length && (
              <div className="mb-4 grid grid-cols-3 gap-2" role="radiogroup" aria-label="Who is signing in?">
                {users.data.data.map((u) => (
                  <button
                    key={u.id}
                    role="radio"
                    aria-checked={userId === u.id}
                    onClick={() => {
                      setUserId(userId === u.id ? undefined : u.id);
                      setErr(null);
                    }}
                    className={`flex min-h-[72px] flex-col items-center justify-center rounded-2xl p-2 text-sm font-semibold ring-2 ring-inset ${userId === u.id ? 'bg-brand-600 text-white ring-brand-600' : 'ring-slate-200 hover:bg-slate-50 dark:ring-slate-700 dark:hover:bg-slate-800'}`}
                  >
                    <span className="text-lg">{u.name}</span>
                    <span className="text-xs opacity-75">{u.role}</span>
                  </button>
                ))}
              </div>
            )}
            <p className="mb-3 text-center text-slate-600 dark:text-slate-300">{userId ? 'Enter your PIN' : 'Tap your name, or just enter your PIN'}</p>
            <PinPad value={pin} onChange={setPin} onSubmit={submitPin} error={err} disabled={busy} />
            <div className="mt-4 flex justify-between">
              <Button variant="ghost" size="sm" onClick={() => setMode('password')}>
                <KeyRound className="h-4 w-4" /> Password login
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setMode('pair')}>
                Pair device
              </Button>
            </div>
          </>
        )}

        {mode === 'password' && !needsPairing && (
          <form
            className="space-y-3"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setErr(null);
              try {
                await loginPassword(username, password);
              } catch (x) {
                setErr(x instanceof ApiError ? x.message : 'Login failed');
              } finally {
                setBusy(false);
              }
            }}
          >
            <Field label="Username" htmlFor="u">
              <input id="u" className={inputCls} autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
            </Field>
            <Field label="Password" htmlFor="p" error={err}>
              <input id="p" type="password" className={inputCls} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <Button type="submit" className="w-full" loading={busy}>
              Sign in
            </Button>
            <Button variant="ghost" className="w-full" onClick={() => setMode('pin')}>
              Use PIN instead
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}

/** Activity lock overlay: same person re-enters PIN, or someone else switches user. */
export function LockScreen() {
  const { me, unlock, loginPin } = useSession();
  const [pin, setPin] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div role="dialog" aria-modal="true" aria-label="Screen locked" className="fixed inset-0 z-[150] flex items-center justify-center bg-slate-950/90 p-4 backdrop-blur">
      <div className="w-full max-w-sm rounded-3xl bg-white p-6 text-center dark:bg-slate-900">
        <p className="text-4xl" aria-hidden>
          🔒
        </p>
        <h2 className="mt-2 text-xl font-bold">Locked</h2>
        <p className="mb-4 text-slate-600 dark:text-slate-300">{me?.user.name}, enter your PIN — or another staff member can enter theirs to switch.</p>
        <PinPad
          value={pin}
          onChange={setPin}
          error={err}
          disabled={busy}
          onSubmit={async (p) => {
            setBusy(true);
            setErr(null);
            try {
              await unlock(p);
            } catch {
              try {
                await loginPin(p); // different staff member → switch user
              } catch (e) {
                setErr(e instanceof ApiError ? e.message : 'Incorrect PIN');
              }
            } finally {
              setPin('');
              setBusy(false);
            }
          }}
        />
      </div>
    </div>
  );
}
