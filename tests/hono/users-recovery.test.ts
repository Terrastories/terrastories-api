/**
 * Focused tests for the Slice 11a assisted-recovery routes (#188):
 * POST /v2/users/:id/password-reset and POST /v2/users/:id/login-codes —
 * SPEC-V2 §6.8 (LoginCode), §7 (Bootstrap and account lifecycle); route
 * registry §6. Audit is content-free; the raw code appears exactly once.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq, asc } from 'drizzle-orm';
import { tablesFor } from '../../src/db/dialect.js';
import {
  argon2Seed,
  makeDerivedKey,
  makeServerSecret,
  makeVerifierSalt,
} from './auth-test-utils.js';
import { createHonoApp } from '../../src/hono-app.js';
import { HonoFoundationRepository } from '../../src/repositories/hono-foundation.repository.js';
import { deriveUserIdentityColumns } from '../../src/shared/utils/derived-columns.js';
import { sha256Hex } from '../../src/shared/auth-crypto.js';
import {
  ARGON2ID_PARAMS_JSON,
  ADMIN_ISSUED_CODE_TTL_MS,
} from '../../src/shared/auth-policy.js';

const sqlite = new Sqlite(':memory:');
sqlite.pragma('foreign_keys = ON');
const db = drizzle(sqlite);
const tables = tablesFor(db);

const TEST_DERIVED_KEY = makeDerivedKey();
const T0 = new Date('2026-06-01T12:00:00.000Z');

const API_ORIGIN = 'https://api.example.test';

let app: ReturnType<typeof createHonoApp>;
const ids: Record<string, number> = {};
const cookies: Record<string, string> = {};

async function insertRow<T extends { $inferInsert: Record<string, unknown> }>(
  table: any,
  values: T['$inferInsert']
): Promise<number> {
  const [inserted] = await db
    .insert(table)
    .values(values)
    .returning({ id: table.id });
  return inserted.id as number;
}

async function loginAs(
  email: string,
  communityId: number | null,
  derivedKey: string = TEST_DERIVED_KEY
): Promise<string> {
  let communitySlug: string | undefined;
  if (communityId !== null) {
    const [row] = await db
      .select({ slug: tables.communities.slug })
      .from(tables.communities)
      .where(eq(tables.communities.id, communityId))
      .limit(1);
    communitySlug = row?.slug;
  }
  const res = await app.request(`${API_ORIGIN}/v2/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      identifier: email,
      derivedKey,
      ...(communitySlug === undefined ? {} : { communitySlug }),
    }),
  });
  expect(res.status).toBe(200);
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

async function requestJson(
  method: string,
  path: string,
  options: { cookie?: string; body?: unknown } = {}
) {
  const headers: Record<string, string> = {};
  if (options.cookie) headers.cookie = options.cookie;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const res = await app.request(`${API_ORIGIN}${path}`, {
    method,
    headers,
    body:
      options.body === undefined
        ? undefined
        : typeof options.body === 'string'
          ? options.body
          : JSON.stringify(options.body),
  });
  const text = await res.text();
  return {
    status: res.status,
    headers: res.headers,
    text,
    json: text ? (JSON.parse(text) as unknown) : null,
  };
}

const seedUser = async (
  email: string,
  role: string,
  communityId: number | null,
  username?: string
) => {
  const resolved = username ?? email.replace('@', '-').split('.')[0]!;
  return insertRow(tables.users, {
    email,
    username: resolved,
    ...deriveUserIdentityColumns({ email, username: resolved }),
    firstName: role,
    lastName: 'Tester',
    ...(await argon2Seed(TEST_DERIVED_KEY)),
    role,
    communityId,
    isActive: true,
    createdAt: T0,
    updatedAt: T0,
  });
};

beforeAll(async () => {
  migrate(db, { migrationsFolder: 'src/db/migrations' });

  ids.own = await insertRow(tables.communities, {
    name: 'Own Nation',
    slug: 'own-nation',
    locale: 'en',
    publicStories: false,
    isActive: true,
    createdAt: T0,
    updatedAt: T0,
  });
  ids.foreign = await insertRow(tables.communities, {
    name: 'Foreign Nation',
    slug: 'foreign-nation',
    locale: 'en',
    publicStories: true,
    isActive: true,
    createdAt: T0,
    updatedAt: T0,
  });
  ids.disabled = await insertRow(tables.communities, {
    name: 'Disabled Nation',
    slug: 'disabled-nation',
    locale: 'en',
    publicStories: false,
    isActive: false,
    createdAt: T0,
    updatedAt: T0,
  });

  ids.uAdmin = await seedUser(
    'admin@own.example.test',
    'admin',
    ids.own!,
    'qa_admin_own'
  );
  ids.uAdmin2 = await seedUser(
    'admin2@own.example.test',
    'admin',
    ids.own!,
    'qa_admin2_own'
  );
  ids.uEditor = await seedUser(
    'editor@own.example.test',
    'editor',
    ids.own!,
    'qa_editor_own'
  );
  ids.uMember = await seedUser(
    'member@own.example.test',
    'member',
    ids.own!,
    'qa_member_own'
  );
  ids.uForeignAdmin = await seedUser(
    'admin@foreign.example.test',
    'admin',
    ids.foreign!,
    'qa_admin_foreign'
  );
  ids.uDisabledAdmin = await seedUser(
    'admin@disabled.example.test',
    'admin',
    ids.disabled!,
    'qa_admin_disabled'
  );
  ids.uDisabledMember = await seedUser(
    'member@disabled.example.test',
    'member',
    ids.disabled!,
    'qa_member_disabled'
  );
  ids.uSuper = await seedUser(
    'super@example.test',
    'super_admin',
    null,
    'qa_super'
  );

  app = createHonoApp({
    repository: new HonoFoundationRepository(db),
    secureCookies: false,
    publicOrigin: API_ORIGIN,
    storage: { read: async () => null },
    serverSecret: makeServerSecret(),
  });

  cookies.admin = await loginAs('admin@own.example.test', ids.own!);
  cookies.admin2 = await loginAs('admin2@own.example.test', ids.own!);
  cookies.editor = await loginAs('editor@own.example.test', ids.own!);
  cookies.member = await loginAs('member@own.example.test', ids.own!);
  cookies.foreignAdmin = await loginAs(
    'admin@foreign.example.test',
    ids.foreign!
  );
  cookies.disabledAdmin = await loginAs(
    'admin@disabled.example.test',
    ids.disabled!
  );
  cookies.super = await loginAs('super@example.test', null);
});

afterAll(() => {
  sqlite.close();
});

const verifierBody = (derivedKey: string) => ({
  algorithm: 'client-argon2id+sha256',
  salt: makeVerifierSalt(),
  params: JSON.parse(ARGON2ID_PARAMS_JSON),
  derivedKey,
});

describe('assisted-recovery authority gates (route registry §6, §7)', () => {
  it('rejects unauthenticated callers with 401', async () => {
    for (const path of [
      `/v2/users/${ids.uEditor}/password-reset`,
      `/v2/users/${ids.uEditor}/login-codes`,
    ]) {
      const res = await requestJson('POST', path, { body: {} });
      expect(res.status, path).toBe(401);
    }
  });

  it('rejects non-admin roles and super_admin with 403', async () => {
    for (const [roleKey, cookie] of [
      ['editor', cookies.editor],
      ['member', cookies.member],
      ['super_admin', cookies.super],
    ] as const) {
      const reset = await requestJson(
        'POST',
        `/v2/users/${ids.uEditor}/password-reset`,
        { cookie, body: verifierBody(TEST_DERIVED_KEY) }
      );
      expect(reset.status, `${roleKey} reset`).toBe(403);
      const code = await requestJson(
        'POST',
        `/v2/users/${ids.uEditor}/login-codes`,
        { cookie }
      );
      expect(code.status, `${roleKey} code`).toBe(403);
    }
  });

  it('refuses acting on the caller’s own account with 403', async () => {
    const reset = await requestJson(
      'POST',
      `/v2/users/${ids.uAdmin}/password-reset`,
      { cookie: cookies.admin, body: verifierBody(TEST_DERIVED_KEY) }
    );
    expect(reset.status).toBe(403);
    const code = await requestJson(
      'POST',
      `/v2/users/${ids.uAdmin}/login-codes`,
      { cookie: cookies.admin }
    );
    expect(code.status).toBe(403);
  });

  it('returns 404 for cross-community, null-community and unknown targets', async () => {
    const crossReset = await requestJson(
      'POST',
      `/v2/users/${ids.uForeignAdmin}/password-reset`,
      { cookie: cookies.admin, body: verifierBody(TEST_DERIVED_KEY) }
    );
    expect(crossReset.status).toBe(404);
    const crossCode = await requestJson(
      'POST',
      `/v2/users/${ids.uForeignAdmin}/login-codes`,
      { cookie: cookies.admin }
    );
    expect(crossCode.status).toBe(404);
    // super_admin (null community) has no admin-issued path — §7.
    const superReset = await requestJson(
      'POST',
      `/v2/users/${ids.uSuper}/password-reset`,
      { cookie: cookies.admin, body: verifierBody(TEST_DERIVED_KEY) }
    );
    expect(superReset.status).toBe(404);
    const superCode = await requestJson(
      'POST',
      `/v2/users/${ids.uSuper}/login-codes`,
      { cookie: cookies.admin }
    );
    expect(superCode.status).toBe(404);
    const unknown = await requestJson(
      'POST',
      '/v2/users/999999/password-reset',
      { cookie: cookies.admin, body: verifierBody(TEST_DERIVED_KEY) }
    );
    expect(unknown.status).toBe(404);
    const malformed = await requestJson('POST', '/v2/users/nope/login-codes', {
      cookie: cookies.admin,
    });
    expect(malformed.status).toBe(404);
  });
});

describe('POST /v2/users/:id/password-reset (assisted recovery)', () => {
  it('resets another account atomically with session revocation and creates no session', async () => {
    const targetEmail = 'member@own.example.test';
    const targetCookie = await loginAs(targetEmail, ids.own!);
    const before = await requestJson('GET', '/v2/auth/me', {
      cookie: targetCookie,
    });
    expect(before.status).toBe(200);

    const temporaryKey = makeDerivedKey();
    const res = await requestJson(
      'POST',
      `/v2/users/${ids.uMember}/password-reset`,
      { cookie: cookies.admin, body: verifierBody(temporaryKey) }
    );
    expect(res.status).toBe(204);
    expect(res.text).toBe('');

    // The target's sessions were revoked; the actor keeps their own.
    const afterTarget = await requestJson('GET', '/v2/auth/me', {
      cookie: targetCookie,
    });
    expect(afterTarget.status).toBe(401);
    const afterAdmin = await requestJson('GET', '/v2/auth/me', {
      cookie: cookies.admin,
    });
    expect(afterAdmin.status).toBe(200);

    // The temporary key now authenticates the target account.
    const relogin = await app.request(`${API_ORIGIN}/v2/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        identifier: targetEmail,
        derivedKey: temporaryKey,
        communitySlug: 'own-nation',
      }),
    });
    expect(relogin.status).toBe(200);

    // The applied verifier is the SHA-256 of the temporary key, never visible.
    const [row] = await db
      .select({
        passwordVerifier: tables.users.passwordVerifier,
        passwordAlgorithm: tables.users.passwordAlgorithm,
      })
      .from(tables.users)
      .where(eq(tables.users.id, ids.uMember!));
    expect(row?.passwordVerifier).toBe(await sha256Hex(temporaryKey));
    expect(row?.passwordVerifier).not.toBe(temporaryKey);
  });

  it('allows resetting another administrator’s credentials', async () => {
    const temporaryKey = makeDerivedKey();
    const res = await requestJson(
      'POST',
      `/v2/users/${ids.uAdmin2}/password-reset`,
      { cookie: cookies.admin, body: verifierBody(temporaryKey) }
    );
    expect(res.status).toBe(204);
  });

  it('is available while the community is disabled (credential recovery is the auth surface)', async () => {
    const temporaryKey = makeDerivedKey();
    const res = await requestJson(
      'POST',
      `/v2/users/${ids.uDisabledMember}/password-reset`,
      { cookie: cookies.disabledAdmin, body: verifierBody(temporaryKey) }
    );
    expect(res.status).toBe(204);
    // The acting admin is cross-community: refused identically.
    const cross = await requestJson(
      'POST',
      `/v2/users/${ids.uEditor}/password-reset`,
      { cookie: cookies.disabledAdmin, body: verifierBody(temporaryKey) }
    );
    expect(cross.status).toBe(404);
  });

  it('rejects malformed bodies and below-policy verifier material with 400', async () => {
    const missing = await requestJson(
      'POST',
      `/v2/users/${ids.uEditor}/password-reset`,
      { cookie: cookies.admin, body: { algorithm: 'client-argon2id+sha256' } }
    );
    expect(missing.status).toBe(400);
    const wrongAlgorithm = await requestJson(
      'POST',
      `/v2/users/${ids.uEditor}/password-reset`,
      {
        cookie: cookies.admin,
        body: { ...verifierBody(TEST_DERIVED_KEY), algorithm: 'argon2id' },
      }
    );
    expect(wrongAlgorithm.status).toBe(400);
    const weakParams = await requestJson(
      'POST',
      `/v2/users/${ids.uEditor}/password-reset`,
      {
        cookie: cookies.admin,
        body: {
          ...verifierBody(TEST_DERIVED_KEY),
          params: { memoryKiB: 8, iterations: 1, parallelism: 1 },
        },
      }
    );
    expect(weakParams.status).toBe(400);
    const badSalt = await requestJson(
      'POST',
      `/v2/users/${ids.uEditor}/password-reset`,
      {
        cookie: cookies.admin,
        body: { ...verifierBody(TEST_DERIVED_KEY), salt: 'not-base64!!' },
      }
    );
    expect(badSalt.status).toBe(400);
    const unknownField = await requestJson(
      'POST',
      `/v2/users/${ids.uEditor}/password-reset`,
      {
        cookie: cookies.admin,
        body: { ...verifierBody(TEST_DERIVED_KEY), injected: 'x' },
      }
    );
    expect(unknownField.status).toBe(400);
  });

  it('emits a content-free audit entry without the temporary material', async () => {
    const temporaryKey = makeDerivedKey();
    const res = await requestJson(
      'POST',
      `/v2/users/${ids.uEditor}/password-reset`,
      { cookie: cookies.admin, body: verifierBody(temporaryKey) }
    );
    expect(res.status).toBe(204);
    const rows = await db
      .select()
      .from(tables.auditEntries)
      .where(eq(tables.auditEntries.action, 'user.password_reset'))
      .orderBy(asc(tables.auditEntries.id));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const serialized = JSON.stringify(row);
      expect(serialized).not.toContain(temporaryKey);
      expect(serialized).not.toContain(await sha256Hex(temporaryKey));
      expect(row.resourceType).toBe('user');
      expect(row.ipAddress).toBeNull();
      expect(row.userAgent).toBeNull();
    }
    const success = rows.find(
      (row) =>
        row.outcome === 'success' && row.resourceIds.includes(ids.uEditor!)
    );
    expect(success).toBeDefined();
  });
});

describe('POST /v2/users/:id/login-codes (admin_issued)', () => {
  it('issues a single-use admin_issued code exactly once with ≥100-bit entropy', async () => {
    const res = await requestJson(
      'POST',
      `/v2/users/${ids.uEditor}/login-codes`,
      { cookie: cookies.admin }
    );
    expect(res.status).toBe(201);
    const body = res.json as {
      data: { code: string; purpose: string; expiresAt: string };
    };
    expect(body.data.purpose).toBe('admin_issued');
    // The code is the only occurrence of itself in the whole response.
    const occurrences = res.text.split(body.data.code).length - 1;
    expect(occurrences).toBe(1);
    // ≥100 bits: the token is 16 CSPRNG bytes = 128 bits, base64url-encoded.
    const normalized = body.data.code.replaceAll('-', '+').replaceAll('_', '/');
    const bytes = Buffer.from(normalized, 'base64');
    expect(bytes.length).toBeGreaterThanOrEqual(16);
    expect(body.data.code).toMatch(/^[A-Za-z0-9_-]+$/);
    // Expiry within 72h and in the future.
    const expiresAt = new Date(body.data.expiresAt).getTime();
    expect(Number.isFinite(expiresAt)).toBe(true);
    expect(expiresAt).toBeGreaterThan(Date.now());
    expect(expiresAt).toBeLessThanOrEqual(
      Date.now() + ADMIN_ISSUED_CODE_TTL_MS + 1000
    );
  });

  it('stores only the SHA-256 digest, never the raw code', async () => {
    const res = await requestJson(
      'POST',
      `/v2/users/${ids.uMember}/login-codes`,
      { cookie: cookies.admin }
    );
    expect(res.status).toBe(201);
    const code = (res.json as { data: { code: string } }).data.code;
    const rows = await db
      .select()
      .from(tables.loginCodes)
      .where(eq(tables.loginCodes.userId, ids.uMember!));
    expect(rows.length).toBeGreaterThan(0);
    const hashes = rows.map((row) => row.codeHash);
    expect(hashes).toContain(await sha256Hex(code));
    for (const row of rows) {
      expect(row.codeHash).not.toBe(code);
      expect(row.codeHash).toMatch(/^[a-f0-9]{64}$/);
      expect(row.purpose).toBe('admin_issued');
      expect(row.communityId).toBe(ids.own);
      expect(row.createdBy).toBe(ids.uAdmin);
      expect(row.usedAt).toBeNull();
      expect(row.supersededAt).toBeNull();
      expect(row.expiresAt).not.toBeNull();
      expect(row.expiresAt! - row.createdAt).toBeLessThanOrEqual(
        ADMIN_ISSUED_CODE_TTL_MS
      );
    }
    // Distinct codes on successive issues; both stay outstanding.
    const res2 = await requestJson(
      'POST',
      `/v2/users/${ids.uMember}/login-codes`,
      { cookie: cookies.admin }
    );
    const code2 = (res2.json as { data: { code: string } }).data.code;
    expect(code2).not.toBe(code);
    const after = await db
      .select()
      .from(tables.loginCodes)
      .where(eq(tables.loginCodes.userId, ids.uMember!));
    for (const row of after) {
      expect(row.supersededAt).toBeNull();
    }
  });

  it('is available while the community is disabled for another account', async () => {
    const res = await requestJson(
      'POST',
      `/v2/users/${ids.uDisabledMember}/login-codes`,
      { cookie: cookies.disabledAdmin }
    );
    expect(res.status).toBe(201);
    const body = res.json as { data: { purpose: string } };
    expect(body.data.purpose).toBe('admin_issued');
    // Cross-community disabled-admin is refused identically to 404.
    const cross = await requestJson(
      'POST',
      `/v2/users/${ids.uEditor}/login-codes`,
      { cookie: cookies.disabledAdmin }
    );
    expect(cross.status).toBe(404);
  });

  it('emits a content-free audit entry without the code value', async () => {
    const res = await requestJson(
      'POST',
      `/v2/users/${ids.uEditor}/login-codes`,
      { cookie: cookies.admin }
    );
    expect(res.status).toBe(201);
    const code = (res.json as { data: { code: string } }).data.code;
    const rows = await db
      .select()
      .from(tables.auditEntries)
      .where(eq(tables.auditEntries.action, 'user.login_code_issue'))
      .orderBy(asc(tables.auditEntries.id));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(JSON.stringify(row)).not.toContain(code);
      expect(row.resourceType).toBe('user');
      expect(row.ipAddress).toBeNull();
      expect(row.userAgent).toBeNull();
    }
  });
});
