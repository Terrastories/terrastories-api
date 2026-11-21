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

/** Serialize any value with deterministic key order and trailing LF. */
export function canonicalJsonStringify(value: unknown): string {
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
