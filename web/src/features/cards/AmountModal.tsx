import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError, uuid } from '../../lib/api';
import { formatCents } from '../../lib/money';
import { useSession } from '../../lib/session';
import { useToast } from '../../lib/toast';
import type { Card, MutationResult } from '../../lib/types';
import { Button, Field, inputCls, Modal, StatusPill } from '../../components/ui';
import { AmountKeypad } from '../../components/Keypad';
import { applyResult } from './cache';
import { useCardActions } from './CardActions';

type Kind = 'reload' | 'refund' | 'adjust' | 'activate';
const TITLE: Record<Kind, string> = { reload: 'Reload / top-up', refund: 'Refund to card', adjust: 'Adjust balance', activate: 'Activate card' };

export function AmountModal({ kind, card, onClose }: { kind: Kind; card: Card; onClose: () => void }) {
  const { me } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const { print } = useCardActions();
  const [amount, setAmount] = useState(kind === 'activate' ? card.face_value_cents : 0);
  const [sign, setSign] = useState<1 | -1>(1);
  const [reason, setReason] = useState('');
  const [ref, setRef] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = useRef(uuid());
  const needsReason = kind === 'refund' || kind === 'adjust';
  const delta = kind === 'adjust' ? sign * amount : amount;
  const overdraw = kind === 'adjust' && sign < 0 && amount > card.balance_cents;

  const submit = async () => {
    if (amount <= 0) return setErr('Enter an amount');
    if (needsReason && reason.trim().length < 3) return setErr('Please give a reason');
    if (overdraw) return setErr(`Cannot remove more than ${formatCents(card.balance_cents)}`);
    setBusy(true);
    setErr(null);
    try {
      const path = { reload: 'reload', refund: 'refund', adjust: 'adjust', activate: 'activate' }[kind];
      const body =
        kind === 'adjust'
          ? { delta_cents: delta, reason: reason.trim() }
          : kind === 'refund'
            ? { amount_cents: amount, reason: reason.trim(), external_ref: ref || undefined }
            : { amount_cents: amount, external_ref: ref || undefined };
      const r = await api<MutationResult>(`/cards/${card.id}/${path}`, { idempotencyKey: key.current, body });
      applyResult(qc, r);
      toast.push({ kind: 'success', title: `${TITLE[kind]}: ${formatCents(Math.abs(delta))}`, message: `New balance ${formatCents(r.balance_cents)}` });
      const auto = me?.settings.printer.auto_print;
      if ((kind === 'reload' && auto?.reload) || (kind === 'refund' && auto?.refund)) print(card.id, r.transaction?.id);
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.code !== 'APPROVAL_CANCELLED') setErr(e.message);
      key.current = uuid();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={TITLE[kind]}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button size="lg" variant={kind === 'adjust' && sign < 0 ? 'danger' : 'primary'} onClick={submit} loading={busy} disabled={amount <= 0}>
            {kind === 'adjust' ? `${sign > 0 ? 'Add' : 'Remove'} ${formatCents(amount)}` : `${TITLE[kind].split(' ')[0]} ${formatCents(amount)}`}
          </Button>
        </>
      }
    >
      <div className="mb-4 flex items-center justify-between rounded-lg bg-zinc-100 p-3 dark:bg-zinc-800">
        <div>
          <p className="font-mono text-lg font-bold">{card.card_number}</p>
          <StatusPill status={card.status} size="sm" />
        </div>
        <div className="text-right">
          <p className="text-xs uppercase text-zinc-500">Balance now → after</p>
          <p className="text-2xl font-bold tabular-nums">
            {formatCents(card.balance_cents)} → <span className="text-brand-700 dark:text-brand-400">{formatCents(Math.max(0, card.balance_cents + delta))}</span>
          </p>
        </div>
      </div>
      {kind === 'adjust' && (
        <div className="mb-3 grid grid-cols-2 gap-2" role="radiogroup" aria-label="Adjustment direction">
          {([1, -1] as const).map((s) => (
            <button key={s} role="radio" aria-checked={sign === s} onClick={() => setSign(s)} className={`min-h-[52px] rounded-lg text-lg font-bold ring-2 ring-inset ${sign === s ? (s > 0 ? 'bg-emerald-600 text-white ring-emerald-600' : 'bg-red-600 text-white ring-red-600') : 'ring-zinc-300 dark:ring-zinc-600'}`}>
              {s > 0 ? '+ Add' : '− Remove'}
            </button>
          ))}
        </div>
      )}
      <AmountKeypad value={amount} onChange={setAmount} onEnter={submit} error={err} presets={kind === 'reload' ? [2500, 5000, 10000, 20000] : undefined} />
      <div className="mt-4 grid gap-3">
        {needsReason && (
          <Field label="Reason (required)" htmlFor="am-reason" hint={kind === 'refund' ? 'Recorded in the audit log. Needs manager approval.' : 'Visible in history. Manager approval required.'}>
            <input id="am-reason" className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
          </Field>
        )}
        {kind !== 'adjust' && (
          <Field label="Receipt / payment ref (optional)" htmlFor="am-ref">
            <input id="am-ref" className={inputCls} value={ref} onChange={(e) => setRef(e.target.value)} maxLength={80} />
          </Field>
        )}
      </div>
    </Modal>
  );
}
