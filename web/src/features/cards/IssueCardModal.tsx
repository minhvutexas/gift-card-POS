import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ChevronDown, Printer, Send, Wand2 } from 'lucide-react';
import { api, ApiError, uuid } from '../../lib/api';
import { formatCents } from '../../lib/money';
import { useSession } from '../../lib/session';
import { useToast } from '../../lib/toast';
import type { MutationResult, Tag } from '../../lib/types';
import { Button, Field, inputCls, Modal, StatusPill, TagChip } from '../../components/ui';
import { AmountKeypad } from '../../components/Keypad';
import { applyResult } from './cache';
import { useCardActions } from './CardActions';

const PRESETS = [2500, 5000, 10000, 25000];

/** Issue flow ≤ 3 taps: scan blank card → tap preset → Issue. */
export function IssueCardModal({ onClose, initialNumber = '' }: { onClose: () => void; initialNumber?: string }) {
  const { me } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const { open, print } = useCardActions();
  const [number, setNumber] = useState(initialNumber);
  const [amount, setAmount] = useState(5000);
  const [more, setMore] = useState(false);
  const [cust, setCust] = useState({ first_name: '', last_name: '', phone: '', email: '' });
  const [label, setLabel] = useState('');
  const [expires, setExpires] = useState('');
  const [pin, setPin] = useState('');
  const [tagIds, setTagIds] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [done, setDone] = useState<MutationResult | null>(null);
  const key = useRef(uuid()); // stable across retries → no double-issue
  const tags = useQuery({ queryKey: ['tags'], queryFn: () => api<{ data: Tag[] }>('/tags'), enabled: more });

  const submit = async () => {
    const errs: Record<string, string> = {};
    if (amount <= 0) errs.amount = 'Choose an amount';
    if (number && !/^[0-9A-Za-z-]{4,20}$/.test(number.trim())) errs.number = '4–20 letters or digits';
    if (pin && !/^\d{4,8}$/.test(pin)) errs.pin = 'PIN must be 4–8 digits';
    if (cust.email && !/^\S+@\S+\.\S+$/.test(cust.email)) errs.email = 'Check the email';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      const hasCustomer = Object.values(cust).some((v) => v.trim());
      const r = await api<MutationResult>('/cards', {
        idempotencyKey: key.current,
        body: {
          card_number: number.trim() || null,
          face_value_cents: amount,
          label: label.trim() || null,
          expires_at: expires ? new Date(`${expires}T23:59:59`).toISOString() : null,
          pin: pin || null,
          tag_ids: tagIds,
          customer: hasCustomer ? cust : null,
        },
      });
      applyResult(qc, r);
      qc.invalidateQueries({ queryKey: ['cards'] });
      setDone(r);
      if (me?.settings.printer.auto_print.issue) print(r.card.id, r.transaction?.id);
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.field === 'card_number' || e.code === 'STATE_CONFLICT' || e.code === 'DUPLICATE') setErrors({ number: e.message });
        else if (e.field) setErrors({ [e.field.replace('customer.', '')]: e.message });
        else toast.push({ kind: 'error', title: 'Could not issue card', message: e.message });
        key.current = uuid();
      }
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <Modal open onClose={onClose} title="Card issued" size="sm">
        <div className="py-2 text-center" aria-live="polite">
          <CheckCircle2 className="mx-auto h-16 w-16 text-emerald-600" aria-hidden />
          <p className="mt-3 font-mono text-3xl font-bold tracking-wider">{done.card.card_number}</p>
          <p className="mt-1 text-4xl font-extrabold tabular-nums">{formatCents(done.balance_cents)}</p>
          <div className="mt-2">
            <StatusPill status={done.status} />
          </div>
        </div>
        <div className="mt-5 grid grid-cols-2 gap-2">
          <Button variant="secondary" onClick={() => print(done.card.id, done.transaction?.id)}>
            <Printer className="h-5 w-5" /> Print
          </Button>
          {me?.features?.messaging && (
            <Button variant="secondary" onClick={() => open('send', done.card)}>
              <Send className="h-5 w-5" /> Email / SMS
            </Button>
          )}
          <Button
            variant="secondary"
            onClick={() => {
              setDone(null);
              setNumber('');
              key.current = uuid();
            }}
          >
            Issue another
          </Button>
          <Button onClick={onClose}>Done</Button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="New gift card"
      size="md"
      initialFocus="#issue-number"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button size="lg" onClick={submit} loading={busy} disabled={amount <= 0}>
            Issue {formatCents(amount)} card
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Card number" htmlFor="issue-number" error={errors.number} hint={number ? null : 'Scan a physical card, or leave blank to auto-generate a number.'}>
          <div className="flex gap-2">
            <input
              id="issue-number"
              data-scanner="1"
              className={`${inputCls} font-mono text-lg tracking-wider`}
              placeholder="Scan or type card #"
              autoComplete="off"
              inputMode="numeric"
              value={number}
              aria-invalid={!!errors.number}
              onChange={(e) => setNumber(e.target.value.toUpperCase())}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  (document.querySelector('[aria-label="Amount keypad"]') as HTMLElement | null)?.focus();
                }
              }}
            />
            <Button variant="secondary" onClick={() => setNumber('')} title="Auto-generate number" aria-label="Auto-generate number">
              <Wand2 className="h-5 w-5" />
            </Button>
          </div>
        </Field>

        <AmountKeypad value={amount} onChange={setAmount} presets={PRESETS} label="Load amount" error={errors.amount} onEnter={submit} />

        <button type="button" onClick={() => setMore((m) => !m)} aria-expanded={more} className="flex min-h-[44px] w-full items-center justify-between rounded-xl px-2 font-semibold text-brand-700 hover:bg-brand-50 dark:text-brand-400 dark:hover:bg-slate-800">
          Holder, label, expiry & PIN (optional)
          <ChevronDown className={`h-5 w-5 transition ${more ? 'rotate-180' : ''}`} />
        </button>
        {more && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="First name" htmlFor="i-fn">
              <input id="i-fn" className={inputCls} value={cust.first_name} onChange={(e) => setCust({ ...cust, first_name: e.target.value })} />
            </Field>
            <Field label="Last name" htmlFor="i-ln">
              <input id="i-ln" className={inputCls} value={cust.last_name} onChange={(e) => setCust({ ...cust, last_name: e.target.value })} />
            </Field>
            <Field label="Phone" htmlFor="i-ph" error={errors.phone}>
              <input id="i-ph" className={inputCls} inputMode="tel" value={cust.phone} onChange={(e) => setCust({ ...cust, phone: e.target.value })} />
            </Field>
            <Field label="Email" htmlFor="i-em" error={errors.email}>
              <input id="i-em" className={inputCls} type="email" inputMode="email" value={cust.email} onChange={(e) => setCust({ ...cust, email: e.target.value })} />
            </Field>
            <Field label="🏷 Label" htmlFor="i-lb" hint="e.g. “Mom’s birthday”">
              <input id="i-lb" className={inputCls} maxLength={60} value={label} onChange={(e) => setLabel(e.target.value)} />
            </Field>
            <Field label="Expires (optional)" htmlFor="i-ex">
              <input id="i-ex" className={inputCls} type="date" min={new Date(Date.now() + 86400000).toISOString().slice(0, 10)} value={expires} onChange={(e) => setExpires(e.target.value)} />
            </Field>
            <Field label="Card PIN (for kiosk balance check)" htmlFor="i-pin" error={errors.pin}>
              <input id="i-pin" className={inputCls} inputMode="numeric" maxLength={8} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} />
            </Field>
            {!!tags.data?.data.length && (
              <fieldset className="sm:col-span-2">
                <legend className="mb-1 text-sm font-semibold">Tags</legend>
                <div className="flex flex-wrap gap-2">
                  {tags.data.data.map((t) => (
                    <label key={t.id} className={`flex min-h-[44px] cursor-pointer items-center gap-2 rounded-xl px-3 ring-1 ring-inset ${tagIds.includes(t.id) ? 'bg-brand-50 ring-brand-500 dark:bg-brand-900/30' : 'ring-slate-300 dark:ring-slate-600'}`}>
                      <input type="checkbox" className="h-5 w-5" checked={tagIds.includes(t.id)} onChange={(e) => setTagIds((ids) => (e.target.checked ? [...ids, t.id] : ids.filter((x) => x !== t.id)))} />
                      <TagChip tag={t} />
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
