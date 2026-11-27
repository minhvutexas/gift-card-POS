import { useEffect, useRef } from 'react';
import { Check, Delete } from 'lucide-react';
import { formatCents, keypadAppend } from '../lib/money';

/**
 * Big-button numeric keypad for amounts (cents shift in from the right,
 * like every card terminal). Physical keyboard digits/Backspace/Enter work
 * while the keypad region has focus.
 */
export function AmountKeypad({ value, onChange, onEnter, max, label = 'Amount', error, presets }: {
  value: number;
  onChange: (cents: number) => void;
  onEnter?: () => void;
  max?: number;
  label?: string;
  error?: string | null;
  presets?: number[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  const press = (k: string) => onChange(keypadAppend(value, k, max));

  useEffect(() => {
    ref.current?.focus();
  }, []);

  return (
    <div
      ref={ref}
      tabIndex={0}
      role="group"
      aria-label={`${label} keypad`}
      onKeyDown={(e) => {
        if (/^\d$/.test(e.key)) press(e.key);
        else if (e.key === 'Backspace') press('back');
        else if (e.key === 'Escape' && value) {
          e.stopPropagation();
          press('clear');
        } else if (e.key === 'Enter' && onEnter) onEnter();
        else return;
        e.preventDefault();
      }}
      className="rounded-xl outline-none focus-visible:ring-4 focus-visible:ring-brand-500/40"
    >
      <div className={`mb-3 rounded-xl px-4 py-3 text-right ${error ? 'bg-red-50 ring-2 ring-red-500 dark:bg-red-950' : 'bg-zinc-100 dark:bg-zinc-800'}`}>
        <div className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{label}</div>
        <output aria-live="polite" className="block font-mono text-5xl font-bold tabular-nums">
          {formatCents(value)}
        </output>
        {error && (
          <p role="alert" className="mt-1 text-base font-bold text-red-700 dark:text-red-300">
            {error}
          </p>
        )}
      </div>
      {presets && presets.length > 0 && (
        <div className="mb-3 grid grid-cols-4 gap-2">
          {presets.map((p) => (
            <button key={p} type="button" onClick={() => onChange(p)} className={`min-h-[52px] rounded-lg text-lg font-bold ring-1 ring-inset transition ${value === p ? 'bg-zinc-900 text-white ring-zinc-900 dark:bg-white dark:text-zinc-900 dark:ring-white' : 'bg-white ring-zinc-300 hover:bg-brand-50 dark:bg-zinc-800 dark:ring-zinc-600'}`}>
              {formatCents(p).replace('.00', '')}
            </button>
          ))}
        </div>
      )}
      <div className="grid grid-cols-3 gap-2">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9', '00', '0', 'back'].map((k) => (
          <button
            key={k}
            type="button"
            tabIndex={-1}
            onClick={() => press(k)}
            aria-label={k === 'back' ? 'Backspace' : k}
            className="flex min-h-[60px] items-center justify-center rounded-lg bg-white text-2xl font-semibold shadow-sm ring-1 ring-inset ring-zinc-200 active:scale-95 active:bg-zinc-100 dark:bg-zinc-800 dark:ring-zinc-700 dark:active:bg-zinc-700"
          >
            {k === 'back' ? <Delete className="h-7 w-7" /> : k}
          </button>
        ))}
      </div>
    </div>
  );
}

/** PIN entry pad (masked). */
export function PinPad({ value, onChange, onSubmit, length = 4, error, disabled }: { value: string; onChange: (v: string) => void; onSubmit: (v: string) => void; length?: number; error?: string | null; disabled?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const press = (k: string) => {
    if (disabled) return;
    if (k === 'back') return onChange(value.slice(0, -1));
    if (k === 'ok') return value.length >= 4 && onSubmit(value);
    if (value.length >= 8) return;
    // No auto-submit: PINs may be 4–8 digits; ✓ / Enter submits.
    onChange(value + k);
  };
  return (
    <div
      ref={ref}
      tabIndex={0}
      role="group"
      aria-label="PIN pad"
      onKeyDown={(e) => {
        if (/^\d$/.test(e.key)) press(e.key);
        else if (e.key === 'Backspace') press('back');
        else if (e.key === 'Enter') press('ok');
        else return;
        e.preventDefault();
      }}
      className="mx-auto w-full max-w-xs outline-none"
    >
      <div className="mb-4 flex justify-center gap-3" aria-live="polite" aria-label={`${value.length} digits entered`}>
        {Array.from({ length: Math.max(length, value.length) }, (_, i) => (
          <span key={i} className={`h-4 w-4 rounded-full ${i < value.length ? 'bg-zinc-900 dark:bg-white' : 'bg-zinc-300 dark:bg-zinc-700'} ${error ? 'animate-pulse bg-red-500' : ''}`} />
        ))}
      </div>
      {error && (
        <p role="alert" className="mb-3 text-center font-semibold text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      <div className="grid grid-cols-3 gap-3">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9', 'back', '0', 'ok'].map((k) => (
          <button
            key={k}
            type="button"
            tabIndex={-1}
            disabled={disabled}
            onClick={() => press(k)}
            aria-label={k === 'back' ? 'Backspace' : k === 'ok' ? 'Enter' : k}
            className={`flex aspect-square min-h-[64px] items-center justify-center rounded-full text-2xl font-semibold ring-1 ring-inset active:scale-95 ${
              k === 'ok' ? 'bg-zinc-900 text-white ring-zinc-900 dark:bg-white dark:text-zinc-900 dark:ring-white' : 'bg-white ring-zinc-200 dark:bg-zinc-800 dark:ring-zinc-700'
            }`}
          >
            {k === 'back' ? <Delete className="h-7 w-7" /> : k === 'ok' ? <Check className="h-7 w-7" /> : k}
          </button>
        ))}
      </div>
    </div>
  );
}
