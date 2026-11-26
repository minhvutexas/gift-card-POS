import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, EyeOff, LogOut, RefreshCw, Trash2 } from 'lucide-react';
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

async function papi<T>(path: string, body?: unknown, method?: 'PUT'): Promise<T> {
  const h: Record<string, string> = { Accept: 'application/json' };
  const t = getTok();
  if (t) h.Authorization = `Bearer ${t}`;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Can’t reach the server.');
  }
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, json?.code ?? `HTTP_${res.status}`, json?.message ?? 'Request failed');
  return json as T;
}

interface Salon {
  id: number;
  cid: string;
  slug: string;
  owner_username: string | null;
  name: string;
  status: 'ACTIVE' | 'SUSPENDED';
  owner_email: string | null;
  created_at: string;
  users: number;
  cards: number;
  outstanding: string;
  last_activity_at: string | null;
}

type Pending = { kind: 'suspend' | 'reactivate' | 'reset' | 'key' | 'delete'; salon: Salon };
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
  // reset-password + delete form state (fresh every time a dialog opens)
  const [pwMode, setPwMode] = useState<'keep' | 'auto' | 'custom'>('keep');
  const [newUsername, setNewUsername] = useState('');
  const [customPw, setCustomPw] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const open = (kind: Pending['kind'], salon: Salon) => {
    setPwMode('keep');
    setNewUsername(salon.owner_username ?? '');
    setCustomPw('');
    setShowPw(false);
    setConfirmText('');
    setActionErr(null);
    setPending({ kind, salon });
  };
  const close = () => (setPending(null), setActionErr(null));

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
        const custom = pwMode === 'custom';
        const renamed = newUsername.trim() && newUsername.trim() !== (p.salon.owner_username ?? '');
        const r = await papi<{ username: string; temporary_password?: string }>(`${base}/reset-owner`, {
          ...(renamed ? { username: newUsername.trim() } : {}),
          ...(custom ? { password: customPw } : {}),
          ...(pwMode === 'keep' ? { keep_password: true } : {}),
        });
        const lines: [string, string][] = [['CID', p.salon.cid], ['Username', r.username]];
        if (pwMode !== 'keep') lines.push(['Password', custom ? customPw : (r.temporary_password ?? '')]);
        return {
          title: `Owner login · ${p.salon.name}`,
          lines,
          note: pwMode === 'keep' ? 'Username saved. The password did not change.' : 'Shown once. Give these to the owner.',
        } as Secret;
      }
      if (p.kind === 'delete') {
        await papi(`${base}/delete`, { confirm: confirmText });
        return { title: 'Salon deleted', lines: [['Salon', p.salon.name], ['Salon ID', p.salon.slug]], note: 'Its cards, customers, staff, devices and history are gone. The Salon ID can be used again.' } as Secret;
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

  const rows = (list.data?.data ?? []).filter((s) => !filter || `${s.cid} ${s.name} ${s.slug} ${s.owner_email ?? ''} ${s.owner_username ?? ''}`.toLowerCase().includes(filter.toLowerCase()));
  const active = list.data?.data.filter((s) => s.status === 'ACTIVE').length ?? 0;

  const confirmCopy: Record<Pending['kind'], { title: string; body: string; cta: string; danger?: boolean }> = {
    suspend: { title: 'Suspend', body: 'Staff and customers of this salon can’t sign in or check balances until you reactivate it. No data is deleted.', cta: 'Suspend', danger: true },
    reactivate: { title: 'Reactivate', body: 'Staff can sign in again right away.', cta: 'Reactivate' },
    reset: { title: 'Owner login for', body: '', cta: 'Save', danger: false },
    delete: { title: 'Delete', body: '', cta: 'Delete salon forever', danger: true },
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
        <PlatformSettings />
        <div className="mb-4 max-w-sm">
          <label htmlFor="pf" className="mb-1 block text-sm font-semibold">
            Find a salon
          </label>
          <input id="pf" className={inputCls} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="CID, name, username or email" />
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
            <table className="w-full min-w-[980px] text-left text-sm">
              <thead className="border-b border-slate-200 text-slate-600 dark:border-slate-800 dark:text-slate-300">
                <tr>
                  <th className="px-4 py-3 font-semibold">CID</th>
                  <th className="px-4 py-3 font-semibold">Salon</th>
                  <th className="px-4 py-3 font-semibold">Owner username</th>
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
                    <td className="px-4 py-3 font-mono font-semibold tabular-nums">{s.cid}</td>
                    <td className="px-4 py-3">
                      <div className="font-semibold">{s.name}</div>
                      <div className="font-mono text-xs text-slate-600 dark:text-slate-400">{s.slug}</div>
                      {s.owner_email && <div className="text-xs text-slate-600 dark:text-slate-400">{s.owner_email}</div>}
                    </td>
                    <td className="px-4 py-3 font-mono">{s.owner_username ?? '—'}</td>
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
                        <Button variant="ghost" size="sm" onClick={() => open('reset', s)}>
                          Owner login
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => open('key', s)}>
                          New key
                        </Button>
                        {s.status === 'ACTIVE' ? (
                          <Button variant="ghost" size="sm" className="text-red-700 dark:text-red-400" onClick={() => open('suspend', s)}>
                            Suspend
                          </Button>
                        ) : (
                          <Button variant="secondary" size="sm" onClick={() => open('reactivate', s)}>
                            Reactivate
                          </Button>
                        )}
                        <Button variant="ghost" size="sm" className="text-red-700 dark:text-red-400" aria-label={`Delete ${s.name}`} title="Delete salon" onClick={() => open('delete', s)}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
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
        onClose={close}
        title={pending ? `${confirmCopy[pending.kind].title} ${pending.salon.name}?` : ''}
        footer={
          pending && (
            <>
              <Button variant="ghost" onClick={close}>
                Cancel
              </Button>
              <Button
                variant={confirmCopy[pending.kind].danger ? 'danger' : 'primary'}
                loading={act.isPending}
                disabled={(pending.kind === 'reset' &&
                    ((pwMode === 'custom' && customPw.length < 10) ||
                      !/^[A-Za-z0-9._-]{2,40}$/.test(newUsername.trim()) ||
                      (pwMode === 'keep' && newUsername.trim() === (pending.salon.owner_username ?? '')))) || (pending.kind === 'delete' && confirmText.trim().toLowerCase() !== pending.salon.slug)}
                onClick={() => act.mutate(pending)}
              >
                {confirmCopy[pending.kind].cta}
              </Button>
            </>
          )
        }
      >
        {pending && confirmCopy[pending.kind].body && <p className="text-slate-700 dark:text-slate-200">{confirmCopy[pending.kind].body}</p>}
        {pending?.kind === 'reset' && (
          <fieldset className="space-y-3">
            <legend className="sr-only">Owner sign-in</legend>
            <p className="text-sm text-slate-600 dark:text-slate-300">
              CID <span className="font-mono font-semibold">{pending.salon.cid}</span> · Passwords are stored scrambled, so nobody can read the current one — you can only set a new one.
            </p>
            <Field label="Username" htmlFor="ownu" hint="The owner signs in with the CID, this username and the password." error={newUsername && !/^[A-Za-z0-9._-]{2,40}$/.test(newUsername.trim()) ? 'Use 2–40 letters, numbers, dots, dashes or underscores.' : null}>
              <input id="ownu" className={`${inputCls} font-mono`} value={newUsername} onChange={(e) => setNewUsername(e.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} />
            </Field>
            <p className="pt-1 text-sm font-semibold">Password</p>
            <label className="flex items-center gap-2">
              <input type="radio" name="pwmode" checked={pwMode === 'keep'} onChange={() => setPwMode('keep')} />
              Keep the current password
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="pwmode" checked={pwMode === 'auto'} onChange={() => setPwMode('auto')} />
              Make a new password for me
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="pwmode" checked={pwMode === 'custom'} onChange={() => setPwMode('custom')} />
              I’ll type the new password
            </label>
            {pwMode === 'custom' && (
              <Field label="New password" htmlFor="npw" hint="At least 10 characters." error={customPw && customPw.length < 10 ? 'Too short — use at least 10 characters.' : null}>
                <div className="flex gap-2">
                  <input
                    id="npw"
                    type={showPw ? 'text' : 'password'}
                    className={inputCls}
                    value={customPw}
                    onChange={(e) => setCustomPw(e.target.value)}
                    autoComplete="new-password"
                        />
                  <Button variant="secondary" aria-label={showPw ? 'Hide password' : 'Show password'} title={showPw ? 'Hide password' : 'Show password'} onClick={() => setShowPw(!showPw)}>
                    {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </Button>
                </div>
              </Field>
            )}
          </fieldset>
        )}
        {pending?.kind === 'delete' && (
          <div className="space-y-3">
            <p className="rounded-xl bg-red-50 p-3 text-red-900 dark:bg-red-950/40 dark:text-red-200">
              This permanently deletes <strong>{pending.salon.name}</strong>: {pending.salon.cards} cards ({formatCents(Math.round(Number(pending.salon.outstanding) * 100))} still on them), all customers, staff, devices, history and backups. <strong>It can’t be undone.</strong>
            </p>
            <p className="text-sm text-slate-700 dark:text-slate-200">Just want to stop them for now? Use Suspend instead.</p>
            <Field label={<>Type <span className="font-mono">{pending.salon.slug}</span> to confirm</>} htmlFor="delconf">
              <input id="delconf" className={`${inputCls} font-mono`} value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} autoFocus />
            </Field>
          </div>
        )}
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

/** Platform-wide switches (apply to every salon). */
function PlatformSettings() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['platform-settings'], queryFn: () => papi<{ messaging: boolean }>('/platform/settings'), retry: false });
  const save = useMutation({
    mutationFn: (messaging: boolean) => papi<{ messaging: boolean }>('/platform/settings', { messaging }, 'PUT'),
    onSuccess: (v) => qc.setQueryData(['platform-settings'], v),
  });
  const on = !!q.data?.messaging;
  return (
    <section aria-labelledby="ps-h" className="mb-6 rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <h2 id="ps-h" className="text-base font-bold">
        Platform settings
      </h2>
      <div className="mt-3 flex items-start justify-between gap-4">
        <div>
          <p id="msg-label" className="font-semibold">
            Email &amp; SMS to customers
          </p>
          <p id="msg-desc" className="text-sm text-slate-600 dark:text-slate-300">
            {on
              ? 'On for all salons: the “Email / SMS” button, the Messaging settings tab and automatic messages (reload thanks, low balance, expiry reminders).'
              : 'Off for all salons. The Email / SMS button and Messaging settings are hidden, and no messages are sent.'}
          </p>
          {save.error && (
            <p role="alert" className="mt-1 text-sm text-red-700 dark:text-red-400">
              Couldn’t save: {(save.error as Error).message}
            </p>
          )}
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-labelledby="msg-label"
          aria-describedby="msg-desc"
          disabled={q.isLoading || save.isPending}
          onClick={() => save.mutate(!on)}
          className={`relative inline-flex h-8 w-14 shrink-0 items-center rounded-full transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:opacity-50 ${on ? 'bg-emerald-600' : 'bg-slate-300 dark:bg-slate-700'}`}
        >
          <span className={`inline-block h-6 w-6 rounded-full bg-white shadow transition-transform ${on ? 'translate-x-7' : 'translate-x-1'}`} />
        </button>
      </div>
    </section>
  );
}
