import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { CheckCircle2, AlertTriangle, Info, XCircle, X } from 'lucide-react';

type Kind = 'success' | 'error' | 'info' | 'warning';
interface Toast {
  id: number;
  kind: Kind;
  title: string;
  message?: string;
  action?: { label: string; onClick: () => void | Promise<void> };
  duration: number;
}

const Ctx = createContext<{ push: (t: Omit<Toast, 'id' | 'duration'> & { duration?: number }) => number; dismiss: (id: number) => void } | null>(null);

const ICON = { success: CheckCircle2, error: XCircle, info: Info, warning: AlertTriangle };
const STYLE: Record<Kind, string> = {
  success: 'border-emerald-500/40 bg-white dark:bg-slate-900',
  error: 'border-red-500/50 bg-red-50 dark:bg-red-950',
  info: 'border-sky-500/40 bg-white dark:bg-slate-900',
  warning: 'border-amber-500/50 bg-amber-50 dark:bg-amber-950',
};
const ICON_COLOR: Record<Kind, string> = { success: 'text-emerald-600', error: 'text-red-600', info: 'text-sky-600', warning: 'text-amber-600' };

function ToastItem({ t, onClose }: { t: Toast; onClose: () => void }) {
  const [left, setLeft] = useState(t.duration);
  const paused = useRef(false);
  useEffect(() => {
    const iv = setInterval(() => {
      if (!paused.current) setLeft((l) => l - 100);
    }, 100);
    return () => clearInterval(iv);
  }, []);
  useEffect(() => {
    if (left <= 0) onClose();
  }, [left, onClose]);
  const Icon = ICON[t.kind];
  return (
    <div
      role={t.kind === 'error' ? 'alert' : 'status'}
      onMouseEnter={() => (paused.current = true)}
      onMouseLeave={() => (paused.current = false)}
      className={`pointer-events-auto relative w-full max-w-sm overflow-hidden rounded-xl border-2 p-4 shadow-lg animate-pop ${STYLE[t.kind]}`}
    >
      <div className="flex gap-3">
        <Icon className={`mt-0.5 h-6 w-6 shrink-0 ${ICON_COLOR[t.kind]}`} aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="font-semibold">{t.title}</p>
          {t.message && <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-300">{t.message}</p>}
          {t.action && (
            <button
              className="mt-2 min-h-[44px] rounded-lg bg-slate-900 px-4 font-semibold text-white hover:bg-slate-700 dark:bg-white dark:text-slate-900"
              onClick={async () => {
                onClose();
                await t.action!.onClick();
              }}
            >
              {t.action.label} {t.duration >= 5000 && <span className="font-normal opacity-70">({Math.ceil(left / 1000)}s)</span>}
            </button>
          )}
        </div>
        <button onClick={onClose} className="-m-2 h-11 w-11 shrink-0 rounded-lg p-2 text-slate-500 hover:bg-black/5" aria-label="Dismiss notification">
          <X className="mx-auto h-5 w-5" />
        </button>
      </div>
      <div className="absolute bottom-0 left-0 h-1 bg-current opacity-20" style={{ width: `${(left / t.duration) * 100}%` }} aria-hidden />
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const dismiss = useCallback((id: number) => setToasts((ts) => ts.filter((t) => t.id !== id)), []);
  const push = useCallback((t: Omit<Toast, 'id' | 'duration'> & { duration?: number }) => {
    const id = ++seq.current;
    setToasts((ts) => [...ts.slice(-4), { duration: t.kind === 'error' ? 8000 : 4000, ...t, id }]);
    return id;
  }, []);
  return (
    <Ctx.Provider value={{ push, dismiss }}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-0 z-[100] flex flex-col items-center gap-2 p-4 sm:items-end">
        {toasts.map((t) => (
          <ToastItem key={t.id} t={t} onClose={() => dismiss(t.id)} />
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useToast outside ToastProvider');
  return c;
}
