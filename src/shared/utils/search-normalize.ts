/**
 * Shared text normalization for application-defined case comparison
 * (docs/SPEC-V2.md §6.2). The contract, stated on its own:
 *
 * - the comparison key is NFC-composed, then lowercased with the
 *   ECMAScript default (full, locale-independent) mapping, then final
 *   sigma (U+03C2) is folded to medial sigma (U+03C3), then the key is NFC
 *   re-composed (lowercasing itself can emit decomposed output);
 * - matching is accent-sensitive on purpose: a base letter without its
 *   mark does not match, while composed and decomposed forms of the same
 *   text both match;
 * - no Unicode case folding is applied beyond the sigma fold, so for
 *   example "İ" (U+0130) lowercases to "i" + U+0307 and "İnstituto" does
 *   not contain "instituto" (documented limitation, SPEC-V2 §6.3).
 *
 * The sigma fold exists because `toLowerCase()` applies the context-dependent
 * Final_Sigma rule: a needle "ΑΣ" lowercases to "ας" on its own but the same
 * letters inside "ΑΣΑ" lowercase to "ασα", so without the fold a prefix typed
 * in the stored case would not match.
 *
 * This is the same contract the application applies to tags (SPEC-V2
 * §6.3), applied in application code so SQLite/D1 (ASCII-only `lower()`)
 * and PostgreSQL agree on the result. The old PostgreSQL path folded case
 * with ILIKE, whose behavior depends on the database collation.
 */

/**
 * NFC compose + lowercase + sigma fold + NFC re-compose: the application
 * comparison key. The re-compose matters because lowercasing can emit
 * decomposed output — e.g. "T" + U+0308 lowercases to decomposed
 * "t" + U+0308, which NFC composes back to U+1E97 — so the key is stable
 * across equivalent input forms.
 */
export function normalizeSearchText(value: string): string {
  return value
    .normalize('NFC')
    .toLowerCase()
    .replace(/\u03C2/g, '\u03C3')
    .normalize('NFC');
}

/**
 * Literal substring match against a needle key already produced by
 * `normalizeSearchText`, so a caller filtering many rows does not
 * re-normalize the needle for every row.
 */
export function containsNormalizedKey(
  haystack: string,
  needleKey: string
): boolean {
  return normalizeSearchText(haystack).includes(needleKey);
}

/**
 * Literal substring match under the normalized key, normalizing both
 * sides. Wildcards are NOT special: `%` and `_` match themselves, because
 * the needle never reaches a LIKE pattern. Accent-sensitive on purpose —
 * "sao" does not match "São", a base letter without its mark does not
 * match — while composed and decomposed forms of the same text both
 * match, because both sides are NFC-composed first.
 */
export function containsNormalized(haystack: string, needle: string): boolean {
  return containsNormalizedKey(haystack, normalizeSearchText(needle));
}
