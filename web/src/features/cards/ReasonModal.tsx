import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { api, ApiError, uuid } from '../../lib/api';
import { formatCents } from '../../lib/money';
import { useToast } from '../../lib/toast';
import type { Card, MutationResult } from '../../lib/types';
import { Button, Field, inputCls, Modal } from '../../components/ui';
import { applyResult } from './cache';

type Kind = 'freeze' | 'unfreeze' | 'void' | 'delete';

const COPY: Record<Kind, { title: string; button: string; danger: boolean; reasonRequired: boolean; quick: string[] }> = {
  freeze: { title: 'Freeze card', button: 'Freeze', danger: false, reasonRequired: true, quick: ['Reported lost', 'Suspicious use', 'Customer request', 'Pending investigation'] },
  unfreeze: { title: 'Unfreeze card', button: 'Unfreeze', danger: false, reasonRequired: false, quick: ['Card found', 'Verified customer ID'] },
  void: { title: 'Void card', button: 'Void permanently', danger: true, reasonRequired: true, quick: ['Sold in error', 'Payment reversed / chargeback', 'Duplicate card'] },
  delete: { title: 'Delete card', button: 'Delete', danger: true, reasonRequired: true, quick: ['Created by mistake', 'Test card'] },
};

/** Destructive confirmations always require a typed reason (and manager PIN where configured). */
export function ReasonModal({ kind, card, onClose }: { kind: Kind; card: Card; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [confirmNum, setConfirmNum] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = useRef(uuid());
  const c = COPY[kind];
  const mustTypeNumber = kind === 'void' && card.balance_cents > 0;

  const submit = async () => {
    if (c.reasonRequired && reason.trim().length < 3) return setErr('Please type a reason (3+ characters)');
    if (mustTypeNumber && confirmNum.trim() !== card.card_number.slice(-4)) return setErr('Type the last 4 digits of the card to confirm');
    setBusy(true);
    setErr(null);
    try {
      if (kind === 'delete') {
        await api(`/cards/${card.id}`, { method: 'DELETE', body: { reason: reason.trim() }, idempotencyKey: key.current });
        qc.invalidateQueries({ queryKey: ['cards'] });
        toast.push({ kind: 'success', title: `Card ${card.card_number} deleted`, message: 'History is kept in the audit log.' });
      } else {
        const r = await api<MutationResult>(`/cards/${card.id}/${kind}`, {
          method: kind === 'void' ? 'POST' : 'PUT',
          idempotencyKey: key.current,
          body: { reason: reason.trim() || undefined },
        });
        applyResult(qc, r);
        const done = { freeze: 'Frozen', unfreeze: 'Unfrozen', void: 'Voided' }[kind];
        toast.push({ kind: 'success', title: `${done}: ${card.card_number}`, message: kind === 'void' ? `${formatCents(card.balance_cents)} removed from liability` : undefined });
      }
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
      title={c.title}
      size="sm"
      initialFocus="#reason-input"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant={c.danger ? 'danger' : 'primary'} onClick={submit} loading={busy}>
            {c.button}
          </Button>
        </>
      }
    >
      <p className="mb-3">
        Card <strong className="font-mono">{card.card_number}</strong> · balance <strong>{formatCents(card.balance_cents)}</strong>
      </p>
      {c.danger && (
        <div className="mb-3 flex gap-2 rounded-lg bg-red-50 p-3 text-red-900 dark:bg-red-950 dark:text-red-100">
          <AlertTriangle className="h-5 w-5 shrink-0" />
          <p className="text-sm">
            {kind === 'void'
              ? `Voiding forfeits the remaining ${formatCents(card.balance_cents)} and cannot be undone. A manager must approve.`
              : 'The card disappears from lists but its full history stays in the audit log. Only $0 cards can be deleted.'}
          </p>
        </div>
      )}
      <div className="mb-2 flex flex-wrap gap-2">
        {c.quick.map((q) => (
          <button key={q} type="button" onClick={() => setReason(q)} className="min-h-[44px] rounded-full bg-zinc-100 px-3 text-sm font-medium hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700">
            {q}
          </button>
        ))}
      </div>
      <Field label={`Reason${c.reasonRequired ? ' (required)' : ''}`} htmlFor="reason-input" error={err}>
        <textarea id="reason-input" rows={2} className={`${inputCls} py-2`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} aria-invalid={!!err} />
      </Field>
      {mustTypeNumber && (
        <div className="mt-3">
          <Field label={`Type the last 4 digits (${card.card_number.slice(-4)}) to confirm`} htmlFor="confirm-num">
            <input id="confirm-num" className={`${inputCls} font-mono`} inputMode="numeric" value={confirmNum} onChange={(e) => setConfirmNum(e.target.value)} />
          </Field>
        </div>
      )}
    </Modal>
  );
}
