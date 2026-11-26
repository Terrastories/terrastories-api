import { describe, expect, it } from 'vitest';
import {
  descriptionPlainText,
  isPlainTextDescription,
  sanitizeDescriptionForMigration,
  sanitizeDescriptionFullPipelineForTest,
  validateDescriptionForWrite,
} from '../../src/shared/utils/safe-description.js';

// Deterministic PRNG (mulberry32) so a failure reproduces.
function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PIECES = [
  'a',
  'Z',
  '0',
  '9',
  ' ',
  '  ',
  '\n',
  '\n\n',
  '\t',
  '.',
  ',',
  ';',
  ':',
  '!',
  '?',
  '"',
  "'",
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
  '-',
  '_',
  '/',
  '\\',
  '@',
  '#',
  '%',
  '*',
  '+',
  '=',
  '|',
  '~',
  '$',
  '^',
  '`',
  'é',
  'ñ',
  'ü',
  '日本語',
  'ж',
  '😀',
  '👩‍👩‍👧',
  '\u00a0',
  '\u200b',
  '\u2003',
  '\u3000',
  'javascript:alert(1)',
  'https://example.org/a?b=c',
  'hello world',
  'x'.repeat(50),
  '&',
  '<',
  '>',
  '&amp;',
  '<b>',
  '</p>',
  '<!--',
  '\r',
  '\r\n',
  '\u0000',
  '\u2028',
  '\ufffd',
];

const EDGE = [
  '',
  ' ',
  '  ',
  '\n',
  ' leading',
  'trailing ',
  '\nleading newline',
  'trailing newline\n',
  'a\n\n\nb',
  'a \t b',
  '\t',
  'plain',
  'a"b\'c',
  'x > y',
  '1 < 2',
  'AT&T',
  '&amp;',
  'a\r\nb',
  'a\u0000b',
  'zero\u200bwidth',
  'ünïcödé 日本語 😀',
  '\u00a0nbsp\u00a0',
  '  multiple   spaces  ',
  '-->',
  '<!-- c -->',
  'a\u2028b',
  'a\ufdd0b',
  'a\u{1fffe}b',
  '\ue000',
];

function build(r: () => number): string {
  const n = Math.floor(r() * 12);
  let s = '';
  for (let i = 0; i < n; i++) s += PIECES[Math.floor(r() * PIECES.length)];
  return s;
}

function expectSame(input: string) {
  const viaFull = sanitizeDescriptionFullPipelineForTest(input, 'runtime');
  const migFull = sanitizeDescriptionFullPipelineForTest(input, 'migration');
  const viaPublic = validateDescriptionForWrite(input);
  expect(viaPublic.html, JSON.stringify(input)).toBe(viaFull.html);
  expect(viaPublic.changed).toBe(viaFull.changed);
  expect(viaPublic.plainText).toBe(descriptionPlainText(viaFull.html));
  const mig = sanitizeDescriptionForMigration(input);
  expect(mig.html).toBe(migFull.html);
  expect(mig.changed).toBe(migFull.changed);
  expect(mig.droppedHrefs).toBe(migFull.droppedHrefs);
  expect(mig.removedNodes).toBe(migFull.removedNodes);
  if (isPlainTextDescription(input)) {
    // The fast path returns the input verbatim, so the full pipeline must too.
    expect(viaFull.html, JSON.stringify(input)).toBe(input);
    expect(viaFull.changed).toBe(false);
    expect(viaFull.droppedHrefs).toBe(0);
    expect(viaFull.removedNodes).toBe(0);
  }
}

describe('plain-text description fast path', () => {
  it('matches the full pipeline on edge inputs', () => {
    for (const input of EDGE) expectSame(input);
  });

  it('matches the full pipeline on 5000 generated inputs', () => {
    const r = rng(295);
    let eligible = 0;
    for (let i = 0; i < 5000; i++) {
      const input = build(r);
      if (isPlainTextDescription(input)) eligible += 1;
      expectSame(input);
    }
    expect(eligible).toBeGreaterThan(500);
  });

  it('never takes the fast path for markup or entity starters', () => {
    for (const s of ['<b>x</b>', 'a & b', 'a > b', '&amp;', '<', 'x\ru'])
      expect(isPlainTextDescription(s)).toBe(false);
  });
});
