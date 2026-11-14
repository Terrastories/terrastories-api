/**
 * Shared text normalization for application-defined case comparison
 * (docs/SPEC-V2.md §6.2): NFC compose, then Unicode lowercase. This is the
 * same contract the application applies to tags (SPEC-V2 §6.3), applied in
 * application code so both SQLite/D1 (ASCII-only `lower()`) and PostgreSQL
 * (Unicode ILIKE) agree on the result.
 */

/** NFC compose + Unicode lowercase: the application comparison key. */
export function normalizeSearchText(value: string): string {
  return value.normalize('NFC').toLowerCase();
}

/**
 * Literal substring match under the normalized key. Wildcards are NOT
 * special: `%` and `_` match themselves, because the needle never reaches a
 * LIKE pattern. Accent-sensitive on purpose — "sao" does not match "São"
 * (PostgreSQL ILIKE parity) — while composed and decomposed forms of the
 * same text both match, because both sides are NFC-composed first.
 */
export function containsNormalized(haystack: string, needle: string): boolean {
  return normalizeSearchText(haystack).includes(normalizeSearchText(needle));
}
