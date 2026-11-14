import { describe, expect, it } from 'vitest';
import {
  deriveDescriptionForWrite,
  deriveDescriptionPlain,
  deriveTopicColumns,
  deriveTopicNormalized,
} from '../../src/shared/utils/derived-columns.js';
import { InvalidDescriptionError } from '../../src/shared/utils/safe-description.js';

describe('derived-columns helpers for V2 writes', () => {
  describe('deriveTopicNormalized & deriveTopicColumns', () => {
    it('returns null for null, undefined, or whitespace-only topics', () => {
      expect(deriveTopicNormalized(null)).toBeNull();
      expect(deriveTopicNormalized(undefined)).toBeNull();
      expect(deriveTopicNormalized('   \t\n  ')).toBeNull();
      expect(deriveTopicColumns(null)).toEqual({
        topic: null,
        topicNormalized: null,
      });
      expect(deriveTopicColumns('   ')).toEqual({
        topic: null,
        topicNormalized: null,
      });
    });

    it('normalizes case, final sigma, and NFC equivalence while preserving accents', () => {
      const nfdRiver = 'Ri\u0301o   Amazo\u0301nico';
      expect(deriveTopicNormalized('  Río   Amazónico  ')).toBe(
        'río   amazónico'
      );
      expect(deriveTopicNormalized(nfdRiver)).toBe('río   amazónico');
      expect(deriveTopicColumns('  Πόλις  ')).toEqual({
        topic: 'Πόλις',
        topicNormalized: 'πόλισ',
      });
    });
  });

  describe('deriveDescriptionPlain & deriveDescriptionForWrite', () => {
    it('returns null for null, undefined, empty, or whitespace/empty-tag descriptions', () => {
      expect(deriveDescriptionPlain(null)).toBeNull();
      expect(deriveDescriptionPlain(undefined)).toBeNull();
      expect(deriveDescriptionPlain('')).toBeNull();
      expect(deriveDescriptionPlain('<p>   </p>')).toBeNull();
      expect(deriveDescriptionForWrite(null)).toEqual({
        description: null,
        descriptionPlain: null,
      });
      expect(deriveDescriptionForWrite('   \n  ')).toEqual({
        description: null,
        descriptionPlain: null,
      });
    });

    it('sanitizes HTML and extracts bounded plain text without entities or tags', () => {
      const html = '<p>River &amp; <strong>Forest</strong></p>';
      expect(deriveDescriptionPlain(html)).toBe('River & Forest');

      const derived = deriveDescriptionForWrite(
        '<p onclick="evil()">Story <script>x()</script><em>title</em> &amp; map</p>'
      );
      expect(derived.description).toBe('<p>Story <em>title</em> &amp; map</p>');
      expect(derived.descriptionPlain).toBe('Story title & map');
    });

    it('propagates InvalidDescriptionError on oversized description inputs', () => {
      expect(() =>
        deriveDescriptionForWrite(`<p>${'a'.repeat(50_000)}</p>`)
      ).toThrow(InvalidDescriptionError);
    });
  });
});
