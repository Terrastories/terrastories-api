import { describe, expect, it } from 'vitest';
import {
  ARGON2ID_MAX_STORED_ITERATIONS,
  ARGON2ID_MAX_STORED_MEMORY_KIB,
  ARGON2ID_MAX_STORED_PARALLELISM,
  ARGON2ID_MIN_STORED_MEMORY_KIB,
  ARGON2ID_PARAMS,
  isWellFormedArgon2idParams,
} from '../../src/shared/auth-policy.js';

describe('isWellFormedArgon2idParams', () => {
  it('accepts the named policy and serious below-policy rows', () => {
    expect(isWellFormedArgon2idParams(ARGON2ID_PARAMS)).toBe(true);
    // Below policy (8 MiB, 1 iteration) but sane: must not be locked out by
    // a future policy raise.
    expect(
      isWellFormedArgon2idParams({
        memoryKiB: 8192,
        iterations: 1,
        parallelism: 1,
      })
    ).toBe(true);
    // Above policy is not required, but certainly well formed.
    expect(
      isWellFormedArgon2idParams({
        memoryKiB: 128 * 1024,
        iterations: 4,
        parallelism: 4,
      })
    ).toBe(true);
  });

  it('rejects near-zero memory', () => {
    const belowFloor = ARGON2ID_MIN_STORED_MEMORY_KIB - 1;
    for (const memoryKiB of [1, 256, 1024, 4096, belowFloor]) {
      expect(
        isWellFormedArgon2idParams({
          memoryKiB,
          iterations: 2,
          parallelism: 1,
        }),
        `${memoryKiB} KiB must fail closed`
      ).toBe(false);
    }
  });

  it('accepts exactly the floor and exactly the ceiling', () => {
    expect(
      isWellFormedArgon2idParams({
        memoryKiB: ARGON2ID_MIN_STORED_MEMORY_KIB,
        iterations: 1,
        parallelism: 1,
      })
    ).toBe(true);
    expect(
      isWellFormedArgon2idParams({
        memoryKiB: ARGON2ID_MAX_STORED_MEMORY_KIB,
        iterations: ARGON2ID_MAX_STORED_ITERATIONS,
        parallelism: ARGON2ID_MAX_STORED_PARALLELISM,
      })
    ).toBe(true);
  });

  it('rejects above-cap memory, iterations and parallelism', () => {
    expect(
      isWellFormedArgon2idParams({
        memoryKiB: ARGON2ID_MAX_STORED_MEMORY_KIB + 1,
        iterations: 1,
        parallelism: 1,
      })
    ).toBe(false);
    expect(
      isWellFormedArgon2idParams({
        memoryKiB: 8192,
        iterations: ARGON2ID_MAX_STORED_ITERATIONS + 1,
        parallelism: 1,
      })
    ).toBe(false);
    expect(
      isWellFormedArgon2idParams({
        memoryKiB: 8192,
        iterations: 1,
        parallelism: ARGON2ID_MAX_STORED_PARALLELISM + 1,
      })
    ).toBe(false);
  });

  it('rejects non-integers, missing keys and non-objects', () => {
    expect(
      isWellFormedArgon2idParams({
        memoryKiB: 8192.5,
        iterations: 2,
        parallelism: 1,
      })
    ).toBe(false);
    expect(
      isWellFormedArgon2idParams({ memoryKiB: 8192, parallelism: 1 })
    ).toBe(false);
    expect(
      isWellFormedArgon2idParams({
        memoryKiB: 8192,
        iterations: 0,
        parallelism: 1,
      })
    ).toBe(false);
    expect(
      isWellFormedArgon2idParams({
        memoryKiB: 8192,
        iterations: 1,
        parallelism: 0,
      })
    ).toBe(false);
    expect(isWellFormedArgon2idParams(null)).toBe(false);
    expect(isWellFormedArgon2idParams(undefined)).toBe(false);
    expect(isWellFormedArgon2idParams('8192')).toBe(false);
    expect(
      isWellFormedArgon2idParams({
        memoryKiB: Number.NaN,
        iterations: 1,
        parallelism: 1,
      })
    ).toBe(false);
  });
});
