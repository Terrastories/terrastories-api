import { afterEach, describe, expect, it, vi } from 'vitest';
import { seedDatabase } from '../../src/db/seed.js';

afterEach(() => vi.unstubAllEnvs());

describe('Demo database seed environment boundary', () => {
  it.each(['production', 'staging', undefined, '', 'field-kit', 'offline'])(
    'refuses seeding before opening a database for NODE_ENV=%s',
    async (environment) => {
      vi.stubEnv('NODE_ENV', environment);
      await expect(seedDatabase()).rejects.toThrow(
        'Demo seeding requires NODE_ENV=development or NODE_ENV=test'
      );
    }
  );
});
