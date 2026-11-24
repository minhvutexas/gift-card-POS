import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeftRight, Ban, CalendarClock, Combine, Eye, FileText, MoreVertical, Printer, Receipt, RefreshCcw,
  Scissors, Send, Snowflake, StickyNote, Tag as TagIcon, Trash2, Undo2, Wallet, Sun, Repeat, Power, KeyRound,
} from 'lucide-react';
import { openPdf } from '../../lib/api';
import { useSession } from '../../lib/session';
import type { Card } from '../../lib/types';
import { useCardActions, type ActionKind } from './CardActions';

interface Item {
  kind: ActionKind | 'print' | 'statement';
  label: string;
  icon: typeof Eye;
  perm: string;
  danger?: boolean;
  show: (c: Card) => boolean;
}

const live = (c: Card) => c.status === 'ACTIVE' || c.status === 'PARTIALUSED';
const terminal = (c: Card) => ['VOIDED', 'EXPIRED', 'LOST_REPLACED'].includes(c.status);

export const CARD_ITEMS: Item[] = [
  { kind: 'details', label: 'View details', icon: Eye, perm: 'cards.read', show: () => true },
  { kind: 'redeem', label: 'Redeem / spend', icon: Wallet, perm: 'cards.redeem', show: live },
  { kind: 'activate', label: 'Activate', icon: Power, perm: 'cards.issue', show: (c) => c.status === 'PENDING_ACTIVATION' },
  { kind: 'reload', label: 'Reload / top-up', icon: RefreshCcw, perm: 'cards.reload', show: (c) => live(c) || c.status === 'CLOSED' },
  { kind: 'refund', label: 'Refund to card', icon: Undo2, perm: 'cards.refund', show: (c) => live(c) || c.status === 'CLOSED' },
  { kind: 'adjust', label: 'Adjust balance', icon: Receipt, perm: 'cards.adjust', show: (c) => !terminal(c) && c.status !== 'PENDING_ACTIVATION' },
  { kind: 'freeze', label: 'Freeze', icon: Snowflake, perm: 'cards.freeze', show: (c) => !terminal(c) && c.status !== 'FROZEN' },
  { kind: 'unfreeze', label: 'Unfreeze', icon: Sun, perm: 'cards.freeze', show: (c) => c.status === 'FROZEN' },
  { kind: 'print', label: 'Print receipt', icon: Printer, perm: 'cards.print', show: () => true },
  { kind: 'send', label: 'Email / SMS', icon: Send, perm: 'cards.send', show: (c) => !terminal(c) },
  { kind: 'tags', label: 'Label & tags', icon: TagIcon, perm: 'cards.edit', show: () => true },
  { kind: 'note', label: 'Add note', icon: StickyNote, perm: 'cards.edit', show: () => true },
  { kind: 'transfer', label: 'Transfer balance', icon: ArrowLeftRight, perm: 'cards.transfer', show: live },
  { kind: 'merge', label: 'Merge into another card', icon: Combine, perm: 'cards.merge', show: live },
  { kind: 'split', label: 'Split into new card', icon: Scissors, perm: 'cards.transfer', show: live },
  { kind: 'replace', label: 'Replace lost card', icon: Repeat, perm: 'cards.replace', show: (c) => (live(c) || c.status === 'FROZEN') && c.balance_cents > 0 },
  { kind: 'pin', label: 'Set / reset PIN', icon: KeyRound, perm: 'cards.edit', show: (c) => !terminal(c) },
  { kind: 'expiry', label: 'Set / clear expiry', icon: CalendarClock, perm: 'cards.edit', show: (c) => !terminal(c) },
  { kind: 'statement', label: 'Statement (PDF)', icon: FileText, perm: 'cards.read', show: () => true },
  { kind: 'void', label: 'Void', icon: Ban, perm: 'cards.void', danger: true, show: (c) => !terminal(c) },
  { kind: 'delete', label: 'Delete', icon: Trash2, perm: 'cards.delete', danger: true, show: (c) => c.balance_cents === 0 },
];

export function useCardItems(card: Card) {
  const { can } = useSession();
  const { open, print } = useCardActions();
  const items = CARD_ITEMS.filter((i) => i.show(card) && can(i.perm));
  const run = (kind: Item['kind']) => {
    if (kind === 'print') return print(card.id);
    if (kind === 'statement') return openPdf(`/cards/statement/${card.id}.pdf`);
    open(kind, card);
  };
  return { items, run };
}

/** ⋮ row menu — keyboard navigable (arrows / Esc), 44px targets. */
export function CardMenu({ card }: { card: Card }) {
  const { items, run } = useCardItems(card);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const first = ref.current?.querySelector<HTMLElement>('[role="menuitem"]');
    first?.focus();
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  return (
    <div className="relative">
      <button
        ref={btn}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Actions for card ${card.card_number}`}
        className="flex h-11 w-11 items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
      >
        <MoreVertical className="h-5 w-5" />
      </button>
      {open && (
        <div
          ref={ref}
          role="menu"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            const els = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
            const i = els.indexOf(document.activeElement as HTMLElement);
            if (e.key === 'ArrowDown') els[(i + 1) % els.length]?.focus();
            else if (e.key === 'ArrowUp') els[(i - 1 + els.length) % els.length]?.focus();
            else if (e.key === 'Escape') {
              setOpen(false);
              btn.current?.focus();
            } else return;
            e.preventDefault();
          }}
          className="absolute right-0 z-30 mt-1 max-h-[70vh] w-60 overflow-auto rounded-xl bg-white py-1 shadow-xl ring-1 ring-slate-200 animate-pop dark:bg-slate-900 dark:ring-slate-700"
        >
          {items.map((it, idx) => (
            <div key={it.kind}>
              {it.danger && !items[idx - 1]?.danger && <hr className="my-1 border-slate-200 dark:border-slate-700" />}
              <button
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  run(it.kind);
                }}
                className={`flex min-h-[44px] w-full items-center gap-3 px-4 text-left text-sm font-medium hover:bg-slate-100 focus:bg-slate-100 focus:outline-none dark:hover:bg-slate-800 dark:focus:bg-slate-800 ${it.danger ? 'text-red-700 dark:text-red-400' : ''}`}
              >
                <it.icon className="h-4 w-4" aria-hidden />
                {it.label}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
