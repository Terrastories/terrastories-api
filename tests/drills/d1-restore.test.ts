/**
 * Restore drill, Cloudflare D1 profile (#136), offline.
 *
 * D1 is SQLite, so the drill dumps a migrated, seeded SQLite database in the
 * SQL text shape `wrangler d1 export` produces (a `PRAGMA defer_foreign_keys`
 * header, schema statements, then one INSERT per row with SQL literals), and
 * re-imports that text into a fresh SQLite the way `wrangler d1 execute --file`
 * replays it. No Cloudflare call is made. The dump is built here because the
 * real export needs a remote database; the format is documented at
 * https://developers.cloudflare.com/d1/best-practices/import-export-data/
 */
import { afterEach, describe, expect, it } from 'vitest';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { applyPostRestoreSqlite } from '../../scripts/ops/post-restore.js';
import {
  OWNERSHIP_INVARIANTS,
  diffSnapshots,
  migrationVersion,
  seedDrillDataset,
  snapshotSqlite,
  writeDrillReport,
} from './drill-helpers.js';

const open: Sqlite.Database[] = [];
afterEach(() => {
  while (open.length > 0) open.pop()?.close();
});

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** Dump in the `wrangler d1 export` text shape (schema, data, then triggers). */
function exportD1Sql(sqlite: Sqlite.Database): string {
  const objects = sqlite
    .prepare(
      "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY rowid"
    )
    .all() as Array<{ type: string; name: string; sql: string }>;
  const tables = objects.filter((o) => o.type === 'table');
  const out = ['PRAGMA defer_foreign_keys=TRUE;'];
  // Composite tenant foreign keys (#186) need their unique indexes in place
  // before the first child row, so indexes precede data (triggers follow it).
  for (const t of tables) out.push(`${t.sql};`);
  for (const o of objects.filter((x) => x.type === 'index'))
    out.push(`${o.sql};`);
  for (const t of tables) {
    const cols = (
      sqlite.prepare(`PRAGMA table_info(${q(t.name)})`).all() as Array<{
        name: string;
      }>
    ).map((c) => c.name);
    const expr = cols.map((c) => `quote(${q(c)})`).join(" || ',' || ");
    const rows = sqlite
      .prepare(
        `SELECT 'INSERT INTO ${q(t.name)} VALUES(' || ${expr} || ');' AS stmt FROM ${q(t.name)}`
      )
      .all() as Array<{ stmt: string }>;
    for (const r of rows) out.push(r.stmt);
  }
  // Autoincrement high-water marks (as sqlite's .dump does): a deleted highest
  // id must never be reused after the restore.
  const seq = sqlite
    .prepare('SELECT name, seq FROM sqlite_sequence')
    .all() as Array<{ name: string; seq: number }>;
  out.push('DELETE FROM sqlite_sequence;');
  for (const s of seq)
    out.push(
      `INSERT INTO sqlite_sequence VALUES('${s.name.replace(/'/g, "''")}',${s.seq});`
    );
  for (const o of objects.filter(
    (x) => x.type === 'trigger' || x.type === 'view'
  ))
    out.push(`${o.sql};`);
  return out.join('\n') + '\n';
}

/** Replay an export into a fresh database in one transaction. */
function importD1Sql(sql: string): Sqlite.Database {
  const db = new Sqlite(':memory:');
  open.push(db);
  db.pragma('foreign_keys = ON');
  db.exec(`BEGIN;\n${sql}\nCOMMIT;`);
  return db;
}

const count = (db: Sqlite.Database, sql: string) =>
  (db.prepare(sql).get() as { n: number }).n;

describe('D1 export/import restore drill (#136)', () => {
  it('re-imports a wrangler-d1-export-shaped dump with identical counts, checksums and invariants', async () => {
    const source = new Sqlite(':memory:');
    open.push(source);
    source.pragma('foreign_keys = ON');
    const orm = drizzle(source);
    migrate(orm, { migrationsFolder: 'src/db/migrations' });
    await seedDrillDataset(orm);
    // High-water mark above the highest live id: create then delete community 3.
    source
      .prepare(
        "INSERT INTO communities (name, slug, locale, public_stories, is_active, created_at, updated_at) VALUES ('Gone', 'gone', 'en', 0, 1, 1, 1)"
      )
      .run();
    source.prepare("DELETE FROM communities WHERE slug = 'gone'").run();
    const before = snapshotSqlite(source);

    const started = Date.now();
    const dump = exportD1Sql(source);
    const restored = importD1Sql(dump);
    const elapsedMs = Date.now() - started;

    // Shape of the export: header first, schema before data, no internal tables.
    expect(dump.startsWith('PRAGMA defer_foreign_keys=TRUE;')).toBe(true);
    expect(dump).toMatch(
      /INSERT INTO sqlite_sequence VALUES\('communities',3\)/
    );
    expect(dump.indexOf('CREATE TABLE')).toBeLessThan(
      dump.indexOf('INSERT INTO')
    );

    const after = snapshotSqlite(restored);
    expect(diffSnapshots(before, after)).toEqual([]);
    expect(after.stories!.count).toBe(3);
    expect(restored.pragma('foreign_key_check')).toEqual([]);
    expect(restored.pragma('integrity_check', { simple: true })).toBe('ok');
    for (const [name, query] of Object.entries(OWNERSHIP_INVARIANTS)) {
      expect({ name, violations: restored.prepare(query).all() }).toEqual({
        name,
        violations: [],
      });
    }

    // Triggers survive the round trip: deactivating a user revokes its sessions.
    const triggerSql =
      "SELECT count(*) AS n FROM sqlite_master WHERE type = 'trigger'";
    expect(count(restored, triggerSql)).toBe(count(source, triggerSql));
    expect(count(restored, triggerSql)).toBeGreaterThan(0);
    restored
      .prepare(
        'UPDATE users SET is_active = 0 WHERE id = (SELECT user_id FROM sessions LIMIT 1)'
      )
      .run();
    expect(count(restored, 'SELECT count(*) AS n FROM sessions')).toBe(0);

    // Post-restore step on a fresh import: sessions gone, codes/tokens superseded.
    const second = importD1Sql(dump);
    const fixed = applyPostRestoreSqlite(second);
    expect(fixed.sessionsDeleted).toBeGreaterThan(0);
    expect(fixed.loginCodesSuperseded).toBeGreaterThan(0);
    expect(fixed.claimTokensSuperseded).toBeGreaterThan(0);
    expect(count(second, 'SELECT count(*) AS n FROM sessions')).toBe(0);
    expect(
      count(
        second,
        'SELECT count(*) AS n FROM login_codes WHERE superseded_at IS NULL'
      )
    ).toBe(0);

    // The deleted high-water id is never reused: the next id follows it.
    const next = restored
      .prepare(
        "INSERT INTO communities (name, slug, locale, public_stories, is_active, created_at, updated_at) VALUES ('Next', 'next', 'en', 0, 1, 1, 1)"
      )
      .run();
    expect(Number(next.lastInsertRowid)).toBe(4);

    writeDrillReport('d1', {
      backup: 'wrangler d1 export (SQL text, offline stand-in)',
      schema: migrationVersion('sqlite'),
      tables: after,
      dumpBytes: Buffer.byteLength(dump),
      timingsMs: { exportAndImport: elapsedMs },
    });
  });
});
