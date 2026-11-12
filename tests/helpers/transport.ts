/**
 * Transport-neutral HTTP surface for the authorization-matrix tests.
 *
 * A matrix test drives `(req: Request) => Promise<Response>` only, so the
 * same table can later run unchanged against a Hono app (`app.request`).
 * Today the adapter wraps Fastify's in-process `inject`; production code is
 * not involved.
 */
import type { FastifyInstance } from 'fastify';

export type Transport = (req: Request) => Promise<Response>;

const ORIGIN = 'http://localhost';

/** Wrap a Fastify app as a fetch-style transport (no network). */
export function fastifyTransport(app: FastifyInstance): Transport {
  return async (req) => {
    const url = new URL(req.url);
    const body = req.body === null ? undefined : await req.text();
    const injected = await app.inject({
      method: req.method as 'GET',
      url: url.pathname + url.search,
      headers: Object.fromEntries(req.headers),
      ...(body === undefined ? {} : { payload: body }),
    });

    const headers = new Headers();
    for (const [name, value] of Object.entries(injected.headers)) {
      if (value === undefined) continue;
      for (const item of Array.isArray(value) ? value : [value]) {
        headers.append(name, String(item));
      }
    }
    const nullBody = [101, 204, 205, 304].includes(injected.statusCode);
    return new Response(nullBody ? null : injected.rawPayload, {
      status: injected.statusCode,
      headers,
    });
  };
}

export interface CallOptions {
  /** Raw `Cookie` header value, e.g. a signed `sessionId=...` cookie. */
  cookie?: string;
  /** JSON request body. */
  json?: unknown;
}

/** Build a Request for `path` and send it through `transport`. */
export function call(
  transport: Transport,
  method: string,
  path: string,
  options: CallOptions = {}
): Promise<Response> {
  const headers = new Headers();
  if (options.cookie) headers.set('cookie', options.cookie);
  if (options.json !== undefined) {
    headers.set('content-type', 'application/json');
  }
  return transport(
    new Request(ORIGIN + path, {
      method,
      headers,
      body:
        options.json === undefined ? undefined : JSON.stringify(options.json),
    })
  );
}
