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

  it('uses a dedicated PostgreSQL migration history for PostgreSQL', () => {
    const plan = getMigrationPlan(
      'postgresql://user:password@localhost:5432/terrastories'
    );

    expect(plan.dialect).toBe('postgresql');
    expect(plan.migrationsFolder.replaceAll('\\', '/')).toMatch(
      /\/src\/db\/migrations\/postgres$/
    );
  });

  it('fails closed for unsupported database URL dialects', () => {
    expect(() =>
      getMigrationPlan('mysql://user:password@localhost:3306/terrastories')
    ).toThrow(/Unsupported database URL dialect/);
  });
});
