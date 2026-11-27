/**
 * Request correlation and structured request logging for the V2 app (#143).
 *
 * The request id is accepted from `x-request-id` only when it is a safe,
 * short token; otherwise a fresh UUID is generated. It is echoed on every
 * response (and exposed through CORS) so an operator can join a client
 * report to one JSON log line without the log carrying content.
 */

import type { MiddlewareHandler } from 'hono';
import { REDACTED, type Logger } from './log.js';

export const REQUEST_ID_HEADER = 'X-Request-Id';
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/** 64-hex export tokens (and similar) are opaque path segments, not routes. */
const OPAQUE_PATH_SEGMENT = /^[A-Za-z0-9_-]{32,}$/;

/** Use a client-supplied id only when it is safe; otherwise generate one. */
export function resolveRequestId(candidate: string | undefined | null): string {
  const trimmed = candidate?.trim();
  return trimmed && REQUEST_ID_PATTERN.test(trimmed)
    ? trimmed
    : crypto.randomUUID();
}

/**
 * Keep the route shape without retaining opaque path tokens (for example the
 * export artifact token in `/v2/community/export/download/:token`).
 */
export function safeRequestPath(path: string): string {
  return path
    .split('/')
    .map((segment) => (OPAQUE_PATH_SEGMENT.test(segment) ? REDACTED : segment))
    .join('/');
}

/**
 * Outermost middleware: assigns the correlation id, echoes it, and emits one
 * JSON line per completed request. Thrown errors are logged once by the app's
 * `onError` handler, so this never duplicates them.
 */
export function requestLog(logger: Logger): MiddlewareHandler {
  return async (c, next) => {
    const requestId = resolveRequestId(c.req.header('x-request-id'));
    const startedAt = Date.now();
    c.set('requestId', requestId);
    c.set('requestStartedAt', startedAt);
    c.header(REQUEST_ID_HEADER, requestId);

    await next();

    c.header(REQUEST_ID_HEADER, requestId);
    const status = c.res.status;
    const fields = {
      requestId,
      method: c.req.method,
      path: safeRequestPath(c.req.path),
      status,
      durationMs: Date.now() - startedAt,
    };
    if (status >= 500) logger.error('http.request', fields);
    else logger.info('http.request', fields);
  };
}
