import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CreditCard, Lock, ShieldAlert } from 'lucide-react';
import { api, ApiError, setBusinessOverride } from '../../lib/api';
import { formatCents, signedCents } from '../../lib/money';
import { STATUS } from '../../lib/status';
import type { CardStatus } from '../../lib/types';
import { Button, StatusPill } from '../../components/ui';
import { PinPad } from '../../components/Keypad';

interface KioskView {
  card_masked: string;
  status: CardStatus;
  balance_cents: number;
  currency: string;
  expires_at: string | null;
  can_report_lost: boolean;
  transactions: { date: string; type: string; amount_cents: number }[];
}

const IDLE_RESET_MS = 60_000;

/**
 * Customer self-service (public). Number + PIN, or the QR link on a receipt.
 * Shows only masked number, balance and the last 5 transactions; the API
 * rate-limits and returns one generic error for wrong number/PIN.
 */
export function KioskPage() {
  // /k/:slug names the salon; plain /kiosk uses this device's terminal key / Salon ID.
  const { slug } = useParams();
  setBusinessOverride(slug ?? null);
  useEffect(() => () => setBusinessOverride(null), []);
  const salon = useQuery({ queryKey: ['business', slug ?? ''], queryFn: () => api<{ slug: string; name: string }>('/business'), retry: false });
  const [params, setParams] = useSearchParams();
  const token = params.get('t');
  const [step, setStep] = useState<'number' | 'pin' | 'view'>(token ? 'view' : 'number');
  const [number, setNumber] = useState('');
  const [pin, setPin] = useState('');
  const [view, setView] = useState<KioskView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [panel, setPanel] = useState<'none' | 'lost'>('none');
  const [msg, setMsg] = useState<string | null>(null);
  const creds = useRef<{ number?: string; pin?: string; token?: string }>({});
  const idle = useRef<number>(0);

  const reset = useCallback(() => {
    setStep('number');
    setNumber('');
    setPin('');
    setView(null);
    setErr(null);
    setPanel('none');
    setMsg(null);
    creds.current = {};
    if (params.get('t')) setParams({}, { replace: true });
  }, [params, setParams]);

  // Shared kiosk: wipe the screen after a minute of inactivity.
  useEffect(() => {
    const bump = () => {
      window.clearTimeout(idle.current);
      idle.current = window.setTimeout(reset, IDLE_RESET_MS);
    };
    bump();
    ['pointerdown', 'keydown'].forEach((e) => window.addEventListener(e, bump));
    return () => {
      window.clearTimeout(idle.current);
      ['pointerdown', 'keydown'].forEach((e) => window.removeEventListener(e, bump));
    };
  }, [reset]);

  const lookup = async (body: { number?: string; pin?: string; token?: string }) => {
    setBusy(true);
    setErr(null);
    try {
      const v = await api<KioskView>('/kiosk/lookup', { body });
      creds.current = body;
      setView(v);
      setStep('view');
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Something went wrong');
      setPin('');
      if (body.token) setStep('number');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (token) lookup({ token });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const reportLost = async () => {
    setBusy(true);
    try {
      const r = await api<KioskView & { message: string }>('/kiosk/report-lost', { body: creds.current });
      setView(r);
      setPanel('none');
      setMsg(r.message);
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : 'Could not report');
    } finally {
      setBusy(false);
    }
  };

  const salonCode = salon.error instanceof ApiError ? salon.error.code : null;
  if (salonCode === 'BUSINESS_NOT_FOUND' || salonCode === 'BUSINESS_SUSPENDED')
    return (
      <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-brand-50 via-white to-pink-100 p-4 text-center dark:from-slate-950 dark:via-slate-900 dark:to-brand-950 dark:text-white">
        <main className="max-w-md rounded-3xl bg-white p-6 shadow-xl dark:bg-slate-900">
          <h1 className="text-2xl font-bold">{salonCode === 'BUSINESS_NOT_FOUND' ? 'We can’t find this salon' : 'Balance check is unavailable'}</h1>
          <p className="mt-2 text-slate-600 dark:text-slate-300">
            {salonCode === 'BUSINESS_NOT_FOUND' ? 'Check the link on your receipt, or ask the front desk for your balance.' : 'Please ask the front desk for your balance.'}
          </p>
        </main>
      </div>
    );

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-br from-brand-50 via-white to-pink-100 p-4 text-slate-900 dark:from-slate-950 dark:via-slate-900 dark:to-brand-950 dark:text-white">
      <main className="w-full max-w-md">
        <header className="mb-6 text-center">
          <div className="text-6xl" aria-hidden>
            🎁
          </div>
          {salon.data && <p className="mt-2 text-lg font-semibold text-brand-700 dark:text-brand-300">{salon.data.name}</p>}
          <h1 className="mt-1 text-3xl font-extrabold">Check your gift card</h1>
        </header>

        <div className="rounded-3xl bg-white p-6 shadow-xl dark:bg-slate-900">
          {step === 'number' && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (number.trim().length >= 4) {
                  setErr(null);
                  setStep('pin');
                }
              }}
              className="space-y-4"
            >
              <label htmlFor="k-num" className="block text-center text-lg font-semibold">
                Card number
              </label>
              <input
                id="k-num"
                autoFocus
                inputMode="numeric"
                autoComplete="off"
                className="block w-full min-h-[64px] rounded-2xl border-0 text-center font-mono text-3xl tracking-widest ring-2 ring-slate-300 focus:ring-4 focus:ring-brand-500 dark:bg-slate-800 dark:ring-slate-600"
                value={number}
                onChange={(e) => setNumber(e.target.value.replace(/[^0-9A-Za-z]/g, '').toUpperCase())}
                aria-describedby="k-hint"
              />
              <p id="k-hint" className="text-center text-sm text-slate-500">
                Or scan the QR code on your receipt with your phone camera.
              </p>
              {err && (
                <p role="alert" className="text-center font-semibold text-red-600">
                  {err}
                </p>
              )}
              <Button type="submit" size="xl" className="w-full" disabled={number.trim().length < 4}>
                Next
              </Button>
            </form>
          )}

          {step === 'pin' && (
            <div className="space-y-4">
              <p className="flex items-center justify-center gap-2 text-center text-lg font-semibold">
                <Lock className="h-5 w-5" /> Enter your card PIN
              </p>
              <PinPad value={pin} onChange={setPin} onSubmit={(p) => lookup({ number, pin: p })} error={err} disabled={busy} />
              <Button variant="ghost" className="w-full" onClick={() => (setStep('number'), setPin(''), setErr(null))}>
                Back
              </Button>
              <p className="text-center text-xs text-slate-500">No PIN? Ask at the front desk.</p>
            </div>
          )}

          {step === 'view' && !view && <p className="py-10 text-center text-slate-500">{err ?? 'Loading…'}</p>}

          {step === 'view' && view && (
            <div className="space-y-5">
              <div className="rounded-2xl bg-gradient-to-br from-brand-600 to-brand-800 p-5 text-white">
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-2 font-mono text-xl tracking-widest">
                    <CreditCard className="h-5 w-5" aria-hidden /> {view.card_masked}
                  </span>
                  <span className="rounded-full bg-white p-0.5">
                    <StatusPill status={view.status} size="sm" />
                  </span>
                </div>
                <p className="mt-4 text-sm opacity-80">Available balance</p>
                <p className="text-6xl font-extrabold tabular-nums" aria-live="polite">
                  {formatCents(view.balance_cents, view.currency)}
                </p>
                {view.expires_at && <p className="mt-1 text-sm opacity-80">Expires {new Date(view.expires_at).toLocaleDateString()}</p>}
              </div>

              {view.status === 'FROZEN' && <p className="rounded-xl bg-sky-50 p-3 text-sky-900 dark:bg-sky-950 dark:text-sky-100">❄ {STATUS.FROZEN.hint}. Please see the front desk.</p>}
              {msg && (
                <p role="status" className="rounded-xl bg-emerald-50 p-3 font-semibold text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100">
                  {msg}
                </p>
              )}

              <section aria-labelledby="k-recent">
                <h2 id="k-recent" className="mb-2 font-bold">
                  Recent activity
                </h2>
                <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                  {view.transactions.map((t, i) => (
                    <li key={i} className="flex justify-between py-2">
                      <span>
                        {t.type}
                        <span className="block text-xs text-slate-500">{new Date(t.date).toLocaleDateString()}</span>
                      </span>
                      <span className={`font-semibold tabular-nums ${t.amount_cents > 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-slate-700 dark:text-slate-200'}`}>{signedCents(t.amount_cents)}</span>
                    </li>
                  ))}
                </ul>
              </section>

              {panel === 'lost' && (
                <div className="space-y-2 rounded-2xl bg-red-50 p-4 text-red-900 dark:bg-red-950 dark:text-red-100">
                  <p className="font-semibold">Freeze this card now?</p>
                  <p className="text-sm">Nobody will be able to use it. The front desk can move your balance to a new card.</p>
                  <div className="flex gap-2">
                    <Button variant="secondary" onClick={() => setPanel('none')}>
                      Cancel
                    </Button>
                    <Button variant="danger" loading={busy} onClick={reportLost}>
                      Yes, freeze it
                    </Button>
                  </div>
                </div>
              )}

              <p className="text-center text-sm text-slate-500">To add money to your card, please visit the front desk.</p>
              {view.can_report_lost && (
                <Button size="lg" variant="secondary" className="w-full" onClick={() => setPanel(panel === 'lost' ? 'none' : 'lost')}>
                  <ShieldAlert className="h-5 w-5" /> Report lost
                </Button>
              )}
              <Button variant="ghost" size="lg" className="w-full" onClick={reset}>
                Done
              </Button>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
