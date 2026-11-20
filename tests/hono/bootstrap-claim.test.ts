/**
 * Focused tests for POST /v2/bootstrap/claim (Slice 11b-C, #188;
 * SPEC-V2 §6.2, §6.8, §7 "Bootstrap and account lifecycle"; route registry §1).
 *
 * Covers:
 * - Wire validation (415, 400 malformed/extra/weak verifier, 413, 503 missing secret)
 * - Happy path: claims empty never-administered community, sets first admin,
 *   consumes token (consumedAt + consumedBy), supersedes sibling unconsumed
 *   tokens, issues 10 recovery codes, establishes ts_session (standard + deviceSession),
 *   confirms /v2/auth/me `recoveryCodesConfirmed: true`, login + recovery code redeem,
 *   never escalates to super_admin
 * - Uniform 401 on unknown, expired, superseded, consumed, >72h TTL, disabled
 *   community, already-administered community, previously-claimed community, and
 *   non-empty communities (stories, places, speakers, files, attachments,
 *   external_media_links, community_map_configs)
 * - 409 on §6.2 cross-community identity collisions leaving token unconsumed
 * - Shared-browser cross-user session revocation on success only
 * - AuthThrottle per-IP and per-token (`claim:`) isolation, community cascade,
 *   zero claim rows created for garbage tokens, reset on success
 * - Real concurrency races, D1 `db.batch()` emulation, audit-failure rollback
 * - Content-free audit verification (bootstrap.claim vs claim_token.consume)
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
  authThrottleSqlite,
  sessionsSqlite,
} from '../../src/db/schema/sessions.js';
import {
  claimTokensSqlite,
  loginCodesSqlite,
} from '../../src/db/schema/login_codes.js';
import { storiesSqlite } from '../../src/db/schema/stories.js';
import { placesSqlite } from '../../src/db/schema/places.js';
import { speakersSqlite } from '../../src/db/schema/speakers.js';
import { filesSqlite } from '../../src/db/schema/files.js';
import { attachmentsSqlite } from '../../src/db/schema/attachments.js';
import { externalMediaLinksSqlite } from '../../src/db/schema/external_media_links.js';
import { communityMapConfigsSqlite } from '../../src/db/schema/community_map_configs.js';
import { auditEntriesSqlite } from '../../src/db/schema/audit_entries.js';
import {
  ARGON2ID_ALGORITHM,
  ARGON2ID_PARAMS,
  AUTH_THROTTLE_MAX_FAILURES,
  CLAIM_TOKEN_MAX_TTL_MS,
  RECOVERY_CODE_COUNT,
} from '../../src/shared/auth-policy.js';
import { sha256Hex, toBase64Url, toHex } from '../../src/shared/auth-crypto.js';
import { BootstrapResponseSchema } from '../../src/shared/schemas/bootstrap.js';
import { validateContentFreeAuditEntry } from '../../src/shared/utils/audit-entry.js';
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

const makeRawToken = (): string =>
  toBase64Url(crypto.getRandomValues(new Uint8Array(32)));

describe('POST /v2/bootstrap/claim (Slice 11b-C)', () => {
  const openDbs: Sqlite.Database[] = [];

  afterEach(() => {
    while (openDbs.length > 0) openDbs.pop()?.close();
  });

  async function setup(
    options: {
      serverSecret?: string | undefined;
      useD1Batch?: boolean;
    } = {}
  ) {
    const sqlite = new Sqlite(':memory:');
    sqlite.pragma('foreign_keys = ON');
    openDbs.push(sqlite);
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: 'src/db/migrations' });
    if (options.useD1Batch) installD1BatchEmulation(db);

    let currentNow = new Date('2026-06-01T12:00:00.000Z');
    const advanceMs = (ms: number) => {
      currentNow = new Date(currentNow.getTime() + ms);
    };
    const secret =
      'serverSecret' in options ? options.serverSecret : makeServerSecret();

    const saKey = makeDerivedKey();
    const [superAdmin] = await db
      .insert(usersSqlite)
      .values({
        email: 'sa@claim.example.test',
        username: 'claim_super_admin',
        emailNormalized: 'sa@claim.example.test',
        usernameNormalized: 'claim_super_admin',
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

    const [existingComm] = await db
      .insert(communitiesSqlite)
      .values({
        name: 'Existing Hosted Community',
        slug: 'existing-hosted',
        locale: 'en',
        publicStories: false,
        isActive: true,
        createdAt: currentNow,
        updatedAt: currentNow,
      })
      .returning();

    const existingUserKey = makeDerivedKey();
    const [existingUser] = await db
      .insert(usersSqlite)
      .values({
        email: 'existing-member@hosted.example.test',
        username: 'existing_member',
        emailNormalized: 'existing-member@hosted.example.test',
        usernameNormalized: 'existing_member',
        firstName: '',
        lastName: '',
        ...(await argon2Seed(existingUserKey)),
        role: 'member',
        communityId: existingComm.id,
        isActive: true,
        createdAt: currentNow,
        updatedAt: currentNow,
      })
      .returning();

    const createProvisionedCommunity = async (
      slug: string,
      isActive = true
    ) => {
      const [comm] = await db
        .insert(communitiesSqlite)
        .values({
          name: `Provisioned ${slug}`,
          slug,
          locale: 'en',
          publicStories: false,
          isActive,
          createdAt: currentNow,
          updatedAt: currentNow,
        })
        .returning();
      return comm;
    };

    const insertClaimToken = async (
      communityId: number,
      opts: {
        ttlMs?: number;
        supersededAt?: number | null;
        consumedAt?: number | null;
        consumedBy?: number | null;
      } = {}
    ) => {
      const raw = makeRawToken();
      const createdAt = currentNow.getTime();
      const expiresAt = createdAt + (opts.ttlMs ?? CLAIM_TOKEN_MAX_TTL_MS);
      const [row] = await db
        .insert(claimTokensSqlite)
        .values({
          communityId,
          tokenHash: await sha256Hex(raw),
          issuedBy: superAdmin.id,
          createdAt,
          expiresAt,
          consumedAt: opts.consumedAt ?? null,
          consumedBy: opts.consumedBy ?? null,
          supersededAt: opts.supersededAt ?? null,
        })
        .returning();
      return { raw, row };
    };

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

    const postClaim = (body: unknown, headers: Record<string, string> = {}) =>
      app.request(`${API_ORIGIN}/v2/bootstrap/claim`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'cf-connecting-ip': '203.0.113.30',
          'user-agent': 'ClaimTest/1.0',
          ...headers,
        },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      });

    return {
      sqlite,
      db,
      app,
      secret,
      superAdmin,
      existingComm,
      existingUser,
      existingUserKey,
      currentNow: () => currentNow,
      advanceMs,
      createProvisionedCommunity,
      insertClaimToken,
      postClaim,
    };
  }

  it('enforces wire validation (415, 400, 413, weak verifier, 503 missing secret)', async () => {
    const { app, postClaim } = await setup();

    expect(
      (
        await app.request(`${API_ORIGIN}/v2/bootstrap/claim`, {
          method: 'POST',
          headers: { 'content-type': 'text/plain' },
          body: '{}',
        })
      ).status
    ).toBe(415);

    expect((await postClaim('{broken')).status).toBe(400);

    expect(
      (
        await postClaim(
          JSON.stringify({
            token: 'a'.repeat(5000),
            username: 'u',
            email: 'u@example.test',
            password: makePasswordPayload(),
          })
        )
      ).status
    ).toBe(413);

    expect(
      (
        await postClaim({
          token: makeRawToken(),
          username: 'new_admin',
          email: 'new@example.test',
          password: makePasswordPayload(),
          extra: 'nope',
        })
      ).status
    ).toBe(400);

    const weakRes = await postClaim({
      token: makeRawToken(),
      username: 'new_admin',
      email: 'new@example.test',
      password: {
        algorithm: ARGON2ID_ALGORITHM,
        salt: makeVerifierSalt(),
        params: { memoryKiB: 1024, iterations: 1, parallelism: 1 },
        derivedKey: makeDerivedKey(),
      },
    });
    expect(weakRes.status).toBe(400);
    expect(await weakRes.json()).toEqual({
      error: 'Password does not meet requirements',
    });

    // Missing serverSecret -> 503
    const noSecretCtx = await setup({ serverSecret: undefined });
    const comm = await noSecretCtx.createProvisionedCommunity('no-secret-comm');
    const tok = await noSecretCtx.insertClaimToken(comm.id);
    const noSecretRes = await noSecretCtx.postClaim({
      token: tok.raw,
      username: 'no_secret_admin',
      email: 'nosecret@example.test',
      password: makePasswordPayload(),
    });
    expect(noSecretRes.status).toBe(503);
    expect(await noSecretRes.json()).toEqual({ error: 'Service unavailable' });
  });

  it('claims an empty hosted community, supersedes siblings, issues 10 recovery codes + session, and rejects replay', async () => {
    const { db, app, createProvisionedCommunity, insertClaimToken, postClaim } =
      await setup();

    const comm = await createProvisionedCommunity('hosted-alpha');
    const olderSibling = await insertClaimToken(comm.id);
    const activeToken = await insertClaimToken(comm.id);
    const derivedKey = makeDerivedKey();

    const res = await postClaim({
      token: activeToken.raw,
      username: 'hosted_alpha_admin',
      email: 'admin@hosted-alpha.example.test',
      displayName: 'Alpha Admin',
      password: makePasswordPayload(derivedKey),
      deviceSession: true,
    });
    expect(res.status).toBe(201);

    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('ts_session=');
    expect(setCookie).toMatch(/Max-Age=5184000/i);
    const cookie = setCookie.split(';')[0]!;

    const json = await res.json();
    const parsed = BootstrapResponseSchema.parse(json);
    expect(parsed.data.community.id).toBe(comm.id);
    expect(parsed.data.community.slug).toBe('hosted-alpha');
    expect(parsed.data.user.role).toBe('admin');
    expect(parsed.data.user.communityId).toBe(comm.id);
    expect(parsed.data.user.recoveryCodesConfirmed).toBe(true);
    expect('caFingerprint' in parsed.data).toBe(false);
    expect(parsed.data.recoveryCodes.codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(new Set(parsed.data.recoveryCodes.codes).size).toBe(
      RECOVERY_CODE_COUNT
    );

    const serialized = JSON.stringify(json);
    expect(serialized).not.toContain(activeToken.raw);
    expect(serialized).not.toContain(derivedKey);
    expect(serialized).not.toContain(cookie.slice('ts_session='.length));

    // Claimed token is consumed with consumedBy = new admin; sibling superseded.
    const [consumedRow] = await db
      .select()
      .from(claimTokensSqlite)
      .where(eq(claimTokensSqlite.id, activeToken.row.id));
    expect(consumedRow?.consumedAt).not.toBeNull();
    expect(consumedRow?.consumedBy).toBe(parsed.data.user.id);
    const [siblingRow] = await db
      .select()
      .from(claimTokensSqlite)
      .where(eq(claimTokensSqlite.id, olderSibling.row.id));
    expect(siblingRow?.supersededAt).not.toBeNull();
    expect(siblingRow?.consumedAt).toBeNull();

    // 10 SHA-256 recovery codes saved for new admin.
    const storedCodes = await db
      .select()
      .from(loginCodesSqlite)
      .where(eq(loginCodesSqlite.userId, parsed.data.user.id));
    expect(storedCodes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(storedCodes.every((c) => c.purpose === 'recovery')).toBe(true);

    // /v2/auth/me works and cannot reach super_admin endpoints.
    const meRes = await app.request(`${API_ORIGIN}/v2/auth/me`, {
      headers: { cookie },
    });
    expect(meRes.status).toBe(200);
    const meBody = (await meRes.json()) as {
      user: { role: string; recoveryCodesConfirmed: boolean };
    };
    expect(meBody.user.role).toBe('admin');
    expect(meBody.user.recoveryCodesConfirmed).toBe(true);

    // Replay of consumed token AND older superseded token fail uniformly 401.
    for (const replayToken of [activeToken.raw, olderSibling.raw]) {
      const replayRes = await postClaim({
        token: replayToken,
        username: 'replay_admin',
        email: 'replay@example.test',
        password: makePasswordPayload(),
      });
      expect(replayRes.status).toBe(401);
      expect(await replayRes.json()).toEqual({ error: 'Invalid credentials' });
    }

    // Login works and redeeming a recovery code rotates password & revokes session.
    const loginRes = await app.request(`${API_ORIGIN}/v2/auth/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'cf-connecting-ip': '203.0.113.31',
      },
      body: JSON.stringify({
        identifier: 'hosted_alpha_admin',
        derivedKey,
      }),
    });
    expect(loginRes.status).toBe(200);

    const redeemRes = await app.request(
      `${API_ORIGIN}/v2/auth/recovery/redeem`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'cf-connecting-ip': '203.0.113.32',
        },
        body: JSON.stringify({
          code: parsed.data.recoveryCodes.codes[0],
          password: makePasswordPayload(),
        }),
      }
    );
    expect(redeemRes.status).toBe(200);
    expect(
      (await app.request(`${API_ORIGIN}/v2/auth/me`, { headers: { cookie } }))
        .status
    ).toBe(401);
  });

  it('uniformly rejects unknown, expired, superseded, >72h TTL, disabled, administered, previously-claimed, and non-empty communities', async () => {
    const ctx = await setup();
    const {
      sqlite,
      db,
      currentNow,
      advanceMs,
      createProvisionedCommunity,
      insertClaimToken,
      postClaim,
    } = ctx;

    const expectUniform401 = async (token: string, ip = '203.0.113.33') => {
      const res = await postClaim(
        {
          token,
          username: `u_${toHex(crypto.getRandomValues(new Uint8Array(6)))}`,
          email: `${toHex(crypto.getRandomValues(new Uint8Array(6)))}@example.test`,
          password: makePasswordPayload(),
        },
        { 'cf-connecting-ip': ip }
      );
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'Invalid credentials' });
    };

    // 1. Unknown token
    await expectUniform401(makeRawToken(), '203.0.113.34');

    // 2. Expired token
    const commExp = await createProvisionedCommunity('exp-comm');
    const expToken = await insertClaimToken(commExp.id, { ttlMs: 1000 });
    advanceMs(2000);
    await expectUniform401(expToken.raw, '203.0.113.35');

    // 3. Superseded token
    const commSup = await createProvisionedCommunity('sup-comm');
    const supToken = await insertClaimToken(commSup.id, {
      supersededAt: currentNow().getTime(),
    });
    await expectUniform401(supToken.raw, '203.0.113.36');

    // 4. >72h TTL token
    const commTtl = await createProvisionedCommunity('ttl-comm');
    const ttlToken = await insertClaimToken(commTtl.id, {
      ttlMs: CLAIM_TOKEN_MAX_TTL_MS + 60_000,
    });
    await expectUniform401(ttlToken.raw, '203.0.113.37');

    // 5. Disabled community
    const commDisabled = await createProvisionedCommunity('dis-comm', false);
    const disToken = await insertClaimToken(commDisabled.id);
    await expectUniform401(disToken.raw, '203.0.113.38');

    // 6. Community already has a user
    const existingTok = await insertClaimToken(ctx.existingComm.id);
    await expectUniform401(existingTok.raw, '203.0.113.39');

    // 7. Previously claimed community (even if claimant user was later deleted!)
    const commPrev = await createProvisionedCommunity('prev-claimed');
    await insertClaimToken(commPrev.id, {
      consumedAt: currentNow().getTime() - 1000,
    });
    const freshAfterPrev = await insertClaimToken(commPrev.id);
    await expectUniform401(freshAfterPrev.raw, '203.0.113.40');

    // 8. Non-empty community for every content table (stories, places, speakers,
    // files, attachments, external_media_links, community_map_configs)
    const now = currentNow();
    const contentCases = [
      async (communityId: number) => {
        await db.insert(storiesSqlite).values({
          title: 'S',
          slug: `s-${communityId}`,
          communityId,
          isRestricted: false,
          privacyLevel: 'editors',
          language: 'en',
          createdAt: now,
          updatedAt: now,
        });
      },
      async (communityId: number) => {
        await db.insert(placesSqlite).values({
          name: 'P',
          communityId,
          isRestricted: false,
          createdAt: now,
          updatedAt: now,
        });
      },
      async (communityId: number) => {
        await db.insert(speakersSqlite).values({
          name: 'Sp',
          communityId,
          createdAt: now,
          updatedAt: now,
        });
      },
      async (communityId: number) => {
        await db.insert(filesSqlite).values({
          id: crypto.randomUUID(),
          filename: 'f.png',
          originalName: 'f.png',
          path: `communities/${communityId}/f.png`,
          storageKey: `communities/${communityId}/f.png`,
          url: '/v2/media/x',
          mimeType: 'image/png',
          size: 10,
          byteSize: 10,
          communityId,
          createdAt: now,
          updatedAt: now,
        });
      },
      async (communityId: number) => {
        const fileId = crypto.randomUUID();
        await db.insert(filesSqlite).values({
          id: fileId,
          filename: 'a.png',
          originalName: 'a.png',
          path: `communities/${communityId}/a.png`,
          storageKey: `communities/${communityId}/a.png`,
          url: '/v2/media/y',
          mimeType: 'image/png',
          size: 10,
          byteSize: 10,
          communityId,
          createdAt: now,
          updatedAt: now,
        });
        await db.insert(attachmentsSqlite).values({
          communityId,
          fileId,
          ownerType: 'community',
          ownerId: communityId,
          role: 'community_display_image',
          ordinal: 0,
        });
      },
      async (communityId: number) => {
        const [story] = await db
          .insert(storiesSqlite)
          .values({
            title: 'Eml',
            slug: `eml-${communityId}`,
            communityId,
            isRestricted: false,
            privacyLevel: 'editors',
            language: 'en',
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        await db.insert(externalMediaLinksSqlite).values({
          communityId,
          storyId: story.id,
          url: 'https://media.example.test/v.mp4',
          ordinal: 0,
          createdAt: now,
        });
      },
      async (communityId: number) => {
        await db.insert(communityMapConfigsSqlite).values({
          communityId,
          createdAt: now,
          updatedAt: now,
        });
      },
    ];
    for (let i = 0; i < contentCases.length; i += 1) {
      const c = await createProvisionedCommunity(`nonempty-${i}`);
      const t = await insertClaimToken(c.id);
      await contentCases[i]!(c.id);
      await expectUniform401(t.raw, `203.0.113.${41 + i}`);
    }
    expect(sqlite.open).toBe(true);
  });

  it('rejects §6.2 cross-community identity collisions with 409 while leaving the token unconsumed for retry', async () => {
    const {
      db,
      createProvisionedCommunity,
      insertClaimToken,
      postClaim,
      existingComm,
      existingUser,
      superAdmin,
      currentNow,
    } = await setup();
    const now = currentNow();
    const [emailShapedUsernameUser] = await db
      .insert(usersSqlite)
      .values({
        email: 'other@collision.example.test',
        username: 'handle@collision.example.test',
        emailNormalized: 'other@collision.example.test',
        usernameNormalized: 'handle@collision.example.test',
        firstName: '',
        lastName: '',
        ...(await argon2Seed(makeDerivedKey())),
        role: 'member',
        communityId: existingComm.id,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    const comm = await createProvisionedCommunity('collision-comm');
    const tok = await insertClaimToken(comm.id);

    for (const badIdentity of [
      // Collides with existing user's usernameNormalized (case-insensitive)
      {
        username: existingUser.username!.toUpperCase(),
        email: 'fresh1@collision.example.test',
      },
      // Username matches another account's emailNormalized
      {
        username: existingUser.email,
        email: 'fresh2@collision.example.test',
      },
      // Email matches another account's usernameNormalized
      {
        username: 'fresh_user_3',
        email: emailShapedUsernameUser.username!.toUpperCase(),
      },
      // Email matches null-community super_admin's emailNormalized
      {
        username: 'fresh_user_4',
        email: superAdmin.email.toUpperCase(),
      },
    ]) {
      const res = await postClaim({
        token: tok.raw,
        username: badIdentity.username,
        email: badIdentity.email,
        password: makePasswordPayload(),
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'Conflict' });
    }

    // Token remains unconsumed; retrying with clean credentials succeeds 201!
    const [rowBeforeRetry] = await db
      .select()
      .from(claimTokensSqlite)
      .where(eq(claimTokensSqlite.id, tok.row.id));
    expect(rowBeforeRetry?.consumedAt).toBeNull();

    const okRes = await postClaim({
      token: tok.raw,
      username: 'clean_claim_admin',
      email: 'clean-admin@collision.example.test',
      password: makePasswordPayload(),
    });
    expect(okRes.status).toBe(201);
  });

  it('revokes a presented cross-user cookie only on 201 claim success', async () => {
    const {
      app,
      db,
      createProvisionedCommunity,
      insertClaimToken,
      postClaim,
      existingUser,
      existingUserKey,
    } = await setup();

    const loginRes = await app.request(`${API_ORIGIN}/v2/auth/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'cf-connecting-ip': '203.0.113.50',
      },
      body: JSON.stringify({
        identifier: existingUser.email,
        derivedKey: existingUserKey,
      }),
    });
    expect(loginRes.status).toBe(200);
    const otherCookie = (loginRes.headers.get('set-cookie') ?? '').split(
      ';'
    )[0]!;

    // Failed claim does NOT revoke otherCookie.
    const badRes = await postClaim(
      {
        token: makeRawToken(),
        username: 'fail_claim',
        email: 'fail@example.test',
        password: makePasswordPayload(),
      },
      { cookie: otherCookie }
    );
    expect(badRes.status).toBe(401);
    expect(
      (
        await app.request(`${API_ORIGIN}/v2/auth/me`, {
          headers: { cookie: otherCookie },
        })
      ).status
    ).toBe(200);

    // Successful claim DOES revoke otherCookie.
    const comm = await createProvisionedCommunity('shared-browser');
    const tok = await insertClaimToken(comm.id);
    const okRes = await postClaim(
      {
        token: tok.raw,
        username: 'shared_browser_admin',
        email: 'shared@example.test',
        password: makePasswordPayload(),
      },
      { cookie: otherCookie }
    );
    expect(okRes.status).toBe(201);
    expect(
      (
        await app.request(`${API_ORIGIN}/v2/auth/me`, {
          headers: { cookie: otherCookie },
        })
      ).status
    ).toBe(401);
    expect(
      await db
        .select()
        .from(sessionsSqlite)
        .where(eq(sessionsSqlite.userId, existingUser.id))
    ).toHaveLength(0);
  });

  it('throttles per IP and per ClaimToken without cross-token starvation or garbage rows, and resets on success', async () => {
    const { db, createProvisionedCommunity, insertClaimToken, postClaim } =
      await setup();

    // 1. Garbage tokens create ONLY ip throttle rows, never claim rows.
    for (let i = 0; i < 3; i += 1) {
      const res = await postClaim(
        {
          token: makeRawToken(),
          username: 'garbage_u',
          email: 'garbage@example.test',
          password: makePasswordPayload(),
        },
        { 'cf-connecting-ip': '203.0.113.51' }
      );
      expect(res.status).toBe(401);
    }
    const throttleAfterGarbage = await db.select().from(authThrottleSqlite);
    expect(throttleAfterGarbage.every((r) => r.kind === 'ip')).toBe(true);

    // 2. Burn valid Token A's per-token budget across rotated IPs; Token A
    // locks (rejecting even clean credentials from a brand-new IP uniformly
    // with 401), while Token B in another community succeeds from a clean IP.
    const commA = await createProvisionedCommunity('throttle-a');
    const tokenA = await insertClaimToken(commA.id);
    for (let i = 0; i < AUTH_THROTTLE_MAX_FAILURES; i += 1) {
      const r = await postClaim(
        {
          token: tokenA.raw,
          username: 'ta_user',
          email: 'sa@claim.example.test',
          password: makePasswordPayload(),
        },
        { 'cf-connecting-ip': `203.0.113.${100 + i}` }
      );
      expect(r.status).toBe(409);
    }
    const claimRows = (await db.select().from(authThrottleSqlite)).filter(
      (r) => r.kind === 'claim'
    );
    expect(claimRows).toHaveLength(1);
    expect(claimRows[0]?.communityId).toBe(commA.id);
    expect(claimRows[0]?.blockedUntil).not.toBeNull();

    const blockedCleanRes = await postClaim(
      {
        token: tokenA.raw,
        username: 'ta_clean_admin',
        email: 'ta-clean@example.test',
        password: makePasswordPayload(),
      },
      { 'cf-connecting-ip': '203.0.113.109' }
    );
    expect(blockedCleanRes.status).toBe(401);
    expect(await blockedCleanRes.json()).toEqual({
      error: 'Invalid credentials',
    });

    // Token B fails 2 times from IP .52 (creating claim + ip rows), then
    // succeeds on attempt 3 and clears both counters!
    const commB = await createProvisionedCommunity('throttle-b');
    const tokenB = await insertClaimToken(commB.id);
    for (let i = 0; i < 2; i += 1) {
      // Trigger 409 identity collision using super_admin email so token stays
      // valid while recording failure counters for token B + IP .52.
      const failRes = await postClaim(
        {
          token: tokenB.raw,
          username: 'tb_admin',
          email: 'sa@claim.example.test',
          password: makePasswordPayload(),
        },
        { 'cf-connecting-ip': '203.0.113.52' }
      );
      expect(failRes.status).toBe(409);
    }
    const okRes = await postClaim(
      {
        token: tokenB.raw,
        username: 'tb_admin',
        email: 'tb@example.test',
        password: makePasswordPayload(),
      },
      { 'cf-connecting-ip': '203.0.113.52' }
    );
    expect(okRes.status).toBe(201);
    expect(
      (await db.select().from(authThrottleSqlite)).filter(
        (r) => r.communityId === commB.id
      )
    ).toHaveLength(0);

    // Community erasure (deleting audit_entries first per NO ACTION FK, then
    // the community row) cascades claim throttle rows.
    await db
      .delete(auditEntriesSqlite)
      .where(eq(auditEntriesSqlite.communityId, commA.id));
    await db
      .delete(communitiesSqlite)
      .where(eq(communitiesSqlite.id, commA.id));
    expect(
      (await db.select().from(authThrottleSqlite)).filter(
        (r) => r.kind === 'claim'
      )
    ).toHaveLength(0);
  });

  it('prevents concurrent double-claim and same-username claim races across SQLite and D1 db.batch() emulation', async () => {
    // 1. Real SQLite transaction race interposition: competitor consumes token inside tx hook
    const raceCtx = await setup();
    const comm = await raceCtx.createProvisionedCommunity('race-comm');
    const tok = await raceCtx.insertClaimToken(comm.id);
    let intercepted = 0;
    const raceProxy = new Proxy(raceCtx.db, {
      get(target, prop) {
        if (prop === 'transaction') {
          const realTx = target.transaction.bind(target);
          return (fn: (tx: unknown) => unknown) => {
            if (intercepted === 0) {
              intercepted += 1;
              raceCtx.sqlite
                .prepare('UPDATE claim_tokens SET consumed_at = ? WHERE id = ?')
                .run(raceCtx.currentNow().getTime(), tok.row.id);
            }
            return realTx(fn);
          };
        }
        return Reflect.get(target, prop);
      },
    }) as unknown as ReturnType<typeof drizzle>;
    const raceApp = createHonoApp({
      repository: new HonoFoundationRepository(raceProxy),
      storage: { read: async () => null },
      serverSecret: raceCtx.secret,
      secureCookies: false,
      publicOrigin: API_ORIGIN,
      now: () => raceCtx.currentNow(),
    });
    const lostRes = await raceApp.request(`${API_ORIGIN}/v2/bootstrap/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: tok.raw,
        username: 'race_loser',
        email: 'loser@race.example.test',
        password: makePasswordPayload(),
      }),
    });
    expect(intercepted).toBe(1);
    expect(lostRes.status).toBe(401);
    expect(
      await raceCtx.db
        .select()
        .from(usersSqlite)
        .where(eq(usersSqlite.communityId, comm.id))
    ).toHaveLength(0);

    // 2. D1 db.batch() concurrent double-claim -> exactly 1 wins (201), 1 loses (401)
    const d1Ctx = await setup({ useD1Batch: true });
    const commD1 = await d1Ctx.createProvisionedCommunity('d1-claim');
    const tokD1 = await d1Ctx.insertClaimToken(commD1.id);
    const [res1, res2] = await Promise.all([
      d1Ctx.postClaim(
        {
          token: tokD1.raw,
          username: 'd1_admin_1',
          email: 'd1a@example.test',
          password: makePasswordPayload(),
        },
        { 'cf-connecting-ip': '203.0.113.53' }
      ),
      d1Ctx.postClaim(
        {
          token: tokD1.raw,
          username: 'd1_admin_2',
          email: 'd1b@example.test',
          password: makePasswordPayload(),
        },
        { 'cf-connecting-ip': '203.0.113.54' }
      ),
    ]);
    expect([res1.status, res2.status].sort()).toEqual([201, 401]);
    expect(
      await d1Ctx.db
        .select()
        .from(usersSqlite)
        .where(eq(usersSqlite.communityId, commD1.id))
    ).toHaveLength(1);

    // 3. D1 concurrent same-username claim across TWO communities -> 1 wins (201), 1 gets 409
    const comm1 = await d1Ctx.createProvisionedCommunity('race-u-1');
    const comm2 = await d1Ctx.createProvisionedCommunity('race-u-2');
    const t1 = await d1Ctx.insertClaimToken(comm1.id);
    const t2 = await d1Ctx.insertClaimToken(comm2.id);
    const [uRes1, uRes2] = await Promise.all([
      d1Ctx.postClaim(
        {
          token: t1.raw,
          username: 'shared_desired_handle',
          email: 'u1@race.example.test',
          password: makePasswordPayload(),
        },
        { 'cf-connecting-ip': '203.0.113.55' }
      ),
      d1Ctx.postClaim(
        {
          token: t2.raw,
          username: 'shared_desired_handle',
          email: 'u2@race.example.test',
          password: makePasswordPayload(),
        },
        { 'cf-connecting-ip': '203.0.113.56' }
      ),
    ]);
    expect([uRes1.status, uRes2.status].sort()).toEqual([201, 409]);
  });

  it('rolls back all claim writes when audit fails and emits strictly content-free audit entries', async () => {
    // 1. Audit failure rollback atomicity (direct SQLite + D1 batch)
    for (const useD1Batch of [false, true]) {
      const broken = await setup({ useD1Batch });
      const comm = await broken.createProvisionedCommunity('broken-claim');
      const tok = await broken.insertClaimToken(comm.id);
      broken.sqlite.exec(
        "CREATE TRIGGER fail_audit BEFORE INSERT ON audit_entries BEGIN SELECT RAISE(ABORT, 'audit-boom'); END;"
      );
      const res = await broken.postClaim({
        token: tok.raw,
        username: 'broken_claim_admin',
        email: 'broken@claim.example.test',
        password: makePasswordPayload(),
      });
      expect(res.status).toBe(503);
      const [tokenAfter] = await broken.db
        .select()
        .from(claimTokensSqlite)
        .where(eq(claimTokensSqlite.id, tok.row.id));
      expect(tokenAfter?.consumedAt).toBeNull();
      expect(tokenAfter?.consumedBy).toBeNull();
      expect(
        await broken.db
          .select()
          .from(usersSqlite)
          .where(eq(usersSqlite.communityId, comm.id))
      ).toHaveLength(0);
      expect(
        await broken.db
          .select()
          .from(loginCodesSqlite)
          .where(eq(loginCodesSqlite.communityId, comm.id))
      ).toHaveLength(0);
    }

    // 2. Content-free audit entry verification across unknown-token, known-token
    // failure, and claim success
    const { db, createProvisionedCommunity, insertClaimToken, postClaim } =
      await setup();
    const comm = await createProvisionedCommunity('audit-claim');
    const tok = await insertClaimToken(comm.id);
    const derivedKey = makeDerivedKey();

    await postClaim({
      token: makeRawToken(),
      username: 'unknown_u',
      email: 'unknown@claim.example.test',
      password: makePasswordPayload(),
    });
    await postClaim({
      token: tok.raw,
      username: 'audit_admin',
      email: 'sa@claim.example.test', // 409 collision
      password: makePasswordPayload(),
    });
    const ok = await postClaim({
      token: tok.raw,
      username: 'audit_admin',
      email: 'audit-admin@claim.example.test',
      password: makePasswordPayload(derivedKey),
    });
    expect(ok.status).toBe(201);
    const codes = BootstrapResponseSchema.parse(await ok.json()).data
      .recoveryCodes.codes;

    const entries = await db.select().from(auditEntriesSqlite);
    expect(entries.length).toBeGreaterThanOrEqual(3);
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain(tok.raw);
    expect(serialized).not.toContain(tok.row.tokenHash);
    expect(serialized).not.toContain(derivedKey);
    expect(serialized).not.toContain('audit-admin@claim.example.test');
    for (const code of codes) {
      expect(serialized).not.toContain(code);
      expect(serialized).not.toContain(await sha256Hex(code));
    }

    const unknownAudit = entries.find((e) => e.action === 'bootstrap.claim');
    expect(unknownAudit).toBeDefined();
    expect(unknownAudit?.communityId).toBeNull();
    expect(unknownAudit?.resourceType).toBe('bootstrap');

    const tokenAudits = entries.filter(
      (e) => e.action === 'claim_token.consume'
    );
    expect(tokenAudits).toHaveLength(2);
    expect(tokenAudits.map((a) => a.outcome).sort()).toEqual([
      'failure',
      'success',
    ]);
    for (const entry of entries) {
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
});
