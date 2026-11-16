/**
 * Focused tests for the Slice 11a device-session list/revoke routes (#188):
 * GET /v2/users/:id/sessions and DELETE /v2/users/:id/sessions/:handle —
 * SPEC-V2 §6.8 (Session), §7 (Sessions); route registry §6. Metadata only —
 * never token digests and never the raw session id; the wire carries an
 * opaque per-deployment handle (base64url HMAC-SHA256 truncated to 22 chars).
 * Revoke sets the §6.8 tombstone (revoked_at/revoked_by).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHmac } from 'node:crypto';
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
import { deriveUserIdentityColumns } from '../../src/shared/utils/derived-columns.js';

const sqlite = new Sqlite(':memory:');
sqlite.pragma('foreign_keys = ON');
const db = drizzle(sqlite);
const tables = tablesFor(db);

const TEST_DERIVED_KEY = makeDerivedKey();
const T0 = new Date('2026-06-01T12:00:00.000Z');
const DEVICE_WINDOW_MS = 60 * 24 * 60 * 60 * 1000;

const API_ORIGIN = 'https://api.example.test';

let app: ReturnType<typeof createHonoApp>;
const ids: Record<string, number> = {};
const cookies: Record<string, string> = {};
const serverSecret = makeServerSecret();

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
  device = false
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
      derivedKey: TEST_DERIVED_KEY,
      ...(communitySlug === undefined ? {} : { communitySlug }),
      ...(device ? { deviceSession: true } : {}),
    }),
  });
  expect(res.status).toBe(200);
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

async function requestJson(
  method: string,
  path: string,
  options: { cookie?: string } = {}
) {
  const headers: Record<string, string> = {};
  if (options.cookie) headers.cookie = options.cookie;
  const res = await app.request(`${API_ORIGIN}${path}`, {
    method,
    headers,
  });
  const text = await res.text();
  return {
    status: res.status,
    headers: res.headers,
    text,
    json: text ? (JSON.parse(text) as unknown) : null,
  };
}

const credentialFree = (text: string): boolean =>
  !/tokenHash|token_hash|password|verifier|salt/i.test(text);

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

  const seedUser = async (
    email: string,
    role: string,
    communityId: number | null,
    username?: string
  ) =>
    insertRow(tables.users, {
      email,
      username: username ?? email.replace('@', '-').split('.')[0]!,
      ...deriveUserIdentityColumns({
        email,
        username: username ?? email.replace('@', '-').split('.')[0]!,
      }),
      firstName: role,
      lastName: 'Tester',
      ...(await argon2Seed(TEST_DERIVED_KEY)),
      role,
      communityId,
      isActive: true,
      createdAt: T0,
      updatedAt: T0,
    });

  ids.uAdmin = await seedUser(
    'admin@own.example.test',
    'admin',
    ids.own!,
    'qa_admin_own'
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
  ids.uMember2 = await seedUser(
    'member2@own.example.test',
    'member',
    ids.own!,
    'qa_member2_own'
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
    serverSecret,
  });

  cookies.admin = await loginAs('admin@own.example.test', ids.own!);
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

describe('device-session list/revoke authority gates (registry §6, §6.8)', () => {
  it('rejects unauthenticated callers with 401', async () => {
    const list = await requestJson('GET', `/v2/users/${ids.uMember}/sessions`);
    expect(list.status).toBe(401);
    const revoke = await requestJson(
      'DELETE',
      `/v2/users/${ids.uMember}/sessions/abc123`
    );
    expect(revoke.status).toBe(401);
  });

  it('rejects non-admin roles and super_admin with 403', async () => {
    for (const [roleKey, cookie] of [
      ['editor', cookies.editor],
      ['member', cookies.member],
      ['super_admin', cookies.super],
    ] as const) {
      const list = await requestJson(
        'GET',
        `/v2/users/${ids.uMember}/sessions`,
        { cookie }
      );
      expect(list.status, `${roleKey} list`).toBe(403);
      const revoke = await requestJson(
        'DELETE',
        `/v2/users/${ids.uMember}/sessions/abc123`,
        { cookie }
      );
      expect(revoke.status, `${roleKey} revoke`).toBe(403);
    }
  });

  it('returns 403 for a disabled-community admin (route is not on the recovery surface)', async () => {
    const list = await requestJson(
      'GET',
      `/v2/users/${ids.uDisabledMember}/sessions`,
      { cookie: cookies.disabledAdmin }
    );
    expect(list.status).toBe(403);
    const revoke = await requestJson(
      'DELETE',
      `/v2/users/${ids.uDisabledMember}/sessions/abc123`,
      { cookie: cookies.disabledAdmin }
    );
    expect(revoke.status).toBe(403);
  });

  it('returns 404 for cross-community targets', async () => {
    const list = await requestJson('GET', `/v2/users/${ids.uMember}/sessions`, {
      cookie: cookies.foreignAdmin,
    });
    expect(list.status).toBe(404);
    const revoke = await requestJson(
      'DELETE',
      `/v2/users/${ids.uMember}/sessions/sess-1`,
      { cookie: cookies.foreignAdmin }
    );
    expect(revoke.status).toBe(404);
  });
});

describe('GET /v2/users/:id/sessions', () => {
  it('lists only live device sessions, metadata only, never token hashes or raw ids', async () => {
    // Fresh device session for the member; the seeded standard session stays.
    const deviceCookie = await loginAs(
      'member@own.example.test',
      ids.own!,
      true
    );
    void deviceCookie;
    const res = await requestJson('GET', `/v2/users/${ids.uMember}/sessions`, {
      cookie: cookies.admin,
    });
    expect(res.status).toBe(200);
    expect(credentialFree(res.text)).toBe(true);
    const body = res.json as {
      data: Array<Record<string, unknown>>;
    };
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    const sessionRows = await db
      .select({
        id: tables.sessions.id,
        tokenHash: tables.sessions.tokenHash,
        kind: tables.sessions.kind,
        revokedAt: tables.sessions.revokedAt,
        idleExpiresAt: tables.sessions.idleExpiresAt,
        absoluteExpiresAt: tables.sessions.absoluteExpiresAt,
        expiresAt: tables.sessions.expiresAt,
      })
      .from(tables.sessions)
      .where(eq(tables.sessions.userId, ids.uMember!));
    for (const session of body.data) {
      expect(session.kind).toBe('device');
      expect(typeof session.handle).toBe('string');
      expect(String(session.handle)).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(Object.keys(session).sort()).toEqual([
        'absoluteExpiresAt',
        'createdAt',
        'handle',
        'idleExpiresAt',
        'kind',
        'lastSeenAt',
      ]);
      // The handle is never the raw session id (a token digest) and never
      // equals a stored token hash.
      for (const row of sessionRows) {
        expect(session.handle).not.toBe(row.id);
        expect(session.handle).not.toBe(row.tokenHash);
      }
      const created = new Date(session.createdAt as string).getTime();
      const idle = new Date(session.idleExpiresAt as string).getTime();
      expect(Number.isFinite(created)).toBe(true);
      expect(idle - created).toBe(DEVICE_WINDOW_MS);
    }
    // The standard session of the member is not listed (and the raw id is
    // not on the wire).
    const listedHandles = body.data.map((row) => String(row.handle));
    for (const row of sessionRows) {
      expect(listedHandles).not.toContain(row.id);
      expect(listedHandles).not.toContain(row.tokenHash);
    }
    // The handle is defined exactly as
    // base64url(HMAC-SHA256(serverSecret, "session-handle:" + sessions.id))
    // truncated to 22 chars — re-derive it for the live device rows.
    const nowMs = Date.now();
    const expectedHandles = sessionRows
      .filter((row) => row.kind === 'device' && row.revokedAt === null)
      .filter((row) => Number(row.expiresAt) > nowMs)
      .map((row) =>
        createHmac('sha256', serverSecret)
          .update(`session-handle:${row.id}`, 'utf8')
          .digest()
      )
      .map((digest) => digest.toString('base64url').slice(0, 22))
      .sort();
    expect([...listedHandles].sort()).toEqual(expectedHandles);
    const kinds = await db
      .select({ id: tables.sessions.id, kind: tables.sessions.kind })
      .from(tables.sessions)
      .where(eq(tables.sessions.userId, ids.uMember!));
    expect(
      kinds.filter((row) => row.kind === 'device').length
    ).toBeGreaterThanOrEqual(listedHandles.length);
  });

  it('returns an empty list when the account holds no live device sessions', async () => {
    const res = await requestJson('GET', `/v2/users/${ids.uMember2}/sessions`, {
      cookie: cookies.admin,
    });
    expect(res.status).toBe(200);
    expect((res.json as { data: unknown[] }).data).toEqual([]);
  });
});

describe('DELETE /v2/users/:id/sessions/:handle', () => {
  it('revokes a device session by handle (tombstone) and the account re-authenticates without it', async () => {
    // Fresh device session for member2 to revoke.
    const deviceCookie = await loginAs(
      'member2@own.example.test',
      ids.own!,
      true
    );
    const list = await requestJson(
      'GET',
      `/v2/users/${ids.uMember2}/sessions`,
      { cookie: cookies.admin }
    );
    const listed = (list.json as { data: Array<{ handle: string }> }).data;
    expect(listed.length).toBeGreaterThanOrEqual(1);
    const handle = listed[0]!.handle;

    const res = await requestJson(
      'DELETE',
      `/v2/users/${ids.uMember2}/sessions/${handle}`,
      { cookie: cookies.admin }
    );
    expect(res.status).toBe(204);
    expect(res.text).toBe('');

    // The revoked device session no longer authenticates.
    const after = await requestJson('GET', '/v2/auth/me', {
      cookie: deviceCookie,
    });
    expect(after.status).toBe(401);

    // The tombstone carries revoked_by (the acting admin), not a deletion.
    const underlying = await db
      .select({
        id: tables.sessions.id,
        revokedAt: tables.sessions.revokedAt,
        revokedBy: tables.sessions.revokedBy,
      })
      .from(tables.sessions)
      .where(eq(tables.sessions.userId, ids.uMember2!));
    const revoked = underlying.find((row) => row.revokedAt !== null);
    expect(revoked?.revokedBy).toBe(ids.uAdmin);

    // The member2 account's standard sessions are untouched.
    const member2Standard = await loginAs('member2@own.example.test', ids.own!);
    const me = await requestJson('GET', '/v2/auth/me', {
      cookie: member2Standard,
    });
    expect(me.status).toBe(200);

    // Audited, without the session handle nor the underlying raw id.
    const sessionIds = underlying.map((row) => row.id);
    const auditRows = await db
      .select()
      .from(tables.auditEntries)
      .where(eq(tables.auditEntries.action, 'user.session.revoke'))
      .orderBy(asc(tables.auditEntries.id));
    expect(auditRows.length).toBeGreaterThan(0);
    for (const row of auditRows) {
      expect(row.resourceType).toBe('session');
      expect(row.resourceIds).toEqual([]);
      const serialized = JSON.stringify(row);
      expect(serialized).not.toContain(handle);
      for (const sessionId of sessionIds) {
        expect(serialized).not.toContain(sessionId);
      }
      expect(row.communityId).toBe(ids.own);
    }
  });

  it('returns 404 for standard sessions, wrong users, foreign handles and replays', async () => {
    // Seed a fresh standard session for member2 and try to revoke it as a device session.
    await loginAs('member2@own.example.test', ids.own!);
    const standard = await db
      .select({ id: tables.sessions.id, kind: tables.sessions.kind })
      .from(tables.sessions)
      .where(eq(tables.sessions.userId, ids.uMember2!));
    const standardId = standard.find((row) => row.kind === 'standard')?.id;
    expect(standardId).toBeDefined();
    const standardAsHandle = await requestJson(
      'DELETE',
      `/v2/users/${ids.uMember2}/sessions/${standardId}`,
      { cookie: cookies.admin }
    );
    expect(standardAsHandle.status).toBe(404);

    // A device session of a DIFFERENT user cannot be revoked via this path:
    // its handle resolves only against the target user's own live sessions.
    const deviceCookie = await loginAs(
      'member@own.example.test',
      ids.own!,
      true
    );
    void deviceCookie;
    const memberList = await requestJson(
      'GET',
      `/v2/users/${ids.uMember}/sessions`,
      { cookie: cookies.admin }
    );
    const memberHandle = (
      memberList.json as { data: Array<{ handle: string }> }
    ).data[0]!.handle;
    const wrongUser = await requestJson(
      'DELETE',
      `/v2/users/${ids.uMember2}/sessions/${memberHandle}`,
      { cookie: cookies.admin }
    );
    expect(wrongUser.status).toBe(404);

    // Replaying the revoke is a 404, not a double effect.
    const first = await requestJson(
      'DELETE',
      `/v2/users/${ids.uMember}/sessions/${memberHandle}`,
      { cookie: cookies.admin }
    );
    expect(first.status).toBe(204);
    const replay = await requestJson(
      'DELETE',
      `/v2/users/${ids.uMember}/sessions/${memberHandle}`,
      { cookie: cookies.admin }
    );
    expect(replay.status).toBe(404);

    // Malformed handles never reach the database.
    const bad = await requestJson(
      'DELETE',
      `/v2/users/${ids.uMember2}/sessions/not valid!!`,
      { cookie: cookies.admin }
    );
    // Hono decodes %20; the pattern rejects the space either way.
    expect([404, 400]).toContain(bad.status);
  });
});
