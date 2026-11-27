import { describe, expect, it } from 'vitest';
import { assertValidDate } from '../../scripts/db-repository-contract.js';

describe('assertValidDate', () => {
  it('accepts a finite Date', () => {
    expect(() => assertValidDate(new Date(0), 'x')).not.toThrow();
  });

  it('keeps its message for an Invalid Date instead of throwing a RangeError', () => {
    expect(() =>
      assertValidDate(new Date(NaN), 'places.create createdAt')
    ).toThrow(
      /places\.create createdAt must be a Date with a finite time, got Invalid Date/
    );
  });

  it('names the type of a non-Date value', () => {
    expect(() => assertValidDate('2026-01-01', 'label')).toThrow(/got string/);
    expect(() => assertValidDate(undefined, 'label')).toThrow(/got undefined/);
  });
});
