export interface Endpoint {
  method: string;
  path: string;
}
export interface Step extends Endpoint {
  name: string;
  expected: number;
  body?: unknown;
  rawBody?: string | Uint8Array;
  captureId?: string;
  prepare?: () => Promise<void>;
  headers?: Record<string, string>;
  check?: (body: unknown) => boolean;
  /** Save the cookie sent by this step, before response Set-Cookie changes it. */
  saveCookieAs?: string;
  /** Replay a previously saved cookie even after logout cleared the cookie jar. */
  useSavedCookie?: string;
}
export interface Journey {
  persona: string;
  steps: Step[];
  skipped?: string;
}
export interface Exclusion extends Endpoint {
  reason: string;
}
export interface Result extends Endpoint {
  persona: string;
  step: string;
  expected: number;
  actual: number;
  pass: boolean;
  failure?:
    | 'status-mismatch'
    | 'body-mismatch'
    | 'missing-created-id'
    | 'request-failed'
    | 'unmatched-route'
    | 'request-timeout';
  message?: string;
}
export type Handler = (request: Request) => Promise<Response>;
export function validateBaseUrl(value: string): URL {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error('Invalid base URL');
  return url;
}
export function validateRequestTimeout(value: number): number {
  if (!Number.isFinite(value) || value <= 0 || value > 2_147_483_647) {
    throw new Error(
      'Request timeout must be positive, finite and at most 2147483647 milliseconds'
    );
  }
  return value;
}
const key = (endpoint: Endpoint) =>
  `${endpoint.method.toUpperCase()} ${endpoint.path}`;
function matches(pattern: string, path: string): boolean {
  const a = pattern.replace(/\/$/, '').split('/');
  const b = path.split('?')[0].replace(/\/$/, '').split('/');
  return (
    a.length === b.length &&
    a.every((part, i) => part.startsWith(':') || part === b[i])
  );
}
export async function runJourneys(options: {
  handler: Handler;
  routes: Endpoint[];
  journeys: Journey[];
  exclusions?: Exclusion[];
  requestTimeoutMs?: number;
  /** Tracked session cookie name; stacks differ (Fastify sessionId, Hono ts_session). */
  sessionCookieName?: string;
}) {
  const timeoutMs = validateRequestTimeout(options.requestTimeoutMs ?? 30_000);
  const sessionCookieName = options.sessionCookieName ?? 'sessionId';
  const sessionCookiePrefix = `${sessionCookieName}=`;
  const sessionCookieSplit = new RegExp(
    `,(?=\\s*${sessionCookieName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=)`
  );
  const results: Result[] = [];
  const reached = new Set<string>();
  const exclusions = options.exclusions ?? [];
  for (const exclusion of exclusions) {
    if (
      !exclusion.reason.trim() ||
      !options.routes.some((route) => key(route) === key(exclusion))
    )
      throw new Error(`Invalid exclusion: ${key(exclusion)}`);
  }
  for (const journey of options.journeys) {
    if (journey.skipped) continue;
    let cookie = '';
    const savedCookies: Record<string, string> = {};
    const ids: Record<string, number | string> = {};
    for (const step of journey.steps) {
      let path = step.path;
      let actual = 0;
      let pass = false;
      let failure: Result['failure'];
      let message: string | undefined;
      let stage = 'Preparing request';
      const controller = new AbortController();
      let response: Response | undefined;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cancelBody = () => {
        // Cleanup must not itself hang after the deadline. Both cancellation
        // paths observe rejection, including a late handler response.
        if (reader) {
          const activeReader = reader;
          void activeReader
            .cancel()
            .catch(() => {})
            .finally(() => {
              try {
                activeReader.releaseLock();
              } catch {
                /* A pending read owns the lock until cancellation completes. */
              }
            });
        } else if (response?.body && !response.bodyUsed)
          void response.body.cancel().catch(() => {});
      };
      try {
        const work = (async () => {
          await step.prepare?.();
          if (controller.signal.aborted)
            throw new Error('Request deadline elapsed');
          path = step.path.replace(/\{(\w+)\}/g, (_, name: string) => {
            if (!ids[name]) throw new Error(`Missing captured id: ${name}`);
            return String(ids[name]);
          });
          const headers = new Headers(step.headers);
          if (step.useSavedCookie) {
            const saved = savedCookies[step.useSavedCookie];
            if (!saved) throw new Error('Saved session cookie is unavailable');
            headers.set('cookie', saved);
          } else if (cookie && !headers.has('cookie'))
            headers.set('cookie', cookie);
          if (step.saveCookieAs) {
            const outgoingCookie = headers.get('cookie');
            if (!outgoingCookie) throw new Error('No session cookie to save');
            savedCookies[step.saveCookieAs] = outgoingCookie;
          }
          if (step.body !== undefined)
            headers.set('content-type', 'application/json');
          stage = 'Sending request';
          response = await options.handler(
            new Request(`http://qa.invalid${path}`, {
              method: step.method,
              headers,
              signal: controller.signal,
              body:
                (step.rawBody instanceof Uint8Array
                  ? Uint8Array.from(step.rawBody).buffer
                  : step.rawBody) ??
                (step.body === undefined
                  ? undefined
                  : JSON.stringify(step.body)),
            })
          );
          if (controller.signal.aborted) {
            cancelBody();
            throw new Error('Request deadline elapsed');
          }
          actual = response.status;
          const setCookies = response.headers.getSetCookie();
          const sessionCookies = setCookies
            .flatMap((value) => value.split(sessionCookieSplit))
            .map((value) => value.trim().split(';')[0])
            .filter((value) => value.startsWith(sessionCookiePrefix))
            .sort((a, b) => b.length - a.length);
          // A Set-Cookie that empties the session cookie (logout/revoke
          // clearing, e.g. `ts_session=`) clears the tracked cookie — an
          // empty value must never be adopted as the current session.
          if (sessionCookies[0])
            cookie =
              sessionCookies[0] === sessionCookiePrefix
                ? ''
                : sessionCookies[0];
          pass = actual === step.expected;
          if (!pass) failure = 'status-mismatch';
          if (step.check || step.captureId) {
            stage = 'Reading response JSON';
            // Retain ownership of the reader so timeout can cancel a hanging body.
            reader = response.body?.getReader();
            const decoder = new TextDecoder();
            let text = '';
            if (reader) {
              while (true) {
                const part = await reader.read();
                if (controller.signal.aborted)
                  throw new Error('Request deadline elapsed');
                if (part.done) break;
                text += decoder.decode(part.value, { stream: true });
              }
              text += decoder.decode();
              reader.releaseLock();
              reader = undefined;
            }
            const body: unknown = JSON.parse(text);
            if (step.check && !step.check(body)) {
              pass = false;
              failure ??= 'body-mismatch';
            }
            if (step.captureId) {
              const data = (body as { data?: { id?: unknown } })?.data;
              if (
                pass &&
                ((typeof data?.id === 'number' &&
                  Number.isSafeInteger(data.id) &&
                  data.id > 0) ||
                  (typeof data?.id === 'string' &&
                    /^[a-zA-Z0-9-]+$/.test(data.id)))
              )
                ids[step.captureId] = data.id;
              else {
                pass = false;
                failure ??= 'missing-created-id';
              }
            }
          }
          if (!step.check && !step.captureId) {
            stage = 'Closing response body';
            await response.body?.cancel();
          }
          if (controller.signal.aborted)
            throw new Error('Request deadline elapsed');
          const candidates = options.routes.filter(
            (route) =>
              route.method.toUpperCase() === step.method.toUpperCase() &&
              matches(route.path, path)
          );
          candidates.sort(
            (a, b) =>
              a.path.split('/').filter((p) => p.startsWith(':')).length -
              b.path.split('/').filter((p) => p.startsWith(':')).length
          );
          if (candidates[0]) reached.add(key(candidates[0]));
          else {
            pass = false;
            failure = 'unmatched-route';
            message = 'No registered endpoint matches this request';
          }
        })();
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
            cancelBody();
            reject(new Error('Request deadline elapsed'));
          }, timeoutMs);
        });
        await Promise.race([work, deadline]);
      } catch {
        pass = false;
        if (timedOut) {
          failure = 'request-timeout';
          message = `${stage} exceeded request timeout`;
        } else {
          failure ??= 'request-failed';
          message = `${stage} failed`;
        }
      } finally {
        if (timer) clearTimeout(timer);
        cancelBody();
      }
      results.push({
        persona: journey.persona,
        step: step.name,
        method: step.method,
        path,
        expected: step.expected,
        actual,
        pass,
        ...(failure ? { failure } : {}),
        ...(message ? { message } : {}),
      });
    }
  }
  const uncovered = options.routes.filter(
    (route) =>
      !reached.has(key(route)) &&
      !exclusions.some((exclusion) => key(exclusion) === key(route))
  );
  return {
    results,
    uncovered,
    exclusions,
    skipped: options.journeys
      .filter((journey) => journey.skipped)
      .map((journey) => ({
        persona: journey.persona,
        reason: journey.skipped,
      })),
    coverage: {
      total: options.routes.length,
      reached: reached.size,
      excluded: exclusions.length,
    },
    pass:
      options.routes.length > 0 &&
      results.length > 0 &&
      results.every((result) => result.pass) &&
      uncovered.length === 0,
  };
}
