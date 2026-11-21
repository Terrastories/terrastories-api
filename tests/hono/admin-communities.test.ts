/**
 * Focused tests for Slice 14-A system administration endpoints:
 * - GET /v2/admin/communities
 * - POST /v2/admin/communities
 * - POST /v2/admin/communities/:id/claim-tokens
 *
 * Covers SPEC-V2 §6.2, §6.8, §7 and route registry §10:
 * - Authz matrix (401 unauthenticated, 403 community roles / non-null super_admin, CSRF 403)
 * - Operational-only projections & provision writes (no descriptive/content fields)
 * - Pagination, status filter, claimStatus lifecycle (`unclaimed` -> `claim_pending` -> `unclaimed` on expiry -> `claimed`)
 * - ClaimToken issuance & reissue supersession, <=72h TTL bounds, SHA-256 storage, shown once
 * - Issuance refusal (409 + content-free failure audit) when claimed, bootstrapped, disabled,
 *   user-bearing, or holding any content row
 * - Real concurrency races, D1 db.batch() emulation, and audit-failure rollback atomicity
 */
import { afterEach, describe, expect, it } from 'vitest';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import { createHonoApp } from '../../src/hono-app.js';
import { HonoFoundationRepository } from '../../src/repositories/hono-foundation.repository.js';
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
import { externalMediaLinksSqlite } from '../../src/db/schema/external_media_links.js';
import { communityMapConfigsSqlite } from '../../src/db/schema/community_map_configs.js';
import { themesSqlite } from '../../src/db/schema/themes.js';
import { authThrottleSqlite } from '../../src/db/schema/sessions.js';
import { auditEntriesSqlite } from '../../src/db/schema/audit_entries.js';
import {
  ARGON2ID_ALGORITHM,
  ARGON2ID_PARAMS,
  CLAIM_TOKEN_MAX_TTL_MS,
} from '../../src/shared/auth-policy.js';
import { sha256Hex } from '../../src/shared/auth-crypto.js';
import {
  AdminCommunityListResponseSchema,
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
        config?: { returning?: unknown };
        all: () => unknown[];
        run: () => unknown;
      }>
    ) => Promise<unknown[][]>;
  };
  handle.batch = async (stmts) =>
    database.transaction(() =>
      stmts.map((stmt) =>
        stmt.config?.returning !== undefined ? stmt.all() : (stmt.run(), [])
      )
    );
}

const makePasswordPayload = (derivedKey: string = makeDerivedKey()) => ({
  algorithm: ARGON2ID_ALGORITHM,
  salt: makeVerifierSalt(),
  params: { ...ARGON2ID_PARAMS },
  derivedKey,
});

describe('Slice 14-A /v2/admin/communities & claim-tokens', () => {
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

    let currentNow = new Date('2026-07-01T12:00:00.000Z');
    const advanceMs = (ms: number) => {
      currentNow = new Date(currentNow.getTime() + ms);
    };
    const secret = makeServerSecret();

    const saKey = makeDerivedKey();
    const [superAdmin] = await db
      .insert(usersSqlite)
      .values({
        email: 'sa@admin-slice14.example.test',
        username: 'slice14_super_admin',
        emailNormalized: 'sa@admin-slice14.example.test',
        usernameNormalized: 'slice14_super_admin',
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
        name: 'Sensitive Community Title',
        description: '<p>Secret community story overview</p>',
        descriptionPlain: 'Secret community story overview',
        slug: 'seed-community',
        locale: 'pt-BR',
        country: 'BR',
        publicStories: true,
        isActive: true,
        createdAt: currentNow,
        updatedAt: currentNow,
      })
      .returning();

    const [disabledCommunity] = await db
      .insert(communitiesSqlite)
      .values({
        name: 'Disabled Community Title',
        description: '<p>Withdrawn community text</p>',
        descriptionPlain: 'Withdrawn community text',
        slug: 'disabled-community',
        locale: 'en',
        country: null,
        publicStories: false,
        isActive: false,
        createdAt: currentNow,
        updatedAt: currentNow,
      })
      .returning();

    const roleCookies: Record<string, string> = {};
    const app = createHonoApp({
      repository: new HonoFoundationRepository(db),
      storage: { read: async () => null },
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
      communitySlug?: string
    ): Promise<string> => {
      const res = await app.request(`${API_ORIGIN}/v2/auth/login`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'cf-connecting-ip': '203.0.113.10',
        },
        body: JSON.stringify({
          identifier,
          derivedKey,
          ...(communitySlug === undefined ? {} : { communitySlug }),
        }),
      });
      expect(res.status).toBe(200);
      return (res.headers.get('set-cookie') ?? '').split(';')[0]!;
    };

    roleCookies.super_admin = await loginAs(superAdmin.email, saKey);

    for (const role of ['viewer', 'member', 'editor', 'admin'] as const) {
      const key = makeDerivedKey();
      const email = `${role}@seed-slice14.example.test`;
      await db.insert(usersSqlite).values({
        email,
        username: `seed_${role}`,
        emailNormalized: email,
        usernameNormalized: `seed_${role}`,
        firstName: '',
        lastName: '',
        ...(await argon2Seed(key)),
        role,
        communityId: seedCommunity.id,
        isActive: true,
        createdAt: currentNow,
        updatedAt: currentNow,
      });
      roleCookies[role] = await loginAs(email, key, seedCommunity.slug);
    }

    // Disabled community own-admin (can authenticate, must still get 403 on /v2/admin/*)
    const disabledAdminKey = makeDerivedKey();
    const disabledAdminEmail = 'disabled-admin@slice14.example.test';
    await db.insert(usersSqlite).values({
      email: disabledAdminEmail,
      username: 'seed_disabled_admin',
      emailNormalized: disabledAdminEmail,
      usernameNormalized: 'seed_disabled_admin',
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
      disabledCommunity.slug
    );

    // Malformed legacy super_admin carrying a communityId must also be rejected 403.
    const nonNullSaKey = makeDerivedKey();
    const nonNullSaEmail = 'nonnull-sa@slice14.example.test';
    await db.insert(usersSqlite).values({
      email: nonNullSaEmail,
      username: 'nonnull_super_admin',
      emailNormalized: nonNullSaEmail,
      usernameNormalized: 'nonnull_super_admin',
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
      seedCommunity.slug
    );

    const requestAdmin = (
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
      disabledCommunity,
      roleCookies,
      requestAdmin,
      advanceMs,
      currentNow: () => currentNow,
    };
  }

  it('enforces 401 unauthenticated, 403 for all community roles and non-null super_admin, and CSRF 403', async () => {
    const { roleCookies, seedCommunity, requestAdmin } = await setup();

    // Unauthenticated -> 401
    for (const [method, path, body] of [
      ['GET', '/v2/admin/communities', undefined],
      ['POST', '/v2/admin/communities', { slug: 'unauth-slug' }],
      [
        'POST',
        `/v2/admin/communities/${seedCommunity.id}/claim-tokens`,
        undefined,
      ],
    ] as const) {
      const res = await requestAdmin(method, path, { body });
      expect(res.status).toBe(401);
    }

    // Community roles + disabled_admin + non-null super_admin -> 403 even on malformed bodies/ids
    for (const role of [
      'viewer',
      'member',
      'editor',
      'admin',
      'disabled_admin',
      'nonnull_super_admin',
    ] as const) {
      const cookie = roleCookies[role]!;
      const listRes = await requestAdmin('GET', '/v2/admin/communities', {
        cookie,
      });
      expect(listRes.status).toBe(403);
      expect(await listRes.json()).toEqual({ error: 'Forbidden' });

      const provRes = await requestAdmin('POST', '/v2/admin/communities', {
        cookie,
        rawBody: 'not-json',
        headers: { 'content-type': 'text/plain' },
      });
      expect(provRes.status).toBe(403);

      const tokRes = await requestAdmin(
        'POST',
        '/v2/admin/communities/not-an-id/claim-tokens',
        { cookie }
      );
      expect(tokRes.status).toBe(403);
    }

    // CSRF rejection for super_admin on foreign origin
    const csrfRes = await requestAdmin('POST', '/v2/admin/communities', {
      cookie: roleCookies.super_admin,
      body: { slug: 'csrf-blocked' },
      headers: { origin: FOREIGN_ORIGIN },
    });
    expect(csrfRes.status).toBe(403);
  });

  it('lists operational community records only (never descriptive fields), paginated and filtered', async () => {
    const { db, roleCookies, seedCommunity, disabledCommunity, requestAdmin } =
      await setup();

    const listRes = await requestAdmin('GET', '/v2/admin/communities', {
      cookie: roleCookies.super_admin,
    });
    expect(listRes.status).toBe(200);
    const text = await listRes.text();
    // Descriptive fields must never be projected to system admin (§6.2, §7).
    expect(text).not.toContain('Sensitive Community Title');
    expect(text).not.toContain('Secret community story overview');
    expect(text).not.toContain('Withdrawn community text');
    expect(text).not.toContain('pt-BR');
    expect(text).not.toContain('"name"');
    expect(text).not.toContain('"description"');
    expect(text).not.toContain('"visibility"');
    expect(text).not.toContain('"locale"');
    expect(text).not.toContain('"country"');

    const parsed = AdminCommunityListResponseSchema.parse(JSON.parse(text));
    expect(parsed.meta).toEqual({
      total: 2,
      limit: 20,
      offset: 0,
      hasNextPage: false,
    });
    expect(parsed.data.map((r) => r.id)).toEqual([
      seedCommunity.id,
      disabledCommunity.id,
    ]);
    expect(parsed.data[0]).toMatchObject({
      id: seedCommunity.id,
      slug: 'seed-community',
      status: 'active',
      claimStatus: 'claimed',
    });
    expect(parsed.data[1]).toMatchObject({
      id: disabledCommunity.id,
      slug: 'disabled-community',
      status: 'disabled',
      claimStatus: 'claimed',
    });

    // Empty unclaimed community inserted -> appears as unclaimed
    const provRes = await requestAdmin('POST', '/v2/admin/communities', {
      cookie: roleCookies.super_admin,
      body: { slug: 'empty-listed' },
    });
    expect(provRes.status).toBe(201);
    const emptyId = AdminCommunityResponseSchema.parse(await provRes.json())
      .data.id;

    // Filter by status=active + pagination limit=1
    const page1 = AdminCommunityListResponseSchema.parse(
      await (
        await requestAdmin(
          'GET',
          '/v2/admin/communities?status=active&limit=1&offset=0',
          { cookie: roleCookies.super_admin }
        )
      ).json()
    );
    expect(page1.meta).toEqual({
      total: 2,
      limit: 1,
      offset: 0,
      hasNextPage: true,
    });
    expect(page1.data).toHaveLength(1);
    expect(page1.data[0]?.id).toBe(seedCommunity.id);

    const page2 = AdminCommunityListResponseSchema.parse(
      await (
        await requestAdmin(
          'GET',
          '/v2/admin/communities?status=active&limit=1&offset=1',
          { cookie: roleCookies.super_admin }
        )
      ).json()
    );
    expect(page2.meta).toEqual({
      total: 2,
      limit: 1,
      offset: 1,
      hasNextPage: false,
    });
    expect(page2.data[0]).toMatchObject({
      id: emptyId,
      slug: 'empty-listed',
      status: 'active',
      claimStatus: 'unclaimed',
    });

    const disabledOnly = AdminCommunityListResponseSchema.parse(
      await (
        await requestAdmin('GET', '/v2/admin/communities?status=disabled', {
          cookie: roleCookies.super_admin,
        })
      ).json()
    );
    expect(disabledOnly.data.map((r) => r.id)).toEqual([disabledCommunity.id]);

    // Malformed / unknown query params -> 400
    for (const badQuery of [
      '?limit=0',
      '?limit=101',
      '?offset=-1',
      '?status=unknown',
      '?search=seed',
    ]) {
      const badRes = await requestAdmin(
        'GET',
        `/v2/admin/communities${badQuery}`,
        { cookie: roleCookies.super_admin }
      );
      expect(badRes.status).toBe(400);
    }

    // Stored community row stays free of invented description/visibility
    const [storedEmpty] = await db
      .select()
      .from(communitiesSqlite)
      .where(eq(communitiesSqlite.id, emptyId));
    expect(storedEmpty?.description).toBeNull();
    expect(storedEmpty?.descriptionPlain).toBeNull();
    expect(storedEmpty?.publicStories).toBe(false);
    expect(storedEmpty?.isActive).toBe(true);
  });

  it('provisions operational communities, rejects descriptive/invalid inputs, handles duplicate slugs, and rolls back on audit failure', async () => {
    for (const useD1Batch of [false, true]) {
      const { db, roleCookies, requestAdmin } = await setup({ useD1Batch });

      // Invalid Content-Type -> 415, oversized -> 413, malformed JSON -> 400
      expect(
        (
          await requestAdmin('POST', '/v2/admin/communities', {
            cookie: roleCookies.super_admin,
            rawBody: '{"slug":"ok"}',
            headers: { 'content-type': 'text/plain' },
          })
        ).status
      ).toBe(415);

      expect(
        (
          await requestAdmin('POST', '/v2/admin/communities', {
            cookie: roleCookies.super_admin,
            rawBody: JSON.stringify({ slug: 'a'.repeat(5000) }),
            headers: { 'content-type': 'application/json' },
          })
        ).status
      ).toBe(413);

      expect(
        (
          await requestAdmin('POST', '/v2/admin/communities', {
            cookie: roleCookies.super_admin,
            rawBody: '{',
            headers: { 'content-type': 'application/json' },
          })
        ).status
      ).toBe(400);

      // Descriptive/publication fields rejected fail-closed with 400
      for (const badBody of [
        {},
        { slug: '' },
        { slug: 'Bad_Slug' },
        { slug: 'valid-slug', name: 'Community Name' },
        { slug: 'valid-slug', description: '<p>hi</p>' },
        { slug: 'valid-slug', visibility: 'public' },
        { slug: 'valid-slug', locale: 'en' },
        { slug: 'valid-slug', country: 'US' },
        { slug: 'valid-slug', status: 'active' },
      ]) {
        const res = await requestAdmin('POST', '/v2/admin/communities', {
          cookie: roleCookies.super_admin,
          body: badBody,
        });
        expect(res.status).toBe(400);
      }

      // Valid provision -> 201 + atomic system.community.provision audit
      const okRes = await requestAdmin('POST', '/v2/admin/communities', {
        cookie: roleCookies.super_admin,
        body: { slug: 'hosted-alpha' },
      });
      expect(okRes.status).toBe(201);
      const created = AdminCommunityResponseSchema.parse(await okRes.json());
      expect(created.data).toMatchObject({
        slug: 'hosted-alpha',
        status: 'active',
        claimStatus: 'unclaimed',
      });

      const audits = await db
        .select()
        .from(auditEntriesSqlite)
        .where(eq(auditEntriesSqlite.action, 'system.community.provision'));
      expect(audits).toHaveLength(1);
      expect(audits[0]?.communityId).toBeNull();
      expect(audits[0]?.resourceType).toBe('system');
      expect(audits[0]?.resourceIds).toEqual([created.data.id]);
      expect(audits[0]?.outcome).toBe('success');
      validateContentFreeAuditEntry({
        communityId: audits[0]!.communityId,
        actorId: audits[0]!.actorId,
        action: audits[0]!.action,
        resourceType: audits[0]!.resourceType,
        resourceIds: audits[0]!.resourceIds,
        outcome: audits[0]!.outcome,
        ipAddress: audits[0]!.ipAddress,
        userAgent: audits[0]!.userAgent,
      });

      // Duplicate slug -> 409 and emits no extra audit row
      const dupRes = await requestAdmin('POST', '/v2/admin/communities', {
        cookie: roleCookies.super_admin,
        body: { slug: 'hosted-alpha' },
      });
      expect(dupRes.status).toBe(409);
      const auditsAfterDup = await db
        .select()
        .from(auditEntriesSqlite)
        .where(eq(auditEntriesSqlite.action, 'system.community.provision'));
      expect(auditsAfterDup).toHaveLength(1);
    }

    // Audit failure rollback (direct SQLite + D1 batch)
    for (const useD1Batch of [false, true]) {
      const broken = await setup({ useD1Batch });
      broken.sqlite.exec(
        "CREATE TRIGGER fail_audit BEFORE INSERT ON audit_entries BEGIN SELECT RAISE(ABORT, 'audit-boom'); END;"
      );
      const res = await broken.requestAdmin('POST', '/v2/admin/communities', {
        cookie: broken.roleCookies.super_admin,
        body: { slug: 'rolled-back-comm' },
      });
      expect(res.status).toBe(503);
      expect(
        await broken.db
          .select()
          .from(communitiesSqlite)
          .where(eq(communitiesSqlite.slug, 'rolled-back-comm'))
      ).toHaveLength(0);
    }
  });

  it('issues and reissues ClaimTokens (<=72h, SHA-256 only, shown once, audited), updates claimStatus, and integrates with /v2/bootstrap/claim', async () => {
    for (const useD1Batch of [false, true]) {
      const { db, app, superAdmin, roleCookies, requestAdmin, advanceMs } =
        await setup({ useD1Batch });

      const provRes = await requestAdmin('POST', '/v2/admin/communities', {
        cookie: roleCookies.super_admin,
        body: { slug: 'claimable-hosted' },
      });
      expect(provRes.status).toBe(201);
      const commId = AdminCommunityResponseSchema.parse(await provRes.json())
        .data.id;

      // Input validation on :id and ttlSeconds
      expect(
        (
          await requestAdmin(
            'POST',
            '/v2/admin/communities/not-an-id/claim-tokens',
            { cookie: roleCookies.super_admin }
          )
        ).status
      ).toBe(400);
      expect(
        (
          await requestAdmin(
            'POST',
            '/v2/admin/communities/999999/claim-tokens',
            { cookie: roleCookies.super_admin }
          )
        ).status
      ).toBe(404);
      for (const badBody of [
        { ttlSeconds: 59 },
        { ttlSeconds: CLAIM_TOKEN_MAX_TTL_MS / 1000 + 1 },
        { ttlSeconds: 3600.5 },
        { ttlSeconds: 3600, extra: true },
      ]) {
        expect(
          (
            await requestAdmin(
              'POST',
              `/v2/admin/communities/${commId}/claim-tokens`,
              { cookie: roleCookies.super_admin, body: badBody }
            )
          ).status
        ).toBe(400);
      }

      // First issuance (empty body -> default 72h)
      const issue1Res = await requestAdmin(
        'POST',
        `/v2/admin/communities/${commId}/claim-tokens`,
        { cookie: roleCookies.super_admin }
      );
      expect(issue1Res.status).toBe(201);
      const tok1 = ClaimTokenIssuedResponseSchema.parse(
        await issue1Res.json()
      ).data;
      expect(tok1.communityId).toBe(commId);
      expect(
        new Date(tok1.expiresAt).getTime() - new Date(tok1.createdAt).getTime()
      ).toBe(CLAIM_TOKEN_MAX_TTL_MS);

      // Token is stored only as SHA-256 hash; never plaintext
      const [row1] = await db
        .select()
        .from(claimTokensSqlite)
        .where(eq(claimTokensSqlite.id, tok1.id));
      expect(row1?.tokenHash).toBe(await sha256Hex(tok1.token));
      expect(row1?.tokenHash).not.toBe(tok1.token);
      expect(row1?.issuedBy).toBe(superAdmin.id);

      // claimStatus -> claim_pending
      const listPending = AdminCommunityListResponseSchema.parse(
        await (
          await requestAdmin('GET', '/v2/admin/communities', {
            cookie: roleCookies.super_admin,
          })
        ).json()
      );
      expect(listPending.data.find((c) => c.id === commId)?.claimStatus).toBe(
        'claim_pending'
      );

      // Reissue with shorter TTL (1 hour) supersedes token 1
      advanceMs(10_000);
      const issue2Res = await requestAdmin(
        'POST',
        `/v2/admin/communities/${commId}/claim-tokens`,
        { cookie: roleCookies.super_admin, body: { ttlSeconds: 3600 } }
      );
      expect(issue2Res.status).toBe(201);
      const tok2 = ClaimTokenIssuedResponseSchema.parse(
        await issue2Res.json()
      ).data;
      expect(
        new Date(tok2.expiresAt).getTime() - new Date(tok2.createdAt).getTime()
      ).toBe(3600 * 1000);

      const [row1After] = await db
        .select()
        .from(claimTokensSqlite)
        .where(eq(claimTokensSqlite.id, tok1.id));
      expect(row1After?.supersededAt).toBe(new Date(tok2.createdAt).getTime());

      // Advance past token 2's 1h expiry -> claimStatus returns to unclaimed
      advanceMs(3600 * 1000 + 1);
      const listExpired = AdminCommunityListResponseSchema.parse(
        await (
          await requestAdmin('GET', '/v2/admin/communities', {
            cookie: roleCookies.super_admin,
          })
        ).json()
      );
      expect(listExpired.data.find((c) => c.id === commId)?.claimStatus).toBe(
        'unclaimed'
      );

      // Reissue token 3 so we can test end-to-end claim
      const issue3Res = await requestAdmin(
        'POST',
        `/v2/admin/communities/${commId}/claim-tokens`,
        { cookie: roleCookies.super_admin, body: {} }
      );
      expect(issue3Res.status).toBe(201);
      const tok3 = ClaimTokenIssuedResponseSchema.parse(
        await issue3Res.json()
      ).data;

      // Superseded token 1 and expired token 2 fail /v2/bootstrap/claim
      for (const staleToken of [tok1.token, tok2.token]) {
        const failClaim = await app.request(
          `${API_ORIGIN}/v2/bootstrap/claim`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'cf-connecting-ip': '203.0.113.80',
            },
            body: JSON.stringify({
              token: staleToken,
              username: 'stale_admin',
              email: 'stale@example.test',
              password: makePasswordPayload(),
            }),
          }
        );
        expect(failClaim.status).toBe(401);
      }

      // Valid token 3 succeeds
      const okClaim = await app.request(`${API_ORIGIN}/v2/bootstrap/claim`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'cf-connecting-ip': '203.0.113.81',
        },
        body: JSON.stringify({
          token: tok3.token,
          username: 'claimed_host_admin',
          email: 'claimed-host@example.test',
          password: makePasswordPayload(),
        }),
      });
      expect(okClaim.status).toBe(201);

      // claimStatus -> claimed, and further token issuance is permanently refused (409)
      const listClaimed = AdminCommunityListResponseSchema.parse(
        await (
          await requestAdmin('GET', '/v2/admin/communities', {
            cookie: roleCookies.super_admin,
          })
        ).json()
      );
      expect(listClaimed.data.find((c) => c.id === commId)?.claimStatus).toBe(
        'claimed'
      );

      const refusedRes = await requestAdmin(
        'POST',
        `/v2/admin/communities/${commId}/claim-tokens`,
        { cookie: roleCookies.super_admin }
      );
      expect(refusedRes.status).toBe(409);

      // Audits carry communityId = commId, never token or tokenHash.
      // Failed issuance records resourceIds: [] (never communityId as a claim_token id).
      const issueAudits = (
        await db
          .select()
          .from(auditEntriesSqlite)
          .where(eq(auditEntriesSqlite.communityId, commId))
      ).filter((e) => e.action === 'claim_token.issue');
      expect(issueAudits.map((e) => e.outcome)).toEqual([
        'success',
        'success',
        'success',
        'failure',
      ]);
      expect(
        issueAudits.map((e) => ({
          communityId: e.communityId,
          resourceType: e.resourceType,
          resourceIds: e.resourceIds,
        }))
      ).toEqual([
        {
          communityId: commId,
          resourceType: 'claim_token',
          resourceIds: [tok1.id],
        },
        {
          communityId: commId,
          resourceType: 'claim_token',
          resourceIds: [tok2.id],
        },
        {
          communityId: commId,
          resourceType: 'claim_token',
          resourceIds: [tok3.id],
        },
        { communityId: commId, resourceType: 'claim_token', resourceIds: [] },
      ]);
      const serialized = JSON.stringify(issueAudits);
      for (const tok of [tok1.token, tok2.token, tok3.token]) {
        expect(serialized).not.toContain(tok);
        expect(serialized).not.toContain(await sha256Hex(tok));
      }
      for (const entry of issueAudits) {
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
    }
  });

  it('refuses ClaimToken issuance (409 + failure audit) for disabled, bootstrapped, previously-claimed, user-bearing, or content-bearing communities, and rolls back on audit failure', async () => {
    const ctx = await setup();
    const { db, superAdmin, roleCookies, requestAdmin, currentNow } = ctx;
    const now = currentNow();
    const nowMs = now.getTime();

    const makeEmptyCommunity = async (slug: string, isActive = true) => {
      const [c] = await db
        .insert(communitiesSqlite)
        .values({
          name: slug,
          slug,
          locale: 'en',
          publicStories: false,
          isActive,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      return c;
    };

    // Disabled empty community
    const disabledEmpty = await makeEmptyCommunity('disabled-empty', false);
    expect(
      (
        await requestAdmin(
          'POST',
          `/v2/admin/communities/${disabledEmpty.id}/claim-tokens`,
          { cookie: roleCookies.super_admin }
        )
      ).status
    ).toBe(409);
    const disabledFailureAudits = (
      await db
        .select()
        .from(auditEntriesSqlite)
        .where(eq(auditEntriesSqlite.communityId, disabledEmpty.id))
    ).filter((e) => e.action === 'claim_token.issue');
    expect(disabledFailureAudits).toHaveLength(1);
    expect(disabledFailureAudits[0]?.outcome).toBe('failure');
    expect(disabledFailureAudits[0]?.resourceType).toBe('claim_token');
    expect(disabledFailureAudits[0]?.resourceIds).toEqual([]);

    // Bootstrapped community (even if users were absent)
    const bootstrappedComm = await makeEmptyCommunity('bootstrapped-comm');
    await db.insert(installationBootstrapSqlite).values({
      id: 1,
      setupId: 'setup-1',
      communityId: bootstrappedComm.id,
      adminUserId: null,
      completedAt: nowMs,
    });
    expect(
      (
        await requestAdmin(
          'POST',
          `/v2/admin/communities/${bootstrappedComm.id}/claim-tokens`,
          { cookie: roleCookies.super_admin }
        )
      ).status
    ).toBe(409);

    // Previously claimed community (consumed claim token even if user deleted)
    const prevClaimed = await makeEmptyCommunity('prev-claimed');
    await db.insert(claimTokensSqlite).values({
      communityId: prevClaimed.id,
      tokenHash: await sha256Hex('used-token-material'),
      issuedBy: superAdmin.id,
      createdAt: nowMs - 1000,
      expiresAt: nowMs + 60_000,
      consumedAt: nowMs - 500,
      consumedBy: null,
      supersededAt: null,
    });
    expect(
      (
        await requestAdmin(
          'POST',
          `/v2/admin/communities/${prevClaimed.id}/claim-tokens`,
          { cookie: roleCookies.super_admin }
        )
      ).status
    ).toBe(409);

    // Community with any content/operational history row
    const contentCases: Array<[string, (cid: number) => Promise<void>]> = [
      [
        'story',
        async (cid) => {
          await db.insert(storiesSqlite).values({
            communityId: cid,
            title: 'Content Story',
            slug: `s-${cid}`,
            language: 'en',
            privacyLevel: 'editors',
            isRestricted: false,
            createdAt: now,
            updatedAt: now,
          });
        },
      ],
      [
        'place',
        async (cid) => {
          await db.insert(placesSqlite).values({
            communityId: cid,
            name: 'Content Place',
            createdAt: now,
            updatedAt: now,
          });
        },
      ],
      [
        'speaker',
        async (cid) => {
          await db.insert(speakersSqlite).values({
            communityId: cid,
            name: 'Content Speaker',
            createdAt: now,
            updatedAt: now,
          });
        },
      ],
      [
        'file',
        async (cid) => {
          const fid = crypto.randomUUID();
          await db.insert(filesSqlite).values({
            id: fid,
            filename: 'c.png',
            originalName: 'c.png',
            path: `communities/${cid}/${fid}`,
            url: `https://ignored.invalid/${fid}`,
            mimeType: 'image/png',
            size: 10,
            communityId: cid,
            uploadedBy: null,
            createdAt: now,
            updatedAt: now,
          });
        },
      ],
      [
        'attachment',
        async (cid) => {
          await db.insert(attachmentsSqlite).values({
            communityId: cid,
            fileId: null,
            ownerType: 'community',
            ownerId: cid,
            role: 'community_display_image',
            ordinal: 0,
            createdAt: now,
          });
        },
      ],
      [
        'external_media_link',
        async (cid) => {
          const [story] = await db
            .insert(storiesSqlite)
            .values({
              communityId: cid,
              title: 'EML Story',
              slug: `eml-${cid}`,
              language: 'en',
              privacyLevel: 'editors',
              isRestricted: false,
              createdAt: now,
              updatedAt: now,
            })
            .returning();
          await db.insert(externalMediaLinksSqlite).values({
            communityId: cid,
            storyId: story.id,
            url: 'https://example.test/video',
            ordinal: 0,
            createdAt: now,
          });
        },
      ],
      [
        'community_map_config',
        async (cid) => {
          await db.insert(communityMapConfigsSqlite).values({
            communityId: cid,
            createdAt: now,
            updatedAt: now,
          });
        },
      ],
      [
        'theme',
        async (cid) => {
          await db.insert(themesSqlite).values({
            communityId: cid,
            name: 'Legacy Theme',
            active: true,
            createdAt: now,
            updatedAt: now,
          });
        },
      ],
      [
        'login_code',
        async (cid) => {
          await db.insert(loginCodesSqlite).values({
            communityId: cid,
            userId: superAdmin.id,
            purpose: 'recovery',
            codeHash: await sha256Hex(`lc-${cid}`),
            createdBy: superAdmin.id,
            createdAt: nowMs,
            expiresAt: null,
          });
        },
      ],
      [
        'account_auth_throttle',
        async (cid) => {
          await db.insert(authThrottleSqlite).values({
            key: `acct-${cid}`,
            kind: 'account',
            communityId: cid,
            failures: 1,
            windowStartedAt: nowMs,
            blockedUntil: null,
          });
        },
      ],
      [
        'non_claim_audit_entry',
        async (cid) => {
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
        },
      ],
    ];

    for (const [label, seed] of contentCases) {
      const c = await makeEmptyCommunity(`nonempty-${label}`);
      await seed(c.id);
      const res = await requestAdmin(
        'POST',
        `/v2/admin/communities/${c.id}/claim-tokens`,
        { cookie: roleCookies.super_admin }
      );
      expect(res.status, `expected 409 for ${label}`).toBe(409);
      const failureAudits = (
        await db
          .select()
          .from(auditEntriesSqlite)
          .where(eq(auditEntriesSqlite.communityId, c.id))
      ).filter((e) => e.action === 'claim_token.issue');
      expect(failureAudits).toHaveLength(1);
      expect(failureAudits[0]?.outcome).toBe('failure');
      expect(failureAudits[0]?.resourceType).toBe('claim_token');
      expect(failureAudits[0]?.resourceIds).toEqual([]);
    }

    // Audit failure rollback on issueClaimTokenAtomically (direct SQLite + D1 batch)
    for (const useD1Batch of [false, true]) {
      const broken = await setup({ useD1Batch });
      const provRes = await broken.requestAdmin(
        'POST',
        '/v2/admin/communities',
        {
          cookie: broken.roleCookies.super_admin,
          body: { slug: 'broken-issue-comm' },
        }
      );
      const cid = AdminCommunityResponseSchema.parse(await provRes.json()).data
        .id;
      const firstIssue = await broken.requestAdmin(
        'POST',
        `/v2/admin/communities/${cid}/claim-tokens`,
        { cookie: broken.roleCookies.super_admin }
      );
      expect(firstIssue.status).toBe(201);
      const firstId = ClaimTokenIssuedResponseSchema.parse(
        await firstIssue.json()
      ).data.id;

      broken.sqlite.exec(
        "CREATE TRIGGER fail_audit BEFORE INSERT ON audit_entries BEGIN SELECT RAISE(ABORT, 'audit-boom'); END;"
      );
      const secondIssue = await broken.requestAdmin(
        'POST',
        `/v2/admin/communities/${cid}/claim-tokens`,
        { cookie: broken.roleCookies.super_admin }
      );
      expect(secondIssue.status).toBe(503);

      const tokens = await broken.db
        .select()
        .from(claimTokensSqlite)
        .where(eq(claimTokensSqlite.communityId, cid));
      expect(tokens).toHaveLength(1);
      expect(tokens[0]?.id).toBe(firstId);
      expect(tokens[0]?.supersededAt).toBeNull();
    }
  });

  it('treats descriptive/non-default community row fields (including custom name and non-default locale) as non-empty on SQLite and D1 db.batch() while allowing provisioning defaults', async () => {
    for (const useD1Batch of [false, true]) {
      const { db, roleCookies, requestAdmin, currentNow } = await setup({
        useD1Batch,
      });
      const now = currentNow();
      const descriptiveCases: Array<
        [string, Partial<typeof communitiesSqlite.$inferInsert>, string]
      > = [
        [
          'name',
          { name: 'Secret Custom Community Name' },
          'Secret Custom Community Name',
        ],
        ['locale', { locale: 'pt-BR' }, 'pt-BR'],
        [
          'description',
          { description: '<p>Secret community overview</p>' },
          'Secret community overview',
        ],
        [
          'descriptionPlain',
          { descriptionPlain: 'Plain private description' },
          'Plain private description',
        ],
        ['country', { country: 'BR' }, 'BR'],
        [
          'culturalSettings',
          { culturalSettings: '{"custom":"secret"}' },
          '{"custom":"secret"}',
        ],
        ['publicStories', { publicStories: true }, ''],
        ['beta', { beta: true }, ''],
      ];

      for (const [label, patch, secretMarker] of descriptiveCases) {
        const provRes = await requestAdmin('POST', '/v2/admin/communities', {
          cookie: roleCookies.super_admin,
          body: { slug: `row-desc-${label.toLowerCase()}` },
        });
        expect(provRes.status).toBe(201);
        const cid = AdminCommunityResponseSchema.parse(await provRes.json())
          .data.id;

        await db
          .update(communitiesSqlite)
          .set(patch)
          .where(eq(communitiesSqlite.id, cid));

        const issueRes = await requestAdmin(
          'POST',
          `/v2/admin/communities/${cid}/claim-tokens`,
          { cookie: roleCookies.super_admin }
        );
        expect(issueRes.status, `expected 409 for ${label}`).toBe(409);

        expect(
          await db
            .select()
            .from(claimTokensSqlite)
            .where(eq(claimTokensSqlite.communityId, cid))
        ).toHaveLength(0);

        const failureAudits = (
          await db
            .select()
            .from(auditEntriesSqlite)
            .where(eq(auditEntriesSqlite.communityId, cid))
        ).filter((e) => e.action === 'claim_token.issue');
        expect(failureAudits).toHaveLength(1);
        expect(failureAudits[0]?.outcome).toBe('failure');
        expect(failureAudits[0]?.resourceType).toBe('claim_token');
        expect(failureAudits[0]?.resourceIds).toEqual([]);

        const listRes = await requestAdmin(
          'GET',
          '/v2/admin/communities?limit=100',
          { cookie: roleCookies.super_admin }
        );
        expect(listRes.status).toBe(200);
        const listText = await listRes.text();
        if (secretMarker.length > 0) {
          expect(listText).not.toContain(secretMarker);
        }
        const listed = AdminCommunityListResponseSchema.parse(
          JSON.parse(listText)
        ).data.find((c) => c.id === cid);
        expect(listed?.claimStatus, `expected claimed for ${label}`).toBe(
          'claimed'
        );
      }

      // Provisioning defaults (name === slug, locale === 'en', null descriptive fields) remain unclaimed & issuable
      const [cleanRow] = await db
        .insert(communitiesSqlite)
        .values({
          name: 'clean-default-comm',
          slug: 'clean-default-comm',
          locale: 'en',
          publicStories: false,
          beta: false,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      const listClean = AdminCommunityListResponseSchema.parse(
        await (
          await requestAdmin('GET', '/v2/admin/communities?limit=100', {
            cookie: roleCookies.super_admin,
          })
        ).json()
      ).data.find((c) => c.id === cleanRow.id);
      expect(listClean?.claimStatus).toBe('unclaimed');
      expect(
        (
          await requestAdmin(
            'POST',
            `/v2/admin/communities/${cleanRow.id}/claim-tokens`,
            { cookie: roleCookies.super_admin }
          )
        ).status
      ).toBe(201);
    }
  });
});
