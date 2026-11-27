import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { textOrder } from '../../src/db/dialect.js';
import { storiesPg, storiesSqlite } from '../../src/db/schema/stories.js';

// S2: V2 public-content story ordering goes through textOrder, so PostgreSQL
// must pin byte order with COLLATE "C" while SQLite keeps its BINARY default.
describe('textOrder collation (S2)', () => {
  it('pins byte order on PostgreSQL in both directions', () => {
    const pg = new PgDialect();
    for (const direction of ['asc', 'desc'] as const) {
      const { sql } = pg.sqlToQuery(
        textOrder('postgresql', storiesPg.title, direction)
      );
      expect(sql).toContain('COLLATE "C"');
      expect(sql.endsWith(direction.toUpperCase())).toBe(true);
    }
  });

  it('leaves SQLite on its default BINARY collation', () => {
    const { sql } = new SQLiteSyncDialect().sqlToQuery(
      textOrder('sqlite', storiesSqlite.title, 'asc')
    );
    expect(sql).not.toContain('COLLATE');
    expect(sql.endsWith('ASC')).toBe(true);
  });
});
