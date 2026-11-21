/**
 * Focused tests for Slice 14-B system administration endpoints:
 * - PATCH /v2/admin/communities/:id/status
 * - DELETE /v2/admin/communities/:id
 * - GET /v2/admin/audit-entries
 *
 * Covers SPEC-V2 §6.1, §6.2, §6.8, §7 and route registry §10:
 * - Authz matrix (401 unauth, 403 community roles / non-null super_admin, CSRF 403)
 * - Status toggle (`disabled` purges community standard & device sessions while leaving
 *   other communities and super_admin intact; idempotent disable purges disabled-admin
 *   session; `active` restores without disturbing live active sessions; operational-only
 *   projections; atomic system audit + trigger rollback)
 * - Deprovision (`204` on empty unclaimed community even with claim_tokens, claim
 *   throttles, and pre-claim audit entries; allows same slug reprovision; `409` + failure
 *   audit when claimed, bootstrapped, user-bearing, or content-bearing; audit rollback)
 * - System audit read (`communityId IS NULL` only; zero leakage of community audit rows;
 *   deterministic `createdAt DESC, id DESC` tie-broken pagination; `action`/`outcome`
 *   filters; strict rejection of `communityId` query param; content-free checks)
 * - Existing `super_admin` boundary verification across community content endpoints
 */
import { afterEach, describe, expect, it } from 'vitest';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import { createHonoApp } from '../../src/hono-app.js';
import { HonoFoundationRepository } from '../../src/repositories/hono-foundation.repository.js';
import { AdminRepository } from '../../src/repositories/admin.repository.js';
import { BootstrapRepository } from '../../src/repositories/bootstrap.repository.js';
import { HonoAuthRepository } from '../../src/repositories/hono-auth.repository.js';
import { BootstrapService } from '../../src/services/bootstrap.service.js';
import { communitiesSqlite } from '../../src/db/schema/communities.js';
import { usersSqlite } from '../../src/db/schema/users.js';
import {
  claimTokensSqlite,
  installationBootstrapSqlite,
  loginCodesSqlite,
} from '../../src/db/schema/login_codes.js';
import { storiesSqlite } from '../../src/db/schema/stories.js';
import { placesSqlite } from '../../src/db/schema/places.js';
import { speakersSqlite } from '../../src/db/schema/speakers.js';
import { filesSqlite } from '../../src/db/schema/files.js';
import { attachmentsSqlite } from '../../src/db/schema/attachments.js';
import { communityMapConfigsSqlite } from '../../src/db/schema/community_map_configs.js';
import { themesSqlite } from '../../src/db/schema/themes.js';
import {
  authThrottleSqlite,
  sessionsSqlite,
} from '../../src/db/schema/sessions.js';
import { auditEntriesSqlite } from '../../src/db/schema/audit_entries.js';
import {
  ARGON2ID_ALGORITHM,
  ARGON2ID_PARAMS,
} from '../../src/shared/auth-policy.js';
import { sha256Hex } from '../../src/shared/auth-crypto.js';
import {
  AdminAuditEntryListResponseSchema,
  AdminCommunityResponseSchema,
  ClaimTokenIssuedResponseSchema,
} from '../../src/shared/schemas/admin.js';
import { validateContentFreeAuditEntry } from '../../src/shared/utils/audit-entry.js';
import {
  argon2Seed,
  makeDerivedKey,
  makeServerSecret,
  makeVerifierSalt,
} from './auth-test-utils.js';

const API_ORIGIN = 'https://api.example.test';
const FOREIGN_ORIGIN = 'https://evil.invalid';

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

const makePasswordPayload = (derivedKey: string = makeDerivedKey()) => ({
  algorithm: ARGON2ID_ALGORITHM,
  salt: makeVerifierSalt(),
  params: { ...ARGON2ID_PARAMS },
  derivedKey,
});

describe('Slice 14-B /v2/admin status, deprovision, audit-entries & isolation', () => {
  const openDbs: Sqlite.Database[] = [];

  afterEach(() => {
    while (openDbs.length > 0) openDbs.pop()?.close();
  });

  async function setup(options: { useD1Batch?: boolean } = {}) {
    const sqlite = new Sqlite(':memory:');
    sqlite.pragma('foreign_keys = ON');
    openDbs.push(sqlite);
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: 'src/db/migrations' });
    if (options.useD1Batch) installD1BatchEmulation(db);

    let currentNow = new Date();
    const advanceMs = (ms: number) => {
      currentNow = new Date(currentNow.getTime() + ms);
    };
    const secret = makeServerSecret();

    const saKey = makeDerivedKey();
    const [superAdmin] = await db
      .insert(usersSqlite)
      .values({
        email: 'sa@admin-14b.example.test',
        username: 'slice14b_super_admin',
        emailNormalized: 'sa@admin-14b.example.test',
        usernameNormalized: 'slice14b_super_admin',
        firstName: '',
        lastName: '',
        ...(await argon2Seed(saKey)),
        role: 'super_admin',
        communityId: null,
        isActive: true,
        createdAt: currentNow,
        updatedAt: currentNow,
      })
      .returning();

    const [seedCommunity] = await db
      .insert(communitiesSqlite)
      .values({
        name: 'Sensitive Community Alpha',
        description: '<p>Protected cultural narrative</p>',
        descriptionPlain: 'Protected cultural narrative',
        slug: 'seed-alpha',
        locale: 'pt-BR',
        country: 'BR',
        publicStories: true,
        isActive: true,
        createdAt: currentNow,
        updatedAt: currentNow,
      })
      .returning();

    const [otherCommunity] = await db
      .insert(communitiesSqlite)
      .values({
        name: 'Other Community Beta',
        description: '<p>Other community text</p>',
        descriptionPlain: 'Other community text',
        slug: 'other-beta',
        locale: 'es',
        country: 'CO',
        publicStories: true,
        isActive: true,
        createdAt: currentNow,
        updatedAt: currentNow,
      })
      .returning();

    const [disabledCommunity] = await db
      .insert(communitiesSqlite)
      .values({
        name: 'Disabled Community Gamma',
        description: '<p>Disabled text</p>',
        descriptionPlain: 'Disabled text',
        slug: 'disabled-gamma',
        locale: 'en',
        country: null,
        publicStories: false,
        isActive: false,
        createdAt: currentNow,
        updatedAt: currentNow,
      })
      .returning();

    const app = createHonoApp({
      repository: new HonoFoundationRepository(db),
      storage: {
        read: async () => ({ body: new Uint8Array([1, 2, 3]), size: 3 }),
      },
      serverSecret: secret,
      secureCookies: false,
      publicOrigin: API_ORIGIN,
      trustProxy: true,
      isWorkers: true,
      now: () => currentNow,
    });

    const loginAs = async (
      identifier: string,
      derivedKey: string,
      opts: {
        communitySlug?: string;
        deviceSession?: boolean;
        ip?: string;
      } = {}
    ): Promise<string> => {
      const res = await app.request(`${API_ORIGIN}/v2/auth/login`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'cf-connecting-ip': opts.ip ?? '203.0.113.10',
        },
        body: JSON.stringify({
          identifier,
          derivedKey,
          ...(opts.communitySlug === undefined
            ? {}
            : { communitySlug: opts.communitySlug }),
          ...(opts.deviceSession ? { deviceSession: true } : {}),
        }),
      });
      expect(res.status).toBe(200);
      return (res.headers.get('set-cookie') ?? '').split(';')[0]!;
    };

    const roleCookies: Record<string, string> = {};
    const roleCreds: Record<string, { email: string; key: string }> = {};

    roleCookies.super_admin = await loginAs(superAdmin.email, saKey);
    roleCreds.super_admin = { email: superAdmin.email, key: saKey };

    for (const role of ['viewer', 'member', 'editor', 'admin'] as const) {
      const key = makeDerivedKey();
      const email = `${role}@seed-14b.example.test`;
      await db.insert(usersSqlite).values({
        email,
        username: `s14b_${role}`,
        emailNormalized: email,
        usernameNormalized: `s14b_${role}`,
        firstName: '',
        lastName: '',
        ...(await argon2Seed(key)),
        role,
        communityId: seedCommunity.id,
        isActive: true,
        createdAt: currentNow,
        updatedAt: currentNow,
      });
      roleCreds[role] = { email, key };
      roleCookies[role] = await loginAs(email, key, {
        communitySlug: seedCommunity.slug,
        deviceSession: role === 'member',
      });
    }

    const otherAdminKey = makeDerivedKey();
    const otherAdminEmail = 'admin@other-14b.example.test';
    await db.insert(usersSqlite).values({
      email: otherAdminEmail,
      username: 's14b_other_admin',
      emailNormalized: otherAdminEmail,
      usernameNormalized: 's14b_other_admin',
      firstName: '',
      lastName: '',
      ...(await argon2Seed(otherAdminKey)),
      role: 'admin',
      communityId: otherCommunity.id,
      isActive: true,
      createdAt: currentNow,
      updatedAt: currentNow,
    });
    roleCookies.other_admin = await loginAs(otherAdminEmail, otherAdminKey, {
      communitySlug: otherCommunity.slug,
    });

    const disabledAdminKey = makeDerivedKey();
    const disabledAdminEmail = 'disabled-admin@14b.example.test';
    await db.insert(usersSqlite).values({
      email: disabledAdminEmail,
      username: 's14b_disabled_admin',
      emailNormalized: disabledAdminEmail,
      usernameNormalized: 's14b_disabled_admin',
      firstName: '',
      lastName: '',
      ...(await argon2Seed(disabledAdminKey)),
      role: 'admin',
      communityId: disabledCommunity.id,
      isActive: true,
      createdAt: currentNow,
      updatedAt: currentNow,
    });
    roleCookies.disabled_admin = await loginAs(
      disabledAdminEmail,
      disabledAdminKey,
      { communitySlug: disabledCommunity.slug }
    );

    const nonNullSaKey = makeDerivedKey();
    const nonNullSaEmail = 'nonnull-sa@14b.example.test';
    await db.insert(usersSqlite).values({
      email: nonNullSaEmail,
      username: 's14b_nonnull_sa',
      emailNormalized: nonNullSaEmail,
      usernameNormalized: 's14b_nonnull_sa',
      firstName: '',
      lastName: '',
      ...(await argon2Seed(nonNullSaKey)),
      role: 'super_admin',
      communityId: seedCommunity.id,
      isActive: true,
      createdAt: currentNow,
      updatedAt: currentNow,
    });
    roleCookies.nonnull_super_admin = await loginAs(
      nonNullSaEmail,
      nonNullSaKey,
      { communitySlug: seedCommunity.slug }
    );

    const request = (
      method: string,
      path: string,
      opts: {
        cookie?: string;
        body?: unknown;
        rawBody?: string;
        headers?: Record<string, string>;
      } = {}
    ) => {
      const headers: Record<string, string> = {
        'cf-connecting-ip': '203.0.113.11',
        ...(opts.headers ?? {}),
      };
      if (opts.cookie !== undefined) headers.cookie = opts.cookie;
      if (
        opts.body !== undefined &&
        !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')
      ) {
        headers['content-type'] = 'application/json';
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
      sqlite,
      db,
      app,
      superAdmin,
      seedCommunity,
      otherCommunity,
      disabledCommunity,
      roleCookies,
      roleCreds,
      loginAs,
      request,
      advanceMs,
      currentNow: () => currentNow,
    };
  }

  it('enforces 401 unauthenticated, 403 for all community roles and non-null super_admin, and CSRF 403 on status/deprovision/audit routes', async () => {
    const { roleCookies, seedCommunity, request } = await setup();

    for (const [method, path, body] of [
      [
        'PATCH',
        `/v2/admin/communities/${seedCommunity.id}/status`,
        { status: 'disabled' },
      ],
      ['DELETE', `/v2/admin/communities/${seedCommunity.id}`, undefined],
      ['GET', '/v2/admin/audit-entries', undefined],
    ] as const) {
      expect((await request(method, path, { body })).status).toBe(401);
    }

    for (const role of [
      'viewer',
      'member',
      'editor',
      'admin',
      'disabled_admin',
      'nonnull_super_admin',
    ] as const) {
      const cookie = roleCookies[role]!;
      const patchRes = await request(
        'PATCH',
        '/v2/admin/communities/not-an-id/status',
        {
          cookie,
          rawBody: 'not-json',
          headers: { 'content-type': 'text/plain' },
        }
      );
      expect(patchRes.status).toBe(403);
      expect(await patchRes.json()).toEqual({ error: 'Forbidden' });

      const delRes = await request(
        'DELETE',
        '/v2/admin/communities/not-an-id',
        { cookie }
      );
      expect(delRes.status).toBe(403);

      const auditRes = await request(
        'GET',
        '/v2/admin/audit-entries?communityId=1',
        { cookie }
      );
      expect(auditRes.status).toBe(403);
    }

    expect(
      (
        await request(
          'PATCH',
          `/v2/admin/communities/${seedCommunity.id}/status`,
          {
            cookie: roleCookies.super_admin,
            body: { status: 'disabled' },
            headers: { origin: FOREIGN_ORIGIN },
          }
        )
      ).status
    ).toBe(403);

    expect(
      (
        await request('DELETE', `/v2/admin/communities/${seedCommunity.id}`, {
          cookie: roleCookies.super_admin,
          headers: { origin: FOREIGN_ORIGIN },
        })
      ).status
    ).toBe(403);
  });

  it('toggles lifecycle status, purges target community standard and device sessions on disable, restores on active, and rolls back on audit failure', async () => {
    for (const useD1Batch of [false, true]) {
      const ctx = await setup({ useD1Batch });
      const {
        db,
        seedCommunity,
        otherCommunity,
        roleCookies,
        roleCreds,
        loginAs,
        request,
        advanceMs,
      } = ctx;

      // Input validation & Content-Type / body limits
      expect(
        (
          await request('PATCH', '/v2/admin/communities/not-an-id/status', {
            cookie: roleCookies.super_admin,
            body: { status: 'disabled' },
          })
        ).status
      ).toBe(400);
      expect(
        (
          await request('PATCH', '/v2/admin/communities/999999/status', {
            cookie: roleCookies.super_admin,
            body: { status: 'disabled' },
          })
        ).status
      ).toBe(404);
      expect(
        (
          await request(
            'PATCH',
            `/v2/admin/communities/${seedCommunity.id}/status`,
            {
              cookie: roleCookies.super_admin,
              rawBody: '{"status":"disabled"}',
              headers: { 'content-type': 'text/plain' },
            }
          )
        ).status
      ).toBe(415);
      expect(
        (
          await request(
            'PATCH',
            `/v2/admin/communities/${seedCommunity.id}/status`,
            {
              cookie: roleCookies.super_admin,
              rawBody: JSON.stringify({ status: 'a'.repeat(5000) }),
              headers: { 'content-type': 'application/json' },
            }
          )
        ).status
      ).toBe(413);
      for (const badBody of [
        {},
        { status: 'archived' },
        { status: 'disabled', name: 'Renamed' },
        { status: 'disabled', visibility: 'private' },
        { status: 'disabled', description: '<p>x</p>' },
      ]) {
        expect(
          (
            await request(
              'PATCH',
              `/v2/admin/communities/${seedCommunity.id}/status`,
              { cookie: roleCookies.super_admin, body: badBody }
            )
          ).status
        ).toBe(400);
      }

      // Idempotent active -> active must NOT purge active community sessions
      advanceMs(1000);
      const idempActive = await request(
        'PATCH',
        `/v2/admin/communities/${seedCommunity.id}/status`,
        {
          cookie: roleCookies.super_admin,
          body: { status: 'active' },
        }
      );
      expect(idempActive.status).toBe(200);
      expect(
        (await request('GET', '/v2/auth/me', { cookie: roleCookies.viewer }))
          .status
      ).toBe(200);
      expect(
        (await request('GET', '/v2/auth/me', { cookie: roleCookies.member }))
          .status
      ).toBe(200);

      // Disable community -> 200 operational projection only, purges ALL community sessions
      advanceMs(1000);
      const disRes = await request(
        'PATCH',
        `/v2/admin/communities/${seedCommunity.id}/status`,
        {
          cookie: roleCookies.super_admin,
          body: { status: 'disabled' },
        }
      );
      expect(disRes.status).toBe(200);
      const disText = await disRes.text();
      expect(disText).not.toContain('Sensitive Community Alpha');
      expect(disText).not.toContain('Protected cultural narrative');
      expect(disText).not.toContain('"name"');
      expect(disText).not.toContain('"description"');
      expect(disText).not.toContain('"visibility"');
      const disParsed = AdminCommunityResponseSchema.parse(JSON.parse(disText));
      expect(disParsed.data).toMatchObject({
        id: seedCommunity.id,
        slug: seedCommunity.slug,
        status: 'disabled',
        claimStatus: 'claimed',
      });

      // Every session in seedCommunity (standard + device) is gone
      for (const r of ['viewer', 'member', 'editor', 'admin'] as const) {
        expect(
          (await request('GET', '/v2/auth/me', { cookie: roleCookies[r] }))
            .status
        ).toBe(401);
      }
      // super_admin and otherCommunity sessions are untouched
      expect(
        (
          await request('GET', '/v2/auth/me', {
            cookie: roleCookies.super_admin,
          })
        ).status
      ).toBe(200);
      expect(
        (
          await request('GET', '/v2/auth/me', {
            cookie: roleCookies.other_admin,
          })
        ).status
      ).toBe(200);

      // Public community surface closes immediately
      expect(
        (await request('GET', `/v2/public/communities/${seedCommunity.slug}`))
          .status
      ).toBe(404);

      // Non-admin cannot log in while disabled; own-admin CAN log in to /v2/auth/me,
      // and idempotent disabled -> disabled purges that disabled-admin session too
      const viewerDisabledLogin = await request('POST', '/v2/auth/login', {
        body: {
          identifier: roleCreds.viewer!.email,
          derivedKey: roleCreds.viewer!.key,
          communitySlug: seedCommunity.slug,
        },
      });
      expect(viewerDisabledLogin.status).toBe(401);

      const disabledAdminFreshCookie = await loginAs(
        roleCreds.admin!.email,
        roleCreds.admin!.key,
        { communitySlug: seedCommunity.slug, ip: '203.0.113.21' }
      );
      expect(
        (
          await request('GET', '/v2/auth/me', {
            cookie: disabledAdminFreshCookie,
          })
        ).status
      ).toBe(200);
      expect(
        (
          await request('GET', '/v2/community', {
            cookie: disabledAdminFreshCookie,
          })
        ).status
      ).toBe(403);

      advanceMs(1000);
      const idempDisable = await request(
        'PATCH',
        `/v2/admin/communities/${seedCommunity.id}/status`,
        {
          cookie: roleCookies.super_admin,
          body: { status: 'disabled' },
        }
      );
      expect(idempDisable.status).toBe(200);
      expect(
        (
          await request('GET', '/v2/auth/me', {
            cookie: disabledAdminFreshCookie,
          })
        ).status
      ).toBe(401);

      // Restore active -> public community opens & community users can log in again
      advanceMs(1000);
      const restoreRes = await request(
        'PATCH',
        `/v2/admin/communities/${seedCommunity.id}/status`,
        {
          cookie: roleCookies.super_admin,
          body: { status: 'active' },
        }
      );
      expect(restoreRes.status).toBe(200);
      expect(
        AdminCommunityResponseSchema.parse(await restoreRes.json()).data.status
      ).toBe('active');
      expect(
        (await request('GET', `/v2/public/communities/${seedCommunity.slug}`))
          .status
      ).toBe(200);
      const restoredViewerCookie = await loginAs(
        roleCreds.viewer!.email,
        roleCreds.viewer!.key,
        { communitySlug: seedCommunity.slug, ip: '203.0.113.22' }
      );
      expect(
        (
          await request('GET', '/v2/community', {
            cookie: restoredViewerCookie,
          })
        ).status
      ).toBe(200);

      // Stored descriptive fields stayed intact and untouched
      const [stored] = await db
        .select()
        .from(communitiesSqlite)
        .where(eq(communitiesSqlite.id, seedCommunity.id));
      expect(stored?.name).toBe('Sensitive Community Alpha');
      expect(stored?.description).toBe('<p>Protected cultural narrative</p>');
      expect(stored?.publicStories).toBe(true);

      // System audits recorded with communityId=null and resourceIds=[seedCommunity.id]
      const sysAudits = (await db.select().from(auditEntriesSqlite)).filter(
        (e) =>
          e.communityId === null &&
          e.action.startsWith('system.community.status.')
      );
      expect(sysAudits.map((e) => e.action)).toEqual([
        'system.community.status.active',
        'system.community.status.disabled',
        'system.community.status.disabled',
        'system.community.status.active',
      ]);
      for (const a of sysAudits) {
        expect(a.resourceIds).toEqual([seedCommunity.id]);
        validateContentFreeAuditEntry({
          communityId: a.communityId,
          actorId: a.actorId,
          action: a.action,
          resourceType: a.resourceType,
          resourceIds: a.resourceIds,
          outcome: a.outcome,
          ipAddress: a.ipAddress,
          userAgent: a.userAgent,
        });
      }
      expect(otherCommunity.id).toBeGreaterThan(0);
    }

    // Audit trigger abort rolls back both status update and session purge
    for (const useD1Batch of [false, true]) {
      const broken = await setup({ useD1Batch });
      broken.sqlite.exec(
        "CREATE TRIGGER fail_audit BEFORE INSERT ON audit_entries BEGIN SELECT RAISE(ABORT, 'audit-boom'); END;"
      );
      const res = await broken.request(
        'PATCH',
        `/v2/admin/communities/${broken.seedCommunity.id}/status`,
        {
          cookie: broken.roleCookies.super_admin,
          body: { status: 'disabled' },
        }
      );
      expect(res.status).toBe(503);
      const [comm] = await broken.db
        .select()
        .from(communitiesSqlite)
        .where(eq(communitiesSqlite.id, broken.seedCommunity.id));
      expect(comm?.isActive).toBe(true);
      expect(
        (
          await broken.request('GET', '/v2/auth/me', {
            cookie: broken.roleCookies.viewer,
          })
        ).status
      ).toBe(200);
      expect(
        (await broken.db.select().from(sessionsSqlite)).length
      ).toBeGreaterThan(0);
    }
  });

  it('deprovisions empty unclaimed communities (including pre-claim tokens, throttles, and pre-claim audits), allows slug reuse, refuses non-empty/claimed, and rolls back on audit failure', async () => {
    for (const useD1Batch of [false, true]) {
      const {
        db,
        app,
        superAdmin,
        seedCommunity,
        roleCookies,
        request,
        currentNow,
      } = await setup({ useD1Batch });

      expect(
        (
          await request('DELETE', '/v2/admin/communities/not-an-id', {
            cookie: roleCookies.super_admin,
          })
        ).status
      ).toBe(400);
      expect(
        (
          await request('DELETE', '/v2/admin/communities/999999', {
            cookie: roleCookies.super_admin,
          })
        ).status
      ).toBe(404);

      // Provision community, issue+reissue claim tokens, and trigger a failed claim attempt
      const provRes = await request('POST', '/v2/admin/communities', {
        cookie: roleCookies.super_admin,
        body: { slug: 'deprov-target' },
      });
      expect(provRes.status).toBe(201);
      const commId = AdminCommunityResponseSchema.parse(await provRes.json())
        .data.id;

      const t1 = ClaimTokenIssuedResponseSchema.parse(
        await (
          await request(
            'POST',
            `/v2/admin/communities/${commId}/claim-tokens`,
            {
              cookie: roleCookies.super_admin,
            }
          )
        ).json()
      ).data;
      const t2 = ClaimTokenIssuedResponseSchema.parse(
        await (
          await request(
            'POST',
            `/v2/admin/communities/${commId}/claim-tokens`,
            {
              cookie: roleCookies.super_admin,
            }
          )
        ).json()
      ).data;

      // Failed claim with existing username triggers identity_conflict -> writes claim throttle + failure audit
      const failClaim = await app.request(`${API_ORIGIN}/v2/bootstrap/claim`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'cf-connecting-ip': '203.0.113.99',
        },
        body: JSON.stringify({
          token: t2.token,
          username: superAdmin.username,
          email: 'deprov-fail@example.test',
          password: makePasswordPayload(),
        }),
      });
      expect(failClaim.status).toBe(401);

      expect(
        (
          await db
            .select()
            .from(claimTokensSqlite)
            .where(eq(claimTokensSqlite.communityId, commId))
        ).length
      ).toBe(2);
      expect(
        (
          await db
            .select()
            .from(authThrottleSqlite)
            .where(eq(authThrottleSqlite.communityId, commId))
        ).length
      ).toBe(1);
      expect(
        (
          await db
            .select()
            .from(auditEntriesSqlite)
            .where(eq(auditEntriesSqlite.communityId, commId))
        ).length
      ).toBe(3);

      // Deprovision succeeds 204 and clears community + pre-claim records, while leaving system audit
      const delRes = await request(
        'DELETE',
        `/v2/admin/communities/${commId}`,
        { cookie: roleCookies.super_admin }
      );
      expect(delRes.status).toBe(204);
      expect(
        await db
          .select()
          .from(communitiesSqlite)
          .where(eq(communitiesSqlite.id, commId))
      ).toHaveLength(0);
      expect(
        await db
          .select()
          .from(claimTokensSqlite)
          .where(eq(claimTokensSqlite.communityId, commId))
      ).toHaveLength(0);
      expect(
        await db
          .select()
          .from(authThrottleSqlite)
          .where(eq(authThrottleSqlite.communityId, commId))
      ).toHaveLength(0);
      expect(
        await db
          .select()
          .from(auditEntriesSqlite)
          .where(eq(auditEntriesSqlite.communityId, commId))
      ).toHaveLength(0);

      const deprovAudits = (await db.select().from(auditEntriesSqlite)).filter(
        (e) => e.action === 'system.community.deprovision'
      );
      expect(deprovAudits).toHaveLength(1);
      expect(deprovAudits[0]?.communityId).toBeNull();
      expect(deprovAudits[0]?.resourceIds).toEqual([commId]);

      // Old token t1/t2 no longer resolves; same slug can be reprovisioned
      const staleClaim = await app.request(`${API_ORIGIN}/v2/bootstrap/claim`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'cf-connecting-ip': '203.0.113.100',
        },
        body: JSON.stringify({
          token: t1.token,
          username: 'new_owner',
          email: 'new-owner@example.test',
          password: makePasswordPayload(),
        }),
      });
      expect(staleClaim.status).toBe(401);

      const reprovRes = await request('POST', '/v2/admin/communities', {
        cookie: roleCookies.super_admin,
        body: { slug: 'deprov-target' },
      });
      expect(reprovRes.status).toBe(201);
      const reprovId = AdminCommunityResponseSchema.parse(
        await reprovRes.json()
      ).data.id;
      expect(reprovId).not.toBe(commId);

      // Disabled unclaimed empty community can also be deprovisioned (204)
      expect(
        (
          await request('PATCH', `/v2/admin/communities/${reprovId}/status`, {
            cookie: roleCookies.super_admin,
            body: { status: 'disabled' },
          })
        ).status
      ).toBe(200);
      expect(
        (
          await request('DELETE', `/v2/admin/communities/${reprovId}`, {
            cookie: roleCookies.super_admin,
          })
        ).status
      ).toBe(204);

      // Non-empty / claimed / bootstrapped communities are refused with 409 + failure audit
      const now = currentNow();
      const nowMs = now.getTime();
      const makeNonEmpty = async (
        slug: string,
        seed: (cid: number) => Promise<void>
      ) => {
        const created = AdminCommunityResponseSchema.parse(
          await (
            await request('POST', '/v2/admin/communities', {
              cookie: roleCookies.super_admin,
              body: { slug },
            })
          ).json()
        ).data;
        await seed(created.id);
        const res = await request(
          'DELETE',
          `/v2/admin/communities/${created.id}`,
          { cookie: roleCookies.super_admin }
        );
        expect(res.status, `expected 409 for ${slug}`).toBe(409);
        expect(
          await db
            .select()
            .from(communitiesSqlite)
            .where(eq(communitiesSqlite.id, created.id))
        ).toHaveLength(1);
      };

      await makeNonEmpty('refuse-story', async (cid) => {
        await db.insert(storiesSqlite).values({
          communityId: cid,
          title: 'Story',
          slug: 's',
          language: 'en',
          privacyLevel: 'editors',
          isRestricted: false,
          createdAt: now,
          updatedAt: now,
        });
      });
      await makeNonEmpty('refuse-place', async (cid) => {
        await db.insert(placesSqlite).values({
          communityId: cid,
          name: 'Place',
          createdAt: now,
          updatedAt: now,
        });
      });
      await makeNonEmpty('refuse-speaker', async (cid) => {
        await db.insert(speakersSqlite).values({
          communityId: cid,
          name: 'Speaker',
          createdAt: now,
          updatedAt: now,
        });
      });
      await makeNonEmpty('refuse-file', async (cid) => {
        const fid = crypto.randomUUID();
        await db.insert(filesSqlite).values({
          id: fid,
          filename: 'a.png',
          originalName: 'a.png',
          path: `communities/${cid}/${fid}`,
          url: `https://ignored.invalid/${fid}`,
          mimeType: 'image/png',
          size: 5,
          communityId: cid,
          uploadedBy: null,
          createdAt: now,
          updatedAt: now,
        });
      });
      await makeNonEmpty('refuse-attachment', async (cid) => {
        await db.insert(attachmentsSqlite).values({
          communityId: cid,
          fileId: null,
          ownerType: 'community',
          ownerId: cid,
          role: 'community_display_image',
          ordinal: 0,
          createdAt: now,
        });
      });
      await makeNonEmpty('refuse-map', async (cid) => {
        await db.insert(communityMapConfigsSqlite).values({
          communityId: cid,
          createdAt: now,
          updatedAt: now,
        });
      });
      await makeNonEmpty('refuse-theme', async (cid) => {
        await db.insert(themesSqlite).values({
          communityId: cid,
          name: 'Theme',
          active: true,
          createdAt: now,
          updatedAt: now,
        });
      });
      await makeNonEmpty('refuse-login-code', async (cid) => {
        await db.insert(loginCodesSqlite).values({
          communityId: cid,
          userId: superAdmin.id,
          purpose: 'recovery',
          codeHash: await sha256Hex(`lc-deprov-${cid}`),
          createdBy: superAdmin.id,
          createdAt: nowMs,
          expiresAt: null,
        });
      });
      await makeNonEmpty('refuse-bootstrap', async (cid) => {
        await db.insert(installationBootstrapSqlite).values({
          id: 1,
          setupId: 'boot-deprov',
          communityId: cid,
          adminUserId: null,
          completedAt: nowMs,
        });
      });
      await makeNonEmpty('refuse-audit', async (cid) => {
        await db.insert(auditEntriesSqlite).values({
          communityId: cid,
          actorId: superAdmin.id,
          action: 'community.visibility.public',
          resourceType: 'community',
          resourceIds: [cid],
          outcome: 'success',
          ipAddress: null,
          userAgent: null,
          createdAt: now,
        });
      });
      await makeNonEmpty('refuse-row-description', async (cid) => {
        await db
          .update(communitiesSqlite)
          .set({ description: '<p>Private description</p>' })
          .where(eq(communitiesSqlite.id, cid));
      });
      await makeNonEmpty('refuse-row-description-plain', async (cid) => {
        await db
          .update(communitiesSqlite)
          .set({ descriptionPlain: 'Private description' })
          .where(eq(communitiesSqlite.id, cid));
      });
      await makeNonEmpty('refuse-row-country', async (cid) => {
        await db
          .update(communitiesSqlite)
          .set({ country: 'BR' })
          .where(eq(communitiesSqlite.id, cid));
      });
      await makeNonEmpty('refuse-row-cultural-settings', async (cid) => {
        await db
          .update(communitiesSqlite)
          .set({ culturalSettings: '{"k":"v"}' })
          .where(eq(communitiesSqlite.id, cid));
      });
      await makeNonEmpty('refuse-row-public-stories', async (cid) => {
        await db
          .update(communitiesSqlite)
          .set({ publicStories: true })
          .where(eq(communitiesSqlite.id, cid));
      });
      await makeNonEmpty('refuse-row-beta', async (cid) => {
        await db
          .update(communitiesSqlite)
          .set({ beta: true })
          .where(eq(communitiesSqlite.id, cid));
      });

      // Claimed seedCommunity refuses 409 and emits system failure audit
      const claimedDel = await request(
        'DELETE',
        `/v2/admin/communities/${seedCommunity.id}`,
        { cookie: roleCookies.super_admin }
      );
      expect(claimedDel.status).toBe(409);

      const deprovFailures = (
        await db.select().from(auditEntriesSqlite)
      ).filter(
        (e) =>
          e.action === 'system.community.deprovision' && e.outcome === 'failure'
      );
      expect(deprovFailures.length).toBeGreaterThanOrEqual(16);
      for (const entry of deprovFailures) {
        expect(entry.communityId).toBeNull();
      }
    }

    // Audit failure rollback preserves community + pre-claim claim_tokens + pre-claim audits
    for (const useD1Batch of [false, true]) {
      const broken = await setup({ useD1Batch });
      const provRes = await broken.request('POST', '/v2/admin/communities', {
        cookie: broken.roleCookies.super_admin,
        body: { slug: 'rollback-deprov' },
      });
      const cid = AdminCommunityResponseSchema.parse(await provRes.json()).data
        .id;
      expect(
        (
          await broken.request(
            'POST',
            `/v2/admin/communities/${cid}/claim-tokens`,
            { cookie: broken.roleCookies.super_admin }
          )
        ).status
      ).toBe(201);

      broken.sqlite.exec(
        "CREATE TRIGGER fail_audit BEFORE INSERT ON audit_entries BEGIN SELECT RAISE(ABORT, 'audit-boom'); END;"
      );
      const res = await broken.request(
        'DELETE',
        `/v2/admin/communities/${cid}`,
        { cookie: broken.roleCookies.super_admin }
      );
      expect(res.status).toBe(503);
      expect(
        await broken.db
          .select()
          .from(communitiesSqlite)
          .where(eq(communitiesSqlite.id, cid))
      ).toHaveLength(1);
      expect(
        await broken.db
          .select()
          .from(claimTokensSqlite)
          .where(eq(claimTokensSqlite.communityId, cid))
      ).toHaveLength(1);
      expect(
        await broken.db
          .select()
          .from(auditEntriesSqlite)
          .where(eq(auditEntriesSqlite.communityId, cid))
      ).toHaveLength(1);
    }
  });

  it('lists only communityId=null system audit entries in deterministic newest-first order, supports pagination and action/outcome filters, rejects communityId query param, and leaks zero community/cultural content', async () => {
    const {
      db,
      superAdmin,
      seedCommunity,
      roleCookies,
      request,
      advanceMs,
      currentNow,
    } = await setup();

    // Seed diverse community audit rows (newest timestamps too!) that MUST NEVER appear
    advanceMs(5000);
    await db.insert(auditEntriesSqlite).values([
      {
        communityId: seedCommunity.id,
        actorId: superAdmin.id,
        action: 'story.create',
        resourceType: 'story',
        resourceIds: [10],
        outcome: 'success',
        ipAddress: null,
        userAgent: null,
        createdAt: currentNow(),
      },
      {
        communityId: seedCommunity.id,
        actorId: superAdmin.id,
        action: 'community.visibility.public',
        resourceType: 'community',
        resourceIds: [seedCommunity.id],
        outcome: 'success',
        ipAddress: null,
        userAgent: null,
        createdAt: currentNow(),
      },
    ]);

    // Trigger system lifecycle entries + tie-timestamp system entries
    const prov = await request('POST', '/v2/admin/communities', {
      cookie: roleCookies.super_admin,
      body: { slug: 'audit-read-comm' },
    });
    const commId = AdminCommunityResponseSchema.parse(await prov.json()).data
      .id;

    // Issue claim token (writes community audit entry claim_token.issue, must NOT leak)
    const tokRes = await request(
      'POST',
      `/v2/admin/communities/${commId}/claim-tokens`,
      { cookie: roleCookies.super_admin }
    );
    expect(tokRes.status).toBe(201);
    const issuedToken = ClaimTokenIssuedResponseSchema.parse(
      await tokRes.json()
    ).data.token;

    // Identical timestamp tie-break across system.community.status.disabled + deprovision
    await request('PATCH', `/v2/admin/communities/${commId}/status`, {
      cookie: roleCookies.super_admin,
      body: { status: 'disabled' },
    });
    await request('DELETE', `/v2/admin/communities/${commId}`, {
      cookie: roleCookies.super_admin,
    });

    // Strict query parameter rejection
    for (const badQuery of [
      '?communityId=1',
      `?communityId=${seedCommunity.id}`,
      '?limit=0',
      '?limit=101',
      '?offset=-1',
      '?action=InvalidAction',
      '?outcome=BAD!',
      '?unknown=1',
    ]) {
      expect(
        (
          await request('GET', `/v2/admin/audit-entries${badQuery}`, {
            cookie: roleCookies.super_admin,
          })
        ).status
      ).toBe(400);
    }

    // Read all system audit entries
    const allRes = await request('GET', '/v2/admin/audit-entries?limit=100', {
      cookie: roleCookies.super_admin,
    });
    expect(allRes.status).toBe(200);
    const allText = await allRes.text();
    expect(allText).not.toContain('Sensitive Community Alpha');
    expect(allText).not.toContain('Protected cultural narrative');
    expect(allText).not.toContain(issuedToken);
    expect(allText).not.toContain(await sha256Hex(issuedToken));
    expect(allText).not.toContain('story.create');
    expect(allText).not.toContain('community.visibility.public');
    expect(allText).not.toContain('claim_token.issue');

    const allParsed = AdminAuditEntryListResponseSchema.parse(
      JSON.parse(allText)
    );
    for (const row of allParsed.data) {
      expect(row.communityId).toBeNull();
    }

    // Verify deterministic createdAt DESC, id DESC ordering
    for (let i = 1; i < allParsed.data.length; i++) {
      const prev = allParsed.data[i - 1]!;
      const curr = allParsed.data[i]!;
      const prevMs = new Date(prev.createdAt).getTime();
      const currMs = new Date(curr.createdAt).getTime();
      expect(prevMs > currMs || (prevMs === currMs && prev.id > curr.id)).toBe(
        true
      );
    }
    expect(allParsed.data[0]?.action).toBe('system.community.deprovision');
    expect(allParsed.data[1]?.action).toBe('system.community.status.disabled');
    expect(allParsed.data[2]?.action).toBe('system.community.provision');

    // Paginate limit=1 offset=1
    const page2 = AdminAuditEntryListResponseSchema.parse(
      await (
        await request('GET', '/v2/admin/audit-entries?limit=1&offset=1', {
          cookie: roleCookies.super_admin,
        })
      ).json()
    );
    expect(page2.meta).toEqual({
      total: allParsed.meta.total,
      limit: 1,
      offset: 1,
      hasNextPage: allParsed.meta.total > 2,
    });
    expect(page2.data[0]?.id).toBe(allParsed.data[1]?.id);

    // Action + outcome filters
    const filtered = AdminAuditEntryListResponseSchema.parse(
      await (
        await request(
          'GET',
          '/v2/admin/audit-entries?action=system.community.deprovision&outcome=success',
          { cookie: roleCookies.super_admin }
        )
      ).json()
    );
    expect(filtered.data).toHaveLength(1);
    expect(filtered.data[0]?.action).toBe('system.community.deprovision');
    expect(filtered.data[0]?.outcome).toBe('success');
  });

  it('verifies super_admin still receives 403/404 on every community content, user, and community media endpoint', async () => {
    const { db, seedCommunity, roleCookies, request, currentNow } =
      await setup();
    const now = currentNow();
    const fileId = crypto.randomUUID();
    await db.insert(filesSqlite).values({
      id: fileId,
      filename: 'branding.png',
      originalName: 'branding.png',
      path: `communities/${seedCommunity.id}/${fileId}.png`,
      url: `/v2/media/${fileId}`,
      mimeType: 'image/png',
      size: 3,
      communityId: seedCommunity.id,
      uploadedBy: null,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(attachmentsSqlite).values({
      communityId: seedCommunity.id,
      fileId,
      ownerType: 'community',
      ownerId: seedCommunity.id,
      role: 'community_display_image',
      ordinal: 0,
      createdAt: now,
    });

    const cookie = roleCookies.super_admin;
    for (const [method, path, expected] of [
      ['GET', '/v2/community', 403],
      ['PATCH', '/v2/community', 403],
      ['GET', '/v2/community/map-config', 403],
      ['PUT', '/v2/community/map-config', 403],
      ['GET', '/v2/stories', 403],
      ['POST', '/v2/stories', 403],
      ['GET', '/v2/places', 403],
      ['POST', '/v2/places', 403],
      ['GET', '/v2/speakers', 403],
      ['POST', '/v2/speakers', 403],
      ['GET', '/v2/users', 403],
      ['POST', '/v2/users', 403],
      ['GET', `/v2/media/${fileId}`, 404],
      ['GET', `/v2/media/${fileId}/metadata`, 404],
      ['DELETE', `/v2/media/${fileId}`, 404],
    ] as const) {
      const res = await request(method, path, {
        cookie,
        body:
          method === 'POST' || method === 'PATCH' || method === 'PUT'
            ? {}
            : undefined,
      });
      expect(res.status, `expected ${expected} on ${method} ${path}`).toBe(
        expected
      );
    }
  });

  it('returns uniform 401 and records per-IP throttle + system bootstrap.claim failure audit when community is deprovisioned mid-claim', async () => {
    const { db, superAdmin, roleCookies, request, currentNow } = await setup();
    const provRes = await request('POST', '/v2/admin/communities', {
      cookie: roleCookies.super_admin,
      body: { slug: 'race-deprov-claim' },
    });
    expect(provRes.status).toBe(201);
    const commId = AdminCommunityResponseSchema.parse(await provRes.json()).data
      .id;
    const tokRes = await request(
      'POST',
      `/v2/admin/communities/${commId}/claim-tokens`,
      { cookie: roleCookies.super_admin }
    );
    expect(tokRes.status).toBe(201);
    const tok = ClaimTokenIssuedResponseSchema.parse(await tokRes.json()).data;

    const adminRepo = new AdminRepository(db);
    const bootRepo = new BootstrapRepository(db);
    const authRepo = new HonoAuthRepository(db);
    const origFind = bootRepo.findClaimTokenByHash.bind(bootRepo);
    bootRepo.findClaimTokenByHash = async (tokenHash: string) => {
      const row = await origFind(tokenHash);
      // Simulate concurrent DELETE /v2/admin/communities/:id finishing right after lookup
      await adminRepo.deprovisionCommunityAtomically({
        actorId: superAdmin.id,
        communityId: commId,
        now: currentNow(),
      });
      return row;
    };

    const secret = makeServerSecret();
    const service = new BootstrapService(bootRepo, authRepo, {
      serverSecret: secret,
    });
    const result = await service.claimCommunity(
      {
        token: tok.token,
        username: 'race_claim_admin',
        email: 'race-claim-admin@example.test',
        password: makePasswordPayload(),
      },
      undefined,
      {
        clientIp: '203.0.113.250',
        now: currentNow(),
      }
    );
    expect(result.status).toBe(401);
    expect(result.body).toEqual({ error: 'Invalid credentials' });

    const ipKey = await authRepo.ipThrottleKey('203.0.113.250', secret);
    const [throttleRow] = await db
      .select()
      .from(authThrottleSqlite)
      .where(eq(authThrottleSqlite.key, ipKey));
    expect(throttleRow?.failures).toBe(1);

    const bootstrapFailAudits = (
      await db.select().from(auditEntriesSqlite)
    ).filter(
      (e) =>
        e.communityId === null &&
        e.action === 'bootstrap.claim' &&
        e.outcome === 'failure'
    );
    expect(bootstrapFailAudits).toHaveLength(1);
  });
});
