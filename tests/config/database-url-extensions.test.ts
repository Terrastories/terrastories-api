import { describe, expect, it } from 'vitest';
import { DatabaseConfigSchema } from '../../src/shared/config/schema.js';

describe('DATABASE_URL SQLite file extensions', () => {
  it.each([
    './data.db',
    '/srv/terrastories/v2.sqlite',
    './v2.sqlite3',
    ':memory:',
    'postgresql://user@host/db',
  ])('accepts %s', (url) => {
    expect(DatabaseConfigSchema.parse({ url }).url).toBe(url);
  });

  it('still rejects unrelated values', () => {
    expect(() => DatabaseConfigSchema.parse({ url: './data.txt' })).toThrow(
      /valid database connection string/
    );
  });
});
