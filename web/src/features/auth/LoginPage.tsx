import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { KeyRound, MonitorSmartphone } from 'lucide-react';
import { api, ApiError, store } from '../../lib/api';
import { useSession } from '../../lib/session';
import { PinPad } from '../../components/Keypad';
import { Button, Field, inputCls } from '../../components/ui';

/**
 * Two ways in:
 *  - Paired front-desk device (has a terminal key): staff tap their name → PIN.
 *  - Any other device: the salon OWNER signs in with username + password.
 *    No Salon ID needed — owner usernames are unique, so the username finds the salon.
 */
export function LoginPage() {
  const { loginPin, loginPassword, authError } = useSession();
  const paired = !!store.terminalKey;
  const [mode, setMode] = useState<'pin' | 'password' | 'pair'>(
    authError === 'TERMINAL_INVALID' ? 'pair' : paired ? 'pin' : 'password',
  );
  const users = useQuery({
    queryKey: ['login-users'],
    queryFn: () => api<{ data: { id: number; name: string; role: string }[] }>('/auth/users'),
    retry: false,
    enabled: paired,
  });
  const business = useQuery({ queryKey: ['business'], queryFn: () => api<{ cid: string; slug: string; name: string }>('/business'), retry: false, enabled: paired });
  const keyBroken = paired && users.error instanceof ApiError && users.error.code.startsWith('TERMINAL');

  const [userId, setUserId] = useState<number | undefined>();
  const [pin, setPin] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [terminalKey, setTerminalKey] = useState(store.terminalKey ?? '');

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

  const show = keyBroken && mode === 'pin' ? 'pair' : mode;

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-brand-50 to-slate-100 p-4 dark:from-slate-950 dark:to-slate-900">
      <div className="w-full max-w-md rounded-3xl bg-white p-6 shadow-xl dark:bg-slate-900">
        <div className="mb-4 text-center">
          <div className="text-5xl" aria-hidden>
            🎁
          </div>
          <h1 className="mt-2 text-2xl font-bold">{business.data?.name ?? 'Gift Card POS'}</h1>
          {business.data && <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">CID {business.data.cid}</p>}
          {authError === 'SESSION_EXPIRED' && <p className="mt-1 text-sm text-amber-700">Your session ended — please sign in again.</p>}
        </div>

        {show === 'password' && (
          <form
            className="space-y-3"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setErr(null);
              try {
                await loginPassword(username.trim(), password);
              } catch (x) {
                setErr(x instanceof ApiError ? x.message : 'Login failed');
              } finally {
                setBusy(false);
              }
            }}
          >
            <p className="flex items-center gap-2 font-semibold">
              <KeyRound className="h-5 w-5" aria-hidden /> Owner sign-in
            </p>
            <Field label="Username" htmlFor="u">
              <input id="u" className={inputCls} autoComplete="username" autoCapitalize="none" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
            </Field>
            <Field label="Password" htmlFor="p" error={err}>
              <input id="p" type="password" className={inputCls} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <Button type="submit" className="w-full" loading={busy} disabled={!username.trim() || !password}>
              Sign in
            </Button>
            {paired && !keyBroken ? (
              <Button variant="ghost" className="w-full" onClick={() => (setMode('pin'), setErr(null))}>
                Staff: use PIN instead
              </Button>
            ) : (
              <p className="pt-1 text-center text-sm text-slate-600 dark:text-slate-300">
                Staff sign in with a PIN on the front-desk device.{' '}
                <button type="button" className="font-semibold text-brand-700 underline-offset-2 hover:underline dark:text-brand-300" onClick={() => (setMode('pair'), setErr(null))}>
                  Set up this device as a front desk
                </button>
              </p>
            )}
          </form>
        )}

        {show === 'pair' && (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              store.terminalKey = terminalKey.trim() || null;
              window.location.reload();
            }}
          >
            <p className="flex items-center gap-2 font-semibold">
              <MonitorSmartphone className="h-5 w-5" aria-hidden /> Set up a front-desk device
            </p>
            <p className="text-sm text-slate-600 dark:text-slate-300">
              {keyBroken ? 'This device’s key no longer works. ' : ''}Enter a terminal key. The owner creates one in Settings › Terminal.
            </p>
            <Field label="Terminal key" htmlFor="tk">
              <input id="tk" className={`${inputCls} font-mono`} value={terminalKey} onChange={(e) => setTerminalKey(e.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} />
            </Field>
            <Button type="submit" className="w-full" disabled={!terminalKey.trim()}>
              Save & continue
            </Button>
            <Button variant="ghost" className="w-full" onClick={() => setMode('password')}>
              Owner sign-in instead
            </Button>
          </form>
        )}

        {show === 'pin' && (
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
            {users.data && !users.data.data.length && (
              <p className="mb-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                No staff PINs yet. The owner signs in with their password and adds staff in Settings › Security.
              </p>
            )}
            <p className="mb-3 text-center text-slate-600 dark:text-slate-300">{userId ? 'Enter your PIN' : 'Tap your name, or just enter your PIN'}</p>
            <PinPad value={pin} onChange={setPin} onSubmit={submitPin} error={err} disabled={busy} />
            <div className="mt-4 flex justify-between">
              <Button variant="ghost" size="sm" onClick={() => (setMode('password'), setErr(null))}>
                <KeyRound className="h-4 w-4" /> Owner sign-in
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setMode('pair')}>
                Change device key
              </Button>
            </div>
          </>
        )}

        <p className="mt-6 border-t border-slate-200 pt-4 text-center text-sm text-slate-600 dark:border-slate-700 dark:text-slate-300">
          New salon?{' '}
          <Link to="/signup" className="font-semibold text-brand-700 underline-offset-2 hover:underline dark:text-brand-300">
            Create your account
          </Link>
        </p>
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
