/**
 * Focused tests for POST /v2/auth/recovery/redeem (Slice 11b-A, #188;
 * SPEC-V2 §6.8, §6.10, §7, §12).
 *
 * Covers:
 * - Wire validation (415, 400 malformed/extra/below-policy verifier, 413, 503)
 * - Recovery-code redemption (requires password, revokes prior sessions, atomic verifier update, replay/superseded/unknown -> uniform 401)
 * - Admin-issued code redemption (password optional, expiry enforced, code-only sole-admin lifecycle, migrated Rails admin lifecycle)
 * - Null-community super_admin redemption (without slug -> 200; with any slug -> 401)
 * - Optional communitySlug & identifier disambiguation/mismatch checks
 * - Authority & disabled-community gates (disabled admin -> 200; disabled member/inactive user -> 401 without consuming code)
 * - Shared-browser cross-user redemption revoking presented session on success only
 * - AuthThrottle per-IP and per-account backoff and reset on success
 * - Real race interposition, D1 `db.batch()` emulation (incl. same-ms double-redeem), and audit-failure rollback atomicity
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
import { sessionsSqlite } from '../../src/db/schema/sessions.js';
import { loginCodesSqlite } from '../../src/db/schema/login_codes.js';
import { auditEntriesSqlite } from '../../src/db/schema/audit_entries.js';
import {
  ADMIN_ISSUED_CODE_TTL_MS,
  ARGON2ID_ALGORITHM,
  ARGON2ID_PARAMS,
  AUTH_THROTTLE_MAX_FAILURES,
  DEVICE_SESSION_ABSOLUTE_MS,
  RAILS_BCRYPT_ALGORITHM,
} from '../../src/shared/auth-policy.js';
import { sha256Hex, toBase64Url, toHex } from '../../src/shared/auth-crypto.js';
import { normalizeSearchText } from '../../src/shared/utils/search-normalize.js';
import { validateContentFreeAuditEntry } from '../../src/shared/utils/audit-entry.js';
import {
  argon2Seed,
  makeDerivedKey,
  makeServerSecret,
  makeVerifierSalt,
} from './auth-test-utils.js';

const API_ORIGIN = 'https://api.example.test';

const validPasswordPayload = (derivedKey: string = makeDerivedKey()) => ({
  algorithm: ARGON2ID_ALGORITHM,
  salt: makeVerifierSalt(),
  params: { ...ARGON2ID_PARAMS },
  derivedKey,
});

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

describe('POST /v2/auth/recovery/redeem (Slice 11b-A)', () => {
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
    const advanceMs = (ms: number) => {
      currentNow = new Date(currentNow.getTime() + ms);
    };

    const [alpha] = await db
      .insert(communitiesSqlite)
      .values({
        name: 'Redeem Alpha',
        slug: 'redeem-alpha',
        locale: 'en',
        publicStories: false,
        isActive: true,
        createdAt: currentNow,
        updatedAt: currentNow,
      })
      .returning();
    const [beta] = await db
      .insert(communitiesSqlite)
      .values({
        name: 'Redeem Beta',
        slug: 'redeem-beta',
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
        name: 'Redeem Disabled',
        slug: 'redeem-disabled',
        locale: 'en',
        publicStories: false,
        isActive: false,
        createdAt: currentNow,
        updatedAt: currentNow,
      })
      .returning();

    const adminKey = makeDerivedKey();
    const betaUserKey = makeDerivedKey();
    const disabledAdminKey = makeDerivedKey();
    const superKey = makeDerivedKey();

    const insertUser = async (input: {
      email: string;
      username: string;
      role: 'viewer' | 'member' | 'editor' | 'admin' | 'super_admin';
      communityId: number | null;
      derivedKey?: string;
      isActive?: boolean;
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
          lastName: 'Redeem',
          role: input.role,
          communityId: input.communityId,
          isActive: input.isActive ?? true,
          createdAt: currentNow,
          updatedAt: currentNow,
          ...verifierCols,
        })
        .returning();
      return row!;
    };

    const admin = await insertUser({
      email: 'admin@redeem.example.test',
      username: 'red_admin',
      role: 'admin',
      communityId: alpha.id,
      derivedKey: adminKey,
    });
    const betaUser = await insertUser({
      email: 'member@redeem.example.test',
      username: 'red_beta_member',
      role: 'member',
      communityId: beta.id,
      derivedKey: betaUserKey,
    });
    const codeOnlyAdmin = await insertUser({
      email: 'codeonly@redeem.example.test',
      username: 'red_codeonly',
      role: 'admin',
      communityId: alpha.id,
    });
    const inactiveUser = await insertUser({
      email: 'inactive@redeem.example.test',
      username: 'red_inactive',
      role: 'admin',
      communityId: alpha.id,
      derivedKey: makeDerivedKey(),
      isActive: false,
    });
    const disabledAdmin = await insertUser({
      email: 'dadmin@redeem.example.test',
      username: 'red_dadmin',
      role: 'admin',
      communityId: disabledComm.id,
      derivedKey: disabledAdminKey,
    });
    const disabledMember = await insertUser({
      email: 'dmember@redeem.example.test',
      username: 'red_dmember',
      role: 'member',
      communityId: disabledComm.id,
      derivedKey: makeDerivedKey(),
    });
    const superAdmin = await insertUser({
      email: 'super@redeem.example.test',
      username: 'red_super',
      role: 'super_admin',
      communityId: null,
      derivedKey: superKey,
    });

    const secret =
      'serverSecret' in options ? options.serverSecret : makeServerSecret();
    const app = createHonoApp({
      repository: new HonoFoundationRepository(db),
      storage: { read: async () => null },
      serverSecret: secret,
      secureCookies: false,
      publicOrigin: API_ORIGIN,
      trustProxy: true,
      now: () => currentNow,
    });

    const insertCode = async (input: {
      userId: number;
      communityId: number | null;
      purpose: 'admin_issued' | 'recovery';
      ttlMs?: number;
    }) => {
      const code = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
      const codeHash = await sha256Hex(code);
      const createdAt = currentNow.getTime();
      await db.insert(loginCodesSqlite).values({
        userId: input.userId,
        communityId: input.communityId,
        purpose: input.purpose,
        codeHash,
        createdBy: admin.id,
        createdAt,
        expiresAt:
          input.purpose === 'admin_issued'
            ? createdAt + (input.ttlMs ?? ADMIN_ISSUED_CODE_TTL_MS)
            : null,
      });
      return { code, codeHash };
    };

    const redeem = (
      body: unknown,
      headers: Record<string, string> = {}
    ): Promise<Response> =>
      app.request(`${API_ORIGIN}/v2/auth/recovery/redeem`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
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

    return {
      sqlite,
      db,
      app,
      secret,
      currentNow: () => currentNow,
      advanceMs,
      alpha,
      beta,
      disabledComm,
      admin,
      adminKey,
      betaUser,
      betaUserKey,
      codeOnlyAdmin,
      inactiveUser,
      disabledAdmin,
      disabledAdminKey,
      disabledMember,
      superAdmin,
      superKey,
      insertCode,
      redeem,
      login,
    };
  }

  it('rejects non-JSON, malformed, below-policy verifier, oversized, and unconfigured-secret requests', async () => {
    const { app, redeem, insertCode, admin } = await setup();
    const { code } = await insertCode({
      userId: admin.id,
      communityId: admin.communityId,
      purpose: 'recovery',
    });

    const wrongType = await app.request(
      `${API_ORIGIN}/v2/auth/recovery/redeem`,
      {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: `code=${code}`,
      }
    );
    expect(wrongType.status).toBe(415);

    const malformed = await redeem('{bad');
    expect(malformed.status).toBe(400);

    const extraField = await redeem({ code, extra: true });
    expect(extraField.status).toBe(400);

    const emptyCode = await redeem({ code: '' });
    expect(emptyCode.status).toBe(400);

    const oversized = await redeem({ code: 'x'.repeat(5000) });
    expect(oversized.status).toBe(413);

    // Below-policy params rejected with 400 BEFORE consuming the code.
    const weakParams = await redeem({
      code,
      password: {
        algorithm: ARGON2ID_ALGORITHM,
        salt: makeVerifierSalt(),
        params: { memoryKiB: 1024, iterations: 1, parallelism: 1 },
        derivedKey: makeDerivedKey(),
      },
    });
    expect(weakParams.status).toBe(400);

    const weakSalt = await redeem({
      code,
      password: {
        algorithm: ARGON2ID_ALGORITHM,
        salt: 'c2FsdA==',
        params: { ...ARGON2ID_PARAMS },
        derivedKey: makeDerivedKey(),
      },
    });
    expect(weakSalt.status).toBe(400);

    // Unconfigured serverSecret returns 503.
    const noSecret = await setup({ serverSecret: undefined });
    const noSecretCode = await noSecret.insertCode({
      userId: noSecret.admin.id,
      communityId: noSecret.admin.communityId,
      purpose: 'admin_issued',
    });
    expect((await noSecret.redeem({ code: noSecretCode.code })).status).toBe(
      503
    );
  });

  it('redeems a recovery code with mandatory new password, revokes prior sessions, and blocks replay/superseded/unknown codes', async () => {
    const { db, app, admin, adminKey, login, insertCode, redeem } =
      await setup();

    const oldCookieA = await login(admin.email, adminKey);
    const oldCookieB = await login(admin.email, adminKey);

    const { code, codeHash } = await insertCode({
      userId: admin.id,
      communityId: admin.communityId,
      purpose: 'recovery',
    });

    // Omitting password on a recovery code fails uniformly and does NOT consume the code.
    const withoutPassword = await redeem({ code });
    expect(withoutPassword.status).toBe(401);
    expect(await withoutPassword.json()).toEqual({
      error: 'Invalid credentials',
    });
    const [notConsumed] = await db
      .select()
      .from(loginCodesSqlite)
      .where(eq(loginCodesSqlite.codeHash, codeHash));
    expect(notConsumed?.usedAt).toBeNull();

    // Valid recovery redemption with deviceSession sets new verifier, revokes old sessions,
    // and issues a live 60-day device session.
    const newKey = makeDerivedKey();
    const okRes = await redeem({
      code,
      password: validPasswordPayload(newKey),
      deviceSession: true,
    });
    expect(okRes.status).toBe(200);
    const setCookie = okRes.headers.get('set-cookie') ?? '';
    const newCookie = setCookie.split(';')[0]!;
    expect(newCookie).toContain('ts_session=');
    expect(setCookie).toContain(`Max-Age=${DEVICE_SESSION_ABSOLUTE_MS / 1000}`);

    // Old sessions are revoked; new session works.
    expect(
      (
        await app.request(`${API_ORIGIN}/v2/auth/me`, {
          headers: { cookie: oldCookieA },
        })
      ).status
    ).toBe(401);
    expect(
      (
        await app.request(`${API_ORIGIN}/v2/auth/me`, {
          headers: { cookie: oldCookieB },
        })
      ).status
    ).toBe(401);
    expect(
      (
        await app.request(`${API_ORIGIN}/v2/auth/me`, {
          headers: { cookie: newCookie },
        })
      ).status
    ).toBe(200);

    // Old password rejected; new password logs in.
    const oldLogin = await app.request(`${API_ORIGIN}/v2/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: admin.email, derivedKey: adminKey }),
    });
    expect(oldLogin.status).toBe(401);
    const newCookie2 = await login(admin.email, newKey);
    expect(newCookie2).toContain('ts_session=');

    // Replay of used code fails uniformly.
    const replay = await redeem({
      code,
      password: validPasswordPayload(),
    });
    expect(replay.status).toBe(401);
    expect(await replay.json()).toEqual({ error: 'Invalid credentials' });

    // Unknown and superseded codes return identical 401.
    const unknown = await redeem({
      code: 'nonexistent-code-value-0000',
      password: validPasswordPayload(),
    });
    expect(unknown.status).toBe(401);
    expect(await unknown.json()).toEqual({ error: 'Invalid credentials' });

    const { code: supCode, codeHash: supHash } = await insertCode({
      userId: admin.id,
      communityId: admin.communityId,
      purpose: 'recovery',
    });
    await db
      .update(loginCodesSqlite)
      .set({ supersededAt: Date.now() })
      .where(eq(loginCodesSqlite.codeHash, supHash));
    const supRes = await redeem({
      code: supCode,
      password: validPasswordPayload(),
    });
    expect(supRes.status).toBe(401);
  });

  it('supports code-only sole-admin enrollment + recovery and migrated Rails admin first-login recovery lifecycle', async () => {
    const {
      db,
      app,
      alpha,
      codeOnlyAdmin,
      insertCode,
      redeem,
      login,
      advanceMs,
    } = await setup();

    // 1. Code-only sole admin lifecycle:
    //    admin_issued code without password -> verifier-free recovery-code generation ->
    //    recovery code redemption setting a password -> normal login.
    const expiredAdminCode = await insertCode({
      userId: codeOnlyAdmin.id,
      communityId: alpha.id,
      purpose: 'admin_issued',
      ttlMs: 1000,
    });
    advanceMs(2000);
    expect((await redeem({ code: expiredAdminCode.code })).status).toBe(401);

    const freshAdminCode = await insertCode({
      userId: codeOnlyAdmin.id,
      communityId: alpha.id,
      purpose: 'admin_issued',
    });
    const enrolled = await redeem({ code: freshAdminCode.code });
    expect(enrolled.status).toBe(200);
    const enrolledCookie = (enrolled.headers.get('set-cookie') ?? '').split(
      ';'
    )[0]!;

    const genSheet = await app.request(`${API_ORIGIN}/v2/auth/recovery-codes`, {
      method: 'POST',
      headers: { cookie: enrolledCookie },
    });
    expect(genSheet.status).toBe(201);
    const codes = ((await genSheet.json()) as { data: { codes: string[] } })
      .data.codes;

    const chosenKey = makeDerivedKey();
    const recovered = await redeem({
      code: codes[0]!,
      password: validPasswordPayload(chosenKey),
    });
    expect(recovered.status).toBe(200);
    const normalLoginCookie = await login(codeOnlyAdmin.email, chosenKey);
    expect(normalLoginCookie).toContain('ts_session=');

    // 2. Migrated Rails admin lifecycle (§12):
    //    wrapped bcrypt login + upgrade -> GET /v2/auth/me recoveryCodesConfirmed=false ->
    //    generate recovery codes (with current password step-up) -> recoveryCodesConfirmed=true ->
    //    recover with code + new password -> regenerate with new password -> old code rejected.
    const legacySecret = toHex(crypto.getRandomValues(new Uint8Array(12)));
    const wrappedKey = await hash(legacySecret, 10);
    const [migratedAdmin] = await db
      .insert(usersSqlite)
      .values({
        email: 'migrated-admin@redeem.example.test',
        username: 'migrated_admin',
        emailNormalized: normalizeSearchText(
          'migrated-admin@redeem.example.test'
        ),
        usernameNormalized: normalizeSearchText('migrated_admin'),
        firstName: 'Migrated',
        lastName: 'Admin',
        passwordHash: wrappedKey,
        passwordAlgorithm: RAILS_BCRYPT_ALGORITHM,
        passwordSalt: wrappedKey.slice(7, 29),
        passwordParams: JSON.stringify({
          cost: Number(wrappedKey.slice(4, 6)),
        }),
        passwordVerifier: await sha256Hex(wrappedKey),
        role: 'admin',
        communityId: alpha.id,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();

    const upgradedKey = makeDerivedKey();
    const loginRes = await app.request(`${API_ORIGIN}/v2/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        identifier: migratedAdmin!.email,
        derivedKey: wrappedKey,
        upgrade: validPasswordPayload(upgradedKey),
      }),
    });
    expect(loginRes.status).toBe(200);
    const migCookie = (loginRes.headers.get('set-cookie') ?? '').split(';')[0]!;

    const migMeBefore = await app.request(`${API_ORIGIN}/v2/auth/me`, {
      headers: { cookie: migCookie },
    });
    expect(
      (
        (await migMeBefore.json()) as {
          user: { recoveryCodesConfirmed: boolean };
        }
      ).user.recoveryCodesConfirmed
    ).toBe(false);

    const migGen = await app.request(`${API_ORIGIN}/v2/auth/recovery-codes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: migCookie },
      body: JSON.stringify({ currentDerivedKey: upgradedKey }),
    });
    expect(migGen.status).toBe(201);
    const migCodes = ((await migGen.json()) as { data: { codes: string[] } })
      .data.codes;

    const migMeAfter = await app.request(`${API_ORIGIN}/v2/auth/me`, {
      headers: { cookie: migCookie },
    });
    expect(
      (
        (await migMeAfter.json()) as {
          user: { recoveryCodesConfirmed: boolean };
        }
      ).user.recoveryCodesConfirmed
    ).toBe(true);

    const recoveredKey = makeDerivedKey();
    const migRecovered = await redeem({
      code: migCodes[0]!,
      password: validPasswordPayload(recoveredKey),
    });
    expect(migRecovered.status).toBe(200);
    const migRecCookie = (migRecovered.headers.get('set-cookie') ?? '').split(
      ';'
    )[0]!;

    const migRegen = await app.request(`${API_ORIGIN}/v2/auth/recovery-codes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: migRecCookie },
      body: JSON.stringify({ currentDerivedKey: recoveredKey }),
    });
    expect(migRegen.status).toBe(201);

    // Remaining code from first sheet was superseded by regeneration.
    expect(
      (
        await redeem({
          code: migCodes[1]!,
          password: validPasswordPayload(),
        })
      ).status
    ).toBe(401);
  });

  it('enforces communitySlug, identifier, null-community super_admin, disabled/inactive gates, and shared-browser cross-user revocation', async () => {
    const {
      app,
      alpha,
      beta,
      admin,
      betaUser,
      betaUserKey,
      inactiveUser,
      disabledAdmin,
      disabledMember,
      superAdmin,
      insertCode,
      redeem,
      login,
    } = await setup();

    // Super admin recovery code works without slug, fails with any slug.
    const superRec = await insertCode({
      userId: superAdmin.id,
      communityId: null,
      purpose: 'recovery',
    });
    expect(
      (
        await redeem({
          code: superRec.code,
          communitySlug: alpha.slug,
          password: validPasswordPayload(),
        })
      ).status
    ).toBe(401);
    expect(
      (
        await redeem({
          code: superRec.code,
          password: validPasswordPayload(),
        })
      ).status
    ).toBe(200);

    // Community admin code checks communitySlug and identifier.
    const adminCode = await insertCode({
      userId: admin.id,
      communityId: alpha.id,
      purpose: 'admin_issued',
    });
    expect(
      (await redeem({ code: adminCode.code, communitySlug: beta.slug })).status
    ).toBe(401);
    expect(
      (
        await redeem({
          code: adminCode.code,
          communitySlug: 'no-such-slug',
        })
      ).status
    ).toBe(401);
    expect(
      (
        await redeem({
          code: adminCode.code,
          identifier: betaUser.email,
        })
      ).status
    ).toBe(401);
    // Code was not consumed by those mismatches; succeeds with matching slug & identifier.
    const okMatch = await redeem({
      code: adminCode.code,
      identifier: admin.username!,
      communitySlug: alpha.slug,
    });
    expect(okMatch.status).toBe(200);

    // Inactive user & disabled-community non-admin fail without consuming code.
    const inactiveCode = await insertCode({
      userId: inactiveUser.id,
      communityId: alpha.id,
      purpose: 'admin_issued',
    });
    expect((await redeem({ code: inactiveCode.code })).status).toBe(401);

    const disabledMemberCode = await insertCode({
      userId: disabledMember.id,
      communityId: disabledMember.communityId,
      purpose: 'admin_issued',
    });
    expect((await redeem({ code: disabledMemberCode.code })).status).toBe(401);

    // Disabled-community admin CAN redeem an assisted recovery code (§7).
    const disabledAdminCode = await insertCode({
      userId: disabledAdmin.id,
      communityId: disabledAdmin.communityId,
      purpose: 'admin_issued',
    });
    expect((await redeem({ code: disabledAdminCode.code })).status).toBe(200);

    // Shared-browser cross-user redemption: failing attempt revokes nothing;
    // succeeding attempt revokes User A's presented cookie and issues User B's.
    const userACookie = await login(betaUser.email, betaUserKey, beta.slug);
    expect(
      (await redeem({ code: 'invalid-code-0000' }, { cookie: userACookie }))
        .status
    ).toBe(401);
    expect(
      (
        await app.request(`${API_ORIGIN}/v2/auth/me`, {
          headers: { cookie: userACookie },
        })
      ).status
    ).toBe(200);

    const userBCode = await insertCode({
      userId: admin.id,
      communityId: alpha.id,
      purpose: 'admin_issued',
    });
    const crossRedeem = await redeem(
      { code: userBCode.code },
      { cookie: userACookie }
    );
    expect(crossRedeem.status).toBe(200);
    expect(
      (
        await app.request(`${API_ORIGIN}/v2/auth/me`, {
          headers: { cookie: userACookie },
        })
      ).status
    ).toBe(401);
  });

  it('enforces per-IP and per-account AuthThrottle and resets on success', async () => {
    const { admin, insertCode, redeem } = await setup();
    const { code } = await insertCode({
      userId: admin.id,
      communityId: admin.communityId,
      purpose: 'admin_issued',
    });

    // 10 unknown-code failures from 198.51.100.1 block that IP.
    for (let i = 0; i < AUTH_THROTTLE_MAX_FAILURES; i += 1) {
      const fail = await redeem(
        { code: `wrong-code-${i}` },
        { 'x-forwarded-for': '198.51.100.1' }
      );
      expect(fail.status).toBe(401);
    }
    const blockedIpAttempt = await redeem(
      { code },
      { 'x-forwarded-for': '198.51.100.1' }
    );
    expect(blockedIpAttempt.status).toBe(401);

    // Now drive 10 failures against `admin` across distinct IPs (using identifier).
    for (let i = 0; i < AUTH_THROTTLE_MAX_FAILURES; i += 1) {
      const fail = await redeem(
        { code: `wrong-acct-${i}`, identifier: admin.email },
        { 'x-forwarded-for': `198.51.100.${10 + i}` }
      );
      expect(fail.status).toBe(401);
    }
    // Account is blocked even from a fresh IP, and valid code is NOT consumed.
    const blockedAccountAttempt = await redeem(
      { code },
      { 'x-forwarded-for': '198.51.100.99' }
    );
    expect(blockedAccountAttempt.status).toBe(401);

    // Wait out the backoff window (after advancing 61 minutes, window/block clear).
    const ctx2 = await setup();
    const c2 = await ctx2.insertCode({
      userId: ctx2.admin.id,
      communityId: ctx2.admin.communityId,
      purpose: 'admin_issued',
    });
    for (let i = 0; i < AUTH_THROTTLE_MAX_FAILURES - 1; i += 1) {
      await ctx2.redeem(
        { code: `bad-${i}`, identifier: ctx2.admin.email },
        { 'x-forwarded-for': '203.0.113.5' }
      );
    }
    const ok = await ctx2.redeem(
      { code: c2.code },
      { 'x-forwarded-for': '203.0.113.5' }
    );
    expect(ok.status).toBe(200);
    // Counters reset on success: 9 more bad attempts don't block yet.
    for (let i = 0; i < AUTH_THROTTLE_MAX_FAILURES - 1; i += 1) {
      const res = await ctx2.redeem(
        { code: `after-reset-${i}`, identifier: ctx2.admin.email },
        { 'x-forwarded-for': '203.0.113.5' }
      );
      expect(res.status).toBe(401);
    }
  });

  it('handles D1 batch emulation (incl. same-ms double-redeem), concurrent race interposition, and audit rollback atomically', async () => {
    // 1. D1 batch emulation: valid redeem + immediate same-millisecond replay.
    const d1Ctx = await setup();
    installD1BatchEmulation(d1Ctx.db);
    const priorCookie = await d1Ctx.login(d1Ctx.admin.email, d1Ctx.adminKey);
    const d1Code = await d1Ctx.insertCode({
      userId: d1Ctx.admin.id,
      communityId: d1Ctx.admin.communityId,
      purpose: 'recovery',
    });
    const nextKey = makeDerivedKey();
    const d1Ok = await d1Ctx.redeem({
      code: d1Code.code,
      password: validPasswordPayload(nextKey),
    });
    expect(d1Ok.status).toBe(200);
    expect(
      (
        await d1Ctx.app.request(`${API_ORIGIN}/v2/auth/me`, {
          headers: { cookie: priorCookie },
        })
      ).status
    ).toBe(401);

    // Same-millisecond replay fails and preserves the winning session & verifier.
    const d1Replay = await d1Ctx.redeem({
      code: d1Code.code,
      password: validPasswordPayload(),
    });
    expect(d1Replay.status).toBe(401);
    const winningCookie = (d1Ok.headers.get('set-cookie') ?? '').split(';')[0]!;
    expect(
      (
        await d1Ctx.app.request(`${API_ORIGIN}/v2/auth/me`, {
          headers: { cookie: winningCookie },
        })
      ).status
    ).toBe(200);

    // 2. Real race interposition (HTTP end-to-end): another caller consumes
    //    the LoginCode between findLoginCodeByHash and redeemLoginCodeAtomically.
    const raceCtx = await setup();
    const raceCookie = await raceCtx.login(
      raceCtx.admin.email,
      raceCtx.adminKey
    );
    const raceCode = await raceCtx.insertCode({
      userId: raceCtx.admin.id,
      communityId: raceCtx.admin.communityId,
      purpose: 'recovery',
    });
    const [raceUserBefore] = await raceCtx.db
      .select()
      .from(usersSqlite)
      .where(eq(usersSqlite.id, raceCtx.admin.id));
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
                  'UPDATE login_codes SET used_at = ? WHERE code_hash = ?'
                )
                .run(raceCtx.currentNow().getTime(), raceCode.codeHash);
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
    const lostRaceRes = await raceApp.request(
      `${API_ORIGIN}/v2/auth/recovery/redeem`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code: raceCode.code,
          password: validPasswordPayload(),
        }),
      }
    );
    expect(intercepted).toBeGreaterThanOrEqual(1);
    expect(lostRaceRes.status).toBe(401);
    const [raceUserAfter] = await raceCtx.db
      .select()
      .from(usersSqlite)
      .where(eq(usersSqlite.id, raceCtx.admin.id));
    expect(raceUserAfter?.passwordVerifier).toBe(
      raceUserBefore?.passwordVerifier
    );
    expect(
      (
        await raceCtx.app.request(`${API_ORIGIN}/v2/auth/me`, {
          headers: { cookie: raceCookie },
        })
      ).status
    ).toBe(200);
    const raceRepo = new AuthRecoveryRepository(raceCtx.db);
    const directLost = await raceRepo.redeemLoginCodeAtomically(
      {
        code: {
          id: 1,
          codeHash: raceCode.codeHash,
          userId: raceCtx.admin.id,
          purpose: 'recovery',
          expiresAt: null,
        },
        account: {
          id: raceCtx.admin.id,
          communityId: raceCtx.admin.communityId,
          role: 'admin',
          passwordHash: raceCtx.admin.passwordHash,
        },
        verifier: {
          passwordHash: '',
          passwordVerifier: await sha256Hex(makeDerivedKey()),
          passwordAlgorithm: ARGON2ID_ALGORITHM,
          passwordSalt: makeVerifierSalt(),
          passwordParams: JSON.stringify(ARGON2ID_PARAMS),
        },
        session: {
          tokenHash: await sha256Hex(
            toHex(crypto.getRandomValues(new Uint8Array(32)))
          ),
          kind: 'standard',
          createdAtMs: raceCtx.currentNow().getTime(),
          idleExpiresAtMs: raceCtx.currentNow().getTime() + 3600_000,
          absoluteExpiresAtMs: raceCtx.currentNow().getTime() + 86400_000,
          adminCodeStepUpExpiresAtMs: null,
        },
        nowMs: raceCtx.currentNow().getTime(),
      },
      {
        communityId: raceCtx.admin.communityId,
        actorId: raceCtx.admin.id,
        action: 'auth.recovery.redeem',
        resourceType: 'login_code',
        resourceIds: [raceCtx.admin.id],
        outcome: 'success',
        ipAddress: '203.0.113.10',
        userAgent: 'RaceTest/1.0',
      }
    );
    expect(directLost).toBe(false);

    // 3. Audit-failure rollback atomicity: dropping `audit_entries` rolls back
    //    `used_at`, verifier change, and session revocation/creation.
    const brokenCtx = await setup();
    const brokenExistingCookie = await brokenCtx.login(
      brokenCtx.admin.email,
      brokenCtx.adminKey
    );
    const brokenCode = await brokenCtx.insertCode({
      userId: brokenCtx.admin.id,
      communityId: brokenCtx.admin.communityId,
      purpose: 'recovery',
    });
    const [userBefore] = await brokenCtx.db
      .select()
      .from(usersSqlite)
      .where(eq(usersSqlite.id, brokenCtx.admin.id));

    brokenCtx.sqlite.exec('DROP TABLE audit_entries');

    const failRedeem = await brokenCtx.redeem({
      code: brokenCode.code,
      password: validPasswordPayload(),
    });
    expect(failRedeem.status).toBe(503);

    const [codeAfter] = await brokenCtx.db
      .select()
      .from(loginCodesSqlite)
      .where(eq(loginCodesSqlite.codeHash, brokenCode.codeHash));
    expect(codeAfter?.usedAt).toBeNull();
    const [userAfter] = await brokenCtx.db
      .select()
      .from(usersSqlite)
      .where(eq(usersSqlite.id, brokenCtx.admin.id));
    expect(userAfter?.passwordVerifier).toBe(userBefore?.passwordVerifier);
    const sessionsAfter = await brokenCtx.db
      .select()
      .from(sessionsSqlite)
      .where(eq(sessionsSqlite.userId, brokenCtx.admin.id));
    expect(sessionsAfter).toHaveLength(1);
    expect(
      (
        await brokenCtx.app.request(`${API_ORIGIN}/v2/auth/me`, {
          headers: { cookie: brokenExistingCookie },
        })
      ).status
    ).toBe(200);
  });

  it('writes strictly content-free audit entries with zero code/verifier/identifier leakage', async () => {
    const { db, admin, insertCode, redeem } = await setup();
    const { code } = await insertCode({
      userId: admin.id,
      communityId: admin.communityId,
      purpose: 'recovery',
    });
    const newKey = makeDerivedKey();
    expect((await redeem({ code: 'unknown-code-123' })).status).toBe(401);
    expect(
      (
        await redeem(
          { code, password: validPasswordPayload(newKey) },
          { 'x-forwarded-for': '203.0.113.42', 'user-agent': 'Redeem-QA/1.0' }
        )
      ).status
    ).toBe(200);

    const rows = await db
      .select()
      .from(auditEntriesSqlite)
      .where(eq(auditEntriesSqlite.action, 'auth.recovery.redeem'));
    expect(rows).toHaveLength(2);
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(code);
    expect(serialized).not.toContain(await sha256Hex(code));
    expect(serialized).not.toContain(newKey);
    expect(serialized).not.toContain(admin.email);
    expect(serialized).not.toContain(admin.username ?? '');
    for (const row of rows) {
      const validated = validateContentFreeAuditEntry({
        communityId: row.communityId,
        actorId: row.actorId,
        action: row.action,
        resourceType: row.resourceType,
        resourceIds: row.resourceIds,
        outcome: row.outcome,
        ipAddress: row.ipAddress,
        userAgent: row.userAgent,
      });
      expect(validated.resourceType).toBe('login_code');
    }
  });
});
