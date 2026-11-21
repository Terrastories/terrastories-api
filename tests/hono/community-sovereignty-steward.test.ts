import { CommunityErasureService } from '../../src/services/community-erasure.service.js';
import {
  verifyErasureRestorePoint,
  type ErasureRecord,
  type ErasureRecordStore,
} from '../../src/services/erasure-record-store.js';
/**
 * Tests for Slice 13b-A sovereignty read & steward designation:
 * - `GET /v2/community/sovereignty` (active & disabled own-admin; 403 for
 *   viewer/member/editor/super_admin including designated steward; 401 anon)
 * - `PUT /v2/community/steward` (designate same-community user or null-community
 *   super_admin, replace, remove, cancel pending steward notice requests on
 *   removal/replacement, reject cross-community/inactive/elder targets with 404,
 *   password step-up + AuthThrottle integration, fresh one-shot admin_issued
 *   session step-up without burning on 404, content-free audit verification)
 * - Designated steward recovery-code generation (`POST /v2/auth/recovery-codes`)
 *   and disabled-community authentication while non-steward members stay denied
 * - D1 `db.batch()` emulation coverage
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import { createHonoApp } from '../../src/hono-app.js';
import { CommunitySovereigntyRepository } from '../../src/repositories/community-sovereignty.repository.js';
import { HonoFoundationRepository } from '../../src/repositories/hono-foundation.repository.js';
import { communitiesSqlite } from '../../src/db/schema/communities.js';
import { filesSqlite } from '../../src/db/schema/files.js';
import { usersSqlite } from '../../src/db/schema/users.js';
import {
  sessionsSqlite,
  authThrottleSqlite,
} from '../../src/db/schema/sessions.js';
import { auditEntriesSqlite } from '../../src/db/schema/audit_entries.js';
import {
  communityArchiveCustodySqlite,
  communitySovereigntyRequestsSqlite,
  communityStewardsSqlite,
} from '../../src/db/schema/community_sovereignty.js';
import {
  AUTH_THROTTLE_MAX_FAILURES,
  RECOVERY_CODE_COUNT,
} from '../../src/shared/auth-policy.js';
import { sha256Hex } from '../../src/shared/auth-crypto.js';
import { normalizeSearchText } from '../../src/shared/utils/search-normalize.js';
import { validateContentFreeAuditEntry } from '../../src/shared/utils/audit-entry.js';
import {
  CommunitySovereigntyStatusResponseSchema,
  PutCommunityStewardResponseSchema,
} from '../../src/shared/schemas/community-sovereignty.js';
import { RecoveryCodesResponseSchema } from '../../src/shared/schemas/auth-recovery.js';
import {
  argon2Seed,
  makeDerivedKey,
  makeServerSecret,
  makeVerifierSalt,
} from './auth-test-utils.js';

const API_ORIGIN = 'https://api.example.test';

function installD1BatchEmulation(db: ReturnType<typeof drizzle>) {
  const database = db as unknown as {
    transaction: (fn: () => unknown[][]) => unknown[][];
  };
  const handle = db as unknown as {
    batch?: (
      stmts: Array<{
        config?: { returning?: unknown; fields?: unknown };
        all: () => unknown[];
        run: () => unknown;
      }>
    ) => Promise<unknown[][]>;
  };
  handle.batch = async (stmts) =>
    database.transaction(() =>
      stmts.map((stmt) =>
        stmt.config?.returning !== undefined ||
        stmt.config?.fields !== undefined
          ? stmt.all()
          : (stmt.run(), [])
      )
    );
}

describe('Slice 13b-A/B community sovereignty', () => {
  const openDbs: Sqlite.Database[] = [];

  afterEach(() => {
    while (openDbs.length > 0) openDbs.pop()?.close();
  });

  async function setup(options: { d1Batch?: boolean } = {}) {
    const sqlite = new Sqlite(':memory:');
    sqlite.pragma('foreign_keys = ON');
    openDbs.push(sqlite);
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: 'src/db/migrations' });
    if (options.d1Batch) {
      installD1BatchEmulation(db);
    }

    let currentNow = new Date('2026-11-21T10:00:00.000Z');
    const advanceMs = (ms: number) => {
      currentNow = new Date(currentNow.getTime() + ms);
    };

    const [activeComm, disabledComm, foreignComm] = await db
      .insert(communitiesSqlite)
      .values([
        {
          name: 'Alpha Sovereign',
          slug: 'alpha-sov',
          locale: 'en',
          publicStories: true,
          isActive: true,
          createdAt: currentNow,
          updatedAt: currentNow,
        },
        {
          name: 'Disabled Sovereign',
          slug: 'disabled-sov',
          locale: 'en',
          publicStories: false,
          isActive: false,
          createdAt: currentNow,
          updatedAt: currentNow,
        },
        {
          name: 'Foreign Community',
          slug: 'foreign-sov',
          locale: 'en',
          publicStories: true,
          isActive: true,
          createdAt: currentNow,
          updatedAt: currentNow,
        },
      ])
      .returning();

    const makeCreds = async () => {
      const derivedKey = makeDerivedKey();
      return {
        derivedKey,
        salt: makeVerifierSalt(),
        verifier: await sha256Hex(derivedKey),
      };
    };

    const adminCreds = await makeCreds();
    const disabledAdminCreds = await makeCreds();
    const memberCreds = await makeCreds();
    const editorCreds = await makeCreds();
    const viewerCreds = await makeCreds();
    const disabledMemberCreds = await makeCreds();
    const disabledOtherMemberCreds = await makeCreds();
    const superAdminCreds = await makeCreds();
    const foreignUserCreds = await makeCreds();
    const inactiveUserCreds = await makeCreds();
    const elderUserCreds = await makeCreds();

    const insertUser = async (input: {
      email: string;
      username: string;
      role: string;
      communityId: number | null;
      isActive?: boolean;
      creds: { derivedKey: string; salt: string; verifier: string };
    }) => {
      const [row] = await db
        .insert(usersSqlite)
        .values({
          email: input.email,
          username: input.username,
          emailNormalized: normalizeSearchText(input.email),
          usernameNormalized: normalizeSearchText(input.username),
          firstName: input.username,
          lastName: 'User',
          ...(await argon2Seed(input.creds.derivedKey)),
          role: input.role,
          communityId: input.communityId,
          isActive: input.isActive ?? true,
          createdAt: currentNow,
          updatedAt: currentNow,
        })
        .returning();
      return row!;
    };

    const adminUser = await insertUser({
      email: 'admin@alpha.test',
      username: 'alpha_admin',
      role: 'admin',
      communityId: activeComm!.id,
      creds: adminCreds,
    });
    const disabledAdmin = await insertUser({
      email: 'admin@disabled.test',
      username: 'disabled_admin',
      role: 'admin',
      communityId: disabledComm!.id,
      creds: disabledAdminCreds,
    });
    const memberUser = await insertUser({
      email: 'member@alpha.test',
      username: 'alpha_member',
      role: 'member',
      communityId: activeComm!.id,
      creds: memberCreds,
    });
    const editorUser = await insertUser({
      email: 'editor@alpha.test',
      username: 'alpha_editor',
      role: 'editor',
      communityId: activeComm!.id,
      creds: editorCreds,
    });
    const viewerUser = await insertUser({
      email: 'viewer@alpha.test',
      username: 'alpha_viewer',
      role: 'viewer',
      communityId: activeComm!.id,
      creds: viewerCreds,
    });
    const disabledMember = await insertUser({
      email: 'member@disabled.test',
      username: 'disabled_member',
      role: 'member',
      communityId: disabledComm!.id,
      creds: disabledMemberCreds,
    });
    const disabledOtherMember = await insertUser({
      email: 'other@disabled.test',
      username: 'disabled_other',
      role: 'member',
      communityId: disabledComm!.id,
      creds: disabledOtherMemberCreds,
    });
    const superAdmin = await insertUser({
      email: 'sysadmin@system.test',
      username: 'sys_admin',
      role: 'super_admin',
      communityId: null,
      creds: superAdminCreds,
    });
    const foreignUser = await insertUser({
      email: 'member@foreign.test',
      username: 'foreign_member',
      role: 'member',
      communityId: foreignComm!.id,
      creds: foreignUserCreds,
    });
    const inactiveUser = await insertUser({
      email: 'inactive@alpha.test',
      username: 'alpha_inactive',
      role: 'member',
      communityId: activeComm!.id,
      isActive: false,
      creds: inactiveUserCreds,
    });
    const elderUser = await insertUser({
      email: 'elder@alpha.test',
      username: 'alpha_elder',
      role: 'elder',
      communityId: activeComm!.id,
      creds: elderUserCreds,
    });

    const records = new Map<number, ErasureRecord>();
    const erasureStore: ErasureRecordStore = {
      list: async () => [...records.values()],
      write: async (r) => {
        records.set(r.communityId, structuredClone(r));
      },
    };
    const objects = new Map<string, Uint8Array>();
    const storage = {
      fenceCommunity: async () => {},
      read: async () => null,
      delete: async (key: string) => {
        objects.delete(key);
      },
      list: async (options?: { prefix?: string; limit?: number }) => {
        const keys = [...objects.keys()]
          .filter((k) => k.startsWith(options?.prefix ?? ''))
          .sort();
        return {
          entries: keys
            .slice(0, options?.limit ?? 20)
            .map((key) => ({ key, uploaded: currentNow })),
          truncated: keys.length > (options?.limit ?? 20),
        };
      },
    };
    const erasureService = new CommunityErasureService(
      new CommunitySovereigntyRepository(db),
      storage,
      erasureStore,
      () => currentNow
    );
    const serverSecret = makeServerSecret();
    const app = createHonoApp({
      repository: new HonoFoundationRepository(db),
      storage,
      erasureStore,
      serverSecret,
      secureCookies: false,
      publicOrigin: API_ORIGIN,
      trustProxy: true,
      now: () => currentNow,
    });

    const loginCookie = async (
      identifier: string,
      derivedKey: string,
      ip = '198.51.100.10'
    ) => {
      const res = await app.request(`${API_ORIGIN}/v2/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-forwarded-for': ip,
        },
        body: JSON.stringify({ identifier, derivedKey }),
      });
      expect(res.status).toBe(200);
      const setCookie = res.headers.get('set-cookie') ?? '';
      const match = /ts_session=([^;]+)/.exec(setCookie);
      expect(match?.[1]).toBeTruthy();
      return `ts_session=${match![1]}`;
    };

    const call = (
      method: string,
      path: string,
      opts: {
        cookie?: string;
        body?: unknown;
        rawBody?: string;
        contentType?: string;
        ip?: string;
      } = {}
    ) => {
      const headers: Record<string, string> = {
        'x-forwarded-for': opts.ip ?? '198.51.100.10',
      };
      if (opts.cookie) headers.Cookie = opts.cookie;
      if (opts.contentType !== undefined) {
        headers['Content-Type'] = opts.contentType;
      } else if (opts.body !== undefined) {
        headers['Content-Type'] = 'application/json';
      }
      return app.request(`${API_ORIGIN}${path}`, {
        method,
        headers,
        body:
          opts.rawBody !== undefined
            ? opts.rawBody
            : opts.body !== undefined
              ? JSON.stringify(opts.body)
              : undefined,
      });
    };

    return {
      db,
      records,
      objects,
      erasureStore,
      erasureService,
      storage,
      app,
      call,
      loginCookie,
      advanceMs,
      getNow: () => currentNow,
      activeComm: activeComm!,
      disabledComm: disabledComm!,
      foreignComm: foreignComm!,
      adminUser,
      adminCreds,
      disabledAdmin,
      disabledAdminCreds,
      memberUser,
      memberCreds,
      editorUser,
      editorCreds,
      viewerUser,
      viewerCreds,
      disabledMember,
      disabledMemberCreds,
      disabledOtherMember,
      disabledOtherMemberCreds,
      superAdmin,
      superAdminCreds,
      foreignUser,
      inactiveUser,
      elderUser,
    };
  }

  it('enforces role gates and serves GET /v2/community/sovereignty for active and disabled own-admin', async () => {
    const ctx = await setup();

    expect((await ctx.call('GET', '/v2/community/sovereignty')).status).toBe(
      401
    );

    for (const [user, creds] of [
      [ctx.viewerUser, ctx.viewerCreds],
      [ctx.memberUser, ctx.memberCreds],
      [ctx.editorUser, ctx.editorCreds],
      [ctx.superAdmin, ctx.superAdminCreds],
    ] as const) {
      const cookie = await ctx.loginCookie(user.email, creds.derivedKey);
      const res = await ctx.call('GET', '/v2/community/sovereignty', {
        cookie,
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'Forbidden' });
    }

    // Active own-admin succeeds and sees archive custody + history.
    await ctx.db.insert(communityArchiveCustodySqlite).values({
      communityId: ctx.activeComm.id,
      custodianType: 'community',
      custodianUserId: ctx.adminUser.id,
      status: 'held',
      retentionUntil: ctx.getNow().getTime() + 30 * 86_400_000,
      createdAt: ctx.getNow().getTime(),
      updatedAt: ctx.getNow().getTime(),
    });

    const adminCookie = await ctx.loginCookie(
      ctx.adminUser.email,
      ctx.adminCreds.derivedKey
    );
    const activeRes = await ctx.call('GET', '/v2/community/sovereignty', {
      cookie: adminCookie,
    });
    expect(activeRes.status).toBe(200);
    const activeBody = CommunitySovereigntyStatusResponseSchema.parse(
      await activeRes.json()
    );
    expect(activeBody.data.communityId).toBe(ctx.activeComm.id);
    expect(activeBody.data.status).toBe('active');
    expect(activeBody.data.steward).toBeNull();
    expect(activeBody.data.noticePeriodSeconds).toBe(7 * 24 * 60 * 60);
    expect(activeBody.data.archiveCustody?.status).toBe('held');
    expect(activeBody.data.archiveCustody?.custodianType).toBe('community');

    // Disabled own-admin also succeeds.
    const disabledCookie = await ctx.loginCookie(
      ctx.disabledAdmin.email,
      ctx.disabledAdminCreds.derivedKey
    );
    const disabledRes = await ctx.call('GET', '/v2/community/sovereignty', {
      cookie: disabledCookie,
    });
    expect(disabledRes.status).toBe(200);
    const disabledBody = CommunitySovereigntyStatusResponseSchema.parse(
      await disabledRes.json()
    );
    expect(disabledBody.data.communityId).toBe(ctx.disabledComm.id);
    expect(disabledBody.data.status).toBe('disabled');
  });

  it('designates, replaces, and removes community stewards with step-up, cancels pending requests, and audits content-free', async () => {
    const ctx = await setup();
    const adminCookie = await ctx.loginCookie(
      ctx.adminUser.email,
      ctx.adminCreds.derivedKey
    );
    const memberCookie = await ctx.loginCookie(
      ctx.memberUser.email,
      ctx.memberCreds.derivedKey
    );

    // Non-admin receives 403.
    expect(
      (
        await ctx.call('PUT', '/v2/community/steward', {
          cookie: memberCookie,
          body: {
            stewardUserId: ctx.memberUser.id,
            currentDerivedKey: ctx.memberCreds.derivedKey,
          },
        })
      ).status
    ).toBe(403);

    // Malformed payloads return 400 / 415.
    expect(
      (
        await ctx.call('PUT', '/v2/community/steward', {
          cookie: adminCookie,
          rawBody: 'not json',
          contentType: 'text/plain',
        })
      ).status
    ).toBe(415);
    expect(
      (
        await ctx.call('PUT', '/v2/community/steward', {
          cookie: adminCookie,
          body: { stewardUserId: -1 },
        })
      ).status
    ).toBe(400);
    expect(
      (
        await ctx.call('PUT', '/v2/community/steward', {
          cookie: adminCookie,
          body: { stewardUserId: ctx.memberUser.id, extra: true },
        })
      ).status
    ).toBe(400);

    // Missing or wrong currentDerivedKey returns uniform 401 and increments AuthThrottle.
    const noStepUp = await ctx.call('PUT', '/v2/community/steward', {
      cookie: adminCookie,
      body: { stewardUserId: ctx.memberUser.id },
    });
    expect(noStepUp.status).toBe(401);
    expect(await noStepUp.json()).toEqual({ error: 'Invalid credentials' });

    const wrongKey = makeDerivedKey();
    const badStepUp = await ctx.call('PUT', '/v2/community/steward', {
      cookie: adminCookie,
      body: { stewardUserId: ctx.memberUser.id, currentDerivedKey: wrongKey },
    });
    expect(badStepUp.status).toBe(401);
    expect(await badStepUp.json()).toEqual({ error: 'Invalid credentials' });

    const throttleRows = await ctx.db.select().from(authThrottleSqlite);
    expect(throttleRows.some((r) => r.failures >= 1)).toBe(true);

    // Cross-community, inactive, and legacy elder targets are rejected with 404 (not 403/409).
    for (const badTargetId of [
      ctx.foreignUser.id,
      ctx.inactiveUser.id,
      ctx.elderUser.id,
      999_999,
    ]) {
      const res = await ctx.call('PUT', '/v2/community/steward', {
        cookie: adminCookie,
        body: {
          stewardUserId: badTargetId,
          currentDerivedKey: ctx.adminCreds.derivedKey,
        },
      });
      expect(res.status).toBe(404);
    }

    // Designate same-community member as steward.
    const designateMember = await ctx.call('PUT', '/v2/community/steward', {
      cookie: adminCookie,
      body: {
        stewardUserId: ctx.memberUser.id,
        currentDerivedKey: ctx.adminCreds.derivedKey,
      },
    });
    expect(designateMember.status).toBe(200);
    const designateParsed = PutCommunityStewardResponseSchema.parse(
      await designateMember.json()
    );
    expect(designateParsed.data.steward).toMatchObject({
      userId: ctx.memberUser.id,
      role: 'member',
      status: 'active',
      sameCommunity: true,
      designatedBy: ctx.adminUser.id,
    });
    expect(designateParsed.data.cancelledRequestIds).toEqual([]);

    // Non-admin member who is now designated steward still gets 403 on GET /v2/community/sovereignty,
    // but CAN generate recovery codes (§6.8, §7)!
    expect(
      (
        await ctx.call('GET', '/v2/community/sovereignty', {
          cookie: memberCookie,
        })
      ).status
    ).toBe(403);
    const memberRecovRes = await ctx.call('POST', '/v2/auth/recovery-codes', {
      cookie: memberCookie,
      body: { currentDerivedKey: ctx.memberCreds.derivedKey },
    });
    expect(memberRecovRes.status).toBe(201);
    expect(
      RecoveryCodesResponseSchema.parse(await memberRecovRes.json()).data.codes
    ).toHaveLength(RECOVERY_CODE_COUNT);

    // Seed a pending steward notice request for the designated member.
    const pendingReqId = '11111111-1111-4111-8111-111111111111';
    const nowMs = ctx.getNow().getTime();
    await ctx.db.insert(communitySovereigntyRequestsSqlite).values({
      id: pendingReqId,
      communityId: ctx.activeComm.id,
      kind: 'withdrawal',
      state: 'notice',
      initiatedBy: ctx.memberUser.id,
      initiatedByRole: 'steward',
      requestedAt: nowMs,
      noticeEndsAt: nowMs + 604_800_000,
      updatedAt: nowMs,
    });

    // Replace steward with null-community super_admin -> automatically cancels pending request!
    ctx.advanceMs(1000);
    const replaceRes = await ctx.call('PUT', '/v2/community/steward', {
      cookie: adminCookie,
      body: {
        stewardUserId: ctx.superAdmin.id,
        currentDerivedKey: ctx.adminCreds.derivedKey,
      },
    });
    expect(replaceRes.status).toBe(200);
    const replaceParsed = PutCommunityStewardResponseSchema.parse(
      await replaceRes.json()
    );
    expect(replaceParsed.data.steward).toMatchObject({
      userId: ctx.superAdmin.id,
      role: 'super_admin',
      status: 'active',
      sameCommunity: false,
      designatedBy: ctx.adminUser.id,
    });
    expect(replaceParsed.data.cancelledRequestIds).toEqual([pendingReqId]);

    const [cancelledRow] = await ctx.db
      .select()
      .from(communitySovereigntyRequestsSqlite)
      .where(eq(communitySovereigntyRequestsSqlite.id, pendingReqId));
    expect(cancelledRow?.state).toBe('cancelled');
    expect(cancelledRow?.cancelledBy).toBe(ctx.adminUser.id);

    // Former member steward can no longer generate recovery codes.
    expect(
      (
        await ctx.call('POST', '/v2/auth/recovery-codes', {
          cookie: memberCookie,
          body: { currentDerivedKey: ctx.memberCreds.derivedKey },
        })
      ).status
    ).toBe(403);

    // Remove steward (null).
    ctx.advanceMs(1000);
    const removeRes = await ctx.call('PUT', '/v2/community/steward', {
      cookie: adminCookie,
      body: {
        stewardUserId: null,
        currentDerivedKey: ctx.adminCreds.derivedKey,
      },
    });
    expect(removeRes.status).toBe(200);
    expect(
      PutCommunityStewardResponseSchema.parse(await removeRes.json()).data
        .steward
    ).toBeNull();

    // GET sovereignty reflects removal and cancelled request in recentRequests.
    const statusRes = await ctx.call('GET', '/v2/community/sovereignty', {
      cookie: adminCookie,
    });
    expect(statusRes.status).toBe(200);
    const statusParsed = CommunitySovereigntyStatusResponseSchema.parse(
      await statusRes.json()
    );
    expect(statusParsed.data.steward).toBeNull();
    expect(statusParsed.data.pendingRequests).toEqual([]);
    expect(statusParsed.data.recentRequests[0]?.id).toBe(pendingReqId);
    expect(statusParsed.data.recentRequests[0]?.state).toBe('cancelled');

    // Audit entries are content-free.
    const audits = await ctx.db
      .select()
      .from(auditEntriesSqlite)
      .where(eq(auditEntriesSqlite.communityId, ctx.activeComm.id));
    expect(
      audits.some(
        (a) =>
          a.action === 'community.sovereignty.steward.designated' &&
          a.outcome === 'success'
      )
    ).toBe(true);
    expect(
      audits.some(
        (a) =>
          a.action === 'community.sovereignty.steward.removed' &&
          a.outcome === 'success'
      )
    ).toBe(true);
    for (const entry of audits) {
      validateContentFreeAuditEntry({
        communityId: entry.communityId,
        actorId: entry.actorId,
        action: entry.action,
        resourceType: entry.resourceType,
        resourceIds: entry.resourceIds,
        outcome: entry.outcome,
        ipAddress: entry.ipAddress,
        userAgent: entry.userAgent,
      });
    }
  });

  it('supports one-shot admin_issued step-up and disabled-community steward authentication on D1 batch mode', async () => {
    const ctx = await setup({ d1Batch: true });

    // Disabled community own-admin designates disabledMember as steward.
    const disabledAdminCookie = await ctx.loginCookie(
      ctx.disabledAdmin.email,
      ctx.disabledAdminCreds.derivedKey
    );

    // Non-steward member in disabled community cannot log in.
    const deniedMemberLogin = await ctx.call('POST', '/v2/auth/login', {
      body: {
        identifier: ctx.disabledOtherMember.email,
        derivedKey: ctx.disabledOtherMemberCreds.derivedKey,
      },
    });
    expect(deniedMemberLogin.status).toBe(401);

    // Designated member in disabled community also cannot log in BEFORE designation.
    const beforeDesignateLogin = await ctx.call('POST', '/v2/auth/login', {
      body: {
        identifier: ctx.disabledMember.email,
        derivedKey: ctx.disabledMemberCreds.derivedKey,
      },
    });
    expect(beforeDesignateLogin.status).toBe(401);

    // Issue admin_issued code for disabledAdmin via a second disabled admin or recovery?
    // Actually disabledMember gets designated first, then disabledAdmin issues an admin_issued code for disabledMember?
    // Let's issue an admin_issued code for a second admin or test disabledMember after designation!
    const designateRes = await ctx.call('PUT', '/v2/community/steward', {
      cookie: disabledAdminCookie,
      body: {
        stewardUserId: ctx.disabledMember.id,
        currentDerivedKey: ctx.disabledAdminCreds.derivedKey,
      },
    });
    expect(designateRes.status).toBe(200);

    // Now disabledMember CAN authenticate on the disabled community and hold recovery codes!
    const stewardLoginCookie = await ctx.loginCookie(
      ctx.disabledMember.email,
      ctx.disabledMemberCreds.derivedKey
    );
    const stewardMe = await ctx.call('GET', '/v2/auth/me', {
      cookie: stewardLoginCookie,
    });
    expect(stewardMe.status).toBe(200);
    // Content routes remain denied on disabled community even for designated steward.
    expect(
      (await ctx.call('GET', '/v2/stories', { cookie: stewardLoginCookie }))
        .status
    ).toBe(403);
    expect(
      (
        await ctx.call('POST', '/v2/auth/recovery-codes', {
          cookie: stewardLoginCookie,
          body: { currentDerivedKey: ctx.disabledMemberCreds.derivedKey },
        })
      ).status
    ).toBe(201);

    // Test fresh admin_issued step-up session on active community admin.
    const adminCookie = await ctx.loginCookie(
      ctx.adminUser.email,
      ctx.adminCreds.derivedKey
    );
    // Create a second admin in activeComm and issue them an admin_issued code.
    const admin2Creds = {
      derivedKey: makeDerivedKey(),
      salt: makeVerifierSalt(),
      verifier: '',
    };
    admin2Creds.verifier = await sha256Hex(admin2Creds.derivedKey);
    const [admin2] = await ctx.db
      .insert(usersSqlite)
      .values({
        email: 'admin2@alpha.test',
        username: 'alpha_admin2',
        emailNormalized: normalizeSearchText('admin2@alpha.test'),
        usernameNormalized: normalizeSearchText('alpha_admin2'),
        firstName: 'Admin2',
        lastName: 'Alpha',
        ...(await argon2Seed(admin2Creds.derivedKey)),
        role: 'admin',
        communityId: ctx.activeComm.id,
        isActive: true,
        createdAt: ctx.getNow(),
        updatedAt: ctx.getNow(),
      })
      .returning();

    const issueRes = await ctx.call(
      'POST',
      `/v2/users/${admin2!.id}/login-codes`,
      { cookie: adminCookie, body: {} }
    );
    expect(issueRes.status).toBe(201);
    const code = ((await issueRes.json()) as { data: { code: string } }).data
      .code;

    const redeemRes = await ctx.call('POST', '/v2/auth/recovery/redeem', {
      body: { code },
    });
    expect(redeemRes.status).toBe(200);
    const stepUpCookie =
      /ts_session=([^;]+)/.exec(
        redeemRes.headers.get('set-cookie') ?? ''
      )?.[0] ?? '';
    expect(stepUpCookie).toBeTruthy();

    // 404 invalid target must NOT consume the one-shot admin_issued step-up.
    const invalidTarget = await ctx.call('PUT', '/v2/community/steward', {
      cookie: stepUpCookie,
      body: { stewardUserId: ctx.foreignUser.id },
    });
    expect(invalidTarget.status).toBe(404);

    // Valid steward designation succeeds without currentDerivedKey on first use.
    const validStepUp = await ctx.call('PUT', '/v2/community/steward', {
      cookie: stepUpCookie,
      body: { stewardUserId: ctx.memberUser.id },
    });
    expect(validStepUp.status).toBe(200);

    // Second call without currentDerivedKey fails 401 (one-shot consumed).
    const replayStepUp = await ctx.call('PUT', '/v2/community/steward', {
      cookie: stepUpCookie,
      body: { stewardUserId: null },
    });
    expect(replayStepUp.status).toBe(401);

    // Throttle blocks after AUTH_THROTTLE_MAX_FAILURES failed password step-ups.
    for (let i = 0; i < AUTH_THROTTLE_MAX_FAILURES; i++) {
      const failRes = await ctx.call('PUT', '/v2/community/steward', {
        cookie: adminCookie,
        body: {
          stewardUserId: null,
          currentDerivedKey: makeDerivedKey(),
        },
        ip: '198.51.100.77',
      });
      expect(failRes.status).toBe(401);
    }
    const blockedRes = await ctx.call('PUT', '/v2/community/steward', {
      cookie: adminCookie,
      body: {
        stewardUserId: null,
        currentDerivedKey: ctx.adminCreds.derivedKey,
      },
      ip: '198.51.100.77',
    });
    expect(blockedRes.status).toBe(401);

    // Suppress unused warning on communityStewardsSqlite import check
    expect(
      (
        await ctx.db
          .select()
          .from(communityStewardsSqlite)
          .where(eq(communityStewardsSqlite.communityId, ctx.activeComm.id))
      )[0]?.userId
    ).toBe(ctx.memberUser.id);
  });
  for (const d1Batch of [false, true]) {
    it(`withdraws immediately, invalidates sessions and URLs, preserves rows and admin sovereignty (D1=${d1Batch})`, async () => {
      const ctx = await setup({ d1Batch });
      const adminCookie = await ctx.loginCookie(
        ctx.adminUser.email,
        ctx.adminCreds.derivedKey
      );
      const memberCookie = await ctx.loginCookie(
        ctx.memberUser.email,
        ctx.memberCreds.derivedKey
      );
      const post = (body: unknown, cookie = adminCookie) =>
        ctx.call('POST', '/v2/community/withdrawal', { cookie, body });
      expect(
        (
          await post(
            { currentDerivedKey: ctx.memberCreds.derivedKey },
            memberCookie
          )
        ).status
      ).toBe(403);
      expect((await post({})).status).toBe(401);
      expect(
        (
          await post({
            communityId: ctx.foreignComm.id,
            currentDerivedKey: ctx.adminCreds.derivedKey,
          })
        ).status
      ).toBe(400);
      expect((await post({ currentDerivedKey: makeDerivedKey() })).status).toBe(
        401
      );
      const withdrawn = await post({
        currentDerivedKey: ctx.adminCreds.derivedKey,
      });
      expect(withdrawn.status).toBe(200);
      expect(await withdrawn.json()).toMatchObject({
        data: {
          status: 'disabled',
          request: {
            kind: 'withdrawal',
            state: 'completed',
            initiatedByRole: 'admin',
          },
        },
      });
      expect(withdrawn.headers.get('cache-control')).toBe('no-store');
      expect(
        (await ctx.call('GET', '/v2/stories', { cookie: memberCookie })).status
      ).toBe(401);
      expect(
        (
          await ctx.call('GET', '/v2/community/sovereignty', {
            cookie: adminCookie,
          })
        ).status
      ).toBe(401);
      expect(
        (await ctx.call('GET', '/v2/public/communities/alpha-sov')).status
      ).toBe(404);
      const fresh = await ctx.loginCookie(
        ctx.adminUser.email,
        ctx.adminCreds.derivedKey
      );
      expect(
        (await ctx.call('GET', '/v2/community/sovereignty', { cookie: fresh }))
          .status
      ).toBe(200);
      expect((await ctx.db.select().from(usersSqlite)).length).toBe(11);
      expect((await ctx.db.select().from(communitiesSqlite)).length).toBe(3);
    });

    it(`lets an acting admin withdraw immediately despite a steward notice (D1=${d1Batch})`, async () => {
      const ctx = await setup({ d1Batch });
      const adminCookie = await ctx.loginCookie(
        ctx.adminUser.email,
        ctx.adminCreds.derivedKey
      );
      const memberCookie = await ctx.loginCookie(
        ctx.memberUser.email,
        ctx.memberCreds.derivedKey
      );
      expect(
        (
          await ctx.call('PUT', '/v2/community/steward', {
            cookie: adminCookie,
            body: {
              stewardUserId: ctx.memberUser.id,
              currentDerivedKey: ctx.adminCreds.derivedKey,
            },
          })
        ).status
      ).toBe(200);
      const noticeResponse = await ctx.call(
        'POST',
        '/v2/community/withdrawal',
        {
          cookie: memberCookie,
          body: { currentDerivedKey: ctx.memberCreds.derivedKey },
        }
      );
      expect(noticeResponse.status).toBe(202);
      const noticeId = (await noticeResponse.json()).data.request.id;
      const response = await ctx.call('POST', '/v2/community/withdrawal', {
        cookie: adminCookie,
        body: { currentDerivedKey: ctx.adminCreds.derivedKey },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        data: {
          status: 'disabled',
          request: { state: 'completed', initiatedByRole: 'admin' },
        },
      });
      const [notice] = await ctx.db
        .select()
        .from(communitySovereigntyRequestsSqlite)
        .where(eq(communitySovereigntyRequestsSqlite.id, noticeId));
      expect(notice).toMatchObject({
        state: 'cancelled',
        cancelledBy: ctx.adminUser.id,
      });
      expect(
        (await ctx.db.select().from(auditEntriesSqlite)).filter(
          (row) => row.action === 'community.sovereignty.request.cancelled'
        )
      ).toHaveLength(1);
    });

    it(`rejects stale step-up before superseding a steward notice (D1=${d1Batch})`, async () => {
      const ctx = await setup({ d1Batch });
      const adminCookie = await ctx.loginCookie(
        ctx.adminUser.email,
        ctx.adminCreds.derivedKey
      );
      const memberCookie = await ctx.loginCookie(
        ctx.memberUser.email,
        ctx.memberCreds.derivedKey
      );
      expect(
        (
          await ctx.call('PUT', '/v2/community/steward', {
            cookie: adminCookie,
            body: {
              stewardUserId: ctx.memberUser.id,
              currentDerivedKey: ctx.adminCreds.derivedKey,
            },
          })
        ).status
      ).toBe(200);
      const response = await ctx.call('POST', '/v2/community/withdrawal', {
        cookie: memberCookie,
        body: { currentDerivedKey: ctx.memberCreds.derivedKey },
      });
      expect(response.status).toBe(202);
      const noticeId = (await response.json()).data.request.id;
      const repo = new CommunitySovereigntyRepository(ctx.db);
      // Models credentials changing after the service's password verification.
      expect(
        await repo.requestWithdrawal({
          communityId: ctx.activeComm.id,
          actorId: ctx.adminUser.id,
          role: 'admin',
          requestId: crypto.randomUUID(),
          stepUp: {
            mode: 'password',
            passwordHash: 'stale-hash',
            expectedVerifier: 'stale-verifier',
          },
          now: ctx.getNow(),
          noticeEndsAt: null,
          auditMeta: { ipAddress: null, userAgent: null },
        })
      ).toBeNull();
      expect(
        (
          await ctx.db
            .select()
            .from(communitySovereigntyRequestsSqlite)
            .where(eq(communitySovereigntyRequestsSqlite.id, noticeId))
        )[0]?.state
      ).toBe('notice');
      expect(
        (await ctx.db.select().from(auditEntriesSqlite)).filter(
          (row) => row.action === 'community.sovereignty.request.cancelled'
        )
      ).toHaveLength(0);
    });

    it(`holds steward notices, allows admin cancellation, and applies uncancelled notices after restart (D1=${d1Batch})`, async () => {
      const ctx = await setup({ d1Batch });
      const adminCookie = await ctx.loginCookie(
        ctx.adminUser.email,
        ctx.adminCreds.derivedKey
      );
      const memberCookie = await ctx.loginCookie(
        ctx.memberUser.email,
        ctx.memberCreds.derivedKey
      );
      const designate = await ctx.call('PUT', '/v2/community/steward', {
        cookie: adminCookie,
        body: {
          stewardUserId: ctx.memberUser.id,
          currentDerivedKey: ctx.adminCreds.derivedKey,
        },
      });
      expect(designate.status).toBe(200);
      const start = () =>
        ctx.call('POST', '/v2/community/withdrawal', {
          cookie: memberCookie,
          body: { currentDerivedKey: ctx.memberCreds.derivedKey },
        });
      const first = await start();
      expect(first.status).toBe(202);
      const notice = (await first.json()).data.request;
      expect(
        Date.parse(notice.noticeEndsAt) - Date.parse(notice.requestedAt)
      ).toBe(7 * 86400000);
      expect((await start()).status).toBe(409);
      expect(
        (
          await ctx.db
            .select()
            .from(communitiesSqlite)
            .where(eq(communitiesSqlite.id, ctx.activeComm.id))
        )[0]!.isActive
      ).toBe(true);
      expect(
        (
          await ctx.call('POST', '/v2/community/sovereignty/cancel', {
            cookie: memberCookie,
            body: {
              requestId: notice.id,
              currentDerivedKey: ctx.memberCreds.derivedKey,
            },
          })
        ).status
      ).toBe(403);
      expect(
        (
          await ctx.call('POST', '/v2/community/sovereignty/cancel', {
            cookie: adminCookie,
            body: { requestId: notice.id },
          })
        ).status
      ).toBe(401);
      expect(
        (
          await ctx.call('POST', '/v2/community/sovereignty/cancel', {
            cookie: adminCookie,
            body: {
              requestId: notice.id,
              currentDerivedKey: ctx.adminCreds.derivedKey,
            },
          })
        ).status
      ).toBe(200);
      const second = await start();
      expect(second.status).toBe(202);
      const secondId = (await second.json()).data.request.id;
      ctx.advanceMs(7 * 86400000 - 1);
      const repo = new CommunitySovereigntyRepository(ctx.db);
      await repo.applyDueWithdrawals(ctx.getNow());
      expect(
        (
          await ctx.db
            .select()
            .from(communitiesSqlite)
            .where(eq(communitiesSqlite.id, ctx.activeComm.id))
        )[0]!.isActive
      ).toBe(true);
      ctx.advanceMs(1);
      // New repository instance models persisted restart, including two competing sweeps.
      await Promise.all([
        repo.applyDueWithdrawals(ctx.getNow()),
        new CommunitySovereigntyRepository(ctx.db).applyDueWithdrawals(
          ctx.getNow()
        ),
      ]);
      const row = (
        await ctx.db
          .select()
          .from(communitySovereigntyRequestsSqlite)
          .where(eq(communitySovereigntyRequestsSqlite.id, secondId))
      )[0]!;
      expect(row.state).toBe('completed');
      expect(row.effectiveAt).toBe(ctx.getNow().getTime());
      expect(
        (
          await ctx.db
            .select()
            .from(communitiesSqlite)
            .where(eq(communitiesSqlite.id, ctx.activeComm.id))
        )[0]!.isActive
      ).toBe(false);
      expect(
        (await ctx.call('GET', '/v2/auth/me', { cookie: memberCookie })).status
      ).toBe(401);
      const audits = await ctx.db
        .select()
        .from(auditEntriesSqlite)
        .where(
          eq(
            auditEntriesSqlite.action,
            'community.sovereignty.withdrawal.completed'
          )
        );
      expect(audits).toHaveLength(1);
    });
  }

  it('consumes fresh admin-issued authority only on a successful cancellation or withdrawal', async () => {
    const ctx = await setup({ d1Batch: true });
    const adminCookie = await ctx.loginCookie(
      ctx.adminUser.email,
      ctx.adminCreds.derivedKey
    );
    const memberCookie = await ctx.loginCookie(
      ctx.memberUser.email,
      ctx.memberCreds.derivedKey
    );
    await ctx.call('PUT', '/v2/community/steward', {
      cookie: adminCookie,
      body: {
        stewardUserId: ctx.memberUser.id,
        currentDerivedKey: ctx.adminCreds.derivedKey,
      },
    });
    const started = await ctx.call('POST', '/v2/community/withdrawal', {
      cookie: memberCookie,
      body: { currentDerivedKey: ctx.memberCreds.derivedKey },
    });
    expect(started.status).toBe(202);
    const requestId = (await started.json()).data.request.id;
    const fresh = () =>
      ctx.db
        .update(sessionsSqlite)
        .set({ adminCodeStepUpExpiresAt: ctx.getNow().getTime() + 900000 })
        .where(eq(sessionsSqlite.userId, ctx.adminUser.id));
    await fresh();
    const cancel = (id: string) =>
      ctx.call('POST', '/v2/community/sovereignty/cancel', {
        cookie: adminCookie,
        body: { requestId: id },
      });
    expect((await cancel(crypto.randomUUID())).status).toBe(409);
    expect((await cancel(requestId)).status).toBe(200);
    // Same-clock retry must not audit another cancellation or consume a new
    // one-shot step-up merely because a historical cancelled row matches.
    await fresh();
    expect((await cancel(requestId)).status).toBe(409);
    expect(
      (await ctx.db.select().from(auditEntriesSqlite)).filter(
        (row) => row.action === 'community.sovereignty.request.cancelled'
      )
    ).toHaveLength(1);
    expect(
      (
        await ctx.call('PUT', '/v2/community/steward', {
          cookie: adminCookie,
          body: { stewardUserId: ctx.memberUser.id },
        })
      ).status
    ).toBe(200);
    expect(
      (
        await ctx.call('POST', '/v2/community/withdrawal', {
          cookie: adminCookie,
          body: {},
        })
      ).status
    ).toBe(401);
    await fresh();
    expect(
      (
        await ctx.call('POST', '/v2/community/withdrawal', {
          cookie: adminCookie,
          body: {},
        })
      ).status
    ).toBe(200);
    expect(
      (await ctx.call('GET', '/v2/auth/me', { cookie: adminCookie })).status
    ).toBe(401);
  });

  it('requires an explicit, designated community for a null-community super-admin steward', async () => {
    const ctx = await setup();
    const adminCookie = await ctx.loginCookie(
      ctx.adminUser.email,
      ctx.adminCreds.derivedKey
    );
    const superCookie = await ctx.loginCookie(
      ctx.superAdmin.email,
      ctx.superAdminCreds.derivedKey
    );
    const call = (body: unknown) =>
      ctx.call('POST', '/v2/community/withdrawal', {
        cookie: superCookie,
        body,
      });
    expect(
      (await call({ currentDerivedKey: ctx.superAdminCreds.derivedKey })).status
    ).toBe(400);
    expect(
      (
        await call({
          communitySlug: ctx.activeComm.slug,
          currentDerivedKey: ctx.superAdminCreds.derivedKey,
        })
      ).status
    ).toBe(403);
    expect(
      (
        await ctx.call('PUT', '/v2/community/steward', {
          cookie: adminCookie,
          body: {
            stewardUserId: ctx.superAdmin.id,
            currentDerivedKey: ctx.adminCreds.derivedKey,
          },
        })
      ).status
    ).toBe(200);
    expect(
      (
        await call({
          communityId: ctx.foreignComm.id,
          currentDerivedKey: ctx.superAdminCreds.derivedKey,
        })
      ).status
    ).toBe(403);
    expect(
      (
        await call({
          communityId: ctx.activeComm.id,
          communitySlug: ctx.activeComm.slug,
          currentDerivedKey: ctx.superAdminCreds.derivedKey,
        })
      ).status
    ).toBe(400);
    expect(
      (
        await call({
          communitySlug: ctx.activeComm.slug,
          currentDerivedKey: ctx.superAdminCreds.derivedKey,
        })
      ).status
    ).toBe(202);
    expect(
      (
        await ctx.call('GET', '/v2/community/sovereignty', {
          cookie: superCookie,
        })
      ).status
    ).toBe(403);
    expect(
      (
        await ctx.call('POST', '/v2/community/sovereignty/cancel', {
          cookie: adminCookie,
          body: { currentDerivedKey: ctx.adminCreds.derivedKey },
        })
      ).status
    ).toBe(200);
    expect(
      (
        await call({
          communityId: ctx.activeComm.id,
          currentDerivedKey: ctx.superAdminCreds.derivedKey,
        })
      ).status
    ).toBe(202);
  });
  for (const d1Batch of [false, true]) {
    it(`erasure retries bytes before rows, blocks export, survives restart and guards restore (D1=${d1Batch})`, async () => {
      const ctx = await setup({ d1Batch });
      const cookie = await ctx.loginCookie(
        ctx.adminUser.email!,
        ctx.adminCreds.derivedKey
      );
      const own = `communities/${ctx.activeComm.id}/media/test-object`;
      const foreign = `communities/${ctx.foreignComm.id}/media/test-object`;
      ctx.objects.set(own, new Uint8Array([1]));
      ctx.objects.set(foreign, new Uint8Array([2]));
      expect(
        (
          await ctx.call('POST', '/v2/community/erasure', {
            cookie,
            body: { confirmFinality: true },
          })
        ).status
      ).toBe(401);
      expect(
        (
          await ctx.call('POST', '/v2/community/erasure', {
            cookie,
            body: {
              confirmFinality: false,
              currentDerivedKey: ctx.adminCreds.derivedKey,
            },
          })
        ).status
      ).toBe(400);
      const legacyKey = 'legacy/community-file';
      const foreignKey = 'legacy/foreign-file';
      ctx.objects.set(legacyKey, new Uint8Array([3]));
      ctx.objects.set(foreignKey, new Uint8Array([4]));
      for (const [key, uploader] of [
        [legacyKey, ctx.adminUser.id],
        [foreignKey, ctx.foreignUser.id],
      ] as const)
        await ctx.db.insert(filesSqlite).values({
          id: crypto.randomUUID(),
          filename: 'legacy',
          originalName: 'legacy',
          path: key,
          storageKey: key,
          url: 'https://example.test/file',
          mimeType: 'image/png',
          size: 1,
          communityId: null,
          uploadedBy: uploader,
        });
      await ctx.db.insert(communityArchiveCustodySqlite).values({
        communityId: ctx.activeComm.id,
        custodianType: 'community',
        custodianUserId: ctx.adminUser.id,
        status: 'destroyed',
        retentionUntil: ctx.getNow().getTime(),
        destroyedAt: ctx.getNow().getTime(),
        destructionAttestationRef: 'attestation-ref',
        createdAt: 0,
        updatedAt: 0,
      });
      // Both the request write and its immediate sweep fail; the durable DB
      // request must still acknowledge acceptance and survive a process restart.
      const write = vi
        .spyOn(ctx.erasureStore, 'write')
        .mockRejectedValueOnce(new Error('unavailable'))
        .mockRejectedValueOnce(new Error('unavailable'));
      const response = await ctx.call('POST', '/v2/community/erasure', {
        cookie,
        body: {
          confirmFinality: true,
          currentDerivedKey: ctx.adminCreds.derivedKey,
        },
      });
      expect(response.status).toBe(202);
      expect((await response.json()).data.request.state).toBe('requested');
      expect(write).toHaveBeenCalledTimes(2);
      write.mockRestore();
      await ctx.erasureService.sweep(ctx.getNow());
      expect(ctx.objects.has(own)).toBe(false);
      expect(ctx.objects.has(legacyKey)).toBe(false);
      expect(ctx.objects.has(foreignKey)).toBe(true);
      expect(ctx.objects.has(foreign)).toBe(true);
      expect(ctx.records.get(ctx.activeComm.id)?.completedAt).toBeNull();
      await expect(
        verifyErasureRestorePoint(ctx.erasureStore, ctx.getNow())
      ).rejects.toThrow('Restore point');
      const afterCookie = await ctx.loginCookie(
        ctx.adminUser.email!,
        ctx.adminCreds.derivedKey
      );
      expect(
        (
          await ctx.call('POST', '/v2/community/export', {
            cookie: afterCookie,
            body: {},
          })
        ).status
      ).toBe(403);
      const restarted = new CommunityErasureService(
        new CommunitySovereigntyRepository(ctx.db),
        ctx.storage,
        ctx.erasureStore,
        ctx.getNow
      );
      await restarted.sweep(ctx.getNow());
      expect(
        await ctx.db
          .select()
          .from(communitiesSqlite)
          .where(eq(communitiesSqlite.id, ctx.activeComm.id))
      ).toHaveLength(0);
      expect(ctx.records.get(ctx.activeComm.id)?.outcome).toBe('completed');
      expect(ctx.records.get(ctx.activeComm.id)?.archiveCustody).toEqual({
        custodianType: 'community',
        custodianUserId: ctx.adminUser.id,
        retentionUntil: ctx.getNow().toISOString(),
        destructionAttestationRef: 'attestation-ref',
      });
      expect(
        await ctx.db
          .select()
          .from(communityArchiveCustodySqlite)
          .where(
            eq(communityArchiveCustodySqlite.communityId, ctx.activeComm.id)
          )
      ).toHaveLength(0);
      const remainingFiles = await ctx.db.select().from(filesSqlite);
      expect(remainingFiles.map((file) => file.storageKey)).toEqual([
        foreignKey,
      ]);

      await ctx.db.insert(communitiesSqlite).values({
        id: ctx.activeComm.id,
        name: 'Restored',
        slug: 'restored-erased',
        isActive: true,
      });
      ctx.objects.set(own, new Uint8Array([9]));
      await restarted.reconcileRestore(ctx.getNow(), ctx.getNow());
      expect(ctx.objects.has(own)).toBe(false);
      expect(
        await ctx.db
          .select()
          .from(communitiesSqlite)
          .where(eq(communitiesSqlite.id, ctx.activeComm.id))
      ).toHaveLength(0);

      await verifyErasureRestorePoint(ctx.erasureStore, ctx.getNow());
      await expect(
        verifyErasureRestorePoint(
          ctx.erasureStore,
          new Date(ctx.getNow().getTime() - 1)
        )
      ).rejects.toThrow();
      const systemCookie = await ctx.loginCookie(
        ctx.superAdmin.email!,
        ctx.superAdminCreds.derivedKey
      );
      const listing = await ctx.call('GET', '/v2/admin/erasures', {
        cookie: systemCookie,
      });
      expect(listing.status).toBe(200);
      expect((await listing.json()).data[0].requestingActorId).toBe(
        ctx.adminUser.id
      );
      ctx.advanceMs(30 * 86400000);
      const freshSystemCookie = await ctx.loginCookie(
        ctx.superAdmin.email!,
        ctx.superAdminCreds.derivedKey
      );
      const redacted = await ctx.call('GET', '/v2/admin/erasures', {
        cookie: freshSystemCookie,
      });
      expect((await redacted.json()).data[0].requestingActorId).toBeNull();
      expect(ctx.records.get(ctx.activeComm.id)?.requestingActorId).toBeNull();
    });
  }

  for (const d1Batch of [false, true]) {
    it(`fails closed while a sixth due erasure awaits activation (D1=${d1Batch})`, async () => {
      const ctx = await setup({ d1Batch });
      for (let i = 0; i < 6; i++) {
        const [community] = await ctx.db
          .insert(communitiesSqlite)
          .values({
            name: `Due ${i}`,
            slug: `due-${i}`,
            isActive: true,
          })
          .returning();
        await ctx.db.insert(communitySovereigntyRequestsSqlite).values({
          id: crypto.randomUUID(),
          communityId: community!.id,
          kind: 'erasure',
          state: 'notice',
          initiatedByRole: 'steward',
          requestedAt: ctx.getNow().getTime() - 1000,
          noticeEndsAt: ctx.getNow().getTime(),
          updatedAt: ctx.getNow().getTime(),
        });
      }
      expect((await ctx.call('GET', '/v2/public/communities')).status).toBe(
        503
      );
      expect((await ctx.call('GET', '/v2/public/communities')).status).not.toBe(
        503
      );
      const repository = new CommunitySovereigntyRepository(ctx.db);
      const discovered = [
        ...(await repository.erasureWork(5, new Date(0))),
        ...(await repository.erasureWork(5, new Date(60000))),
      ];
      expect(new Set(discovered.map((row) => row.communityId)).size).toBe(6);
    });

    it(`admin erasure atomically supersedes the matching steward notice (D1=${d1Batch})`, async () => {
      const ctx = await setup({ d1Batch });
      const noticeId = crypto.randomUUID();
      ctx.objects.set(
        `communities/${ctx.activeComm.id}/media/pending`,
        new Uint8Array([1])
      );
      await ctx.db.insert(communitySovereigntyRequestsSqlite).values({
        id: noticeId,
        communityId: ctx.activeComm.id,
        kind: 'erasure',
        state: 'notice',
        initiatedByRole: 'steward',
        requestedAt: ctx.getNow().getTime(),
        noticeEndsAt: ctx.getNow().getTime() + 604800000,
        updatedAt: ctx.getNow().getTime(),
      });
      const cookie = await ctx.loginCookie(
        ctx.adminUser.email!,
        ctx.adminCreds.derivedKey
      );
      const response = await ctx.call('POST', '/v2/community/erasure', {
        cookie,
        body: {
          confirmFinality: true,
          currentDerivedKey: ctx.adminCreds.derivedKey,
        },
      });
      expect(response.status).toBe(202);
      const rows = await ctx.db
        .select()
        .from(communitySovereigntyRequestsSqlite)
        .where(eq(communitySovereigntyRequestsSqlite.id, noticeId));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.state).toBe('cancelled');
      expect(rows[0]!.cancelledBy).toBe(ctx.adminUser.id);
    });
  }

  it('steward erasure stays cancellable until its deadline then starts deletion', async () => {
    const ctx = await setup();
    const admin = await ctx.loginCookie(
      ctx.adminUser.email!,
      ctx.adminCreds.derivedKey
    );
    expect(
      (
        await ctx.call('PUT', '/v2/community/steward', {
          cookie: admin,
          body: {
            stewardUserId: ctx.memberUser.id,
            currentDerivedKey: ctx.adminCreds.derivedKey,
          },
        })
      ).status
    ).toBe(200);
    const steward = await ctx.loginCookie(
      ctx.memberUser.email!,
      ctx.memberCreds.derivedKey
    );
    const body = {
      confirmFinality: true,
      currentDerivedKey: ctx.memberCreds.derivedKey,
    };
    const notice = await ctx.call('POST', '/v2/community/erasure', {
      cookie: steward,
      body,
    });
    expect(notice.status).toBe(202);
    expect((await notice.json()).data.request.state).toBe('notice');
    expect(ctx.records.size).toBe(0);
    expect(
      (
        await ctx.call('POST', '/v2/community/sovereignty/cancel', {
          cookie: admin,
          body: { currentDerivedKey: ctx.adminCreds.derivedKey },
        })
      ).status
    ).toBe(200);
    expect(
      (
        await ctx.call('POST', '/v2/community/erasure', {
          cookie: steward,
          body,
        })
      ).status
    ).toBe(202);
    ctx.advanceMs(7 * 86400000);
    await ctx.erasureService.sweep(ctx.getNow());
    expect(ctx.records.get(ctx.activeComm.id)?.requestingActorId).toBe(
      ctx.memberUser.id
    );
    expect(ctx.records.get(ctx.activeComm.id)?.outcome).toBe('completed');
  });

  it('failed storage deletion retains rows and pending record until a later pass', async () => {
    const ctx = await setup();
    const cookie = await ctx.loginCookie(
      ctx.adminUser.email!,
      ctx.adminCreds.derivedKey
    );
    const key = `communities/${ctx.activeComm.id}/media/interrupted`;
    ctx.objects.set(key, new Uint8Array([1]));
    const original = ctx.storage.delete;
    ctx.storage.delete = async () => {
      throw new Error('simulated failure');
    };
    expect(
      (
        await ctx.call('POST', '/v2/community/erasure', {
          cookie,
          body: {
            confirmFinality: true,
            currentDerivedKey: ctx.adminCreds.derivedKey,
          },
        })
      ).status
    ).toBe(202);
    expect(ctx.objects.has(key)).toBe(true);
    expect(ctx.records.get(ctx.activeComm.id)?.outcome).toBe('pending');
    expect(
      await ctx.db
        .select()
        .from(usersSqlite)
        .where(eq(usersSqlite.communityId, ctx.activeComm.id))
    ).not.toHaveLength(0);
    await expect(async () => {
      await ctx.db
        .update(communitiesSqlite)
        .set({ isActive: true })
        .where(eq(communitiesSqlite.id, ctx.activeComm.id));
    }).rejects.toThrow();
    ctx.storage.delete = original;
    await ctx.erasureService.sweep(ctx.getNow());
    await ctx.erasureService.sweep(ctx.getNow());
    expect(ctx.records.get(ctx.activeComm.id)?.outcome).toBe('completed');
  });
});
