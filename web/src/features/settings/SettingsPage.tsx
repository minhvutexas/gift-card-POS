import { NavLink, Navigate, useParams } from 'react-router-dom';
import { Building2, Database, FileUp, Info, MessageSquare, MonitorSmartphone, Printer, ReceiptText, Shield, Star } from 'lucide-react';
import { useSession } from '../../lib/session';
import { GeneralPanel, LoyaltyPanel, MessagingPanel, PrinterPanel, ReceiptPanel } from './panels';
import { SecurityPanel } from './SecurityPanel';
import { TerminalPanel } from './TerminalPanel';
import { ImportPanel } from './ImportPanel';
import { AboutPanel, DataPanel } from './DataPanel';

// Booking / Tips / Technicians are intentionally out of scope.
const TABS = [
  { key: 'general', label: 'General', icon: Building2, el: GeneralPanel },
  { key: 'receipt', label: 'Receipt', icon: ReceiptText, el: ReceiptPanel },
  { key: 'printer', label: 'Printer', icon: Printer, el: PrinterPanel },
  { key: 'messaging', label: 'Messaging', icon: MessageSquare, el: MessagingPanel },
  { key: 'terminal', label: 'Terminal', icon: MonitorSmartphone, el: TerminalPanel },
  { key: 'security', label: 'Security', icon: Shield, el: SecurityPanel },
  { key: 'import', label: 'Import', icon: FileUp, el: ImportPanel, perm: 'import.run' },
  { key: 'data', label: 'Data', icon: Database, el: DataPanel, perm: 'data.export' },
  { key: 'loyalty', label: 'Loyalty', icon: Star, el: LoyaltyPanel },
  { key: 'about', label: 'About', icon: Info, el: AboutPanel },
] as const;

export function SettingsPage() {
  const { tab } = useParams();
  const { can, me } = useSession();
  // Email/SMS settings only matter once the platform admin has turned messaging on.
  const tabs = TABS.filter((t) => (!('perm' in t) || can(t.perm)) && (t.key !== 'messaging' || !!me?.features?.messaging));
  const active = tabs.find((t) => t.key === tab);
  if (!active) return <Navigate to="/settings/general" replace />;
  const Panel = active.el;
  return (
    <div className="flex flex-col gap-4 md:flex-row">
      <nav aria-label="Settings sections" className="-mx-4 flex gap-1 overflow-x-auto px-4 md:mx-0 md:w-48 md:shrink-0 md:flex-col md:overflow-visible md:px-0">
        {tabs.map((t) => (
          <NavLink
            key={t.key}
            to={`/settings/${t.key}`}
            className={({ isActive }) =>
              `flex min-h-[48px] shrink-0 items-center gap-3 rounded-lg px-3 font-medium ${isActive ? 'bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-white' : 'text-zinc-600 hover:bg-zinc-50 hover:text-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800/60'}`
            }
          >
            <t.icon className="h-5 w-5" aria-hidden />
            {t.label}
          </NavLink>
        ))}
      </nav>
      <section className="min-w-0 flex-1 rounded-xl bg-white p-5 shadow-sm ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800" aria-labelledby="settings-h">
        <h1 id="settings-h" className="mb-4 text-2xl font-bold">
          {active.label}
        </h1>
        <Panel />
      </section>
    </div>
  );
}
