import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { FileUp } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { formatCents } from '../../lib/money';
import { useToast } from '../../lib/toast';
import { Button, Field, inputCls } from '../../components/ui';

const FIELD_LABEL: Record<string, string> = {
  card_number: 'Card number *',
  balance: 'Current balance *',
  face_value: 'Original value',
  label: 'Label',
  first_name: 'First name',
  last_name: 'Last name',
  phone: 'Phone',
  email: 'Email',
  expires_at: 'Expiry date',
  pin: 'Card PIN',
  notes: 'Notes',
};

interface Preview {
  rows_total: number;
  rows_ok: number;
  rows_failed: number;
  rows_skipped: number;
  total_balance_cents: number;
  preview: { row: number; card_number: string | null; balance_cents: number | null; holder: string | null; status: string; message?: string }[];
}

/** Legacy CSV import: upload → map columns → dry-run preview (dedupe) → commit. */
export function ImportPanel() {
  const qc = useQueryClient();
  const toast = useToast();
  const [file, setFile] = useState<{ name: string; csv: string } | null>(null);
  const [step, setStep] = useState<'upload' | 'map' | 'preview' | 'done'>('upload');
  const [headers, setHeaders] = useState<string[]>([]);
  const [fields, setFields] = useState<string[]>([]);
  const [sample, setSample] = useState<Record<string, string>[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = async (body: object) => {
    setBusy(true);
    setErr(null);
    try {
      return await api<any>('/import/csv', { body: { filename: file!.name, csv: file!.csv, ...body } });
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Import failed');
      return null;
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (f: File) => {
    if (f.size > 10_000_000) return setErr('File is larger than 10 MB');
    const csv = await f.text();
    setFile({ name: f.name, csv });
    setBusy(true);
    try {
      const r = await api<any>('/import/csv', { body: { filename: f.name, csv } });
      setHeaders(r.headers);
      setFields(r.fields);
      setSample(r.sample);
      setMapping(r.suggested_mapping);
      setStep('map');
      setErr(null);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not read CSV');
    } finally {
      setBusy(false);
    }
  };

  const cleanMapping = () => Object.fromEntries(Object.entries(mapping).filter(([, v]) => v));

  return (
    <div className="space-y-4">
      <ol className="flex gap-2 text-sm font-semibold" aria-label="Import steps">
        {['upload', 'map', 'preview', 'done'].map((s, i) => (
          <li key={s} aria-current={step === s ? 'step' : undefined} className={`rounded-full px-3 py-1 ${step === s ? 'bg-brand-600 text-white' : 'bg-slate-100 dark:bg-slate-800'}`}>
            {i + 1}. {s === 'map' ? 'Map columns' : s === 'preview' ? 'Dry run' : s[0].toUpperCase() + s.slice(1)}
          </li>
        ))}
      </ol>
      {err && (
        <p role="alert" className="font-semibold text-red-600">
          {err}
        </p>
      )}

      {step === 'upload' && (
        <label className="flex min-h-[160px] cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-slate-300 p-6 text-center hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800">
          <FileUp className="h-10 w-10 text-slate-400" aria-hidden />
          <span className="font-semibold">Choose a CSV exported from your old POS</span>
          <span className="text-sm text-slate-500">Needs at least a card number and a balance column. Nothing is saved until you confirm.</span>
          <input type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} disabled={busy} />
        </label>
      )}

      {step === 'map' && (
        <>
          <p>
            <strong>{file?.name}</strong> — match each field to a column in your file.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            {fields.map((f) => (
              <Field key={f} label={FIELD_LABEL[f] ?? f} htmlFor={`map-${f}`}>
                <select id={`map-${f}`} className={inputCls} value={mapping[f] ?? ''} onChange={(e) => setMapping({ ...mapping, [f]: e.target.value })}>
                  <option value="">— not in file —</option>
                  {headers.map((h) => (
                    <option key={h}>{h}</option>
                  ))}
                </select>
              </Field>
            ))}
          </div>
          {sample.length > 0 && (
            <div className="overflow-x-auto">
              <table className="text-sm">
                <caption className="text-left font-semibold">First rows of your file</caption>
                <thead>
                  <tr>
                    {headers.map((h) => (
                      <th key={h} className="px-2 text-left">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sample.map((r, i) => (
                    <tr key={i} className="border-t border-slate-100 dark:border-slate-800">
                      {headers.map((h) => (
                        <td key={h} className="px-2 py-1">
                          {r[h]}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setStep('upload')}>
              Back
            </Button>
            <Button
              loading={busy}
              disabled={!mapping.card_number || !mapping.balance}
              onClick={async () => {
                const r = await run({ mapping: cleanMapping(), dry_run: true });
                if (r) {
                  setPreview(r);
                  setStep('preview');
                }
              }}
            >
              Dry run
            </Button>
          </div>
        </>
      )}

      {step === 'preview' && preview && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              ['Ready to import', preview.rows_ok, 'text-emerald-700'],
              ['Errors', preview.rows_failed, 'text-red-700'],
              ['Skipped (dupes / $0)', preview.rows_skipped, 'text-amber-700'],
              ['Total balance', formatCents(preview.total_balance_cents), ''],
            ].map(([l, n, c]) => (
              <div key={l as string} className="rounded-xl bg-slate-100 p-3 text-center dark:bg-slate-800">
                <p className={`text-2xl font-bold ${c}`}>{n}</p>
                <p className="text-sm text-slate-500">{l}</p>
              </div>
            ))}
          </div>
          <div className="max-h-80 overflow-auto rounded-xl ring-1 ring-slate-200 dark:ring-slate-700">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-slate-50 text-left dark:bg-slate-800">
                <tr>
                  <th className="px-2 py-1">Row</th>
                  <th>Card</th>
                  <th className="text-right">Balance</th>
                  <th>Holder</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {preview.preview.map((r) => (
                  <tr key={r.row} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="px-2 py-1">{r.row}</td>
                    <td className="font-mono">{r.card_number}</td>
                    <td className="text-right tabular-nums">{r.balance_cents !== null ? formatCents(r.balance_cents) : ''}</td>
                    <td>{r.holder}</td>
                    <td className={r.status === 'ok' ? 'text-emerald-700' : r.status === 'error' ? 'text-red-700' : 'text-amber-700'}>
                      {r.status === 'ok' ? '✓ ready' : `${r.status}: ${r.message}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setStep('map')}>
              Back
            </Button>
            <Button
              loading={busy}
              disabled={!preview.rows_ok}
              onClick={async () => {
                const r = await run({ mapping: cleanMapping(), dry_run: false });
                if (r) {
                  setPreview(r);
                  setStep('done');
                  qc.invalidateQueries({ queryKey: ['cards'] });
                  toast.push({ kind: 'success', title: `Imported ${r.rows_ok} cards`, message: formatCents(r.total_balance_cents) });
                }
              }}
            >
              Import {preview.rows_ok} cards
            </Button>
          </div>
        </>
      )}

      {step === 'done' && preview && (
        <div className="space-y-3">
          <p className="text-lg">
            ✓ Imported <strong>{preview.rows_ok}</strong> cards ({formatCents(preview.total_balance_cents)}). {preview.rows_failed + preview.rows_skipped} rows were not imported.
          </p>
          <Button
            onClick={() => {
              setStep('upload');
              setFile(null);
              setPreview(null);
            }}
          >
            Import another file
          </Button>
        </div>
      )}
    </div>
  );
}
