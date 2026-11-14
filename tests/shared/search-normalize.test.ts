/**
 * Shared search normalization contract (#192, SPEC-V2 §6.2): application
 * case-comparison for Explore community-name search. The contract, stated
 * on its own: the key is NFC-composed, lowercased with the ECMAScript
 * default mapping, final sigma folded to σ, then NFC re-composed
 * (lowercasing itself can emit decomposed output); accent-sensitive (a base
 * letter without its mark does not match); no other case folding. Both SQLite/D1 (`lower()` folds ASCII only) and
 * PostgreSQL must agree on the result, so the folding happens in
 * application code — the old PostgreSQL path folded case with
 * collation-dependent ILIKE — under the same contract as tags (SPEC-V2
 * §6.3).
 */
import { describe, expect, it } from 'vitest';
import {
  containsNormalized,
  containsNormalizedKey,
  normalizeSearchText,
} from '../../src/shared/utils/search-normalize.js';

describe('normalizeSearchText', () => {
  it('folds case on non-ASCII letters, not just ASCII', () => {
    expect(normalizeSearchText('SÃO')).toBe('são');
    expect(normalizeSearchText('ÉCOLE')).toBe('école');
    expect(normalizeSearchText('ÑUU')).toBe('ñuu');
    expect(normalizeSearchText('comunidade')).toBe('comunidade');
  });

  it('composes decomposed (NFD) input to the same NFC key', () => {
    const nfd = 'são'.normalize('NFD');
    expect(nfd).not.toBe('são'); // sanity: the input really is decomposed
    expect(normalizeSearchText(nfd)).toBe('são');
    expect(normalizeSearchText(nfd)).toBe(normalizeSearchText('SÃO'));
  });

  it('re-composes lowercasing output that is itself decomposed', () => {
    // "T" + combining diaeresis lowercases to a DECOMPOSED
    // "t" + U+0308; the NFC re-compose turns it into the precomposed
    // U+1E97 — the same key the precomposed "ẗ" itself produces, so the
    // two forms of the same text share one key.
    expect(normalizeSearchText('T\u0308')).toBe('\u1E97');
    expect(normalizeSearchText('\u1E97')).toBe('\u1E97');
    expect(normalizeSearchText('T\u0308')).toBe(normalizeSearchText('\u1E97'));
  });

  it('folds final sigma so a same-case Greek prefix matches', () => {
    // toLowerCase() maps a word-final Σ to ς but a medial Σ to σ; the key
    // folds ς to σ so the needle and the haystack agree.
    expect(containsNormalized('ΑΣΑ', 'ΑΣ')).toBe(true);
    expect(normalizeSearchText('ΟΔΟΣ')).toBe('οδοσ');
  });

  it('applies no Unicode case folding beyond the sigma fold', () => {
    // Full case folding would map U+1E9B (LATIN SMALL LETTER LONG S WITH
    // DOT ABOVE) to U+1E61 (ṡ); toLowerCase() leaves it alone.
    expect(normalizeSearchText('\u1E9B')).toBe('\u1E9B');
    expect(containsNormalized('\u1E9B', 'ṡ')).toBe(false);
  });

  it('keeps the default İ lowercase mapping (documented limitation)', () => {
    // "İ" (U+0130) lowercases to decomposed "i" + U+0307, which NFC never
    // composes back to a plain "i", so "İnstituto" does NOT contain
    // "instituto". This is the ECMAScript default (full, locale-independent)
    // lowercase; the limitation is documented in SPEC-V2 §6.3, not fixed
    // with case folding.
    expect(containsNormalized('İnstituto', 'instituto')).toBe(false);
    expect(containsNormalized('instituto', 'İnstituto')).toBe(false);
    expect(normalizeSearchText('İnstituto')).not.toContain('instituto');
  });
});

describe('containsNormalized', () => {
  const haystack = 'Comunidade São João';

  it('matches across case and across composed/decomposed forms', () => {
    expect(containsNormalized(haystack, 'SÃO')).toBe(true);
    expect(containsNormalized(haystack, 'SÃO JOÃO')).toBe(true);
    expect(containsNormalized(haystack, 'SÃO JOÃO'.normalize('NFD'))).toBe(
      true
    );
  });

  it('is accent-sensitive on purpose', () => {
    expect(containsNormalized(haystack, 'sao')).toBe(false);
    expect(containsNormalized(haystack, 'joao')).toBe(false);
  });

  it('treats LIKE wildcards as literal characters', () => {
    expect(containsNormalized(haystack, '%')).toBe(false);
    expect(containsNormalized(haystack, '_')).toBe(false);
    expect(containsNormalized(haystack, 'SÃO_JOÃO')).toBe(false);
    expect(containsNormalized('100% Fundo', '%')).toBe(true);
    expect(containsNormalized('a_b', '_')).toBe(true);
  });

  it('matches any haystack for an empty needle', () => {
    expect(containsNormalized(haystack, '')).toBe(true);
    expect(containsNormalized('', '')).toBe(true);
  });

  it('does not match an empty haystack for a non-empty needle', () => {
    expect(containsNormalized('', 'são')).toBe(false);
  });
});

describe('containsNormalizedKey', () => {
  const haystack = 'Comunidade São João';

  it('matches a haystack against an already-normalized needle key', () => {
    const key = normalizeSearchText('SÃO JOÃO');
    expect(containsNormalizedKey(haystack, key)).toBe(true);
    expect(containsNormalizedKey(haystack.normalize('NFD'), key)).toBe(true);
  });

  it('rejects keys the haystack does not contain', () => {
    expect(
      containsNormalizedKey(haystack, normalizeSearchText('sao joao'))
    ).toBe(false);
    expect(containsNormalizedKey(haystack, normalizeSearchText('zzz'))).toBe(
      false
    );
  });
  it('does not let a bare base letter match a letter with a separate mark', () => {
    // No precomposed form exists, so the mark survives NFC as its own code
    // point; the match must still respect it.
    expect(containsNormalized('g\u0303a', 'g')).toBe(false);
    expect(containsNormalized('\u0105\u0301', '\u0105')).toBe(false);
    expect(containsNormalized('g\u0303a', 'g\u0303')).toBe(true);
    expect(containsNormalized('ga g\u0303a', 'ga')).toBe(true);
    expect(containsNormalized('Avañe\u0303\u1EBD', 'AVAÑE\u0303')).toBe(true);
  });
});
