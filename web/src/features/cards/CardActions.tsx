import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { usePrinter } from '../../components/Receipt';
import type { Card } from '../../lib/types';
import { IssueCardModal } from './IssueCardModal';
import { RedeemModal } from './RedeemModal';
import { AmountModal } from './AmountModal';
import { ReasonModal } from './ReasonModal';
import { TransferModal } from './TransferModal';
import { ReplaceModal, SendModal, TagsModal, NoteModal, ExpiryModal, PinModal } from './MiscModals';
import { ArchiveZeroModal } from './ArchiveZeroModal';
import { CardDrawer } from './CardDrawer';

export type ActionKind =
  | 'issue' | 'redeem' | 'reload' | 'refund' | 'adjust' | 'activate'
  | 'freeze' | 'unfreeze' | 'void' | 'delete'
  | 'transfer' | 'merge' | 'split' | 'replace'
  | 'send' | 'tags' | 'note' | 'expiry' | 'pin' | 'details' | 'archive';

interface Ctx {
  open: (kind: ActionKind, card?: Card | null, extra?: Record<string, unknown>) => void;
  print: (cardId: number, txnId?: number) => Promise<void>;
}
const C = createContext<Ctx | null>(null);

/**
 * One place that owns every card modal, so any screen (list row menu, drawer,
 * dashboard, scanner) can trigger any action with `open('redeem', card)`.
 */
export function CardActionsProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ kind: ActionKind; card: Card | null; extra?: Record<string, unknown> } | null>(null);
  const [drawer, setDrawer] = useState<number | null>(null);
  const { print, printNode } = usePrinter();

  const open = useCallback((kind: ActionKind, card?: Card | null, extra?: Record<string, unknown>) => {
    if (kind === 'details') {
      if (card) setDrawer(card.id);
      return;
    }
    setState({ kind, card: card ?? null, extra });
  }, []);
  const close = () => setState(null);
  const k = state?.kind;
  const card = state?.card ?? null;

  return (
    <C.Provider value={{ open, print }}>
      {children}
      {drawer !== null && <CardDrawer cardId={drawer} onClose={() => setDrawer(null)} />}
      {k === 'issue' && <IssueCardModal onClose={close} initialNumber={(state?.extra?.number as string) ?? ''} />}
      {k === 'redeem' && <RedeemModal onClose={close} card={card} />}
      {(k === 'reload' || k === 'refund' || k === 'adjust' || k === 'activate') && card && <AmountModal kind={k} card={card} onClose={close} />}
      {(k === 'freeze' || k === 'unfreeze' || k === 'void' || k === 'delete') && card && <ReasonModal kind={k} card={card} onClose={close} />}
      {(k === 'transfer' || k === 'merge' || k === 'split') && card && <TransferModal kind={k} card={card} onClose={close} />}
      {k === 'replace' && card && <ReplaceModal card={card} onClose={close} />}
      {k === 'send' && card && <SendModal card={card} onClose={close} />}
      {k === 'tags' && card && <TagsModal card={card} onClose={close} />}
      {k === 'note' && card && <NoteModal card={card} onClose={close} />}
      {k === 'expiry' && card && <ExpiryModal card={card} onClose={close} />}
      {k === 'pin' && card && <PinModal card={card} onClose={close} />}
      {k === 'archive' && <ArchiveZeroModal onClose={close} />}
      {printNode}
    </C.Provider>
  );
}

export function useCardActions() {
  const c = useContext(C);
  if (!c) throw new Error('useCardActions outside provider');
  return c;
}
