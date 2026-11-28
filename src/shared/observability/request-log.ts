/**
 * Request correlation and structured request logging for the V2 app (#143).
 *
 * The logged id is always server-generated, so client text never enters a log
 * line. A client `x-request-id` is only echoed back (never logged as-is) and
 * appears in the log, when at all, as a short hash. The request is identified
 * by its matched route template (`/v2/stories/:id`) or the fixed label
 * `unmatched`; raw paths and query strings are never logged.
 */

import type { Context, MiddlewareHandler } from 'hono';
import { matchedRoutes, routePath } from 'hono/route';
import type { LogFields, Logger } from './log.js';

export const REQUEST_ID_HEADER = 'X-Request-Id';
/** Echo of an accepted client id; the value is not logged. */
export const CLIENT_REQUEST_ID_HEADER = 'X-Request-Id-Client';
/** Server-side id of the log line for an unhandled error. */
export const ERROR_ID_HEADER = 'X-Error-Id';
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
/** Label for a request no route matched (Hono reports a `*` template). */
export const UNMATCHED_ROUTE = 'unmatched';

/** Use a client id only when it is a safe, short token. */
export function acceptClientRequestId(
  candidate: string | undefined | null
): string | undefined {
  const trimmed = candidate?.trim();
  return trimmed && REQUEST_ID_PATTERN.test(trimmed) ? trimmed : undefined;
}

/** Correlation id of one log line; never taken from the client. */
export function newRequestId(): string {
  return crypto.randomUUID();
}

/** Correlation aid for an echoed client id without retaining its text. */
export async function hashClientRequestId(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value)
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  )
    .join('')
    .slice(0, 16);
}

/**
 * The route template Hono matched, or `unmatched`. Templates are registered
 * paths (`/v2/stories/:id`), never request values, so they are safe to log.
 *
 * A request refused or answered by middleware before its handler (the `/v2/*`
 * session gate answering 401, a CORS preflight) reports a wildcard template
 * from `routePath`; the most specific non-wildcard match then names the route
 * the client addressed. When nothing but wildcard middleware matched — a
 * `notFound` path or a method mismatch — the label is `unmatched`.
 */
export function requestRoute(c: Context): string {
  const current = routePath(c);
  if (current !== '' && !current.endsWith('*')) return current;
  const matched = matchedRoutes(c)
    .map((route) => route.path)
    .filter((path) => path !== '' && !path.endsWith('*'));
  return matched.at(-1) ?? UNMATCHED_ROUTE;
}

/**
 * Outermost middleware: assigns the server correlation id, echoes it (plus an
 * accepted client id), and emits one JSON line per completed request. Thrown
 * errors are logged once by the app's `onError` handler, so this never
 * duplicates them.
 */
export function requestLog(logger: Logger): MiddlewareHandler {
  return async (c, next) => {
    const requestId = newRequestId();
    const clientRequestId = acceptClientRequestId(c.req.header('x-request-id'));
    const startedAt = Date.now();
    c.set('requestId', requestId);
    c.set('requestStartedAt', startedAt);
    c.header(REQUEST_ID_HEADER, requestId);
    if (clientRequestId) c.header(CLIENT_REQUEST_ID_HEADER, clientRequestId);

    await next();

    c.header(REQUEST_ID_HEADER, requestId);
    if (clientRequestId) c.header(CLIENT_REQUEST_ID_HEADER, clientRequestId);
    const status = c.res.status;
    const fields: LogFields = {
      requestId,
      method: c.req.method,
      route: requestRoute(c),
      status,
      durationMs: Date.now() - startedAt,
      ...(clientRequestId
        ? { clientRequestIdHash: await hashClientRequestId(clientRequestId) }
        : {}),
    };
    if (status >= 500) logger.error('http.request', fields);
    else logger.info('http.request', fields);
  };
}
