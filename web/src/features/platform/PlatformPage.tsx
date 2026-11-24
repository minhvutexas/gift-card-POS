import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LogOut, RefreshCw } from 'lucide-react';
import { API_BASE, ApiError } from '../../lib/api';
import { formatCents } from '../../lib/money';
import { Button, EmptyState, Field, Modal, SkeletonRows, fmtDate, fmtDateTime, inputCls } from '../../components/ui';

/**
 * Platform admin (whoever runs the server). Its own login and token — never
 * mixed with a salon session. Lists salons; suspend/reactivate; recover a
 * locked-out owner. It cannot open a salon's cards.
 */
const TOKEN = 'gc.platform';
const getTok = () => {
  try {
    return sessionStorage.getItem(TOKEN);
  } catch {
    return null;
  }
};
const setTok = (v: string | null) => {
  try {
    if (v) sessionStorage.setItem(TOKEN, v);
    else sessionStorage.removeItem(TOKEN);
  } catch {
    /* private mode: stays logged in for this page only */
  }
};

async function papi<T>(path: string, body?: unknown): Promise<T> {
  const h: Record<string, string> = { Accept: 'application/json' };
  const t = getTok();
  if (t) h.Authorization = `Bearer ${t}`;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Can’t reach the server.');
  }
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, json?.code ?? `HTTP_${res.status}`, json?.message ?? 'Request failed');
  return json as T;
}

interface Salon {
  id: number;
  slug: string;
  name: string;
  status: 'ACTIVE' | 'SUSPENDED';
  owner_email: string | null;
  created_at: string;
  users: number;
  cards: number;
  outstanding: string;
  last_activity_at: string | null;
}

type Pending = { kind: 'suspend' | 'reactivate' | 'reset' | 'key'; salon: Salon };
type Secret = { title: string; lines: [string, string][]; note: string };

export function PlatformPage() {
  const [authed, setAuthed] = useState(!!getTok());
  return authed ? <Salons onLogout={() => (setTok(null), setAuthed(false))} /> : <PlatformLogin onDone={() => setAuthed(true)} />;
}

function PlatformLogin({ onDone }: { onDone: () => void }) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await papi<{ token: string }>('/platform/login', { password: pw });
      setTok(r.token);
      onDone();
    } catch (x) {
      setErr(x instanceof ApiError ? x.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 p-4 dark:bg-slate-950">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-3xl bg-white p-6 shadow-xl dark:bg-slate-900">
        <h1 className="text-xl font-bold">Platform admin</h1>
        <Field label="Platform password" htmlFor="ppw" error={err} hint="PLATFORM_ADMIN_PASSWORD in the server’s .env">
          <input id="ppw" type="password" className={inputCls} value={pw} onChange={(e) => (setPw(e.target.value), setErr(null))} autoComplete="current-password" autoFocus />
        </Field>
        <Button type="submit" className="w-full" loading={busy} disabled={!pw}>
          Sign in
        </Button>
      </form>
    </div>
  );
}

function Salons({ onLogout }: { onLogout: () => void }) {
  const qc = useQueryClient();
  const [filter, setFilter] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const [secret, setSecret] = useState<Secret | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ['platform-salons'],
    queryFn: () => papi<{ data: Salon[] }>('/platform/businesses'),
    retry: false,
  });
  const expired = list.error instanceof ApiError && list.error.status === 401;
  useEffect(() => {
    if (expired) onLogout();
  }, [expired, onLogout]);

  const act = useMutation({
    mutationFn: async (p: Pending) => {
      const base = `/platform/businesses/${p.salon.id}`;
      if (p.kind === 'suspend' || p.kind === 'reactivate') {
        await papi(`${base}/status`, { status: p.kind === 'suspend' ? 'SUSPENDED' : 'ACTIVE' });
        return null;
      }
      if (p.kind === 'reset') {
        const r = await papi<{ username: string; temporary_password: string }>(`${base}/reset-owner`, {});
        return { title: `New owner password · ${p.salon.name}`, lines: [['Salon ID', p.salon.slug], ['Username', r.username], ['Temporary password', r.temporary_password]], note: 'Shown once. Read it to the owner and ask them to change it.' } as Secret;
      }
      const r = await papi<{ code: string; api_key: string }>(`${base}/terminal-key`, {});
      return { title: `Recovery terminal key · ${p.salon.name}`, lines: [['Terminal', r.code], ['Key', r.api_key]], note: 'Shown once. The owner enters it under Pair device on the sign-in screen.' } as Secret;
    },
    onSuccess: (s) => {
      setPending(null);
      setActionErr(null);
      if (s) setSecret(s);
      qc.invalidateQueries({ queryKey: ['platform-salons'] });
    },
    onError: (e) => setActionErr(e instanceof ApiError ? e.message : 'That didn’t work. Try again.'),
  });

  const rows = (list.data?.data ?? []).filter((s) => !filter || `${s.name} ${s.slug} ${s.owner_email ?? ''}`.toLowerCase().includes(filter.toLowerCase()));
  const active = list.data?.data.filter((s) => s.status === 'ACTIVE').length ?? 0;

  const confirmCopy: Record<Pending['kind'], { title: string; body: string; cta: string; danger?: boolean }> = {
    suspend: { title: 'Suspend', body: 'Staff and customers of this salon can’t sign in or check balances until you reactivate it. No data is deleted.', cta: 'Suspend', danger: true },
    reactivate: { title: 'Reactivate', body: 'Staff can sign in again right away.', cta: 'Reactivate' },
    reset: { title: 'Reset owner password for', body: 'The owner’s current password stops working. You get a one-time password to give them.', cta: 'Reset password', danger: true },
    key: { title: 'New terminal key for', body: 'Creates a new paired device called “Recovery device”. The salon can switch it off in Settings › Terminal.', cta: 'Create key' },
  };

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-900">
        <h1 className="text-lg font-bold">Platform admin</h1>
        <span className="text-sm text-slate-600 dark:text-slate-300">
          {list.data ? `${list.data.data.length} salons · ${active} active` : ''}
        </span>
        <div className="ml-auto flex gap-2">
          <Button variant="ghost" size="sm" aria-label="Refresh" title="Refresh" onClick={() => list.refetch()}>
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="sm" onClick={onLogout}>
            <LogOut className="h-4 w-4" /> Sign out
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-6xl p-4">
        <div className="mb-4 max-w-sm">
          <label htmlFor="pf" className="mb-1 block text-sm font-semibold">
            Find a salon
          </label>
          <input id="pf" className={inputCls} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Name, Salon ID or email" />
        </div>

        {list.isLoading ? (
          <SkeletonRows rows={5} />
        ) : list.error ? (
          <p role="alert" className="rounded-xl bg-red-50 p-3 text-red-800 dark:bg-red-950/40 dark:text-red-200">
            Couldn’t load salons: {(list.error as Error).message}{' '}
            <button className="font-semibold underline" onClick={() => list.refetch()}>
              Try again
            </button>
          </p>
        ) : !rows.length ? (
          <EmptyState icon={<span aria-hidden>🏪</span>} title={filter ? 'No salon matches' : 'No salons yet'}>
            {filter ? 'Try another name or Salon ID.' : 'Salons appear here when they sign up at /signup.'}
          </EmptyState>
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="border-b border-slate-200 text-slate-600 dark:border-slate-800 dark:text-slate-300">
                <tr>
                  <th className="px-4 py-3 font-semibold">Salon</th>
                  <th className="px-4 py-3 font-semibold">Status</th>
                  <th className="px-4 py-3 text-right font-semibold">Cards</th>
                  <th className="px-4 py-3 text-right font-semibold">Outstanding</th>
                  <th className="px-4 py-3 font-semibold">Last activity</th>
                  <th className="px-4 py-3 font-semibold">Joined</th>
                  <th className="px-4 py-3">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.id} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
                    <td className="px-4 py-3">
                      <div className="font-semibold">{s.name}</div>
                      <div className="font-mono text-xs text-slate-600 dark:text-slate-400">{s.slug}</div>
                      {s.owner_email && <div className="text-xs text-slate-600 dark:text-slate-400">{s.owner_email}</div>}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${s.status === 'ACTIVE' ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300' : 'bg-amber-50 text-amber-900 dark:bg-amber-950/50 dark:text-amber-300'}`}>
                        {s.status === 'ACTIVE' ? 'Active' : 'Suspended'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{s.cards}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{formatCents(Math.round(Number(s.outstanding) * 100))}</td>
                    <td className="px-4 py-3">{s.last_activity_at ? fmtDateTime(s.last_activity_at) : '—'}</td>
                    <td className="px-4 py-3">{fmtDate(s.created_at)}</td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => setPending({ kind: 'reset', salon: s })}>
                          Reset owner
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setPending({ kind: 'key', salon: s })}>
                          New key
                        </Button>
                        {s.status === 'ACTIVE' ? (
                          <Button variant="ghost" size="sm" className="text-red-700 dark:text-red-400" onClick={() => setPending({ kind: 'suspend', salon: s })}>
                            Suspend
                          </Button>
                        ) : (
                          <Button variant="secondary" size="sm" onClick={() => setPending({ kind: 'reactivate', salon: s })}>
                            Reactivate
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>

      <Modal
        open={!!pending}
        onClose={() => (setPending(null), setActionErr(null))}
        title={pending ? `${confirmCopy[pending.kind].title} ${pending.salon.name}?` : ''}
        footer={
          pending && (
            <>
              <Button variant="ghost" onClick={() => (setPending(null), setActionErr(null))}>
                Cancel
              </Button>
              <Button variant={confirmCopy[pending.kind].danger ? 'danger' : 'primary'} loading={act.isPending} onClick={() => act.mutate(pending)}>
                {confirmCopy[pending.kind].cta}
              </Button>
            </>
          )
        }
      >
        {pending && <p className="text-slate-700 dark:text-slate-200">{confirmCopy[pending.kind].body}</p>}
        {actionErr && (
          <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-400">
            {actionErr}
          </p>
        )}
      </Modal>

      <Modal open={!!secret} onClose={() => setSecret(null)} title={secret?.title ?? ''} dismissable={false} footer={<Button onClick={() => setSecret(null)}>I’ve saved it</Button>}>
        {secret && (
          <div className="space-y-3">
            {secret.lines.map(([k, v]) => (
              <div key={k}>
                <div className="text-sm font-semibold text-slate-600 dark:text-slate-300">{k}</div>
                <code className="block break-all rounded-xl bg-slate-100 px-3 py-2 font-mono dark:bg-slate-800">{v}</code>
              </div>
            ))}
            <p className="text-sm text-slate-600 dark:text-slate-300">{secret.note}</p>
          </div>
        )}
      </Modal>
    </div>
  );
}
