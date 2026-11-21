/**
 * Focused tests for POST /v2/auth/recovery-codes and GET /v2/auth/me
 * `recoveryCodesConfirmed` flag (Slice 11b-A, #188; SPEC-V2 §6.8, §6.10, §7).
 *
 * Covers:
 * - Wire validation (401 unauthenticated, 415 non-JSON, 400 malformed/extra, 413 >4KB, 503 missing secret)
 * - Role gating (viewer/member/editor -> 403; active admin, disabled-community admin, super_admin -> 201)
 * - Password step-up (Argon2id and wrapped Rails bcrypt) + AuthThrottle integration
 * - Regeneration superseding only active recovery codes (leaving used and admin_issued codes intact)
 * - GET /v2/auth/me `recoveryCodesConfirmed` lifecycle
 * - Verifier-free `admin_issued` step-up session: one-shot consumption, 15m TTL freshness bound,
 *   cleared on session rotation, and NOT granted to `recovery`-redeemed sessions
 * - Real race interposition, D1 `db.batch()` emulation, and audit-failure rollback atomicity
 * - Content-free audit verification
 */
import { afterEach, describe, expect, it } from 'vitest';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { hash } from 'bcrypt';
import { eq } from 'drizzle-orm';
import { createHonoApp } from '../../src/hono-app.js';
import { HonoFoundationRepository } from '../../src/repositories/hono-foundation.repository.js';
import { AuthRecoveryRepository } from '../../src/repositories/auth-recovery.repository.js';
import { communitiesSqlite } from '../../src/db/schema/communities.js';
import { usersSqlite } from '../../src/db/schema/users.js';
import {
  authThrottleSqlite,
  sessionsSqlite,
} from '../../src/db/schema/sessions.js';
import { loginCodesSqlite } from '../../src/db/schema/login_codes.js';
import { auditEntriesSqlite } from '../../src/db/schema/audit_entries.js';
import {
  ADMIN_CODE_STEP_UP_TTL_MS,
  ADMIN_ISSUED_CODE_TTL_MS,
  AUTH_THROTTLE_MAX_FAILURES,
  RAILS_BCRYPT_ALGORITHM,
  RECOVERY_CODE_COUNT,
} from '../../src/shared/auth-policy.js';
import { sha256Hex, toBase64Url, toHex } from '../../src/shared/auth-crypto.js';
import { normalizeSearchText } from '../../src/shared/utils/search-normalize.js';
import { validateContentFreeAuditEntry } from '../../src/shared/utils/audit-entry.js';
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

describe('POST /v2/auth/recovery-codes and GET /v2/auth/me flag (Slice 11b-A)', () => {
  const openDbs: Sqlite.Database[] = [];

  afterEach(() => {
    while (openDbs.length > 0) openDbs.pop()?.close();
  });

  async function setup(options: { serverSecret?: string | undefined } = {}) {
    const sqlite = new Sqlite(':memory:');
    sqlite.pragma('foreign_keys = ON');
    openDbs.push(sqlite);
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: 'src/db/migrations' });

    let currentNow = new Date('2026-06-01T12:00:00.000Z');
    const setNow = (next: Date) => {
      currentNow = next;
    };
    const advanceMs = (ms: number) => {
      currentNow = new Date(currentNow.getTime() + ms);
    };

    const [activeComm] = await db
      .insert(communitiesSqlite)
      .values({
        name: 'Recovery Alpha',
        slug: 'recovery-alpha',
        locale: 'en',
        publicStories: false,
        isActive: true,
        createdAt: currentNow,
        updatedAt: currentNow,
      })
      .returning();
    const [disabledComm] = await db
      .insert(communitiesSqlite)
      .values({
        name: 'Recovery Disabled',
        slug: 'recovery-disabled',
        locale: 'en',
        publicStories: false,
        isActive: false,
        createdAt: currentNow,
        updatedAt: currentNow,
      })
      .returning();

    const adminKey = makeDerivedKey();
    const viewerKey = makeDerivedKey();
    const memberKey = makeDerivedKey();
    const editorKey = makeDerivedKey();
    const disabledAdminKey = makeDerivedKey();
    const superKey = makeDerivedKey();

    const legacySecret = toHex(crypto.getRandomValues(new Uint8Array(12)));
    const wrappedKey = await hash(legacySecret, 10);
    const wrappedVerifier = await sha256Hex(wrappedKey);
    const wrappedSalt = wrappedKey.slice(7, 29);
    const wrappedCost = Number(wrappedKey.slice(4, 6));

    const insertUser = async (input: {
      email: string;
      username: string;
      role: 'viewer' | 'member' | 'editor' | 'admin' | 'super_admin';
      communityId: number | null;
      derivedKey?: string;
    }) => {
      const verifierCols =
        input.derivedKey !== undefined
          ? await argon2Seed(input.derivedKey)
          : {
              passwordHash: await hash(
                toHex(crypto.getRandomValues(new Uint8Array(16))),
                4
              ),
              passwordAlgorithm: null,
              passwordSalt: null,
              passwordParams: null,
              passwordVerifier: null,
            };
      const [row] = await db
        .insert(usersSqlite)
        .values({
          email: input.email,
          username: input.username,
          emailNormalized: normalizeSearchText(input.email),
          usernameNormalized: normalizeSearchText(input.username),
          firstName: input.role,
          lastName: 'User',
          role: input.role,
          communityId: input.communityId,
          isActive: true,
          createdAt: currentNow,
          updatedAt: currentNow,
          ...verifierCols,
        })
        .returning();
      return row!;
    };

    const admin = await insertUser({
      email: 'admin@recovery.example.test',
      username: 'rec_admin',
      role: 'admin',
      communityId: activeComm.id,
      derivedKey: adminKey,
    });
    const viewer = await insertUser({
      email: 'viewer@recovery.example.test',
      username: 'rec_viewer',
      role: 'viewer',
      communityId: activeComm.id,
      derivedKey: viewerKey,
    });
    const member = await insertUser({
      email: 'member@recovery.example.test',
      username: 'rec_member',
      role: 'member',
      communityId: activeComm.id,
      derivedKey: memberKey,
    });
    const editor = await insertUser({
      email: 'editor@recovery.example.test',
      username: 'rec_editor',
      role: 'editor',
      communityId: activeComm.id,
      derivedKey: editorKey,
    });
    const disabledAdmin = await insertUser({
      email: 'dadmin@recovery.example.test',
      username: 'rec_dadmin',
      role: 'admin',
      communityId: disabledComm.id,
      derivedKey: disabledAdminKey,
    });
    const superAdmin = await insertUser({
      email: 'super@recovery.example.test',
      username: 'rec_super',
      role: 'super_admin',
      communityId: null,
      derivedKey: superKey,
    });
    const codeOnlyAdmin = await insertUser({
      email: 'codeonly@recovery.example.test',
      username: 'rec_codeonly',
      role: 'admin',
      communityId: activeComm.id,
    });
    const [wrappedAdmin] = await db
      .insert(usersSqlite)
      .values({
        email: 'wrappedadmin@recovery.example.test',
        username: 'rec_wrapped_admin',
        emailNormalized: normalizeSearchText(
          'wrappedadmin@recovery.example.test'
        ),
        usernameNormalized: normalizeSearchText('rec_wrapped_admin'),
        firstName: 'Wrapped',
        lastName: 'Admin',
        passwordHash: await hash(
          toHex(crypto.getRandomValues(new Uint8Array(16))),
          4
        ),
        passwordAlgorithm: RAILS_BCRYPT_ALGORITHM,
        passwordSalt: wrappedSalt,
        passwordParams: JSON.stringify({ cost: wrappedCost }),
        passwordVerifier: wrappedVerifier,
        role: 'admin',
        communityId: activeComm.id,
        isActive: true,
        createdAt: currentNow,
        updatedAt: currentNow,
      })
      .returning();

    const secret =
      'serverSecret' in options ? options.serverSecret : makeServerSecret();
    const app = createHonoApp({
      repository: new HonoFoundationRepository(db),
      storage: { read: async () => null },
      serverSecret: secret,
      secureCookies: false,
      publicOrigin: API_ORIGIN,
      now: () => currentNow,
    });

    const login = async (
      identifier: string,
      derivedKey: string,
      communitySlug?: string
    ) => {
      const res = await app.request(`${API_ORIGIN}/v2/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          identifier,
          derivedKey,
          ...(communitySlug === undefined ? {} : { communitySlug }),
        }),
      });
      expect(res.status).toBe(200);
      return (res.headers.get('set-cookie') ?? '').split(';')[0]!;
    };

    const insertAdminIssuedCode = async (
      userId: number,
      communityId: number | null
    ) => {
      const rawCode = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
      const codeHash = await sha256Hex(rawCode);
      const createdAt = currentNow.getTime();
      await db.insert(loginCodesSqlite).values({
        communityId,
        userId,
        purpose: 'admin_issued',
        codeHash,
        createdBy: admin.id,
        createdAt,
        expiresAt: createdAt + ADMIN_ISSUED_CODE_TTL_MS,
      });
      return rawCode;
    };

    const redeemCode = async (body: Record<string, unknown>) => {
      const res = await app.request(`${API_ORIGIN}/v2/auth/recovery/redeem`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return {
        status: res.status,
        cookie: (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '',
        json: await res.json(),
      };
    };

    const postRecoveryCodes = (
      cookie: string,
      body: unknown,
      headers: Record<string, string> = {}
    ) =>
      app.request(`${API_ORIGIN}/v2/auth/recovery-codes`, {
        method: 'POST',
        headers: {
          cookie,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
        body:
          body === undefined
            ? undefined
            : typeof body === 'string'
              ? body
              : JSON.stringify(body),
      });

    return {
      sqlite,
      db,
      app,
      secret,
      currentNow: () => currentNow,
      setNow,
      advanceMs,
      activeComm,
      disabledComm,
      admin,
      adminKey,
      viewer,
      viewerKey,
      member,
      memberKey,
      editor,
      editorKey,
      disabledAdmin,
      disabledAdminKey,
      superAdmin,
      superKey,
      codeOnlyAdmin,
      wrappedAdmin: wrappedAdmin!,
      wrappedKey,
      login,
      insertAdminIssuedCode,
      redeemCode,
      postRecoveryCodes,
    };
  }

  it('rejects unauthenticated, non-JSON, malformed, oversized, and unconfigured-secret requests', async () => {
    const { app, admin, adminKey, login, postRecoveryCodes } = await setup();
    const unauth = await app.request(`${API_ORIGIN}/v2/auth/recovery-codes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(unauth.status).toBe(401);

    const cookie = await login(admin.email, adminKey);
    const wrongType = await app.request(
      `${API_ORIGIN}/v2/auth/recovery-codes`,
      {
        method: 'POST',
        headers: { cookie, 'content-type': 'text/plain' },
        body: 'currentDerivedKey=x',
      }
    );
    expect(wrongType.status).toBe(415);

    const rawTextNoHeader = await app.request(
      `${API_ORIGIN}/v2/auth/recovery-codes`,
      {
        method: 'POST',
        headers: { cookie },
        body: 'unexpected-body-without-content-type',
      }
    );
    expect(rawTextNoHeader.status).toBe(415);

    const malformedJson = await postRecoveryCodes(cookie, '{bad');
    expect(malformedJson.status).toBe(400);

    const extraField = await postRecoveryCodes(cookie, {
      currentDerivedKey: adminKey,
      extra: true,
    });
    expect(extraField.status).toBe(400);

    const badKeyShape = await postRecoveryCodes(cookie, {
      currentDerivedKey: 'not-a-derived-key',
    });
    expect(badKeyShape.status).toBe(400);

    const oversized = await postRecoveryCodes(cookie, {
      currentDerivedKey: 'a'.repeat(5000),
    });
    expect(oversized.status).toBe(413);

    // Missing serverSecret fails closed with 503.
    const noSecret = await setup({ serverSecret: undefined });
    const rawSess = toHex(crypto.getRandomValues(new Uint8Array(32)));
    const tokenHash = await sha256Hex(rawSess);
    const nowMs = noSecret.currentNow().getTime();
    await noSecret.db.insert(sessionsSqlite).values({
      id: tokenHash,
      tokenHash,
      userId: noSecret.admin.id,
      expiresAt: nowMs + 3600_000,
      kind: 'standard',
      createdAt: nowMs,
      lastSeenAt: nowMs,
      idleExpiresAt: nowMs + 3600_000,
      absoluteExpiresAt: nowMs + 86400_000,
    });
    const unconfigured = await noSecret.postRecoveryCodes(
      `ts_session=${rawSess}`,
      { currentDerivedKey: noSecret.adminKey }
    );
    expect(unconfigured.status).toBe(503);
  });

  it('rejects viewer, member, and editor with 403 and allows admin, disabled admin, and super_admin', async () => {
    const {
      admin,
      adminKey,
      viewer,
      viewerKey,
      member,
      memberKey,
      editor,
      editorKey,
      disabledAdmin,
      disabledAdminKey,
      superAdmin,
      superKey,
      login,
      postRecoveryCodes,
    } = await setup();

    for (const [account, key] of [
      [viewer, viewerKey],
      [member, memberKey],
      [editor, editorKey],
    ] as const) {
      const cookie = await login(account.email, key);
      const res = await postRecoveryCodes(cookie, { currentDerivedKey: key });
      expect(res.status).toBe(403);
    }

    for (const [account, key] of [
      [admin, adminKey],
      [disabledAdmin, disabledAdminKey],
      [superAdmin, superKey],
    ] as const) {
      const cookie = await login(account.email, key);
      const res = await postRecoveryCodes(cookie, { currentDerivedKey: key });
      expect(res.status).toBe(201);
      const parsed = RecoveryCodesResponseSchema.safeParse(await res.json());
      expect(parsed.success).toBe(true);
    }
  });

  it('generates 10 >=100-bit codes stored only as SHA-256 hashes, supports regeneration, and updates GET /v2/auth/me flag', async () => {
    const {
      db,
      app,
      admin,
      adminKey,
      login,
      insertAdminIssuedCode,
      postRecoveryCodes,
      redeemCode,
    } = await setup();

    const cookie = await login(admin.email, adminKey);
    const meBefore = await app.request(`${API_ORIGIN}/v2/auth/me`, {
      headers: { cookie },
    });
    expect(meBefore.status).toBe(200);
    expect(
      ((await meBefore.json()) as { user: { recoveryCodesConfirmed: boolean } })
        .user.recoveryCodesConfirmed
    ).toBe(false);

    // An outstanding admin_issued code must NOT flip recoveryCodesConfirmed or
    // be touched when recovery codes are regenerated.
    const adminIssuedRaw = await insertAdminIssuedCode(
      admin.id,
      admin.communityId
    );
    const adminIssuedHash = await sha256Hex(adminIssuedRaw);

    const meWithAdminCode = await app.request(`${API_ORIGIN}/v2/auth/me`, {
      headers: { cookie },
    });
    expect(
      (
        (await meWithAdminCode.json()) as {
          user: { recoveryCodesConfirmed: boolean };
        }
      ).user.recoveryCodesConfirmed
    ).toBe(false);

    const firstRes = await postRecoveryCodes(cookie, {
      currentDerivedKey: adminKey,
    });
    expect(firstRes.status).toBe(201);
    const firstText = await firstRes.text();
    const firstJson = JSON.parse(firstText) as {
      data: { codes: string[]; purpose: string; createdAt: string };
    };
    expect(firstJson.data.purpose).toBe('recovery');
    expect(firstJson.data.codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(new Set(firstJson.data.codes).size).toBe(RECOVERY_CODE_COUNT);
    for (const code of firstJson.data.codes) {
      expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
      const normalized = code.replaceAll('-', '+').replaceAll('_', '/');
      expect(Buffer.from(normalized, 'base64').length).toBeGreaterThanOrEqual(
        16
      );
      expect(firstText.split(code).length - 1).toBe(1);
    }

    const storedRows = await db
      .select()
      .from(loginCodesSqlite)
      .where(eq(loginCodesSqlite.userId, admin.id));
    const recoveryRows = storedRows.filter((r) => r.purpose === 'recovery');
    expect(recoveryRows).toHaveLength(RECOVERY_CODE_COUNT);
    for (const row of recoveryRows) {
      expect(row.codeHash).toMatch(/^[a-f0-9]{64}$/);
      expect(row.expiresAt).toBeNull();
      expect(row.usedAt).toBeNull();
      expect(row.supersededAt).toBeNull();
      expect(row.createdBy).toBe(admin.id);
      expect(row.communityId).toBe(admin.communityId);
    }

    const meAfterGen = await app.request(`${API_ORIGIN}/v2/auth/me`, {
      headers: { cookie },
    });
    expect(
      (
        (await meAfterGen.json()) as {
          user: { recoveryCodesConfirmed: boolean };
        }
      ).user.recoveryCodesConfirmed
    ).toBe(true);

    // Redeem 1 recovery code (leaves 9 active -> recoveryCodesConfirmed stays true).
    const nextKey = makeDerivedKey();
    const redeemedOne = await redeemCode({
      code: firstJson.data.codes[0]!,
      password: {
        algorithm: 'client-argon2id+sha256',
        salt: makeVerifierSalt(),
        params: { memoryKiB: 19 * 1024, iterations: 2, parallelism: 1 },
        derivedKey: nextKey,
      },
    });
    expect(redeemedOne.status).toBe(200);

    const meAfterOneRedeem = await app.request(`${API_ORIGIN}/v2/auth/me`, {
      headers: { cookie: redeemedOne.cookie },
    });
    expect(
      (
        (await meAfterOneRedeem.json()) as {
          user: { recoveryCodesConfirmed: boolean };
        }
      ).user.recoveryCodesConfirmed
    ).toBe(true);

    // Regenerate with new password: supersedes remaining 9 unused recovery
    // codes, leaves the 1 already-used code untouched, leaves admin_issued
    // untouched, and inserts 10 new active codes.
    const regenRes = await postRecoveryCodes(redeemedOne.cookie, {
      currentDerivedKey: nextKey,
    });
    expect(regenRes.status).toBe(201);
    const regenJson = (await regenRes.json()) as {
      data: { codes: string[] };
    };
    expect(regenJson.data.codes).toHaveLength(RECOVERY_CODE_COUNT);

    const afterRegen = await db
      .select()
      .from(loginCodesSqlite)
      .where(eq(loginCodesSqlite.userId, admin.id));
    const adminCodeRow = afterRegen.find((r) => r.codeHash === adminIssuedHash);
    expect(adminCodeRow?.supersededAt).toBeNull();

    const firstCodeHash = await sha256Hex(firstJson.data.codes[0]!);
    const consumedFirst = afterRegen.find((r) => r.codeHash === firstCodeHash);
    expect(consumedFirst?.usedAt).not.toBeNull();
    expect(consumedFirst?.supersededAt).toBeNull();

    const secondCodeHash = await sha256Hex(firstJson.data.codes[1]!);
    const supersededSecond = afterRegen.find(
      (r) => r.codeHash === secondCodeHash
    );
    expect(supersededSecond?.usedAt).toBeNull();
    expect(supersededSecond?.supersededAt).not.toBeNull();

    // Consume all 10 regenerated codes -> recoveryCodesConfirmed becomes false.
    let activeCookie = redeemedOne.cookie;
    let activeKey = nextKey;
    for (const code of regenJson.data.codes) {
      activeKey = makeDerivedKey();
      const res = await redeemCode({
        code,
        password: {
          algorithm: 'client-argon2id+sha256',
          salt: makeVerifierSalt(),
          params: { memoryKiB: 19 * 1024, iterations: 2, parallelism: 1 },
          derivedKey: activeKey,
        },
      });
      expect(res.status).toBe(200);
      activeCookie = res.cookie;
    }
    const meExhausted = await app.request(`${API_ORIGIN}/v2/auth/me`, {
      headers: { cookie: activeCookie },
    });
    expect(
      (
        (await meExhausted.json()) as {
          user: { recoveryCodesConfirmed: boolean };
        }
      ).user.recoveryCodesConfirmed
    ).toBe(false);
  });

  it('requires current password re-verification on password sessions (incl. wrapped Rails bcrypt) and throttles wrong keys', async () => {
    const {
      db,
      admin,
      adminKey,
      wrappedAdmin,
      wrappedKey,
      currentNow,
      login,
      postRecoveryCodes,
    } = await setup();

    // Wrapped Rails bcrypt admin step-up works directly with wrapped key.
    const nowMs = currentNow().getTime();
    const wTok = toHex(crypto.getRandomValues(new Uint8Array(32)));
    const wHash = await sha256Hex(wTok);
    await db.insert(sessionsSqlite).values({
      id: wHash,
      tokenHash: wHash,
      userId: wrappedAdmin.id,
      expiresAt: nowMs + 3600_000,
      kind: 'standard',
      createdAt: nowMs,
      lastSeenAt: nowMs,
      idleExpiresAt: nowMs + 3600_000,
      absoluteExpiresAt: nowMs + 86400_000,
    });
    const wrappedStepUp = await postRecoveryCodes(`ts_session=${wTok}`, {
      currentDerivedKey: wrappedKey,
    });
    expect(wrappedStepUp.status).toBe(201);

    const adminCookie = await login(admin.email, adminKey);
    const missingKey = await postRecoveryCodes(adminCookie, {});
    expect(missingKey.status).toBe(401);
    expect(await missingKey.json()).toEqual({ error: 'Invalid credentials' });

    const missingBody = await postRecoveryCodes(adminCookie, undefined);
    expect(missingBody.status).toBe(401);

    // 10 wrong current keys throttle the account: 11th attempt with the RIGHT
    // key is still refused uniformly.
    for (let i = 0; i < AUTH_THROTTLE_MAX_FAILURES; i += 1) {
      const bad = await postRecoveryCodes(adminCookie, {
        currentDerivedKey: makeDerivedKey(),
      });
      expect(bad.status).toBe(401);
    }
    const throttledRight = await postRecoveryCodes(adminCookie, {
      currentDerivedKey: adminKey,
    });
    expect(throttledRight.status).toBe(401);
  });

  it('refuses password step-up when the client address is throttled by another auth endpoint', async () => {
    const { app, db, admin, adminKey, login, postRecoveryCodes } =
      await setup();
    const adminCookie = await login(admin.email, adminKey);

    // Ten unresolved login attempts from the same client address feed ONLY the
    // per-IP counter (§6.8, §7 step 6), leaving the admin's account bucket clean.
    for (let i = 0; i < AUTH_THROTTLE_MAX_FAILURES; i += 1) {
      const bad = await app.request(`${API_ORIGIN}/v2/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          identifier: `unresolved-${i}@throttled.example.test`,
          derivedKey: makeDerivedKey(),
        }),
      });
      expect(bad.status).toBe(401);
    }
    const throttleRows = await db.select().from(authThrottleSqlite);
    expect(throttleRows.filter((row) => row.kind === 'account')).toHaveLength(
      0
    );
    const ipRow = throttleRows.find((row) => row.kind === 'ip');
    expect(ipRow?.blockedUntil).not.toBeNull();

    // The correct step-up key must still be refused: the address is blocked.
    const blocked = await postRecoveryCodes(adminCookie, {
      currentDerivedKey: adminKey,
    });
    expect(blocked.status).toBe(401);
    expect(await blocked.json()).toEqual({ error: 'Invalid credentials' });
    expect(
      await db
        .select()
        .from(loginCodesSqlite)
        .where(eq(loginCodesSqlite.userId, admin.id))
    ).toHaveLength(0);
  });

  it('grants verifier-free step-up ONLY on fresh admin_issued sessions (one-shot, 15m TTL, cleared on rotation)', async () => {
    const {
      admin,
      adminKey,
      codeOnlyAdmin,
      login,
      advanceMs,
      insertAdminIssuedCode,
      redeemCode,
      postRecoveryCodes,
    } = await setup();

    // 1. Code-only admin redeems admin_issued code -> generates verifier-free once.
    const rawCode1 = await insertAdminIssuedCode(
      codeOnlyAdmin.id,
      codeOnlyAdmin.communityId
    );
    const redeemed1 = await redeemCode({ code: rawCode1 });
    expect(redeemed1.status).toBe(200);

    // Empty body (no Content-Type) works for verifier-free step-up.
    const gen1 = await postRecoveryCodes(redeemed1.cookie, undefined);
    expect(gen1.status).toBe(201);
    const gen1Json = (await gen1.json()) as { data: { codes: string[] } };
    expect(gen1Json.data.codes).toHaveLength(RECOVERY_CODE_COUNT);

    // One-shot: immediate second verifier-free call on the same session fails 401.
    const genAgain = await postRecoveryCodes(redeemed1.cookie, {});
    expect(genAgain.status).toBe(401);

    // 2. Freshness bound: advancing past 15m TTL expires the verifier-free right
    // while the 12h session itself stays valid.
    const rawCode2 = await insertAdminIssuedCode(
      codeOnlyAdmin.id,
      codeOnlyAdmin.communityId
    );
    const redeemed2 = await redeemCode({ code: rawCode2 });
    expect(redeemed2.status).toBe(200);
    advanceMs(ADMIN_CODE_STEP_UP_TTL_MS + 1);
    const expiredStepUp = await postRecoveryCodes(redeemed2.cookie, {});
    expect(expiredStepUp.status).toBe(401);

    // 3. Session rotation via password login clears any admin_issued step-up right.
    const s = await setup();
    const c = await s.insertAdminIssuedCode(s.admin.id, s.admin.communityId);
    const r = await s.redeemCode({ code: c });
    expect(r.status).toBe(200);
    const rotRes = await s.app.request(`${API_ORIGIN}/v2/auth/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: r.cookie,
      },
      body: JSON.stringify({
        identifier: s.admin.email,
        derivedKey: s.adminKey,
      }),
    });
    expect(rotRes.status).toBe(200);
    const rotCookie = (rotRes.headers.get('set-cookie') ?? '').split(';')[0]!;
    const postRot = await s.postRecoveryCodes(rotCookie, {});
    expect(postRot.status).toBe(401);

    // 4. A session created by redeeming a `recovery` code is NEVER verifier-free.
    const newPassword = makeDerivedKey();
    const recSession = await redeemCode({
      code: gen1Json.data.codes[0]!,
      password: {
        algorithm: 'client-argon2id+sha256',
        salt: makeVerifierSalt(),
        params: { memoryKiB: 19 * 1024, iterations: 2, parallelism: 1 },
        derivedKey: newPassword,
      },
    });
    expect(recSession.status).toBe(200);
    const noKeyAfterRecovery = await postRecoveryCodes(recSession.cookie, {});
    expect(noKeyAfterRecovery.status).toBe(401);
    const withKeyAfterRecovery = await postRecoveryCodes(recSession.cookie, {
      currentDerivedKey: newPassword,
    });
    expect(withKeyAfterRecovery.status).toBe(201);
  });

  it('handles D1 batch emulation, real concurrency races, and audit-failure rollback atomically', async () => {
    // 1. D1 batch emulation: both password & verifier-free paths, plus lost step-up race.
    const d1Ctx = await setup();
    installD1BatchEmulation(d1Ctx.db);
    const d1Cookie = await d1Ctx.login(d1Ctx.admin.email, d1Ctx.adminKey);
    const d1Gen = await d1Ctx.postRecoveryCodes(d1Cookie, {
      currentDerivedKey: d1Ctx.adminKey,
    });
    expect(d1Gen.status).toBe(201);
    const d1Regen = await d1Ctx.postRecoveryCodes(d1Cookie, {
      currentDerivedKey: d1Ctx.adminKey,
    });
    expect(d1Regen.status).toBe(201);

    const d1Code = await d1Ctx.insertAdminIssuedCode(
      d1Ctx.codeOnlyAdmin.id,
      d1Ctx.codeOnlyAdmin.communityId
    );
    const d1Redeem = await d1Ctx.redeemCode({ code: d1Code });
    expect(d1Redeem.status).toBe(200);
    const d1First = await d1Ctx.postRecoveryCodes(d1Redeem.cookie, {});
    expect(d1First.status).toBe(201);
    const d1Second = await d1Ctx.postRecoveryCodes(d1Redeem.cookie, {});
    expect(d1Second.status).toBe(401);

    // 2. Real race interposition (HTTP end-to-end): a concurrent request
    //    consumes the session's step-up right between middleware/read and write.
    const raceCtx = await setup();
    const raceCode = await raceCtx.insertAdminIssuedCode(
      raceCtx.codeOnlyAdmin.id,
      raceCtx.codeOnlyAdmin.communityId
    );
    const raceSession = await raceCtx.redeemCode({ code: raceCode });
    expect(raceSession.status).toBe(200);
    let intercepted = 0;
    const raceProxy = new Proxy(
      raceCtx.db as unknown as Record<string, unknown>,
      {
        get(target, prop) {
          if (prop === 'transaction') {
            return (...args: unknown[]) => {
              intercepted += 1;
              raceCtx.sqlite
                .prepare(
                  'UPDATE sessions SET admin_code_step_up_expires_at = NULL WHERE user_id = ?'
                )
                .run(raceCtx.codeOnlyAdmin.id);
              const realTx = Reflect.get(target, prop) as (
                ...txArgs: unknown[]
              ) => unknown;
              return realTx.apply(target, args);
            };
          }
          return Reflect.get(target, prop);
        },
      }
    ) as unknown as ReturnType<typeof drizzle>;
    const raceApp = createHonoApp({
      repository: new HonoFoundationRepository(raceProxy),
      storage: { read: async () => null },
      serverSecret: raceCtx.secret,
      secureCookies: false,
      publicOrigin: API_ORIGIN,
      now: () => raceCtx.currentNow(),
    });
    const lostStepUpRes = await raceApp.request(
      `${API_ORIGIN}/v2/auth/recovery-codes`,
      {
        method: 'POST',
        headers: { cookie: raceSession.cookie },
      }
    );
    expect(intercepted).toBe(1);
    expect(lostStepUpRes.status).toBe(401);
    expect(
      await raceCtx.db
        .select()
        .from(loginCodesSqlite)
        .where(eq(loginCodesSqlite.userId, raceCtx.codeOnlyAdmin.id))
    ).toHaveLength(1); // Only the initial consumed admin_issued row; 0 recovery rows.

    // Also test concurrent password verifier replacement race -> 409.
    const pwRaceRepo = new AuthRecoveryRepository(raceCtx.db);
    const lostPwOutcome = await pwRaceRepo.generateRecoveryCodesAtomically(
      {
        actor: {
          id: raceCtx.admin.id,
          communityId: raceCtx.admin.communityId,
          role: 'admin',
        },
        codeHashes: Array.from({ length: 10 }, (_, i) =>
          `${i}`.repeat(64).slice(0, 64)
        ),
        nowMs: raceCtx.currentNow().getTime(),
        stepUp: {
          mode: 'password',
          passwordHash: raceCtx.admin.passwordHash,
          expectedVerifier: 'stale-verifier-lost-race',
        },
      },
      {
        communityId: raceCtx.admin.communityId,
        actorId: raceCtx.admin.id,
        action: 'auth.recovery_codes.generate',
        resourceType: 'recovery_codes',
        resourceIds: [raceCtx.admin.id],
        outcome: 'success',
        ipAddress: '203.0.113.10',
        userAgent: 'RaceTest/1.0',
      }
    );
    expect(lostPwOutcome).toBe('authority_lost');
    expect(
      await raceCtx.db
        .select()
        .from(loginCodesSqlite)
        .where(eq(loginCodesSqlite.userId, raceCtx.admin.id))
    ).toHaveLength(0);

    // 3. Audit-failure rollback atomicity: DROP TABLE audit_entries rolls back
    // generation completely (no new codes, old codes not superseded, step-up kept).
    const brokenCtx = await setup();
    const brokenAdminCookie = await brokenCtx.login(
      brokenCtx.admin.email,
      brokenCtx.adminKey
    );
    const firstValid = await brokenCtx.postRecoveryCodes(brokenAdminCookie, {
      currentDerivedKey: brokenCtx.adminKey,
    });
    expect(firstValid.status).toBe(201);
    const adminIssuedForBroken = await brokenCtx.insertAdminIssuedCode(
      brokenCtx.codeOnlyAdmin.id,
      brokenCtx.codeOnlyAdmin.communityId
    );
    const brokenStepUp = await brokenCtx.redeemCode({
      code: adminIssuedForBroken,
    });
    expect(brokenStepUp.status).toBe(200);

    brokenCtx.sqlite.exec('DROP TABLE audit_entries');

    const failPasswordGen = await brokenCtx.postRecoveryCodes(
      brokenAdminCookie,
      { currentDerivedKey: brokenCtx.adminKey }
    );
    expect(failPasswordGen.status).toBe(503);
    const adminCodesAfterBroken = await brokenCtx.db
      .select()
      .from(loginCodesSqlite)
      .where(eq(loginCodesSqlite.userId, brokenCtx.admin.id));
    expect(adminCodesAfterBroken).toHaveLength(10);
    expect(
      adminCodesAfterBroken.every((row) => row.supersededAt === null)
    ).toBe(true);

    const failStepUpGen = await brokenCtx.postRecoveryCodes(
      brokenStepUp.cookie,
      {}
    );
    expect(failStepUpGen.status).toBe(503);
    const [stepUpSession] = await brokenCtx.db
      .select()
      .from(sessionsSqlite)
      .where(eq(sessionsSqlite.userId, brokenCtx.codeOnlyAdmin.id));
    expect(stepUpSession?.adminCodeStepUpExpiresAt).not.toBeNull();
  });

  it('emits strictly content-free audit entries with zero secret/code/identifier leakage', async () => {
    const { db, admin, adminKey, login, postRecoveryCodes } = await setup();
    const cookie = await login(admin.email, adminKey);
    const badRes = await postRecoveryCodes(cookie, {
      currentDerivedKey: makeDerivedKey(),
    });
    expect(badRes.status).toBe(401);

    const okRes = await postRecoveryCodes(cookie, {
      currentDerivedKey: adminKey,
    });
    expect(okRes.status).toBe(201);
    const codes = ((await okRes.json()) as { data: { codes: string[] } }).data
      .codes;

    const entries = await db
      .select()
      .from(auditEntriesSqlite)
      .where(eq(auditEntriesSqlite.action, 'auth.recovery_codes.generate'));
    expect(entries.length).toBe(2);
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain(adminKey);
    expect(serialized).not.toContain(admin.email);
    expect(serialized).not.toContain(admin.username ?? '');
    for (const code of codes) {
      expect(serialized).not.toContain(code);
      expect(serialized).not.toContain(await sha256Hex(code));
    }
    for (const entry of entries) {
      const validated = validateContentFreeAuditEntry({
        communityId: entry.communityId,
        actorId: entry.actorId,
        action: entry.action,
        resourceType: entry.resourceType,
        resourceIds: entry.resourceIds,
        outcome: entry.outcome,
        ipAddress: entry.ipAddress,
        userAgent: entry.userAgent,
      });
      expect(validated.resourceType).toBe('recovery_codes');
    }
  });
});
