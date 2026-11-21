import { describe, expect, it } from 'vitest';
import {
  canonicalJsonStringify,
  canonicalJsonValue,
  parseJsonColumn,
} from '../../src/shared/utils/canonical-json.js';

describe('canonical-json', () => {
  it('sorts object keys deterministically regardless of insertion order', () => {
    const a = {
      zeta: 1,
      alpha: { d: 4, b: 2, a: undefined },
      beta: [true, -0, new Date('2026-11-21T12:00:00.000Z'), undefined],
    };
    const b = {
      beta: [true, 0, new Date('2026-11-21T12:00:00.000Z'), null],
      alpha: { b: 2, d: 4 },
      zeta: 1,
    };

    expect(canonicalJsonStringify(a)).toBe(canonicalJsonStringify(b));
    expect(canonicalJsonStringify(a)).toBe(
      '{"alpha":{"b":2,"d":4},"beta":[true,0,"2026-11-21T12:00:00.000Z",null],"zeta":1}\n'
    );
  });

  it('guards against __proto__ prototype mutation and normalizes non-finite numbers', () => {
    const input = JSON.parse('{"__proto__":{"polluted":true},"a":1}') as Record<
      string,
      unknown
    >;
    const normalized = canonicalJsonValue(input) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(normalized, '__proto__')).toBe(
      true
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(canonicalJsonStringify({ bad: Number.NaN, inf: Infinity })).toBe(
      '{"bad":null,"inf":null}\n'
    );
  });

  it('normalizes JSON string columns and pre-parsed objects identically', () => {
    expect(parseJsonColumn(null)).toBeNull();
    expect(parseJsonColumn('   ')).toBeNull();
    expect(parseJsonColumn('{"width":640,"height":480}')).toEqual({
      width: 640,
      height: 480,
    });
    expect(parseJsonColumn({ width: 640, height: 480 })).toEqual({
      width: 640,
      height: 480,
    });
    expect(parseJsonColumn('not-json')).toBe('not-json');
  });
});
