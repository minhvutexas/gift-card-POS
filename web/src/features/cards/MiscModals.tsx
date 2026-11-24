import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, uuid } from '../../lib/api';
import { formatCents } from '../../lib/money';
import { TAG_COLORS } from '../../lib/status';
import { useToast } from '../../lib/toast';
import type { Card, MutationResult, Tag } from '../../lib/types';
import { Button, Field, inputCls, Modal, TagChip } from '../../components/ui';
import { applyResult } from './cache';

function useSubmit(onClose: () => void) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const key = useRef(uuid());
  const run = async (fn: (key: string) => Promise<MutationResult | void>, success?: string) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await fn(key.current);
      if (r && 'card' in r) applyResult(qc, r);
      qc.invalidateQueries({ queryKey: ['cards'] });
      if (success) toast.push({ kind: 'success', title: success });
      onClose();
    } catch (e) {
      if (e instanceof ApiError) setErr(e.message);
      key.current = uuid();
    } finally {
      setBusy(false);
    }
  };
  return { busy, err, run, setErr };
}

// ------------------------------------------------------------------ replace lost
export function ReplaceModal({ card, onClose }: { card: Card; onClose: () => void }) {
  const [num, setNum] = useState('');
  const [reason, setReason] = useState('Reported lost');
  const s = useSubmit(onClose);
  return (
    <Modal
      open
      onClose={onClose}
      title="Replace lost card"
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={s.busy}
            onClick={() =>
              s.run(async (k) => {
                const r = await api<{ old: MutationResult; new: MutationResult }>(`/cards/${card.id}/replace`, { idempotencyKey: k, body: { new_number: num.trim() || null, reason } });
                return r.new;
              }, 'Balance moved to the replacement card')
            }
          >
            Move {formatCents(card.balance_cents)} to new card
          </Button>
        </>
      }
    >
      <p className="mb-3 text-sm text-slate-600 dark:text-slate-300">
        The old card <strong className="font-mono">{card.card_number}</strong> becomes “Replaced” and can never be used again. Holder, label, expiry and PIN carry over; history links both cards.
      </p>
      <Field label="New card number (scan, or blank for auto)" htmlFor="rp-num" error={s.err}>
        <input id="rp-num" data-scanner="1" autoFocus className={`${inputCls} font-mono`} value={num} onChange={(e) => setNum(e.target.value.toUpperCase())} />
      </Field>
      <div className="mt-3">
        <Field label="Reason" htmlFor="rp-reason">
          <input id="rp-reason" className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ email / sms
export function SendModal({ card, onClose }: { card: Card; onClose: () => void }) {
  const [channel, setChannel] = useState<'EMAIL' | 'SMS'>(card.customer?.email ? 'EMAIL' : 'SMS');
  const [to, setTo] = useState(channel === 'EMAIL' ? (card.customer?.email ?? '') : (card.customer?.phone ?? ''));
  const [tpl, setTpl] = useState('card_delivered');
  const s = useSubmit(onClose);
  return (
    <Modal
      open
      onClose={onClose}
      title="Send card to customer"
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={s.busy} disabled={!to.trim()} onClick={() => s.run((k) => api(`/cards/${card.id}/send`, { idempotencyKey: k, body: { channel, to: to.trim(), template_key: tpl } }), `${channel === 'EMAIL' ? 'Email' : 'SMS'} sent`)}>
            Send
          </Button>
        </>
      }
    >
      <div className="mb-3 grid grid-cols-2 gap-2" role="radiogroup" aria-label="Channel">
        {(['EMAIL', 'SMS'] as const).map((c) => (
          <button
            key={c}
            role="radio"
            aria-checked={channel === c}
            onClick={() => {
              setChannel(c);
              setTo(c === 'EMAIL' ? (card.customer?.email ?? '') : (card.customer?.phone ?? ''));
            }}
            className={`min-h-[48px] rounded-xl font-semibold ring-2 ring-inset ${channel === c ? 'bg-brand-600 text-white ring-brand-600' : 'ring-slate-300 dark:ring-slate-600'}`}
          >
            {c === 'EMAIL' ? 'Email' : 'Text message'}
          </button>
        ))}
      </div>
      <Field label={channel === 'EMAIL' ? 'Email address' : 'Mobile number'} htmlFor="send-to" error={s.err}>
        <input id="send-to" className={inputCls} type={channel === 'EMAIL' ? 'email' : 'tel'} value={to} onChange={(e) => setTo(e.target.value)} />
      </Field>
      <div className="mt-3">
        <Field label="Message" htmlFor="send-tpl">
          <select id="send-tpl" className={inputCls} value={tpl} onChange={(e) => setTpl(e.target.value)}>
            <option value="card_delivered">Card delivered (balance + link)</option>
            <option value="low_balance">Low balance reminder</option>
            <option value="expiry_warning">Expiry reminder</option>
          </select>
        </Field>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ label + tags
export function TagsModal({ card, onClose }: { card: Card; onClose: () => void }) {
  const qc = useQueryClient();
  const tags = useQuery({ queryKey: ['tags'], queryFn: () => api<{ data: Tag[] }>('/tags') });
  const [label, setLabel] = useState(card.label ?? '');
  const [color, setColor] = useState(card.color_tag ?? '');
  const [ids, setIds] = useState(card.tags.map((t) => t.id));
  const [newTag, setNewTag] = useState('');
  const s = useSubmit(onClose);
  const addTag = async () => {
    if (!newTag.trim()) return;
    try {
      const t = await api<Tag>('/tags', { body: { name: newTag.trim(), color: 'pink' } });
      setIds((x) => [...x, t.id]);
      setNewTag('');
      qc.invalidateQueries({ queryKey: ['tags'] });
    } catch (e) {
      s.setErr(e instanceof ApiError ? e.message : 'Could not add tag');
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title="🏷 Label & tags"
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={s.busy}
            onClick={() =>
              s.run(async (k) => {
                await api(`/cards/${card.id}`, { method: 'PATCH', idempotencyKey: k, body: { label: label.trim() || null, color_tag: color || null } });
                return api<MutationResult>(`/cards/${card.id}/tags`, { method: 'PUT', idempotencyKey: `${k}:tags`, body: { tag_ids: ids } });
              }, 'Label saved')
            }
          >
            Save
          </Button>
        </>
      }
    >
      <Field label="Label" htmlFor="tg-label" error={s.err}>
        <input id="tg-label" className={inputCls} maxLength={60} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Birthday gift for Anna" />
      </Field>
      <fieldset className="mt-3">
        <legend className="mb-1 text-sm font-semibold">Colour</legend>
        <div className="flex flex-wrap gap-2">
          {['', ...Object.keys(TAG_COLORS)].map((c) => (
            <button key={c || 'none'} onClick={() => setColor(c)} aria-pressed={color === c} aria-label={c || 'No colour'} className={`h-11 w-11 rounded-full ring-2 ring-offset-2 dark:ring-offset-slate-900 ${color === c ? 'ring-slate-900 dark:ring-white' : 'ring-transparent'} ${c ? TAG_COLORS[c] : 'bg-white ring-slate-300'}`} />
          ))}
        </div>
      </fieldset>
      <fieldset className="mt-3">
        <legend className="mb-1 text-sm font-semibold">Tags</legend>
        <div className="flex flex-wrap gap-2">
          {tags.data?.data.map((t) => (
            <label key={t.id} className={`flex min-h-[44px] cursor-pointer items-center gap-2 rounded-xl px-3 ring-1 ring-inset ${ids.includes(t.id) ? 'bg-brand-50 ring-brand-500 dark:bg-brand-900/30' : 'ring-slate-300 dark:ring-slate-600'}`}>
              <input type="checkbox" className="h-5 w-5" checked={ids.includes(t.id)} onChange={(e) => setIds((x) => (e.target.checked ? [...x, t.id] : x.filter((y) => y !== t.id)))} />
              <TagChip tag={t} />
            </label>
          ))}
        </div>
        <div className="mt-2 flex gap-2">
          <input className={inputCls} placeholder="New tag" value={newTag} onChange={(e) => setNewTag(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addTag()} aria-label="New tag name" />
          <Button variant="secondary" onClick={addTag}>
            Add
          </Button>
        </div>
      </fieldset>
    </Modal>
  );
}

// ------------------------------------------------------------------ note
export function NoteModal({ card, onClose }: { card: Card; onClose: () => void }) {
  const [note, setNote] = useState('');
  const s = useSubmit(onClose);
  return (
    <Modal
      open
      onClose={onClose}
      title="Add note"
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={s.busy} disabled={!note.trim()} onClick={() => s.run((k) => api<MutationResult>(`/cards/${card.id}/notes`, { idempotencyKey: k, body: { note: note.trim() } }), 'Note added')}>
            Save note
          </Button>
        </>
      }
    >
      {card.notes && <pre className="mb-3 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-100 p-3 text-sm dark:bg-slate-800">{card.notes}</pre>}
      <Field label="Note (timestamped with your name)" htmlFor="note" error={s.err}>
        <textarea id="note" autoFocus rows={3} className={`${inputCls} py-2`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
      </Field>
    </Modal>
  );
}

// ------------------------------------------------------------------ card PIN (kiosk)
export function PinModal({ card, onClose }: { card: Card; onClose: () => void }) {
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [verified, setVerified] = useState(false);
  const s = useSubmit(onClose);
  const save = (value: string | null) => {
    if (value !== null) {
      if (!/^\d{4,8}$/.test(value)) return s.setErr('PIN must be 4–8 digits');
      if (value !== confirm) return s.setErr('The two PINs don’t match');
    }
    s.run((k) => api<MutationResult>(`/cards/${card.id}`, { method: 'PATCH', idempotencyKey: k, body: { pin: value } }), value ? 'Card PIN updated' : 'Card PIN removed');
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={card.has_pin ? 'Reset card PIN' : 'Set card PIN'}
      size="sm"
      footer={
        <>
          {card.has_pin && (
            <Button variant="secondary" onClick={() => save(null)} loading={s.busy} disabled={!verified}>
              Remove PIN
            </Button>
          )}
          <Button onClick={() => save(pin)} loading={s.busy} disabled={!verified || pin.length < 4}>
            Save PIN
          </Button>
        </>
      }
    >
      <p className="mb-3 text-sm text-slate-600 dark:text-slate-300">
        The customer uses this PIN with card <strong className="font-mono">{card.card_number}</strong> to check their balance at the kiosk. Saving also unlocks the card if it was locked after wrong guesses.
      </p>
      <label className="mb-3 flex min-h-[48px] items-center gap-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">
        <input type="checkbox" className="h-5 w-5" checked={verified} onChange={(e) => setVerified(e.target.checked)} />
        I checked the customer’s ID or that they hold the physical card / receipt.
      </label>
      <div className="grid grid-cols-2 gap-3">
        <Field label="New PIN" htmlFor="pin-new" error={s.err}>
          <input id="pin-new" className={`${inputCls} text-center font-mono text-xl tracking-widest`} inputMode="numeric" autoComplete="off" maxLength={8} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} />
        </Field>
        <Field label="Repeat PIN" htmlFor="pin-confirm">
          <input id="pin-confirm" className={`${inputCls} text-center font-mono text-xl tracking-widest`} inputMode="numeric" autoComplete="off" maxLength={8} value={confirm} onChange={(e) => setConfirm(e.target.value.replace(/\D/g, ''))} />
        </Field>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ expiry
export function ExpiryModal({ card, onClose }: { card: Card; onClose: () => void }) {
  const [date, setDate] = useState(card.expires_at ? card.expires_at.slice(0, 10) : '');
  const s = useSubmit(onClose);
  const save = (value: string | null) =>
    s.run((k) => api<MutationResult>(`/cards/${card.id}`, { method: 'PATCH', idempotencyKey: k, body: { expires_at: value ? new Date(`${value}T23:59:59`).toISOString() : null } }), value ? 'Expiry set' : 'Expiry cleared');
  return (
    <Modal
      open
      onClose={onClose}
      title="Set / clear expiry"
      size="sm"
      footer={
        <>
          {card.expires_at && (
            <Button variant="secondary" onClick={() => save(null)} loading={s.busy}>
              Clear expiry
            </Button>
          )}
          <Button onClick={() => save(date)} loading={s.busy} disabled={!date}>
            Save
          </Button>
        </>
      }
    >
      <p className="mb-3 text-sm text-slate-600 dark:text-slate-300">Check local gift-card law before setting an expiry (many US states require 5+ years or none).</p>
      <Field label="Expires on" htmlFor="exp" error={s.err}>
        <input id="exp" type="date" className={inputCls} min={new Date(Date.now() + 86400000).toISOString().slice(0, 10)} value={date} onChange={(e) => setDate(e.target.value)} />
      </Field>
    </Modal>
  );
}
