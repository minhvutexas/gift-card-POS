import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight } from 'lucide-react';
import { api, ApiError, uuid } from '../../lib/api';
import { formatCents } from '../../lib/money';
import { useToast } from '../../lib/toast';
import type { Card, MutationResult } from '../../lib/types';
import { Button, Field, inputCls, Modal, StatusPill } from '../../components/ui';
import { AmountKeypad } from '../../components/Keypad';
import { applyResult } from './cache';
import { lookupCard } from './RedeemModal';

type Kind = 'transfer' | 'merge' | 'split';
const TITLE: Record<Kind, string> = { transfer: 'Transfer balance', merge: 'Merge two cards', split: 'Split into a new card' };

export function TransferModal({ kind, card, onClose }: { kind: Kind; card: Card; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [other, setOther] = useState<Card | null>(null);
  const [num, setNum] = useState('');
  const [amount, setAmount] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = useRef(uuid());

  const find = async () => {
    setErr(null);
    try {
      const c = await lookupCard(num);
      if (c.id === card.id) return setErr('Pick a different card');
      setOther(c);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Lookup failed');
    }
  };

  const submit = async () => {
    setErr(null);
    if (kind !== 'merge' && amount <= 0) return setErr('Enter an amount');
    if (kind !== 'merge' && amount > card.balance_cents) return setErr(`Insufficient: ${formatCents(card.balance_cents)} available`);
    if (kind !== 'split' && !other) return setErr('Choose the other card');
    setBusy(true);
    try {
      const r =
        kind === 'transfer'
          ? await api<{ from: MutationResult; to: MutationResult }>('/cards/transfer', { idempotencyKey: key.current, body: { from_id: card.id, to_id: other!.id, amount_cents: amount } })
          : kind === 'merge'
            ? await api<{ from: MutationResult; to: MutationResult }>('/cards/merge', { idempotencyKey: key.current, body: { from_id: card.id, to_id: other!.id } })
            : await api<{ from: MutationResult; to: MutationResult }>(`/cards/${card.id}/split`, { idempotencyKey: key.current, body: { amount_cents: amount, new_number: num.trim() || null } });
      applyResult(qc, r.from);
      applyResult(qc, r.to);
      qc.invalidateQueries({ queryKey: ['cards'] });
      toast.push({
        kind: 'success',
        title: TITLE[kind],
        message: `${r.from.card.card_number}: ${formatCents(r.from.balance_cents)} · ${r.to.card.card_number}: ${formatCents(r.to.balance_cents)}`,
      });
      onClose();
    } catch (e) {
      if (e instanceof ApiError) setErr(e.message);
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
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button size="lg" onClick={submit} loading={busy} disabled={kind === 'split' ? amount <= 0 : !other || (kind === 'transfer' && amount <= 0)}>
            {kind === 'merge' ? `Move ${formatCents(card.balance_cents)}` : `${kind === 'split' ? 'Split' : 'Transfer'} ${formatCents(amount)}`}
          </Button>
        </>
      }
    >
      <div className="mb-4 grid grid-cols-[1fr_auto_1fr] items-center gap-2">
        <div className="rounded-xl bg-slate-100 p-3 dark:bg-slate-800">
          <p className="text-xs uppercase text-slate-500">From</p>
          <p className="font-mono font-bold">{card.card_number}</p>
          <p className="tabular-nums">{formatCents(card.balance_cents)}</p>
        </div>
        <ArrowRight className="h-6 w-6 text-slate-400" aria-hidden />
        <div className="rounded-xl bg-slate-100 p-3 dark:bg-slate-800">
          <p className="text-xs uppercase text-slate-500">To</p>
          {kind === 'split' ? (
            <p className="font-semibold">New card</p>
          ) : other ? (
            <>
              <p className="font-mono font-bold">{other.card_number}</p>
              <p className="tabular-nums">{formatCents(other.balance_cents)}</p>
              <StatusPill status={other.status} size="sm" />
            </>
          ) : (
            <p className="text-slate-500">Scan below</p>
          )}
        </div>
      </div>
      <Field label={kind === 'split' ? 'New card number (blank = auto)' : 'Other card number'} htmlFor="tx-num" error={!other || kind === 'split' ? err : null}>
        <div className="flex gap-2">
          <input
            id="tx-num"
            data-scanner="1"
            autoFocus
            className={`${inputCls} font-mono`}
            value={num}
            onChange={(e) => {
              setNum(e.target.value.toUpperCase());
              if (kind !== 'split') setOther(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && kind !== 'split') {
                e.preventDefault();
                find();
              }
            }}
          />
          {kind !== 'split' && (
            <Button variant="secondary" onClick={find} disabled={!num.trim()}>
              Find
            </Button>
          )}
        </div>
      </Field>
      {kind !== 'merge' && (
        <div className="mt-4">
          <AmountKeypad value={amount} onChange={setAmount} max={card.balance_cents} error={other || kind === 'split' ? err : null} />
        </div>
      )}
      {kind === 'merge' && <p className="mt-3 text-sm text-slate-600 dark:text-slate-400">The full balance moves to the other card and this card is closed. Both cards keep their history.</p>}
    </Modal>
  );
}
