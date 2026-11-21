/**
 * Focused tests for GET /v2/bootstrap and POST /v2/bootstrap (Slice 11b-B, #188;
 * SPEC-V2 §4, §6.8, §7 "Bootstrap and account lifecycle"; route registry §1).
 *
 * Covers:
 * - GET /v2/bootstrap fail-closed boolean (fresh true, closed false, permanent
 *   closure even after initial community deletion, 503 on DB failure, zero
 *   leaked community metadata)
 * - POST /v2/bootstrap wire validation (415, 400, 413, weak verifier, unsafe HTML)
 * - Happy path: creates community + first admin + 10 >=100-bit recovery codes
 *   (stored only as SHA-256) + active ts_session (standard and deviceSession)
 * - Optional slug derivation (incl. non-Latin fallback) and fieldKitCaFingerprint
 * - Post-bootstrap login, /v2/auth/me `recoveryCodesConfirmed: true`, and recovery
 *   code redemption
 * - Replay / non-fresh installation denial (403)
 * - Real concurrency race, D1 `db.batch()` emulation, and audit-failure rollback
 * - Content-free audit entry validation
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
import { sessionsSqlite } from '../../src/db/schema/sessions.js';
import {
  installationBootstrapSqlite,
  loginCodesSqlite,
} from '../../src/db/schema/login_codes.js';
import { auditEntriesSqlite } from '../../src/db/schema/audit_entries.js';
import {
  ARGON2ID_ALGORITHM,
  ARGON2ID_PARAMS,
  AUTH_THROTTLE_MAX_FAILURES,
  RECOVERY_CODE_COUNT,
} from '../../src/shared/auth-policy.js';
import { sha256Hex, toHex } from '../../src/shared/auth-crypto.js';
import {
  BootstrapResponseSchema,
  BootstrapStatusResponseSchema,
} from '../../src/shared/schemas/bootstrap.js';
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

const BOOTSTRAP_SECRET = 'bootstrap-operator-secret-0123456789abcdef';

function makeValidBootstrapBody(
  overrides: {
    community?: Record<string, unknown>;
    admin?: Record<string, unknown>;
    deviceSession?: boolean;
    derivedKey?: string;
  } = {}
) {
  const derivedKey = overrides.derivedKey ?? makeDerivedKey();
  return {
    derivedKey,
    payload: {
      bootstrapSecret: BOOTSTRAP_SECRET,
      community: {
        name: 'Awa Nation Stories',
        slug: 'awa-nation',
        description: '<p>Community <strong>archive</strong></p>',
        locale: 'en',
        country: 'EC',
        visibility: 'private',
        ...overrides.community,
      },
      admin: {
        username: 'awa_admin',
        email: 'admin@awa.example.test',
        displayName: 'Awa Admin',
        password: makePasswordPayload(derivedKey),
        ...overrides.admin,
      },
      ...(overrides.deviceSession !== undefined
        ? { deviceSession: overrides.deviceSession }
        : {}),
    },
  };
}

describe('GET /v2/bootstrap and POST /v2/bootstrap (Slice 11b-B)', () => {
  const openDbs: Sqlite.Database[] = [];

  afterEach(() => {
    while (openDbs.length > 0) openDbs.pop()?.close();
  });

  function setup(
    options: {
      serverSecret?: string | undefined;
      fieldKitCaFingerprint?: string | undefined;
      useD1Batch?: boolean;
      bootstrapSecret?: string | undefined;
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
    const bootstrapSecret =
      'bootstrapSecret' in options ? options.bootstrapSecret : BOOTSTRAP_SECRET;

    const app = createHonoApp({
      repository: new HonoFoundationRepository(db),
      storage: { read: async () => null },
      serverSecret: secret,
      bootstrapSecret,
      secureCookies: false,
      publicOrigin: API_ORIGIN,
      trustProxy: true,
      isWorkers: true,
      now: () => currentNow,
      fieldKitCaFingerprint: options.fieldKitCaFingerprint,
    });

    const getStatus = () => app.request(`${API_ORIGIN}/v2/bootstrap`);

    const postBootstrap = (
      body: unknown,
      headers: Record<string, string> = {}
    ) =>
      app.request(`${API_ORIGIN}/v2/bootstrap`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'cf-connecting-ip': '203.0.113.20',
          'user-agent': 'BootstrapTest/1.0',
          ...headers,
        },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      });

    return {
      sqlite,
      db,
      app,
      secret,
      currentNow: () => currentNow,
      advanceMs,
      getStatus,
      postBootstrap,
    };
  }

  it('reports GET /v2/bootstrap open=true only when fresh, closes permanently, and fails closed on DB errors', async () => {
    const { sqlite, db, getStatus, postBootstrap } = setup();

    const freshRes = await getStatus();
    expect(freshRes.status).toBe(200);
    const freshJson = await freshRes.json();
    expect(BootstrapStatusResponseSchema.parse(freshJson)).toEqual({
      open: true,
    });
    expect(Object.keys(freshJson as object)).toEqual(['open']);

    const { payload } = makeValidBootstrapBody();
    const bootRes = await postBootstrap(payload);
    expect(bootRes.status).toBe(201);

    const closedRes = await getStatus();
    expect(closedRes.status).toBe(200);
    expect(await closedRes.json()).toEqual({ open: false });

    // Even if all communities/users are deleted afterwards, installation_bootstrap
    // keeps bootstrap permanently closed.
    sqlite.exec('DELETE FROM audit_entries');
    await db.delete(usersSqlite);
    await db.delete(communitiesSqlite);
    const stillClosedRes = await getStatus();
    expect(stillClosedRes.status).toBe(200);
    expect(await stillClosedRes.json()).toEqual({ open: false });

    // Fail-closed 503 if DB cannot be read.
    sqlite.exec('DROP TABLE installation_bootstrap');
    const errorRes = await getStatus();
    expect(errorRes.status).toBe(503);
    expect(await errorRes.json()).toEqual({ error: 'Service unavailable' });
  });

  it('fails closed when no bootstrap secret is configured and refuses every bootstrap attempt', async () => {
    const { db, getStatus, postBootstrap } = setup({
      bootstrapSecret: undefined,
    });

    // Fail-closed boolean: an installation whose operator never configured
    // BOOTSTRAP_SECRET is never open for initial setup.
    expect(await (await getStatus()).json()).toEqual({ open: false });

    const res = await postBootstrap(makeValidBootstrapBody().payload);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });

    // No bootstrap state was minted for the anonymous probes.
    expect(await db.select().from(installationBootstrapSqlite)).toHaveLength(0);
    expect(await db.select().from(communitiesSqlite)).toHaveLength(0);
    expect(await db.select().from(usersSqlite)).toHaveLength(0);
  });

  it('refuses POST /v2/bootstrap with a wrong or missing bootstrap secret exactly like a closed installation', async () => {
    const { db, getStatus, postBootstrap } = setup();

    for (const bootstrapSecret of [
      undefined,
      'wrong-operator-secret-value-0123456789ab',
    ]) {
      const res = await postBootstrap({
        ...makeValidBootstrapBody().payload,
        ...(bootstrapSecret === undefined
          ? { bootstrapSecret: undefined }
          : { bootstrapSecret }),
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'Forbidden' });
    }

    // The refused attempts performed no bootstrap and left the install open
    // for a later operator retry.
    expect(await (await getStatus()).json()).toEqual({ open: true });
    expect(await db.select().from(communitiesSqlite)).toHaveLength(0);
    expect(await db.select().from(usersSqlite)).toHaveLength(0);
  });

  it('throttles failed bootstrap secret attempts per IP and stops the audit flood once blocked', async () => {
    const { db, postBootstrap, getStatus } = setup();

    const wrongSecretBody = {
      ...makeValidBootstrapBody().payload,
      bootstrapSecret: 'wrong-operator-secret-value-0123456789ab',
    };
    for (
      let attempt = 0;
      attempt < AUTH_THROTTLE_MAX_FAILURES + 3;
      attempt += 1
    ) {
      const res = await postBootstrap(wrongSecretBody);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'Forbidden' });
    }

    // The per-IP brake engaged: further attempts stay refused and mint no new
    // audit rows (first-failure-per-window audit only).
    const auditsBeforeBlock = await db
      .select()
      .from(auditEntriesSqlite)
      .where(eq(auditEntriesSqlite.action, 'bootstrap.complete'));
    const blockedRes = await postBootstrap(wrongSecretBody);
    expect(blockedRes.status).toBe(403);
    const auditsAfterBlock = await db
      .select()
      .from(auditEntriesSqlite)
      .where(eq(auditEntriesSqlite.action, 'bootstrap.complete'));
    expect(auditsAfterBlock.length).toBe(auditsBeforeBlock.length);
    expect(await (await getStatus()).json()).toEqual({ open: true });
    expect(await db.select().from(communitiesSqlite)).toHaveLength(0);
  });

  it('reports open=false and rejects POST /v2/bootstrap when a pre-existing community or user exists', async () => {
    const { db, getStatus, postBootstrap, currentNow } = setup();
    const [comm] = await db
      .insert(communitiesSqlite)
      .values({
        name: 'Preseeded',
        slug: 'preseeded',
        locale: 'en',
        publicStories: false,
        isActive: true,
        createdAt: currentNow(),
        updatedAt: currentNow(),
      })
      .returning();

    expect(await (await getStatus()).json()).toEqual({ open: false });
    const replayRes = await postBootstrap(makeValidBootstrapBody().payload);
    expect(replayRes.status).toBe(403);
    expect(await replayRes.json()).toEqual({ error: 'Forbidden' });
    expect(await db.select().from(communitiesSqlite)).toHaveLength(1);
    expect(await db.select().from(usersSqlite)).toHaveLength(0);

    // Also test user-only row (e.g. null-community super_admin) closes bootstrap.
    const ctx2 = setup();
    await ctx2.db.insert(usersSqlite).values({
      email: 'sa@example.test',
      username: 'sa_user',
      emailNormalized: 'sa@example.test',
      usernameNormalized: 'sa_user',
      firstName: '',
      lastName: '',
      ...(await argon2Seed(makeDerivedKey())),
      role: 'super_admin',
      communityId: null,
      isActive: true,
      createdAt: currentNow(),
      updatedAt: currentNow(),
    });
    expect(await (await ctx2.getStatus()).json()).toEqual({ open: false });
    expect(
      (await ctx2.postBootstrap(makeValidBootstrapBody().payload)).status
    ).toBe(403);
    expect(comm.id).toBeGreaterThan(0);
  });

  it('enforces wire validation (415, 400, 413, below-policy verifier, unsafe HTML) without closing bootstrap', async () => {
    const { app, getStatus, postBootstrap } = setup();

    // Non-JSON -> 415
    const nonJson = await app.request(`${API_ORIGIN}/v2/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{}',
    });
    expect(nonJson.status).toBe(415);

    // Malformed JSON -> 400
    const badJson = await postBootstrap('{broken');
    expect(badJson.status).toBe(400);

    // Oversized body (>256KB) -> 413
    const huge = JSON.stringify({
      community: { name: 'Big', description: 'a'.repeat(270 * 1024) },
    });
    const tooLarge = await postBootstrap(huge);
    expect(tooLarge.status).toBe(413);

    // Extra field -> 400
    const valid = makeValidBootstrapBody();
    const extraField = await postBootstrap({
      ...valid.payload,
      extra: true,
    });
    expect(extraField.status).toBe(400);

    // Unsafe href in description -> 400 without echoing raw description
    const badHrefHtml =
      '<a href="javascript:alert(\'secret-xss-payload\')">click</a>';
    const unsafeHtml = await postBootstrap(
      makeValidBootstrapBody({
        community: { description: badHrefHtml },
      }).payload
    );
    expect(unsafeHtml.status).toBe(400);
    expect(await unsafeHtml.text()).not.toContain('secret-xss-payload');

    // Over-length sanitised description (>20,000 chars) -> 400
    const tooLongDesc = await postBootstrap(
      makeValidBootstrapBody({
        community: { description: `<p>${'a'.repeat(20005)}</p>` },
      }).payload
    );
    expect(tooLongDesc.status).toBe(400);

    // Below-policy Argon2id parameters -> 400
    const weakParams = await postBootstrap(
      makeValidBootstrapBody({
        admin: {
          password: {
            algorithm: ARGON2ID_ALGORITHM,
            salt: makeVerifierSalt(),
            params: { memoryKiB: 1024, iterations: 1, parallelism: 1 },
            derivedKey: makeDerivedKey(),
          },
        },
      }).payload
    );
    expect(weakParams.status).toBe(400);
    expect(await weakParams.json()).toEqual({
      error: 'Password does not meet requirements',
    });

    // Bootstrap remains open after all invalid attempts.
    expect(await (await getStatus()).json()).toEqual({ open: true });
  });

  it('completes bootstrap atomically, issues 10 recovery codes + session + optional caFingerprint, and supports login + recovery', async () => {
    const fingerprint = `SHA256:${toHex(crypto.getRandomValues(new Uint8Array(16)))}`;
    const { db, app, getStatus, postBootstrap } = setup({
      fieldKitCaFingerprint: fingerprint,
    });

    const { derivedKey, payload } = makeValidBootstrapBody({
      community: { visibility: 'public' },
      deviceSession: true,
    });
    const res = await postBootstrap(payload);
    expect(res.status).toBe(201);

    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('ts_session=');
    expect(setCookie).toMatch(/Max-Age=5184000/i);
    const cookie = setCookie.split(';')[0]!;

    const json = await res.json();
    const parsed = BootstrapResponseSchema.parse(json);
    expect(parsed.data.community.slug).toBe('awa-nation');
    expect(parsed.data.community.visibility).toBe('public');
    expect(parsed.data.community.status).toBe('active');
    expect(parsed.data.community.description).toBe(
      '<p>Community <strong>archive</strong></p>'
    );
    expect(parsed.data.user.role).toBe('admin');
    expect(parsed.data.user.recoveryCodesConfirmed).toBe(true);
    expect(parsed.data.caFingerprint).toBe(fingerprint);
    expect(parsed.data.recoveryCodes.codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(new Set(parsed.data.recoveryCodes.codes).size).toBe(
      RECOVERY_CODE_COUNT
    );

    const serialized = JSON.stringify(json);
    expect(serialized).not.toContain(derivedKey);
    expect(serialized).not.toContain(cookie.slice('ts_session='.length));

    // Stored codes are SHA-256 digests only.
    const storedCodes = await db.select().from(loginCodesSqlite);
    expect(storedCodes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(storedCodes.every((row) => row.purpose === 'recovery')).toBe(true);
    expect(storedCodes.every((row) => row.expiresAt === null)).toBe(true);
    const expectedHashes = await Promise.all(
      parsed.data.recoveryCodes.codes.map((c) => sha256Hex(c))
    );
    expect(storedCodes.map((r) => r.codeHash).sort()).toEqual(
      expectedHashes.sort()
    );

    // Stored descriptionPlain maintained.
    const [storedComm] = await db.select().from(communitiesSqlite);
    expect(storedComm?.descriptionPlain).toBe('Community archive');

    // GET /v2/auth/me works with the bootstrap session and shows recoveryCodesConfirmed: true.
    const meRes = await app.request(`${API_ORIGIN}/v2/auth/me`, {
      headers: { cookie },
    });
    expect(meRes.status).toBe(200);
    const meBody = (await meRes.json()) as {
      user: { role: string; recoveryCodesConfirmed: boolean };
    };
    expect(meBody.user.role).toBe('admin');
    expect(meBody.user.recoveryCodesConfirmed).toBe(true);

    // Bootstrap is permanently closed; replay returns 403.
    expect(await (await getStatus()).json()).toEqual({ open: false });
    const replay = await postBootstrap(makeValidBootstrapBody().payload);
    expect(replay.status).toBe(403);

    // Admin can log in with the bootstrapped credentials.
    const loginRes = await app.request(`${API_ORIGIN}/v2/auth/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'cf-connecting-ip': '203.0.113.21',
      },
      body: JSON.stringify({
        identifier: payload.admin.username,
        derivedKey,
      }),
    });
    expect(loginRes.status).toBe(200);

    // Admin can redeem one of the bootstrap recovery codes to reset password & revoke sessions.
    const newDerivedKey = makeDerivedKey();
    const redeemRes = await app.request(
      `${API_ORIGIN}/v2/auth/recovery/redeem`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'cf-connecting-ip': '203.0.113.22',
        },
        body: JSON.stringify({
          code: parsed.data.recoveryCodes.codes[0],
          password: makePasswordPayload(newDerivedKey),
        }),
      }
    );
    expect(redeemRes.status).toBe(200);
    const meAfterRedeem = await app.request(`${API_ORIGIN}/v2/auth/me`, {
      headers: { cookie },
    });
    expect(meAfterRedeem.status).toBe(401);
  });

  it('omits caFingerprint when not configured and derives slugs including non-Latin fallback', async () => {
    const ctx1 = setup();
    const body1 = makeValidBootstrapBody({
      community: {
        name: 'Tëst Cømmunity!!',
        slug: undefined,
        visibility: undefined,
        locale: undefined,
      },
    }).payload;
    delete (body1.community as Record<string, unknown>).slug;
    delete (body1.community as Record<string, unknown>).visibility;
    delete (body1.community as Record<string, unknown>).locale;

    const res1 = await ctx1.postBootstrap(body1);
    expect(res1.status).toBe(201);
    const json1 = BootstrapResponseSchema.parse(await res1.json());
    expect(json1.data.community.slug).toBe('test-c-mmunity');
    expect(json1.data.community.visibility).toBe('private');
    expect(json1.data.community.locale).toBe('en');
    expect('caFingerprint' in json1.data).toBe(false);

    // Non-Latin name with zero ASCII chars falls back to 'community'.
    const ctx2 = setup();
    const body2 = makeValidBootstrapBody({
      community: { name: 'ชุมชนพื้นเมือง' },
    }).payload;
    delete (body2.community as Record<string, unknown>).slug;
    const res2 = await ctx2.postBootstrap(body2);
    expect(res2.status).toBe(201);
    const json2 = BootstrapResponseSchema.parse(await res2.json());
    expect(json2.data.community.slug).toBe('community');
  });

  it('prevents concurrent bootstrap race across SQLite transactions and D1 db.batch() emulation', async () => {
    // 1. Real SQLite race interposition: a second bootstrap steals the singleton
    // inside the first transaction check window -> first loses cleanly with 403.
    const raceCtx = setup();
    let intercepted = 0;
    const raceProxy = new Proxy(raceCtx.db, {
      get(target, prop) {
        if (prop === 'transaction') {
          const realTx = target.transaction.bind(target);
          return (fn: (tx: unknown) => unknown) => {
            if (intercepted === 0) {
              intercepted += 1;
              raceCtx.sqlite
                .prepare(
                  'INSERT INTO installation_bootstrap (id, setup_id, community_id, admin_user_id, completed_at) VALUES (1, ?, NULL, NULL, ?)'
                )
                .run('competitor-setup', raceCtx.currentNow().getTime());
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
      bootstrapSecret: BOOTSTRAP_SECRET,
      secureCookies: false,
      publicOrigin: API_ORIGIN,
      now: () => raceCtx.currentNow(),
    });
    const lostRes = await raceApp.request(`${API_ORIGIN}/v2/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(makeValidBootstrapBody().payload),
    });
    expect(intercepted).toBe(1);
    expect(lostRes.status).toBe(403);
    expect(await raceCtx.db.select().from(communitiesSqlite)).toHaveLength(0);
    expect(await raceCtx.db.select().from(usersSqlite)).toHaveLength(0);

    // 2. D1 db.batch() emulation: concurrent Promise.all -> exactly 1 wins (201), 1 loses (403).
    const d1Ctx = setup({ useD1Batch: true });
    const reqA = makeValidBootstrapBody({
      community: { slug: 'd1-first' },
      admin: { username: 'd1_first', email: 'first@d1.example.test' },
    }).payload;
    const reqB = makeValidBootstrapBody({
      community: { slug: 'd1-second' },
      admin: { username: 'd1_second', email: 'second@d1.example.test' },
    }).payload;

    const [resA, resB] = await Promise.all([
      d1Ctx.postBootstrap(reqA),
      d1Ctx.postBootstrap(reqB),
    ]);
    expect([resA.status, resB.status].sort()).toEqual([201, 403]);
    expect(await d1Ctx.db.select().from(communitiesSqlite)).toHaveLength(1);
    expect(await d1Ctx.db.select().from(usersSqlite)).toHaveLength(1);
    expect(await d1Ctx.db.select().from(loginCodesSqlite)).toHaveLength(
      RECOVERY_CODE_COUNT
    );
    expect(await d1Ctx.db.select().from(sessionsSqlite)).toHaveLength(1);
    expect(
      await d1Ctx.db.select().from(installationBootstrapSqlite)
    ).toHaveLength(1);
  });

  it('rolls back all bootstrap writes if audit_entries write fails and keeps audit entries content-free', async () => {
    // 1. Audit failure rollback atomicity (direct transaction + D1 batch)
    for (const useD1Batch of [false, true]) {
      const broken = setup({ useD1Batch });
      broken.sqlite.exec(
        "CREATE TRIGGER fail_audit BEFORE INSERT ON audit_entries BEGIN SELECT RAISE(ABORT, 'audit-boom'); END;"
      );
      const res = await broken.postBootstrap(makeValidBootstrapBody().payload);
      expect(res.status).toBe(503);
      expect(
        await broken.db.select().from(installationBootstrapSqlite)
      ).toHaveLength(0);
      expect(await broken.db.select().from(communitiesSqlite)).toHaveLength(0);
      expect(await broken.db.select().from(usersSqlite)).toHaveLength(0);
      expect(await broken.db.select().from(loginCodesSqlite)).toHaveLength(0);
      expect(await broken.db.select().from(sessionsSqlite)).toHaveLength(0);
      expect(await (await broken.getStatus()).json()).toEqual({ open: true });
    }

    // 2. Content-free audit entry check (success + replay failure)
    const { db, postBootstrap } = setup();
    const { derivedKey, payload } = makeValidBootstrapBody({
      community: {
        name: 'Sensitive Cultural Name',
        description: '<p>Protected community story text</p>',
      },
    });
    const ok = await postBootstrap(payload);
    expect(ok.status).toBe(201);
    const codes = BootstrapResponseSchema.parse(await ok.json()).data
      .recoveryCodes.codes;
    const replay = await postBootstrap(makeValidBootstrapBody().payload);
    expect(replay.status).toBe(403);

    const audits = await db
      .select()
      .from(auditEntriesSqlite)
      .where(eq(auditEntriesSqlite.action, 'bootstrap.complete'));
    expect(audits).toHaveLength(2);
    expect(audits.map((a) => a.outcome).sort()).toEqual(['failure', 'success']);
    const serialized = JSON.stringify(audits);
    expect(serialized).not.toContain(derivedKey);
    expect(serialized).not.toContain('Sensitive Cultural Name');
    expect(serialized).not.toContain('Protected community story text');
    expect(serialized).not.toContain(payload.admin.email);
    expect(serialized).not.toContain(payload.admin.username);
    for (const code of codes) {
      expect(serialized).not.toContain(code);
      expect(serialized).not.toContain(await sha256Hex(code));
    }
    for (const entry of audits) {
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
      expect(validated.communityId).toBeNull();
      expect(validated.resourceType).toBe('bootstrap');
    }
  });
});
