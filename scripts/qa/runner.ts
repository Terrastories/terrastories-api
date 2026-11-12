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
    | 'request-failed';
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
}) {
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
    const ids: Record<string, number | string> = {};
    for (const step of journey.steps) {
      let path = step.path;
      let actual = 0;
      let pass = false;
      let failure: Result['failure'];
      try {
        await step.prepare?.();
        path = step.path.replace(/\{(\w+)\}/g, (_, name: string) => {
          if (!ids[name]) throw new Error(`Missing captured id: ${name}`);
          return String(ids[name]);
        });
        const headers = new Headers(step.headers);
        if (cookie && !headers.has('cookie')) headers.set('cookie', cookie);
        if (step.body !== undefined)
          headers.set('content-type', 'application/json');
        const response = await options.handler(
          new Request(`http://qa.invalid${path}`, {
            method: step.method,
            headers,
            body:
              (step.rawBody instanceof Uint8Array
                ? Uint8Array.from(step.rawBody).buffer
                : step.rawBody) ??
              (step.body === undefined ? undefined : JSON.stringify(step.body)),
          })
        );
        actual = response.status;
        const setCookies = response.headers.getSetCookie();
        const sessionCookies = setCookies
          .flatMap((value) => value.split(/,(?=\s*sessionId=)/))
          .map((value) => value.trim().split(';')[0])
          .filter((value) => value.startsWith('sessionId='))
          .sort((a, b) => b.length - a.length);
        if (sessionCookies[0]) cookie = sessionCookies[0];
        pass = actual === step.expected;
        if (!pass) failure = 'status-mismatch';
        if (step.check || step.captureId) {
          const body: unknown = await response.json();
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
      } catch {
        pass = false;
        failure ??= 'request-failed';
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
      results.length > 0 &&
      results.every((result) => result.pass) &&
      uncovered.length === 0,
  };
}
