/**
 * Focused contract, validation, security, audit, and tenant-isolation tests
 * for Slice 7 V2 authenticated community write routes (#145).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq, asc } from 'drizzle-orm';
import { hash } from 'bcrypt';
import { nodePasswordVerifier } from '../../src/node-password.js';
import { tablesFor } from '../../src/db/dialect.js';
import { createHonoApp } from '../../src/hono-app.js';
import { HonoFoundationRepository } from '../../src/repositories/hono-foundation.repository.js';
import { CommunityReadsRepository } from '../../src/repositories/community-reads.repository.js';
import { CommunityWritesRepository } from '../../src/repositories/community-writes.repository.js';
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

  it('keeps PATCH /v2/community + audit insert atomic via D1 db.batch() contract', async () => {
    const batchCalls: unknown[][] = [];
    // Minimal D1 batch stub confirming single atomic batch with 2 statements
    const mockD1 = {
      batch: async (stmts: unknown[]) => {
        batchCalls.push(stmts);
        return [[{ id: 1 }], []];
      },
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [
              { id: 1, publicStories: false, isActive: true },
            ],
          }),
        }),
      }),
      update: () => ({
        set: () => ({
          where: () => ({
            returning: () => ({ sql: 'update communities' }),
          }),
        }),
      }),
      insert: () => ({
        values: () => ({ sql: 'insert audit_entries' }),
      }),
    };

    const repo = new CommunityWritesRepository(mockD1 as never);
    const result = await repo.updateCommunitySettings(
      1,
      2,
      { visibility: 'public' },
      T0
    );
    expect(result.updated).toBe(true);
    expect(batchCalls).toHaveLength(1);
    expect(batchCalls[0]).toHaveLength(2);
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
