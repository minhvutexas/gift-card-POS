import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, KeyRound, Plug } from 'lucide-react';
import { api, ApiError, store } from '../../lib/api';
import { useSession } from '../../lib/session';
import { useToast } from '../../lib/toast';
import { Button, Field, fmtDateTime, inputCls, Modal, SkeletonRows } from '../../components/ui';
import { SaveBar } from './panels';
import { useSetting } from './useSetting';

interface Terminal {
  id: number;
  code: string;
  name: string;
  kind: string;
  last_seen_at: string | null;
  active: boolean;
}

export function TerminalPanel() {
  const { me, can } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const s = useSetting<any>('terminal');
  const q = useQuery({ queryKey: ['terminals'], queryFn: () => api<{ data: Terminal[] }>('/terminals') });
  const [newKey, setNewKey] = useState<{ code: string; key: string } | null>(null);
  const [form, setForm] = useState<{ code: string; name: string; kind: string } | null>(null);
  const [test, setTest] = useState<string | null>(null);

  const create = async () => {
    try {
      const r = await api<{ code: string; api_key: string }>('/terminals', { body: form });
      setForm(null);
      setNewKey({ code: r.code, key: r.api_key });
      qc.invalidateQueries({ queryKey: ['terminals'] });
    } catch (e) {
      toast.push({ kind: 'error', title: 'Could not create terminal', message: e instanceof ApiError ? e.message : '' });
    }
  };
  const rotate = async (t: Terminal) => {
    const r = await api<{ code: string; api_key: string }>(`/terminals/${t.id}/rotate-key`, { body: {} });
    setNewKey({ code: r.code, key: r.api_key });
  };
  const toggle = async (t: Terminal) => {
    try {
      await api(`/terminals/${t.id}`, { method: 'PATCH', body: { active: !t.active } });
      qc.invalidateQueries({ queryKey: ['terminals'] });
    } catch (e) {
      toast.push({ kind: 'error', title: 'Failed', message: e instanceof Error ? e.message : '' });
    }
  };

  return (
    <div className="space-y-8">
      <section>
        <p className="mb-3 rounded-xl bg-slate-100 p-3 text-sm dark:bg-slate-800">
          This device: <strong>{me?.terminal ? `${me.terminal.code} — ${me.terminal.name}` : 'not paired'}</strong>
          {store.terminalKey && (
            <Button
              size="sm"
              variant="ghost"
              className="ml-2"
              onClick={() => {
                store.terminalKey = null;
                window.location.reload();
              }}
            >
              Unpair
            </Button>
          )}
        </p>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-lg font-bold">Terminals</h2>
          {can('settings.write') && (
            <Button size="sm" onClick={() => setForm({ code: '', name: '', kind: 'POS' })}>
              Add terminal
            </Button>
          )}
        </div>
        {!q.data ? (
          <SkeletonRows rows={2} />
        ) : (
          <ul className="divide-y divide-slate-100 rounded-xl ring-1 ring-slate-200 dark:divide-slate-800 dark:ring-slate-700">
            {q.data.data.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <span>
                  <strong className="font-mono">{t.code}</strong> · {t.name} <span className="text-sm text-slate-500">({t.kind})</span>
                  <span className="block text-xs text-slate-500">
                    {t.active ? 'Active' : 'Disabled'} · last seen {fmtDateTime(t.last_seen_at)}
                  </span>
                </span>
                {can('settings.write') && (
                  <span className="flex gap-2">
                    <Button size="sm" variant="secondary" onClick={() => rotate(t)}>
                      <KeyRound className="h-4 w-4" /> New key
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => toggle(t)}>
                      {t.active ? 'Disable' : 'Enable'}
                    </Button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {s.value && (
        <fieldset disabled={!s.canEdit} className="grid gap-4 sm:grid-cols-2">
          <h2 className="text-lg font-bold sm:col-span-2">Payment gateway (online reloads)</h2>
          <Field label="Gateway" htmlFor="gw">
            <select id="gw" className={inputCls} value={s.value.gateway} onChange={(e) => s.set('gateway', e.target.value)}>
              <option value="stub">Stub (sandbox — no real charges)</option>
              <option value="stripe">Stripe (placeholder)</option>
              <option value="square">Square (placeholder)</option>
            </select>
          </Field>
          <Field label="Mode" htmlFor="gw-m">
            <select id="gw-m" className={inputCls} value={s.value.gateway_mode} onChange={(e) => s.set('gateway_mode', e.target.value)}>
              <option value="sandbox">Sandbox</option>
              <option value="live">Live</option>
            </select>
          </Field>
          <div className="sm:col-span-2">
            <Field label="Publishable key" htmlFor="gw-k" hint="Secret keys belong in server environment variables, never here.">
              <input id="gw-k" className={`${inputCls} font-mono`} value={s.value.gateway_public_key} onChange={(e) => s.set('gateway_public_key', e.target.value)} placeholder="pk_live_…" />
            </Field>
          </div>
          <div className="flex items-center gap-3 sm:col-span-2">
            <Button
              variant="secondary"
              onClick={async () => {
                const r = await api<{ ok: boolean; message: string; latency_ms: number }>('/terminals/test-connection', { body: {} });
                setTest(`${r.ok ? '✓' : '✗'} ${r.message} (${r.latency_ms} ms)`);
              }}
            >
              <Plug className="h-4 w-4" /> Test connection
            </Button>
            {test && <span role="status">{test}</span>}
          </div>
          <div className="sm:col-span-2">
            <SaveBar s={s} />
          </div>
        </fieldset>
      )}

      {form && (
        <Modal
          open
          onClose={() => setForm(null)}
          title="Add terminal"
          size="sm"
          footer={
            <Button onClick={create} disabled={!form.code || !form.name}>
              Create
            </Button>
          }
        >
          <div className="space-y-3">
            <Field label="Code" htmlFor="t-c" hint="e.g. FRONT-DESK-2">
              <input id="t-c" className={`${inputCls} font-mono`} value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} />
            </Field>
            <Field label="Name" htmlFor="t-n">
              <input id="t-n" className={inputCls} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <Field label="Kind" htmlFor="t-k">
              <select id="t-k" className={inputCls} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                <option value="POS">Staff POS</option>
                <option value="KIOSK">Customer kiosk</option>
              </select>
            </Field>
          </div>
        </Modal>
      )}
      {newKey && (
        <Modal open onClose={() => setNewKey(null)} title={`Key for ${newKey.code}`} size="sm" footer={<Button onClick={() => setNewKey(null)}>I’ve saved it</Button>}>
          <p className="mb-2 text-sm">Shown only once. Enter it on the device under “Pair device”.</p>
          <div className="flex gap-2">
            <code className="flex-1 break-all rounded-lg bg-slate-100 p-3 dark:bg-slate-800">{newKey.key}</code>
            <Button variant="secondary" aria-label="Copy key" onClick={() => navigator.clipboard?.writeText(newKey.key).then(() => toast.push({ kind: 'success', title: 'Copied' }))}>
              <Copy className="h-4 w-4" />
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
