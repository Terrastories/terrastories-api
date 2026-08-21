import { describe, expect, it } from 'vitest';
import { getMigrationPlan } from '../../src/db/migrate.js';

describe('database migration dialect guard', () => {
  it('uses the existing SQLite/D1-compatible migration history for SQLite', () => {
    const plan = getMigrationPlan('./data.db');

    expect(plan.dialect).toBe('sqlite');
    expect(plan.migrationsFolder.replaceAll('\\', '/')).toMatch(
      /\/src\/db\/migrations$/
    );
  });

  it('fails closed instead of applying SQLite migrations to PostgreSQL', () => {
    expect(() =>
      getMigrationPlan('postgresql://user:password@localhost:5432/terrastories')
    ).toThrow(
      /Refusing to run the SQLite\/D1 migration set against PostgreSQL/
    );
  });
});
