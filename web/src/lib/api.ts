/**
 * Thin fetch wrapper:
 *  - adds session JWT, terminal key, and an Idempotency-Key on every mutation
 *  - parses problem+json errors into ApiError
 *  - transparently handles manager step-up: on 403 APPROVAL_REQUIRED it asks the
 *    registered approval handler (PIN pad modal) for a token and retries the
 *    SAME request with the SAME idempotency key.
 */
export const API_BASE: string = import.meta.env.VITE_API_URL ?? '/api/v1';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public field?: string,
    public details?: Record<string, any>,
  ) {
    super(message);
  }
}

const TOKEN_KEY = 'gc.session';
const TERMINAL_KEY = 'gc.terminalKey';
const BUSINESS_KEY = 'gc.business';

/** Pages that are about one named salon (the /k/:slug kiosk) pin it here. */
let businessOverride: string | null = null;
export const setBusinessOverride = (slug: string | null) => {
  businessOverride = slug;
};

const safe = <T,>(fn: () => T, fallback: T): T => {
  try {
    return fn();
  } catch {
    return fallback;
  }
};

export const store = {
  get token(): string | null {
    return safe(() => localStorage.getItem(TOKEN_KEY), null);
  },
  set token(v: string | null) {
    safe(() => (v ? localStorage.setItem(TOKEN_KEY, v) : localStorage.removeItem(TOKEN_KEY)), undefined);
  },
  get terminalKey(): string | null {
    return safe(() => localStorage.getItem(TERMINAL_KEY), null) ?? import.meta.env.VITE_TERMINAL_KEY ?? null;
  },
  set terminalKey(v: string | null) {
    safe(() => (v ? localStorage.setItem(TERMINAL_KEY, v) : localStorage.removeItem(TERMINAL_KEY)), undefined);
  },
  /** Salon ID typed on this device (only needed when it has no terminal key). */
  get business(): string | null {
    return safe(() => localStorage.getItem(BUSINESS_KEY), null);
  },
  set business(v: string | null) {
    safe(() => (v ? localStorage.setItem(BUSINESS_KEY, v.trim().toLowerCase()) : localStorage.removeItem(BUSINESS_KEY)), undefined);
  },
};

/** RFC4122 v4 using getRandomValues — works on plain-HTTP LAN tablets where crypto.randomUUID is unavailable. */
export function uuid(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export interface ApprovalRequest {
  action: string;
  dual_control: boolean;
  message: string;
}
type ApprovalHandler = (req: ApprovalRequest) => Promise<string | null>;
let approvalHandler: ApprovalHandler | null = null;
export const setApprovalHandler = (h: ApprovalHandler | null) => {
  approvalHandler = h;
};

type AuthListener = (code: string) => void;
const authListeners = new Set<AuthListener>();
export const onAuthError = (fn: AuthListener) => {
  authListeners.add(fn);
  return () => {
    authListeners.delete(fn);
  };
};

export interface RequestOpts {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  idempotencyKey?: string;
  approvalToken?: string;
  signal?: AbortSignal;
  /** return the raw Response (downloads) */
  raw?: boolean;
}

function headers(opts: RequestOpts, key?: string): Record<string, string> {
  const h: Record<string, string> = { Accept: 'application/json' };
  if (opts.body !== undefined) h['Content-Type'] = 'application/json';
  const t = store.token;
  if (t) h.Authorization = `Bearer ${t}`;
  const tk = store.terminalKey;
  if (tk) h['X-Terminal-Key'] = tk;
  // A terminal key already names its salon; otherwise say which salon we mean.
  const biz = businessOverride ?? (tk ? null : store.business);
  if (biz) h['X-Business'] = biz;
  if (key) h['Idempotency-Key'] = key;
  if (opts.approvalToken) h['X-Approval-Token'] = opts.approvalToken;
  return h;
}

async function toError(res: Response): Promise<ApiError> {
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    /* not json */
  }
  return new ApiError(res.status, body?.code ?? `HTTP_${res.status}`, body?.message ?? res.statusText ?? 'Request failed', body?.field, body?.details);
}

export async function api<T = any>(path: string, opts: RequestOpts = {}): Promise<T> {
  const method = opts.method ?? (opts.body !== undefined ? 'POST' : 'GET');
  const key = method === 'GET' ? undefined : (opts.idempotencyKey ?? uuid());
  let approvalToken = opts.approvalToken;

  for (let attempt = 0; attempt < 3; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${API_BASE}${path}`, {
        method,
        headers: headers({ ...opts, approvalToken }, key),
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: opts.signal,
      });
    } catch (e: any) {
      if (e?.name === 'AbortError') throw e;
      throw new ApiError(0, 'NETWORK', 'Can’t reach the server. Check the Wi-Fi connection.');
    }
    if (res.ok) {
      if (opts.raw) return res as unknown as T;
      return (res.status === 204 ? null : await res.json()) as T;
    }
    const err = await toError(res);
    if (err.code === 'APPROVAL_REQUIRED' && approvalHandler) {
      const tok = await approvalHandler({ action: err.details?.action ?? 'large_amount', dual_control: !!err.details?.dual_control, message: err.message });
      if (!tok) throw new ApiError(403, 'APPROVAL_CANCELLED', 'Manager approval was cancelled');
      approvalToken = tok;
      continue; // retry same request, same idempotency key
    }
    if (res.status === 401 && ['SESSION_INVALID', 'UNAUTHENTICATED', 'TERMINAL_REQUIRED', 'TERMINAL_INVALID'].includes(err.code)) {
      authListeners.forEach((l) => l(err.code));
    }
    throw err;
  }
  throw new ApiError(403, 'APPROVAL_INVALID', 'Approval failed');
}

/** Authenticated file download (CSV/PDF) without putting the token in a URL. */
export async function download(path: string, fallbackName: string) {
  const res = await api<Response>(path, { raw: true });
  const blob = await res.blob();
  const cd = res.headers.get('content-disposition') ?? '';
  const name = /filename="?([^"]+)"?/.exec(cd)?.[1] ?? fallbackName;
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Open a PDF in a new tab (statement). */
export async function openPdf(path: string) {
  const w = window.open('', '_blank');
  const res = await api<Response>(path, { raw: true });
  const url = URL.createObjectURL(await res.blob());
  if (w) w.location.href = url;
  else window.location.href = url;
}
