import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { Archive, CreditCard, Download, History, Plus, ScanLine, Search, Snowflake, Sun, Ban, Tag as TagIcon, Trash2, X } from 'lucide-react';
import { api, ApiError, download, uuid } from '../../lib/api';
import { formatCents } from '../../lib/money';
import { useScanner } from '../../lib/scanner';
import { useSession } from '../../lib/session';
import { TAG_COLORS } from '../../lib/status';
import { useToast } from '../../lib/toast';
import type { Card, CardList } from '../../lib/types';
import { AnimatedMoney, Button, EmptyState, Field, holderName, inputCls, Modal, SkeletonRows, StatusPill } from '../../components/ui';
import { useCardActions } from './CardActions';
import { CardMenu } from './CardMenu';
import { lookupCard } from './RedeemModal';

const CHIPS = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'partial', label: 'Partially used' },
  { key: 'zero', label: 'Zero balance' },
  { key: 'frozen', label: 'Frozen' },
  { key: 'voided', label: 'Voided' },
] as const;

const SORTS = [
  { key: 'balance_desc', label: 'Balance (high → low)' },
  { key: 'created_desc', label: 'Newest first' },
  { key: 'last_used_desc', label: 'Last used' },
  { key: 'status', label: 'Status' },
  { key: 'label', label: 'Label A → Z' },
  { key: 'number', label: 'Card number' },
];

export function CardsPage() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? 'all';
  const sort = params.get('sort') ?? 'balance_desc';
  const page = Number(params.get('page') ?? 1);
  const [q, setQ] = useState(params.get('q') ?? '');
  const [debounced, setDebounced] = useState(q);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [scan, setScan] = useState('');
  const [scanErr, setScanErr] = useState<string | null>(null);
  const scanRef = useRef<HTMLInputElement>(null);
  const { open } = useCardActions();
  const { can } = useSession();
  const toast = useToast();
  const qc = useQueryClient();

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 250);
    return () => clearTimeout(t);
  }, [q]);

  const set = (k: string, v: string | null) => {
    const p = new URLSearchParams(params);
    if (v === null || v === '') p.delete(k);
    else p.set(k, v);
    if (k !== 'page') p.delete('page');
    setParams(p, { replace: true });
  };

  const query = useQuery({
    queryKey: ['cards', 'list', { status, sort, page, q: debounced }],
    queryFn: () => api<CardList>(`/cards?${new URLSearchParams({ status, sort, page: String(page), per_page: '50', ...(debounced ? { q: debounced } : {}) })}`),
    placeholderData: keepPreviousData,
  });
  const data = query.data;
  useEffect(() => {
    if (data) qc.setQueryData(['outstanding'], data.meta.outstanding_total_cents);
  }, [data, qc]);
  useEffect(() => setSelected(new Set()), [status, debounced, page]);

  // Scanner: a scan anywhere on this page opens Redeem for that card.
  const onScanned = async (code: string) => {
    setScanErr(null);
    try {
      const card = await lookupCard(code);
      open('redeem', card);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'CARD_NOT_FOUND' && can('cards.issue')) {
        toast.push({ kind: 'info', title: `Card ${code} is new`, message: 'Issue it now?', action: { label: 'Issue card', onClick: () => open('issue', null, { number: code }) }, duration: 8000 });
      } else setScanErr(e instanceof ApiError ? e.message : 'Lookup failed');
    }
    setScan('');
  };
  useScanner(onScanned);

  const cards = data?.data ?? [];
  const allSelected = cards.length > 0 && cards.every((c) => selected.has(c.id));
  const selCards = useMemo(() => cards.filter((c) => selected.has(c.id)), [cards, selected]);

  const [bulkAsk, setBulkAsk] = useState<{ action: 'freeze' | 'void'; reason: string } | null>(null);
  const bulk = async (action: 'freeze' | 'unfreeze' | 'void', reason?: string) => {
    if (action !== 'unfreeze' && !reason) {
      setBulkAsk({ action, reason: '' });
      return;
    }
    setBulkAsk(null);
    try {
      const r = await api<{ ok: number; failed: number; results: { id: number; ok: boolean; error?: string }[] }>('/cards/bulk', {
        idempotencyKey: uuid(),
        body: { action, ids: [...selected], reason },
      });
      qc.invalidateQueries({ queryKey: ['cards'] });
      toast.push({
        kind: r.failed ? 'warning' : 'success',
        title: `${action[0].toUpperCase() + action.slice(1)}: ${r.ok} done${r.failed ? `, ${r.failed} skipped` : ''}`,
        message: r.results.filter((x) => !x.ok).slice(0, 3).map((x) => x.error).join(' · ') || undefined,
      });
      setSelected(new Set());
    } catch (e) {
      if (e instanceof ApiError && e.code !== 'APPROVAL_CANCELLED') toast.push({ kind: 'error', title: 'Bulk action failed', message: e.message });
    }
  };

  return (
    <div className="space-y-4">
      {/* Header summary bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Gift Cards</h1>
          <p className="text-slate-600 dark:text-slate-300" aria-live="polite">
            {data ? (
              <>
                <strong>{data.meta.total}</strong> card{data.meta.total === 1 ? '' : 's'} · Total outstanding: <AnimatedMoney cents={data.meta.outstanding_total_cents} className="font-bold text-slate-900 dark:text-white" />
              </>
            ) : (
              'Loading…'
            )}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link to="/history" className="inline-flex min-h-[48px] items-center gap-2 rounded-xl px-4 font-semibold ring-1 ring-inset ring-slate-300 hover:bg-slate-100 dark:ring-slate-600 dark:hover:bg-slate-800">
            <History className="h-5 w-5" /> 📜 History Log
          </Link>
          {can('cards.archive') && (
            <Button variant="secondary" onClick={() => open('archive')}>
              <Archive className="h-5 w-5" /> 🗑 Clear Zero-Balance
            </Button>
          )}
          {can('cards.redeem') && (
            <Button variant="success" onClick={() => open('redeem')}>
              <ScanLine className="h-5 w-5" /> Redeem
            </Button>
          )}
        </div>
      </div>

      {/* Scan + search */}
      <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_auto]">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (scan.trim()) onScanned(scan.trim());
          }}
          className="relative"
        >
          <ScanLine className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-brand-600" aria-hidden />
          <input
            ref={scanRef}
            data-scanner="1"
            value={scan}
            onChange={(e) => setScan(e.target.value)}
            placeholder="Scan card → Enter to redeem"
            aria-label="Scan or type a card number to redeem"
            aria-invalid={!!scanErr}
            className={`${inputCls} pl-10 font-mono`}
            inputMode="numeric"
            autoComplete="off"
          />
          {scanErr && (
            <p role="alert" className="mt-1 text-sm font-medium text-red-600">
              {scanErr}
            </p>
          )}
        </form>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400" aria-hidden />
          <input value={q} onChange={(e) => (setQ(e.target.value), set('q', e.target.value))} placeholder="Search number, label, name, phone, email" aria-label="Search cards" className={`${inputCls} pl-10 pr-10`} type="search" />
          {q && (
            <button onClick={() => (setQ(''), set('q', null))} className="absolute right-1 top-1/2 h-10 w-10 -translate-y-1/2 rounded-lg text-slate-400 hover:text-slate-700" aria-label="Clear search">
              <X className="mx-auto h-5 w-5" />
            </button>
          )}
        </div>
        <select value={sort} onChange={(e) => set('sort', e.target.value)} aria-label="Sort cards" className={`${inputCls} md:w-56`}>
          {SORTS.map((s) => (
            <option key={s.key} value={s.key}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      {/* Filter chips */}
      <div role="radiogroup" aria-label="Filter by status" className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
        {CHIPS.map((c) => (
          <button
            key={c.key}
            role="radio"
            aria-checked={status === c.key}
            onClick={() => set('status', c.key === 'all' ? null : c.key)}
            className={`min-h-[44px] shrink-0 rounded-full px-4 font-semibold ring-1 ring-inset transition ${status === c.key ? 'bg-slate-900 text-white ring-slate-900 dark:bg-white dark:text-slate-900' : 'bg-white ring-slate-300 hover:bg-slate-100 dark:bg-slate-900 dark:ring-slate-700 dark:hover:bg-slate-800'}`}
          >
            {c.label}
          </button>
        ))}
      </div>

      {/* Bulk bar */}
      {selected.size > 0 && (
        <div role="toolbar" aria-label="Bulk actions" className="sticky top-16 z-20 flex flex-wrap items-center gap-2 rounded-xl bg-slate-900 p-2 text-white shadow-lg dark:bg-slate-100 dark:text-slate-900">
          <span className="px-2 font-semibold">{selected.size} selected</span>
          {can('cards.freeze') && (
            <>
              <Button size="sm" variant="ghost" className="text-inherit" onClick={() => bulk('freeze')}>
                <Snowflake className="h-4 w-4" /> Freeze
              </Button>
              <Button size="sm" variant="ghost" className="text-inherit" onClick={() => bulk('unfreeze')}>
                <Sun className="h-4 w-4" /> Unfreeze
              </Button>
            </>
          )}
          {can('cards.void') && (
            <Button size="sm" variant="ghost" className="text-red-300 dark:text-red-700" onClick={() => bulk('void')}>
              <Ban className="h-4 w-4" /> Void
            </Button>
          )}
          {can('cards.export') && (
            <Button size="sm" variant="ghost" className="text-inherit" onClick={() => download(`/cards/export.csv?ids=${[...selected].join(',')}`, 'gift-cards.csv')}>
              <Download className="h-4 w-4" /> Export CSV
            </Button>
          )}
          <span className="ml-auto pr-2 text-sm opacity-80">Total {formatCents(selCards.reduce((s, c) => s + c.balance_cents, 0))}</span>
          <Button size="sm" variant="ghost" className="text-inherit" onClick={() => setSelected(new Set())} aria-label="Clear selection">
            <X className="h-4 w-4" />
          </Button>
        </div>
      )}

      {/* List */}
      {query.isLoading ? (
        <SkeletonRows rows={6} />
      ) : query.isError ? (
        <EmptyState icon={<CreditCard className="h-12 w-12" />} title="Couldn’t load cards" action={<Button onClick={() => query.refetch()}>Try again</Button>}>
          {(query.error as Error).message}
        </EmptyState>
      ) : cards.length === 0 ? (
        <EmptyState
          icon={<CreditCard className="h-12 w-12" />}
          title={debounced || status !== 'all' ? 'No cards match' : 'No gift cards yet'}
          action={
            debounced || status !== 'all' ? (
              <Button variant="secondary" onClick={() => (setQ(''), setParams(new URLSearchParams()))}>
                Clear filters
              </Button>
            ) : can('cards.issue') ? (
              <Button onClick={() => open('issue')}>
                <Plus className="h-5 w-5" /> Issue the first card
              </Button>
            ) : undefined
          }
        >
          {debounced || status !== 'all' ? 'Try a different search or filter.' : 'Sell a card with “+ New Card”, or import your old cards in Settings › Import.'}
        </EmptyState>
      ) : (
        <div className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
          <table className="w-full">
            <caption className="sr-only">Gift cards</caption>
            <thead className="hidden bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500 dark:bg-slate-800/50 md:table-header-group">
              <tr>
                <th className="w-12 px-3 py-2">
                  <input type="checkbox" className="h-5 w-5" aria-label="Select all on this page" checked={allSelected} onChange={(e) => setSelected(e.target.checked ? new Set(cards.map((c) => c.id)) : new Set())} />
                </th>
                <th className="px-3 py-2">Card #</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2 text-right">Balance</th>
                <th className="px-3 py-2">Holder</th>
                <th className="px-3 py-2 text-center">🏷</th>
                <th className="px-3 py-2 text-center">🗑</th>
                <th className="w-12" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {cards.map((c) => (
                <Row key={c.id} card={c} selected={selected.has(c.id)} onSelect={(v) => setSelected((s) => { const n = new Set(s); v ? n.add(c.id) : n.delete(c.id); return n; })} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {bulkAsk && (
        <Modal
          open
          onClose={() => setBulkAsk(null)}
          title={`${bulkAsk.action === 'void' ? 'Void' : 'Freeze'} ${selected.size} card${selected.size === 1 ? '' : 's'}`}
          size="sm"
          initialFocus="#bulk-reason"
          footer={
            <>
              <Button variant="secondary" onClick={() => setBulkAsk(null)}>
                Cancel
              </Button>
              <Button variant={bulkAsk.action === 'void' ? 'danger' : 'primary'} disabled={bulkAsk.reason.trim().length < 3} onClick={() => bulk(bulkAsk.action, bulkAsk.reason.trim())}>
                {bulkAsk.action === 'void' ? 'Void all' : 'Freeze all'}
              </Button>
            </>
          }
        >
          {bulkAsk.action === 'void' && (
            <p className="mb-3 rounded-xl bg-red-50 p-3 text-sm text-red-900 dark:bg-red-950 dark:text-red-100">
              Forfeits {formatCents(selCards.reduce((s, c) => s + c.balance_cents, 0))} in total. Cannot be undone. Manager approval required.
            </p>
          )}
          <Field label="Reason (required)" htmlFor="bulk-reason">
            <input id="bulk-reason" className={inputCls} value={bulkAsk.reason} onChange={(e) => setBulkAsk({ ...bulkAsk, reason: e.target.value })} />
          </Field>
        </Modal>
      )}

      {data && data.meta.total > data.meta.per_page && (
        <nav className="flex items-center justify-center gap-2" aria-label="Pagination">
          <Button variant="secondary" disabled={page <= 1} onClick={() => set('page', String(page - 1))}>
            Previous
          </Button>
          <span className="px-3 text-sm">
            Page {page} of {Math.ceil(data.meta.total / data.meta.per_page)}
          </span>
          <Button variant="secondary" disabled={page * data.meta.per_page >= data.meta.total} onClick={() => set('page', String(page + 1))}>
            Next
          </Button>
        </nav>
      )}
    </div>
  );
}

function Row({ card: c, selected, onSelect }: { card: Card; selected: boolean; onSelect: (v: boolean) => void }) {
  const { open } = useCardActions();
  const { can } = useSession();
  const holder = holderName(c.customer);
  return (
    <tr
      className={`grid cursor-pointer grid-cols-[auto_1fr_auto_auto] items-center gap-x-2 px-2 py-2 hover:bg-slate-50 dark:hover:bg-slate-800/50 md:table-row md:px-0 ${selected ? 'bg-brand-50 dark:bg-brand-900/20' : ''}`}
      onClick={() => open('details', c)}
    >
      <td className="px-1 md:px-3" onClick={(e) => e.stopPropagation()}>
        <input type="checkbox" className="h-5 w-5" checked={selected} onChange={(e) => onSelect(e.target.checked)} aria-label={`Select card ${c.card_number}`} />
      </td>
      <td className="min-w-0 px-1 md:px-3 md:py-3">
        <button className="text-left font-mono text-lg font-bold tracking-wide hover:underline" onClick={(e) => (e.stopPropagation(), open('details', c))}>
          {c.card_number}
        </button>
        <div className="md:hidden">
          <StatusPill status={c.status} size="sm" />
        </div>
        {c.label && <div className="truncate text-sm text-slate-500 md:hidden">🏷 {c.label}</div>}
      </td>
      <td className="hidden px-3 md:table-cell">
        <StatusPill status={c.status} />
      </td>
      <td className="px-1 text-right md:px-3">
        <span className={`text-lg font-bold tabular-nums ${c.balance_cents === 0 ? 'text-slate-400' : ''}`}>{formatCents(c.balance_cents, c.currency)}</span>
      </td>
      <td className="hidden max-w-[12rem] truncate px-3 text-sm text-slate-600 dark:text-slate-300 md:table-cell">{holder || <span className="text-slate-400">—</span>}</td>
      <td className="hidden px-3 text-center md:table-cell" onClick={(e) => e.stopPropagation()}>
        <button
          onClick={() => can('cards.edit') && open('tags', c)}
          title={c.label ?? (c.tags.map((t) => t.name).join(', ') || 'Add label')}
          aria-label={c.label ? `Label: ${c.label}. Edit` : 'Add label'}
          className="inline-flex h-11 min-w-[44px] items-center justify-center gap-1 rounded-lg px-2 hover:bg-slate-100 dark:hover:bg-slate-800"
        >
          {c.color_tag ? <span className={`h-3 w-3 rounded-full ${TAG_COLORS[c.color_tag] ?? 'bg-slate-400'}`} aria-hidden /> : <TagIcon className={`h-5 w-5 ${c.label || c.tags.length ? 'text-brand-600' : 'text-slate-300'}`} />}
          {c.label && <span className="max-w-[8rem] truncate text-sm">{c.label}</span>}
        </button>
      </td>
      <td className="hidden px-3 text-center md:table-cell" onClick={(e) => e.stopPropagation()}>
        {can('cards.delete') && (
          <button
            onClick={() => open('delete', c)}
            disabled={c.balance_cents > 0}
            title={c.balance_cents > 0 ? 'Only $0 cards can be deleted — void first' : 'Delete (soft)'}
            aria-label={`Delete card ${c.card_number}`}
            className="h-11 w-11 rounded-lg text-slate-400 hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-30 dark:hover:bg-red-950"
          >
            <Trash2 className="mx-auto h-5 w-5" />
          </button>
        )}
      </td>
      <td className="pr-1 md:pr-3" onClick={(e) => e.stopPropagation()}>
        <CardMenu card={c} />
      </td>
    </tr>
  );
}
