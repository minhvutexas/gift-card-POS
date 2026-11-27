import { useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { formatCents, parseToCents } from '../../lib/money';
import { useToast } from '../../lib/toast';
import { Button, Field, inputCls, SkeletonRows } from '../../components/ui';
import { code128Svg } from '../../components/Receipt';
import { useSetting } from './useSetting';

export function SaveBar({ s }: { s: { dirty: boolean; save: () => void; saving: boolean; error: ApiError | null; canEdit: boolean } }) {
  if (!s.canEdit) return <p className="mt-4 text-sm text-zinc-500">Read-only for your role.</p>;
  return (
    <div className="sticky bottom-20 mt-6 flex items-center justify-end gap-3 md:bottom-0">
      {s.error && (
        <p role="alert" className="mr-auto font-semibold text-red-600">
          {s.error.field ? `${s.error.field}: ` : ''}
          {s.error.message}
        </p>
      )}
      {s.dirty && <span className="text-sm text-amber-700">Unsaved changes</span>}
      <Button onClick={s.save} loading={s.saving} disabled={!s.dirty}>
        Save changes
      </Button>
    </div>
  );
}

export function Toggle({ label, checked, onChange, hint }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <label className="flex min-h-[48px] cursor-pointer items-center justify-between gap-4 rounded-lg px-1">
      <span>
        <span className="font-medium">{label}</span>
        {hint && <span className="block text-sm text-zinc-500">{hint}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative h-8 w-14 shrink-0 rounded-full transition ${checked ? 'bg-brand-600' : 'bg-zinc-300 dark:bg-zinc-600'}`}
      >
        <span className={`absolute top-1 h-6 w-6 rounded-full bg-white shadow transition ${checked ? 'left-7' : 'left-1'}`} />
      </button>
    </label>
  );
}

export function MoneyInput({ id, cents, onChange }: { id: string; cents: number; onChange: (c: number) => void }) {
  const [text, setText] = useState((cents / 100).toFixed(2));
  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500">$</span>
      <input
        id={id}
        inputMode="decimal"
        className={`${inputCls} pl-7`}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const c = parseToCents(e.target.value);
          if (c !== null) onChange(c);
        }}
        onBlur={() => setText((cents / 100).toFixed(2))}
      />
    </div>
  );
}

// ------------------------------------------------------------------ General
const TIMEZONES = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu', 'America/Toronto', 'Europe/London', 'Australia/Sydney'];

export function GeneralPanel() {
  const s = useSetting<any>('general');
  if (!s.value) return <SkeletonRows rows={4} />;
  const v = s.value;
  return (
    <fieldset disabled={!s.canEdit} className="grid gap-4 sm:grid-cols-2">
      <Field label="Business name" htmlFor="g-name">
        <input id="g-name" className={inputCls} value={v.business_name} onChange={(e) => s.set('business_name', e.target.value)} />
      </Field>
      <Field label="Phone" htmlFor="g-phone">
        <input id="g-phone" className={inputCls} value={v.phone} onChange={(e) => s.set('phone', e.target.value)} />
      </Field>
      <div className="sm:col-span-2">
        <Field label="Address" htmlFor="g-addr">
          <input id="g-addr" className={inputCls} value={v.address} onChange={(e) => s.set('address', e.target.value)} />
        </Field>
      </div>
      <Field label="Logo URL" htmlFor="g-logo" hint="PNG/SVG, shown on receipts & kiosk">
        <input id="g-logo" className={inputCls} value={v.logo_url} onChange={(e) => s.set('logo_url', e.target.value)} />
      </Field>
      <Field label="Timezone" htmlFor="g-tz">
        <select id="g-tz" className={inputCls} value={v.timezone} onChange={(e) => s.set('timezone', e.target.value)}>
          {[...new Set([v.timezone, ...TIMEZONES])].map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      </Field>
      <Field label="Currency" htmlFor="g-cur">
        <select id="g-cur" className={inputCls} value={v.currency} onChange={(e) => s.set('currency', e.target.value)}>
          {['USD', 'CAD', 'EUR', 'GBP', 'AUD'].map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </Field>
      <Field label="Sales tax rate (%)" htmlFor="g-tax" hint="Gift card sales are usually NOT taxed (tax applies when redeemed for services).">
        <input id="g-tax" className={inputCls} inputMode="decimal" value={(v.tax_rate_bps / 100).toString()} onChange={(e) => s.set('tax_rate_bps', Math.round(Number(e.target.value.replace(/[^\d.]/g, '') || 0) * 100))} />
      </Field>
      <div className="sm:col-span-2">
        <Toggle label="Charge tax on gift card sales" checked={v.tax_on_card_sale} onChange={(x) => s.set('tax_on_card_sale', x)} />
      </div>
      <div className="sm:col-span-2">
        <SaveBar s={s} />
      </div>
    </fieldset>
  );
}

// ------------------------------------------------------------------ Receipt
export function ReceiptPanel() {
  const s = useSetting<any>('receipt');
  if (!s.value) return <SkeletonRows rows={4} />;
  const v = s.value;
  return (
    <fieldset disabled={!s.canEdit} className="grid gap-4 lg:grid-cols-2">
      <div className="space-y-4">
        <Field label="Header text" htmlFor="r-h">
          <textarea id="r-h" rows={3} className={`${inputCls} py-2`} value={v.header} onChange={(e) => s.set('header', e.target.value)} />
        </Field>
        <Field label="Footer text" htmlFor="r-f">
          <textarea id="r-f" rows={2} className={`${inputCls} py-2`} value={v.footer} onChange={(e) => s.set('footer', e.target.value)} />
        </Field>
        <Field label="Terms & conditions" htmlFor="r-t">
          <textarea id="r-t" rows={3} className={`${inputCls} py-2`} value={v.terms} onChange={(e) => s.set('terms', e.target.value)} />
        </Field>
        <Toggle label="Show balance after each transaction" checked={v.show_balance_after} onChange={(x) => s.set('show_balance_after', x)} />
        <Toggle label="Print terms" checked={v.show_terms} onChange={(x) => s.set('show_terms', x)} />
        <Toggle label="Barcode (Code 128 card number)" hint="Scan the receipt at the front desk to open the card." checked={v.show_barcode} onChange={(x) => s.set('show_barcode', x)} />
      </div>
      <div>
        <p className="mb-2 text-sm font-semibold">Preview</p>
        <div className="mx-auto w-72 rounded bg-white p-4 font-mono text-xs text-black shadow ring-1 ring-zinc-200">
          {v.header.split('\n').map((l: string, i: number) => (
            <p key={i} className="text-center font-bold">
              {l}
            </p>
          ))}
          <hr className="my-2 border-dashed border-black" />
          <p className="flex justify-between">
            <span>Card</span>
            <span>•••0010</span>
          </p>
          <p className="flex justify-between font-bold">
            <span>Redeemed</span>
            <span>-$45.00</span>
          </p>
          {v.show_balance_after && (
            <p className="flex justify-between font-bold">
              <span>Balance</span>
              <span>$455.00</span>
            </p>
          )}
          <hr className="my-2 border-dashed border-black" />
          {v.show_barcode && <div className="receipt-barcode mx-auto my-2 w-48 [&_svg]:h-auto [&_svg]:w-full" dangerouslySetInnerHTML={{ __html: code128Svg('3460010') }} />}
          <p className="text-center">{v.footer}</p>
          {v.show_terms && <p className="mt-1 text-center text-[10px]">{v.terms}</p>}
        </div>
      </div>
      <div className="lg:col-span-2">
        <SaveBar s={s} />
      </div>
    </fieldset>
  );
}

// ------------------------------------------------------------------ Printer
export function PrinterPanel() {
  const s = useSetting<any>('printer');
  const toast = useToast();
  const [testing, setTesting] = useState(false);
  if (!s.value) return <SkeletonRows rows={4} />;
  const v = s.value;
  const test = async () => {
    setTesting(true);
    try {
      const r = await api<{ mode: string }>('/printer/test', { body: {} });
      if (r.mode === 'browser') window.print();
      toast.push({ kind: 'success', title: r.mode === 'network' ? 'Test page sent' : 'Browser print dialog opened' });
    } catch (e) {
      toast.push({ kind: 'error', title: 'Printer test failed', message: e instanceof Error ? e.message : '' });
    } finally {
      setTesting(false);
    }
  };
  return (
    <fieldset disabled={!s.canEdit} className="grid gap-4 sm:grid-cols-2">
      <Field label="Print method" htmlFor="p-mode" hint="Network = ESC/POS thermal printer on the LAN (port 9100). Browser = AirPrint / OS printer dialog.">
        <select id="p-mode" className={inputCls} value={v.mode} onChange={(e) => s.set('mode', e.target.value)}>
          <option value="network">Network thermal printer (ESC/POS)</option>
          <option value="browser">Browser / AirPrint</option>
          <option value="disabled">Don’t print</option>
        </select>
      </Field>
      <Field label="Paper width" htmlFor="p-w">
        <select id="p-w" className={inputCls} value={v.paper_width_mm} onChange={(e) => s.set('paper_width_mm', Number(e.target.value))}>
          <option value={80}>80 mm (48 columns)</option>
          <option value={58}>58 mm (32 columns)</option>
        </select>
      </Field>
      {v.mode === 'network' && (
        <>
          <Field label="Printer IP / host" htmlFor="p-host">
            <input id="p-host" className={inputCls} placeholder="192.168.1.50" value={v.host} onChange={(e) => s.set('host', e.target.value.trim())} />
          </Field>
          <Field label="Port" htmlFor="p-port">
            <input id="p-port" className={inputCls} inputMode="numeric" value={v.port} onChange={(e) => s.set('port', Number(e.target.value.replace(/\D/g, '') || 9100))} />
          </Field>
        </>
      )}
      <Field label="Copies" htmlFor="p-copies">
        <select id="p-copies" className={inputCls} value={v.copies} onChange={(e) => s.set('copies', Number(e.target.value))}>
          {[1, 2, 3].map((n) => (
            <option key={n}>{n}</option>
          ))}
        </select>
      </Field>
      <fieldset className="sm:col-span-2">
        <legend className="mb-1 font-semibold">Auto-print after…</legend>
        {(['issue', 'redeem', 'reload', 'refund'] as const).map((k) => (
          <Toggle key={k} label={{ issue: 'Selling a card', redeem: 'Redemption', reload: 'Reload', refund: 'Refund' }[k]} checked={v.auto_print[k]} onChange={(x) => s.set('auto_print', { ...v.auto_print, [k]: x })} />
        ))}
      </fieldset>
      <div className="flex items-center gap-3 sm:col-span-2">
        <Button variant="secondary" onClick={test} loading={testing} disabled={s.dirty}>
          Print test page
        </Button>
        {s.dirty && <span className="text-sm text-zinc-500">Save first to test new settings</span>}
      </div>
      <div className="sm:col-span-2">
        <SaveBar s={s} />
      </div>
    </fieldset>
  );
}

// ------------------------------------------------------------------ Messaging
interface Template {
  id: number;
  key: string;
  channel: string;
  subject: string | null;
  body: string;
  active: boolean;
}

export function MessagingPanel() {
  const s = useSetting<any>('messaging');
  const qc = useQueryClient();
  const toast = useToast();
  const t = useQuery({ queryKey: ['templates'], queryFn: () => api<{ data: Template[] }>('/templates') });
  const [edits, setEdits] = useState<Record<number, Partial<Template>>>({});
  if (!s.value) return <SkeletonRows rows={4} />;
  const v = s.value;
  const saveTpl = async (tpl: Template) => {
    const e = { ...tpl, ...edits[tpl.id] };
    try {
      await api(`/templates/${tpl.id}`, { method: 'PUT', body: { subject: e.subject, body: e.body, active: e.active } });
      setEdits(({ [tpl.id]: _, ...rest }) => rest);
      qc.invalidateQueries({ queryKey: ['templates'] });
      toast.push({ kind: 'success', title: 'Template saved' });
    } catch (x) {
      toast.push({ kind: 'error', title: 'Save failed', message: x instanceof Error ? x.message : '' });
    }
  };
  const days = v.expiry_warning_days as number[];
  return (
    <div className="space-y-6">
      <fieldset disabled={!s.canEdit} className="grid gap-4 sm:grid-cols-2">
        <Field label="Email provider" htmlFor="m-ep" hint="“Log” records messages without sending (setup/testing).">
          <select id="m-ep" className={inputCls} value={v.email_provider} onChange={(e) => s.set('email_provider', e.target.value)}>
            <option value="log">Log only</option>
            <option value="sendgrid">SendGrid (SENDGRID_API_KEY)</option>
          </select>
        </Field>
        <Field label="SMS provider" htmlFor="m-sp">
          <select id="m-sp" className={inputCls} value={v.sms_provider} onChange={(e) => s.set('sms_provider', e.target.value)}>
            <option value="log">Log only</option>
            <option value="twilio">Twilio (TWILIO_* env)</option>
          </select>
        </Field>
        <Field label="From email" htmlFor="m-fe">
          <input id="m-fe" className={inputCls} value={v.from_email} onChange={(e) => s.set('from_email', e.target.value)} />
        </Field>
        <Field label="From SMS number" htmlFor="m-fs">
          <input id="m-fs" className={inputCls} value={v.from_sms} onChange={(e) => s.set('from_sms', e.target.value)} />
        </Field>
        <Field label="Low-balance alert below" htmlFor="m-low">
          <MoneyInput id="m-low" cents={v.low_balance_threshold_cents} onChange={(c) => s.set('low_balance_threshold_cents', c)} />
        </Field>
        <fieldset>
          <legend className="mb-1 text-sm font-semibold">Expiry warnings (days before)</legend>
          <div className="flex gap-2">
            {[30, 14, 7, 3, 1].map((d) => (
              <label key={d} className={`flex min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center rounded-lg font-semibold ring-1 ring-inset ${days.includes(d) ? 'bg-zinc-900 text-white ring-zinc-900 dark:bg-white dark:text-zinc-900 dark:ring-white' : 'ring-zinc-300 dark:ring-zinc-600'}`}>
                <input type="checkbox" className="sr-only" checked={days.includes(d)} onChange={(e) => s.set('expiry_warning_days', e.target.checked ? [...days, d].sort((a, b) => b - a).slice(0, 5) : days.filter((x) => x !== d))} />
                {d}
              </label>
            ))}
          </div>
        </fieldset>
        <Toggle label="Send low-balance alerts" checked={v.send_low_balance} onChange={(x) => s.set('send_low_balance', x)} />
        <Toggle label="Send reload thank-you" checked={v.send_reload_thanks} onChange={(x) => s.set('send_reload_thanks', x)} />
        <div className="sm:col-span-2">
          <SaveBar s={s} />
        </div>
      </fieldset>

      <section>
        <h2 className="mb-1 text-lg font-bold">Templates</h2>
        <p className="mb-3 text-sm text-zinc-500">
          Variables: <code>{'{{business_name}} {{first_name}} {{card_masked}} {{balance}} {{amount}} {{kiosk_url}} {{expires_on}} {{days_left}}'}</code>
        </p>
        <div className="space-y-3">
          {t.data?.data.map((tpl) => {
            const e = { ...tpl, ...edits[tpl.id] };
            const changed = !!edits[tpl.id];
            return (
              <details key={tpl.id} className="rounded-lg ring-1 ring-zinc-200 dark:ring-zinc-700">
                <summary className="flex min-h-[48px] cursor-pointer items-center justify-between px-4 font-semibold">
                  {tpl.key.replace(/_/g, ' ')} · {tpl.channel}
                  {!e.active && <span className="text-sm text-zinc-500">off</span>}
                </summary>
                <div className="space-y-2 p-4 pt-0">
                  {tpl.channel === 'EMAIL' && (
                    <Field label="Subject" htmlFor={`ts-${tpl.id}`}>
                      <input id={`ts-${tpl.id}`} className={inputCls} value={e.subject ?? ''} onChange={(x) => setEdits({ ...edits, [tpl.id]: { ...edits[tpl.id], subject: x.target.value } })} />
                    </Field>
                  )}
                  <Field label="Body" htmlFor={`tb-${tpl.id}`} hint={tpl.channel === 'SMS' ? `${e.body.length} chars (≈${Math.ceil(e.body.length / 160)} SMS)` : undefined}>
                    <textarea id={`tb-${tpl.id}`} rows={3} className={`${inputCls} py-2`} value={e.body} onChange={(x) => setEdits({ ...edits, [tpl.id]: { ...edits[tpl.id], body: x.target.value } })} />
                  </Field>
                  <Toggle label="Enabled" checked={e.active} onChange={(x) => setEdits({ ...edits, [tpl.id]: { ...edits[tpl.id], active: x } })} />
                  <Button size="sm" disabled={!changed} onClick={() => saveTpl(tpl)}>
                    Save template
                  </Button>
                </div>
              </details>
            );
          })}
        </div>
      </section>
    </div>
  );
}

// ------------------------------------------------------------------ Loyalty
export function LoyaltyPanel() {
  const s = useSetting<any>('loyalty');
  if (!s.value) return <SkeletonRows rows={2} />;
  return (
    <fieldset disabled={!s.canEdit} className="max-w-lg space-y-4">
      <p className="text-zinc-600 dark:text-zinc-300">Lightweight loyalty: customers earn points when they pay with a gift card registered to them.</p>
      <Toggle label="Enable loyalty points" checked={s.value.enabled} onChange={(x) => s.set('enabled', x)} />
      <Field label="Points per $1 spent with a gift card" htmlFor="ly-p" hint={`Example: a ${formatCents(4500)} service earns ${45 * s.value.points_per_dollar} points.`}>
        <input id="ly-p" className={inputCls} inputMode="numeric" value={s.value.points_per_dollar} onChange={(e) => s.set('points_per_dollar', Math.min(100, Number(e.target.value.replace(/\D/g, '') || 0)))} />
      </Field>
      <SaveBar s={s} />
    </fieldset>
  );
}
