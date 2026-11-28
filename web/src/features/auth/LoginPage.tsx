import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { KeyRound, Lock, MonitorSmartphone } from 'lucide-react';
import { Logo } from '../../components/Logo';
import { FeedbackDialog } from '../../components/Feedback';
import { api, ApiError, onTerminalKeyDropped, store } from '../../lib/api';
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
  const [paired, setPaired] = useState(!!store.terminalKey);
  const [keyRemoved, setKeyRemoved] = useState(false);
  useEffect(
    () =>
      onTerminalKeyDropped(() => {
        setPaired(false);
        setKeyRemoved(true);
        setMode('password');
      }),
    [],
  );
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
  // The CID is remembered on this device after a successful sign-in.
  const [cid, setCid] = useState(() => {
    try {
      return localStorage.getItem('gc.cid') ?? '';
    } catch {
      return '';
    }
  });
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [terminalKey, setTerminalKey] = useState(store.terminalKey ?? '');
  const [feedback, setFeedback] = useState(false);

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
    <div className="flex min-h-screen items-center justify-center p-4 bg-zinc-50 dark:bg-zinc-950">
      <div className="w-full max-w-md rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mb-4 text-center">
          <Link to="/welcome" aria-label="About Gift Card POS" className="mx-auto inline-flex">
            <Logo size="lg" />
          </Link>
          <h1 className="mt-3 text-xl font-semibold">{business.data?.name ?? 'Gift Card POS'}</h1>
          {business.data && <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">CID {business.data.cid}</p>}
          {authError === 'SESSION_EXPIRED' && <p className="mt-1 text-sm text-amber-700">Your session ended — please sign in again.</p>}
        </div>

        {keyRemoved && show === 'password' && (
          <p role="status" className="mb-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
            This device had an old front-desk key that no longer works, so it was removed. Owners can sign in below. To use this device at the front desk, set it up again with a new key.
          </p>
        )}

        {show === 'password' && (
          <form
            className="space-y-3"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setErr(null);
              try {
                const c = (cid.trim() || business.data?.cid || '').replace(/\D/g, '');
                await loginPassword(c, username.trim(), password);
                try {
                  localStorage.setItem('gc.cid', c.padStart(5, '0'));
                } catch {
                  /* private mode */
                }
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
            <Field label="CID" htmlFor="cid" hint="Your 5-digit client ID, e.g. 00012.">
              <input
                id="cid"
                inputMode="numeric"
                className={`${inputCls} font-mono tracking-widest`}
                value={cid || business.data?.cid || ''}
                onChange={(e) => (setCid(e.target.value.replace(/\D/g, '').slice(0, 5)), setErr(null))}
                autoComplete="organization"
                autoFocus={!cid}
              />
            </Field>
            <Field label="Username" htmlFor="u">
              <input id="u" className={inputCls} autoComplete="username" autoCapitalize="none" spellCheck={false} value={username} onChange={(e) => (setUsername(e.target.value), setErr(null))} autoFocus={!!cid} />
            </Field>
            <Field label="Password" htmlFor="p" error={err}>
              <input id="p" type="password" className={inputCls} autoComplete="current-password" value={password} onChange={(e) => (setPassword(e.target.value), setErr(null))} />
            </Field>
            <Button type="submit" className="w-full" loading={busy} disabled={!(cid || business.data?.cid) || !username.trim() || !password}>
              Sign in
            </Button>
            {paired && !keyBroken ? (
              <Button variant="ghost" className="w-full" onClick={() => (setMode('pin'), setErr(null))}>
                Staff: use PIN instead
              </Button>
            ) : (
              <p className="pt-1 text-center text-sm text-zinc-600 dark:text-zinc-300">
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
            <p className="text-sm text-zinc-600 dark:text-zinc-300">
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
                    className={`flex min-h-[72px] flex-col items-center justify-center rounded-xl p-2 text-sm font-semibold ring-2 ring-inset ${userId === u.id ? 'bg-zinc-900 text-white ring-zinc-900 dark:bg-white dark:text-zinc-900 dark:ring-white' : 'ring-zinc-200 hover:bg-zinc-50 dark:ring-zinc-700 dark:hover:bg-zinc-800'}`}
                  >
                    <span className="text-lg">{u.name}</span>
                    <span className="text-xs opacity-75">{u.role}</span>
                  </button>
                ))}
              </div>
            )}
            {users.data && !users.data.data.length && (
              <p className="mb-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                No staff PINs yet. The owner signs in with their password and adds staff in Settings › Security.
              </p>
            )}
            <p className="mb-3 text-center text-zinc-600 dark:text-zinc-300">{userId ? 'Enter your PIN' : 'Tap your name, or just enter your PIN'}</p>
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

        <p className="mt-6 border-t border-zinc-200 pt-4 text-center text-sm text-zinc-600 dark:border-zinc-700 dark:text-zinc-300">
          New salon?{' '}
          <Link to="/signup" className="font-semibold text-brand-700 underline-offset-2 hover:underline dark:text-brand-300">
            Create your account
          </Link>
          {' · '}
          <button type="button" onClick={() => setFeedback(true)} className="font-semibold text-brand-700 underline-offset-2 hover:underline dark:text-brand-300">
            Feedback & support
          </button>
        </p>
        <FeedbackDialog open={feedback} onClose={() => setFeedback(false)} />
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
    <div role="dialog" aria-modal="true" aria-label="Screen locked" className="fixed inset-0 z-[150] flex items-center justify-center bg-zinc-950/90 p-4">
      <div className="w-full max-w-sm rounded-xl bg-white p-6 text-center dark:bg-zinc-900">
        <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200" aria-hidden>
          <Lock className="h-6 w-6" />
        </span>
        <h2 className="mt-3 text-xl font-semibold">Locked</h2>
        <p className="mb-4 text-zinc-600 dark:text-zinc-300">{me?.user.name}, enter your PIN — or another staff member can enter theirs to switch.</p>
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
