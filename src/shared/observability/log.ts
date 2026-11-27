/**
 * Privacy-safe structured logging for the V2 runtime (#143).
 *
 * One JSON object per line, produced by a single `redact` pass. The redaction
 * layer is the only way log data leaves the process: request/response bodies,
 * credentials and identifiers are never passed in by callers, and anything
 * that does reach a log line is scrubbed here.
 *
 * Node-only and Workers-only APIs are deliberately absent; `console` and the
 * standard `Date`/`JSON` globals exist in both runtimes.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export const REDACTED = '[REDACTED]';

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** Maximum depth, key count and string length retained in one log value. */
const MAX_DEPTH = 8;
const MAX_ENTRIES = 50;
const MAX_STRING_LENGTH = 2048;

/**
 * Sensitive object keys, matched after lowercasing and removing `-`, `_`, `.`
 * so `derivedKey`, `derived-key` and `derived_key` all match. Exact matches
 * (`code`, `salt`, `cookie`) are listed separately because broad substring
 * matching would redact ordinary fields (for example `statusCode`).
 */
const SENSITIVE_KEY_PARTS: readonly string[] = [
  'password',
  'passphrase',
  'secret',
  'token',
  'authorization',
  'cookie',
  'credential',
  'derivedkey',
  'signature',
  'apikey',
  'privatekey',
  'accesskey',
  'recoverycode',
  'claimtoken',
  'logincode',
  'sessionid',
];

const SENSITIVE_EXACT_KEYS = new Set([
  'code',
  'salt',
  'cookie',
  'authorization',
  'auth',
]);

/** Bearer credentials, session cookies, JWT-shaped values and signed URLs. */
const VALUE_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/(\bBearer\s+)[A-Za-z0-9._~+/=-]{4,}/gi, `$1${REDACTED}`],
  [/(\bts_session=)[^;\s,]+/gi, `$1${REDACTED}`],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTED],
  [
    /([?&](?:X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token|Signature|sig|signature|token|key|code|access_token)=)[^&\s"'<>]+/gi,
    `$1${REDACTED}`,
  ],
  // Export download tokens are 64-hex path segments with no query marker.
  [/(\/export\/download\/)[A-Za-z0-9_-]{16,}/gi, `$1${REDACTED}`],
];

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-_.\s]/g, '');
  if (SENSITIVE_EXACT_KEYS.has(normalized)) return true;
  return SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part));
}

/** Scrub credentials, cookies and signatures embedded in a string. */
export function redactString(value: string): string {
  let result = value;
  for (const [pattern, replacement] of VALUE_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result.length > MAX_STRING_LENGTH
    ? `${result.slice(0, MAX_STRING_LENGTH)}…[truncated]`
    : result;
}

function redactError(
  error: Error,
  seen: WeakSet<object>,
  depth: number
): Record<string, unknown> {
  const record: Record<string, unknown> = {
    name: redactValue(error.name, seen, depth + 1),
    message: redactValue(error.message, seen, depth + 1),
  };
  if (typeof error.stack === 'string') {
    record.stack = redactValue(error.stack, seen, depth + 1);
  }
  return record;
}

function redactValue(
  value: unknown,
  seen: WeakSet<object>,
  depth: number
): unknown {
  if (value === null || value === undefined) return value;
  switch (typeof value) {
    case 'string':
      return redactString(value);
    case 'number':
    case 'boolean':
      return value;
    case 'bigint':
      return value.toString();
    case 'function':
    case 'symbol':
      return '[unserializable]';
  }
  if (value instanceof Error) return redactError(value, seen, depth);
  if (value instanceof Date)
    return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  if (depth >= MAX_DEPTH) return '[max depth]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ENTRIES)
      .map((item) => redactValue(item, seen, depth + 1));
  }
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, MAX_ENTRIES)) {
    output[key] = isSensitiveKey(key)
      ? REDACTED
      : redactValue(item, seen, depth + 1);
  }
  return output;
}

/**
 * The single redaction function every log line passes through. Returns a
 * JSON-safe copy: sensitive keys become `[REDACTED]`, known credential shapes
 * inside strings are scrubbed, cycles/depth/entry counts are bounded, and
 * `Error` objects keep only name/message/stack (all scrubbed).
 */
export function redact(value: unknown): unknown {
  // The body is a plain object here, so the cycle tracker only needs to span
  // one call; cycles are still reported faithfully.
  const seen = new WeakSet<object>();
  return redactValue(value, seen, 0);
}

export interface LogFields {
  [key: string]: unknown;
}

export interface Logger {
  readonly level: LogLevel;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields, error?: unknown): void;
  child(bindings: LogFields): Logger;
}

export type LogSink = (line: string, level: LogLevel) => void;

export interface LoggerOptions {
  /** Minimum level emitted; default `info`. */
  level?: LogLevel;
  /** Destination; default `console.log` except `error`, which uses `console.error`. */
  sink?: LogSink;
  /** Clock override for tests. */
  now?: () => Date;
}

/** Parse `LOG_LEVEL` fail-safe: unknown values fall back to `info`. */
export function parseLogLevel(raw: string | undefined): LogLevel {
  const value = raw?.trim().toLowerCase();
  return value === 'debug' ||
    value === 'info' ||
    value === 'warn' ||
    value === 'error'
    ? value
    : 'info';
}

const defaultSink: LogSink = (line, level) => {
  // eslint-disable-next-line no-console -- structured logger; the line is redacted above
  if (level === 'error') console.error(line);
  // eslint-disable-next-line no-console -- structured logger; the line is redacted above
  else console.log(line);
};

/**
 * Create a JSON logger. Every record — message, fields, bound fields and
 * error — is passed through `redact` exactly once before serialization.
 */
export function createJsonLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const sink = options.sink ?? defaultSink;
  const now = options.now ?? (() => new Date());
  const minimum = LEVEL_WEIGHT[level];

  const emit = (
    entryLevel: LogLevel,
    message: string,
    bindings: LogFields,
    fields: LogFields | undefined,
    error: unknown,
    hasError: boolean
  ): void => {
    if (LEVEL_WEIGHT[entryLevel] < minimum) return;
    const record = redact({
      time: now().toISOString(),
      level: entryLevel,
      msg: message,
      ...bindings,
      ...(fields ?? {}),
      ...(hasError ? { error } : {}),
    });
    let line: string;
    try {
      line = JSON.stringify(record);
    } catch {
      // A caller-supplied value that survived redaction but cannot be
      // serialized must never break the request path.
      line = JSON.stringify({
        time: now().toISOString(),
        level: entryLevel,
        msg: 'log.serialization_failed',
      });
    }
    sink(line, entryLevel);
  };

  const make = (bindings: LogFields): Logger => ({
    level,
    debug: (message, fields) =>
      emit('debug', message, bindings, fields, undefined, false),
    info: (message, fields) =>
      emit('info', message, bindings, fields, undefined, false),
    warn: (message, fields) =>
      emit('warn', message, bindings, fields, undefined, false),
    error: (message, fields, error) => {
      const hasError = error !== undefined;
      emit('error', message, bindings, fields, error, hasError);
    },
    child: (extra) => make({ ...bindings, ...extra }),
  });

  return make({});
}
