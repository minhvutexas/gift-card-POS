import type { CardStatus } from './types';

/**
 * Status colour system. Every pill also carries an icon glyph + text label,
 * so status is never conveyed by colour alone (WCAG 1.4.1).
 */
export const STATUS: Record<CardStatus, { label: string; glyph: string; pill: string; dot: string; hint: string }> = {
  ACTIVE: {
    label: 'Active',
    glyph: '●',
    pill: 'bg-emerald-100 text-emerald-900 ring-emerald-600/30 dark:bg-emerald-500/15 dark:text-emerald-200 dark:ring-emerald-400/30',
    dot: 'bg-emerald-500',
    hint: 'Full value available',
  },
  PARTIALUSED: {
    label: 'Partially used',
    glyph: '◐',
    pill: 'bg-amber-100 text-amber-900 ring-amber-600/30 dark:bg-amber-500/15 dark:text-amber-200 dark:ring-amber-400/30',
    dot: 'bg-amber-500',
    hint: 'Some value spent',
  },
  CLOSED: {
    label: 'Zero balance',
    glyph: '○',
    pill: 'bg-slate-200 text-slate-800 ring-slate-500/30 dark:bg-slate-500/20 dark:text-slate-200 dark:ring-slate-400/30',
    dot: 'bg-slate-400',
    hint: 'Fully redeemed — can be reloaded',
  },
  PENDING_ACTIVATION: {
    label: 'Pending',
    glyph: '◌',
    pill: 'bg-violet-100 text-violet-900 ring-violet-600/30 dark:bg-violet-500/15 dark:text-violet-200 dark:ring-violet-400/30',
    dot: 'bg-violet-500',
    hint: 'Not activated yet',
  },
  FROZEN: {
    label: 'Frozen',
    glyph: '❄',
    pill: 'bg-sky-100 text-sky-900 ring-sky-600/30 dark:bg-sky-500/15 dark:text-sky-200 dark:ring-sky-400/30',
    dot: 'bg-sky-500',
    hint: 'Blocked — unfreeze to use',
  },
  EXPIRED: {
    label: 'Expired',
    glyph: '⌛',
    pill: 'bg-red-100 text-red-900 ring-red-600/30 dark:bg-red-500/15 dark:text-red-200 dark:ring-red-400/30',
    dot: 'bg-red-500',
    hint: 'Past expiry date',
  },
  VOIDED: {
    label: 'Voided',
    glyph: '⊘',
    pill: 'bg-red-100 text-red-900 ring-red-600/30 dark:bg-red-500/15 dark:text-red-200 dark:ring-red-400/30',
    dot: 'bg-red-500',
    hint: 'Cancelled permanently',
  },
  LOST_REPLACED: {
    label: 'Replaced',
    glyph: '⇄',
    pill: 'bg-rose-100 text-rose-900 ring-rose-600/30 dark:bg-rose-500/15 dark:text-rose-200 dark:ring-rose-400/30',
    dot: 'bg-rose-500',
    hint: 'Balance moved to a new card',
  },
};

export const TXN_LABEL: Record<string, string> = {
  ISSUE: 'Issued',
  ACTIVATE: 'Activated',
  RELOAD: 'Reload',
  REDEEM: 'Redeemed',
  REFUND_TO_CARD: 'Refund to card',
  TIP_FROM_CARD: 'Tip',
  ADJUSTMENT: 'Adjustment',
  TRANSFER_OUT: 'Transfer out',
  TRANSFER_IN: 'Transfer in',
  MERGE_OUT: 'Merged out',
  MERGE_IN: 'Merged in',
  VOID: 'Voided',
  EXPIRE: 'Expired',
  REPLACE_OUT: 'Replaced (out)',
  REPLACE_IN: 'Replacement (in)',
  REVERSAL: 'Reversal',
};

export const actionLabel = (a: string) =>
  TXN_LABEL[a] ??
  a
    .replace(/^(card|cards|auth|alert|data|import|history|settings|customer|approval|template|terminal|user|role|tag|loyalty)\./, (m) => (m === 'alert.' ? '⚠ ' : ''))
    .replace(/_/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase());

export const TAG_COLORS: Record<string, string> = {
  slate: 'bg-slate-400',
  pink: 'bg-pink-500',
  violet: 'bg-violet-500',
  sky: 'bg-sky-500',
  amber: 'bg-amber-500',
  emerald: 'bg-emerald-500',
  red: 'bg-red-500',
};
