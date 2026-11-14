/**
 * Production configuration governance for the V2 runtime entrypoints (#150).
 *
 * One shared validator runs at Node startup in `src/hono-server.ts`
 * (`validateNodeV2Runtime`) and at first request per binding set in
 * `src/worker.ts` (`validateWorkerV2Runtime`). It fails closed: in
 * production-like modes a missing, placeholder or unsafe critical value
 * refuses startup/serving, and every message names the setting — never its
 * value (SPEC-V2 Section 7). Development and test modes still start; the
 * plain-HTTP trusted-LAN exception stays an explicit field-kit opt-in
 * (SPEC-V2 Section 7, "Field-kit HTTPS and the plain-HTTP exception").
 *
 * This module must stay importable from the workerd browser bundle: no Node
 * APIs. It validates configuration only — authorization, adapters and the
 * database are not its concern.
 */

/** Modes that enforce the production rules; unset resolves to `production`. */
export type V2RuntimeEnvironment =
  | 'development'
  | 'test'
  | 'production'
  | 'field-kit'
  | 'offline';

const KNOWN_ENVIRONMENTS: readonly V2RuntimeEnvironment[] = [
  'development',
  'test',
  'production',
  'field-kit',
  'offline',
];

/** Throw of this type means: refuse to start (Node) / refuse to serve (Workers). */
export class V2RuntimeConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`V2 runtime configuration check failed: ${problems.join('; ')}`);
    this.name = 'V2RuntimeConfigError';
  }
}

/** Marker substrings that never occur in a real value (case-insensitive). */
const PLACEHOLDER_SUBSTRINGS: readonly string[] = [
  'change-me',
  'change_me',
  'changeme',
  'replace-with',
  'replace_with',
  'replacewith',
  '00000000-',
  'placeholder',
];

/** Marker prefixes of shipped template values (case-insensitive). */
const PLACEHOLDER_PREFIX = /^(your[-_]|replace|change[-_]?me)/i;

/** Documentation-only hostnames and suffixes, invalid in every mode. */
const PLACEHOLDER_HOSTNAMES: readonly string[] = [
  'example.org',
  'example.com',
  'example.net',
  'example',
];
const PLACEHOLDER_HOST_SUFFIXES: readonly string[] = [
  '.example.org',
  '.example.com',
  '.example.net',
  '.example',
  '.invalid',
  '.test',
  '.localhost',
];

/** Loopback hosts: legitimate for development, never a production origin. */
const LOOPBACK_HOSTNAMES: readonly string[] = [
  'localhost',
  '127.0.0.1',
  '[::1]',
];

/**
 * Unspecified bind-any hosts (`0.0.0.0`, `[::]`): valid bind addresses,
 * never a deployment origin — accepting one would silently break cookie
 * and CORS scoping instead of failing closed.
 */
const UNSPECIFIED_HOSTNAMES: readonly string[] = ['0.0.0.0', '[::]'];

/**
 * Canonical IPv4-mapped IPv6 loopback (127/8) hostnames. The WHATWG URL
 * parser serializes `http://[::ffff:127.0.0.1]` as the hex-piece form
 * `[::ffff:7f00:1]` — never dotted quad — so only hex forms can reach this
 * check through `URL.hostname` (PR #229 review).
 */
const IPV4_MAPPED_LOOPBACK = /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/;

function isPlaceholderValue(value: string): boolean {
  const lowered = value.toLowerCase();
  return (
    PLACEHOLDER_PREFIX.test(lowered) ||
    PLACEHOLDER_SUBSTRINGS.some((marker) => lowered.includes(marker))
  );
}

/** Lowercase and drop a trailing root dot, so `example.com.` matches. */
function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, '');
}

function isDocumentationHostname(raw: string): boolean {
  const hostname = normalizeHostname(raw);
  return (
    PLACEHOLDER_HOSTNAMES.includes(hostname) ||
    PLACEHOLDER_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix)) ||
    /^(your[-_]|replace|change[-_]?me)/.test(hostname)
  );
}

function isLoopbackHostname(raw: string): boolean {
  const hostname = normalizeHostname(raw);
  return (
    LOOPBACK_HOSTNAMES.includes(hostname) ||
    hostname.endsWith('.localhost') ||
    /^127(\.\d{1,3}){3}$/.test(hostname) ||
    hostname === '[0:0:0:0:0:0:0:1]' ||
    IPV4_MAPPED_LOOPBACK.test(hostname)
  );
}

/** The validated configuration the entrypoints build their app options from. */
export interface V2RuntimeConfig {
  environment: V2RuntimeEnvironment;
  /** `production`, `field-kit` and `offline` enforce the production rules. */
  productionLike: boolean;
  /** Plain-HTTP origins are refused while this is true. */
  httpsRequired: boolean;
  publicOrigin?: string;
  corsOrigins: string[];
  secureCookies: boolean;
}

/** Setting names differ per platform; messages always use the caller's name. */
export interface V2RuntimeSettingNames {
  environment: string;
  publicOrigin: string;
  corsOrigins: string;
  secureCookies: string;
}

export interface V2RuntimeCoreInput {
  environment?: string | undefined;
  publicOrigin?: string | undefined;
  corsOrigins?: readonly string[] | undefined;
  secureCookies?: boolean | undefined;
  /** The explicit field-kit plain-HTTP opt-in (never available on Workers). */
  allowPlainHttp?: boolean | undefined;
  names: V2RuntimeSettingNames;
}

export function validateV2RuntimeCore(
  input: V2RuntimeCoreInput
): V2RuntimeConfig {
  const problems: string[] = [];
  const { names } = input;
  const rawEnvironment = input.environment;
  let environment: V2RuntimeEnvironment = 'production';
  if (rawEnvironment !== undefined && rawEnvironment !== '') {
    if (KNOWN_ENVIRONMENTS.includes(rawEnvironment as V2RuntimeEnvironment)) {
      environment = rawEnvironment as V2RuntimeEnvironment;
    } else {
      problems.push(
        `${names.environment} must be one of ${KNOWN_ENVIRONMENTS.join(', ')} (or unset for production)`
      );
      // Unknown values resolve to the strictest mode so every other problem
      // surfaces in the same refusal.
    }
  }
  const productionLike = !['development', 'test'].includes(environment);
  const httpsRequired =
    environment === 'production' ||
    ((environment === 'field-kit' || environment === 'offline') &&
      input.allowPlainHttp !== true);

  /**
   * Validate one origin. Returns the parsed URL when the value is clean, so
   * callers can layer further rules on the same parse — or `null` once a
   * problem has been recorded for the value.
   */
  const checkOrigin = (value: string, name: string): URL | null => {
    if (value.includes('*')) {
      problems.push(
        `${name} must not use a wildcard origin; credentialed CORS requires an exact origin allowlist`
      );
      return null;
    }
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      problems.push(
        `${name} must be an absolute origin (scheme://host[:port])`
      );
      return null;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      problems.push(`${name} must use the https or http scheme`);
      return null;
    }
    // Placeholder detection runs before the exact-origin comparison so a
    // template value is named as such, not as a path/query mismatch.
    if (isPlaceholderValue(value) || isDocumentationHostname(parsed.hostname)) {
      problems.push(`${name} must not keep a template placeholder value`);
      return null;
    }
    if (parsed.origin !== value) {
      problems.push(`${name} must be an origin without a path or query`);
      return null;
    }
    if (
      productionLike &&
      (isLoopbackHostname(parsed.hostname) ||
        UNSPECIFIED_HOSTNAMES.includes(parsed.hostname))
    ) {
      problems.push(
        `${name} must not use a loopback or unspecified host in ${environment} mode`
      );
      return null;
    }
    if (parsed.protocol === 'http:' && httpsRequired) {
      problems.push(
        `${name} must use https in ${environment} mode; plain http is the field-kit trusted-LAN exception and requires its explicit opt-in`
      );
      return null;
    }
    return parsed;
  };

  if (input.publicOrigin !== undefined && input.publicOrigin !== '') {
    const publicOrigin = checkOrigin(input.publicOrigin, names.publicOrigin);
    // A relaxed mode may not hide behind a deployed origin: `https` on a
    // non-loopback host is a production signal, so `development`/`test`
    // refuse to serve it instead of silently disabling the gate (PR #229
    // review). Local development keeps working on loopback or plain-HTTP
    // origins, or with no origin at all.
    if (
      !productionLike &&
      publicOrigin?.protocol === 'https:' &&
      !isLoopbackHostname(publicOrigin.hostname) &&
      !UNSPECIFIED_HOSTNAMES.includes(publicOrigin.hostname)
    ) {
      problems.push(
        `${names.publicOrigin} is an https origin on a non-loopback host, which is a production deployment signal; ${names.environment} ${environment} may not relax the gate for it`
      );
    }
  } else if (productionLike) {
    problems.push(`${names.publicOrigin} is required in ${environment} mode`);
  }

  for (const origin of input.corsOrigins ?? []) {
    checkOrigin(origin, names.corsOrigins);
  }

  const secureCookies = input.secureCookies ?? true;
  if (!secureCookies && httpsRequired) {
    problems.push(
      `${names.secureCookies} must stay enabled in ${environment} mode; non-Secure cookies are a development/test setting or require the field-kit plain-HTTP opt-in`
    );
  }

  if (problems.length > 0) throw new V2RuntimeConfigError(problems);
  return {
    environment,
    productionLike,
    httpsRequired,
    publicOrigin: input.publicOrigin || undefined,
    corsOrigins: [...(input.corsOrigins ?? [])],
    secureCookies,
  };
}

function parseCorsOrigins(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

/** The origin's scheme through the gate's own URL parsing, never a raw prefix. */
function originProtocol(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined;
  try {
    return new URL(value).protocol;
  } catch {
    return undefined;
  }
}

/**
 * One-line, content-free marker for relaxed modes, logged by both
 * entrypoints so a deployment that inherits `development`/`test` is visible
 * in operator channels instead of silently serving with the gate off
 * (PR #229 review). Names the mode only — never a setting value.
 */
export function v2RuntimeModeNotice(config: {
  environment: V2RuntimeEnvironment;
  productionLike: boolean;
}): string | undefined {
  if (config.productionLike) return undefined;
  return `V2 runtime gate relaxed: mode "${config.environment}" — production origin, HTTPS and Secure-cookie enforcement disabled`;
}

/** Node V2 entrypoint environment (`src/hono-server.ts`). */
export interface NodeV2Env {
  /** Accepts `process.env` and partial test environments. */
  [key: string]: string | undefined;
  NODE_ENV?: string | undefined;
  HONO_PUBLIC_ORIGIN?: string | undefined;
  HONO_CORS_ORIGINS?: string | undefined;
  HONO_PORT?: string | undefined;
  HONO_ALLOW_PLAIN_HTTP?: string | undefined;
}

export interface NodeV2RuntimeConfig extends V2RuntimeConfig {
  port: number;
}

/**
 * Validate the Node V2 entrypoint environment. Throws `V2RuntimeConfigError`
 * (fail closed) before any adapter or database is opened. `NODE_ENV` keeps
 * its existing meaning: unset means production; only `development` and
 * `test` relax the rules.
 */
export function validateNodeV2Runtime(env: NodeV2Env): NodeV2RuntimeConfig {
  const port = Number(env.HONO_PORT ?? 3001);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new V2RuntimeConfigError([
      'HONO_PORT must be an integer between 1 and 65535',
    ]);
  }
  const config = validateV2RuntimeCore({
    environment: env.NODE_ENV,
    publicOrigin: env.HONO_PUBLIC_ORIGIN,
    corsOrigins: parseCorsOrigins(env.HONO_CORS_ORIGINS),
    // Secure cookies follow the origin: browsers drop Secure cookies over
    // plain HTTP, so the §7 field-kit trusted-LAN exception must not set it.
    // The scheme comes from the gate's own URL parsing — a raw string prefix
    // disagrees with the parser on padded values (PR #229 review).
    secureCookies:
      env.NODE_ENV !== 'development' &&
      !(
        env.HONO_ALLOW_PLAIN_HTTP === 'true' &&
        originProtocol(env.HONO_PUBLIC_ORIGIN) === 'http:'
      ),
    allowPlainHttp: env.HONO_ALLOW_PLAIN_HTTP === 'true',
    names: {
      environment: 'NODE_ENV',
      publicOrigin: 'HONO_PUBLIC_ORIGIN',
      corsOrigins: 'HONO_CORS_ORIGINS',
      secureCookies: 'secureCookies',
    },
  });
  return { ...config, port };
}

/** Worker V2 binding set (`src/worker.ts`). */
export interface WorkerV2Env {
  ENVIRONMENT?: string | undefined;
  PUBLIC_ORIGIN?: string | undefined;
  CORS_ORIGINS?: string | undefined;
  DB?: unknown;
  MEDIA?: unknown;
}

/**
 * Validate the Worker binding set. Unset `ENVIRONMENT` means production — the
 * hosted profile is always HTTPS, so the plain-HTTP opt-in does not exist
 * here. Missing service bindings are refused by name like any other setting.
 */
export function validateWorkerV2Runtime(env: WorkerV2Env): V2RuntimeConfig {
  const problems: string[] = [];
  if (env.DB === undefined) problems.push('DB D1 binding is missing');
  if (env.MEDIA === undefined) problems.push('MEDIA R2 binding is missing');
  let config: V2RuntimeConfig;
  try {
    config = validateV2RuntimeCore({
      environment: env.ENVIRONMENT,
      publicOrigin: env.PUBLIC_ORIGIN,
      corsOrigins: parseCorsOrigins(env.CORS_ORIGINS),
      secureCookies: true,
      names: {
        environment: 'ENVIRONMENT',
        publicOrigin: 'PUBLIC_ORIGIN',
        corsOrigins: 'CORS_ORIGINS',
        secureCookies: 'secureCookies',
      },
    });
  } catch (error) {
    if (!(error instanceof V2RuntimeConfigError)) throw error;
    problems.unshift(...error.problems);
    throw new V2RuntimeConfigError(problems);
  }
  if (problems.length > 0) throw new V2RuntimeConfigError(problems);
  return config;
}
