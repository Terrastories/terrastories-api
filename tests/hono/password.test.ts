import { expect, it, vi } from 'vitest';
import { compare } from 'bcrypt';
import { nodePasswordVerifier } from '../../src/node-password.js';
vi.mock('bcrypt', () => ({ compare: vi.fn(async () => false) }));
const costs = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
const encoded = (cost: number) =>
  `$2b$${String(cost).padStart(2, '0')}$${'.'.repeat(53)}`;
it('uses identical ordered bcrypt work for every rejection', async () => {
  for (const hash of ['', 'malformed', ...costs.map(encoded), encoded(15)]) {
    vi.mocked(compare).mockClear().mockResolvedValue(false);
    expect(await nodePasswordVerifier.verify('wrong', hash)).toBe(false);
    expect(
      vi
        .mocked(compare)
        .mock.calls.map(([, candidate]) => Number(candidate.slice(4, 6)))
    ).toEqual(costs);
  }
});
it('never treats a matching dummy hash as authentication', async () => {
  vi.mocked(compare).mockClear().mockResolvedValue(true);
  expect(await nodePasswordVerifier.verify('dummy-password', '')).toBe(false);
  expect(compare).toHaveBeenCalledTimes(costs.length);
  expect(await nodePasswordVerifier.verify('correct', encoded(12))).toBe(true);
});
