import type { QueryClient } from '@tanstack/react-query';
import type { Card, CardList, MutationResult } from '../../lib/types';

/** Write a fresh card into every cached list + detail, and update the liability. */
export function applyResult(qc: QueryClient, r: Pick<MutationResult, 'card' | 'outstanding_total_cents'>) {
  qc.setQueriesData<CardList>({ queryKey: ['cards', 'list'] }, (old) =>
    old ? { ...old, data: old.data.map((c) => (c.id === r.card.id ? r.card : c)), meta: { ...old.meta, outstanding_total_cents: r.outstanding_total_cents } } : old,
  );
  qc.setQueryData<number>(['outstanding'], r.outstanding_total_cents);
  qc.invalidateQueries({ queryKey: ['card', r.card.id] });
  qc.invalidateQueries({ queryKey: ['dashboard'] });
  qc.invalidateQueries({ queryKey: ['history'] });
}

/** Optimistically change a card in lists; returns a rollback fn. */
export function optimistic(qc: QueryClient, cardId: number, patch: (c: Card) => Card, outstandingDelta = 0) {
  const lists = qc.getQueriesData<CardList>({ queryKey: ['cards', 'list'] });
  const outstanding = qc.getQueryData<number>(['outstanding']);
  qc.setQueriesData<CardList>({ queryKey: ['cards', 'list'] }, (old) =>
    old ? { ...old, data: old.data.map((c) => (c.id === cardId ? patch(c) : c)), meta: { ...old.meta, outstanding_total_cents: old.meta.outstanding_total_cents + outstandingDelta } } : old,
  );
  if (outstanding !== undefined) qc.setQueryData(['outstanding'], outstanding + outstandingDelta);
  return () => {
    lists.forEach(([k, v]) => qc.setQueryData(k, v));
    if (outstanding !== undefined) qc.setQueryData(['outstanding'], outstanding);
  };
}

/** Mirrors fn_status_for_balance for optimistic display. */
export const statusFor = (balance: number, face: number) => (balance === 0 ? 'CLOSED' : balance >= face ? 'ACTIVE' : 'PARTIALUSED') as Card['status'];
