import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Database, Download, HardDriveDownload } from 'lucide-react';
import { api, download } from '../../lib/api';
import { useSession } from '../../lib/session';
import { useToast } from '../../lib/toast';
import { Button, fmtDateTime, SkeletonRows } from '../../components/ui';

const TABLES = ['gift_cards', 'gift_card_transactions', 'customers', 'audit_log', 'message_log', 'import_jobs'];
const bytes = (n: number) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.ceil(n / 1e3)} KB`);

export function DataPanel() {
  const { can } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const backups = useQuery({ queryKey: ['backups'], queryFn: () => api<{ data: any[] }>('/data/backups'), enabled: can('data.backup') });
  return (
    <div className="space-y-8">
      <section>
        <h2 className="mb-2 text-lg font-bold">Export</h2>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => download('/data/export.json', 'export.json')}>
            <Download className="h-4 w-4" /> Full export (JSON)
          </Button>
          {TABLES.map((t) => (
            <Button key={t} variant="secondary" size="sm" onClick={() => download(`/data/export/${t}.csv`, `${t}.csv`)}>
              {t}.csv
            </Button>
          ))}
        </div>
        <p className="mt-2 text-sm text-slate-500">Exports never include PIN/password hashes or terminal keys. Every export is logged.</p>
      </section>

      {can('data.backup') && (
        <section>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-lg font-bold">Backups</h2>
            <Button
              size="sm"
              onClick={async () => {
                const b = await api<{ filename: string }>('/data/backups', { body: {} });
                qc.invalidateQueries({ queryKey: ['backups'] });
                toast.push({ kind: 'success', title: 'Backup created', message: b.filename });
              }}
            >
              <HardDriveDownload className="h-4 w-4" /> Back up now
            </Button>
          </div>
          {!backups.data ? (
            <SkeletonRows rows={2} />
          ) : backups.data.data.length === 0 ? (
            <p className="text-slate-500">No backups yet.</p>
          ) : (
            <ul className="divide-y divide-slate-100 rounded-xl ring-1 ring-slate-200 dark:divide-slate-800 dark:ring-slate-700">
              {backups.data.data.map((b) => (
                <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                  <span>
                    <strong>{fmtDateTime(b.created_at)}</strong> · {bytes(b.size_bytes)} · {b.created_by ?? 'system'}
                    <span className="block font-mono text-xs text-slate-500">sha256 {b.sha256.slice(0, 16)}…</span>
                  </span>
                  <Button size="sm" variant="secondary" onClick={() => download(`/data/backups/${b.id}/download`, b.filename)}>
                    Download
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">
            <strong>Restore:</strong> for safety, restores run on the server into a fresh database:
            <code className="mt-1 block">npm run db:restore -- backups/&lt;file&gt;.json &lt;sha256&gt;</code>
            See README › “Restore a backup”. Backups contain PIN hashes — store them encrypted.
          </div>
        </section>
      )}

      <section>
        <h2 className="mb-1 text-lg font-bold">Privacy (GDPR)</h2>
        <p className="text-sm text-slate-600 dark:text-slate-300">To erase a holder’s personal data, open Customers → choose the person → “GDPR erase”. Balances and the money ledger are retained as required for accounting.</p>
      </section>
    </div>
  );
}

export function AboutPanel() {
  const q = useQuery({ queryKey: ['about'], queryFn: () => api<any>('/about') });
  if (!q.data) return <SkeletonRows rows={4} />;
  const a = q.data;
  const rows: [string, string][] = [
    ['Version', `${a.app} ${a.version}`],
    ['License', a.license],
    ['Environment', `${a.env} · Node ${a.node}`],
    ['Database', a.postgres.split(',')[0]],
    ['Database size', bytes(a.db_bytes)],
    ['Ledger size', bytes(a.ledger_bytes)],
    ['Audit log size', bytes(a.audit_bytes)],
    ['Cards', `${a.cards} (${a.archived_cards} archived)`],
    ['Transactions', String(a.transactions)],
    ['Audit events', String(a.audit_events)],
    ['Customers', String(a.customers)],
  ];
  return (
    <dl className="grid max-w-2xl grid-cols-[auto_1fr] gap-x-6 gap-y-2">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="flex items-center gap-2 text-slate-500">
            {k === 'Database' && <Database className="h-4 w-4" />}
            {k}
          </dt>
          <dd className="font-medium">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
