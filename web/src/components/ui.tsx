import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { STATUS, TAG_COLORS } from '../lib/status';
import { formatCents } from '../lib/money';
import type { CardStatus, Tag } from '../lib/types';

// ------------------------------------------------------------------ buttons
type Variant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'success';
const VARIANT: Record<Variant, string> = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700 focus-visible:ring-brand-500 disabled:bg-brand-600/50',
  secondary: 'bg-white text-slate-900 ring-1 ring-inset ring-slate-300 hover:bg-slate-50 dark:bg-slate-800 dark:text-slate-100 dark:ring-slate-600 dark:hover:bg-slate-700',
  danger: 'bg-red-600 text-white hover:bg-red-700 focus-visible:ring-red-500 disabled:bg-red-600/50',
  success: 'bg-emerald-600 text-white hover:bg-emerald-700 focus-visible:ring-emerald-500 disabled:bg-emerald-600/50',
  ghost: 'text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800',
};

export function Button({ variant = 'primary', size = 'md', className = '', loading, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg' | 'xl'; loading?: boolean }) {
  const sz = { sm: 'min-h-[44px] px-3 text-sm', md: 'min-h-[48px] px-4 text-base', lg: 'min-h-[56px] px-6 text-lg', xl: 'min-h-[72px] px-8 text-xl' }[size];
  return (
    <button
      {...rest}
      disabled={rest.disabled || loading}
      aria-busy={loading || undefined}
      className={`inline-flex items-center justify-center gap-2 rounded-xl font-semibold transition focus:outline-none focus-visible:ring-4 disabled:cursor-not-allowed disabled:opacity-60 ${sz} ${VARIANT[variant]} ${className}`}
    >
      {loading && <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-r-transparent" aria-hidden />}
      {children}
    </button>
  );
}

// ------------------------------------------------------------------ status pill (colour + glyph + text)
export function StatusPill({ status, size = 'md' }: { status: CardStatus; size?: 'sm' | 'md' }) {
  const s = STATUS[status] ?? STATUS.CLOSED;
  return (
    <span title={s.hint} className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full font-semibold ring-1 ring-inset ${s.pill} ${size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-2.5 py-1 text-sm'}`}>
      <span aria-hidden>{s.glyph}</span>
      {s.label}
    </span>
  );
}

export function TagChip({ tag }: { tag: Pick<Tag, 'name' | 'color'> }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-200">
      <span className={`h-2 w-2 rounded-full ${TAG_COLORS[tag.color] ?? 'bg-slate-400'}`} aria-hidden />
      {tag.name}
    </span>
  );
}

// ------------------------------------------------------------------ animated money (liability header etc.)
export function AnimatedMoney({ cents, className = '', currency = 'USD' }: { cents: number; className?: string; currency?: string }) {
  const [shown, setShown] = useState(cents);
  const [flash, setFlash] = useState(0);
  const from = useRef(cents);
  useEffect(() => {
    if (cents === shown) return;
    from.current = shown;
    setFlash((f) => f + 1);
    const start = performance.now();
    const dur = 600;
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / dur);
      const eased = 1 - (1 - p) ** 3;
      setShown(Math.round(from.current + (cents - from.current) * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) setShown(cents);
    else raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cents]);
  return (
    <span key={flash} className={`tabular-nums rounded px-1 ${flash ? 'animate-flash' : ''} ${className}`}>
      {formatCents(shown, currency)}
    </span>
  );
}

// ------------------------------------------------------------------ modal (focus trap, Esc, aria)
export function Modal({ open, onClose, title, children, footer, size = 'md', dismissable = true, initialFocus }: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  dismissable?: boolean;
  initialFocus?: string; // CSS selector inside the modal
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current!;
    const focusables = () => [...el.querySelectorAll<HTMLElement>('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')].filter((x) => !x.hasAttribute('disabled'));
    (initialFocus ? el.querySelector<HTMLElement>(initialFocus) : null)?.focus() ?? focusables()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dismissable) {
        e.stopPropagation();
        onClose();
      }
      if (e.key === 'Tab') {
        const f = focusables();
        if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) {
          e.preventDefault();
          f[f.length - 1].focus();
        } else if (!e.shiftKey && document.activeElement === f[f.length - 1]) {
          e.preventDefault();
          f[0].focus();
        }
      }
    };
    el.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      el.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      prev?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  if (!open) return null;
  const w = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' }[size];
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/60 p-0 backdrop-blur-sm sm:items-center sm:p-4" onMouseDown={(e) => dismissable && e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} className={`flex max-h-[95vh] w-full ${w} flex-col overflow-hidden rounded-t-2xl bg-white shadow-2xl animate-pop dark:bg-slate-900 sm:rounded-2xl`}>
        <div className="flex items-center justify-between gap-4 border-b border-slate-200 px-5 py-3 dark:border-slate-800">
          <h2 id={titleId} className="text-xl font-bold">
            {title}
          </h2>
          {dismissable && (
            <button onClick={onClose} className="h-11 w-11 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="Close">
              <X className="mx-auto h-6 w-6" />
            </button>
          )}
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-slate-200 px-5 py-3 dark:border-slate-800">{footer}</div>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ form bits
export function Field({ label, error, hint, children, htmlFor }: { label: ReactNode; error?: string | null; hint?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="space-y-1">
      <label htmlFor={htmlFor} className="block text-sm font-semibold text-slate-700 dark:text-slate-200">
        {label}
      </label>
      {children}
      {error ? (
        <p role="alert" className="text-sm font-medium text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : hint ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">{hint}</p>
      ) : null}
    </div>
  );
}

export const inputCls =
  'block w-full min-h-[48px] rounded-xl border-0 bg-white px-3 text-base text-slate-900 ring-1 ring-inset ring-slate-300 placeholder:text-slate-400 focus:ring-2 focus:ring-brand-500 dark:bg-slate-800 dark:text-white dark:ring-slate-600 aria-[invalid=true]:ring-red-500';

// ------------------------------------------------------------------ empty / skeleton
export function EmptyState({ icon, title, children, action }: { icon: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-slate-300 px-6 py-14 text-center dark:border-slate-700">
      <div className="mb-3 text-slate-400" aria-hidden>
        {icon}
      </div>
      <h3 className="text-lg font-bold">{title}</h3>
      {children && <div className="mt-1 max-w-md text-slate-600 dark:text-slate-400">{children}</div>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-lg bg-slate-200 dark:bg-slate-800 ${className}`} aria-hidden />;
}

export function SkeletonRows({ rows = 6 }: { rows?: number }) {
  return (
    <div className="space-y-2" role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-16 w-full" />
      ))}
    </div>
  );
}

export const fmtDateTime = (iso: string | null | undefined, tz?: string) =>
  iso ? new Date(iso).toLocaleString('en-US', { timeZone: tz, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';
export const fmtDate = (iso: string | null | undefined, tz?: string) => (iso ? new Date(iso).toLocaleDateString('en-US', { timeZone: tz, month: 'short', day: 'numeric', year: 'numeric' }) : '—');
export const holderName = (c: { first_name: string | null; last_name: string | null } | null | undefined) => (c ? [c.first_name, c.last_name].filter(Boolean).join(' ') : '');
