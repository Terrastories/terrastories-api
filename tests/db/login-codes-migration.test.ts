import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { hash } from 'bcrypt';
import { tablesFor } from '../../src/db/dialect.js';
import { sha256Hex, toHex } from '../../src/shared/auth-crypto.js';

describe('0014 migration: sessions step-up column and login_codes (user_id, purpose) index', () => {
  it('adds admin_code_step_up_expires_at cleanly over existing session rows and indexes (user_id, purpose)', async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'ts-0014-mig-'));
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
      const [comm] = await db
        .insert(t.communities)
        .values({
          name: 'Mig Alpha',
          slug: 'mig-alpha',
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
      const [user] = await db
        .insert(t.users)
        .values({
          email: 'mig@example.test',
          username: 'mig_admin',
          emailNormalized: 'mig@example.test',
          usernameNormalized: 'mig_admin',
          firstName: 'Mig',
          lastName: 'Admin',
          passwordHash,
          role: 'admin',
          communityId: comm.id,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: t.users.id });
      const tokenHash = await sha256Hex('existing-session-token');
      const nowMs = now.getTime();
      sqlite
        .prepare(
          `INSERT INTO sessions (id, token_hash, user_id, expires_at, kind, created_at, last_seen_at, idle_expires_at, absolute_expires_at)
           VALUES (?, ?, ?, ?, 'standard', ?, ?, ?, ?)`
        )
        .run(
          tokenHash,
          tokenHash,
          user.id,
          nowMs + 3600_000,
          nowMs,
          nowMs,
          nowMs + 3600_000,
          nowMs + 86400_000
        );

      const sql0014 = readFileSync(
        path.join(
          migrationsDir,
          '0014_session_admin_code_step_up_and_login_code_idx.sql'
        ),
        'utf8'
      );
      for (const stmt of sql0014.split('--> statement-breakpoint')) {
        if (stmt.trim()) sqlite.exec(stmt);
      }

      const cols = sqlite
        .prepare('PRAGMA table_info(sessions)')
        .all() as Array<{
        name: string;
        notnull: number;
      }>;
      const stepUpCol = cols.find(
        (col) => col.name === 'admin_code_step_up_expires_at'
      );
      expect(stepUpCol).toBeDefined();
      expect(stepUpCol?.notnull).toBe(0);

      const existing = sqlite
        .prepare(
          'SELECT admin_code_step_up_expires_at FROM sessions WHERE id = ?'
        )
        .get(tokenHash) as { admin_code_step_up_expires_at: number | null };
      expect(existing.admin_code_step_up_expires_at).toBeNull();

      const plan = sqlite
        .prepare(
          "EXPLAIN QUERY PLAN SELECT id FROM login_codes WHERE user_id = 1 AND purpose = 'recovery' AND used_at IS NULL AND superseded_at IS NULL LIMIT 1"
        )
        .all() as Array<{ detail: string }>;
      expect(
        plan.some((row) => row.detail.includes('login_codes_user_purpose_idx'))
      ).toBe(true);
      sqlite.close();

      // Fresh migrate check via Drizzle migrator too.
      const freshSqlite = new Sqlite(':memory:');
      freshSqlite.pragma('foreign_keys = ON');
      migrate(drizzle(freshSqlite), { migrationsFolder: 'src/db/migrations' });
      const freshCols = freshSqlite
        .prepare('PRAGMA table_info(sessions)')
        .all() as Array<{ name: string }>;
      expect(
        freshCols.some((c) => c.name === 'admin_code_step_up_expires_at')
      ).toBe(true);
      freshSqlite.close();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
