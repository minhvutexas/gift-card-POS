import { one, query, runAsSystem } from './db.js';

/** Platform-wide feature switches (set on /platform → Settings). */
export interface Features {
  /** Email + SMS to customers (manual "Email / SMS" and automatic messages). */
  messaging: boolean;
}

const DEFAULTS: Features = { messaging: false };
let cache: { at: number; value: Features } | null = null;

export async function getFeatures(): Promise<Features> {
  if (cache && Date.now() - cache.at < 10_000) return cache.value;
  const row = await runAsSystem(() => one<{ value: Partial<Features> }>(`SELECT value FROM platform_settings WHERE key = 'features'`));
  const value = { ...DEFAULTS, ...(row?.value ?? {}) };
  cache = { at: Date.now(), value };
  return value;
}

export async function setFeatures(patch: Partial<Features>): Promise<Features> {
  const next = { ...(await getFeatures()), ...patch };
  await runAsSystem(() =>
    query(
      `INSERT INTO platform_settings (key, value, updated_at) VALUES ('features', $1, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [JSON.stringify(next)],
    ),
  );
  cache = null;
  return getFeatures();
}
