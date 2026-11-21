import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { hash } from 'bcrypt';
import { tablesFor } from '../../src/db/dialect.js';
import { toHex } from '../../src/shared/auth-crypto.js';

describe('0015 migration: import_manifests schema, composite FK, CHECKs, and indexes', () => {
  it('upgrades from 0014 cleanly, enforces composite FK & CHECK constraints, and indexes listing/daily queries', async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'ts-0015-mig-'));
    try {
      const sqlite = new Sqlite(path.join(tmpDir, 'upgrade.db'));
      sqlite.pragma('foreign_keys = ON');
      const migrationsDir = path.resolve('src/db/migrations');
      const files = [
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
      ];
      for (const file of files) {
        const sqlText = readFileSync(path.join(migrationsDir, file), 'utf8');
        for (const stmt of sqlText.split('--> statement-breakpoint')) {
          if (stmt.trim()) sqlite.exec(stmt);
        }
      }

      const db = drizzle(sqlite);
      const t = tablesFor(db);
      const now = new Date('2026-06-01T12:00:00.000Z');
      const nowMs = now.getTime();
      const [comm1] = await db
        .insert(t.communities)
        .values({
          name: 'Import Mig Alpha',
          slug: 'import-mig-alpha',
          locale: 'en',
          publicStories: false,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: t.communities.id });
      const [comm2] = await db
        .insert(t.communities)
        .values({
          name: 'Import Mig Beta',
          slug: 'import-mig-beta',
          locale: 'en',
          publicStories: false,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: t.communities.id });
      const passwordHash = await hash(
        toHex(crypto.getRandomValues(new Uint8Array(16))),
        4
      );
      const [user1] = await db
        .insert(t.users)
        .values({
          email: 'imp-editor@example.test',
          username: 'imp_editor',
          emailNormalized: 'imp-editor@example.test',
          usernameNormalized: 'imp_editor',
          firstName: 'Imp',
          lastName: 'Editor',
          passwordHash,
          role: 'editor',
          communityId: comm1.id,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: t.users.id });

      const csv1Id = '11111111-1111-4111-8111-111111111111';
      const csv2Id = '22222222-2222-4222-8222-222222222222';
      const nullFileId = '33333333-3333-4333-8333-333333333333';
      await db.insert(t.files).values([
        {
          id: csv1Id,
          filename: csv1Id,
          originalName: 'c1.csv',
          path: `communities/${comm1.id}/imports/${csv1Id}`,
          storageKey: `communities/${comm1.id}/imports/${csv1Id}`,
          url: `/v2/media/${csv1Id}`,
          mimeType: 'text/csv',
          size: 12,
          byteSize: 12,
          checksum: 'a'.repeat(64),
          communityId: comm1.id,
          uploadedBy: user1.id,
          isActive: false,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: csv2Id,
          filename: csv2Id,
          originalName: 'c2.csv',
          path: `communities/${comm2.id}/imports/${csv2Id}`,
          storageKey: `communities/${comm2.id}/imports/${csv2Id}`,
          url: `/v2/media/${csv2Id}`,
          mimeType: 'text/csv',
          size: 12,
          byteSize: 12,
          checksum: 'b'.repeat(64),
          communityId: comm2.id,
          uploadedBy: null,
          isActive: false,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: nullFileId,
          filename: nullFileId,
          originalName: 'null.csv',
          path: `users/${user1.id}/media/${nullFileId}`,
          storageKey: `users/${user1.id}/media/${nullFileId}`,
          url: `/v2/media/${nullFileId}`,
          mimeType: 'text/csv',
          size: 12,
          byteSize: 12,
          checksum: 'c'.repeat(64),
          communityId: null,
          uploadedBy: user1.id,
          isActive: false,
          createdAt: now,
          updatedAt: now,
        },
      ]);

      const sql0015 = readFileSync(
        path.join(migrationsDir, '0015_import_manifests.sql'),
        'utf8'
      );
      for (const stmt of sql0015.split('--> statement-breakpoint')) {
        if (stmt.trim()) sqlite.exec(stmt);
      }

      // Cross-community source_file_id must be rejected by composite FK.
      expect(() =>
        sqlite
          .prepare(
            `INSERT INTO import_manifests (community_id, kind, status, created_by, source_file_name, source_file_id, mappings, normalized_rows, row_count, row_errors, staged_file_ids, created_at)
             VALUES (?, 'places', 'previewed', ?, 'c2.csv', ?, '{}', '{}', 0, '[]', '[]', ?)`
          )
          .run(comm1.id, user1.id, csv2Id, nowMs)
      ).toThrow();

      // Null-community file must also be rejected by composite FK.
      expect(() =>
        sqlite
          .prepare(
            `INSERT INTO import_manifests (community_id, kind, status, created_by, source_file_name, source_file_id, mappings, normalized_rows, row_count, row_errors, staged_file_ids, created_at)
             VALUES (?, 'places', 'previewed', ?, 'null.csv', ?, '{}', '{}', 0, '[]', '[]', ?)`
          )
          .run(comm1.id, user1.id, nullFileId, nowMs)
      ).toThrow();

      // CHECK constraints reject invalid kind/status/row_count/committed_at pairs.
      expect(() =>
        sqlite
          .prepare(
            `INSERT INTO import_manifests (community_id, kind, status, created_by, source_file_name, source_file_id, mappings, normalized_rows, row_count, row_errors, staged_file_ids, created_at)
             VALUES (?, 'users', 'previewed', ?, 'c1.csv', ?, '{}', '{}', 0, '[]', '[]', ?)`
          )
          .run(comm1.id, user1.id, csv1Id, nowMs)
      ).toThrow();
      expect(() =>
        sqlite
          .prepare(
            `INSERT INTO import_manifests (community_id, kind, status, created_by, source_file_name, source_file_id, mappings, normalized_rows, row_count, row_errors, staged_file_ids, created_at)
             VALUES (?, 'places', 'committing', ?, 'c1.csv', ?, '{}', '{}', 0, '[]', '[]', ?)`
          )
          .run(comm1.id, user1.id, csv1Id, nowMs)
      ).toThrow();
      expect(() =>
        sqlite
          .prepare(
            `INSERT INTO import_manifests (community_id, kind, status, created_by, source_file_name, source_file_id, mappings, normalized_rows, row_count, row_errors, staged_file_ids, created_at)
             VALUES (?, 'places', 'previewed', ?, 'c1.csv', ?, '{}', '{}', -1, '[]', '[]', ?)`
          )
          .run(comm1.id, user1.id, csv1Id, nowMs)
      ).toThrow();
      expect(() =>
        sqlite
          .prepare(
            `INSERT INTO import_manifests (community_id, kind, status, created_by, source_file_name, source_file_id, mappings, normalized_rows, row_count, row_errors, staged_file_ids, committed_at, created_at)
             VALUES (?, 'places', 'committed', ?, 'c1.csv', ?, '{}', '{}', 1, '[]', '[]', NULL, ?)`
          )
          .run(comm1.id, user1.id, csv1Id, nowMs)
      ).toThrow();
      expect(() =>
        sqlite
          .prepare(
            `INSERT INTO import_manifests (community_id, kind, status, created_by, source_file_name, source_file_id, mappings, normalized_rows, row_count, row_errors, staged_file_ids, committed_at, created_at)
             VALUES (?, 'places', 'previewed', ?, 'c1.csv', ?, '{}', '{}', 1, '[]', '[]', ?, ?)`
          )
          .run(comm1.id, user1.id, csv1Id, nowMs, nowMs)
      ).toThrow();

      // Valid insert + ON DELETE SET NULL on created_by.
      sqlite
        .prepare(
          `INSERT INTO import_manifests (community_id, kind, status, created_by, source_file_name, source_file_id, mappings, normalized_rows, row_count, row_errors, staged_file_ids, created_at)
           VALUES (?, 'places', 'previewed', ?, 'c1.csv', ?, '{}', '{}', 1, '[]', '[]', ?)`
        )
        .run(comm1.id, user1.id, csv1Id, nowMs);

      sqlite
        .prepare('UPDATE files SET uploaded_by = NULL WHERE uploaded_by = ?')
        .run(user1.id);
      sqlite.prepare('DELETE FROM users WHERE id = ?').run(user1.id);
      const retained = sqlite
        .prepare(
          'SELECT community_id, created_by, status FROM import_manifests WHERE source_file_id = ?'
        )
        .get(csv1Id) as {
        community_id: number;
        created_by: number | null;
        status: string;
      };
      expect(retained).toEqual({
        community_id: comm1.id,
        created_by: null,
        status: 'previewed',
      });

      // Indexes used by list and D1 daily limit queries.
      const listPlan = sqlite
        .prepare(
          'EXPLAIN QUERY PLAN SELECT id FROM import_manifests WHERE community_id = ? ORDER BY created_at DESC, id DESC LIMIT 20'
        )
        .all(comm1.id) as Array<{ detail: string }>;
      expect(
        listPlan.some((r) =>
          r.detail.includes('import_manifests_community_created_idx')
        )
      ).toBe(true);

      const dailyPlan = sqlite
        .prepare(
          "EXPLAIN QUERY PLAN SELECT id FROM import_manifests WHERE status = 'committed' AND committed_at >= ? AND committed_at < ? LIMIT 1"
        )
        .all(nowMs, nowMs + 86400_000) as Array<{ detail: string }>;
      expect(
        dailyPlan.some((r) =>
          r.detail.includes('import_manifests_status_committed_at_idx')
        )
      ).toBe(true);

      sqlite.close();

      // Fresh migrate check via Drizzle migrator.
      const freshSqlite = new Sqlite(':memory:');
      freshSqlite.pragma('foreign_keys = ON');
      migrate(drizzle(freshSqlite), { migrationsFolder: 'src/db/migrations' });
      const cols = freshSqlite
        .prepare('PRAGMA table_info(import_manifests)')
        .all() as Array<{ name: string }>;
      expect(cols.map((c) => c.name)).toEqual([
        'id',
        'community_id',
        'kind',
        'status',
        'created_by',
        'source_file_name',
        'source_file_id',
        'mappings',
        'normalized_rows',
        'row_count',
        'row_errors',
        'staged_file_ids',
        'result_summary',
        'committed_at',
        'created_at',
      ]);
      freshSqlite.close();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
