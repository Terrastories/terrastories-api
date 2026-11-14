/**
 * Shared search normalization contract (#192, SPEC-V2 §6.2): application
 * case-comparison for Explore community-name search. Both SQLite/D1
 * (`lower()` folds ASCII only) and PostgreSQL (Unicode ILIKE) must agree on
 * the result, so the folding happens in application code under the same NFC
 * + lower-case contract as tags (SPEC-V2 §6.3).
 */
import { describe, expect, it } from 'vitest';
import {
  containsNormalized,
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
