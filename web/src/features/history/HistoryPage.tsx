import { useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { Download, FileText, History, MonitorSmartphone, User } from 'lucide-react';
import { api, download } from '../../lib/api';
import { formatCents, signedCents } from '../../lib/money';
import { useSession } from '../../lib/session';
import { actionLabel } from '../../lib/status';
import type { Card, HistoryRow } from '../../lib/types';
import { Button, EmptyState, inputCls, SkeletonRows } from '../../components/ui';
import { useCardActions } from '../cards/CardActions';

const TXN_ACTIONS = ['ISSUE', 'ACTIVATE', 'RELOAD', 'REDEEM', 'TIP_FROM_CARD', 'REFUND_TO_CARD', 'ADJUSTMENT', 'TRANSFER_OUT', 'TRANSFER_IN', 'MERGE_OUT', 'MERGE_IN', 'VOID', 'EXPIRE', 'REPLACE_OUT', 'REPLACE_IN', 'REVERSAL'];

/** 📜 Append-only history, grouped by day; amounts +green / −red with running balance. */
export function HistoryPage() {
  const { me, can } = useSession();
  const tz = me?.settings.general.timezone;
  const { open } = useCardActions();
  const [params, setParams] = useSearchParams();
  const f = {
    from: params.get('from') ?? '',
    to: params.get('to') ?? '',
    actor_id: params.get('actor_id') ?? '',
    action: params.get('action') ?? '',
    card: params.get('card') ?? '',
    kind: params.get('kind') ?? '',
  };
  const [page, setPage] = useState(1);
  const set = (k: string, v: string) => {
    const p = new URLSearchParams(params);
    v ? p.set(k, v) : p.delete(k);
    setParams(p, { replace: true });
    setPage(1);
  };

  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (f.from) p.set('from', new Date(`${f.from}T00:00:00`).toISOString());
    if (f.to) p.set('to', new Date(new Date(`${f.to}T00:00:00`).getTime() + 86400000).toISOString());
    if (f.actor_id) p.set('actor_id', f.actor_id);
    if (f.action) p.set('action', f.action);
    if (f.card) p.set('card', f.card.trim());
    if (f.kind) p.set('kind', f.kind);
    return p;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  const users = useQuery({ queryKey: ['users'], queryFn: () => api<{ data: { id: number; name: string }[] }>('/users'), enabled: can('settings.read') });
  const actions = useQuery({ queryKey: ['history', 'actions'], queryFn: () => api<{ data: string[] }>('/history/actions') });
  const q = useQuery({
    queryKey: ['history', qs.toString(), page],
    queryFn: () => api<{ data: HistoryRow[]; meta: { total: number; per_page: number } }>(`/history?${qs}&page=${page}&per_page=100`),
    placeholderData: keepPreviousData,
  });

  const groups = useMemo(() => {
    const m = new Map<string, HistoryRow[]>();
    for (const r of q.data?.data ?? []) {
      const day = new Date(r.occurred_at).toLocaleDateString('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
      if (!m.has(day)) m.set(day, []);
      m.get(day)!.push(r);
    }
    return [...m.entries()];
  }, [q.data, tz]);

  const otherActions = (actions.data?.data ?? []).filter((a) => !TXN_ACTIONS.includes(a));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">📜 History log</h1>
          <p className="text-slate-500">Every money movement and card event. Append-only — entries can never be edited or deleted.</p>
        </div>
        {can('history.export') && (
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => download(`/history/export.csv?${qs}`, 'history.csv')}>
              <Download className="h-5 w-5" /> CSV
            </Button>
            <Button variant="secondary" onClick={() => download(`/history/export.pdf?${qs}`, 'history.pdf')}>
              <FileText className="h-5 w-5" /> PDF
            </Button>
          </div>
        )}
      </div>

      <form className="grid gap-2 rounded-2xl bg-white p-3 shadow-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800 sm:grid-cols-3 lg:grid-cols-6" onSubmit={(e) => e.preventDefault()} aria-label="History filters">
        <label className="text-sm font-semibold">
          From
          <input type="date" className={inputCls} value={f.from} onChange={(e) => set('from', e.target.value)} />
        </label>
        <label className="text-sm font-semibold">
          To
          <input type="date" className={inputCls} value={f.to} onChange={(e) => set('to', e.target.value)} />
        </label>
        <label className="text-sm font-semibold">
          Card #
          <input className={`${inputCls} font-mono`} value={f.card} onChange={(e) => set('card', e.target.value.toUpperCase())} placeholder="Any" />
        </label>
        <label className="text-sm font-semibold">
          Action
          <select className={inputCls} value={f.action} onChange={(e) => set('action', e.target.value)}>
            <option value="">All actions</option>
            <option value="REDEEM,TIP_FROM_CARD">Redemptions</option>
            <option value="ISSUE,ACTIVATE,RELOAD">Sales & reloads</option>
            <optgroup label="Money">
              {TXN_ACTIONS.map((a) => (
                <option key={a} value={a}>
                  {actionLabel(a)}
                </option>
              ))}
            </optgroup>
            <optgroup label="Events">
              {otherActions.map((a) => (
                <option key={a} value={a}>
                  {actionLabel(a)} ({a})
                </option>
              ))}
            </optgroup>
          </select>
        </label>
        <label className="text-sm font-semibold">
          Staff
          <select className={inputCls} value={f.actor_id} onChange={(e) => set('actor_id', e.target.value)}>
            <option value="">Everyone</option>
            {users.data?.data.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm font-semibold">
          Type
          <select className={inputCls} value={f.kind} onChange={(e) => set('kind', e.target.value)}>
            <option value="">Money + events</option>
            <option value="TXN">Money only</option>
            <option value="AUDIT">Events only</option>
          </select>
        </label>
      </form>

      {q.isLoading ? (
        <SkeletonRows rows={8} />
      ) : !groups.length ? (
        <EmptyState icon={<History className="h-12 w-12" />} title="No history for these filters">
          Try widening the date range or clearing filters.
        </EmptyState>
      ) : (
        <div className="space-y-6">
          {groups.map(([day, rows]) => (
            <section key={day} aria-label={day}>
              <h2 className="sticky top-16 z-10 mb-2 bg-slate-50/95 py-1 text-sm font-bold uppercase tracking-wide text-slate-500 backdrop-blur dark:bg-slate-950/95">{day}</h2>
              <ol className="relative space-y-1 border-l-2 border-slate-200 pl-4 dark:border-slate-800">
                {rows.map((r) => (
                  <li key={r.id} className="relative rounded-xl bg-white p-3 shadow-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
                    <span className={`absolute -left-[23px] top-4 h-3 w-3 rounded-full ring-4 ring-slate-50 dark:ring-slate-950 ${r.kind === 'TXN' ? (r.amount_cents! > 0 ? 'bg-emerald-500' : r.amount_cents! < 0 ? 'bg-red-500' : 'bg-slate-400') : r.action.startsWith('alert.') ? 'bg-amber-500' : 'bg-slate-400'}`} aria-hidden />
                    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
                      <div className="min-w-0">
                        <p className="font-semibold">
                          {actionLabel(r.action)}{' '}
                          {r.card_number && (
                            <button className="font-mono text-brand-700 hover:underline dark:text-brand-400" onClick={() => r.card_id && open('details', { id: r.card_id } as Card)}>
                              #{r.card_number}
                            </button>
                          )}
                        </p>
                        <p className="flex flex-wrap items-center gap-x-3 text-sm text-slate-500">
                          <time dateTime={r.occurred_at}>🕐 {new Date(r.occurred_at).toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', second: '2-digit' })}</time>
                          <span className="flex items-center gap-1">
                            <User className="h-3.5 w-3.5" aria-hidden />
                            {r.actor_name ?? r.actor_type}
                          </span>
                          {r.terminal_code && (
                            <span className="flex items-center gap-1">
                              <MonitorSmartphone className="h-3.5 w-3.5" aria-hidden />
                              {r.terminal_code}
                            </span>
                          )}
                          {r.ip && <span>IP {r.ip}</span>}
                          {r.reference && <span>Ref {r.reference}</span>}
                        </p>
                        {r.note && <p className="mt-0.5 text-sm">{r.note}</p>}
                      </div>
                      {r.amount_cents !== null && (
                        <div className="text-right">
                          <p className={`text-lg font-bold tabular-nums ${r.amount_cents > 0 ? 'text-emerald-700 dark:text-emerald-400' : r.amount_cents < 0 ? 'text-red-700 dark:text-red-400' : ''}`}>
                            <span className="sr-only">{r.amount_cents > 0 ? 'credit' : 'debit'} </span>
                            {signedCents(r.amount_cents)}
                          </p>
                          <p className="text-xs text-slate-500">balance {formatCents(r.balance_after_cents)}</p>
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            </section>
          ))}
          {q.data && q.data.meta.total > page * q.data.meta.per_page && (
            <div className="text-center">
              <Button variant="secondary" onClick={() => setPage((p) => p + 1)}>
                Older entries
              </Button>
            </div>
          )}
          {page > 1 && (
            <div className="text-center">
              <Button variant="ghost" onClick={() => setPage(1)}>
                Back to newest
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
