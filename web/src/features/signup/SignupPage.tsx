import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Check, Copy } from 'lucide-react';
import { api, ApiError, store } from '../../lib/api';
import { Button, Field, inputCls } from '../../components/ui';

const toSlug = (name: string) =>
  name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

interface Form {
  salon_name: string;
  slug: string;
  owner_name: string;
  email: string;
  username: string;
  password: string;
  pin: string;
}

type Errors = Partial<Record<keyof Form, string>>;

function validate(f: Form): Errors {
  const e: Errors = {};
  if (f.salon_name.trim().length < 2) e.salon_name = 'Enter your salon’s name.';
  if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(f.slug)) e.slug = 'Use 3–40 lowercase letters, numbers or dashes.';
  if (!f.owner_name.trim()) e.owner_name = 'Enter your name.';
  if (!/^\S+@\S+\.\S+$/.test(f.email.trim())) e.email = 'Enter an email like you@salon.com.';
  if (!/^[A-Za-z0-9._-]{2,40}$/.test(f.username.trim())) e.username = 'Use 2–40 letters, numbers, dots, dashes or underscores (no spaces).';
  if (f.password.length < 10) e.password = 'Use at least 10 characters.';
  if (!/^\d{4,8}$/.test(f.pin)) e.pin = 'Use 4–8 digits.';
  return e;
}

interface Created {
  business: { slug: string; name: string };
  terminal_key: string;
  token: string;
  username?: string;
}

/** Public: a new salon creates its account, owner login and first paired device. */
export function SignupPage() {
  const [f, setF] = useState<Form>({ salon_name: '', slug: '', owner_name: '', email: '', username: '', password: '', pin: '' });
  const [slugEdited, setSlugEdited] = useState(false);
  const [userEdited, setUserEdited] = useState(false);
  const [touched, setTouched] = useState<Partial<Record<keyof Form, boolean>>>({});
  const [serverErr, setServerErr] = useState<Errors>({});
  const [formErr, setFormErr] = useState<string | null>(null);
  const [slugState, setSlugState] = useState<{ slug: string; ok: boolean; reason?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Created | null>(null);

  const errors = validate(f);
  const shown = (k: keyof Form) => serverErr[k] ?? (touched[k] ? errors[k] : undefined);
  const set = (k: keyof Form, v: string) => {
    setF((p) => ({
      ...p,
      [k]: v,
      ...(k === 'salon_name' && !slugEdited ? { slug: toSlug(v) } : {}),
      ...(k === 'owner_name' && !userEdited ? { username: toSlug(v.trim().split(/\s+/)[0] ?? '').replace(/-/g, '').slice(0, 40) } : {}),
    }));
    setServerErr((p) => ({ ...p, [k]: undefined, ...(k === 'salon_name' && !slugEdited ? { slug: undefined } : {}) }));
  };
  const blur = (k: keyof Form) => () => setTouched((p) => ({ ...p, [k]: true }));

  // Live Salon ID check (debounced)
  useEffect(() => {
    if (errors.slug) {
      setSlugState(null);
      return;
    }
    const slug = f.slug;
    const t = window.setTimeout(async () => {
      try {
        const r = await api<{ available: boolean; reason?: string }>(`/signup/slug-available?slug=${encodeURIComponent(slug)}`);
        setSlugState({ slug, ok: r.available, reason: r.reason });
      } catch {
        setSlugState(null);
      }
    }, 350);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f.slug]);

  const slugTaken = slugState && slugState.slug === f.slug && !slugState.ok ? (slugState.reason ?? 'That Salon ID is taken.') : undefined;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched({ salon_name: true, slug: true, owner_name: true, email: true, username: true, password: true, pin: true });
    setFormErr(null);
    if (Object.keys(errors).length || slugTaken) return;
    setBusy(true);
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const r = await api<Created>('/signup', { body: { ...f, username: f.username.trim(), timezone: tz } });
      store.terminalKey = r.terminal_key;
      store.token = r.token;
      store.business = r.business.slug;
      setDone({ ...r, username: f.username.trim() });
    } catch (x) {
      if (x instanceof ApiError && x.field && x.field in f) setServerErr({ [x.field]: x.message });
      else setFormErr(x instanceof ApiError ? x.message : 'We couldn’t create your account. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-brand-50 to-slate-100 p-4 dark:from-slate-950 dark:to-slate-900">
      <div className="w-full max-w-lg rounded-3xl bg-white p-6 shadow-xl dark:bg-slate-900 sm:p-8">
        {done ? (
          <Welcome created={done} />
        ) : (
          <>
            <h1 className="text-2xl font-bold">Create your salon account</h1>
            <p className="mt-1 text-slate-600 dark:text-slate-300">Gift cards for your salon. Free to start.</p>

            <form className="mt-6 space-y-4" onSubmit={submit} noValidate>
              <Field label="Salon name" htmlFor="sn" error={shown('salon_name')}>
                <input id="sn" className={inputCls} value={f.salon_name} onChange={(e) => set('salon_name', e.target.value)} onBlur={blur('salon_name')} autoComplete="organization" autoFocus />
              </Field>
              <Field
                label="Salon ID"
                htmlFor="slug"
                error={shown('slug') ?? slugTaken}
                hint={slugState?.ok && slugState.slug === f.slug ? <span className="text-emerald-700 dark:text-emerald-400">Available</span> : 'Staff type this to sign in on a new device. You can’t change it later.'}
              >
                <input
                  id="slug"
                  className={`${inputCls} font-mono lowercase`}
                  value={f.slug}
                  onChange={(e) => {
                    setSlugEdited(true);
                    set('slug', e.target.value.toLowerCase());
                  }}
                  onBlur={blur('slug')}
                  autoCapitalize="none"
                  spellCheck={false}
                />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Your name" htmlFor="on" error={shown('owner_name')}>
                  <input id="on" className={inputCls} value={f.owner_name} onChange={(e) => set('owner_name', e.target.value)} onBlur={blur('owner_name')} autoComplete="name" />
                </Field>
                <Field label="Email" htmlFor="em" error={shown('email')}>
                  <input id="em" type="email" className={inputCls} value={f.email} onChange={(e) => set('email', e.target.value)} onBlur={blur('email')} autoComplete="email" />
                </Field>
              </div>
              <Field label="Username" htmlFor="un" error={shown('username')} hint="You sign in with this, your password and the Salon ID.">
                <input
                  id="un"
                  className={`${inputCls} font-mono`}
                  value={f.username}
                  onChange={(e) => {
                    setUserEdited(true);
                    set('username', e.target.value.replace(/\s/g, ''));
                  }}
                  onBlur={blur('username')}
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Password" htmlFor="pw" error={shown('password')} hint="For signing in as owner. 10+ characters.">
                  <input id="pw" type="password" className={inputCls} value={f.password} onChange={(e) => set('password', e.target.value)} onBlur={blur('password')} autoComplete="new-password" />
                </Field>
                <Field label="PIN" htmlFor="pin" error={shown('pin')} hint="4–8 digits, for quick sign-in at the desk.">
                  <input
                    id="pin"
                    type="password"
                    inputMode="numeric"
                    className={`${inputCls} font-mono`}
                    value={f.pin}
                    onChange={(e) => set('pin', e.target.value.replace(/\D/g, '').slice(0, 8))}
                    onBlur={blur('pin')}
                    autoComplete="off"
                  />
                </Field>
              </div>
              {formErr && (
                <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950/40 dark:text-red-200">
                  {formErr}
                </p>
              )}
              <Button type="submit" size="lg" className="w-full" loading={busy}>
                Create salon account
              </Button>
            </form>
            <p className="mt-6 text-center text-sm text-slate-600 dark:text-slate-300">
              Already have an account?{' '}
              <Link to="/" className="font-semibold text-brand-700 underline-offset-2 hover:underline dark:text-brand-300">
                Sign in
              </Link>
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <div className="text-sm font-semibold text-slate-700 dark:text-slate-200">{label}</div>
      <div className="mt-1 flex items-center gap-2">
        <code className="min-w-0 flex-1 break-all rounded-xl bg-slate-100 px-3 py-2 font-mono text-sm dark:bg-slate-800">{value}</code>
        <Button
          variant="secondary"
          size="sm"
          aria-label={`Copy ${label}`}
          title={`Copy ${label}`}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            } catch {
              /* clipboard blocked: the value stays visible to copy by hand */
            }
          }}
        >
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
        </Button>
      </div>
    </div>
  );
}

function Welcome({ created }: { created: Created }) {
  return (
    <div>
      <h1 className="text-2xl font-bold">{created.business.name} is ready</h1>
      <p className="mt-1 text-slate-600 dark:text-slate-300">This device is signed in and paired. Save these somewhere safe.</p>
      <div className="mt-6 space-y-4">
        <CopyRow label="Salon ID" value={created.business.slug} />
        {created.username && <CopyRow label="Username" value={created.username} />}
        <CopyRow label="Terminal key (shown only once)" value={created.terminal_key} />
      </div>
      <p className="mt-4 text-sm text-slate-600 dark:text-slate-300">
        To add another device, open Settings › Terminal and create a new key for it. Your customers check balances at{' '}
        <span className="font-mono">/k/{created.business.slug}</span>.
      </p>
      <Button size="lg" className="mt-6 w-full" onClick={() => window.location.assign('/')}>
        Open my dashboard
      </Button>
    </div>
  );
}
