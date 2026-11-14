/**
 * Migrated-database probes for the #186 composite tenant foreign keys.
 *
 * Schema suites use these instead of asserting against the Drizzle table
 * objects: a property on the table object says nothing about the database a
 * migration actually produced. Every probe here runs against an in-memory
 * SQLite database that applied the repository's full SQLite migration set.
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface SqliteColumnProbe {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

export interface SqliteForeignKeyGroup {
  table: string;
  from: string[];
  to: string[];
  onUpdate: string;
  onDelete: string;
}

/** Apply the repository's SQLite migrations to a fresh in-memory database. */
export async function migrateInMemorySqlite(): Promise<Database.Database> {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const database = drizzle(sqlite);
  await migrate(database, {
    migrationsFolder: path.join(
      __dirname,
      '..',
      '..',
      'src',
      'db',
      'migrations'
    ),
  });
  return sqlite;
}

export function sqliteColumn(
  sqlite: Database.Database,
  table: string,
  column: string
): SqliteColumnProbe | undefined {
  const rows = sqlite
    .prepare(`PRAGMA table_info(${table})`)
    .all() as SqliteColumnProbe[];
  return rows.find((row) => row.name === column);
}

/**
 * Foreign keys of a table, grouped per constraint (PRAGMA
 * foreign_key_list returns one row per column of a constraint).
 */
export function sqliteForeignKeyGroups(
  sqlite: Database.Database,
  table: string
): SqliteForeignKeyGroup[] {
  const rows = sqlite
    .prepare(`PRAGMA foreign_key_list(${table})`)
    .all() as Array<{
    id: number;
    seq: number;
    table: string;
    from: string;
    to: string;
    on_update: string;
    on_delete: string;
  }>;
  const groups = new Map<number, typeof rows>();
  for (const row of rows) {
    const group = groups.get(row.id) ?? [];
    group.push(row);
    groups.set(row.id, group);
  }
  return [...groups.values()].map((group) => {
    const ordered = group.slice().sort((left, right) => left.seq - right.seq);
    return {
      table: ordered[0].table,
      from: ordered.map((row) => row.from),
      to: ordered.map((row) => row.to),
      onUpdate: ordered[0].on_update,
      onDelete: ordered[0].on_delete,
    };
  });
}
