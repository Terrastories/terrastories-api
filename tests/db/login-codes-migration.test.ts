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
      // Seed the historical schema with SQL, independent of later Drizzle columns.
      const comm = sqlite
        .prepare(
          `INSERT INTO communities (name, slug, locale, public_stories, is_active, created_at, updated_at)
        VALUES (?, ?, 'en', 0, 1, ?, ?) RETURNING id`
        )
        .get('Mig Alpha', 'mig-alpha', now.getTime(), now.getTime()) as {
        id: number;
      };
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
      const nowMs = now.getTime();
      sqlite
        .prepare(
          "INSERT INTO auth_throttle (key, kind, community_id, failures, window_started_at, blocked_until) VALUES ('acct-pre-0014', 'account', ?, 3, ?, NULL), ('ip-pre-0014', 'ip', NULL, 1, ?, NULL)"
        )
        .run(comm.id, nowMs, nowMs);
      const tokenHash = await sha256Hex('existing-session-token');
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

      // auth_throttle rebuild in 0014 preserves existing account/ip rows,
      // permits kind='claim' with non-null community_id, and rejects
      // kind='claim' with null community_id or kind='ip' with non-null community_id.
      expect(
        sqlite
          .prepare(
            "SELECT kind, failures FROM auth_throttle WHERE key = 'acct-pre-0014'"
          )
          .get()
      ).toEqual({ kind: 'account', failures: 3 });
      expect(
        sqlite
          .prepare(
            "SELECT kind, failures FROM auth_throttle WHERE key = 'ip-pre-0014'"
          )
          .get()
      ).toEqual({ kind: 'ip', failures: 1 });
      sqlite
        .prepare(
          "INSERT INTO auth_throttle (key, kind, community_id, failures, window_started_at, blocked_until) VALUES ('claim-key-1', 'claim', ?, 2, ?, NULL)"
        )
        .run(comm.id, nowMs);
      expect(() =>
        sqlite
          .prepare(
            "INSERT INTO auth_throttle (key, kind, community_id, failures, window_started_at, blocked_until) VALUES ('claim-bad-null', 'claim', NULL, 1, ?, NULL)"
          )
          .run(nowMs)
      ).toThrow();
      expect(() =>
        sqlite
          .prepare(
            "INSERT INTO auth_throttle (key, kind, community_id, failures, window_started_at, blocked_until) VALUES ('ip-bad-comm', 'ip', ?, 1, ?, NULL)"
          )
          .run(comm.id, nowMs)
      ).toThrow();

      // installation_bootstrap table added in 0014: singleton CHECK (id = 1)
      // and ON DELETE SET NULL on community_id / admin_user_id.
      sqlite
        .prepare(
          'INSERT INTO installation_bootstrap (id, setup_id, community_id, admin_user_id, completed_at) VALUES (1, ?, ?, ?, ?)'
        )
        .run('setup-1', comm.id, user.id, nowMs);
      expect(() =>
        sqlite
          .prepare(
            'INSERT INTO installation_bootstrap (id, setup_id, community_id, admin_user_id, completed_at) VALUES (2, ?, ?, ?, ?)'
          )
          .run('setup-2', comm.id, user.id, nowMs)
      ).toThrow();
      sqlite.prepare('DELETE FROM users WHERE id = ?').run(user.id);
      sqlite.prepare('DELETE FROM communities WHERE id = ?').run(comm.id);
      const retained = sqlite
        .prepare(
          'SELECT id, community_id, admin_user_id FROM installation_bootstrap WHERE id = 1'
        )
        .get() as {
        id: number;
        community_id: number | null;
        admin_user_id: number | null;
      };
      expect(retained).toEqual({
        id: 1,
        community_id: null,
        admin_user_id: null,
      });
      // Community deletion cascades claim and account throttle rows, while ip rows survive.
      expect(
        sqlite
          .prepare(
            "SELECT kind, failures FROM auth_throttle WHERE key = 'claim-key-1'"
          )
          .get()
      ).toBeUndefined();
      expect(
        sqlite
          .prepare(
            "SELECT kind, failures FROM auth_throttle WHERE key = 'acct-pre-0014'"
          )
          .get()
      ).toBeUndefined();
      expect(
        sqlite
          .prepare(
            "SELECT kind, failures FROM auth_throttle WHERE key = 'ip-pre-0014'"
          )
          .get()
      ).toEqual({ kind: 'ip', failures: 1 });
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
      const bootCols = freshSqlite
        .prepare('PRAGMA table_info(installation_bootstrap)')
        .all() as Array<{ name: string }>;
      expect(bootCols.map((c) => c.name)).toEqual([
        'id',
        'setup_id',
        'community_id',
        'admin_user_id',
        'completed_at',
      ]);
      freshSqlite.close();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
