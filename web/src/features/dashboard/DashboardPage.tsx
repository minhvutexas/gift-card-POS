import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CalendarClock, CheckCircle2, CreditCard, RefreshCcw, TrendingUp, Wallet } from 'lucide-react';
import { api } from '../../lib/api';
import { useClock } from '../../lib/live';
import { formatCents } from '../../lib/money';
import { useSession } from '../../lib/session';
import { actionLabel } from '../../lib/status';
import type { Card } from '../../lib/types';
import { AnimatedMoney, Button, fmtDate, fmtDateTime, Skeleton, StatusPill } from '../../components/ui';
import { useCardActions } from '../cards/CardActions';

interface Summary {
  outstanding_total_cents: number;
  outstanding_card_count: number;
  today: { cards_sold: number; sold_cents: number; redemptions: number; redeemed_cents: number; reload_count: number; reload_cents: number; breakage_cents: number; revenue_recognized_cents: number };
  breakage_30d_cents: number;
  expiring_soon: { id: number; card_number: string; status: any; balance_cents: number; expires_at: string; days_left: number }[];
  alerts: { id: number; action: string; card_id: number | null; card_number: string | null; message: string | null; created_at: string; actor_name: string | null }[];
  series: { day: string; sold_cents: number; redeemed_cents: number }[];
  status_counts: Record<string, number>;
}

function Tile({ label, value, sub, icon: Icon }: { label: string; value: React.ReactNode; sub?: React.ReactNode; icon: typeof Wallet }) {
  return (
    <div className="rounded-xl bg-white p-4 shadow-sm ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800">
      <div className="flex items-center justify-between text-sm font-semibold text-zinc-500">
        {label}
        <Icon className="h-5 w-5" aria-hidden />
      </div>
      <div className="mt-1 text-3xl font-bold tabular-nums">{value}</div>
      {sub && <div className="mt-0.5 text-sm text-zinc-500">{sub}</div>}
    </div>
  );
}

export function DashboardPage() {
  const { me, can } = useSession();
  const { open } = useCardActions();
  const tz = me?.settings.general.timezone;
  const now = useClock();
  const q = useQuery({ queryKey: ['dashboard', 'summary'], queryFn: () => api<Summary>('/dashboard/summary'), refetchInterval: 60_000 });
  const d = q.data;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Good {now.getHours() < 12 ? 'morning' : now.getHours() < 17 ? 'afternoon' : 'evening'}, {me?.user.name}</h1>
          <p className="text-zinc-500">
            <time className="text-3xl font-semibold tabular-nums text-zinc-900 dark:text-white">{now.toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' })}</time>{' '}
            {now.toLocaleDateString('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric' })}
          </p>
        </div>
        <div className="flex gap-2">
          {can('cards.redeem') && (
            <Button size="lg" variant="success" onClick={() => open('redeem')}>
              <Wallet className="h-5 w-5" /> Redeem
            </Button>
          )}
          {can('cards.issue') && (
            <Button size="lg" onClick={() => open('issue')}>
              <CreditCard className="h-5 w-5" /> Sell card
            </Button>
          )}
        </div>
      </div>

      {!d ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Tile label="Outstanding liability" icon={Wallet} value={<AnimatedMoney cents={d.outstanding_total_cents} />} sub={`${d.outstanding_card_count} live cards`} />
            <Tile label="Cards sold today" icon={CreditCard} value={d.today.cards_sold} sub={formatCents(d.today.sold_cents)} />
            <Tile label="Revenue recognized today" icon={TrendingUp} value={formatCents(d.today.revenue_recognized_cents)} sub={`${d.today.redemptions} redemptions · breakage ${formatCents(d.today.breakage_cents)}`} />
            <Tile label="Top-ups today" icon={RefreshCcw} value={formatCents(d.today.reload_cents)} sub={`${d.today.reload_count} reloads`} />
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <section className="rounded-xl bg-white p-4 shadow-sm ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800 lg:col-span-2">
              <SalesChart series={d.series} />
            </section>

            <section className="rounded-xl bg-white p-4 shadow-sm ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800" aria-labelledby="alerts-h">
              <h2 id="alerts-h" className="mb-2 flex items-center gap-2 font-bold">
                <AlertTriangle className="h-5 w-5 text-amber-600" aria-hidden /> Alerts (24h)
              </h2>
              {d.alerts.length === 0 ? (
                <p className="flex items-center gap-2 py-6 text-zinc-500">
                  <CheckCircle2 className="h-5 w-5 text-emerald-600" /> No problems in the last 24 hours.
                </p>
              ) : (
                <ul className="max-h-72 space-y-1 overflow-auto">
                  {d.alerts.map((a) => (
                    <li key={a.id}>
                      <button onClick={() => a.card_id && open('details', { id: a.card_id } as Card)} className="w-full rounded-lg px-2 py-2 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800">
                        <span className="font-semibold">{actionLabel(a.action)}</span> {a.card_number && <span className="font-mono">#{a.card_number}</span>}
                        <span className="block text-xs text-zinc-500">
                          {fmtDateTime(a.created_at, tz)} · {a.actor_name ?? 'system'} · {a.message}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <section className="rounded-xl bg-white p-4 shadow-sm ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800" aria-labelledby="exp-h">
              <h2 id="exp-h" className="mb-2 flex items-center gap-2 font-bold">
                <CalendarClock className="h-5 w-5" aria-hidden /> Expiring in the next 30 days
              </h2>
              {d.expiring_soon.length === 0 ? (
                <p className="py-6 text-zinc-500">Nothing expiring soon.</p>
              ) : (
                <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {d.expiring_soon.map((e) => (
                    <li key={e.id}>
                      <button onClick={() => open('details', { id: e.id } as Card)} className="flex min-h-[48px] w-full items-center justify-between gap-2 px-1 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800">
                        <span className="font-mono font-semibold">{e.card_number}</span>
                        <StatusPill status={e.status} size="sm" />
                        <span className="tabular-nums">{formatCents(e.balance_cents)}</span>
                        <span className={`text-sm ${e.days_left <= 7 ? 'font-bold text-red-700 dark:text-red-400' : 'text-zinc-500'}`}>
                          {fmtDate(e.expires_at, tz)} ({e.days_left}d)
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className="rounded-xl bg-white p-4 shadow-sm ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800" aria-labelledby="mix-h">
              <h2 id="mix-h" className="mb-3 font-bold">Card status mix</h2>
              <ul className="flex flex-wrap gap-2">
                {Object.entries(d.status_counts).map(([s, n]) => (
                  <li key={s} className="flex items-center gap-2 rounded-lg bg-zinc-50 px-3 py-2 dark:bg-zinc-800">
                    <StatusPill status={s as any} size="sm" /> <span className="font-bold tabular-nums">{n}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-4 text-sm text-zinc-500">Breakage recognized (expired balances), last 30 days: <strong>{formatCents(d.breakage_30d_cents)}</strong></p>
            </section>
          </div>
        </>
      )}
    </div>
  );
}

/** 14-day grouped bars: value loaded vs value redeemed. Legend + hover tooltip + table view. */
function SalesChart({ series }: { series: Summary['series'] }) {
  const [hover, setHover] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const max = Math.max(1, ...series.flatMap((s) => [s.sold_cents, s.redeemed_cents]));
  const W = 560;
  const H = 180;
  const slot = W / series.length;
  const bw = Math.max(4, (slot - 10) / 2);
  const y = (c: number) => H - (c / max) * (H - 8);
  const label = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-bold">Last 14 days — loaded vs redeemed</h2>
        <div className="flex items-center gap-4 text-sm text-zinc-600 dark:text-zinc-300">
          <span className="flex items-center gap-1.5">
            <span className="h-3 w-3 rounded-sm bg-[#2a78d6] dark:bg-[#3987e5]" aria-hidden /> Loaded (sales + reloads)
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-3 w-3 rounded-sm bg-[#eb6834] dark:bg-[#d95926]" aria-hidden /> Redeemed
          </span>
          <button className="min-h-[44px] rounded-lg px-2 font-semibold underline" onClick={() => setAsTable((t) => !t)}>
            {asTable ? 'Chart' : 'Table'}
          </button>
        </div>
      </div>
      {asTable ? (
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase text-zinc-500">
            <tr>
              <th>Day</th>
              <th className="text-right">Loaded</th>
              <th className="text-right">Redeemed</th>
            </tr>
          </thead>
          <tbody>
            {series.map((s) => (
              <tr key={s.day} className="border-t border-zinc-100 dark:border-zinc-800">
                <td className="py-1">{label(s.day)}</td>
                <td className="text-right tabular-nums">{formatCents(s.sold_cents)}</td>
                <td className="text-right tabular-nums">{formatCents(s.redeemed_cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="relative">
          <svg viewBox={`0 0 ${W} ${H + 20}`} className="w-full" role="img" aria-label="Bar chart of value loaded and redeemed per day for the last 14 days. Use the Table button for exact values.">
            <line x1="0" x2={W} y1={H} y2={H} className="stroke-zinc-300 dark:stroke-zinc-700" strokeWidth="1" />
            {series.map((s, i) => {
              const x = i * slot + (slot - (bw * 2 + 2)) / 2;
              return (
                <g key={s.day} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                  <rect x={i * slot} y={0} width={slot} height={H + 20} fill="transparent" />
                  {hover === i && <rect x={i * slot} y={0} width={slot} height={H} className="fill-zinc-100 dark:fill-zinc-800" />}
                  <path d={bar(x, y(s.sold_cents), bw, H)} className="fill-[#2a78d6] dark:fill-[#3987e5]" />
                  <path d={bar(x + bw + 2, y(s.redeemed_cents), bw, H)} className="fill-[#eb6834] dark:fill-[#d95926]" />
                  {(i % 2 === 0 || i === series.length - 1) && (
                    <text x={i * slot + slot / 2} y={H + 14} textAnchor="middle" className="fill-zinc-500 text-[10px]">
                      {label(s.day)}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
          {hover !== null && (
            <div className="pointer-events-none absolute top-0 rounded-lg bg-zinc-900 px-3 py-2 text-sm text-white shadow-sm dark:bg-white dark:text-zinc-900" style={{ left: `${Math.min(75, (hover / series.length) * 100)}%` }}>
              <p className="font-semibold">{label(series[hover].day)}</p>
              <p>Loaded {formatCents(series[hover].sold_cents)}</p>
              <p>Redeemed {formatCents(series[hover].redeemed_cents)}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Bar with 4px rounded top, square at the baseline. Zero-height bars draw nothing. */
function bar(x: number, top: number, w: number, base: number) {
  const h = base - top;
  if (h <= 0.5) return '';
  const r = Math.min(4, h, w / 2);
  return `M${x},${base}V${top + r}Q${x},${top} ${x + r},${top}H${x + w - r}Q${x + w},${top} ${x + w},${top + r}V${base}Z`;
}
