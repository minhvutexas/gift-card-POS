import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertOctagon, CheckCircle2, Printer, ScanLine, WifiOff } from 'lucide-react';
import { api, ApiError, uuid } from '../../lib/api';
import { formatCents } from '../../lib/money';
import { enqueueRedeem } from '../../lib/offline';
import { normaliseScan } from '../../lib/scanner';
import { useSession } from '../../lib/session';
import { STATUS } from '../../lib/status';
import { useToast } from '../../lib/toast';
import type { Card, MutationResult } from '../../lib/types';
import { Button, Field, holderName, inputCls, Modal, StatusPill } from '../../components/ui';
import { AmountKeypad } from '../../components/Keypad';
import { applyResult, optimistic, statusFor } from './cache';
import { useCardActions } from './CardActions';

const REDEEMABLE = ['ACTIVE', 'PARTIALUSED'];

export async function lookupCard(code: string): Promise<Card> {
  const n = normaliseScan(code);
  const r = n.startsWith('QR:')
    ? await api<{ card: Card }>(`/cards/lookup-qr/${encodeURIComponent(n.slice(3))}`)
    : await api<{ card: Card }>(`/cards/lookup/${encodeURIComponent(n)}`);
  return r.card;
}

/** Redeem flow: scan → balance + holder → amount → confirm → print. */
export function RedeemModal({ card: initial, onClose }: { card: Card | null; onClose: () => void }) {
  const { me } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const { print } = useCardActions();
  const [card, setCard] = useState<Card | null>(initial);
  const [scan, setScan] = useState('');
  const [scanErr, setScanErr] = useState<string | null>(null);
  const [amount, setAmount] = useState(0);
  const [tip, setTip] = useState(0);
  const [ref, setRef] = useState('');
  const [busy, setBusy] = useState(false);
  const [offlineOffer, setOfflineOffer] = useState(false);
  const [done, setDone] = useState<MutationResult | null>(null);
  const key = useRef(uuid());

  // Always refresh the balance when opening (another terminal may have just used it).
  useEffect(() => {
    if (initial) api<{ card: Card }>(`/cards/${initial.id}`).then((r) => setCard(r.card)).catch(() => {});
  }, [initial]);

  const total = amount + tip;
  const insufficient = !!card && total > card.balance_cents;
  const blocked = !!card && !REDEEMABLE.includes(card.status);
  const expiredByDate = !!card?.expires_at && new Date(card.expires_at) <= new Date();

  const doLookup = async (code: string) => {
    setScanErr(null);
    try {
      setCard(await lookupCard(code));
    } catch (e) {
      setScanErr(e instanceof ApiError ? (e.code === 'CARD_NOT_FOUND' ? `No card “${code}”` : e.message) : 'Lookup failed');
    }
  };

  const confirm = async () => {
    if (!card || amount <= 0 || insufficient || blocked || busy) return;
    setBusy(true);
    const newBal = card.balance_cents - total;
    const rollback = optimistic(qc, card.id, (c) => ({ ...c, balance_cents: newBal, status: statusFor(newBal, c.face_value_cents) }), -total);
    try {
      const r = await api<MutationResult>(`/cards/${card.id}/redeem`, { idempotencyKey: key.current, body: { amount_cents: amount, tip_cents: tip, ref: ref.trim() || undefined } });
      applyResult(qc, r);
      setDone(r);
      const undoSec = me?.settings.security.undo_window_sec ?? 10;
      toast.push({
        kind: 'success',
        title: `Redeemed ${formatCents(total)} — ${formatCents(r.balance_cents)} left`,
        message: `Card ${r.card.card_number}`,
        duration: undoSec * 1000,
        action: undoSec
          ? {
              label: 'Undo',
              onClick: async () => {
                try {
                  // reverse tip first (if any) then the redemption
                  if (r.tip_transaction) await api(`/transactions/${r.tip_transaction.id}/reverse`, { body: { reason: 'Undo' } });
                  const u = await api<MutationResult>(`/transactions/${r.transaction!.id}/reverse`, { body: { reason: 'Undo' } });
                  applyResult(qc, u);
                  toast.push({ kind: 'info', title: 'Redemption undone', message: `Balance restored to ${formatCents(u.balance_cents)}` });
                } catch (e) {
                  toast.push({ kind: 'error', title: 'Undo failed', message: e instanceof Error ? e.message : '' });
                }
              },
            }
          : undefined,
      });
      if (me?.settings.printer.auto_print.redeem) print(r.card.id, r.transaction?.id);
    } catch (e) {
      rollback();
      if (e instanceof ApiError && e.code === 'NETWORK') {
        setOfflineOffer(true);
      } else if (e instanceof ApiError) {
        toast.push({ kind: 'error', title: e.code === 'INSUFFICIENT_FUNDS' ? 'Insufficient balance' : 'Redemption failed', message: e.message });
        if (['INSUFFICIENT_FUNDS', 'CARD_FROZEN', 'CARD_EXPIRED', 'CARD_VOIDED'].includes(e.code)) {
          api<{ card: Card }>(`/cards/${card.id}`).then((x) => setCard(x.card)).catch(() => {});
        }
        key.current = uuid();
      }
    } finally {
      setBusy(false);
    }
  };

  const queueOffline = () => {
    if (!card) return;
    const cap = me?.settings.security.offline_max_redeem_cents ?? 0;
    if (total > cap) {
      toast.push({ kind: 'error', title: 'Too large for offline', message: `Offline limit is ${formatCents(cap)}. Wait for the connection.` });
      return;
    }
    try {
      enqueueRedeem({ key: key.current, card_id: card.id, card_number: card.card_number, amount_cents: amount, tip_cents: tip, ref: ref || undefined, last_known_balance_cents: card.balance_cents });
      toast.push({ kind: 'warning', title: 'Saved offline', message: `${formatCents(total)} on ${card.card_number} will sync when the connection is back.` });
      onClose();
    } catch (e) {
      toast.push({ kind: 'error', title: 'Cannot queue', message: e instanceof Error ? e.message : '' });
    }
  };

  // ---------------------------------------------------------------- views
  if (done) {
    return (
      <Modal open onClose={onClose} title="Redeemed" size="sm">
        <div className="text-center" aria-live="polite">
          <CheckCircle2 className="mx-auto h-14 w-14 text-emerald-600" aria-hidden />
          <p className="mt-2 text-lg">Remaining balance</p>
          <p className="text-5xl font-bold tabular-nums">{formatCents(done.balance_cents)}</p>
          <div className="mt-2">
            <StatusPill status={done.status} />
          </div>
        </div>
        <div className="mt-5 grid grid-cols-2 gap-2">
          <Button variant="secondary" onClick={() => print(done.card.id, done.transaction?.id)}>
            <Printer className="h-5 w-5" /> Print
          </Button>
          <Button onClick={onClose} autoFocus>
            Done
          </Button>
        </div>
      </Modal>
    );
  }

  if (!card) {
    return (
      <Modal open onClose={onClose} title="Redeem gift card" size="sm" initialFocus="#redeem-scan">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (scan.trim()) doLookup(scan);
          }}
          className="space-y-3"
        >
          <ScanLine className="mx-auto h-16 w-16 text-brand-600" aria-hidden />
          <p className="text-center text-lg">Scan the card or type its number</p>
          <Field label="Card number" htmlFor="redeem-scan" error={scanErr}>
            <input id="redeem-scan" data-scanner="1" className={`${inputCls} text-center font-mono text-2xl tracking-widest`} inputMode="numeric" autoComplete="off" value={scan} onChange={(e) => setScan(e.target.value)} aria-invalid={!!scanErr} />
          </Field>
          <Button type="submit" size="lg" className="w-full" disabled={!scan.trim()}>
            Look up
          </Button>
        </form>
      </Modal>
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Redeem"
      size="md"
      footer={
        offlineOffer ? (
          <>
            <Button variant="secondary" onClick={() => setOfflineOffer(false)}>
              Back
            </Button>
            <Button variant="danger" onClick={queueOffline}>
              <WifiOff className="h-5 w-5" /> Save offline & sync later
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button size="lg" variant="success" onClick={confirm} loading={busy} disabled={amount <= 0 || insufficient || blocked}>
              Redeem {formatCents(total)}
            </Button>
          </>
        )
      }
    >
      <div className="mb-4 flex items-start justify-between gap-3 rounded-xl bg-zinc-100 p-4 dark:bg-zinc-800">
        <div className="min-w-0">
          <p className="font-mono text-xl font-bold tracking-wider">{card.card_number}</p>
          <p className="truncate text-zinc-600 dark:text-zinc-300">{holderName(card.customer) || card.label || 'No holder on file'}</p>
          <div className="mt-1">
            <StatusPill status={card.status} size="sm" />
          </div>
        </div>
        <div className="text-right">
          <p className="text-xs font-semibold uppercase text-zinc-500">Balance</p>
          <p className="text-4xl font-bold tabular-nums" aria-live="polite">
            {formatCents(card.balance_cents)}
          </p>
        </div>
      </div>

      {offlineOffer && (
        <div role="alert" className="mb-4 rounded-lg border-2 border-amber-500 bg-amber-50 p-4 text-amber-900 dark:bg-amber-950 dark:text-amber-100">
          <p className="flex items-center gap-2 font-bold">
            <WifiOff className="h-5 w-5" /> No connection to the server
          </p>
          <p className="mt-1 text-sm">You can save this redemption on this device. It will sync automatically when the connection returns. Balance shown may be out of date if the card was used at another terminal.</p>
        </div>
      )}

      {(blocked || expiredByDate) && (
        <div role="alert" className="mb-4 flex gap-3 rounded-lg border-2 border-red-500 bg-red-50 p-4 text-red-900 dark:bg-red-950 dark:text-red-100">
          <AlertOctagon className="h-6 w-6 shrink-0" />
          <div>
            <p className="font-bold">{expiredByDate ? 'This card has expired' : `This card is ${STATUS[card.status].label.toLowerCase()}`}</p>
            <p className="text-sm">{card.freeze_reason ?? STATUS[card.status].hint}</p>
          </div>
        </div>
      )}

      <AmountKeypad
        value={amount}
        onChange={setAmount}
        label="Service amount"
        onEnter={confirm}
        error={insufficient ? `Insufficient: ${formatCents(card.balance_cents)} available` : null}
      />
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" onClick={() => setAmount(Math.max(0, card.balance_cents - tip))} disabled={blocked || card.balance_cents === 0}>
          Use full balance ({formatCents(card.balance_cents)})
        </Button>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Field label="Tip from card (optional)" htmlFor="r-tip">
          <div className="flex gap-2">
            {[15, 20].map((p) => (
              <Button key={p} variant="secondary" size="sm" onClick={() => setTip(Math.round((amount * p) / 100))} disabled={!amount}>
                {p}%
              </Button>
            ))}
            <input
              id="r-tip"
              className={`${inputCls} text-right`}
              inputMode="decimal"
              value={tip ? (tip / 100).toFixed(2) : ''}
              placeholder="0.00"
              onChange={(e) => {
                const v = e.target.value.replace(/[^\d.]/g, '');
                const [d, f = ''] = v.split('.');
                setTip(Number(d || 0) * 100 + Number(f.slice(0, 2).padEnd(2, '0')));
              }}
            />
          </div>
        </Field>
        <Field label="Ticket / receipt # (optional)" htmlFor="r-ref">
          <input id="r-ref" className={inputCls} maxLength={80} value={ref} onChange={(e) => setRef(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
