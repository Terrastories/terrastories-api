import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import { tablesFor } from '../../src/db/dialect.js';

describe('0016 migration: communities.deprovisioned_at nullable column', () => {
  it('adds nullable deprovisioned_at over existing community rows and persists ms epoch tombstones', async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'ts-0016-mig-'));
    try {
      const sqlite = new Sqlite(path.join(tmpDir, 'upgrade.db'));
      sqlite.pragma('foreign_keys = ON');
      const migrationsDir = path.resolve('src/db/migrations');
      const preFiles = [
        '0000_glamorous_guardsmen.sql',
        '0001_authentication_fields.sql',
        '0002_community_rails_fields.sql',
        '0003_file_indexes.sql',
        '0004_durable_sessions.sql',
        '0005_composite_tenant_fks.sql',
        '0006_ms_timestamps.sql',
        '0007_story_edge_multiplicity_and_speaker_fields.sql',
        '0008_slice1_content_columns.sql',
        '0009_users_identity_and_audit_entries.sql',
        '0010_canonical_media_and_map_configs.sql',
        '0011_files_storage_key_path_indexes.sql',
        '0012_auth_throttle_and_session_lifetimes.sql',
        '0013_login_codes_and_claim_tokens.sql',
        '0014_session_admin_code_step_up_and_login_code_idx.sql',
        '0015_import_manifests.sql',
      ];
      for (const file of preFiles) {
        const sqlText = readFileSync(path.join(migrationsDir, file), 'utf8');
        for (const stmt of sqlText.split('--> statement-breakpoint')) {
          if (stmt.trim()) sqlite.exec(stmt);
        }
      }

      const nowMs = Date.UTC(2026, 10, 21, 12, 0, 0);
      sqlite
        .prepare(
          `INSERT INTO communities (name, slug, locale, public_stories, is_active, beta, created_at, updated_at)
           VALUES ('Pre 0016', 'pre-0016', 'en', 0, 1, 0, ?, ?)`
        )
        .run(nowMs, nowMs);

      const sql0016 = readFileSync(
        path.join(migrationsDir, '0016_communities_deprovisioned_at.sql'),
        'utf8'
      );
      for (const stmt of sql0016.split('--> statement-breakpoint')) {
        if (stmt.trim()) sqlite.exec(stmt);
      }

      const cols = sqlite
        .prepare('PRAGMA table_info(communities)')
        .all() as Array<{ name: string; type: string; notnull: number }>;
      const col = cols.find((c) => c.name === 'deprovisioned_at');
      expect(col).toBeDefined();
      expect(col?.type.toLowerCase()).toBe('integer');
      expect(col?.notnull).toBe(0);

      const db = drizzle(sqlite);
      const t = tablesFor(db);
      const [existing] = await db
        .select({
          id: t.communities.id,
          deprovisionedAt: t.communities.deprovisionedAt,
        })
        .from(t.communities)
        .where(eq(t.communities.slug, 'pre-0016'));
      expect(existing).toBeDefined();
      expect(existing?.deprovisionedAt).toBeNull();

      await db
        .update(t.communities)
        .set({ deprovisionedAt: nowMs + 5000 })
        .where(eq(t.communities.id, existing!.id));

      const [updated] = await db
        .select({ deprovisionedAt: t.communities.deprovisionedAt })
        .from(t.communities)
        .where(eq(t.communities.id, existing!.id));
      expect(updated?.deprovisionedAt).toBe(nowMs + 5000);
      sqlite.close();

      // Fresh migrate() through 0016 also succeeds.
      const freshSqlite = new Sqlite(path.join(tmpDir, 'fresh.db'));
      freshSqlite.pragma('foreign_keys = ON');
      const freshDb = drizzle(freshSqlite);
      migrate(freshDb, { migrationsFolder: 'src/db/migrations' });
      const freshCols = freshSqlite
        .prepare('PRAGMA table_info(communities)')
        .all() as Array<{ name: string; notnull: number }>;
      expect(
        freshCols.find((c) => c.name === 'deprovisioned_at')?.notnull
      ).toBe(0);
      freshSqlite.close();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
