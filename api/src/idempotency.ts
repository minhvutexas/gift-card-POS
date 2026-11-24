import type { NextFunction, Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { one, query } from './db.js';
import { ApiError } from './errors.js';

const KEY_RE = /^[A-Za-z0-9_\-:.]{8,64}$/;

/**
 * Every mutating route requires an `Idempotency-Key` header.
 *  - First request: row inserted as IN_PROGRESS, handler runs, response stored.
 *  - Same key + same body: stored response is replayed verbatim (double-scan safe).
 *  - Same key + different body: 409 IDEMPOTENCY_CONFLICT.
 *  - Same key while first is still running: 409 IDEMPOTENCY_IN_PROGRESS.
 * The key is also passed to fn_apply_txn so the ledger itself is idempotent.
 */
export function idempotency(opts: { required?: boolean } = { required: true }) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
    const key = req.get('idempotency-key');
    if (!key) {
      if (opts.required === false) return next();
      return next(new ApiError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required for this request', 'Idempotency-Key'));
    }
    if (!KEY_RE.test(key)) return next(new ApiError(400, 'VALIDATION', 'Idempotency-Key must be 8–64 chars [A-Za-z0-9_-:.]', 'Idempotency-Key'));

    const scope = `${req.user?.id ?? 'anon'}`;
    const requestHash = createHash('sha256')
      .update(`${scope}|${req.method}|${req.baseUrl}${req.path}|${JSON.stringify(req.body ?? {})}`)
      .digest('hex');

    const inserted = await one(
      `INSERT INTO idempotency_keys (key, method, path, request_hash) VALUES ($1, $2, $3, $4)
       ON CONFLICT (key) DO NOTHING RETURNING key`,
      [key, req.method, req.originalUrl.slice(0, 500), requestHash],
    );

    if (!inserted) {
      const prev = await one<{ request_hash: string; status_code: number | null; response: any }>(
        'SELECT request_hash, status_code, response FROM idempotency_keys WHERE key = $1',
        [key],
      );
      if (!prev) return next(new ApiError(409, 'IDEMPOTENCY_IN_PROGRESS', 'Retry shortly'));
      if (prev.request_hash !== requestHash) {
        return next(new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency-Key was already used with a different request', 'Idempotency-Key'));
      }
      if (prev.status_code === null) return next(new ApiError(409, 'IDEMPOTENCY_IN_PROGRESS', 'The original request is still being processed'));
      res.setHeader('Idempotent-Replay', 'true');
      return res.status(prev.status_code).json(prev.response);
    }

    req.idempotencyKey = key;

    // Capture the JSON body we send so it can be replayed later.
    const origJson = res.json.bind(res);
    res.json = (body: any) => {
      const status = res.statusCode;
      // Only successes are cached. Errors free the key so the same request can be
      // retried after the cause is fixed (approval given, card unfrozen...). The
      // ledger's own idempotency_key still blocks any double-apply.
      const cacheable = status >= 200 && status < 300;
      const write = cacheable
        ? query('UPDATE idempotency_keys SET status_code = $2, response = $3, completed_at = now() WHERE key = $1', [key, status, body])
        : query('DELETE FROM idempotency_keys WHERE key = $1', [key]);
      write.catch((e) => console.error('idempotency store failed', e));
      return origJson(body);
    };
    // Non-JSON responses (PDF/CSV) or aborted requests: release the key.
    res.on('close', () => {
      if (!res.headersSent || !res.getHeader('content-type')?.toString().includes('json')) {
        query('DELETE FROM idempotency_keys WHERE key = $1 AND status_code IS NULL', [key]).catch(() => {});
      }
    });
    next();
  };
}

/** Housekeeping: keys older than 7 days are no longer needed for replay. */
export async function purgeIdempotencyKeys() {
  await query(`DELETE FROM idempotency_keys WHERE created_at < now() - interval '7 days'`);
}
