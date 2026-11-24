import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Bell, CreditCard, History, LayoutDashboard, LogOut, Lock, Moon, Plus, Settings, Sun, Users, ExternalLink, WifiOff } from 'lucide-react';
import { api } from '../lib/api';
import { useClock, useLiveEvents } from '../lib/live';
import { formatCents } from '../lib/money';
import { dismissFailed, flushQueue, useOfflineQueue, useOnline } from '../lib/offline';
import { useSession } from '../lib/session';
import { actionLabel } from '../lib/status';
import { useToast } from '../lib/toast';
import type { CardList } from '../lib/types';
import { useCardActions } from '../features/cards/CardActions';
import { AnimatedMoney, Button } from './ui';

const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, perm: 'dashboard.read', end: true },
  { to: '/cards', label: 'Cards', icon: CreditCard, perm: 'cards.read' },
  { to: '/history', label: 'History', icon: History, perm: 'history.read' },
  { to: '/customers', label: 'Customers', icon: Users, perm: 'customers.read' },
  { to: '/settings', label: 'Settings', icon: Settings, perm: 'settings.read' },
];

export function toggleTheme() {
  const dark = document.documentElement.classList.toggle('dark');
  try {
    localStorage.setItem('gc.theme', dark ? 'dark' : 'light');
  } catch {
    /* ignore */
  }
}

export function Layout() {
  const { me, can, logout, lock } = useSession();
  const { open } = useCardActions();
  const live = useLiveEvents(!!me);
  const online = useOnline();
  const now = useClock();
  const tz = me?.settings.general.timezone;
  const toast = useToast();
  const queue = useOfflineQueue();

  // Liability is shared by header + Cards page (both write ['outstanding']).
  const outstanding = useQuery({
    queryKey: ['outstanding'],
    queryFn: async () => (await api<CardList>('/cards?per_page=1')).meta.outstanding_total_cents,
    refetchInterval: 60_000,
  });

  // Replay offline redemptions on reconnect.
  useEffect(() => {
    const go = async () => {
      if (!queue.pending.length) return;
      const r = await flushQueue();
      if (r.sent) toast.push({ kind: 'success', title: `Synced ${r.sent} offline redemption${r.sent === 1 ? '' : 's'}` });
      r.failed.forEach((f) => toast.push({ kind: 'error', title: `Offline redemption failed — card ${f.card_number}`, message: `${formatCents(f.amount_cents + f.tip_cents)}: ${f.error}. Collect another payment.`, duration: 30000 }));
    };
    if (online) go();
    const iv = setInterval(() => online && go(), 30_000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online, queue.pending.length]);

  return (
    <div className="flex min-h-screen">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-[200] focus:rounded-lg focus:bg-white focus:p-3 focus:shadow">
        Skip to content
      </a>
      {/* Icon sidebar */}
      <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-30 flex justify-around border-t border-slate-200 bg-white/95 backdrop-blur dark:border-slate-800 dark:bg-slate-900/95 md:sticky md:top-0 md:h-screen md:w-24 md:flex-col md:justify-start md:gap-1 md:border-r md:border-t-0 md:py-4">
        <div className="mb-4 hidden text-center text-3xl md:block" aria-hidden>
          🎁
        </div>
        {NAV.filter((n) => can(n.perm)).map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.end}
            className={({ isActive }) =>
              `flex min-h-[56px] min-w-[56px] flex-col items-center justify-center gap-0.5 rounded-xl px-2 text-[11px] font-semibold md:mx-2 ${isActive ? 'bg-brand-50 text-brand-700 dark:bg-brand-900/30 dark:text-brand-300' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'}`
            }
          >
            <n.icon className="h-6 w-6" aria-hidden />
            {n.label}
          </NavLink>
        ))}
        <a href={me?.business ? `/k/${me.business.slug}` : '/kiosk'} target="_blank" rel="noopener" className="flex min-h-[56px] min-w-[56px] flex-col items-center justify-center gap-0.5 rounded-xl px-2 text-[11px] font-semibold text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800 md:mx-2">
          <ExternalLink className="h-6 w-6" aria-hidden />
          Kiosk ↗
        </a>
      </nav>

      <div className="flex min-w-0 flex-1 flex-col pb-20 md:pb-0">
        {/* Top bar */}
        <header className="sticky top-0 z-20 flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-slate-200 bg-white/90 px-4 py-2 backdrop-blur dark:border-slate-800 dark:bg-slate-900/90">
          <div className="flex items-center gap-3">
            <div>
              <p className="text-sm font-semibold leading-tight">{me?.settings.general.business_name}</p>
              <p className="text-xs leading-tight text-slate-500">
                {now.toLocaleDateString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' })} ·{' '}
                <time className="tabular-nums" dateTime={now.toISOString()}>
                  {now.toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', second: '2-digit' })}
                </time>
              </p>
            </div>
            <span className="inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-xs font-semibold" title={live === 'live' ? 'Real-time updates on' : 'Reconnecting…'}>
              {online ? (
                <>
                  <span className={`h-2.5 w-2.5 rounded-full ${live === 'live' ? 'bg-emerald-500 animate-pulseRing' : 'bg-amber-500'}`} aria-hidden />
                  <span className={live === 'live' ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700'}>{live === 'live' ? 'Live' : 'Connecting'}</span>
                </>
              ) : (
                <span className="flex items-center gap-1 text-red-700 dark:text-red-400">
                  <WifiOff className="h-4 w-4" /> Offline{queue.pending.length ? ` · ${queue.pending.length} queued` : ''}
                </span>
              )}
            </span>
          </div>

          <div className="ml-auto flex items-center gap-2">
            <div className="hidden text-right sm:block" aria-live="polite">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Outstanding liability</p>
              <p className="text-lg font-bold leading-tight">{outstanding.data !== undefined ? <AnimatedMoney cents={outstanding.data} /> : '—'}</p>
            </div>
            <Bell2 />
            <button onClick={toggleTheme} className="h-11 w-11 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="Toggle dark mode">
              <Sun className="mx-auto hidden h-5 w-5 dark:block" />
              <Moon className="mx-auto h-5 w-5 dark:hidden" />
            </button>
            <UserMenu name={me?.user.name ?? ''} role={me?.user.role ?? ''} onLock={lock} onLogout={logout} />
            {can('cards.issue') && (
              <Button onClick={() => open('issue')} className="shadow-md" aria-keyshortcuts="Alt+N">
                <Plus className="h-5 w-5" /> New Card
              </Button>
            )}
          </div>
        </header>

        {queue.failed.length > 0 && (
          <div role="alert" className="border-b-2 border-red-500 bg-red-50 px-4 py-2 text-red-900 dark:bg-red-950 dark:text-red-100">
            {queue.failed.map((f) => (
              <div key={f.key} className="flex flex-wrap items-center gap-2">
                <strong>Offline redemption rejected:</strong> card {f.card_number}, {formatCents(f.amount_cents + f.tip_cents)} — {f.error}
                <Button size="sm" variant="secondary" onClick={() => dismissFailed(f.key)}>
                  Resolved
                </Button>
              </div>
            ))}
          </div>
        )}

        <main id="main" className="mx-auto w-full max-w-7xl flex-1 p-4 md:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function UserMenu({ name, role, onLock, onLogout }: { name: string; role: string; onLock: () => void; onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const c = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', c);
    return () => document.removeEventListener('mousedown', c);
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} className="flex h-11 items-center gap-2 rounded-lg px-2 hover:bg-slate-100 dark:hover:bg-slate-800">
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-600 text-sm font-bold text-white" aria-hidden>
          {name.slice(0, 1)}
        </span>
        <span className="hidden text-left text-sm leading-tight lg:block">
          {name}
          <br />
          <span className="text-xs text-slate-500">{role}</span>
        </span>
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-30 mt-1 w-48 rounded-xl bg-white py-1 shadow-xl ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-700">
          <button role="menuitem" onClick={() => (setOpen(false), onLock())} className="flex min-h-[44px] w-full items-center gap-2 px-4 text-sm hover:bg-slate-100 dark:hover:bg-slate-800">
            <Lock className="h-4 w-4" /> Lock / switch user
          </button>
          <button role="menuitem" onClick={() => (setOpen(false), onLogout())} className="flex min-h-[44px] w-full items-center gap-2 px-4 text-sm text-red-700 hover:bg-slate-100 dark:hover:bg-slate-800">
            <LogOut className="h-4 w-4" /> Log out
          </button>
        </div>
      )}
    </div>
  );
}

/** 🔔 Alerts: low balance / expiring / blocked attempts / failed prints. */
function Bell2() {
  const { can } = useSession();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { open: openCard } = useCardActions();
  const d = useQuery({
    queryKey: ['dashboard', 'summary'],
    queryFn: () => api<any>('/dashboard/summary'),
    enabled: can('dashboard.read'),
    refetchInterval: 60_000,
  });
  const [seen, setSeen] = useState<number>(() => Number(localStorage.getItem('gc.alerts.seen') ?? 0));
  useEffect(() => {
    if (!open) return;
    const c = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', c);
    return () => document.removeEventListener('mousedown', c);
  }, [open]);
  const alerts: any[] = d.data?.alerts ?? [];
  const expiring: any[] = d.data?.expiring_soon ?? [];
  const unseen = alerts.filter((a) => a.id > seen).length + expiring.filter((e) => e.days_left <= 7).length;
  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => {
          setOpen((o) => !o);
          const max = Math.max(0, ...alerts.map((a) => a.id));
          setSeen(max);
          try {
            localStorage.setItem('gc.alerts.seen', String(max));
          } catch {
            /* ignore */
          }
        }}
        className="relative h-11 w-11 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800"
        aria-label={`Notifications${unseen ? `, ${unseen} new` : ''}`}
        aria-expanded={open}
      >
        <Bell className="mx-auto h-5 w-5" />
        {unseen > 0 && <span className="absolute right-1 top-1 flex h-5 min-w-[20px] items-center justify-center rounded-full bg-red-600 px-1 text-xs font-bold text-white">{unseen}</span>}
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-1 w-80 max-w-[90vw] rounded-xl bg-white p-2 shadow-xl ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-700">
          <p className="px-2 py-1 text-xs font-bold uppercase text-slate-500">Alerts (24h)</p>
          {alerts.length === 0 && <p className="px-2 py-2 text-sm text-slate-500">All clear ✓</p>}
          {alerts.slice(0, 8).map((a) => (
            <button key={a.id} onClick={() => a.card_id && openCard('details', { id: a.card_id } as any)} className="block min-h-[44px] w-full rounded-lg px-2 py-1 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800">
              <span className="font-semibold">{actionLabel(a.action)}</span> {a.card_number && <span className="font-mono">#{a.card_number}</span>}
              <br />
              <span className="text-xs text-slate-500">{a.message}</span>
            </button>
          ))}
          <p className="mt-2 px-2 py-1 text-xs font-bold uppercase text-slate-500">Expiring soon</p>
          {expiring.length === 0 && <p className="px-2 py-2 text-sm text-slate-500">None in the next 30 days</p>}
          {expiring.slice(0, 5).map((e) => (
            <button key={e.id} onClick={() => openCard('details', { id: e.id } as any)} className="flex min-h-[44px] w-full items-center justify-between rounded-lg px-2 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800">
              <span className="font-mono">{e.card_number}</span>
              <span>{formatCents(e.balance_cents)}</span>
              <span className={e.days_left <= 7 ? 'font-bold text-red-600' : 'text-slate-500'}>{e.days_left}d</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
