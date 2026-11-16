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

/**
 * Whether stored Argon2id parameters are merely *well formed*, independent
 * of policy: positive integers in the expected units. The read path
 * (prelogin) accepts them for existing rows — a future policy raise must not
 * turn today's below-policy rows into fakes and lock them out. New verifier
 * writes still require `argon2idParamsSatisfyPolicy`.
 */
export function isWellFormedArgon2idParams(params: unknown): boolean {
  if (typeof params !== 'object' || params === null) return false;
  const { memoryKiB, iterations, parallelism } = params as Record<
    string,
    unknown
  >;
  return (
    typeof memoryKiB === 'number' &&
    Number.isInteger(memoryKiB) &&
    memoryKiB >= 1 &&
    typeof iterations === 'number' &&
    Number.isInteger(iterations) &&
    iterations >= 1 &&
    typeof parallelism === 'number' &&
    Number.isInteger(parallelism) &&
    parallelism >= 1
  );
}

/**
 * The one Argon2id parameter set every new verifier V2 writes must use: the
 * named policy constants, exactly. A real row and a prelogin fake therefore
 * share one params shape, so the response is not an existence oracle
 * (SPEC-V2 §7 step 1); anything else is refused without revealing the policy.
 */
export function isCanonicalArgon2idParams(
  params: unknown
): params is Argon2idParams {
  if (!argon2idParamsSatisfyPolicy(params)) return false;
  const { memoryKiB, iterations, parallelism } = params as Argon2idParams;
  return (
    memoryKiB === ARGON2ID_PARAMS.memoryKiB &&
    iterations === ARGON2ID_PARAMS.iterations &&
    parallelism === ARGON2ID_PARAMS.parallelism
  );
}

/** Rails bcrypt cost bounds (§7 step 4: cost 10 and 12 both occur). */
export const BCRYPT_MIN_COST = 10;
export const BCRYPT_MAX_COST = 14;
/**
 * The bcrypt costs real Rails rows carry (§7 step 4: cost 10 and 12 both
 * occur). Prelogin fakes draw from this set only, so a fake bcrypt answer
 * cannot be told apart from a migrated row by its cost.
 */
export const BCRYPT_RAILS_COSTS = [10, 12] as const;

/** A 22-character bcrypt salt string (the shape a Rails row carries). */
export const BCRYPT_SALT_PATTERN = /^[./A-Za-z0-9]{22}$/;

/**
 * A client-generated verifier salt must be base64 and decode to 16..64 bytes
 * (SPEC-V2 §7 step 2).
 */
export function isUsableVerifierSalt(salt: string): boolean {
  if (!SALT_BASE64_PATTERN.test(salt)) return false;
  const bytes = verifierSaltBytes(salt);
  return bytes >= MIN_SALT_BYTES && bytes <= MAX_SALT_BYTES;
}

/**
 * Decoded byte length of a base64 salt, without atob's leniency: the caller
 * has already checked the alphabet.
 */
export function verifierSaltBytes(salt: string): number {
  const padding = salt.endsWith('==') ? 2 : salt.endsWith('=') ? 1 : 0;
  return Math.floor((salt.length * 3) / 4) - padding;
}

/**
 * The one salt length every verifier V2 writes — upgrade or password change —
 * must use (16 bytes). Canonicalising at write time keeps a real Argon2id row
 * and a prelogin fake byte-shape identical, so the response is not an
 * existence oracle (SPEC-V2 §7 step 1).
 */
export function isCanonicalVerifierSalt(salt: string): boolean {
  return (
    SALT_BASE64_PATTERN.test(salt) && verifierSaltBytes(salt) === MIN_SALT_BYTES
  );
}

/** The canonical bcrypt salt shape a migrated row and a fake share. */
export function isCanonicalBcryptSalt(salt: string): boolean {
  return BCRYPT_SALT_PATTERN.test(salt);
}

/** Cost bounds of a bcrypt verifier as stored by Rails, not of policy writes. */
export const BCRYPT_STORED_MIN_COST = 4;

/**
 * Whether a bcrypt cost is one a stored Rails row can carry. Existing rows
 * may hold any cost from 4 to 14; new writes never use them (only the
 * migrated-account read path and the prelogin fake must tolerate them).
 */
export function isStoredBcryptCost(cost: number): boolean {
  return (
    Number.isInteger(cost) &&
    cost >= BCRYPT_STORED_MIN_COST &&
    cost <= BCRYPT_MAX_COST
  );
}

/** Whether a bcrypt cost is one a migrated Rails row typically carries. */
export function isCanonicalBcryptCost(cost: number): boolean {
  return (BCRYPT_RAILS_COSTS as readonly number[]).includes(cost);
}

/** A client-derived key is a lowercase SHA-256 digest in hex. */
export const DERIVED_KEY_PATTERN = /^[a-f0-9]{64}$/;

/**
 * A wrapped Rails-bcrypt hash string, the other wire form a client sends as
 * `derivedKey` (SPEC-V2 §7 step 4: "sends the hash string as `derivedKey`").
 * `$2a$`/`$2b$`/`$2y$` are the prefixes Rails and bcrypt-ruby emit, and
 * 04..14 are the bcrypt cost bounds.
 */
export const BCRYPT_HASH_PATTERN =
  /^\$2[aby]\$(0[4-9]|1[0-4])\$[./A-Za-z0-9]{53}$/;

/**
 * The wire shape of a client-derived key: a 64-hex Argon2id digest or a
 * wrapped Rails-bcrypt hash string. Which one applies is decided by the
 * stored account, never by the wire shape, so a bcrypt-shaped key sent to an
 * Argon2id account (or a digest sent to a wrapped account) is an ordinary
 * uniform 401 — never a 400 that would reveal the account's algorithm.
 */
export function isDerivedKeyOrBcryptHash(value: string): boolean {
  return DERIVED_KEY_PATTERN.test(value) || BCRYPT_HASH_PATTERN.test(value);
}

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
 * The `ts_session` cookie lifetime in seconds.
 *
 * `standard` sessions carry the 12-hour idle window. A `device` session
 * carries its *remaining absolute lifetime* — the 60-day absolute window at
 * creation, shrinking on renewal — so the cookie never outlives the row that
 * enforces it and a browser restart cannot silently shorten the opt-in
 * (§7 "Sessions", finding 6/F).
 */
export function sessionCookieMaxAge(
  kind: SessionKind,
  absoluteExpiresAt?: number,
  now?: number
): number {
  if (kind === 'device') {
    if (absoluteExpiresAt !== undefined && now !== undefined)
      return Math.max(0, Math.floor((absoluteExpiresAt - now) / 1000));
    return DEVICE_SESSION_ABSOLUTE_MS / 1000;
  }
  return STANDARD_SESSION_IDLE_MS / 1000;
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

/** The per-IP bucket for a request with no usable client IP. */
export const AUTH_UNKNOWN_CLIENT_IP = 'unknown';

/** How the app learned the request's origin, so only real signals are trusted. */
export interface ClientIpOptions {
  /** Cloudflare Workers: `cf-connecting-ip` is set by the platform. */
  isWorkers?: boolean;
  /** A trusted reverse proxy is configured, so `x-forwarded-for` is usable. */
  trustProxy?: boolean;
  /**
   * Explicit name of the header the trusted proxy overwrites with the client
   * address (`TRUSTED_PROXY_HEADER=x-real-ip`). Only that single header is
   * honoured, and only when the operator names it — a header a client can
   * set themselves (or a mixed chain that passes it through) must never win
   * over the proxy-appended `x-forwarded-for` entry by default.
   */
  trustedProxyHeader?: 'x-real-ip' | undefined;
  /** The transport's observed peer address (Node socket), when available. */
  remoteAddress?: string | null;
}

function isValidIpv4(value: string): boolean {
  const parts = value.split('.');
  if (parts.length !== 4) return false;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return false;
    if (Number(part) > 255) return false;
  }
  return true;
}

function isValidIpv6(value: string): boolean {
  // Zones (fe80::1%eth0) carry a device the throttle must not key on.
  if (value.includes('%') || !value.includes(':')) return false;
  let tailLength = 0;
  if (value.includes('.')) {
    const embedded = value.slice(value.lastIndexOf(':') + 1);
    if (!isValidIpv4(embedded)) return false;
    tailLength = 2; // the embedded IPv4 counts as the final two 16-bit groups
    value = value.slice(0, value.lastIndexOf(':'));
  }
  const sides = value.split('::');
  if (sides.length > 2) return false;
  const groupsOf = (side: string): string[] =>
    side === '' ? [] : side.split(':');
  const left = groupsOf(sides[0]!);
  const right = sides.length === 2 ? groupsOf(sides[1]!) : [];
  for (const group of [...left, ...right])
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return false;
  if (sides.length === 2) return left.length + right.length + tailLength <= 8;
  return left.length === 8 - tailLength;
}

/**
 * Parse a syntactically valid IPv6 address into its eight 16-bit groups.
 * Accepts `::` compression, an embedded IPv4 tail and case-insensitive hex;
 * rejects zones and anything `usableIp` would not accept. Returns `null`
 * for an invalid address.
 */
function parseIpv6Groups(value: string): number[] | null {
  let input = value.toLowerCase();
  // Embedded IPv4 (::ffff:192.0.2.1, ::1.2.3.4): rewrite the dotted tail to
  // its two hex groups, keeping the preceding separator colon in place, then
  // parse as a pure hex address.
  if (input.includes('.')) {
    const lastColon = input.lastIndexOf(':');
    const embedded = input.slice(lastColon + 1);
    if (!isValidIpv4(embedded)) return null;
    const parts = embedded.split('.').map((part) => Number(part));
    const hi = (((parts[0] ?? 0) << 8) | (parts[1] ?? 0)).toString(16);
    const lo = (((parts[2] ?? 0) << 8) | (parts[3] ?? 0)).toString(16);
    input = `${input.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const sides = input.split('::');
  if (sides.length > 2) return null;
  const parseSide = (side: string): number[] | null => {
    if (side === '') return [];
    const groups: number[] = [];
    for (const group of side.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      groups.push(parseInt(group, 16));
    }
    return groups;
  };
  const left = parseSide(sides[0]!);
  const right = sides.length === 2 ? parseSide(sides[1]!) : [];
  if (left === null || right === null) return null;
  if (sides.length === 2) {
    const rightGroups = right ?? [];
    const missing = 8 - left.length - rightGroups.length;
    if (missing < 1) return null;
    return [
      ...left,
      ...Array.from({ length: missing }, () => 0),
      ...rightGroups,
    ];
  }
  if (left.length !== 8) return null;
  return left;
}

/**
 * The bucket the per-IP throttle keys on. IPv4 is keyed verbatim — the same
 * address always maps to the same bucket. IPv6 is keyed on its /64 prefix
 * with the low 64 bits zeroed: a /64 is the subscriber allocation span an
 * attacker controls, and rotating addresses inside it must not mint fresh
 * throttle buckets (§6.8). Non-IPv6 strings (the `unknown` bucket, or an
 * address that fails parsing) pass through unchanged.
 */
export function ipThrottleBucket(clientIp: string): string {
  if (!clientIp.includes(':')) return clientIp;
  const groups = parseIpv6Groups(clientIp);
  if (groups === null || groups.length !== 8) return clientIp;
  return `${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(':')}::/64`;
}

function usableIp(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > AUTH_CLIENT_IP_MAX_LENGTH) return null;
  if (trimmed.includes(':')) return isValidIpv6(trimmed) ? trimmed : null;
  if (trimmed.includes('.')) return isValidIpv4(trimmed) ? trimmed : null;
  return null;
}

/**
 * The client IP for the per-IP throttle counter (§6.8: a keyed hash of the
 * client IP alone).
 *
 * Trust is explicit (finding E): `cf-connecting-ip` is honoured only on
 * Workers, where the platform sets it and a client cannot forge it; the
 * rightmost entry of `x-forwarded-for` — the only entry the trusted proxy
 * itself appended (a leftmost entry is caller-controlled under any proxy that
 * passes mixed chains) — is the only throttle key a trusted proxy vouches
 * for. `x-real-ip` is honoured only when the operator explicitly names it as
 * the proxy's client-address header (`trustedProxyHeader: 'x-real-ip'`;
 * `TRUSTED_PROXY_HEADER=x-real-ip`), and otherwise ignored entirely: a proxy
 * that merely passes a caller-set `X-Real-IP` through must not hand the
 * caller its own per-IP bucket. Only syntactically valid IPv4/IPv6 addresses
 * are used as keys, whichever source they come from; anything else falls
 * back to the socket peer, and failing that becomes the `unknown` bucket, so
 * a request without a usable address still feeds exactly one per-IP counter.
 */
export function clientIpOf(
  headers: Headers,
  options: ClientIpOptions = {}
): string {
  if (options.isWorkers === true) {
    const fromCf = usableIp(headers.get('cf-connecting-ip'));
    if (fromCf !== null) return fromCf;
  }
  if (options.trustProxy === true) {
    // The proxy appends the peer address to the END of the chain — the
    // rightmost entry is the only one the trusted proxy vouches for. Taking
    // the leftmost instead would let every caller steer its own per-IP
    // bucket. X-Real-IP is consulted only when the operator explicitly names
    // it as the proxy's client-address header; left at the default it is
    // caller-controlled and never wins.
    if (options.trustedProxyHeader === 'x-real-ip') {
      const real = usableIp(headers.get('x-real-ip'));
      if (real !== null) return real;
    }
    const raw = headers.get('x-forwarded-for');
    if (raw !== null) {
      const last = raw.split(',').pop();
      const value = usableIp(last);
      if (value !== null) return value;
    }
  }
  const peer = usableIp(options.remoteAddress);
  if (peer !== null) return peer;
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

/**
 * How long a computed prelogin population mix (upgraded/total and the
 * observed bcrypt costs) may be reused. The mix changes slowly while requests
 * do not, so a short TTL keeps prelogin off a full `users` scan per request
 * without making a fresh account invisible for long (finding C).
 */
export const AUTH_PRELOGIN_MIX_TTL_MS = 60 * 1000;

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
