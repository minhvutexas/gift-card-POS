import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Search, UserX, Users } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { formatCents } from '../../lib/money';
import { useSession } from '../../lib/session';
import { useToast } from '../../lib/toast';
import type { Card } from '../../lib/types';
import { Button, EmptyState, Field, inputCls, Modal, SkeletonRows, StatusPill } from '../../components/ui';
import { useCardActions } from '../cards/CardActions';

interface Customer {
  id: number;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  email: string | null;
  marketing_opt_in: boolean;
  loyalty_points: number;
  card_count: number;
  balance_cents: number;
}

export function CustomersPage() {
  const { can } = useSession();
  const [q, setQ] = useState('');
  const [deb, setDeb] = useState('');
  const [edit, setEdit] = useState<Customer | 'new' | null>(null);
  const [view, setView] = useState<number | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setDeb(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  const list = useQuery({
    queryKey: ['customers', deb],
    queryFn: () => api<{ data: Customer[]; meta: { total: number } }>(`/customers?${new URLSearchParams(deb ? { q: deb } : {})}`),
    placeholderData: keepPreviousData,
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Customers</h1>
          <p className="text-slate-500">Card holders. Used for delivery, reminders and lost-card recovery.</p>
        </div>
        {can('customers.write') && (
          <Button onClick={() => setEdit('new')}>
            <Plus className="h-5 w-5" /> Add customer
          </Button>
        )}
      </div>
      <div className="relative max-w-xl">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400" aria-hidden />
        <input type="search" className={`${inputCls} pl-10`} placeholder="Search name, phone, email" aria-label="Search customers" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {list.isLoading ? (
        <SkeletonRows />
      ) : !list.data?.data.length ? (
        <EmptyState icon={<Users className="h-12 w-12" />} title={deb ? 'No matches' : 'No customers yet'}>
          {deb ? 'Try a phone number or part of the name.' : 'Customers are created automatically when you add holder details while issuing a card.'}
        </EmptyState>
      ) : (
        <ul className="divide-y divide-slate-100 overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-200 dark:divide-slate-800 dark:bg-slate-900 dark:ring-slate-800">
          {list.data.data.map((c) => (
            <li key={c.id}>
              <button onClick={() => setView(c.id)} className="grid min-h-[60px] w-full grid-cols-[1fr_auto] items-center gap-2 px-4 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-800 sm:grid-cols-[1.2fr_1fr_1fr_auto]">
                <span className="font-semibold">{[c.first_name, c.last_name].filter(Boolean).join(' ') || '(no name)'}</span>
                <span className="hidden text-sm text-slate-500 sm:block">{c.phone ?? '—'}</span>
                <span className="hidden truncate text-sm text-slate-500 sm:block">{c.email ?? '—'}</span>
                <span className="text-right text-sm">
                  <strong className="tabular-nums">{formatCents(c.balance_cents)}</strong>
                  <span className="block text-xs text-slate-500">
                    {c.card_count} card{c.card_count === 1 ? '' : 's'}
                    {c.loyalty_points ? ` · ${c.loyalty_points} pts` : ''}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {edit && <CustomerForm customer={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
      {view !== null && <CustomerView id={view} onClose={() => setView(null)} onEdit={(c) => (setView(null), setEdit(c))} />}
    </div>
  );
}

function CustomerForm({ customer, onClose }: { customer: Customer | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [v, setV] = useState({ first_name: customer?.first_name ?? '', last_name: customer?.last_name ?? '', phone: customer?.phone ?? '', email: customer?.email ?? '', marketing_opt_in: customer?.marketing_opt_in ?? false });
  const [err, setErr] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api(customer ? `/customers/${customer.id}` : '/customers', { method: customer ? 'PATCH' : 'POST', body: v });
      qc.invalidateQueries({ queryKey: ['customers'] });
      toast.push({ kind: 'success', title: customer ? 'Customer updated' : 'Customer added' });
      onClose();
    } catch (e) {
      if (e instanceof ApiError) setErr(e);
    } finally {
      setBusy(false);
    }
  };
  const fe = (f: string) => (err?.field === f ? err.message : null);
  return (
    <Modal
      open
      onClose={onClose}
      title={customer ? 'Edit customer' : 'Add customer'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={busy}>
            Save
          </Button>
        </>
      }
    >
      {err && !err.field && (
        <p role="alert" className="mb-3 font-semibold text-red-600">
          {err.message}
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="First name" htmlFor="c-fn">
          <input id="c-fn" className={inputCls} value={v.first_name} onChange={(e) => setV({ ...v, first_name: e.target.value })} />
        </Field>
        <Field label="Last name" htmlFor="c-ln">
          <input id="c-ln" className={inputCls} value={v.last_name} onChange={(e) => setV({ ...v, last_name: e.target.value })} />
        </Field>
        <Field label="Phone" htmlFor="c-ph" error={fe('phone')}>
          <input id="c-ph" className={inputCls} inputMode="tel" value={v.phone} onChange={(e) => setV({ ...v, phone: e.target.value })} />
        </Field>
        <Field label="Email" htmlFor="c-em" error={fe('email')}>
          <input id="c-em" className={inputCls} type="email" value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} />
        </Field>
        <label className="flex min-h-[44px] items-center gap-3 sm:col-span-2">
          <input type="checkbox" className="h-5 w-5" checked={v.marketing_opt_in} onChange={(e) => setV({ ...v, marketing_opt_in: e.target.checked })} />
          OK to send offers & reminders
        </label>
      </div>
    </Modal>
  );
}

function CustomerView({ id, onClose, onEdit }: { id: number; onClose: () => void; onEdit: (c: Customer) => void }) {
  const { can } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const { open } = useCardActions();
  const [erase, setErase] = useState(false);
  const [confirm, setConfirm] = useState('');
  const q = useQuery({ queryKey: ['customer', id], queryFn: () => api<{ customer: Customer; cards: Pick<Card, 'id' | 'card_number' | 'status' | 'balance_cents'>[] }>(`/customers/${id}`) });
  const c = q.data?.customer;
  const doErase = async () => {
    try {
      await api(`/customers/${id}/erase`, { body: { confirm: 'ERASE' } });
      qc.invalidateQueries({ queryKey: ['customers'] });
      toast.push({ kind: 'success', title: 'Customer data erased', message: 'Cards and balances are kept; personal details removed.' });
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.code !== 'APPROVAL_CANCELLED') toast.push({ kind: 'error', title: 'Erase failed', message: e.message });
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={c ? [c.first_name, c.last_name].filter(Boolean).join(' ') || 'Customer' : 'Customer'}
      footer={
        c && (
          <>
            {can('customers.erase') && (
              <Button variant="ghost" className="mr-auto text-red-700" onClick={() => setErase(true)}>
                <UserX className="h-5 w-5" /> GDPR erase
              </Button>
            )}
            {can('customers.write') && (
              <Button variant="secondary" onClick={() => onEdit(c)}>
                Edit
              </Button>
            )}
            <Button onClick={onClose}>Close</Button>
          </>
        )
      }
    >
      {!c ? (
        <SkeletonRows rows={3} />
      ) : erase ? (
        <div className="space-y-3">
          <p className="rounded-xl bg-red-50 p-3 text-red-900 dark:bg-red-950 dark:text-red-100">Removes name, phone, email and notes permanently. Card balances and the money ledger are kept (legal requirement). A manager must approve.</p>
          <Field label='Type "ERASE" to confirm' htmlFor="erase-c">
            <input id="erase-c" className={inputCls} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </Field>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setErase(false)}>
              Cancel
            </Button>
            <Button variant="danger" disabled={confirm !== 'ERASE'} onClick={doErase}>
              Erase personal data
            </Button>
          </div>
        </div>
      ) : (
        <>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            <dt className="text-slate-500">Phone</dt>
            <dd>{c.phone ?? '—'}</dd>
            <dt className="text-slate-500">Email</dt>
            <dd>{c.email ?? '—'}</dd>
            <dt className="text-slate-500">Loyalty</dt>
            <dd>{c.loyalty_points} points</dd>
          </dl>
          <h3 className="mb-1 mt-4 font-bold">Cards</h3>
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {q.data!.cards.map((k) => (
              <li key={k.id}>
                <button className="flex min-h-[48px] w-full items-center justify-between gap-2 text-left hover:bg-slate-50 dark:hover:bg-slate-800" onClick={() => (onClose(), open('details', k as Card))}>
                  <span className="font-mono font-semibold">{k.card_number}</span>
                  <StatusPill status={k.status} size="sm" />
                  <span className="tabular-nums">{formatCents(k.balance_cents)}</span>
                </button>
              </li>
            ))}
            {!q.data!.cards.length && <li className="py-2 text-slate-500">No cards.</li>}
          </ul>
        </>
      )}
    </Modal>
  );
}
