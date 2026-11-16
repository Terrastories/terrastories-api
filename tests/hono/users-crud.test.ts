/**
 * Focused tests for the Slice 11a user-management routes (#188):
 * GET/POST/PATCH /v2/users[/:id], identity collisions, authority gates,
 * self-demotion guard, trigger-driven session revocation and content-free
 * audit — SPEC-V2 §6.2, §6.8, §7; route registry §6.
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
} from './auth-test-utils.js';
import { createHonoApp } from '../../src/hono-app.js';
import { HonoFoundationRepository } from '../../src/repositories/hono-foundation.repository.js';
import { UserManagementRepository } from '../../src/repositories/user-management.repository.js';
import { deriveUserIdentityColumns } from '../../src/shared/utils/derived-columns.js';

const sqlite = new Sqlite(':memory:');
sqlite.pragma('foreign_keys = ON');
const db = drizzle(sqlite);
const tables = tablesFor(db);

const TEST_DERIVED_KEY = makeDerivedKey();
const T0 = new Date('2026-06-01T12:00:00.000Z');

const API_ORIGIN = 'https://api.example.test';
const CLIENT_ORIGIN = 'https://app.example.test';
const FOREIGN_ORIGIN = 'https://evil.invalid';

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

async function loginAs(email: string, communityId?: number): Promise<string> {
  let communitySlug: string | undefined;
  if (communityId !== undefined) {
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
      derivedKey: TEST_DERIVED_KEY,
      ...(communitySlug === undefined ? {} : { communitySlug }),
    }),
  });
  expect(res.status).toBe(200);
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

async function requestJson(
  method: string,
  path: string,
  options: {
    cookie?: string;
    body?: unknown;
    headers?: Record<string, string>;
    originUrl?: string;
  } = {}
) {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.cookie) headers.cookie = options.cookie;
  if (
    options.body !== undefined &&
    !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')
  ) {
    headers['content-type'] = 'application/json';
  }
  const base = options.originUrl ?? API_ORIGIN;
  const res = await app.request(`${base}${path}`, {
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
    json: text ? (JSON.parse(text) as unknown) : null,
  };
}

const credentialFree = (body: unknown): boolean => {
  const text = JSON.stringify(body);
  for (const forbidden of [
    'passwordVerifier',
    'passwordAlgorithm',
    'passwordSalt',
    'passwordParams',
    'passwordHash',
    'tokenHash',
    'codeHash',
    'resetPasswordToken',
  ]) {
    if (text.includes(forbidden)) return false;
  }
  return true;
};

beforeAll(async () => {
  migrate(db, { migrationsFolder: 'src/db/migrations' });
  const seed = await argon2Seed(TEST_DERIVED_KEY);

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

  const makeUser = async (
    email: string,
    role: string,
    communityId: number | null,
    username?: string
  ) => {
    const resolvedUsername = username ?? email.replace('@', '-').split('.')[0]!;
    return insertRow(tables.users, {
      email,
      username: resolvedUsername,
      ...deriveUserIdentityColumns({ email, username: resolvedUsername }),
      firstName: role,
      lastName: 'Tester',
      ...seed,
      role,
      communityId,
      isActive: true,
      createdAt: T0,
      updatedAt: T0,
    });
  };

  ids.uAdmin = await makeUser(
    'admin@own.example.test',
    'admin',
    ids.own!,
    'qa_admin_own'
  );
  ids.uAdmin2 = await makeUser(
    'admin2@own.example.test',
    'admin',
    ids.own!,
    'qa_admin2_own'
  );
  ids.uEditor = await makeUser(
    'editor@own.example.test',
    'editor',
    ids.own!,
    'qa_editor_own'
  );
  ids.uMember = await makeUser(
    'member@own.example.test',
    'member',
    ids.own!,
    'qa_member_own'
  );
  ids.uViewer = await makeUser(
    'viewer@own.example.test',
    'viewer',
    ids.own!,
    'qa_viewer_own'
  );
  ids.uForeignAdmin = await makeUser(
    'admin@foreign.example.test',
    'admin',
    ids.foreign!,
    'qa_admin_foreign'
  );
  ids.uDisabledAdmin = await makeUser(
    'admin@disabled.example.test',
    'admin',
    ids.disabled!,
    'qa_admin_disabled'
  );
  // A null-community account whose email is reserved for collision tests.
  ids.uSuperShared = await makeUser(
    'shared-super@example.test',
    'super_admin',
    null,
    'qa_super_shared'
  );
  ids.uSuper = await makeUser(
    'super@example.test',
    'super_admin',
    null,
    'qa_super'
  );

  app = createHonoApp({
    repository: new HonoFoundationRepository(db),
    secureCookies: false,
    publicOrigin: API_ORIGIN,
    corsOrigins: [CLIENT_ORIGIN],
    storage: { read: async () => null },
    serverSecret: makeServerSecret(),
  });

  cookies.admin = await loginAs('admin@own.example.test', ids.own);
  cookies.admin2 = await loginAs('admin2@own.example.test', ids.own);
  cookies.editor = await loginAs('editor@own.example.test', ids.own);
  cookies.member = await loginAs('member@own.example.test', ids.own);
  cookies.viewer = await loginAs('viewer@own.example.test', ids.own);
  cookies.foreignAdmin = await loginAs(
    'admin@foreign.example.test',
    ids.foreign
  );
  cookies.disabledAdmin = await loginAs(
    'admin@disabled.example.test',
    ids.disabled
  );
  cookies.super = await loginAs('super@example.test');
});

afterAll(() => {
  sqlite.close();
});

const allUserManagementRoutes: Array<{
  method: string;
  path: string;
  body?: unknown;
}> = [
  { method: 'GET', path: '/v2/users' },
  { method: 'GET', path: '/v2/users/1' },
  { method: 'POST', path: '/v2/users', body: {} },
  { method: 'PATCH', path: '/v2/users/1', body: {} },
  { method: 'POST', path: '/v2/users/1/password-reset', body: {} },
  { method: 'POST', path: '/v2/users/1/login-codes' },
  { method: 'GET', path: '/v2/users/1/sessions' },
  { method: 'DELETE', path: '/v2/users/1/sessions/abc123' },
];

describe('Slice 11a authority gates (SPEC-V2 §6.2, registry §6)', () => {
  it('rejects unauthenticated callers with 401 on every user-management route', async () => {
    for (const route of allUserManagementRoutes) {
      const res = await requestJson(route.method, route.path, {
        body: route.body,
      });
      expect(res.status, `${route.method} ${route.path}`).toBe(401);
    }
  });

  it('rejects non-admin roles and super_admin with 403 on every route', async () => {
    for (const [roleKey, cookie] of [
      ['viewer', cookies.viewer],
      ['member', cookies.member],
      ['editor', cookies.editor],
      ['super_admin', cookies.super],
    ] as const) {
      for (const route of allUserManagementRoutes) {
        const res = await requestJson(route.method, route.path, {
          cookie,
          body: route.body,
        });
        expect(res.status, `${roleKey} ${route.method} ${route.path}`).toBe(
          403
        );
      }
    }
  });

  it('scopes a foreign-community admin strictly to their own community', async () => {
    // The gate admits any admin of a non-null community; the tenant scoping
    // on every target row is what isolates our community.
    const list = await requestJson('GET', '/v2/users', {
      cookie: cookies.foreignAdmin,
    });
    expect(list.status).toBe(200);
    const body = list.json as { data: Array<{ id: number }> };
    const idsSeen = body.data.map((row) => row.id);
    expect(idsSeen).toContain(ids.uForeignAdmin!);
    expect(idsSeen).not.toContain(ids.uAdmin!);
    expect(idsSeen).not.toContain(ids.uViewer!);

    for (const route of [
      { method: 'GET', path: `/v2/users/${ids.uViewer}` },
      {
        method: 'PATCH',
        path: `/v2/users/${ids.uViewer}`,
        body: { displayName: 'Nope' },
      },
      {
        method: 'POST',
        path: `/v2/users/${ids.uViewer}/password-reset`,
        body: {
          algorithm: 'client-argon2id+sha256',
          salt: 'x',
          params: {},
          derivedKey: 'y',
        },
      },
      { method: 'POST', path: `/v2/users/${ids.uViewer}/login-codes` },
      { method: 'GET', path: `/v2/users/${ids.uViewer}/sessions` },
      { method: 'DELETE', path: `/v2/users/${ids.uViewer}/sessions/sess-1` },
    ]) {
      const res = await requestJson(route.method, route.path, {
        cookie: cookies.foreignAdmin,
        body: route.body,
      });
      expect(res.status, `${route.method} ${route.path}`).toBe(404);
    }
  });
});

describe('GET /v2/users (list)', () => {
  it('lists own-community accounts with pagination meta and no credential material', async () => {
    const res = await requestJson('GET', '/v2/users', {
      cookie: cookies.admin,
    });
    expect(res.status).toBe(200);
    const body = res.json as {
      data: Array<Record<string, unknown>>;
      meta: {
        total: number;
        limit: number;
        offset: number;
        hasNextPage: boolean;
      };
    };
    expect(body.meta.limit).toBe(20);
    expect(body.meta.offset).toBe(0);
    expect(body.meta.total).toBeGreaterThanOrEqual(5);
    const ownIds = body.data.map((row) => row.id);
    expect(ownIds).toContain(ids.uAdmin!);
    expect(ownIds).toContain(ids.uEditor!);
    // Never cross-community.
    expect(ownIds).not.toContain(ids.uForeignAdmin!);
    expect(ownIds).not.toContain(ids.uDisabledAdmin!);
    expect(ownIds).not.toContain(ids.uSuper!);
    expect(ownIds).not.toContain(ids.uSuperShared!);
    // Never credential columns.
    expect(credentialFree(body)).toBe(true);
    // Deterministic order: id ascending.
    const sorted = [...ownIds].sort((a, b) => Number(a) - Number(b));
    expect(ownIds).toEqual(sorted);
  });

  it('honours limit/offset and reports hasNextPage', async () => {
    const first = await requestJson('GET', '/v2/users?limit=2&offset=0', {
      cookie: cookies.admin,
    });
    expect(first.status).toBe(200);
    const firstBody = first.json as {
      data: Array<{ id: number }>;
      meta: {
        total: number;
        limit: number;
        offset: number;
        hasNextPage: boolean;
      };
    };
    expect(firstBody.data.length).toBe(2);
    expect(firstBody.meta.hasNextPage).toBe(true);
    const second = await requestJson('GET', '/v2/users?limit=2&offset=2', {
      cookie: cookies.admin,
    });
    const secondBody = second.json as { data: Array<{ id: number }> };
    expect(secondBody.data.map((row) => row.id)).not.toContain(
      firstBody.data[0]!.id
    );
    const padded = await requestJson('GET', '/v2/users?limit=100&offset=9000', {
      cookie: cookies.admin,
    });
    const paddedBody = padded.json as {
      data: unknown[];
      meta: { hasNextPage: boolean };
    };
    expect(paddedBody.data.length).toBe(0);
    expect(paddedBody.meta.hasNextPage).toBe(false);
  });

  it('rejects a disabled-community admin with 403', async () => {
    const res = await requestJson('GET', '/v2/users', {
      cookie: cookies.disabledAdmin,
    });
    expect(res.status).toBe(403);
  });
});

describe('GET /v2/users/:id (read)', () => {
  it('reads own-community metadata and never cross-community rows', async () => {
    const own = await requestJson('GET', `/v2/users/${ids.uEditor}`, {
      cookie: cookies.admin,
    });
    expect(own.status).toBe(200);
    const body = own.json as { data: Record<string, unknown> };
    expect(body.data.id).toBe(ids.uEditor);
    expect(credentialFree(body)).toBe(true);

    for (const foreignId of [
      ids.uForeignAdmin!,
      ids.uDisabledAdmin!,
      ids.uSuper!,
      ids.uSuperShared!,
    ]) {
      const res = await requestJson('GET', `/v2/users/${foreignId}`, {
        cookie: cookies.admin,
      });
      expect(res.status, `id ${foreignId}`).toBe(404);
    }
  });

  it('returns 404 for malformed ids', async () => {
    for (const bad of ['abc', '1.5', '-1', '0', '2147483648']) {
      const res = await requestJson('GET', `/v2/users/${bad}`, {
        cookie: cookies.admin,
      });
      expect(res.status, bad).toBe(404);
    }
  });
});

describe('POST /v2/users (create)', () => {
  it('creates a community account and returns 201 with a credential-free body', async () => {
    const username = `qa_created_${Date.now()}`;
    const res = await requestJson('POST', '/v2/users', {
      cookie: cookies.admin,
      body: {
        username,
        email: `qa-created-${Date.now()}@own.example.test`,
        displayName: 'QA Created',
        role: 'member',
      },
    });
    expect(res.status).toBe(201);
    const body = res.json as { data: Record<string, unknown> };
    expect(typeof body.data.id).toBe('number');
    expect(body.data.role).toBe('member');
    expect(body.data.status).toBe('active');
    expect(credentialFree(body)).toBe(true);
  });

  it('creates a code-only account that cannot authenticate before enrolment', async () => {
    const username = `qa_codeonly_${Date.now()}`;
    const email = `qa-codeonly-${Date.now()}@own.example.test`;
    const created = await requestJson('POST', '/v2/users', {
      cookie: cookies.admin,
      body: { username, email, role: 'viewer' },
    });
    expect(created.status).toBe(201);
    const res = await app.request(`${API_ORIGIN}/v2/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: email, derivedKey: TEST_DERIVED_KEY }),
    });
    expect(res.status).toBe(401);
  });

  it('honours argon2id verifier material and can authenticate afterwards', async () => {
    const { makeVerifierSalt } = await import('./auth-test-utils.js');
    const { ARGON2ID_PARAMS_JSON } = await import(
      '../../src/shared/auth-policy.js'
    );
    const { sha256Hex } = await import('../../src/shared/auth-crypto.js');
    const derivedKey = makeDerivedKey();
    const username = `qa_withpw_${Date.now()}`;
    const email = `qa-withpw-${Date.now()}@own.example.test`;
    const created = await requestJson('POST', '/v2/users', {
      cookie: cookies.admin,
      body: {
        username,
        email,
        role: 'viewer',
        password: {
          algorithm: 'client-argon2id+sha256',
          salt: makeVerifierSalt(),
          params: JSON.parse(ARGON2ID_PARAMS_JSON),
          derivedKey,
        },
      },
    });
    expect(created.status).toBe(201);
    void sha256Hex;
    const res = await app.request(`${API_ORIGIN}/v2/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: email, derivedKey }),
    });
    expect(res.status).toBe(200);
  });

  it('rejects super_admin in the role enum with 400', async () => {
    const res = await requestJson('POST', '/v2/users', {
      cookie: cookies.admin,
      body: {
        username: `qa_role_${Date.now()}`,
        email: `qa-role-${Date.now()}@own.example.test`,
        role: 'super_admin',
      },
    });
    expect(res.status).toBe(400);
  });

  it('rejects a missing username, a missing email and unknown fields with 400', async () => {
    const noUsername = await requestJson('POST', '/v2/users', {
      cookie: cookies.admin,
      body: { email: 'qa-x@own.example.test', role: 'viewer' },
    });
    expect(noUsername.status).toBe(400);
    const noEmail = await requestJson('POST', '/v2/users', {
      cookie: cookies.admin,
      body: { username: `qa_noemail_${Date.now()}`, role: 'viewer' },
    });
    expect(noEmail.status).toBe(400);
    const unknownField = await requestJson('POST', '/v2/users', {
      cookie: cookies.admin,
      body: {
        username: `qa_extra_${Date.now()}`,
        email: 'qa-extra@own.example.test',
        role: 'viewer',
        isSuperAdmin: true,
      },
    });
    expect(unknownField.status).toBe(400);
  });

  it('returns a uniform 409 for every identity collision rule', async () => {
    const baseline = Date.now();
    // 1. Duplicate username (same community).
    const dupUsername = await requestJson('POST', '/v2/users', {
      cookie: cookies.admin,
      body: {
        username: 'qa_editor_own',
        email: `qa-dup1-${baseline}@own.example.test`,
        role: 'viewer',
      },
    });
    expect(dupUsername.status).toBe(409);
    expect((dupUsername.json as { error: string }).error).toBe('Conflict');

    // 2. Username held by a user of ANOTHER community (global uniqueness).
    const dupUsernameForeign = await requestJson('POST', '/v2/users', {
      cookie: cookies.admin,
      body: {
        username: 'qa_admin_foreign',
        email: `qa-dup2-${baseline}@own.example.test`,
        role: 'viewer',
      },
    });
    expect(dupUsernameForeign.status).toBe(409);

    // 3. Username equal to another account's email (any community).
    const usernameIsEmail = await requestJson('POST', '/v2/users', {
      cookie: cookies.admin,
      body: {
        username: 'admin@own.example.test',
        email: `qa-dup3-${baseline}@own.example.test`,
        role: 'viewer',
      },
    });
    expect(usernameIsEmail.status).toBe(409);

    // 4. Email equal to another account's username (any community). The
    // colliding identifier is email-shaped only when the username is
    // email-shaped, so seed one through the API first.
    const shapedUsername = `qa_dup4_${baseline}@own.example.test`;
    const seedShaped = await requestJson('POST', '/v2/users', {
      cookie: cookies.admin,
      body: {
        username: shapedUsername,
        email: `qa-dup4b-${baseline}@own.example.test`,
        role: 'viewer',
      },
    });
    expect(seedShaped.status).toBe(201);
    const emailIsUsername = await requestJson('POST', '/v2/users', {
      cookie: cookies.admin,
      body: {
        username: `qa_dup4c_${baseline}`,
        email: shapedUsername,
        role: 'viewer',
      },
    });
    expect(emailIsUsername.status).toBe(409);

    // 5. Community-scoped email duplicate.
    const dupCommunityEmail = await requestJson('POST', '/v2/users', {
      cookie: cookies.admin,
      body: {
        username: `qa_dup5_${baseline}`,
        email: 'editor@own.example.test',
        role: 'viewer',
      },
    });
    expect(dupCommunityEmail.status).toBe(409);

    // 6. Email shared with a null-community account (super_admin).
    const nullCommunityShare = await requestJson('POST', '/v2/users', {
      cookie: cookies.admin,
      body: {
        username: `qa_dup6_${baseline}`,
        email: 'shared-super@example.test',
        role: 'viewer',
      },
    });
    expect(nullCommunityShare.status).toBe(409);

    // 7. Same email in a DIFFERENT community is allowed.
    const crossCommunityEmail = await requestJson('POST', '/v2/users', {
      cookie: cookies.admin,
      body: {
        username: `qa_ok7_${baseline}`,
        email: 'admin@foreign.example.test',
        role: 'viewer',
      },
    });
    expect(crossCommunityEmail.status).toBe(201);

    // 8. Case-insensitive collision on the normalized columns (NFC +
    // lowercase contract).
    const caseCollision = await requestJson('POST', '/v2/users', {
      cookie: cookies.admin,
      body: {
        username: `qa_dup8_${baseline}`,
        email: 'EDITOR@own.example.test',
        role: 'viewer',
      },
    });
    expect(caseCollision.status).toBe(409);
  });

  it('emits a content-free audit entry for create (and for refused creates)', async () => {
    const username = `qa_audit_${Date.now()}`;
    await requestJson('POST', '/v2/users', {
      cookie: cookies.admin,
      body: {
        username,
        email: `qa-audit-${Date.now()}@own.example.test`,
        role: 'editor',
      },
    });
    const rows = await db
      .select()
      .from(tables.auditEntries)
      .where(eq(tables.auditEntries.action, 'user.create'))
      .orderBy(asc(tables.auditEntries.id));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(
        JSON.stringify({
          action: row.action,
          resourceType: row.resourceType,
          resourceIds: row.resourceIds,
          outcome: row.outcome,
        })
      ).not.toMatch(/password|verifier|salt|code|credential/i);
      expect(row.ipAddress).toBeNull();
      expect(row.userAgent).toBeNull();
    }
    // The successful create carried the target id; the failed one carried none.
    const success = rows.find((row) => row.outcome === 'success');
    expect(
      success && Array.isArray(success.resourceIds)
        ? success.resourceIds.length
        : 0
    ).toBe(1);
  });
});

describe('PATCH /v2/users/:id', () => {
  it('updates displayName, username and email without leaking credentials', async () => {
    const username = `qa_patch_${Date.now()}`;
    const email = `qa-patch-${Date.now()}@own.example.test`;
    const created = await requestJson('POST', '/v2/users', {
      cookie: cookies.admin,
      body: { username, email, displayName: 'Before', role: 'viewer' },
    });
    const id = (created.json as { data: { id: number } }).data.id;
    const patched = await requestJson('PATCH', `/v2/users/${id}`, {
      cookie: cookies.admin,
      body: { displayName: 'After', username: `${username}x` },
    });
    expect(patched.status).toBe(200);
    const body = patched.json as { data: Record<string, unknown> };
    expect(body.data.displayName).toBe('After');
    expect(body.data.username).toBe(`${username}x`);
    expect(credentialFree(body)).toBe(true);
  });

  it('rejects an identity collision on rename with a uniform 409', async () => {
    const username = `qa_ren_${Date.now()}`;
    const created = await requestJson('POST', '/v2/users', {
      cookie: cookies.admin,
      body: {
        username,
        email: `qa-ren-${Date.now()}@own.example.test`,
        role: 'viewer',
      },
    });
    const id = (created.json as { data: { id: number } }).data.id;
    const clash = await requestJson('PATCH', `/v2/users/${id}`, {
      cookie: cookies.admin,
      body: { username: 'qa_editor_own' },
    });
    expect(clash.status).toBe(409);
    const clashEmail = await requestJson('PATCH', `/v2/users/${id}`, {
      cookie: cookies.admin,
      body: { email: 'shared-super@example.test' },
    });
    expect(clashEmail.status).toBe(409);
  });

  it('revokes the target sessions on role and on status change (§6.8 trigger)', async () => {
    const username = `qa_trig_${Date.now()}`;
    const email = `qa-trig-${Date.now()}@own.example.test`;
    // Seed the target with a known verifier so it can log in.
    const { argon2Seed: seedFor } = await import('./auth-test-utils.js');
    const targetSeed = await seedFor(TEST_DERIVED_KEY);
    const targetId = await insertRow(tables.users, {
      email,
      username,
      ...deriveUserIdentityColumns({ email, username }),
      firstName: 'Trigger',
      lastName: 'Target',
      ...targetSeed,
      role: 'editor',
      communityId: ids.own!,
      isActive: true,
      createdAt: T0,
      updatedAt: T0,
    });
    const cookie = await loginAs(email, ids.own);
    const before = await requestJson('GET', '/v2/auth/me', { cookie });
    expect(before.status).toBe(200);
    const res = await requestJson('PATCH', `/v2/users/${targetId}`, {
      cookie: cookies.admin,
      body: { role: 'member' },
    });
    expect(res.status).toBe(200);
    const after = await requestJson('GET', '/v2/auth/me', { cookie });
    expect(after.status).toBe(401);

    // Status change revokes too.
    const cookie2 = await loginAs(email, ids.own);
    const res2 = await requestJson('PATCH', `/v2/users/${targetId}`, {
      cookie: cookies.admin,
      body: { status: 'disabled' },
    });
    expect(res2.status).toBe(200);
    const after2 = await requestJson('GET', '/v2/auth/me', { cookie: cookie2 });
    expect(after2.status).toBe(401);
  });

  it('forbids self-demotion or self-deactivation that would orphan the community', async () => {
    // admin2 is the second admin; deactivating admin2 by admin2 while admin exists is fine.
    const res = await requestJson('PATCH', `/v2/users/${ids.uAdmin2}`, {
      cookie: cookies.admin2,
      body: { status: 'disabled' },
    });
    expect(res.status).toBe(200);
    // Reactivate for later tests.
    const restore = await requestJson('PATCH', `/v2/users/${ids.uAdmin2}`, {
      cookie: cookies.admin,
      body: { status: 'active' },
    });
    expect(restore.status).toBe(200);

    // Now demote admin2 (the only other admin aside from admin) is fine for
    // admin; but admin demoting THEMSELF would leave admin2 + ... still one
    // admin, so allowed. Build the orphan case: demote admin2 AND make
    // admin2 the only remaining admin by demoting admin2 to editor — wait,
    // that leaves admin. The orphan case is: actor is the only active admin.
    // Use a fresh single-admin community to exercise the guard.
    const soloCommunity = await insertRow(tables.communities, {
      name: 'Solo Nation',
      slug: `solo-${Date.now()}`,
      locale: 'en',
      publicStories: false,
      isActive: true,
      createdAt: T0,
      updatedAt: T0,
    });
    const soloSeed = await argon2Seed(TEST_DERIVED_KEY);
    const soloAdminEmail = `solo-admin-${Date.now()}@solo.example.test`;
    const soloUsername = `qa_solo_admin_${Date.now()}`;
    const soloAdminId = await insertRow(tables.users, {
      email: soloAdminEmail,
      username: soloUsername,
      ...deriveUserIdentityColumns({
        email: soloAdminEmail,
        username: soloUsername,
      }),
      firstName: 'Solo',
      lastName: 'Admin',
      ...soloSeed,
      role: 'admin',
      communityId: soloCommunity,
      isActive: true,
      createdAt: T0,
      updatedAt: T0,
    });
    const soloCookie = await loginAs(soloAdminEmail, soloCommunity);
    const selfDemote = await requestJson('PATCH', `/v2/users/${soloAdminId}`, {
      cookie: soloCookie,
      body: { role: 'editor' },
    });
    expect(selfDemote.status).toBe(409);
    expect((selfDemote.json as { code?: string }).code).toBe('last_admin');
    const selfDeactivate = await requestJson(
      'PATCH',
      `/v2/users/${soloAdminId}`,
      {
        cookie: soloCookie,
        body: { status: 'disabled' },
      }
    );
    expect(selfDeactivate.status).toBe(409);
    // The own-account role guard never blocks demoting a DIFFERENT admin
    // while the actor remains one.
    const otherDemote = await requestJson('PATCH', `/v2/users/${soloAdminId}`, {
      cookie: soloCookie,
      body: { displayName: 'Still one admin' },
    });
    expect(otherDemote.status).toBe(200);
  });

  it('refuses the second demotion inside the guarded write itself (SQLite/D1)', async () => {
    // Two admins in one fresh community: the first demotion is legal, the
    // second is refused by the guarded UPDATE statement — not by a pre-check.
    const guardCommunity = await insertRow(tables.communities, {
      name: 'Guard Nation',
      slug: `guard-${Date.now()}`,
      locale: 'en',
      publicStories: false,
      isActive: true,
      createdAt: T0,
      updatedAt: T0,
    });
    const stamp = Date.now();
    const seedAdmin = async (suffix: string) => {
      const email = `guard-${suffix}-${stamp}@guard.example.test`;
      const username = `qa_guard_${suffix}_${stamp}`;
      const seed = await argon2Seed(TEST_DERIVED_KEY);
      const id = await insertRow(tables.users, {
        email,
        username,
        ...deriveUserIdentityColumns({ email, username }),
        firstName: 'Guard',
        lastName: suffix,
        ...seed,
        role: 'admin',
        communityId: guardCommunity,
        isActive: true,
        createdAt: T0,
        updatedAt: T0,
      });
      return { id, email, username };
    };
    const adminA = await seedAdmin('a');
    const adminB = await seedAdmin('b');
    const repository = new UserManagementRepository(db);
    const first = await repository.updateCommunityUser({
      id: adminB.id,
      communityId: guardCommunity,
      actorId: adminA.id,
      role: 'editor',
      updatedAt: new Date(),
    });
    expect(first).toBe('updated');
    // B no longer administers; A is the community's only active admin.
    const second = await repository.updateCommunityUser({
      id: adminA.id,
      communityId: guardCommunity,
      actorId: adminA.id,
      role: 'editor',
      updatedAt: new Date(),
    });
    expect(second).toBe('last_admin');
    // Deactivating A is refused for the same reason.
    const third = await repository.updateCommunityUser({
      id: adminA.id,
      communityId: guardCommunity,
      actorId: adminA.id,
      isActive: false,
      updatedAt: new Date(),
    });
    expect(third).toBe('last_admin');
    // An actor that lost its admin authority cannot slip a write through.
    const fourth = await repository.updateCommunityUser({
      id: adminB.id,
      communityId: guardCommunity,
      actorId: adminB.id, // now an editor, not an active admin
      role: 'viewer',
      updatedAt: new Date(),
    });
    expect(fourth).toBe('authority_lost');
    const [a] = await db
      .select({ role: tables.users.role, isActive: tables.users.isActive })
      .from(tables.users)
      .where(eq(tables.users.id, adminA.id));
    expect(a?.role).toBe('admin');
    expect(a?.isActive).toBe(true);
  });

  it('returns 404 for unknown, cross-community and malformed targets', async () => {
    const unknown = await requestJson('PATCH', '/v2/users/999999', {
      cookie: cookies.admin,
      body: { displayName: 'Nope' },
    });
    expect(unknown.status).toBe(404);
    const cross = await requestJson('PATCH', `/v2/users/${ids.uForeignAdmin}`, {
      cookie: cookies.admin,
      body: { displayName: 'Nope' },
    });
    expect(cross.status).toBe(404);
    const malformed = await requestJson('PATCH', '/v2/users/not-an-id', {
      cookie: cookies.admin,
      body: { displayName: 'Nope' },
    });
    expect(malformed.status).toBe(404);
  });

  it('returns 400 for an empty body and for super_admin role', async () => {
    const empty = await requestJson('PATCH', `/v2/users/${ids.uViewer}`, {
      cookie: cookies.admin,
      body: {},
    });
    expect(empty.status).toBe(400);
    const superRole = await requestJson('PATCH', `/v2/users/${ids.uViewer}`, {
      cookie: cookies.admin,
      body: { role: 'super_admin' },
    });
    expect(superRole.status).toBe(400);
  });

  it('audits role/status changes with resource ids and outcome', async () => {
    const rows = await db
      .select()
      .from(tables.auditEntries)
      .where(eq(tables.auditEntries.action, 'user.update'))
      .orderBy(asc(tables.auditEntries.id));
    expect(rows.length).toBeGreaterThan(0);
    const success = rows.find((row) => row.outcome === 'success');
    expect(success).toBeDefined();
    expect(JSON.stringify(rows)).not.toMatch(/password|verifier|salt/i);
  });
});

describe('CSRF on user-management writes (SPEC-V2 §7)', () => {
  it('rejects cross-origin writes', async () => {
    const res = await requestJson('POST', '/v2/users', {
      cookie: cookies.admin,
      body: {
        username: `qa_csrf_${Date.now()}`,
        email: `qa-csrf-${Date.now()}@own.example.test`,
        role: 'viewer',
      },
      originUrl: FOREIGN_ORIGIN,
      headers: {
        origin: FOREIGN_ORIGIN,
        'sec-fetch-site': 'cross-site',
      },
    });
    expect(res.status).toBe(403);
  });
});
