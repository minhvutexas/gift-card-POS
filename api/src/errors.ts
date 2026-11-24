import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';

/**
 * RFC 7807-style problem body:
 *   { status, code, message, field?, details? }   (Content-Type: application/problem+json)
 */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public field?: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, field?: string) => new ApiError(400, 'VALIDATION', message, field);
export const notFound = (message = 'Not found') => new ApiError(404, 'NOT_FOUND', message);
export const forbidden = (message = 'You do not have permission for this action', code = 'FORBIDDEN') => new ApiError(403, code, message);
export const unauthorized = (message = 'Authentication required', code = 'UNAUTHENTICATED') => new ApiError(401, code, message);

/** Custom SQLSTATEs raised by db/schema.sql functions. */
const PG_MAP: Record<string, [number, string]> = {
  GC400: [400, 'VALIDATION'],
  GC402: [422, 'INSUFFICIENT_FUNDS'],
  GC404: [404, 'CARD_NOT_FOUND'],
  GC409: [409, 'STATE_CONFLICT'],
  GC410: [422, 'CARD_EXPIRED'],
  GC423: [423, 'CARD_FROZEN'],
  GC424: [422, 'CARD_VOIDED'],
  GC425: [409, 'IDEMPOTENCY_CONFLICT'],
  GC426: [409, 'ALREADY_REVERSED'],
};

export function fromPg(err: any): ApiError | null {
  if (!err || typeof err.code !== 'string') return null;
  const m = PG_MAP[err.code];
  if (m) {
    let details: Record<string, unknown> | undefined;
    if (err.detail) {
      try {
        details = JSON.parse(err.detail);
      } catch {
        details = { detail: err.detail };
      }
    }
    return new ApiError(m[0], m[1], err.message, err.code === 'GC402' ? 'amount_cents' : undefined, details);
  }
  if (err.code === '23505') {
    const field = /\((.+?)\)=/.exec(err.detail ?? '')?.[1];
    return new ApiError(409, 'DUPLICATE', `Duplicate value${field ? ` for ${field}` : ''}`, field);
  }
  if (err.code === '23514') return new ApiError(422, 'CONSTRAINT', `Rule violated: ${err.constraint ?? err.message}`);
  if (err.code === '23503') return new ApiError(422, 'REFERENCE', 'Referenced record does not exist');
  if (err.code === '22P02' || err.code === '22003') return new ApiError(400, 'VALIDATION', 'Invalid value');
  return null;
}

export function toApiError(err: any): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof ZodError) {
    const issue = err.issues[0];
    return new ApiError(400, 'VALIDATION', issue?.message ?? 'Invalid request', issue?.path.join('.') || undefined, {
      issues: err.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    });
  }
  if (err?.type === 'entity.parse.failed') return new ApiError(400, 'BAD_JSON', 'Malformed JSON body');
  if (err?.type === 'entity.too.large') return new ApiError(413, 'TOO_LARGE', 'Request body too large');
  return fromPg(err) ?? new ApiError(500, 'INTERNAL', 'Unexpected server error');
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const e = toApiError(err);
  if (e.status >= 500) console.error(`[${req.method} ${req.originalUrl}]`, err);
  res
    .status(e.status)
    .type('application/problem+json')
    .json({ status: e.status, code: e.code, message: e.message, ...(e.field ? { field: e.field } : {}), ...(e.details ? { details: e.details } : {}) });
};
