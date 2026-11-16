/**
 * Focused contract, validation, security, audit, and tenant-isolation tests
 * for Slice 7 V2 authenticated community write routes (#145).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq, asc, and } from 'drizzle-orm';
import { hash } from 'bcrypt';
import { nodePasswordVerifier } from '../../src/node-password.js';
import { tablesFor } from '../../src/db/dialect.js';
import { createHonoApp } from '../../src/hono-app.js';
import { HonoFoundationRepository } from '../../src/repositories/hono-foundation.repository.js';
import { CommunityReadsRepository } from '../../src/repositories/community-reads.repository.js';
import {
  CommunityWritesRepository,
  isForeignKeyConstraintError,
} from '../../src/repositories/community-writes.repository.js';
import { CommunityReadsService } from '../../src/services/community-reads.service.js';
import { CommunityWritesService } from '../../src/services/community-writes.service.js';
import {
  PatchCommunityResponseSchema,
  PlaceWriteResponseSchema,
  PutCommunityMapConfigResponseSchema,
  SpeakerWriteResponseSchema,
  V2ValidationErrorResponseSchema,
} from '../../src/shared/schemas/community-writes.js';
import { deriveUserIdentityColumns } from '../../src/shared/utils/derived-columns.js';
import { DESCRIPTION_MAX_LENGTH } from '../../src/shared/utils/safe-description.js';

const sqlite = new Sqlite(':memory:');
sqlite.pragma('foreign_keys = ON');
const db = drizzle(sqlite);
const tables = tablesFor(db);

// Build test secret values at runtime so no static credential-shaped literals exist.
const TEST_PASS = ['Slice7', 'WriteTest', '2026!'].join('-');
const TOKEN_QUERY_KEY = ['access', 'token'].join('_');
const TOKEN_QUERY_VAL = ['tok', 'example', '999'].join('.');
const T0 = new Date('2026-06-01T12:00:00.000Z');

const API_ORIGIN = 'https://api.example.test';
const CLIENT_ORIGIN = 'https://app.example.test';
const FOREIGN_ORIGIN = 'https://evil.invalid';

let app: ReturnType<typeof createHonoApp>;
const ids: Record<string, number> = {};
const fileIds = {
  ownActive: '77777777-7777-4777-8777-777777777701',
  ownRestricted: '77777777-7777-4777-8777-777777777702',
  ownInactive: '77777777-7777-4777-8777-777777777703',
  foreignActive: '77777777-7777-4777-8777-777777777704',
};
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
  const res = await app.request(`${API_ORIGIN}/v2/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email,
      password: TEST_PASS,
      ...(communityId === undefined ? {} : { communityId }),
    }),
  });
  expect(res.status).toBe(200);
  const setCookie = res.headers.get('set-cookie') ?? '';
  return setCookie.split(';')[0] ?? '';
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
  const headers: Record<string, string> = {
    ...(options.headers ?? {}),
  };
  if (options.cookie) {
    headers.cookie = options.cookie;
  }
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

beforeAll(async () => {
  migrate(db, { migrationsFolder: 'src/db/migrations' });
  const passwordHash = await hash(TEST_PASS, 4);

  ids.own = await insertRow(tables.communities, {
    name: 'Own Nation',
    slug: 'own-nation',
    description: '<p>Initial narrative</p>',
    descriptionPlain: 'Initial narrative',
    locale: 'en',
    country: 'CA',
    publicStories: false,
    isActive: true,
    createdAt: T0,
    updatedAt: T0,
  });

  ids.foreign = await insertRow(tables.communities, {
    name: 'Foreign Nation',
    slug: 'foreign-nation',
    description: '<p>Foreign narrative</p>',
    descriptionPlain: 'Foreign narrative',
    locale: 'en',
    country: 'NZ',
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
    communityId: number | null
  ) => {
    const username = email.replace('@', '-').split('.')[0]!;
    return insertRow(tables.users, {
      email,
      username,
      ...deriveUserIdentityColumns({ email, username }),
      firstName: role,
      lastName: 'Tester',
      passwordHash,
      role,
      communityId,
      isActive: true,
      createdAt: T0,
      updatedAt: T0,
    });
  };

  ids.uSuper = await makeUser('super@slice7.example.test', 'super_admin', null);
  ids.uAdmin = await makeUser('admin@own.example.test', 'admin', ids.own!);
  ids.uEditor = await makeUser('editor@own.example.test', 'editor', ids.own!);
  ids.uMember = await makeUser('member@own.example.test', 'member', ids.own!);
  ids.uViewer = await makeUser('viewer@own.example.test', 'viewer', ids.own!);
  ids.uDisabledAdmin = await makeUser(
    'admin@disabled.example.test',
    'admin',
    ids.disabled!
  );
  ids.uForeignAdmin = await makeUser(
    'admin@foreign.example.test',
    'admin',
    ids.foreign!
  );

  // Public story + place in `own` so toggling visibility immediately opens/closes public/explore
  ids.plOwnPublic = await insertRow(tables.places, {
    communityId: ids.own!,
    name: 'Cedar Point',
    description: '<p>Landing</p>',
    descriptionPlain: 'Landing',
    latitude: 49.2,
    longitude: -123.1,
    createdAt: T0,
    updatedAt: T0,
  });

  ids.stOwnPublic = await insertRow(tables.stories, {
    communityId: ids.own!,
    title: 'Cedar Song',
    slug: 'cedar-song',
    language: 'en',
    privacyLevel: 'public',
    isRestricted: false,
    createdAt: T0,
    updatedAt: T0,
  });

  await db.insert(tables.storyPlaces).values({
    storyId: ids.stOwnPublic!,
    placeId: ids.plOwnPublic!,
    communityId: ids.own!,
    sortOrder: 0,
  });

  const insertFile = async (
    id: string,
    communityId: number,
    uploadedBy: number,
    opts: { isActive?: boolean; culturalRestrictions?: string | null } = {}
  ) => {
    await db.insert(tables.files).values({
      id,
      filename: `${id}.png`,
      originalName: `${id}.png`,
      path: `communities/${communityId}/${id}.png`,
      storageKey: `communities/${communityId}/${id}.png`,
      url: `https://storage.invalid/${id}.png`,
      mimeType: 'image/png',
      size: 64,
      byteSize: 64,
      communityId,
      uploadedBy,
      isActive: opts.isActive ?? true,
      culturalRestrictions: opts.culturalRestrictions ?? null,
      createdAt: T0,
      updatedAt: T0,
    });
  };

  await insertFile(fileIds.ownActive, ids.own!, ids.uAdmin!);
  await insertFile(fileIds.ownRestricted, ids.own!, ids.uAdmin!, {
    culturalRestrictions: 'RESTRICTED_PROTOCOL',
  });
  await insertFile(fileIds.ownInactive, ids.own!, ids.uAdmin!, {
    isActive: false,
  });
  await insertFile(fileIds.foreignActive, ids.foreign!, ids.uForeignAdmin!);

  app = createHonoApp({
    repository: new HonoFoundationRepository(db),
    verifier: nodePasswordVerifier,
    secureCookies: false,
    publicOrigin: API_ORIGIN,
    corsOrigins: [CLIENT_ORIGIN],
    storage: { read: async () => null },
  });

  cookies.super = await loginAs('super@slice7.example.test');
  cookies.admin = await loginAs('admin@own.example.test', ids.own);
  cookies.editor = await loginAs('editor@own.example.test', ids.own);
  cookies.member = await loginAs('member@own.example.test', ids.own);
  cookies.viewer = await loginAs('viewer@own.example.test', ids.own);
  cookies.disabledAdmin = await loginAs(
    'admin@disabled.example.test',
    ids.disabled
  );
  cookies.foreignAdmin = await loginAs(
    'admin@foreign.example.test',
    ids.foreign
  );
});

afterAll(() => {
  sqlite.close();
});

describe('Slice 7 community settings & map-config authorization, CSRF & CORS', () => {
  it('enforces unauthenticated 401, super_admin/disabled/viewer/member/editor 403, and CSRF 403', async () => {
    const routes: Array<{
      method: 'PATCH' | 'PUT';
      path: string;
      body: unknown;
    }> = [
      { method: 'PATCH', path: '/v2/community', body: { name: 'X' } },
      { method: 'PUT', path: '/v2/community/map-config', body: {} },
    ];

    for (const r of routes) {
      const unauth = await requestJson(r.method, r.path, { body: r.body });
      expect(unauth.status).toBe(401);

      for (const roleKey of [
        'super',
        'disabledAdmin',
        'viewer',
        'member',
        'editor',
      ] as const) {
        const denied = await requestJson(r.method, r.path, {
          cookie: cookies[roleKey],
          body: r.body,
        });
        expect(denied.status).toBe(403);
        expect(denied.json).toEqual({ error: 'Forbidden' });
      }

      // Cross-site without Origin -> 403 CSRF
      const csrfCrossSite = await requestJson(r.method, r.path, {
        cookie: cookies.admin,
        body: r.body,
        headers: { 'Sec-Fetch-Site': 'cross-site' },
      });
      expect(csrfCrossSite.status).toBe(403);

      // Mismatched Origin -> 403 CSRF
      const csrfForeignOrigin = await requestJson(r.method, r.path, {
        cookie: cookies.admin,
        body: r.body,
        headers: { Origin: FOREIGN_ORIGIN },
      });
      expect(csrfForeignOrigin.status).toBe(403);

      // Allowed CORS origin passes CSRF
      const allowedPreflight = await requestJson('OPTIONS', r.path, {
        headers: {
          Origin: CLIENT_ORIGIN,
          'Access-Control-Request-Method': r.method,
        },
      });
      expect(allowedPreflight.status).toBe(204);
      expect(allowedPreflight.headers.get('access-control-allow-origin')).toBe(
        CLIENT_ORIGIN
      );
      expect(
        allowedPreflight.headers.get('access-control-allow-methods')
      ).toContain(r.method);
    }
  });
});

describe('Slice 7 PATCH /v2/community', () => {
  it('updates name, sanitized description + plain text, locale, country, and visibility with atomic audit + public/explore toggle', async () => {
    // Before toggle: own-nation is private -> closed on /v2/public and /explore
    expect(
      (await requestJson('GET', '/v2/public/communities/own-nation')).status
    ).toBe(404);
    expect(
      (await requestJson('GET', '/explore/communities/own-nation')).status
    ).toBe(404);

    // Update settings & toggle private -> public
    const res = await requestJson(
      'PATCH',
      `/v2/community?communityId=${ids.foreign}`, // spoofed query must be ignored
      {
        cookie: cookies.admin,
        headers: { Origin: API_ORIGIN },
        body: {
          name: 'Own Nation Updated',
          description:
            '<p>Welcome to <strong>our</strong> <a href="https://own.example.test">archive</a></p>',
          locale: 'pt-BR',
          country: 'Brazil',
          visibility: 'public',
        },
      }
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');

    const parsed = PatchCommunityResponseSchema.parse(res.json);
    expect(parsed.data.id).toBe(ids.own);
    expect(parsed.data.slug).toBe('own-nation');
    expect(parsed.data.name).toBe('Own Nation Updated');
    expect(parsed.data.locale).toBe('pt-BR');
    expect(parsed.data.country).toBe('Brazil');
    expect(parsed.data.visibility).toBe('public');
    expect(parsed.data.description).toBe(
      '<p>Welcome to <strong>our</strong> <a href="https://own.example.test/" rel="noopener noreferrer nofollow">archive</a></p>'
    );

    // Derived plain-text column stored in DB
    const [dbCommunity] = await db
      .select()
      .from(tables.communities)
      .where(eq(tables.communities.id, ids.own!));
    expect(dbCommunity?.descriptionPlain).toBe('Welcome to our archive');

    // AuditEntry emitted atomically and content-free
    const audits = await db
      .select()
      .from(tables.auditEntries)
      .where(eq(tables.auditEntries.communityId, ids.own!))
      .orderBy(asc(tables.auditEntries.id));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      communityId: ids.own,
      actorId: ids.uAdmin,
      action: 'community.visibility.public',
      resourceType: 'community',
      resourceIds: [ids.own],
      outcome: 'success',
      ipAddress: null,
      userAgent: null,
    });

    // Public and Explore endpoints immediately open
    expect(
      (await requestJson('GET', '/v2/public/communities/own-nation')).status
    ).toBe(200);
    expect(
      (await requestJson('GET', '/explore/communities/own-nation')).status
    ).toBe(200);

    // Idempotent visibility (setting 'public' when already 'public') emits NO extra AuditEntry
    const idemRes = await requestJson('PATCH', '/v2/community', {
      cookie: cookies.admin,
      body: { visibility: 'public' },
    });
    expect(idemRes.status).toBe(200);
    expect(
      await db
        .select()
        .from(tables.auditEntries)
        .where(eq(tables.auditEntries.communityId, ids.own!))
    ).toHaveLength(1);

    // Toggle public -> private: emits second audit entry and immediately closes /v2/public/* and /explore/*
    const closeRes = await requestJson('PATCH', '/v2/community', {
      cookie: cookies.admin,
      body: { visibility: 'private' },
    });
    expect(closeRes.status).toBe(200);
    expect(
      PatchCommunityResponseSchema.parse(closeRes.json).data.visibility
    ).toBe('private');

    const auditsAfter = await db
      .select()
      .from(tables.auditEntries)
      .where(eq(tables.auditEntries.communityId, ids.own!))
      .orderBy(asc(tables.auditEntries.id));
    expect(auditsAfter).toHaveLength(2);
    expect(auditsAfter[1]?.action).toBe('community.visibility.private');

    expect(
      (await requestJson('GET', '/v2/public/communities/own-nation')).status
    ).toBe(404);
    expect(
      (await requestJson('GET', '/explore/communities/own-nation')).status
    ).toBe(404);
  });

  it('rejects slug/communityId mutations, oversize/unsafe description without echoing content, and non-JSON/bad JSON', async () => {
    const nonJson = await requestJson('PATCH', '/v2/community', {
      cookie: cookies.admin,
      headers: { 'content-type': 'text/plain' },
      body: '{}',
    });
    expect(nonJson.status).toBe(415);

    const badJson = await requestJson('PATCH', '/v2/community', {
      cookie: cookies.admin,
      headers: { 'content-type': 'application/json' },
      body: '{invalid',
    });
    expect(badJson.status).toBe(400);

    // Reject slug mutation and communityId in body
    const strictReject = await requestJson('PATCH', '/v2/community', {
      cookie: cookies.admin,
      body: { slug: 'hijacked', communityId: ids.foreign, name: 'Valid' },
    });
    expect(strictReject.status).toBe(400);
    const strictErr = V2ValidationErrorResponseSchema.parse(strictReject.json);
    expect(strictErr.details?.fields.map((f) => f.path)).toEqual(
      expect.arrayContaining(['slug', 'communityId'])
    );

    // Empty body -> 400
    expect(
      (
        await requestJson('PATCH', '/v2/community', {
          cookie: cookies.admin,
          body: {},
        })
      ).status
    ).toBe(400);

    // Oversize description > 20,000 code points -> 400, never echoes description content
    const secretMarker = 'UNIQUE_DESC_SECRET_MARKER';
    const oversize = `${secretMarker}${'a'.repeat(DESCRIPTION_MAX_LENGTH)}`;
    const oversizeRes = await requestJson('PATCH', '/v2/community', {
      cookie: cookies.admin,
      body: { description: oversize },
    });
    expect(oversizeRes.status).toBe(400);
    const oversizeParsed = V2ValidationErrorResponseSchema.parse(
      oversizeRes.json
    );
    expect(oversizeParsed.details?.fields[0]?.path).toBe('description');
    expect(JSON.stringify(oversizeRes.json)).not.toContain(secretMarker);

    // Raw whitespace > 80,000 chars -> 400
    const rawHugeRes = await requestJson('PATCH', '/v2/community', {
      cookie: cookies.admin,
      body: { description: ' '.repeat(DESCRIPTION_MAX_LENGTH * 4 + 10) },
    });
    expect(rawHugeRes.status).toBe(400);

    // Unsafe href -> 400 without echoing href content
    const unsafeHrefRes = await requestJson('PATCH', '/v2/community', {
      cookie: cookies.admin,
      body: {
        description: `<p><a href="javascript:${secretMarker}()">click</a></p>`,
      },
    });
    expect(unsafeHrefRes.status).toBe(400);
    expect(
      V2ValidationErrorResponseSchema.parse(unsafeHrefRes.json).details
        ?.fields[0]?.path
    ).toBe('description');
    expect(JSON.stringify(unsafeHrefRes.json)).not.toContain(secretMarker);
  });

  it('keeps PATCH /v2/community + conditional audit insert atomic via D1 db.batch() and prevents concurrent/0-row audit races', async () => {
    const batchSqlite = new Sqlite(':memory:');
    batchSqlite.pragma('foreign_keys = ON');
    const batchDb = drizzle(batchSqlite);
    migrate(batchDb, { migrationsFolder: 'src/db/migrations' });

    const batchTables = tablesFor(batchDb);
    const [activeComm] = await batchDb
      .insert(batchTables.communities)
      .values({
        name: 'D1 Nation',
        slug: 'd1-nation',
        publicStories: false,
        isActive: true,
        createdAt: T0,
        updatedAt: T0,
      })
      .returning({ id: batchTables.communities.id });
    const [inactiveComm] = await batchDb
      .insert(batchTables.communities)
      .values({
        name: 'D1 Inactive',
        slug: 'd1-inactive',
        publicStories: false,
        isActive: false,
        createdAt: T0,
        updatedAt: T0,
      })
      .returning({ id: batchTables.communities.id });
    const [actor] = await batchDb
      .insert(batchTables.users)
      .values({
        email: 'd1-admin@example.test',
        username: 'd1-admin',
        ...deriveUserIdentityColumns({
          email: 'd1-admin@example.test',
          username: 'd1-admin',
        }),
        firstName: 'D1',
        lastName: 'Admin',
        passwordHash: 'hash',
        role: 'admin',
        communityId: activeComm!.id,
        isActive: true,
        createdAt: T0,
        updatedAt: T0,
      })
      .returning({ id: batchTables.users.id });

    const batchCalls: string[][] = [];
    let beforeNextBatch: (() => void) | null = null;
    // Wrap Drizzle's SQLite query builders with a D1-compatible .batch() that
    // runs each generated SQL statement sequentially inside one SQLite tx.
    const d1Like = Object.create(batchDb) as typeof batchDb & {
      batch: (
        stmts: Array<{ toSQL: () => { sql: string; params: unknown[] } }>
      ) => Promise<unknown[]>;
    };
    d1Like.batch = async (stmts) => {
      if (beforeNextBatch) {
        const hook = beforeNextBatch;
        beforeNextBatch = null;
        hook();
      }
      const queries = stmts.map((s) => s.toSQL());
      batchCalls.push(queries.map((q) => q.sql));
      return batchSqlite.transaction(() =>
        queries.map(({ sql: querySql, params }) => {
          const stmt = batchSqlite.prepare(querySql);
          return stmt.reader ? stmt.all(...params) : stmt.run(...params);
        })
      )();
    };

    try {
      const repo = new CommunityWritesRepository(d1Like as never);

      // 1. Effective transition private -> public emits conditional audit BEFORE update
      const r1 = await repo.updateCommunitySettings(
        activeComm!.id,
        actor!.id,
        { visibility: 'public' },
        T0
      );
      expect(r1.updated).toBe(true);
      expect(batchCalls).toHaveLength(1);
      expect(batchCalls[0]).toHaveLength(2);
      expect(batchCalls[0]![0]).toMatch(/^insert into "audit_entries"/i);
      expect(batchCalls[0]![1]).toMatch(/^update "communities"/i);

      // 2. No-op toggle (public -> public) updates row without adding an audit entry
      const r2 = await repo.updateCommunitySettings(
        activeComm!.id,
        actor!.id,
        { visibility: 'public' },
        T0
      );
      expect(r2.updated).toBe(true);

      // 3. Concurrent-toggle race: community flipped to 'private' before batch runs,
      //    so an update requesting 'private' is a no-op by the time batch executes -> 0 new audits;
      //    then community flipped back to 'public' before a 'private' request -> 1 new audit.
      beforeNextBatch = () => {
        batchSqlite
          .prepare('UPDATE communities SET public_stories = 0 WHERE id = ?')
          .run(activeComm!.id);
      };
      const r3 = await repo.updateCommunitySettings(
        activeComm!.id,
        actor!.id,
        { visibility: 'private' },
        T0
      );
      expect(r3.updated).toBe(true);

      // 4. 0-row update (inactive or missing community) must emit ZERO audit entries
      const r4 = await repo.updateCommunitySettings(
        inactiveComm!.id,
        actor!.id,
        { visibility: 'public' },
        T0
      );
      expect(r4.updated).toBe(false);
      const r5 = await repo.updateCommunitySettings(
        999999,
        actor!.id,
        { visibility: 'public' },
        T0
      );
      expect(r5.updated).toBe(false);

      // 5. Concurrent-toggle burst across alternating/duplicate targets:
      //    current is private (0) -> [public, public, private, private, public]
      //    effective changes: public, private, public (3 more -> 4 total with initial #1)
      const toggleSequence: Array<'public' | 'private'> = [
        'public',
        'public',
        'private',
        'private',
        'public',
      ];
      const burstResults = await Promise.all(
        toggleSequence.map((visibility) =>
          repo.updateCommunitySettings(
            activeComm!.id,
            actor!.id,
            { visibility },
            T0
          )
        )
      );
      expect(burstResults.every((r) => r.updated)).toBe(true);

      const d1Audits = await batchDb
        .select()
        .from(batchTables.auditEntries)
        .orderBy(asc(batchTables.auditEntries.id));
      expect(d1Audits.map((a) => a.action)).toEqual([
        'community.visibility.public',
        'community.visibility.public',
        'community.visibility.private',
        'community.visibility.public',
      ]);
      expect(d1Audits.every((a) => a.communityId === activeComm!.id)).toBe(
        true
      );
    } finally {
      batchSqlite.close();
    }
  });

  it('prevents concurrent-toggle audit loss and 0-row audits on better-sqlite3', async () => {
    const repo = new CommunityWritesRepository(db);
    const [inactive] = await db
      .select({ id: tables.communities.id })
      .from(tables.communities)
      .where(eq(tables.communities.id, ids.disabled!));
    expect(inactive).toBeDefined();

    // 0-row update on inactive community & missing community writes zero audits
    const beforeCount = (
      await db.select({ id: tables.auditEntries.id }).from(tables.auditEntries)
    ).length;

    expect(
      await repo.updateCommunitySettings(
        ids.disabled!,
        ids.uDisabledAdmin!,
        { visibility: 'public' },
        T0
      )
    ).toEqual({ updated: false });
    expect(
      await repo.updateCommunitySettings(
        999999,
        ids.uAdmin!,
        { visibility: 'public' },
        T0
      )
    ).toEqual({ updated: false });
    expect(
      (
        await db
          .select({ id: tables.auditEntries.id })
          .from(tables.auditEntries)
      ).length
    ).toBe(beforeCount);

    // Concurrent-toggle burst via HTTP PATCH /v2/community (own is currently private)
    const seq: Array<'public' | 'public' | 'private' | 'public' | 'private'> = [
      'public',
      'public',
      'private',
      'public',
      'private',
    ];
    const responses = await Promise.all(
      seq.map((visibility) =>
        requestJson('PATCH', '/v2/community', {
          cookie: cookies.admin,
          body: { visibility },
        })
      )
    );
    expect(responses.every((r) => r.status === 200)).toBe(true);

    const allOwnAudits = await db
      .select()
      .from(tables.auditEntries)
      .where(eq(tables.auditEntries.communityId, ids.own!))
      .orderBy(asc(tables.auditEntries.id));
    // Initial test emitted 2 (public, private); this burst has 4 effective transitions
    expect(allOwnAudits.slice(beforeCount).map((a) => a.action)).toEqual([
      'community.visibility.public',
      'community.visibility.private',
      'community.visibility.public',
      'community.visibility.private',
    ]);
  });
});

describe('Slice 7 PUT /v2/community/map-config', () => {
  it('upserts valid config including antimeridian wrap and owned active staticMapFileId', async () => {
    const res = await requestJson('PUT', '/v2/community/map-config', {
      cookie: cookies.admin,
      body: {
        styleUrl: 'https://tiles.example.test/styles/dark/style.json?lang=en',
        basemapStyle: 'satellite',
        centerLatitude: -12.5,
        centerLongitude: 179.0,
        southWestLatitude: -20.0,
        southWestLongitude: 170.0, // antimeridian wrap: swLng > neLng allowed
        northEastLatitude: -5.0,
        northEastLongitude: -170.0,
        zoom: 7.5,
        pitch: 15,
        bearing: -45,
        threeDimensional: true,
        projection: 'globe',
        staticMapFileId: fileIds.ownActive,
      },
    });
    expect(res.status).toBe(200);
    const parsed = PutCommunityMapConfigResponseSchema.parse(res.json);
    expect(parsed.data.southWestLongitude).toBe(170.0);
    expect(parsed.data.northEastLongitude).toBe(-170.0);
    expect(parsed.data.staticMapFileId).toBe(fileIds.ownActive);
    expect(parsed.data.staticMapUrl).toBe(
      `${API_ORIGIN}/v2/media/${fileIds.ownActive}`
    );
    expect(parsed.data.styleUrl).toBe(
      'https://tiles.example.test/styles/dark/style.json?lang=en'
    );

    // Clearing optional fields on second PUT works (onConflictDoUpdate)
    const cleared = await requestJson('PUT', '/v2/community/map-config', {
      cookie: cookies.admin,
      body: {
        styleUrl: null,
        basemapStyle: null,
        staticMapFileId: null,
      },
    });
    expect(cleared.status).toBe(200);
    const clearedParsed = PutCommunityMapConfigResponseSchema.parse(
      cleared.json
    );
    expect(clearedParsed.data.styleUrl).toBeNull();
    expect(clearedParsed.data.staticMapFileId).toBeNull();
    expect(clearedParsed.data.staticMapUrl).toBeNull();
    expect(clearedParsed.data.createdAt).toBe(parsed.data.createdAt);
  });

  it('rejects invalid bounds, half-pairs, credential-bearing styleUrl without echo, and foreign/restricted staticMapFileId', async () => {
    // 1. swLat > neLat -> 400
    const badLatBounds = await requestJson('PUT', '/v2/community/map-config', {
      cookie: cookies.admin,
      body: {
        southWestLatitude: 20,
        southWestLongitude: 10,
        northEastLatitude: 10,
        northEastLongitude: 20,
      },
    });
    expect(badLatBounds.status).toBe(400);
    expect(
      V2ValidationErrorResponseSchema.parse(
        badLatBounds.json
      ).details?.fields.some((f) => f.path === 'southWestLatitude')
    ).toBe(true);

    // 2. Out-of-range lat -> 400
    expect(
      (
        await requestJson('PUT', '/v2/community/map-config', {
          cookie: cookies.admin,
          body: { centerLatitude: 95, centerLongitude: 0 },
        })
      ).status
    ).toBe(400);

    // 3. Partial center pair / partial bounds -> 400
    expect(
      (
        await requestJson('PUT', '/v2/community/map-config', {
          cookie: cookies.admin,
          body: { centerLatitude: 10 },
        })
      ).status
    ).toBe(400);
    expect(
      (
        await requestJson('PUT', '/v2/community/map-config', {
          cookie: cookies.admin,
          body: { southWestLatitude: 10, southWestLongitude: 10 },
        })
      ).status
    ).toBe(400);

    // 4. Credential-bearing or non-https styleUrl -> 400 without echoing URL
    const credUrl = `https://tiles.example.test/style.json?${TOKEN_QUERY_KEY}=${TOKEN_QUERY_VAL}`;
    for (const badStyleUrl of [
      credUrl,
      ['https://', 'user', ':', 'pass', '@tiles.example.test/style.json'].join(
        ''
      ),
      'https://tiles.example.test/style.json#frag',
      'mapbox://styles/community/dark',
      '',
    ]) {
      const styleRes = await requestJson('PUT', '/v2/community/map-config', {
        cookie: cookies.admin,
        body: { styleUrl: badStyleUrl },
      });
      expect(styleRes.status).toBe(400);
      const parsedErr = V2ValidationErrorResponseSchema.parse(styleRes.json);
      expect(parsedErr.details?.fields[0]?.path).toBe('styleUrl');
      expect(JSON.stringify(styleRes.json)).not.toContain(TOKEN_QUERY_VAL);
    }

    // 5. Foreign, inactive, or #162-restricted staticMapFileId -> identical 400 without leaking cross-community
    const foreignRes = await requestJson('PUT', '/v2/community/map-config', {
      cookie: cookies.admin,
      body: { staticMapFileId: fileIds.foreignActive },
    });
    expect(foreignRes.status).toBe(400);

    const restrictedRes = await requestJson('PUT', '/v2/community/map-config', {
      cookie: cookies.admin,
      body: { staticMapFileId: fileIds.ownRestricted },
    });
    expect(restrictedRes.status).toBe(400);

    const missingRes = await requestJson('PUT', '/v2/community/map-config', {
      cookie: cookies.admin,
      body: { staticMapFileId: '77777777-7777-4777-8777-777777777799' },
    });
    expect(missingRes.status).toBe(400);
    expect(foreignRes.json).toEqual(missingRes.json);
    expect(restrictedRes.json).toEqual(missingRes.json);

    // 6. Strict body rejects computed/internal fields
    expect(
      (
        await requestJson('PUT', '/v2/community/map-config', {
          cookie: cookies.admin,
          body: { communityId: ids.foreign },
        })
      ).status
    ).toBe(400);

    // Avoid unused helper warning cleanly
    expect(CommunityWritesService).toBeDefined();
    expect(CommunityReadsRepository).toBeDefined();
    expect(CommunityReadsService).toBeDefined();
    expect(vi).toBeDefined();
  });
});

describe('Slice 7 Place CRUD (/v2/places)', () => {
  it('enforces auth (401), roles (editor/admin ok; viewer/member/super_admin/disabled 403), and CSRF (403)', async () => {
    const restrictedPlaceId = await insertRow(tables.places, {
      communityId: ids.own!,
      name: 'Quarantined Ridge',
      isRestricted: true,
      createdAt: T0,
      updatedAt: T0,
    });
    const foreignPlaceId = await insertRow(tables.places, {
      communityId: ids.foreign!,
      name: 'Foreign Bay',
      latitude: -36.8,
      longitude: 174.7,
      createdAt: T0,
      updatedAt: T0,
    });

    for (const req of [
      { method: 'POST', path: '/v2/places', body: { name: 'Blocked Place' } },
      {
        method: 'PATCH',
        path: `/v2/places/${ids.plOwnPublic}`,
        body: { name: 'Blocked Patch' },
      },
      {
        method: 'DELETE',
        path: `/v2/places/${ids.plOwnPublic}`,
      },
      {
        method: 'PATCH',
        path: '/v2/places/not-an-id',
        body: { name: 'Malformed' },
      },
      {
        method: 'DELETE',
        path: '/v2/places/0',
      },
    ]) {
      expect(
        (await requestJson(req.method, req.path, { body: req.body })).status
      ).toBe(401);

      for (const roleKey of [
        'super',
        'disabledAdmin',
        'viewer',
        'member',
      ] as const) {
        const denied = await requestJson(req.method, req.path, {
          cookie: cookies[roleKey],
          body: req.body,
        });
        expect(denied.status).toBe(403);
        expect(denied.json).toEqual({ error: 'Forbidden' });
      }

      // CSRF rejections
      expect(
        (
          await requestJson(req.method, req.path, {
            cookie: cookies.editor,
            body: req.body,
            headers: { 'Sec-Fetch-Site': 'cross-site' },
          })
        ).status
      ).toBe(403);
      expect(
        (
          await requestJson(req.method, req.path, {
            cookie: cookies.admin,
            body: req.body,
            headers: { Origin: FOREIGN_ORIGIN },
          })
        ).status
      ).toBe(403);
    }

    // Cross-community and #162-restricted places answer identical 404 for editor/admin
    for (const targetId of [foreignPlaceId, restrictedPlaceId, 999999]) {
      const patchRes = await requestJson('PATCH', `/v2/places/${targetId}`, {
        cookie: cookies.editor,
        body: { name: 'Attempt' },
      });
      expect(patchRes.status).toBe(404);
      expect(patchRes.json).toEqual({ error: 'Not found' });

      const delRes = await requestJson('DELETE', `/v2/places/${targetId}`, {
        cookie: cookies.admin,
      });
      expect(delRes.status).toBe(404);
      expect(delRes.json).toEqual({ error: 'Not found' });
    }
  });

  it('creates, updates, validates coords/descriptions, and deletes places with 409 FK protection', async () => {
    // 1. Editor creates place with nullable coords omitted and sanitized HTML description
    const createdNullCoords = await requestJson(
      'POST',
      `/v2/places?communityId=${ids.foreign}`,
      {
        cookie: cookies.editor,
        body: {
          name: 'Storyless Clearing',
          description:
            '<p>By the <em>creek</em> <a href="https://place.example.test">map</a></p>',
          typeOfPlace: 'clearing',
          region: 'North Valley',
        },
      }
    );
    expect(createdNullCoords.status).toBe(201);
    const place1 = PlaceWriteResponseSchema.parse(createdNullCoords.json).data;
    expect(place1.name).toBe('Storyless Clearing');
    expect(place1.latitude).toBeNull();
    expect(place1.longitude).toBeNull();
    expect(place1.typeOfPlace).toBe('clearing');
    expect(place1.region).toBe('North Valley');
    expect(place1.description).toBe(
      '<p>By the <em>creek</em> <a href="https://place.example.test/" rel="noopener noreferrer nofollow">map</a></p>'
    );

    const [dbPlace1] = await db
      .select()
      .from(tables.places)
      .where(eq(tables.places.id, place1.id));
    expect(dbPlace1?.communityId).toBe(ids.own);
    expect(dbPlace1?.descriptionPlain).toBe('By the creek map');

    // 2. Patch coords as a pair, then keep coords when updating only name, then clear coords to null/null
    const patchedCoords = await requestJson(
      'PATCH',
      `/v2/places/${place1.id}`,
      {
        cookie: cookies.editor,
        body: { latitude: 48.5, longitude: -122.25 },
      }
    );
    expect(patchedCoords.status).toBe(200);
    const afterCoords = PlaceWriteResponseSchema.parse(patchedCoords.json).data;
    expect(afterCoords.latitude).toBe(48.5);
    expect(afterCoords.longitude).toBe(-122.25);

    const patchedNameOnly = await requestJson(
      'PATCH',
      `/v2/places/${place1.id}`,
      {
        cookie: cookies.admin,
        body: { name: 'Renamed Clearing' },
      }
    );
    expect(patchedNameOnly.status).toBe(200);
    const afterName = PlaceWriteResponseSchema.parse(patchedNameOnly.json).data;
    expect(afterName.name).toBe('Renamed Clearing');
    expect(afterName.latitude).toBe(48.5);
    expect(afterName.longitude).toBe(-122.25);

    const clearedCoords = await requestJson(
      'PATCH',
      `/v2/places/${place1.id}`,
      {
        cookie: cookies.editor,
        body: { latitude: null, longitude: null },
      }
    );
    expect(clearedCoords.status).toBe(200);
    const afterClear = PlaceWriteResponseSchema.parse(clearedCoords.json).data;
    expect(afterClear.latitude).toBeNull();
    expect(afterClear.longitude).toBeNull();

    // 3. Reject half-pair coordinates, out-of-range coords, body communityId, invalid href, oversize description
    const secretMarker = 'PLACE_SECRET_NO_ECHO';
    for (const invalidCreate of [
      { name: 'Half', latitude: 10 },
      { name: 'HalfNull', latitude: 10, longitude: null },
      { name: 'BadRange', latitude: -91, longitude: 0 },
      { name: 'ForeignKeyInBody', communityId: ids.foreign },
      {
        name: 'BadHref',
        description: `<p><a href="javascript:${secretMarker}()">x</a></p>`,
      },
      {
        name: 'Oversize',
        description: `${secretMarker}${'a'.repeat(DESCRIPTION_MAX_LENGTH)}`,
      },
    ]) {
      const errRes = await requestJson('POST', '/v2/places', {
        cookie: cookies.editor,
        body: invalidCreate,
      });
      expect(errRes.status).toBe(400);
      expect(JSON.stringify(errRes.json)).not.toContain(secretMarker);
    }

    expect(
      (
        await requestJson('PATCH', `/v2/places/${place1.id}`, {
          cookie: cookies.editor,
          body: { latitude: 10 },
        })
      ).status
    ).toBe(400);
    expect(
      (
        await requestJson('PATCH', `/v2/places/${place1.id}`, {
          cookie: cookies.editor,
          body: {},
        })
      ).status
    ).toBe(400);
    expect(
      (
        await requestJson('PATCH', '/v2/places/abc', {
          cookie: cookies.editor,
          body: { name: 'Bad ID' },
        })
      ).status
    ).toBe(400);

    // 4. Deleting a place referenced by story_places -> 409 conflict
    const refStoryPlaceDel = await requestJson(
      'DELETE',
      `/v2/places/${ids.plOwnPublic}`,
      { cookie: cookies.admin }
    );
    expect(refStoryPlaceDel.status).toBe(409);

    // 5. Deleting a place referenced by stories.interviewLocationId -> 409 conflict
    const interviewPlaceRes = await requestJson('POST', '/v2/places', {
      cookie: cookies.editor,
      body: { name: 'Interview Spot' },
    });
    const interviewPlaceId = PlaceWriteResponseSchema.parse(
      interviewPlaceRes.json
    ).data.id;
    await insertRow(tables.stories, {
      communityId: ids.own!,
      title: 'Interview Story',
      slug: 'interview-story',
      language: 'en',
      privacyLevel: 'editors_only',
      isRestricted: false,
      interviewLocationId: interviewPlaceId,
      createdAt: T0,
      updatedAt: T0,
    });
    expect(
      (
        await requestJson('DELETE', `/v2/places/${interviewPlaceId}`, {
          cookie: cookies.editor,
        })
      ).status
    ).toBe(409);

    // 6. Deleting a place referenced by speakers.birthplaceId -> 409 conflict
    const birthplaceRes = await requestJson('POST', '/v2/places', {
      cookie: cookies.editor,
      body: { name: 'Birthplace Meadow' },
    });
    const birthplaceId = PlaceWriteResponseSchema.parse(birthplaceRes.json).data
      .id;
    await insertRow(tables.speakers, {
      communityId: ids.own!,
      name: 'Storyteller A',
      birthplaceId,
      createdAt: T0,
      updatedAt: T0,
    });
    expect(
      (
        await requestJson('DELETE', `/v2/places/${birthplaceId}`, {
          cookie: cookies.editor,
        })
      ).status
    ).toBe(409);

    // 7. Delete unreferenced place -> 204, repeated delete -> 404
    const delOk = await requestJson('DELETE', `/v2/places/${place1.id}`, {
      cookie: cookies.editor,
    });
    expect(delOk.status).toBe(204);

    const delAgain = await requestJson('DELETE', `/v2/places/${place1.id}`, {
      cookie: cookies.editor,
    });
    expect(delAgain.status).toBe(404);
  });
});

describe('Slice 7 Speaker CRUD (/v2/speakers)', () => {
  it('enforces auth (401), roles (editor/admin ok; viewer/member/super_admin/disabled 403), CSRF (403), and cross-community 404', async () => {
    const foreignSpeakerId = await insertRow(tables.speakers, {
      communityId: ids.foreign!,
      name: 'Foreign Speaker',
      createdAt: T0,
      updatedAt: T0,
    });

    for (const req of [
      {
        method: 'POST',
        path: '/v2/speakers',
        body: { name: 'Blocked Speaker' },
      },
      {
        method: 'PATCH',
        path: `/v2/speakers/${foreignSpeakerId}`,
        body: { name: 'Blocked Patch' },
      },
      {
        method: 'DELETE',
        path: `/v2/speakers/${foreignSpeakerId}`,
      },
      {
        method: 'PATCH',
        path: '/v2/speakers/not-an-id',
        body: { name: 'Bad ID' },
      },
      {
        method: 'DELETE',
        path: '/v2/speakers/-5',
      },
    ]) {
      expect(
        (await requestJson(req.method, req.path, { body: req.body })).status
      ).toBe(401);

      for (const roleKey of [
        'super',
        'disabledAdmin',
        'viewer',
        'member',
      ] as const) {
        const denied = await requestJson(req.method, req.path, {
          cookie: cookies[roleKey],
          body: req.body,
        });
        expect(denied.status).toBe(403);
        expect(denied.json).toEqual({ error: 'Forbidden' });
      }

      expect(
        (
          await requestJson(req.method, req.path, {
            cookie: cookies.editor,
            body: req.body,
            headers: { 'Sec-Fetch-Site': 'cross-site' },
          })
        ).status
      ).toBe(403);
      expect(
        (
          await requestJson(req.method, req.path, {
            cookie: cookies.admin,
            body: req.body,
            headers: { Origin: FOREIGN_ORIGIN },
          })
        ).status
      ).toBe(403);
    }

    for (const targetId of [foreignSpeakerId, 999999]) {
      expect(
        (
          await requestJson('PATCH', `/v2/speakers/${targetId}`, {
            cookie: cookies.editor,
            body: { name: 'Cross' },
          })
        ).status
      ).toBe(404);
      expect(
        (
          await requestJson('DELETE', `/v2/speakers/${targetId}`, {
            cookie: cookies.admin,
          })
        ).status
      ).toBe(404);
    }
  });

  it('creates, validates composite birthplace FK & birthDate, updates, and deletes speakers with 409 FK protection', async () => {
    const foreignPlaceId = await insertRow(tables.places, {
      communityId: ids.foreign!,
      name: 'Foreign Birthplace',
      createdAt: T0,
      updatedAt: T0,
    });
    const restrictedPlaceId = await insertRow(tables.places, {
      communityId: ids.own!,
      name: 'Restricted Birthplace',
      isRestricted: true,
      createdAt: T0,
      updatedAt: T0,
    });

    // 1. Editor creates speaker with same-community birthplace & valid calendar birthDate
    const createRes = await requestJson(
      'POST',
      `/v2/speakers?communityId=${ids.foreign}`,
      {
        cookie: cookies.editor,
        body: {
          name: 'Ana Silva',
          birthDate: '1954-07-09',
          birthplaceId: ids.plOwnPublic,
          affiliation: 'River Council',
        },
      }
    );
    expect(createRes.status).toBe(201);
    const speaker1 = SpeakerWriteResponseSchema.parse(createRes.json).data;
    expect(speaker1.name).toBe('Ana Silva');
    expect(speaker1.birthDate).toBe('1954-07-09');
    expect(speaker1.birthplace?.id).toBe(ids.plOwnPublic);
    expect(speaker1.affiliation).toBe('River Council');

    // 2. Reject cross-community, #162-restricted, and missing birthplaceId identically (400 without revealing)
    const crossBirthplace = await requestJson('POST', '/v2/speakers', {
      cookie: cookies.editor,
      body: { name: 'Cross Birthplace', birthplaceId: foreignPlaceId },
    });
    const restrictedBirthplace = await requestJson('POST', '/v2/speakers', {
      cookie: cookies.editor,
      body: { name: 'Restricted Birthplace', birthplaceId: restrictedPlaceId },
    });
    const missingBirthplace = await requestJson('POST', '/v2/speakers', {
      cookie: cookies.editor,
      body: { name: 'Missing Birthplace', birthplaceId: 888888 },
    });
    expect(crossBirthplace.status).toBe(400);
    expect(restrictedBirthplace.status).toBe(400);
    expect(missingBirthplace.status).toBe(400);
    expect(crossBirthplace.json).toEqual(missingBirthplace.json);
    expect(restrictedBirthplace.json).toEqual(missingBirthplace.json);
    expect(
      V2ValidationErrorResponseSchema.parse(crossBirthplace.json).details
        ?.fields[0]?.path
    ).toBe('birthplaceId');

    // 3. Reject invalid calendar birthDate and body communityId
    for (const invalidBody of [
      { name: 'Bad Feb', birthDate: '2026-02-30' },
      { name: 'Bad Leap', birthDate: '2025-02-29' },
      { name: 'Bad Format', birthDate: '07-09-1954' },
      { name: 'Spoof Body', communityId: ids.foreign },
    ]) {
      expect(
        (
          await requestJson('POST', '/v2/speakers', {
            cookie: cookies.editor,
            body: invalidBody,
          })
        ).status
      ).toBe(400);
    }

    // 4. PATCH updates fields and rejects cross-community birthplaceId
    const crossPatch = await requestJson(
      'PATCH',
      `/v2/speakers/${speaker1.id}`,
      {
        cookie: cookies.admin,
        body: { birthplaceId: foreignPlaceId },
      }
    );
    expect(crossPatch.status).toBe(400);

    const patchOk = await requestJson('PATCH', `/v2/speakers/${speaker1.id}`, {
      cookie: cookies.admin,
      body: {
        name: 'Ana Silva-Costa',
        birthDate: '2024-02-29',
        birthplaceId: null,
        affiliation: null,
      },
    });
    expect(patchOk.status).toBe(200);
    const updated = SpeakerWriteResponseSchema.parse(patchOk.json).data;
    expect(updated.name).toBe('Ana Silva-Costa');
    expect(updated.birthDate).toBe('2024-02-29');
    expect(updated.birthplace).toBeNull();
    expect(updated.affiliation).toBeNull();

    // Reject invalid PATCH id / empty body
    expect(
      (
        await requestJson('PATCH', '/v2/speakers/abc', {
          cookie: cookies.editor,
          body: { name: 'Bad' },
        })
      ).status
    ).toBe(400);
    expect(
      (
        await requestJson('PATCH', `/v2/speakers/${speaker1.id}`, {
          cookie: cookies.editor,
          body: {},
        })
      ).status
    ).toBe(400);

    // 5. Delete speaker referenced by story_speakers -> 409 conflict
    await db.insert(tables.storySpeakers).values({
      storyId: ids.stOwnPublic!,
      speakerId: speaker1.id,
      communityId: ids.own!,
      sortOrder: 0,
    });
    expect(
      (
        await requestJson('DELETE', `/v2/speakers/${speaker1.id}`, {
          cookie: cookies.editor,
        })
      ).status
    ).toBe(409);

    // 6. Delete speaker referenced by stories.interviewerId -> 409 conflict
    const interviewerRes = await requestJson('POST', '/v2/speakers', {
      cookie: cookies.editor,
      body: { name: 'Interviewer B' },
    });
    const interviewerId = SpeakerWriteResponseSchema.parse(interviewerRes.json)
      .data.id;
    await insertRow(tables.stories, {
      communityId: ids.own!,
      title: 'Interviewer Story',
      slug: 'interviewer-story',
      language: 'en',
      privacyLevel: 'editors_only',
      isRestricted: false,
      interviewerId,
      createdAt: T0,
      updatedAt: T0,
    });
    expect(
      (
        await requestJson('DELETE', `/v2/speakers/${interviewerId}`, {
          cookie: cookies.admin,
        })
      ).status
    ).toBe(409);

    // 7. Delete unreferenced speaker -> 204, repeated delete -> 404
    const unrefRes = await requestJson('POST', '/v2/speakers', {
      cookie: cookies.editor,
      body: { name: 'Temporary Speaker' },
    });
    const unrefId = SpeakerWriteResponseSchema.parse(unrefRes.json).data.id;

    expect(
      (
        await requestJson('DELETE', `/v2/speakers/${unrefId}`, {
          cookie: cookies.editor,
        })
      ).status
    ).toBe(204);
    expect(
      (
        await requestJson('DELETE', `/v2/speakers/${unrefId}`, {
          cookie: cookies.editor,
        })
      ).status
    ).toBe(404);
  });
});

describe('Slice 7 race-safe 409 deletes & attachment preservation', () => {
  it('preserves attachments on 409/404 and cleans up attachments only when owner row is deleted (SQLite & D1 batch)', async () => {
    // SQLite HTTP test: referenced place & speaker keep attachments on 409, unreferenced lose them on 204
    const refPlaceId = ids.plOwnPublic!;
    const unrefPlaceId = await insertRow(tables.places, {
      communityId: ids.own!,
      name: 'Temp Attachment Place',
      createdAt: T0,
      updatedAt: T0,
    });
    const restrictedPlaceId = await insertRow(tables.places, {
      communityId: ids.own!,
      name: 'Restricted Attachment Place',
      isRestricted: true,
      createdAt: T0,
      updatedAt: T0,
    });
    const refSpeakerId = await insertRow(tables.speakers, {
      communityId: ids.own!,
      name: 'Referenced Attachment Speaker',
      createdAt: T0,
      updatedAt: T0,
    });
    await db.insert(tables.storySpeakers).values({
      storyId: ids.stOwnPublic!,
      speakerId: refSpeakerId,
      communityId: ids.own!,
      sortOrder: 0,
    });
    const unrefSpeakerId = await insertRow(tables.speakers, {
      communityId: ids.own!,
      name: 'Temp Attachment Speaker',
      createdAt: T0,
      updatedAt: T0,
    });

    const attRefPlace = await insertRow(tables.attachments, {
      communityId: ids.own!,
      fileId: fileIds.ownActive,
      ownerType: 'place',
      ownerId: refPlaceId,
      role: 'place_photo',
      ordinal: 0,
      createdAt: T0,
    });
    const attUnrefPlace = await insertRow(tables.attachments, {
      communityId: ids.own!,
      fileId: fileIds.ownActive,
      ownerType: 'place',
      ownerId: unrefPlaceId,
      role: 'place_photo',
      ordinal: 0,
      createdAt: T0,
    });
    const attRestrictedPlace = await insertRow(tables.attachments, {
      communityId: ids.own!,
      fileId: fileIds.ownActive,
      ownerType: 'place',
      ownerId: restrictedPlaceId,
      role: 'place_photo',
      ordinal: 0,
      createdAt: T0,
    });
    const attRefSpeaker = await insertRow(tables.attachments, {
      communityId: ids.own!,
      fileId: fileIds.ownActive,
      ownerType: 'speaker',
      ownerId: refSpeakerId,
      role: 'speaker_photo',
      ordinal: 0,
      createdAt: T0,
    });
    const soloFileId = '99999999-9999-4999-8999-999999999901';
    await db.insert(tables.files).values({
      id: soloFileId,
      filename: 'solo-place.png',
      originalName: 'solo-place.png',
      path: 'communities/own/solo-place.png',
      storageKey: 'communities/own/solo-place.png',
      url: 'https://storage.invalid/solo-place.png',
      mimeType: 'image/png',
      size: 10,
      byteSize: 10,
      communityId: ids.own!,
      uploadedBy: ids.uAdmin!,
      isActive: true,
      createdAt: T0,
      updatedAt: T0,
    });
    await insertRow(tables.attachments, {
      communityId: ids.own!,
      fileId: soloFileId,
      ownerType: 'place',
      ownerId: unrefPlaceId,
      role: 'place_photo',
      ordinal: 1,
      createdAt: T0,
    });
    await insertRow(tables.attachments, {
      communityId: ids.own!,
      fileId: soloFileId,
      ownerType: 'speaker',
      ownerId: unrefSpeakerId,
      role: 'speaker_photo',
      ordinal: 1,
      createdAt: T0,
    });
    const attUnrefSpeaker = await insertRow(tables.attachments, {
      communityId: ids.own!,
      fileId: fileIds.ownActive,
      ownerType: 'speaker',
      ownerId: unrefSpeakerId,
      role: 'speaker_photo',
      ordinal: 0,
      createdAt: T0,
    });

    expect(
      (
        await requestJson('DELETE', `/v2/places/${refPlaceId}`, {
          cookie: cookies.editor,
        })
      ).status
    ).toBe(409);
    expect(
      (
        await requestJson('DELETE', `/v2/places/${restrictedPlaceId}`, {
          cookie: cookies.editor,
        })
      ).status
    ).toBe(404);
    expect(
      (
        await requestJson('DELETE', `/v2/speakers/${refSpeakerId}`, {
          cookie: cookies.editor,
        })
      ).status
    ).toBe(409);

    expect(
      await db
        .select({ id: tables.attachments.id })
        .from(tables.attachments)
        .where(eq(tables.attachments.id, attRefPlace))
    ).toHaveLength(1);
    expect(
      await db
        .select({ id: tables.attachments.id })
        .from(tables.attachments)
        .where(eq(tables.attachments.id, attRestrictedPlace))
    ).toHaveLength(1);
    expect(
      await db
        .select({ id: tables.attachments.id })
        .from(tables.attachments)
        .where(eq(tables.attachments.id, attRefSpeaker))
    ).toHaveLength(1);

    expect(
      (
        await requestJson('DELETE', `/v2/places/${unrefPlaceId}`, {
          cookie: cookies.editor,
        })
      ).status
    ).toBe(204);
    expect(
      (
        await requestJson('DELETE', `/v2/speakers/${unrefSpeakerId}`, {
          cookie: cookies.editor,
        })
      ).status
    ).toBe(204);

    expect(
      await db
        .select({ id: tables.attachments.id })
        .from(tables.attachments)
        .where(eq(tables.attachments.id, attUnrefPlace))
    ).toHaveLength(0);
    expect(
      await db
        .select({ id: tables.attachments.id })
        .from(tables.attachments)
        .where(eq(tables.attachments.id, attUnrefSpeaker))
    ).toHaveLength(0);
    // The solo file's rows were purged once both owners were gone.
    expect(
      await db
        .select({ id: tables.files.id })
        .from(tables.files)
        .where(eq(tables.files.id, soloFileId))
    ).toHaveLength(0);
    // The shared file's row is still referenced, so it is kept.
    expect(
      await db
        .select({ id: tables.files.id })
        .from(tables.files)
        .where(eq(tables.files.id, fileIds.ownActive))
    ).toHaveLength(1);

    // D1 batch race test: link added right before batch executes must return 'conflict',
    // never cascade-delete the link, and never delete the owner's attachments.
    const d1Sqlite = new Sqlite(':memory:');
    d1Sqlite.pragma('foreign_keys = ON');
    const d1Db = drizzle(d1Sqlite);
    migrate(d1Db, { migrationsFolder: 'src/db/migrations' });
    const d1Tables = tablesFor(d1Db);

    try {
      const [comm] = await d1Db
        .insert(d1Tables.communities)
        .values({
          name: 'D1 Del',
          slug: 'd1-del',
          createdAt: T0,
          updatedAt: T0,
        })
        .returning({ id: d1Tables.communities.id });
      const [usr] = await d1Db
        .insert(d1Tables.users)
        .values({
          email: 'd1del@example.test',
          username: 'd1del',
          ...deriveUserIdentityColumns({
            email: 'd1del@example.test',
            username: 'd1del',
          }),
          firstName: 'D1',
          lastName: 'Del',
          passwordHash: 'hash',
          role: 'editor',
          communityId: comm!.id,
          createdAt: T0,
          updatedAt: T0,
        })
        .returning({ id: d1Tables.users.id });
      const fId = '88888888-8888-4888-8888-888888888801';
      await d1Db.insert(d1Tables.files).values({
        id: fId,
        filename: 'a.png',
        originalName: 'a.png',
        path: 'communities/1/a.png',
        storageKey: 'communities/1/a.png',
        url: 'https://storage.invalid/a.png',
        mimeType: 'image/png',
        size: 10,
        byteSize: 10,
        communityId: comm!.id,
        uploadedBy: usr!.id,
        createdAt: T0,
        updatedAt: T0,
      });
      const [story] = await d1Db
        .insert(d1Tables.stories)
        .values({
          communityId: comm!.id,
          title: 'D1 Story',
          slug: 'd1-story',
          language: 'en',
          privacyLevel: 'public',
          isRestricted: false,
          createdAt: T0,
          updatedAt: T0,
        })
        .returning({ id: d1Tables.stories.id });
      const [place] = await d1Db
        .insert(d1Tables.places)
        .values({
          communityId: comm!.id,
          name: 'D1 Raced Place',
          createdAt: T0,
          updatedAt: T0,
        })
        .returning({ id: d1Tables.places.id });
      const [speaker] = await d1Db
        .insert(d1Tables.speakers)
        .values({
          communityId: comm!.id,
          name: 'D1 Raced Speaker',
          createdAt: T0,
          updatedAt: T0,
        })
        .returning({ id: d1Tables.speakers.id });
      const [restrictedPlace] = await d1Db
        .insert(d1Tables.places)
        .values({
          communityId: comm!.id,
          name: 'D1 Restricted Place',
          isRestricted: true,
          createdAt: T0,
          updatedAt: T0,
        })
        .returning({ id: d1Tables.places.id });

      const fIdOnly = '88888888-8888-4888-8888-888888888802';
      await d1Db.insert(d1Tables.files).values({
        id: fIdOnly,
        filename: 'solo.png',
        originalName: 'solo.png',
        path: 'communities/1/solo.png',
        storageKey: 'communities/1/solo.png',
        url: 'https://storage.invalid/solo.png',
        mimeType: 'image/png',
        size: 10,
        byteSize: 10,
        communityId: comm!.id,
        uploadedBy: usr!.id,
        createdAt: T0,
        updatedAt: T0,
      });
      await d1Db.insert(d1Tables.attachments).values([
        {
          communityId: comm!.id,
          fileId: fId,
          ownerType: 'place',
          ownerId: place!.id,
          role: 'place_photo',
          ordinal: 0,
          createdAt: T0,
        },
        {
          communityId: comm!.id,
          fileId: fId,
          ownerType: 'speaker',
          ownerId: speaker!.id,
          role: 'speaker_photo',
          ordinal: 0,
          createdAt: T0,
        },
        {
          communityId: comm!.id,
          fileId: fId,
          ownerType: 'place',
          ownerId: restrictedPlace!.id,
          role: 'place_photo',
          ordinal: 0,
          createdAt: T0,
        },
        {
          communityId: comm!.id,
          fileId: fIdOnly,
          ownerType: 'place',
          ownerId: place!.id,
          role: 'place_photo',
          ordinal: 1,
          createdAt: T0,
        },
      ]);

      let injectRace: (() => void) | null = null;
      const d1Like = Object.create(d1Db) as typeof d1Db & {
        batch: (
          stmts: Array<{ toSQL: () => { sql: string; params: unknown[] } }>
        ) => Promise<unknown[]>;
      };
      d1Like.batch = async (stmts) => {
        if (injectRace) {
          const fn = injectRace;
          injectRace = null;
          fn();
        }
        const queries = stmts.map((s) => s.toSQL());
        return d1Sqlite.transaction(() =>
          queries.map(({ sql: querySql, params }) => {
            const stmt = d1Sqlite.prepare(querySql);
            return stmt.reader ? stmt.all(...params) : stmt.run(...params);
          })
        )();
      };

      const d1Repo = new CommunityWritesRepository(d1Like as never);

      // Inject story_places right as deletePlace's batch executes
      injectRace = () => {
        d1Sqlite
          .prepare(
            'INSERT INTO story_places (community_id, story_id, place_id, sort_order, created_at, updated_at) VALUES (?, ?, ?, 0, 0, 0)'
          )
          .run(comm!.id, story!.id, place!.id);
      };
      expect(await d1Repo.deletePlace(comm!.id, place!.id)).toBe('conflict');
      expect(
        await d1Db
          .select()
          .from(d1Tables.places)
          .where(eq(d1Tables.places.id, place!.id))
      ).toHaveLength(1);
      expect(
        await d1Db
          .select()
          .from(d1Tables.storyPlaces)
          .where(eq(d1Tables.storyPlaces.placeId, place!.id))
      ).toHaveLength(1);
      expect(
        await d1Db
          .select()
          .from(d1Tables.attachments)
          .where(
            and(
              eq(d1Tables.attachments.ownerType, 'place'),
              eq(d1Tables.attachments.ownerId, place!.id)
            )
          )
      ).toHaveLength(2);

      // Inject story_speakers right as deleteSpeaker's batch executes
      injectRace = () => {
        d1Sqlite
          .prepare(
            'INSERT INTO story_speakers (community_id, story_id, speaker_id, sort_order, created_at, updated_at) VALUES (?, ?, ?, 0, 0, 0)'
          )
          .run(comm!.id, story!.id, speaker!.id);
      };
      expect(await d1Repo.deleteSpeaker(comm!.id, speaker!.id)).toBe(
        'conflict'
      );
      expect(
        await d1Db
          .select()
          .from(d1Tables.speakers)
          .where(eq(d1Tables.speakers.id, speaker!.id))
      ).toHaveLength(1);
      expect(
        await d1Db
          .select()
          .from(d1Tables.storySpeakers)
          .where(eq(d1Tables.storySpeakers.speakerId, speaker!.id))
      ).toHaveLength(1);
      expect(
        await d1Db
          .select()
          .from(d1Tables.attachments)
          .where(
            and(
              eq(d1Tables.attachments.ownerType, 'speaker'),
              eq(d1Tables.attachments.ownerId, speaker!.id)
            )
          )
      ).toHaveLength(1);

      // Restricted place returns 'not_found' and does NOT delete its attachment
      expect(await d1Repo.deletePlace(comm!.id, restrictedPlace!.id)).toBe(
        'not_found'
      );
      expect(
        await d1Db
          .select()
          .from(d1Tables.attachments)
          .where(
            and(
              eq(d1Tables.attachments.ownerType, 'place'),
              eq(d1Tables.attachments.ownerId, restrictedPlace!.id)
            )
          )
      ).toHaveLength(1);

      // Unlink story_places / story_speakers, then delete succeeds and deletes attachments
      await d1Db
        .delete(d1Tables.storyPlaces)
        .where(eq(d1Tables.storyPlaces.placeId, place!.id));
      await d1Db
        .delete(d1Tables.storySpeakers)
        .where(eq(d1Tables.storySpeakers.speakerId, speaker!.id));

      expect(await d1Repo.deletePlace(comm!.id, place!.id)).toBe('deleted');
      expect(await d1Repo.deleteSpeaker(comm!.id, speaker!.id)).toBe('deleted');
      // The files row whose only references were the deleted owners'
      // attachments is gone.
      expect(
        await d1Db
          .select()
          .from(d1Tables.files)
          .where(eq(d1Tables.files.id, fIdOnly))
      ).toHaveLength(0);
      // The shared file is still referenced by the restricted place's
      // attachment and is kept.
      expect(
        await d1Db
          .select()
          .from(d1Tables.files)
          .where(eq(d1Tables.files.id, fId))
      ).toHaveLength(1);
      expect(
        await d1Db
          .select()
          .from(d1Tables.attachments)
          .where(
            and(
              eq(d1Tables.attachments.ownerType, 'place'),
              eq(d1Tables.attachments.ownerId, place!.id)
            )
          )
      ).toHaveLength(0);
      expect(
        await d1Db
          .select()
          .from(d1Tables.attachments)
          .where(
            and(
              eq(d1Tables.attachments.ownerType, 'speaker'),
              eq(d1Tables.attachments.ownerId, speaker!.id)
            )
          )
      ).toHaveLength(0);
      expect(await d1Repo.deletePlace(comm!.id, place!.id)).toBe('not_found');
      expect(await d1Repo.deleteSpeaker(comm!.id, speaker!.id)).toBe(
        'not_found'
      );
    } finally {
      d1Sqlite.close();
    }
  });
});

describe('isForeignKeyConstraintError', () => {
  it('maps only real FK violations (23503, SQLITE_CONSTRAINT_FOREIGNKEY, D1 FK message) and rejects UNIQUE/NOT NULL/CHECK', async () => {
    // Real FK errors -> true
    expect(isForeignKeyConstraintError({ code: '23503' })).toBe(true);
    expect(
      isForeignKeyConstraintError({ code: 'SQLITE_CONSTRAINT_FOREIGNKEY' })
    ).toBe(true);
    expect(
      isForeignKeyConstraintError(
        new Error('D1_ERROR: FOREIGN KEY constraint failed: SQLITE_CONSTRAINT')
      )
    ).toBe(true);
    expect(
      isForeignKeyConstraintError({
        code: 'SQLITE_CONSTRAINT',
        message: 'FOREIGN KEY constraint failed',
      })
    ).toBe(true);
    expect(
      isForeignKeyConstraintError({
        message: 'Failed query: delete from places',
        cause: { code: '23503' },
      })
    ).toBe(true);
    expect(
      isForeignKeyConstraintError({
        message: 'Failed query: delete from speakers',
        cause: new Error('D1_ERROR: FOREIGN KEY constraint failed'),
      })
    ).toBe(true);

    // Non-FK constraint violations -> false (must never become 409)
    expect(
      isForeignKeyConstraintError({
        code: '23505',
        message: 'duplicate key value violates unique constraint',
      })
    ).toBe(false);
    expect(
      isForeignKeyConstraintError({
        code: '23502',
        message: 'null value in column violates not-null constraint',
      })
    ).toBe(false);
    expect(
      isForeignKeyConstraintError({
        code: '23514',
        message: 'new row for relation violates check constraint',
      })
    ).toBe(false);
    expect(
      isForeignKeyConstraintError({
        code: 'SQLITE_CONSTRAINT_UNIQUE',
        message: 'UNIQUE constraint failed: places.id',
      })
    ).toBe(false);
    expect(
      isForeignKeyConstraintError({
        code: 'SQLITE_CONSTRAINT_NOTNULL',
        message: 'NOT NULL constraint failed: places.name',
      })
    ).toBe(false);
    expect(
      isForeignKeyConstraintError({
        code: 'SQLITE_CONSTRAINT_CHECK',
        message: 'CHECK constraint failed',
      })
    ).toBe(false);
    expect(
      isForeignKeyConstraintError({
        code: 'SQLITE_CONSTRAINT',
        message: 'UNIQUE constraint failed: communities.slug',
      })
    ).toBe(false);
    expect(
      isForeignKeyConstraintError({
        code: 'SQLITE_CONSTRAINT',
        message: 'NOT NULL constraint failed: places.name',
      })
    ).toBe(false);
    expect(
      isForeignKeyConstraintError({
        code: 'SQLITE_CONSTRAINT',
        message: 'CHECK constraint failed: places',
      })
    ).toBe(false);
    expect(isForeignKeyConstraintError(null)).toBe(false);
    expect(isForeignKeyConstraintError(undefined)).toBe(false);
    expect(isForeignKeyConstraintError('FOREIGN KEY constraint failed')).toBe(
      false
    );

    const cyclic: Record<string, unknown> = { code: '23505' };
    cyclic.cause = cyclic;
    expect(isForeignKeyConstraintError(cyclic)).toBe(false);

    // Verify repository maps D1 FK errors to 'conflict' and rethrows non-FK constraint errors
    const makeThrowingD1Repo = (thrown: unknown) => {
      const stub = {
        batch: async () => {
          throw thrown;
        },
        delete: () => ({
          where: () => ({
            returning: () => ({}),
          }),
        }),
        select: () => ({
          from: () => ({
            where: () => ({
              limit: () => ({}),
            }),
          }),
        }),
      };
      return new CommunityWritesRepository(stub as never);
    };

    await expect(
      makeThrowingD1Repo(
        new Error('D1_ERROR: FOREIGN KEY constraint failed: SQLITE_CONSTRAINT')
      ).deletePlace(1, 1)
    ).resolves.toBe('conflict');

    await expect(
      makeThrowingD1Repo({
        code: 'SQLITE_CONSTRAINT',
        message: 'UNIQUE constraint failed: places.id',
      }).deletePlace(1, 1)
    ).rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT' });

    await expect(
      makeThrowingD1Repo({
        code: 'SQLITE_CONSTRAINT_CHECK',
        message: 'CHECK constraint failed',
      }).deleteSpeaker(1, 1)
    ).rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT_CHECK' });
  });
});
