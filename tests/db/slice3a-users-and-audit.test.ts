import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as schema from '../../src/db/schema/index.js';
import { insertUserSchema, usersSqlite } from '../../src/db/schema/users.js';
import { communitiesSqlite } from '../../src/db/schema/communities.js';
import { sessionsSqlite } from '../../src/db/schema/sessions.js';
import { auditEntriesSqlite } from '../../src/db/schema/audit_entries.js';
import {
  IdentityNormalizationCollisionError,
  backfillUserIdentity,
} from '../../src/db/backfill-user-identity.js';
import {
  scrubExpiredAuditNetworkMetadata,
  writeAuditEntry,
} from '../../src/repositories/audit-entry.repository.js';
import { UserRepository } from '../../src/repositories/user.repository.js';
import { CommunityRepository } from '../../src/repositories/community.repository.js';
import { AuditEntryValidationError } from '../../src/shared/utils/audit-entry.js';
import { normalizeSearchText } from '../../src/shared/utils/search-normalize.js';
import {
  applyD1Migrations,
  bundleWorkerModule,
  startWorkerRuntime,
} from '../helpers/worker-runtime.js';

const migrationsFolder = path.resolve(process.cwd(), 'src/db/migrations');

function createPre0009Folder(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsapi-pre0009-'));
  fs.mkdirSync(path.join(tmpDir, 'meta'), { recursive: true });
  const journal = JSON.parse(
    fs.readFileSync(
      path.join(migrationsFolder, 'meta', '_journal.json'),
      'utf8'
    )
  ) as { version: string; dialect: string; entries: Array<{ tag: string }> };
  const pre0009 = journal.entries.filter((e) => !e.tag.startsWith('0009_'));
  fs.writeFileSync(
    path.join(tmpDir, 'meta', '_journal.json'),
    JSON.stringify({ ...journal, entries: pre0009 }, null, 2)
  );
  for (const e of pre0009) {
    fs.copyFileSync(
      path.join(migrationsFolder, `${e.tag}.sql`),
      path.join(tmpDir, `${e.tag}.sql`)
    );
  }
  return tmpDir;
}

describe('Slice 3a SQLite schema, 0009 migration, identity backfill, triggers, and audit_entries', () => {
  const openDbs: Database.Database[] = [];
  const tempDirs: string[] = [];

  afterEach(() => {
    while (openDbs.length > 0) openDbs.pop()?.close();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function setupDb(folder = migrationsFolder) {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    openDbs.push(sqlite);
    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: folder });
    return { sqlite, db };
  }

  it('backfills ASCII email_normalized and display_name in 0009, leaves non-ASCII NULL for idempotent backfillUserIdentity, and preserves sessions', async () => {
    const preFolder = createPre0009Folder();
    tempDirs.push(preFolder);
    const { sqlite, db } = setupDb(preFolder);

    const now = Date.now();
    const commId = Number(
      sqlite
        .prepare(
          `INSERT INTO communities (name, slug, created_at, updated_at) VALUES ('C1', 'c1', ?, ?)`
        )
        .run(now, now).lastInsertRowid
    );
    const asciiId = Number(
      sqlite
        .prepare(
          `INSERT INTO users (email, password_hash, first_name, last_name, role, community_id, created_at, updated_at) VALUES ('Alice.Test@EXAMPLE.ORG', 'h', 'Ada', 'Lovelace', 'admin', ?, ?, ?)`
        )
        .run(commId, now, now).lastInsertRowid
    );
    const nonAsciiId = Number(
      sqlite
        .prepare(
          `INSERT INTO users (email, password_hash, first_name, last_name, role, community_id, created_at, updated_at) VALUES ('ΜΆΡΊΑ@example.org', 'h', '  María ', '', 'viewer', ?, ?, ?)`
        )
        .run(commId, now, now).lastInsertRowid
    );
    sqlite
      .prepare(
        `INSERT INTO sessions (id, token_hash, user_id, expires_at) VALUES ('sess-keep', 'th-keep', ?, ?)`
      )
      .run(asciiId, now + 60_000);

    migrate(db, { migrationsFolder });

    const asciiRow = sqlite
      .prepare('SELECT email_normalized, display_name FROM users WHERE id = ?')
      .get(asciiId) as {
      email_normalized: string | null;
      display_name: string | null;
    };
    expect(asciiRow).toEqual({
      email_normalized: 'alice.test@example.org',
      display_name: 'Ada Lovelace',
    });

    const nonAsciiRow = sqlite
      .prepare('SELECT email_normalized, display_name FROM users WHERE id = ?')
      .get(nonAsciiId) as {
      email_normalized: string | null;
      display_name: string | null;
    };
    expect(nonAsciiRow).toEqual({
      email_normalized: null,
      display_name: 'María',
    });
    expect(
      sqlite.prepare('SELECT id FROM sessions WHERE id = ?').get('sess-keep')
    ).toBeTruthy();

    expect((await backfillUserIdentity(db)).updated).toBe(1);
    const after = sqlite
      .prepare('SELECT email_normalized FROM users WHERE id = ?')
      .get(nonAsciiId) as { email_normalized: string | null };
    expect(after.email_normalized).toBe(
      normalizeSearchText('ΜΆΡΊΑ@example.org')
    );
    expect((await backfillUserIdentity(db)).updated).toBe(0);
  });

  it('aborts migration 0009 before rename when pre-existing ASCII emails collide case-insensitively', () => {
    const preFolder = createPre0009Folder();
    tempDirs.push(preFolder);
    const { sqlite, db } = setupDb(preFolder);

    const now = Date.now();
    const commId = Number(
      sqlite
        .prepare(
          `INSERT INTO communities (name, slug, created_at, updated_at) VALUES ('CC', 'cc', ?, ?)`
        )
        .run(now, now).lastInsertRowid
    );
    sqlite
      .prepare(
        `INSERT INTO users (email, password_hash, first_name, last_name, role, community_id, created_at, updated_at) VALUES ('Alice@example.org', 'h', 'A', '1', 'viewer', ?, ?, ?), ('alice@example.org', 'h', 'A', '2', 'viewer', ?, ?, ?)`
      )
      .run(commId, now, now, commId, now, now);

    expect(() => migrate(db, { migrationsFolder })).toThrow();
    expect(
      (
        sqlite.prepare('SELECT count(*) AS count FROM users').get() as {
          count: number;
        }
      ).count
    ).toBe(2);
    expect(
      sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='users_old'"
        )
        .all()
    ).toHaveLength(0);
  });

  it('enforces normalized unique rules, nullable community_id, member role, V1 Zod check, and collision detection', async () => {
    const { db } = setupDb();
    const [commA] = await db
      .insert(communitiesSqlite)
      .values({ name: 'A', slug: 'a' })
      .returning();
    const [commB] = await db
      .insert(communitiesSqlite)
      .values({ name: 'B', slug: 'b' })
      .returning();

    expect(
      insertUserSchema.safeParse({
        email: 'root@example.org',
        passwordHash: 'h',
        firstName: 'Root',
        lastName: 'Admin',
        role: 'super_admin',
        communityId: null,
      }).success
    ).toBe(false);

    const [root] = await db
      .insert(usersSqlite)
      .values({
        email: 'Root@Example.ORG',
        emailNormalized: normalizeSearchText('Root@Example.ORG'),
        username: 'RootAdmin',
        usernameNormalized: normalizeSearchText('RootAdmin'),
        passwordHash: 'h',
        firstName: 'Root',
        lastName: 'Admin',
        role: 'super_admin',
        communityId: null,
      })
      .returning();
    expect(root.communityId).toBeNull();

    const [mA] = await db
      .insert(usersSqlite)
      .values({
        email: 'Member@Example.ORG',
        emailNormalized: normalizeSearchText('Member@Example.ORG'),
        passwordHash: 'h',
        firstName: 'Mem',
        lastName: 'A',
        role: 'member',
        communityId: commA.id,
      })
      .returning();
    expect(mA.role).toBe('member');

    // Same email normalized allowed across distinct communities
    await db.insert(usersSqlite).values({
      email: 'member@example.org',
      emailNormalized: normalizeSearchText('member@example.org'),
      passwordHash: 'h',
      firstName: 'Mem',
      lastName: 'B',
      role: 'member',
      communityId: commB.id,
    });

    const dupFail = (values: typeof usersSqlite.$inferInsert) =>
      expect(() => db.insert(usersSqlite).values(values).run()).toThrow();

    // Global username_normalized collision
    dupFail({
      email: 'other@example.org',
      emailNormalized: 'other@example.org',
      username: 'rootadmin',
      usernameNormalized: normalizeSearchText('rootadmin'),
      passwordHash: 'h',
      firstName: 'D',
      lastName: '1',
      role: 'viewer',
      communityId: commB.id,
    });
    // Same-community email_normalized collision
    dupFail({
      email: 'MEMBER@EXAMPLE.ORG',
      emailNormalized: normalizeSearchText('MEMBER@EXAMPLE.ORG'),
      passwordHash: 'h',
      firstName: 'D',
      lastName: '2',
      role: 'viewer',
      communityId: commA.id,
    });
    // Partial unique email_normalized WHERE community_id IS NULL collision
    dupFail({
      email: 'root@example.org',
      emailNormalized: normalizeSearchText('root@example.org'),
      passwordHash: 'h',
      firstName: 'D',
      lastName: '3',
      role: 'super_admin',
      communityId: null,
    });

    // Non-ASCII rows with NULL email_normalized coexist until app backfill detects collision
    await db.insert(usersSqlite).values([
      {
        email: 'Άλφα@example.org',
        emailNormalized: null,
        passwordHash: 'h',
        firstName: 'G1',
        lastName: 'U',
        role: 'viewer',
        communityId: commA.id,
      },
      {
        email: 'άλφα@example.org',
        emailNormalized: null,
        passwordHash: 'h',
        firstName: 'G2',
        lastName: 'U',
        role: 'viewer',
        communityId: commA.id,
      },
    ]);
    await expect(backfillUserIdentity(db)).rejects.toThrow(
      IdentityNormalizationCollisionError
    );
  });

  it('revokes sessions on password_verifier, role, community_id, and community is_active updates, and writes/scrubs audit_entries', async () => {
    const { db } = setupDb();
    const [commA] = await db
      .insert(communitiesSqlite)
      .values({ name: 'CA', slug: 'ca' })
      .returning();
    const [commB] = await db
      .insert(communitiesSqlite)
      .values({ name: 'CB', slug: 'cb' })
      .returning();
    const [user] = await db
      .insert(usersSqlite)
      .values({
        email: 'u@example.org',
        emailNormalized: 'u@example.org',
        passwordHash: 'h',
        passwordVerifier: 'v1',
        firstName: 'U',
        lastName: '1',
        role: 'viewer',
        communityId: commA.id,
      })
      .returning();
    const [sa] = await db
      .insert(usersSqlite)
      .values({
        email: 'sa@example.org',
        emailNormalized: 'sa@example.org',
        passwordHash: 'h',
        firstName: 'S',
        lastName: 'A',
        role: 'super_admin',
        communityId: null,
      })
      .returning();

    const seed = (id: string, userId: number) =>
      db.insert(sessionsSqlite).values({
        id,
        tokenHash: `th-${id}`,
        userId,
        expiresAt: Date.now() + 60_000,
      });
    const countFor = async (userId: number) =>
      (
        await db
          .select()
          .from(sessionsSqlite)
          .where(eq(sessionsSqlite.userId, userId))
      ).length;

    await seed('s0', user.id);
    await db
      .update(usersSqlite)
      .set({ displayName: 'Keep Session' })
      .where(eq(usersSqlite.id, user.id));
    expect(await countFor(user.id)).toBe(1);

    for (const patch of [
      { passwordVerifier: 'v2' },
      { role: 'member' as const },
      { communityId: commB.id },
    ]) {
      await seed(`s-${Object.keys(patch)[0]}`, user.id);
      await db
        .update(usersSqlite)
        .set(patch)
        .where(eq(usersSqlite.id, user.id));
      expect(await countFor(user.id)).toBe(0);
    }

    await seed('s-comm', user.id);
    await db
      .update(communitiesSqlite)
      .set({ isActive: false })
      .where(eq(communitiesSqlite.id, commB.id));
    expect(await countFor(user.id)).toBe(0);

    const now = new Date();
    const [oldEntry] = await db
      .insert(auditEntriesSqlite)
      .values({
        communityId: commA.id,
        actorId: sa.id,
        action: 'claim_token.issue',
        resourceType: 'claim_token',
        resourceIds: [15],
        outcome: 'success',
        ipAddress: '203.0.113.9',
        userAgent: 'OldUA/1.0',
        createdAt: new Date(now.getTime() - 95 * 86_400_000),
      })
      .returning();
    const freshEntry = await writeAuditEntry(db, {
      communityId: null,
      actorId: sa.id,
      action: 'auth.login',
      resourceType: 'session',
      resourceIds: ['sess_2'],
      outcome: 'success',
      ipAddress: '203.0.113.10',
      userAgent: 'NewUA/2.0',
    });

    await expect(
      writeAuditEntry(db, {
        communityId: null,
        actorId: sa.id,
        action: 'auth.login',
        resourceType: 'session',
        outcome: 'success',
        createdAt: new Date(now.getTime() - 200 * 86_400_000),
      } as unknown as Parameters<typeof writeAuditEntry>[1])
    ).rejects.toThrow(AuditEntryValidationError);
    await expect(
      writeAuditEntry(db, {
        communityId: null,
        actorId: sa.id,
        action: 'story.publish',
        resourceType: 'story',
        resourceIds: [1],
        outcome: 'success',
      })
    ).rejects.toThrow(AuditEntryValidationError);

    expect(
      (await scrubExpiredAuditNetworkMetadata(db, { now })).scrubbedCount
    ).toBe(1);
    const [oldAfter] = await db
      .select()
      .from(auditEntriesSqlite)
      .where(eq(auditEntriesSqlite.id, oldEntry.id));
    const [freshAfter] = await db
      .select()
      .from(auditEntriesSqlite)
      .where(eq(auditEntriesSqlite.id, freshEntry.id));
    expect(oldAfter.ipAddress).toBeNull();
    expect(oldAfter.userAgent).toBeNull();
    expect(oldAfter.resourceIds).toEqual([15]);
    expect(freshAfter.ipAddress).toBe('203.0.113.10');

    // ON DELETE NO ACTION: referenced user and community cannot be deleted while audit entries exist.
    expect(() =>
      db.delete(usersSqlite).where(eq(usersSqlite.id, sa.id)).run()
    ).toThrow();
    expect(() =>
      db
        .delete(communitiesSqlite)
        .where(eq(communitiesSqlite.id, commA.id))
        .run()
    ).toThrow();

    // Explicit erasure deletes audit entries first, then parent deletion succeeds.
    await db
      .delete(auditEntriesSqlite)
      .where(eq(auditEntriesSqlite.communityId, commA.id));
    await db
      .delete(auditEntriesSqlite)
      .where(eq(auditEntriesSqlite.actorId, sa.id));
    await db.delete(usersSqlite).where(eq(usersSqlite.id, sa.id));
  });

  it('keeps emailNormalized in sync on every repository write and repairs V1 drift in backfillUserIdentity without false collisions', async () => {
    const { sqlite, db } = setupDb();
    const userRepo = new UserRepository(db);
    const communityRepo = new CommunityRepository(db);

    const [commA] = await db
      .insert(communitiesSqlite)
      .values({ name: 'SyncA', slug: 'sync-a' })
      .returning();
    const [commB] = await db
      .insert(communitiesSqlite)
      .values({ name: 'SyncB', slug: 'sync-b' })
      .returning();

    const firstAdmin = await communityRepo.provisionFirstAdministrator({
      email: 'First.Admin@EXAMPLE.ORG',
      passwordHash: 'h',
      firstName: 'First',
      lastName: 'Admin',
      role: 'admin',
      communityId: commB.id,
      isActive: true,
    });
    expect(firstAdmin?.emailNormalized).toBe('first.admin@example.org');

    const created = await userRepo.create({
      email: 'ΜΆΡΊΑ@EXAMPLE.ORG',
      passwordHash: 'h',
      firstName: 'Maria',
      lastName: 'K',
      role: 'viewer',
      communityId: commA.id,
    });
    expect(created.emailNormalized).toBe(
      normalizeSearchText('ΜΆΡΊΑ@EXAMPLE.ORG')
    );

    const updated = await userRepo.update(
      created.id,
      { email: '  Updated.Maria@EXAMPLE.ORG ' },
      commA.id
    );
    expect(updated?.email).toBe('updated.maria@example.org');
    expect(updated?.emailNormalized).toBe('updated.maria@example.org');

    const casResult = await userRepo.compareAndSetMembership(
      created.id,
      { role: 'viewer', isActive: true, communityId: commA.id },
      { email: 'CAS.Maria@EXAMPLE.ORG', role: 'member' }
    );
    expect(casResult.status).toBe('updated');
    if (casResult.status === 'updated') {
      expect(casResult.user.email).toBe('cas.maria@example.org');
      expect(casResult.user.emailNormalized).toBe('cas.maria@example.org');
    }

    const saUpdated = await userRepo.updateByIdAsSuperAdmin(created.id, {
      email: 'Super.Maria@EXAMPLE.ORG',
    });
    expect(saUpdated.emailNormalized).toBe('super.maria@example.org');

    // Simulate a V1 email change that left email_normalized stale while another
    // account legitimately claims the old email (and also test swapped drift).
    const otherUser = await userRepo.create({
      email: 'old.slot@example.org',
      passwordHash: 'h',
      firstName: 'Other',
      lastName: 'User',
      role: 'viewer',
      communityId: commA.id,
    });
    sqlite
      .prepare('UPDATE users SET email = ? WHERE id = ?')
      .run('brand.new@example.org', otherUser.id);
    // Insert a second user taking old.slot@example.org with NULL email_normalized
    // (as if pre-backfill); backfill must recompute otherUser's new email instead
    // of keeping stale 'old.slot@example.org' and throwing a false collision.
    await db.insert(usersSqlite).values({
      email: 'old.slot@example.org',
      emailNormalized: null,
      passwordHash: 'h',
      firstName: 'New',
      lastName: 'Holder',
      role: 'viewer',
      communityId: commA.id,
    });

    const result = await backfillUserIdentity(db);
    expect(result.drifted).toBe(1);
    expect(result.driftedUserIds).toEqual([otherUser.id]);
    expect(result.updated).toBe(4); // otherUser + New Holder emailNormalized + displayName backfill

    const [repaired] = await db
      .select()
      .from(usersSqlite)
      .where(eq(usersSqlite.id, otherUser.id));
    expect(repaired.emailNormalized).toBe('brand.new@example.org');

    const [newHolder] = await db
      .select()
      .from(usersSqlite)
      .where(eq(usersSqlite.email, 'old.slot@example.org'));
    expect(newHolder.emailNormalized).toBe('old.slot@example.org');

    const secondPass = await backfillUserIdentity(db);
    expect(secondPass.updated).toBe(0);
    expect(secondPass.drifted).toBe(0);
  });

  it('detects SPEC-V2 §6.2 cross-boundary collisions in backfillUserIdentity (null-community share and username-vs-email)', async () => {
    const { db } = setupDb();
    const [comm] = await db
      .insert(communitiesSqlite)
      .values({ name: 'Col', slug: 'col' })
      .returning();

    // 1. Null-community account sharing email with a community account
    await db.insert(usersSqlite).values([
      {
        email: 'Shared@Example.ORG',
        emailNormalized: null,
        passwordHash: 'h',
        firstName: 'Community',
        lastName: 'User',
        role: 'admin',
        communityId: comm.id,
      },
      {
        email: 'shared@example.org',
        emailNormalized: null,
        passwordHash: 'h',
        firstName: 'Super',
        lastName: 'Admin',
        role: 'super_admin',
        communityId: null,
      },
    ]);

    await expect(backfillUserIdentity(db)).rejects.toThrow(
      IdentityNormalizationCollisionError
    );

    // Clear and test username matching another account's email (normalized)
    await db.delete(usersSqlite);
    await db.insert(usersSqlite).values([
      {
        email: 'Person.One@Example.ORG',
        emailNormalized: null,
        username: 'person.one@example.org', // own email as own username is allowed
        usernameNormalized: null,
        passwordHash: 'h',
        firstName: 'P1',
        lastName: 'U',
        role: 'viewer',
        communityId: comm.id,
      },
    ]);
    expect((await backfillUserIdentity(db)).updated).toBe(1);

    await db.insert(usersSqlite).values({
      email: 'second@example.org',
      emailNormalized: null,
      username: 'PERSON.ONE@EXAMPLE.ORG', // matches Person.One's email -> must fail!
      usernameNormalized: null,
      passwordHash: 'h',
      firstName: 'P2',
      lastName: 'U',
      role: 'viewer',
      communityId: comm.id,
    });
    await expect(backfillUserIdentity(db)).rejects.toThrow(
      IdentityNormalizationCollisionError
    );
  });

  it('preserves sqlite_sequence high-water mark for rebuilt users table in SQLite 0009 and D1 (Miniflare)', async () => {
    const preFolder = createPre0009Folder();
    tempDirs.push(preFolder);

    // 1. better-sqlite3: delete max-id row before 0009 -> next insert gets id 4
    const { sqlite, db } = setupDb(preFolder);
    const now = Date.now();
    const commId = Number(
      sqlite
        .prepare(
          `INSERT INTO communities (name, slug, created_at, updated_at) VALUES ('SeqC', 'seq-c', ?, ?)`
        )
        .run(now, now).lastInsertRowid
    );
    for (const email of ['u1@e.org', 'u2@e.org', 'u3@e.org']) {
      sqlite
        .prepare(
          `INSERT INTO users (email, password_hash, first_name, last_name, role, community_id, created_at, updated_at) VALUES (?, 'h', 'F', 'L', 'viewer', ?, ?, ?)`
        )
        .run(email, commId, now, now);
    }
    sqlite.prepare('DELETE FROM users WHERE id = 3').run();
    migrate(db, { migrationsFolder });

    const [insertedAfter] = await db
      .insert(usersSqlite)
      .values({
        email: 'u4@e.org',
        emailNormalized: 'u4@e.org',
        passwordHash: 'h',
        firstName: 'F',
        lastName: 'L',
        role: 'viewer',
        communityId: commId,
      })
      .returning();
    expect(insertedAfter.id).toBe(4);

    // 2. Miniflare / workerd D1: verify D1 permits writing sqlite_sequence in 0009
    const mf = startWorkerRuntime(
      await bundleWorkerModule(
        `import worker from './src/worker.js'; export default worker;`
      )
    );
    try {
      const d1 = await mf.getD1Database('DB');
      await applyD1Migrations(d1, preFolder);
      await d1.batch([
        d1
          .prepare(
            `INSERT INTO communities (name, slug, created_at, updated_at) VALUES ('D1C', 'd1-c', ?, ?)`
          )
          .bind(now, now),
        d1
          .prepare(
            `INSERT INTO users (email, password_hash, first_name, last_name, role, community_id, created_at, updated_at) VALUES ('d1-1@e.org', 'h', 'A', '1', 'viewer', 1, ?, ?)`
          )
          .bind(now, now),
        d1
          .prepare(
            `INSERT INTO users (email, password_hash, first_name, last_name, role, community_id, created_at, updated_at) VALUES ('d1-2@e.org', 'h', 'A', '2', 'viewer', 1, ?, ?)`
          )
          .bind(now, now),
        d1.prepare('DELETE FROM users WHERE id = 2'),
      ]);

      const sql0009 = fs.readFileSync(
        path.join(
          migrationsFolder,
          '0009_users_identity_and_audit_entries.sql'
        ),
        'utf8'
      );
      const statements0009 = sql0009
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter(Boolean);
      await d1.batch(statements0009.map((s) => d1.prepare(s)));

      await d1
        .prepare(
          `INSERT INTO users (email, email_normalized, password_hash, first_name, last_name, role, community_id, created_at, updated_at) VALUES ('d1-3@e.org', 'd1-3@e.org', 'h', 'A', '3', 'viewer', 1, ?, ?)`
        )
        .bind(now, now)
        .run();
      const row = (await d1
        .prepare(`SELECT id FROM users WHERE email = 'd1-3@e.org'`)
        .first()) as { id: number } | null;
      expect(row?.id).toBe(3);
    } finally {
      await mf.dispose();
    }
  });
});
