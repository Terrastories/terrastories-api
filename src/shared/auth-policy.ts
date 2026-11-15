/**
 * Client-stretching authentication constants and wire shapes (SPEC-V2 §6.2,
 * §6.8, §7 "Passwords").
 *
 * The browser stretches the password; the server only hashes and compares
 * (no profile runs a password KDF on the server, #194). This module is the
 * single source for the algorithm names, the Argon2id policy, the session
 * lifetime split and the `AuthThrottle` window/backoff constants. It is pure
 * (no Node, no database) so it bundles for workerd unchanged.
 */

/** New verifiers use Argon2id in WebAssembly with these parameters (§7). */
export const ARGON2ID_PARAMS = Object.freeze({
  memoryKiB: 19 * 1024,
  iterations: 2,
  parallelism: 1,
});

export const ARGON2ID_ALGORITHM = 'client-argon2id+sha256';
export const RAILS_BCRYPT_ALGORITHM = 'client-bcrypt-rails+sha256';
export const PASSWORD_ALGORITHMS = [
  ARGON2ID_ALGORITHM,
  RAILS_BCRYPT_ALGORITHM,
] as const;
export type PasswordAlgorithm = (typeof PASSWORD_ALGORITHMS)[number];

/** Stored `passwordParams` serialization (JSON, so both backends agree). */
export interface Argon2idParams {
  memoryKiB: number;
  iterations: number;
  parallelism: number;
}

export const ARGON2ID_PARAMS_JSON: string = JSON.stringify(ARGON2ID_PARAMS);

/** Below-policy parameters are rejected on upgrade and password change. */
export function argon2idParamsSatisfyPolicy(params: unknown): boolean {
  if (typeof params !== 'object' || params === null) return false;
  const { memoryKiB, iterations, parallelism } = params as Record<
    string,
    unknown
  >;
  return (
    typeof memoryKiB === 'number' &&
    Number.isInteger(memoryKiB) &&
    memoryKiB >= ARGON2ID_PARAMS.memoryKiB &&
    typeof iterations === 'number' &&
    Number.isInteger(iterations) &&
    iterations >= ARGON2ID_PARAMS.iterations &&
    typeof parallelism === 'number' &&
    Number.isInteger(parallelism) &&
    parallelism >= ARGON2ID_PARAMS.parallelism
  );
}

/** Rails bcrypt cost bounds (§7 step 4: cost 10 and 12 both occur). */
export const BCRYPT_MIN_COST = 10;
export const BCRYPT_MAX_COST = 14;

/** A client-derived key is a lowercase SHA-256 digest in hex. */
export const DERIVED_KEY_PATTERN = /^[a-f0-9]{64}$/;

/** Salt: at least 128 bits, stored as base64 (§7 step 2). */
export const MIN_SALT_BYTES = 16;
export const MAX_SALT_BYTES = 64;
export const SALT_BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

// ---------------------------------------------------------------------------
// Sessions (§7 "Sessions")
// ---------------------------------------------------------------------------

/** Default `standard` session idle timeout. */
export const STANDARD_SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
/** `device` ("remember this device") idle timeout. */
export const DEVICE_SESSION_IDLE_MS = 60 * 24 * 60 * 60 * 1000;
/** A device session may never outlive this absolute window. */
export const DEVICE_SESSION_ABSOLUTE_MS = 60 * 24 * 60 * 60 * 1000;
/**
 * `last_seen_at` is persisted at most once per minute per session, so a
 * busy session does not spend one D1 row write per request (§7 write budget).
 */
export const SESSION_LAST_SEEN_WRITE_INTERVAL_MS = 60 * 1000;
/** Scheduled sweep of expired session rows. */
export const SESSION_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export type SessionKind = 'standard' | 'device';

export interface SessionLifetimes {
  kind: SessionKind;
  idleExpiresAt: number;
  absoluteExpiresAt: number;
}

export function sessionLifetimesFor(
  kind: SessionKind,
  now: number
): SessionLifetimes {
  const idleMs =
    kind === 'device' ? DEVICE_SESSION_IDLE_MS : STANDARD_SESSION_IDLE_MS;
  return {
    kind,
    idleExpiresAt: now + idleMs,
    absoluteExpiresAt: now + DEVICE_SESSION_ABSOLUTE_MS,
  };
}

/** The idle window of a session kind, used to place the renewal threshold. */
export function sessionIdleWindowMs(kind: SessionKind): number {
  return kind === 'device' ? DEVICE_SESSION_IDLE_MS : STANDARD_SESSION_IDLE_MS;
}

/**
 * The `ts_session` cookie lifetime. `null` means a browser-session cookie:
 * a `device` session may outlive any fixed `Max-Age`, and its absolute bound
 * is enforced by the session row (§7 "Sessions").
 */
export function sessionCookieMaxAge(kind: SessionKind): number | null {
  return kind === 'device' ? null : STANDARD_SESSION_IDLE_MS / 1000;
}

/** Digest of a presented session token, or `null` when it is not one. */
export function sessionTokenDigestInput(
  token: string | undefined
): string | null {
  if (token === undefined || !/^[a-f0-9]{64}$/.test(token)) return null;
  return token;
}

/** A client IP is an opaque line: long enough for any proxy header value. */
export const AUTH_CLIENT_IP_MAX_LENGTH = 64;

/** Header names that may carry the client IP, in priority order. */
export const AUTH_CLIENT_IP_HEADERS = [
  'cf-connecting-ip',
  'x-forwarded-for',
  'x-real-ip',
] as const;

/** The per-IP bucket for a request with no usable client IP header. */
export const AUTH_UNKNOWN_CLIENT_IP = 'unknown';

/**
 * The client IP for the per-IP throttle counter (§6.8: a keyed hash of the
 * client IP alone). `cf-connecting-ip` wins because Cloudflare sets it and a
 * client cannot forge it; a proxy chain's first hop is the original client.
 * An absent or oversized value becomes the `unknown` bucket, so a request
 * without a usable IP still feeds exactly one per-IP counter.
 */
export function clientIpOf(headers: Headers): string {
  for (const name of AUTH_CLIENT_IP_HEADERS) {
    const raw = headers.get(name);
    if (raw === null || raw.trim() === '') continue;
    const first = name === 'x-forwarded-for' ? raw.split(',')[0] : raw;
    const value = first?.trim() ?? '';
    if (value === '' || value.length > AUTH_CLIENT_IP_MAX_LENGTH)
      return AUTH_UNKNOWN_CLIENT_IP;
    return value;
  }
  return AUTH_UNKNOWN_CLIENT_IP;
}

/**
 * The uniform login failure (§6.2, §7 step 6): identical status and body for
 * every rejected attempt — unknown slug, unknown identifier, ambiguous email,
 * wrong key and throttled — so no response variation reveals which check
 * failed. Login raises it; the route answers one `401` body.
 */
export class AuthLoginRejected extends Error {
  constructor() {
    super('Invalid credentials');
    this.name = 'AuthLoginRejected';
  }
}

/** The one body every rejected login returns (§6.2). */
export const AUTH_LOGIN_FAILURE_BODY = Object.freeze({
  error: 'Invalid credentials',
});

// ---------------------------------------------------------------------------
// AuthThrottle (§6.8, §6.10)
// ---------------------------------------------------------------------------

/**
 * Failure budget inside one window. The 10th failure in a 15-minute window
 * blocks; the window is measured in failures (not a token bucket) so the
 * counters stay two integer columns.
 */
export const AUTH_THROTTLE_MAX_FAILURES = 10;
/** Sliding failure-count window. */
export const AUTH_THROTTLE_WINDOW_MS = 15 * 60 * 1000;
/** Backoff doubling floor: 2^(failures - max) minutes, capped. */
export const AUTH_THROTTLE_BACKOFF_BASE_MS = 60 * 1000;
export const AUTH_THROTTLE_BACKOFF_MAX_MS = 60 * 60 * 1000;
/** Keys are keyed hashes; the input prefix keeps kinds from colliding. */
export const AUTH_THROTTLE_KEY_ACCOUNT = 'account:';
export const AUTH_THROTTLE_KEY_IP = 'ip:';

export function authThrottleBackoffMs(failures: number): number {
  const exponent = Math.max(
    0,
    Math.min(
      6,
      failures - AUTH_THROTTLE_MAX_FAILURES + 1 // 1 min … 60 min cap
    )
  );
  return Math.min(
    AUTH_THROTTLE_BACKOFF_MAX_MS,
    AUTH_THROTTLE_BACKOFF_BASE_MS * 2 ** exponent
  );
}
