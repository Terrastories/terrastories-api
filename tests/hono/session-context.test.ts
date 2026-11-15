import { afterEach, describe, expect, it } from 'vitest';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { hash } from 'bcrypt';
import { eq } from 'drizzle-orm';
import { HonoFoundationRepository } from '../../src/repositories/hono-foundation.repository.js';
import { createHonoApp } from '../../src/hono-app.js';
import { nodePasswordVerifier } from '../../src/node-password.js';
import { tokenDigest } from '../../src/services/hono-foundation.service.js';
import { communitiesSqlite } from '../../src/db/schema/communities.js';
import { usersSqlite } from '../../src/db/schema/users.js';
import { filesSqlite } from '../../src/db/schema/files.js';
import {
  communityMediaSqlite,
  sessionsSqlite,
} from '../../src/db/schema/sessions.js';
import {
  sessionLifetime,
  sessionRenewalInterval,
} from '../../src/shared/session-policy.js';
import type { V2CommunityRole } from '../../src/shared/authorization/sovereignty-policy.js';

describe('Slice 3b HonoFoundationRepository & session middleware context (#137)', () => {
  const openDbs: Sqlite.Database[] = [];

  afterEach(() => {
    while (openDbs.length > 0) openDbs.pop()?.close();
  });

  async function setup() {
    const sqlite = new Sqlite(':memory:');
    sqlite.pragma('foreign_keys = ON');
    openDbs.push(sqlite);
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: 'src/db/migrations' });

    const password = 'Slice3bPassword123!';
    const passwordHash = (await hash(password, 4)).replace('$2b$', '$2a$');
    const now = new Date('2026-11-15T00:00:00Z');

    const [activeCommunity] = await db
      .insert(communitiesSqlite)
      .values({
        name: 'Active Community',
        slug: 'active-comm',
        publicStories: true,
        isActive: true,
      })
      .returning();

    const [disabledCommunity] = await db
      .insert(communitiesSqlite)
      .values({
        name: 'Disabled Community',
        slug: 'disabled-comm',
        publicStories: true,
        isActive: false,
      })
      .returning();

    const [
      activeViewer,
      activeMember,
      activeElder,
      inactiveAdmin,
      nullSuperAdmin,
      inactiveNullSuper,
      orphanAdmin,
      disabledAdmin,
      disabledViewer,
      disabledMember,
      disabledEditor,
    ] = await db
      .insert(usersSqlite)
      .values([
        {
          email: 'viewer@active.test',
          username: 'active_viewer',
          displayName: 'Active Viewer',
          passwordHash,
          firstName: 'Active',
          lastName: 'Viewer',
          role: 'viewer',
          communityId: activeCommunity.id,
          isActive: true,
        },
        {
          email: 'member@active.test',
          username: 'active_member',
          displayName: null,
          passwordHash,
          firstName: 'Active',
          lastName: 'Member',
          role: 'member',
          communityId: activeCommunity.id,
          isActive: true,
        },
        {
          email: 'elder@active.test',
          username: null,
          displayName: 'Legacy Elder',
          passwordHash,
          firstName: 'Legacy',
          lastName: 'Elder',
          role: 'elder',
          communityId: activeCommunity.id,
          isActive: true,
        },
        {
          email: 'inactive-admin@active.test',
          username: null,
          displayName: null,
          passwordHash,
          firstName: 'Inactive',
          lastName: 'Admin',
          role: 'admin',
          communityId: activeCommunity.id,
          isActive: false,
        },
        {
          email: 'super@system.test',
          username: 'null_super',
          displayName: 'System Super Admin',
          passwordHash,
          firstName: 'System',
          lastName: 'Super',
          role: 'super_admin',
          communityId: null,
          isActive: true,
        },
        {
          email: 'inactive-super@system.test',
          username: null,
          displayName: null,
          passwordHash,
          firstName: 'Inactive',
          lastName: 'Super',
          role: 'super_admin',
          communityId: null,
          isActive: false,
        },
        {
          email: 'orphan-admin@system.test',
          username: null,
          displayName: null,
          passwordHash,
          firstName: 'Orphan',
          lastName: 'Admin',
          role: 'admin',
          communityId: null,
          isActive: true,
        },
        {
          email: 'admin@disabled.test',
          username: 'disabled_admin',
          displayName: 'Disabled Admin',
          passwordHash,
          firstName: 'Disabled',
          lastName: 'Admin',
          role: 'admin',
          communityId: disabledCommunity.id,
          isActive: true,
        },
        {
          email: 'viewer@disabled.test',
          username: null,
          displayName: null,
          passwordHash,
          firstName: 'Disabled',
          lastName: 'Viewer',
          role: 'viewer',
          communityId: disabledCommunity.id,
          isActive: true,
        },
        {
          email: 'member@disabled.test',
          username: null,
          displayName: null,
          passwordHash,
          firstName: 'Disabled',
          lastName: 'Member',
          role: 'member',
          communityId: disabledCommunity.id,
          isActive: true,
        },
        {
          email: 'editor@disabled.test',
          username: null,
          displayName: null,
          passwordHash,
          firstName: 'Disabled',
          lastName: 'Editor',
          role: 'editor',
          communityId: disabledCommunity.id,
          isActive: true,
        },
      ])
      .returning();

    const activeFileId = crypto.randomUUID();
    const disabledFileId = crypto.randomUUID();
    await db.insert(filesSqlite).values([
      {
        id: activeFileId,
        filename: 'active.png',
        originalName: 'active.png',
        path: `communities/${activeCommunity.id}/${activeFileId}`,
        url: `/v2/media/${activeFileId}`,
        mimeType: 'image/png',
        size: 4,
        communityId: activeCommunity.id,
        uploadedBy: activeViewer.id,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: disabledFileId,
        filename: 'disabled.png',
        originalName: 'disabled.png',
        path: `communities/${disabledCommunity.id}/${disabledFileId}`,
        url: `/v2/media/${disabledFileId}`,
        mimeType: 'image/png',
        size: 4,
        communityId: disabledCommunity.id,
        uploadedBy: disabledAdmin.id,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await db.insert(communityMediaSqlite).values([
      {
        fileId: activeFileId,
        communityId: activeCommunity.id,
        kind: 'branding',
      },
      {
        fileId: disabledFileId,
        communityId: disabledCommunity.id,
        kind: 'branding',
      },
    ]);

    const repository = new HonoFoundationRepository(db);
    let currentNow = now;
    const app = createHonoApp({
      repository,
      verifier: nodePasswordVerifier,
      secureCookies: false,
      now: () => currentNow,
      storage: {
        read: async () => new Uint8Array([1, 2, 3, 4]),
      },
    });

    return {
      sqlite,
      db,
      repository,
      app,
      password,
      passwordHash,
      activeCommunity,
      disabledCommunity,
      activeFileId,
      disabledFileId,
      users: {
        activeViewer,
        activeMember,
        activeElder,
        inactiveAdmin,
        nullSuperAdmin,
        inactiveNullSuper,
        orphanAdmin,
        disabledAdmin,
        disabledViewer,
        disabledMember,
        disabledEditor,
      },
      setNow: (d: Date) => {
        currentNow = d;
      },
      getNow: () => currentNow,
    };
  }

  it('repository.candidates() filters via leftJoin + communityId IS NULL + canonical-state + V2 role parser', async () => {
    const { repository, activeCommunity, users } = await setup();

    expect(await repository.candidates('viewer@active.test')).toEqual([
      {
        id: users.activeViewer.id,
        email: 'viewer@active.test',
        username: 'active_viewer',
        displayName: 'Active Viewer',
        passwordHash: users.activeViewer.passwordHash,
        role: 'viewer',
        communityId: activeCommunity.id,
      },
    ]);

    expect(await repository.candidates('member@active.test')).toEqual([
      expect.objectContaining({
        id: users.activeMember.id,
        role: 'member',
        username: 'active_member',
        displayName: null,
        communityId: activeCommunity.id,
      }),
    ]);

    expect(await repository.candidates('super@system.test')).toEqual([
      expect.objectContaining({
        id: users.nullSuperAdmin.id,
        role: 'super_admin',
        username: 'null_super',
        displayName: 'System Super Admin',
        communityId: null,
      }),
    ]);

    // Specifying a communityId filter excludes null-community super_admin.
    expect(
      await repository.candidates('super@system.test', activeCommunity.id)
    ).toEqual([]);

    expect(await repository.candidates('admin@disabled.test')).toEqual([
      expect.objectContaining({
        id: users.disabledAdmin.id,
        role: 'admin',
        username: 'disabled_admin',
        displayName: 'Disabled Admin',
        communityId: users.disabledAdmin.communityId,
      }),
    ]);

    for (const rejectedEmail of [
      'elder@active.test',
      'inactive-admin@active.test',
      'inactive-super@system.test',
      'orphan-admin@system.test',
      'viewer@disabled.test',
      'member@disabled.test',
      'editor@disabled.test',
    ]) {
      expect(
        await repository.candidates(rejectedEmail),
        `expected no candidates for ${rejectedEmail}`
      ).toEqual([]);
    }
  });

  it('repository.candidates() and POST /v2/auth/login keep ambiguous emails 401 across both insertion orders (SPEC-V2 §6.2)', async () => {
    const {
      db,
      repository,
      app,
      password,
      passwordHash,
      activeCommunity,
      disabledCommunity,
    } = await setup();

    const cases = [
      [
        'active-first-disabled@shared.test',
        [
          {
            role: 'viewer' as const,
            communityId: activeCommunity.id,
            isActive: true,
          },
          {
            role: 'viewer' as const,
            communityId: disabledCommunity.id,
            isActive: true,
          },
        ],
      ],
      [
        'disabled-first-active@shared.test',
        [
          {
            role: 'viewer' as const,
            communityId: disabledCommunity.id,
            isActive: true,
          },
          {
            role: 'viewer' as const,
            communityId: activeCommunity.id,
            isActive: true,
          },
        ],
      ],
      [
        'active-first-elder@shared.test',
        [
          {
            role: 'viewer' as const,
            communityId: activeCommunity.id,
            isActive: true,
          },
          {
            role: 'elder' as const,
            communityId: disabledCommunity.id,
            isActive: true,
          },
        ],
      ],
      [
        'elder-first-active@shared.test',
        [
          {
            role: 'elder' as const,
            communityId: disabledCommunity.id,
            isActive: true,
          },
          {
            role: 'viewer' as const,
            communityId: activeCommunity.id,
            isActive: true,
          },
        ],
      ],
      [
        'active-first-inactive@shared.test',
        [
          {
            role: 'viewer' as const,
            communityId: activeCommunity.id,
            isActive: true,
          },
          {
            role: 'viewer' as const,
            communityId: disabledCommunity.id,
            isActive: false,
          },
        ],
      ],
      [
        'inactive-first-active@shared.test',
        [
          {
            role: 'viewer' as const,
            communityId: disabledCommunity.id,
            isActive: false,
          },
          {
            role: 'viewer' as const,
            communityId: activeCommunity.id,
            isActive: true,
          },
        ],
      ],
    ] as const;

    for (const [sharedEmail, rows] of cases) {
      for (const entry of rows) {
        await db.insert(usersSqlite).values({
          email: sharedEmail,
          passwordHash,
          firstName: 'Shared',
          lastName: 'User',
          role: entry.role,
          communityId: entry.communityId,
          isActive: entry.isActive,
        });
      }

      expect(
        await repository.candidates(sharedEmail),
        `candidates(${sharedEmail}) without communityId must be empty`
      ).toEqual([]);
      expect(
        await repository.candidates(sharedEmail, activeCommunity.id),
        `candidates(${sharedEmail}, activeCommunity) must resolve the active account`
      ).toHaveLength(1);

      const unlocated = await app.request('http://localhost/v2/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: sharedEmail, password }),
      });
      expect(unlocated.status).toBe(401);
      expect(await unlocated.json()).toEqual({ error: 'Invalid credentials' });

      const located = await app.request('http://localhost/v2/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: sharedEmail,
          password,
          communityId: activeCommunity.id,
        }),
      });
      expect(located.status).toBe(200);
    }
  });

  it('repository.createSession() and session() handle null communityId, disabled-community admin, and reject elder/disabled non-admins', async () => {
    const { db, repository, users, passwordHash, getNow } = await setup();
    const now = getNow();
    const expiresAt = new Date(now.getTime() + sessionLifetime);

    // Null-community super_admin establishes and reads back a session (IS NULL path).
    const superHash = await tokenDigest('s'.repeat(64));
    expect(
      await repository.createSession(
        superHash,
        {
          id: users.nullSuperAdmin.id,
          email: users.nullSuperAdmin.email,
          username: 'null_super',
          displayName: 'System Super Admin',
          passwordHash,
          role: 'super_admin',
          communityId: null,
        },
        now,
        expiresAt
      )
    ).toBe(true);
    expect(await repository.session(superHash, now)).toMatchObject({
      id: users.nullSuperAdmin.id,
      role: 'super_admin',
      communityId: null,
      username: 'null_super',
      displayName: 'System Super Admin',
    });

    // Wrong communityId expectation fails closed (null vs non-null mismatch).
    expect(
      await repository.createSession(
        await tokenDigest('w'.repeat(64)),
        {
          id: users.nullSuperAdmin.id,
          email: users.nullSuperAdmin.email,
          username: 'null_super',
          displayName: 'System Super Admin',
          passwordHash,
          role: 'super_admin',
          communityId: 1,
        },
        now,
        expiresAt
      )
    ).toBe(false);

    // Disabled-community own-admin establishes and holds a session.
    const adminHash = await tokenDigest('a'.repeat(64));
    expect(
      await repository.createSession(
        adminHash,
        {
          id: users.disabledAdmin.id,
          email: users.disabledAdmin.email,
          username: 'disabled_admin',
          displayName: 'Disabled Admin',
          passwordHash,
          role: 'admin',
          communityId: users.disabledAdmin.communityId,
        },
        now,
        expiresAt
      )
    ).toBe(true);
    expect(await repository.session(adminHash, now)).toMatchObject({
      id: users.disabledAdmin.id,
      role: 'admin',
      communityId: users.disabledAdmin.communityId,
    });

    // Direct createSession() rejects elder, orphan null-community admin, and disabled viewer.
    for (const [label, candidate] of [
      [
        'elder',
        {
          id: users.activeElder.id,
          email: users.activeElder.email,
          username: null,
          displayName: 'Legacy Elder',
          passwordHash,
          role: 'elder' as unknown as V2CommunityRole,
          communityId: users.activeElder.communityId,
        },
      ],
      [
        'orphan admin',
        {
          id: users.orphanAdmin.id,
          email: users.orphanAdmin.email,
          username: null,
          displayName: null,
          passwordHash,
          role: 'admin' as const,
          communityId: null,
        },
      ],
      [
        'disabled viewer',
        {
          id: users.disabledViewer.id,
          email: users.disabledViewer.email,
          username: null,
          displayName: null,
          passwordHash,
          role: 'viewer' as const,
          communityId: users.disabledViewer.communityId,
        },
      ],
    ] as const) {
      expect(
        await repository.createSession(
          await tokenDigest(label.padEnd(64, '0').slice(0, 64)),
          candidate,
          now,
          expiresAt
        ),
        `createSession must reject ${label}`
      ).toBe(false);
    }

    // Even if a session row exists in DB for an elder or disabled viewer, session() denies it.
    const elderHash = await tokenDigest('e'.repeat(64));
    const disabledViewerHash = await tokenDigest('v'.repeat(64));
    await db.insert(sessionsSqlite).values([
      {
        id: 'raw-elder',
        tokenHash: elderHash,
        userId: users.activeElder.id,
        expiresAt: expiresAt.getTime(),
      },
      {
        id: 'raw-disabled-viewer',
        tokenHash: disabledViewerHash,
        userId: users.disabledViewer.id,
        expiresAt: expiresAt.getTime(),
      },
    ]);
    expect(await repository.session(elderHash, now)).toBeNull();
    expect(await repository.session(disabledViewerHash, now)).toBeNull();

    // brandingFile fails closed on null communityId or disabled community.
    expect(await repository.brandingFile('any-id', null)).toBeNull();
  });

  it('middleware, /v2/auth/me, renewal/revocation, and fail-closed /v2/media/:id work for all Slice 3b contexts', async () => {
    const {
      db,
      app,
      password,
      activeCommunity,
      disabledCommunity,
      activeFileId,
      disabledFileId,
      users,
      setNow,
      getNow,
    } = await setup();

    const login = (email: string, communityId?: number) =>
      app.request('http://localhost/v2/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password, communityId }),
      });

    // Uniform 401 across bad login, elder, disabled viewer/member/editor, inactive, orphan.
    const baselineBad = await login('missing@example.test');
    expect(baselineBad.status).toBe(401);
    const baselineBody = await baselineBad.json();
    expect(baselineBody).toEqual({ error: 'Invalid credentials' });

    for (const email of [
      'elder@active.test',
      'viewer@disabled.test',
      'member@disabled.test',
      'editor@disabled.test',
      'inactive-admin@active.test',
      'inactive-super@system.test',
      'orphan-admin@system.test',
    ]) {
      const res = await login(email);
      expect(res.status, `login should return 401 for ${email}`).toBe(401);
      expect(await res.json()).toEqual(baselineBody);
    }

    // Null-community super_admin logs in, reads /v2/auth/me with communityId: null,
    // gets 404 on /v2/media/:id branding, renews after 15m, and revokes on logout.
    const superLogin = await login('super@system.test');
    expect(superLogin.status).toBe(200);
    const superCookie = superLogin.headers.get('set-cookie')!.split(';')[0];
    expect(await superLogin.json()).toEqual({
      user: {
        id: users.nullSuperAdmin.id,
        email: 'super@system.test',
        username: 'null_super',
        displayName: 'System Super Admin',
        role: 'super_admin',
        communityId: null,
      },
    });

    const superMe = await app.request('http://localhost/v2/auth/me', {
      headers: { cookie: superCookie },
    });
    expect(superMe.status).toBe(200);
    expect(await superMe.json()).toEqual({
      user: {
        id: users.nullSuperAdmin.id,
        email: 'super@system.test',
        username: 'null_super',
        displayName: 'System Super Admin',
        role: 'super_admin',
        communityId: null,
      },
    });

    expect(
      (
        await app.request(`http://localhost/v2/media/${activeFileId}`, {
          headers: { cookie: superCookie },
        })
      ).status
    ).toBe(404);
    expect(
      (
        await app.request(`http://localhost/v2/media/${disabledFileId}`, {
          headers: { cookie: superCookie },
        })
      ).status
    ).toBe(404);

    // Session renewal semantics unchanged for null-community super_admin.
    const [initialSuperSession] = await db
      .select({ expiresAt: sessionsSqlite.expiresAt })
      .from(sessionsSqlite)
      .where(eq(sessionsSqlite.userId, users.nullSuperAdmin.id));
    setNow(new Date(getNow().getTime() + sessionRenewalInterval));
    const renewedMe = await app.request('http://localhost/v2/auth/me', {
      headers: { cookie: superCookie },
    });
    expect(renewedMe.status).toBe(200);
    const [renewedSuperSession] = await db
      .select({ expiresAt: sessionsSqlite.expiresAt })
      .from(sessionsSqlite)
      .where(eq(sessionsSqlite.userId, users.nullSuperAdmin.id));
    expect(renewedSuperSession.expiresAt).toBeGreaterThan(
      initialSuperSession.expiresAt
    );

    expect(
      (
        await app.request('http://localhost/v2/auth/logout', {
          method: 'POST',
          headers: { cookie: superCookie },
        })
      ).status
    ).toBe(204);
    expect(
      (
        await app.request('http://localhost/v2/auth/me', {
          headers: { cookie: superCookie },
        })
      ).status
    ).toBe(401);

    // Disabled-community admin logs in, reads /v2/auth/me, and gets 404 on /v2/media/:id
    // (including their own disabled community's unrestricted branding file).
    const disabledAdminLogin = await login('admin@disabled.test');
    expect(disabledAdminLogin.status).toBe(200);
    const disabledAdminCookie = disabledAdminLogin.headers
      .get('set-cookie')!
      .split(';')[0];
    expect(await disabledAdminLogin.json()).toEqual({
      user: {
        id: users.disabledAdmin.id,
        email: 'admin@disabled.test',
        username: 'disabled_admin',
        displayName: 'Disabled Admin',
        role: 'admin',
        communityId: disabledCommunity.id,
      },
    });
    const disabledAdminMe = await app.request('http://localhost/v2/auth/me', {
      headers: { cookie: disabledAdminCookie },
    });
    expect(disabledAdminMe.status).toBe(200);
    expect(await disabledAdminMe.json()).toEqual({
      user: {
        id: users.disabledAdmin.id,
        email: 'admin@disabled.test',
        username: 'disabled_admin',
        displayName: 'Disabled Admin',
        role: 'admin',
        communityId: disabledCommunity.id,
      },
    });
    expect(
      (
        await app.request(`http://localhost/v2/media/${disabledFileId}`, {
          headers: { cookie: disabledAdminCookie },
        })
      ).status
    ).toBe(404);
    expect(
      (
        await app.request(`http://localhost/v2/media/${activeFileId}`, {
          headers: { cookie: disabledAdminCookie },
        })
      ).status
    ).toBe(404);

    // Active-community member with null displayName gets exact /v2/auth/me shape and can read active branding.
    const memberLogin = await login('member@active.test', activeCommunity.id);
    expect(memberLogin.status).toBe(200);
    const memberCookie = memberLogin.headers.get('set-cookie')!.split(';')[0];
    expect(await memberLogin.json()).toEqual({
      user: {
        id: users.activeMember.id,
        email: 'member@active.test',
        username: 'active_member',
        displayName: null,
        role: 'member',
        communityId: activeCommunity.id,
      },
    });
    expect(
      (
        await app.request(`http://localhost/v2/media/${activeFileId}`, {
          headers: { cookie: memberCookie },
        })
      ).status
    ).toBe(200);
  });

  it('revokes active community admin, disabled-community admin, and null-community super_admin sessions on authority triggers', async () => {
    const {
      db,
      app,
      password,
      passwordHash,
      activeCommunity,
      disabledCommunity,
      users,
    } = await setup();

    const [activeAdmin] = await db
      .insert(usersSqlite)
      .values({
        email: 'admin@active.test',
        username: 'active_admin',
        displayName: 'Active Admin',
        passwordHash,
        firstName: 'Active',
        lastName: 'Admin',
        role: 'admin',
        communityId: activeCommunity.id,
        isActive: true,
      })
      .returning();

    const login = (email: string) =>
      app.request('http://localhost/v2/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

    // 1. Active community admin's cookie returns 401 after community disable
    //    (before re-login); re-login succeeds while disabled, and re-enable
    //    revokes that session too.
    const activeAdminLogin = await login(activeAdmin.email);
    expect(activeAdminLogin.status).toBe(200);
    const activeAdminCookie = activeAdminLogin.headers
      .get('set-cookie')!
      .split(';')[0];
    expect(
      (
        await app.request('http://localhost/v2/auth/me', {
          headers: { cookie: activeAdminCookie },
        })
      ).status
    ).toBe(200);

    await db
      .update(communitiesSqlite)
      .set({ isActive: false })
      .where(eq(communitiesSqlite.id, activeCommunity.id));
    expect(
      (
        await app.request('http://localhost/v2/auth/me', {
          headers: { cookie: activeAdminCookie },
        })
      ).status
    ).toBe(401);

    const disabledStateRelogin = await login(activeAdmin.email);
    expect(disabledStateRelogin.status).toBe(200);
    const disabledStateCookie = disabledStateRelogin.headers
      .get('set-cookie')!
      .split(';')[0];
    await db
      .update(communitiesSqlite)
      .set({ isActive: true })
      .where(eq(communitiesSqlite.id, activeCommunity.id));
    expect(
      (
        await app.request('http://localhost/v2/auth/me', {
          headers: { cookie: activeAdminCookie },
        })
      ).status
    ).toBe(401);
    expect(
      (
        await app.request('http://localhost/v2/auth/me', {
          headers: { cookie: disabledStateCookie },
        })
      ).status
    ).toBe(401);

    // 2. Disabled-community admin session is revoked on re-enable and remains
    //    revoked on subsequent disable per communities_revoke_sessions trigger.
    const disabledAdminLogin = await login(users.disabledAdmin.email);
    expect(disabledAdminLogin.status).toBe(200);
    const disabledAdminCookie = disabledAdminLogin.headers
      .get('set-cookie')!
      .split(';')[0];
    expect(
      (
        await app.request('http://localhost/v2/auth/me', {
          headers: { cookie: disabledAdminCookie },
        })
      ).status
    ).toBe(200);

    await db
      .update(communitiesSqlite)
      .set({ isActive: true })
      .where(eq(communitiesSqlite.id, disabledCommunity.id));
    expect(
      (
        await app.request('http://localhost/v2/auth/me', {
          headers: { cookie: disabledAdminCookie },
        })
      ).status
    ).toBe(401);

    const enabledAdminLogin = await login(users.disabledAdmin.email);
    expect(enabledAdminLogin.status).toBe(200);
    const enabledAdminCookie = enabledAdminLogin.headers
      .get('set-cookie')!
      .split(';')[0];
    await db
      .update(communitiesSqlite)
      .set({ isActive: false })
      .where(eq(communitiesSqlite.id, disabledCommunity.id));
    expect(
      (
        await app.request('http://localhost/v2/auth/me', {
          headers: { cookie: disabledAdminCookie },
        })
      ).status
    ).toBe(401);
    expect(
      (
        await app.request('http://localhost/v2/auth/me', {
          headers: { cookie: enabledAdminCookie },
        })
      ).status
    ).toBe(401);

    // 3. Role change and deactivation permanently revoke null-community
    //    super_admin sessions (users_revoke_sessions trigger).
    for (const [change, restore] of [
      [{ role: 'admin' as const }, { role: 'super_admin' as const }],
      [{ isActive: false }, { isActive: true }],
    ]) {
      const superLogin = await login(users.nullSuperAdmin.email);
      expect(superLogin.status).toBe(200);
      const superCookie = superLogin.headers.get('set-cookie')!.split(';')[0];
      expect(
        (
          await app.request('http://localhost/v2/auth/me', {
            headers: { cookie: superCookie },
          })
        ).status
      ).toBe(200);

      await db
        .update(usersSqlite)
        .set(change)
        .where(eq(usersSqlite.id, users.nullSuperAdmin.id));
      expect(
        (
          await app.request('http://localhost/v2/auth/me', {
            headers: { cookie: superCookie },
          })
        ).status
      ).toBe(401);
      if ('isActive' in change) {
        expect((await login(users.nullSuperAdmin.email)).status).toBe(401);
      }

      await db
        .update(usersSqlite)
        .set(restore)
        .where(eq(usersSqlite.id, users.nullSuperAdmin.id));
      expect(
        (
          await app.request('http://localhost/v2/auth/me', {
            headers: { cookie: superCookie },
          })
        ).status
      ).toBe(401);
    }
  });
});
