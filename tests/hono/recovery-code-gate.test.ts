/**
 * SPEC-V2 §7 recovery-code gate (#254): a community administrator holding no
 * active recovery code may only use /v2/auth/* until they generate codes.
 */
import { afterEach, describe, expect, it } from 'vitest';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { hash } from 'bcrypt';
import { readFileSync } from 'node:fs';
import { createHonoApp } from '../../src/hono-app.js';
import { HonoFoundationRepository } from '../../src/repositories/hono-foundation.repository.js';
import { communitiesSqlite } from '../../src/db/schema/communities.js';
import { usersSqlite } from '../../src/db/schema/users.js';
import { loginCodesSqlite } from '../../src/db/schema/login_codes.js';
import { sha256Hex } from '../../src/shared/auth-crypto.js';
import { normalizeSearchText } from '../../src/shared/utils/search-normalize.js';
import { makeServerSecret } from './auth-test-utils.js';

describe('recovery-code gate (#254)', () => {
  const openDbs: Sqlite.Database[] = [];
  afterEach(() => {
    while (openDbs.length > 0) openDbs.pop()?.close();
  });

  async function setup(
    role: 'admin' | 'member',
    gate: boolean,
    dropGates = false,
    staleSeen = false
  ) {
    const sqlite = new Sqlite(':memory:');
    sqlite.pragma('foreign_keys = ON');
    openDbs.push(sqlite);
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: 'src/db/migrations' });
    const [community] = await db
      .insert(communitiesSqlite)
      .values({
        name: 'Gate',
        slug: 'gate',
        publicStories: true,
        isActive: true,
      })
      .returning();
    const [user] = await db
      .insert(usersSqlite)
      .values({
        passwordHash: await hash('GatePassword!', 4),
        email: 'gate@example.test',
        username: 'gate_user',
        emailNormalized: normalizeSearchText('gate@example.test'),
        usernameNormalized: normalizeSearchText('gate_user'),
        firstName: 'Gate',
        lastName: 'User',
        role,
        communityId: community.id,
        isActive: true,
      })
      .returning();
    const rawToken = 'b'.repeat(64);
    const nowMs = Date.now();
    sqlite
      .prepare(
        `INSERT INTO sessions (id, token_hash, user_id, expires_at, kind, created_at, last_seen_at, idle_expires_at, absolute_expires_at, revoked_at, revoked_by)
         VALUES (?, ?, ?, ?, 'standard', ?, ?, ?, ?, NULL, NULL)`
      )
      .run(
        'sess-gate',
        await sha256Hex(rawToken),
        user.id,
        nowMs + 12 * 3600_000,
        nowMs,
        staleSeen ? nowMs - 3600_000 : nowMs,
        nowMs + 12 * 3600_000,
        nowMs + 30 * 24 * 3600_000
      );
    const repository = new HonoFoundationRepository(db);
    if (dropGates) {
      // A repository that answers the session but omits the gate state.
      const original = repository.sessionContext.bind(repository);
      repository.sessionContext = async (...args) => {
        const context = await original(...args);
        if (context) delete context.gates;
        return context;
      };
    }
    const app = createHonoApp({
      repository,
      storage: { read: async () => null },
      serverSecret: makeServerSecret(),
      secureCookies: false,
      requireRecoveryCodes: gate,
    });
    const get = (path: string) =>
      app.request(`http://test${path}`, {
        headers: { cookie: `ts_session=${rawToken}` },
      });
    const grantCode = async () => {
      await db.insert(loginCodesSqlite).values({
        communityId: community.id,
        userId: user.id,
        purpose: 'recovery',
        codeHash: await sha256Hex('gate-recovery-code'),
        createdBy: user.id,
        createdAt: nowMs,
        expiresAt: null,
        usedAt: null,
        supersededAt: null,
      });
    };
    return { get, grantCode, sqlite, communityId: community.id, db };
  }

  it('denies an administrator without recovery codes everything but /v2/auth/*', async () => {
    const { get } = await setup('admin', true);
    const denied = await get('/v2/stories');
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({
      code: 'recovery_codes_required',
    });
    expect((await get('/v2/auth/me')).status).toBe(200);
  });

  it('lifts the gate once the administrator holds an active recovery code', async () => {
    const { get, grantCode } = await setup('admin', true);
    expect((await get('/v2/stories')).status).toBe(403);
    await grantCode();
    expect((await get('/v2/stories')).status).toBe(200);
  });

  it('does not gate non-administrators', async () => {
    const { get } = await setup('member', true);
    expect((await get('/v2/stories')).status).toBe(200);
  });

  it('is opt-in per app instance', async () => {
    const { get } = await setup('admin', false);
    expect((await get('/v2/stories')).status).toBe(200);
  });

  it('fails closed when the session read returns no gate state', async () => {
    const { get } = await setup('member', true, true);
    expect((await get('/v2/stories')).status).toBe(403);
    const admin = await setup('admin', true, true);
    expect((await admin.get('/v2/stories')).status).toBe(403);
  });

  const insertErasure = (
    sqlite: Sqlite.Database,
    communityId: number,
    state: string
  ) =>
    sqlite
      .prepare(
        `INSERT INTO community_sovereignty_requests (id, community_id, kind, state, initiated_by_role, requested_at, updated_at)
         VALUES (?, ?, 'erasure', ?, 'admin', 1, 1)`
      )
      .run(`req-${communityId}-${state}`, communityId, state);

  it('denies a member of a community with a pending erasure, from the real predicate', async () => {
    for (const state of ['requested', 'executing']) {
      const { get, sqlite, communityId } = await setup('member', true);
      expect((await get('/v2/stories')).status).toBe(200);
      insertErasure(sqlite, communityId, state);
      expect((await get('/v2/stories')).status).toBe(403);
    }
  });

  it('leaves a community without a pending erasure accessible', async () => {
    const { get, sqlite } = await setup('member', true);
    const other = sqlite
      .prepare(
        `INSERT INTO communities (name, slug, public_stories, is_active, created_at, updated_at) VALUES ('Other', 'other', 1, 1, 1, 1)`
      )
      .run().lastInsertRowid;
    insertErasure(sqlite, Number(other), 'requested');
    expect((await get('/v2/stories')).status).toBe(200);
  });

  it('denies recovery independently on an erasure-exempt path when gates are missing', async () => {
    const { get } = await setup('admin', true, true);
    const res = await get('/v2/community/sovereignty');
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      code: 'recovery_codes_required',
    });
  });

  it('sees an erasure fence committed during the session touch', async () => {
    const { get, sqlite, communityId } = await setup(
      'member',
      true,
      false,
      true
    );
    // The erasure request commits while the session touch runs: after the
    // joined read, before the response gate decision.
    sqlite.exec(`CREATE TRIGGER fence_during_touch AFTER UPDATE OF last_seen_at ON sessions
      BEGIN
        INSERT INTO community_sovereignty_requests (id, community_id, kind, state, initiated_by_role, requested_at, updated_at)
        VALUES ('req-race', ${communityId}, 'erasure', 'requested', 'admin', 1, 1);
      END`);
    expect((await get('/v2/stories')).status).toBe(403);
  });

  it('is enabled by both production entrypoints', () => {
    for (const file of ['src/worker.ts', 'src/hono-server.ts'])
      expect(readFileSync(file, 'utf8')).toContain(
        'requireRecoveryCodes: true'
      );
  });
});
