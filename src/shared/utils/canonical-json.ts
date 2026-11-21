/**
 * Deterministic canonical JSON serialization helpers for community export
 * manifests (SPEC-V2 §7).
 *
 * Pure module with zero Node-only or database imports so SQLite/D1,
 * PostgreSQL, and Cloudflare Workers produce byte-identical output.
 */

function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Recursively normalize a value into a deterministic JSON-compatible structure:
 * - `Date` -> ISO 8601 UTC string
 * - `-0` -> `0`, non-finite numbers -> `null`
 * - arrays preserve element order (`undefined` -> `null`, matching JSON.stringify)
 * - plain objects have keys sorted by UTF-16 code unit order with `undefined`
 *   properties omitted
 */
export function canonicalJsonValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map((item) =>
      item === undefined ? null : canonicalJsonValue(item)
    );
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort(compareCodeUnits);
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      const entry = record[key];
      if (entry === undefined) continue;
      Object.defineProperty(out, key, {
        value: canonicalJsonValue(entry),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return out;
  }
  return null;
}

/** Count canonical UTF-8 JSON bytes without allocating an escaped string or
 * normalized object tree. Stop as soon as the caller's memory budget is spent.
 */
export function canonicalJsonByteLength(
  value: unknown,
  maxBytes = Infinity
): number {
  let bytes = 1; // trailing LF
  const add = (n: number) => {
    bytes += n;
    if (bytes > maxBytes) throw new CanonicalJsonLimitError();
  };
  const string = (text: string) => {
    add(2);
    for (let i = 0; i < text.length; i += 1) {
      const c = text.charCodeAt(i);
      if (
        c === 34 ||
        c === 92 ||
        c === 8 ||
        c === 9 ||
        c === 10 ||
        c === 12 ||
        c === 13
      )
        add(2);
      else if (c < 32) add(6);
      else if (c < 128) add(1);
      else if (c < 2048) add(2);
      else if (
        c >= 0xd800 &&
        c <= 0xdbff &&
        i + 1 < text.length &&
        text.charCodeAt(i + 1) >= 0xdc00 &&
        text.charCodeAt(i + 1) <= 0xdfff
      ) {
        add(4);
        i += 1;
      } else if (c >= 0xd800 && c <= 0xdfff) add(6);
      else add(3);
    }
  };
  const visit = (entry: unknown): void => {
    if (entry instanceof Date) {
      visit(Number.isNaN(entry.getTime()) ? null : entry.toISOString());
      return;
    }
    if (typeof entry === 'string' || typeof entry === 'bigint') {
      string(String(entry));
      return;
    }
    if (
      entry === null ||
      entry === undefined ||
      (typeof entry !== 'object' &&
        typeof entry !== 'number' &&
        typeof entry !== 'boolean')
    ) {
      add(4);
      return;
    }
    if (typeof entry === 'number' || typeof entry === 'boolean') {
      add(JSON.stringify(entry).length);
      return;
    }
    if (Array.isArray(entry)) {
      add(2);
      for (let i = 0; i < entry.length; i += 1) {
        if (i) add(1);
        visit(entry[i]);
      }
      return;
    }
    add(2);
    let first = true;
    for (const key of Object.keys(entry)) {
      const item = (entry as Record<string, unknown>)[key];
      if (item === undefined) continue;
      if (!first) add(1);
      first = false;
      string(key);
      add(1);
      visit(item);
    }
  };
  visit(value);
  if (bytes > maxBytes) throw new CanonicalJsonLimitError();
  return bytes;
}

export class CanonicalJsonLimitError extends Error {}

/** Serialize any value with deterministic key order and trailing LF. */
export function canonicalJsonStringify(
  value: unknown,
  maxBytes = Infinity
): string {
  if (Number.isFinite(maxBytes)) canonicalJsonByteLength(value, maxBytes);
  return `${JSON.stringify(canonicalJsonValue(value))}\n`;
}

/**
 * Normalize a JSON/text column across SQLite (TEXT JSON) and PostgreSQL (JSONB)
 * into a parsed JS value so both backends emit identical structures.
 */
export function parseJsonColumn(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return value;
    }
  }
  return value;
}
