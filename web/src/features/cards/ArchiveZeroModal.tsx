import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Archive, Undo2 } from 'lucide-react';
import { api, ApiError, uuid } from '../../lib/api';
import { formatCents } from '../../lib/money';
import { useToast } from '../../lib/toast';
import { Button, Modal, SkeletonRows } from '../../components/ui';

interface ArchiveResult {
  dry_run: boolean;
  count: number;
  face_value_total_cents: number;
  card_ids: number[];
  cards: { id: number; card_number: string; status: string; face_value_cents: number }[];
  undo_until: string | null;
}

/** 🗑 Clear Zero-Balance: preview → confirm (manager) → 30-day undo. */
export function ArchiveZeroModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [preview, setPreview] = useState<ArchiveResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const key = useRef(uuid());

  useEffect(() => {
    api<ArchiveResult>('/cards/archive-zero', { body: { dry_run: true } })
      .then(setPreview)
      .catch((e) => setErr(e instanceof ApiError ? e.message : 'Could not load preview'));
  }, []);

  const commit = async () => {
    setBusy(true);
    try {
      const r = await api<ArchiveResult>('/cards/archive-zero', { idempotencyKey: key.current, body: { dry_run: false } });
      qc.invalidateQueries({ queryKey: ['cards'] });
      toast.push({
        kind: 'success',
        title: `Archived ${r.count} zero-balance card${r.count === 1 ? '' : 's'}`,
        message: `Restorable until ${new Date(r.undo_until!).toLocaleDateString()}. History is kept forever.`,
        duration: 15000,
        action: {
          label: 'Undo',
          onClick: async () => {
            await api('/cards/archive-restore', { body: { card_ids: r.card_ids } });
            qc.invalidateQueries({ queryKey: ['cards'] });
            toast.push({ kind: 'info', title: 'Archive undone' });
          },
        },
      });
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
      title={<span className="flex items-center gap-2"><Archive className="h-6 w-6" /> Clear zero-balance cards</span>}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" onClick={commit} loading={busy} disabled={!preview?.count}>
            Archive {preview?.count ?? ''} card{preview?.count === 1 ? '' : 's'}
          </Button>
        </>
      }
    >
      {err && (
        <p role="alert" className="mb-3 font-semibold text-red-600">
          {err}
        </p>
      )}
      {!preview && !err && <SkeletonRows rows={3} />}
      {preview && (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3">
            <div className="rounded-xl bg-slate-100 p-4 text-center dark:bg-slate-800">
              <p className="text-4xl font-extrabold">{preview.count}</p>
              <p className="text-sm text-slate-500">cards at $0.00</p>
            </div>
            <div className="rounded-xl bg-slate-100 p-4 text-center dark:bg-slate-800">
              <p className="text-3xl font-extrabold tabular-nums">{formatCents(preview.face_value_total_cents)}</p>
              <p className="text-sm text-slate-500">original face value</p>
            </div>
          </div>
          <p className="mb-3 text-sm text-slate-600 dark:text-slate-300">
            Moves closed, expired, voided and replaced cards with a $0 balance out of the main list. Nothing is deleted: history stays forever and you can <Undo2 className="inline h-4 w-4" /> restore for 30 days. Manager approval required.
          </p>
          {preview.count > 0 && (
            <ul className="max-h-48 divide-y divide-slate-200 overflow-auto rounded-xl ring-1 ring-slate-200 dark:divide-slate-800 dark:ring-slate-800">
              {preview.cards.map((c) => (
                <li key={c.id} className="flex justify-between px-3 py-2 text-sm">
                  <span className="font-mono">{c.card_number}</span>
                  <span className="text-slate-500">{c.status}</span>
                  <span className="tabular-nums">{formatCents(c.face_value_cents)}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Modal>
  );
}
