import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
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

  it('keeps a Drizzle snapshot for every registered migration state', () => {
    for (const migrationsFolder of [
      path.join(process.cwd(), 'src/db/migrations'),
      path.join(process.cwd(), 'src/db/migrations/postgres'),
    ]) {
      const metaFolder = path.join(migrationsFolder, 'meta');
      const journal = JSON.parse(
        readFileSync(path.join(metaFolder, '_journal.json'), 'utf8')
      ) as { entries: Array<{ idx: number; tag: string }> };

      for (const entry of journal.entries) {
        const snapshot = path.join(
          metaFolder,
          `${String(entry.idx).padStart(4, '0')}_snapshot.json`
        );
        expect(
          existsSync(snapshot),
          `missing snapshot for ${entry.tag} in ${migrationsFolder}`
        ).toBe(true);
      }
    }
  });
});
