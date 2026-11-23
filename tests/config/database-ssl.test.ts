import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolvePostgresSsl } from '../../src/db/index.js';
import { loadConfig } from '../../src/shared/config/index.js';
import {
  DatabaseConfigSchema,
  ProductionConfigSchema,
} from '../../src/shared/config/schema.js';

describe('DATABASE_SSL override', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('keeps TLS required by default in production and off elsewhere', () => {
    const production = ProductionConfigSchema.shape.database.parse({});
    expect(resolvePostgresSsl(production)).toBe('require');
    expect(resolvePostgresSsl(DatabaseConfigSchema.parse({}))).toBe(false);
  });

  it.each([
    ['disable', false],
    ['require', 'require'],
    ['verify-full', 'verify-full'],
  ] as const)('maps sslMode %s', (sslMode, expected) => {
    const production = ProductionConfigSchema.shape.database.parse({ sslMode });
    expect(resolvePostgresSsl(production)).toBe(expected);
  });

  it('rejects unknown modes and treats empty as unset', () => {
    expect(() => DatabaseConfigSchema.parse({ sslMode: 'maybe' })).toThrow();
    expect(DatabaseConfigSchema.parse({ sslMode: '' }).sslMode).toBeUndefined();
  });

  it('reads DATABASE_SSL from the environment in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('JWT_SECRET', 'j'.repeat(40));
    vi.stubEnv('SESSION_SECRET', 's'.repeat(40));
    vi.stubEnv('DATABASE_URL', 'postgresql://u@db:5432/t');
    vi.stubEnv('DATABASE_SSL', 'Disable');
    expect(resolvePostgresSsl(loadConfig(true, true).database)).toBe(false);
    vi.stubEnv('DATABASE_SSL', '');
    expect(resolvePostgresSsl(loadConfig(true, true).database)).toBe('require');
  });
});
