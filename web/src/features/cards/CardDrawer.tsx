import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X, Link2 } from 'lucide-react';
import { api } from '../../lib/api';
import { formatCents, signedCents } from '../../lib/money';
import { useSession } from '../../lib/session';
import { actionLabel, TXN_LABEL } from '../../lib/status';
import type { Card, Txn } from '../../lib/types';
import { fmtDate, fmtDateTime, holderName, SkeletonRows, StatusPill, TagChip } from '../../components/ui';
import { useCardItems } from './CardMenu';
import { useCardActions } from './CardActions';

interface Detail {
  card: Card;
  transactions: Txn[];
  events: { id: number; action: string; payload: any; created_at: string; actor_name: string | null; actor_type: string }[];
  messages: { id: number; template_key: string; channel: string; recipient: string | null; status: string; sent_at: string }[];
  replaced_from: { id: number; card_number: string } | null;
}

export function CardDrawer({ cardId, onClose }: { cardId: number; onClose: () => void }) {
  const { me } = useSession();
  const tz = me?.settings.general.timezone;
  const q = useQuery({ queryKey: ['card', cardId], queryFn: () => api<Detail>(`/cards/${cardId}`) });
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !document.querySelector('[role="dialog"][aria-modal="true"]') && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-slate-950/40" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside ref={ref} tabIndex={-1} aria-label="Card details" className="flex h-full w-full max-w-xl flex-col bg-white shadow-2xl outline-none animate-slideIn dark:bg-slate-900">
        <header className="flex items-center justify-between border-b border-slate-200 px-5 py-3 dark:border-slate-800">
          <h2 className="text-xl font-bold">Card details</h2>
          <button onClick={onClose} className="h-11 w-11 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="Close details">
            <X className="mx-auto h-6 w-6" />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto p-5">{q.isLoading || !q.data ? <SkeletonRows rows={8} /> : <Body d={q.data} tz={tz} />}</div>
      </aside>
    </div>
  );
}

function Body({ d, tz }: { d: Detail; tz?: string }) {
  const { card } = d;
  const { items, run } = useCardItems(card);
  const { open } = useCardActions();
  const primary = items.filter((i) => ['redeem', 'reload', 'activate', 'print', 'freeze', 'unfreeze'].includes(i.kind));
  const rest = items.filter((i) => !primary.includes(i) && i.kind !== 'details');

  return (
    <div className="space-y-6">
      <section className="rounded-2xl bg-gradient-to-br from-brand-600 to-brand-800 p-5 text-white shadow-lg">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-sm opacity-80">{card.label ?? 'Gift card'}</p>
            <p className="font-mono text-3xl font-bold tracking-widest">{card.card_number}</p>
          </div>
          <span className="rounded-full bg-white/95 p-0.5">
            <StatusPill status={card.status} />
          </span>
        </div>
        <p className="mt-4 text-sm opacity-80">Balance</p>
        <p className="text-5xl font-extrabold tabular-nums" aria-live="polite">
          {formatCents(card.balance_cents, card.currency)}
        </p>
        <p className="mt-1 text-sm opacity-80">
          Face value {formatCents(card.face_value_cents)} · Issued {fmtDate(card.created_at, tz)}
          {card.expires_at && ` · Expires ${fmtDate(card.expires_at, tz)}`}
        </p>
      </section>

      {card.status === 'FROZEN' && card.freeze_reason && <p className="rounded-xl bg-sky-50 p-3 text-sky-900 dark:bg-sky-950 dark:text-sky-100">❄ Frozen: {card.freeze_reason}</p>}
      {card.status === 'VOIDED' && <p className="rounded-xl bg-red-50 p-3 text-red-900 dark:bg-red-950 dark:text-red-100">⊘ Voided: {card.void_reason}</p>}
      {(card.replaced_by_card_id || d.replaced_from) && (
        <p className="flex items-center gap-2 rounded-xl bg-rose-50 p-3 text-rose-900 dark:bg-rose-950 dark:text-rose-100">
          <Link2 className="h-4 w-4" />
          {card.replaced_by_card_id ? (
            <button className="underline" onClick={() => open('details', { id: card.replaced_by_card_id } as Card)}>
              Replaced by card #{card.replaced_by_card_id}
            </button>
          ) : (
            <button className="underline" onClick={() => open('details', { id: d.replaced_from!.id } as Card)}>
              Replacement for {d.replaced_from!.card_number}
            </button>
          )}
        </p>
      )}

      <section aria-label="Actions" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {primary.map((i) => (
          <button key={i.kind} onClick={() => run(i.kind)} className="flex min-h-[56px] flex-col items-center justify-center gap-1 rounded-xl bg-slate-100 text-sm font-semibold hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700">
            <i.icon className="h-5 w-5" aria-hidden />
            {i.label}
          </button>
        ))}
      </section>
      <details className="rounded-xl ring-1 ring-slate-200 dark:ring-slate-800">
        <summary className="flex min-h-[48px] cursor-pointer items-center px-4 font-semibold">More actions</summary>
        <div className="grid grid-cols-2 gap-1 p-2">
          {rest.map((i) => (
            <button key={i.kind} onClick={() => run(i.kind)} className={`flex min-h-[44px] items-center gap-2 rounded-lg px-3 text-left text-sm font-medium hover:bg-slate-100 dark:hover:bg-slate-800 ${i.danger ? 'text-red-700 dark:text-red-400' : ''}`}>
              <i.icon className="h-4 w-4" aria-hidden />
              {i.label}
            </button>
          ))}
        </div>
      </details>

      <section>
        <h3 className="mb-2 font-bold">Holder</h3>
        {card.customer ? (
          card.customer.erased ? (
            <p className="text-slate-500">Customer data erased (GDPR)</p>
          ) : (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-slate-500">Name</dt>
              <dd>{holderName(card.customer) || '—'}</dd>
              <dt className="text-slate-500">Phone</dt>
              <dd>{card.customer.phone ?? '—'}</dd>
              <dt className="text-slate-500">Email</dt>
              <dd>{card.customer.email ?? '—'}</dd>
            </dl>
          )
        ) : (
          <p className="text-sm text-slate-500">No holder on file.</p>
        )}
        {!!card.tags.length && (
          <div className="mt-2 flex flex-wrap gap-1">
            {card.tags.map((t) => (
              <TagChip key={t.id} tag={t} />
            ))}
          </div>
        )}
        {card.notes && <pre className="mt-3 whitespace-pre-wrap rounded-lg bg-amber-50 p-3 text-sm dark:bg-amber-950/40">{card.notes}</pre>}
      </section>

      <section>
        <h3 className="mb-2 font-bold">Transactions</h3>
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase text-slate-500">
            <tr>
              <th className="py-1">When</th>
              <th>Type</th>
              <th className="text-right">Amount</th>
              <th className="text-right">Balance</th>
            </tr>
          </thead>
          <tbody>
            {d.transactions.map((t) => (
              <tr key={t.id} className="border-t border-slate-100 dark:border-slate-800">
                <td className="py-2 pr-2 text-slate-600 dark:text-slate-400">{fmtDateTime(t.created_at, tz)}</td>
                <td>
                  <span className={t.reversed ? 'line-through opacity-60' : ''}>{TXN_LABEL[t.txn_type] ?? t.txn_type}</span>
                  {t.external_ref && <span className="ml-1 text-xs text-slate-500">#{t.external_ref}</span>}
                  <div className="text-xs text-slate-500">{t.actor_name ?? t.actor_type}</div>
                </td>
                <td className={`text-right font-semibold tabular-nums ${t.amount_cents > 0 ? 'text-emerald-700 dark:text-emerald-400' : t.amount_cents < 0 ? 'text-red-700 dark:text-red-400' : ''}`}>{signedCents(t.amount_cents)}</td>
                <td className="text-right tabular-nums">{formatCents(t.balance_after_cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {!!d.events.length && (
        <section>
          <h3 className="mb-2 font-bold">Activity</h3>
          <ul className="space-y-1 text-sm">
            {d.events.map((e) => (
              <li key={e.id} className="flex justify-between gap-2">
                <span>
                  {actionLabel(e.action)} {e.payload?.reason || e.payload?.note ? <span className="text-slate-500">— {e.payload.reason ?? e.payload.note}</span> : null}
                </span>
                <span className="shrink-0 text-slate-500">{fmtDateTime(e.created_at, tz)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
