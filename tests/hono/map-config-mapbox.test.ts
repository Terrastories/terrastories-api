/**
 * Dual-dialect (SQLite + PostgreSQL) contract tests for per-community Mapbox
 * and Protomaps configuration in V2 map-config (SPEC-V2 §6.6, 2026-11-22
 * decision reversing credential removal):
 *
 * - `PUT /v2/community/map-config` validation, pairing, `pk.*` enforcement,
 *   `sk.*` 422 rejection without echoing credentials, URL validation, length caps,
 *   and role boundaries;
 * - Content-free `audit_entries`, zero console token logging, and atomic D1
 *   `db.batch()` writes (map-config upsert + audit, visibility='private' reset);
 * - Authenticated reads across roles, optional deployment `MAPBOX_ACCESS_TOKEN`
 *   fallback, corrupt DB `sk.*` stripping, offline mode suppression, and runtime
 *   env validation (`validateNodeV2Runtime`, `validateWorkerV2Runtime`);
 * - Public exposure matrix across `/v2/public/communities*` and
 *   `/explore/communities*` (expose false, expose true, private reset);
 * - Export manifest credential classification + determinism and community erasure.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import Sqlite from 'better-sqlite3';
import { drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { migrate as migrateSqlite } from 'drizzle-orm/better-sqlite3/migrator';
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js';
import { migrate as migratePostgres } from 'drizzle-orm/postgres-js/migrator';
import { eq, sql } from 'drizzle-orm';
import { createHonoApp } from '../../src/hono-app.js';
import { createPostgresClient, type Database } from '../../src/db/index.js';
import { tablesFor, type Dialect } from '../../src/db/dialect.js';
import { HonoFoundationRepository } from '../../src/repositories/hono-foundation.repository.js';
import { CommunityWritesRepository } from '../../src/repositories/community-writes.repository.js';
import { CommunityExportRepository } from '../../src/repositories/community-export.repository.js';
import { CommunitySovereigntyRepository } from '../../src/repositories/community-sovereignty.repository.js';
import { CommunityErasureService } from '../../src/services/community-erasure.service.js';
import type {
  ErasureRecord,
  ErasureRecordStore,
} from '../../src/services/erasure-record-store.js';
import { buildCommunityExportManifest } from '../../src/services/community-export-manifest.js';
import {
  validateNodeV2Runtime,
  validateWorkerV2Runtime,
} from '../../src/config/v2-runtime.js';
import { deriveUserIdentityColumns } from '../../src/shared/utils/derived-columns.js';
import {
  MAPBOX_ACCESS_TOKEN_MAX_LENGTH,
  MAPBOX_STYLE_URL_MAX_LENGTH,
  PROTOMAPS_API_KEY_MAX_LENGTH,
  PROTOMAPS_BASEMAP_STYLE_MAX_LENGTH,
} from '../../src/shared/utils/map-config.js';
import {
  argon2Seed,
  makeDerivedKey,
  makeServerSecret,
} from './auth-test-utils.js';
import { resolvePostgresQaTarget } from '../../scripts/qa/qa-database.js';

const API_ORIGIN = 'https://api.mapbox-test.example';
const BASE_TIME = new Date('2026-11-22T12:00:00.000Z');

// Obviously fake non-JWT test tokens (never real credentials).
const FAKE_PK_COMMUNITY = 'pk.test-mapbox-community-public-token';
const FAKE_PK_HTTPS = 'pk.test-mapbox-https-public-token';
const FAKE_PK_INSTANCE = 'pk.test-instance-fallback-public-token';
const FAKE_SK_SECRET = 'sk.test-mapbox-secret-must-never-leak';
const FAKE_SK_UPPER = 'SK.test-mapbox-uppercase-secret-leak';
const FAKE_PROTOMAPS_KEY = 'pm-test-protomaps-api-key';

const pgDecision = resolvePostgresQaTarget(
  process.env.QA_POSTGRES_URL,
  process.env.ALLOW_POSTGRES_TEST_RESET
);

interface SeededUsers {
  communityId: number;
  communitySlug: string;
  adminId: number;
  adminDerivedKey: string;
  adminCookie: string;
  editorCookie: string;
  memberCookie: string;
  viewerCookie: string;
  superAdminCookie: string;
  app: ReturnType<typeof createHonoApp>;
  erasureRecords: Map<number, ErasureRecord>;
  erasureService: CommunityErasureService;
}

interface TestHarness {
  dialect: Dialect;
  getDb: () => Database;
  getNow: () => Date;
  makeApp: (options?: {
    mapboxAccessToken?: string;
    offlineMode?: boolean;
  }) => {
    app: ReturnType<typeof createHonoApp>;
    erasureRecords: Map<number, ErasureRecord>;
    erasureService: CommunityErasureService;
  };
  seedCommunityAndActors: (options?: {
    visibility?: 'public' | 'private';
    slug?: string;
    mapboxAccessToken?: string;
    offlineMode?: boolean;
  }) => Promise<SeededUsers>;
}

function createMemoryStorageAndErasure(getNow: () => Date) {
  const objects = new Map<string, Uint8Array>();
  const erasureRecords = new Map<number, ErasureRecord>();
  const erasureStore: ErasureRecordStore = {
    list: async () => [...erasureRecords.values()],
    write: async (record) => {
      erasureRecords.set(record.communityId, structuredClone(record));
    },
  };
  const storage = {
    fenceCommunity: async () => undefined,
    read: async () => null,
    delete: async (key: string) => {
      objects.delete(key);
    },
    list: async (options?: { prefix?: string; limit?: number }) => {
      const keys = [...objects.keys()]
        .filter((k) => k.startsWith(options?.prefix ?? ''))
        .sort();
      const limit = options?.limit ?? 20;
      return {
        entries: keys
          .slice(0, limit)
          .map((key) => ({ key, uploaded: getNow() })),
        truncated: keys.length > limit,
      };
    },
  };
  return { objects, erasureRecords, erasureStore, storage };
}

function captureThrown(fn: () => unknown): Error | null {
  try {
    fn();
  } catch (err) {
    return err as Error;
  }
  return null;
}

function cookieFromSetHeader(response: Response): string {
  const raw = response.headers.get('set-cookie') ?? '';
  const match = /ts_session=([^;]+)/.exec(raw);
  expect(match?.[1]).toBeTruthy();
  return `ts_session=${match![1]}`;
}

async function jsonRequest(
  app: ReturnType<typeof createHonoApp>,
  method: string,
  path: string,
  options: {
    cookie?: string;
    body?: unknown;
    ip?: string;
  } = {}
): Promise<{ status: number; rawText: string; json: any }> {
  const headers: Record<string, string> = {
    'x-forwarded-for': options.ip ?? '203.0.113.50',
  };
  if (options.cookie) {
    headers.cookie = options.cookie;
  }
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  const response = await app.request(`${API_ORIGIN}${path}`, {
    method,
    headers,
    ...(options.body !== undefined
      ? { body: JSON.stringify(options.body) }
      : {}),
  });
  const rawText = await response.text();
  let json: unknown = null;
  if (rawText) {
    try {
      json = JSON.parse(rawText);
    } catch {
      json = rawText;
    }
  }
  return { status: response.status, rawText, json };
}

function buildHarnessHelpers(
  dialect: Dialect,
  getDb: () => Database,
  getNow: () => Date
): TestHarness {
  let ipCounter = 10;
  const nextIp = () => `203.0.113.${++ipCounter}`;

  const makeApp = (
    options: { mapboxAccessToken?: string; offlineMode?: boolean } = {}
  ) => {
    const db = getDb();
    const { erasureRecords, erasureStore, storage } =
      createMemoryStorageAndErasure(getNow);
    const app = createHonoApp({
      repository: new HonoFoundationRepository(db),
      storage,
      erasureStore,
      serverSecret: makeServerSecret(),
      secureCookies: false,
      publicOrigin: API_ORIGIN,
      corsOrigins: [API_ORIGIN],
      trustProxy: true,
      now: getNow,
      mapboxAccessToken: options.mapboxAccessToken,
      offlineMode: options.offlineMode,
    });
    const erasureService = new CommunityErasureService(
      new CommunitySovereigntyRepository(db),
      storage,
      erasureStore,
      getNow
    );
    return { app, erasureRecords, erasureService };
  };

  const seedCommunityAndActors: TestHarness['seedCommunityAndActors'] = async (
    options = {}
  ) => {
    const db = getDb();
    const tables = tablesFor(db);
    const slug = options.slug ?? 'mapbox-alpha';
    const isPublic = (options.visibility ?? 'public') === 'public';
    const now = getNow();

    const [community] = await db
      .insert(tables.communities)
      .values({
        name: `Community ${slug}`,
        slug,
        publicStories: isPublic,
        isActive: true,
        locale: 'en',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: tables.communities.id, slug: tables.communities.slug });

    const insertAccount = async (
      prefix: string,
      role: string,
      communityId: number | null
    ) => {
      const email = `${prefix}-${slug}@example.test`;
      const username = `${prefix}_${slug.replace(/-/g, '_')}`;
      const derivedKey = makeDerivedKey();
      const seed = await argon2Seed(derivedKey);
      const [user] = await db
        .insert(tables.users)
        .values({
          email,
          username,
          ...deriveUserIdentityColumns({ email, username }),
          firstName: prefix,
          lastName: 'User',
          role,
          communityId,
          isActive: true,
          createdAt: now,
          updatedAt: now,
          ...seed,
        })
        .returning({ id: tables.users.id });
      return { id: user!.id, email, derivedKey };
    };

    const admin = await insertAccount('admin', 'admin', community!.id);
    const editor = await insertAccount('editor', 'editor', community!.id);
    const member = await insertAccount('member', 'member', community!.id);
    const viewer = await insertAccount('viewer', 'viewer', community!.id);
    const superAdmin = await insertAccount('super', 'super_admin', null);

    const { app, erasureRecords, erasureService } = makeApp({
      mapboxAccessToken: options.mapboxAccessToken,
      offlineMode: options.offlineMode,
    });

    const login = async (identifier: string, derivedKey: string) => {
      const res = await app.request(`${API_ORIGIN}/v2/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-forwarded-for': nextIp(),
        },
        body: JSON.stringify({ identifier, derivedKey }),
      });
      expect(res.status).toBe(200);
      return cookieFromSetHeader(res);
    };

    return {
      communityId: community!.id,
      communitySlug: community!.slug,
      adminId: admin.id,
      adminDerivedKey: admin.derivedKey,
      adminCookie: await login(admin.email, admin.derivedKey),
      editorCookie: await login(editor.email, editor.derivedKey),
      memberCookie: await login(member.email, member.derivedKey),
      viewerCookie: await login(viewer.email, viewer.derivedKey),
      superAdminCookie: await login(superAdmin.email, superAdmin.derivedKey),
      app,
      erasureRecords,
      erasureService,
    };
  };

  return { dialect, getDb, getNow, makeApp, seedCommunityAndActors };
}

function registerSharedMapboxTests(harness: TestHarness) {
  it('allows admin to configure, read, update, and clear Mapbox + Protomaps settings and rejects invalid inputs without token echo', async () => {
    const consoleSpies = [
      vi.spyOn(console, 'log'),
      vi.spyOn(console, 'info'),
      vi.spyOn(console, 'warn'),
      vi.spyOn(console, 'error'),
      vi.spyOn(console, 'debug'),
    ];
    try {
      const ctx = await harness.seedCommunityAndActors({
        visibility: 'public',
      });

      // 1. Valid mapbox:// style + pk.* + protomaps config
      const createRes = await jsonRequest(
        ctx.app,
        'PUT',
        '/v2/community/map-config',
        {
          cookie: ctx.adminCookie,
          body: {
            mapboxStyleUrl: 'mapbox://styles/community/territory-v1',
            mapboxAccessToken: FAKE_PK_COMMUNITY,
            exposeMapboxCredentials: false,
            mapbox3d: true,
            protomapsApiKey: FAKE_PROTOMAPS_KEY,
            protomapsBasemapStyle: 'dark',
            centerLatitude: 4.5,
            centerLongitude: -74.1,
            zoom: 9,
          },
        }
      );
      expect(createRes.status).toBe(200);
      expect(createRes.json.data).toMatchObject({
        mapboxStyleUrl: 'mapbox://styles/community/territory-v1',
        mapboxAccessToken: FAKE_PK_COMMUNITY,
        exposeMapboxCredentials: false,
        mapbox3d: true,
        protomapsApiKey: FAKE_PROTOMAPS_KEY,
        protomapsBasemapStyle: 'dark',
        centerLatitude: 4.5,
        centerLongitude: -74.1,
        zoom: 9,
      });

      // 2. Role authorization checks
      for (const [roleName, cookie, expectedStatus] of [
        ['viewer', ctx.viewerCookie, 403],
        ['member', ctx.memberCookie, 403],
        ['editor', ctx.editorCookie, 403],
        ['super_admin', ctx.superAdminCookie, 403],
        ['anonymous', undefined, 401],
      ] as const) {
        const denyRes = await jsonRequest(
          ctx.app,
          'PUT',
          '/v2/community/map-config',
          {
            cookie,
            body: { basemapStyle: `denied-${roleName}` },
          }
        );
        expect(denyRes.status, `${roleName} should get ${expectedStatus}`).toBe(
          expectedStatus
        );
      }

      // 3. Secret sk.* rejection with 422 + no token echo + DB unchanged
      for (const secretCandidate of [FAKE_SK_SECRET, FAKE_SK_UPPER]) {
        const skRes = await jsonRequest(
          ctx.app,
          'PUT',
          '/v2/community/map-config',
          {
            cookie: ctx.adminCookie,
            body: {
              mapboxStyleUrl: 'mapbox://styles/community/should-not-save',
              mapboxAccessToken: secretCandidate,
            },
          }
        );
        expect(skRes.status).toBe(422);
        expect(skRes.json.code).toBe('secret_token_rejected');
        expect(skRes.rawText).not.toContain(secretCandidate);
      }

      // 4. Negative 400 validations: half-pairs, non-pk token, bad URLs, length caps, whitespace API key
      const invalidPayloads: Array<{
        label: string;
        body: Record<string, unknown>;
        forbiddenSubstrings?: string[];
      }> = [
        {
          label: 'style without token',
          body: {
            mapboxStyleUrl: 'mapbox://styles/community/only-style',
            mapboxAccessToken: null,
          },
        },
        {
          label: 'token without style',
          body: { mapboxStyleUrl: null, mapboxAccessToken: FAKE_PK_HTTPS },
        },
        {
          label: 'non-pk token',
          body: {
            mapboxStyleUrl: 'mapbox://styles/community/s1',
            mapboxAccessToken: 'tok.test-not-a-pk-token',
          },
          forbiddenSubstrings: ['tok.test-not-a-pk-token'],
        },
        {
          label: 'http style URL rejected',
          body: {
            mapboxStyleUrl: 'http://insecure.example/style.json',
            mapboxAccessToken: FAKE_PK_HTTPS,
          },
        },
        {
          label: 'https style URL with access_token query param rejected',
          body: {
            mapboxStyleUrl: `https://styles.example/style.json?access_token=${FAKE_PK_HTTPS}`,
            mapboxAccessToken: FAKE_PK_HTTPS,
          },
          forbiddenSubstrings: [FAKE_PK_HTTPS],
        },
        {
          label: 'https style URL with embedded userinfo rejected',
          body: {
            mapboxStyleUrl: [
              'https://',
              'u',
              ':',
              'p',
              '@styles.example/style.json',
            ].join(''),
            mapboxAccessToken: FAKE_PK_HTTPS,
          },
          forbiddenSubstrings: ['@styles.example'],
        },
        {
          label: 'https style URL with fragment rejected',
          body: {
            mapboxStyleUrl: 'https://styles.example/style.json#token=leak',
            mapboxAccessToken: FAKE_PK_HTTPS,
          },
          forbiddenSubstrings: ['leak'],
        },
        {
          label: 'mapbox:// non-styles scheme rejected',
          body: {
            mapboxStyleUrl: 'mapbox://tilesets/community/data',
            mapboxAccessToken: FAKE_PK_HTTPS,
          },
        },
        {
          label: 'javascript URI rejected',
          body: {
            mapboxStyleUrl: 'javascript:alert(1)',
            mapboxAccessToken: FAKE_PK_HTTPS,
          },
        },
        {
          label: 'mapboxStyleUrl exceeds max length',
          body: {
            mapboxStyleUrl: `https://styles.example/${'a'.repeat(MAPBOX_STYLE_URL_MAX_LENGTH)}`,
            mapboxAccessToken: FAKE_PK_HTTPS,
          },
        },
        {
          label: 'mapboxAccessToken exceeds max length',
          body: {
            mapboxStyleUrl: 'mapbox://styles/community/long-token',
            mapboxAccessToken: `pk.${'t'.repeat(MAPBOX_ACCESS_TOKEN_MAX_LENGTH)}`,
          },
        },
        {
          label: 'protomapsApiKey with whitespace rejected',
          body: { protomapsApiKey: 'pm test invalid key' },
          forbiddenSubstrings: ['pm test invalid key'],
        },
        {
          label: 'protomapsApiKey exceeds max length',
          body: {
            protomapsApiKey: 'p'.repeat(PROTOMAPS_API_KEY_MAX_LENGTH + 1),
          },
        },
        {
          label: 'protomapsBasemapStyle exceeds max length',
          body: {
            protomapsBasemapStyle: 'b'.repeat(
              PROTOMAPS_BASEMAP_STYLE_MAX_LENGTH + 1
            ),
          },
        },
      ];

      for (const testCase of invalidPayloads) {
        const res = await jsonRequest(
          ctx.app,
          'PUT',
          '/v2/community/map-config',
          { cookie: ctx.adminCookie, body: testCase.body }
        );
        expect(res.status, testCase.label).toBe(400);
        for (const forbidden of testCase.forbiddenSubstrings ?? []) {
          expect(res.rawText, testCase.label).not.toContain(forbidden);
        }
      }

      // Verify previously stored valid Mapbox values survived rejected writes
      const readAfterReject = await jsonRequest(
        ctx.app,
        'GET',
        '/v2/community/map-config',
        { cookie: ctx.memberCookie }
      );
      expect(readAfterReject.status).toBe(200);
      expect(readAfterReject.json.data.mapboxAccessToken).toBe(
        FAKE_PK_COMMUNITY
      );
      expect(readAfterReject.json.data.mapboxStyleUrl).toBe(
        'mapbox://styles/community/territory-v1'
      );

      // 5. Credential-free HTTPS style URL + pk.* token accepted
      const httpsRes = await jsonRequest(
        ctx.app,
        'PUT',
        '/v2/community/map-config',
        {
          cookie: ctx.adminCookie,
          body: {
            mapboxStyleUrl: 'https://styles.example.org/territory/style.json',
            mapboxAccessToken: FAKE_PK_HTTPS,
            exposeMapboxCredentials: false,
          },
        }
      );
      expect(httpsRes.status).toBe(200);
      expect(httpsRes.json.data.mapboxStyleUrl).toBe(
        'https://styles.example.org/territory/style.json'
      );
      expect(httpsRes.json.data.mapboxAccessToken).toBe(FAKE_PK_HTTPS);

      // 6. Content-free audit entries verification (no token, URL, or API key leaked)
      const db = harness.getDb();
      const tables = tablesFor(db);
      const audits = await db
        .select()
        .from(tables.auditEntries)
        .where(eq(tables.auditEntries.communityId, ctx.communityId));
      const mapConfigAudits = audits.filter(
        (row) => row.action === 'community.map_config.update'
      );
      expect(mapConfigAudits).toHaveLength(2);
      for (const entry of mapConfigAudits) {
        expect(entry.resourceType).toBe('map_config');
        expect(entry.outcome).toBe('success');
        expect(entry.ipAddress).toBeNull();
        expect(entry.userAgent).toBeNull();
        expect(entry.resourceIds[0]).toBe(ctx.communityId);
        const serialized = JSON.stringify(entry);
        expect(serialized).not.toContain(FAKE_PK_COMMUNITY);
        expect(serialized).not.toContain(FAKE_PK_HTTPS);
        expect(serialized).not.toContain(FAKE_PROTOMAPS_KEY);
        expect(serialized).not.toContain('styles.example.org');
        expect(serialized).not.toContain('territory-v1');
      }
      expect(mapConfigAudits[0]!.resourceIds.slice(1)).toEqual([
        'centerLatitude',
        'centerLongitude',
        'exposeMapboxCredentials',
        'mapbox3d',
        'mapboxAccessToken',
        'mapboxStyleUrl',
        'protomapsApiKey',
        'protomapsBasemapStyle',
        'zoom',
      ]);

      // 7. Clearing with empty strings trims to null cleanly
      const clearRes = await jsonRequest(
        ctx.app,
        'PUT',
        '/v2/community/map-config',
        {
          cookie: ctx.adminCookie,
          body: {
            mapboxStyleUrl: '   ',
            mapboxAccessToken: '',
            protomapsApiKey: '',
            protomapsBasemapStyle: null,
          },
        }
      );
      expect(clearRes.status).toBe(200);
      expect(clearRes.json.data).toMatchObject({
        mapboxStyleUrl: null,
        mapboxAccessToken: null,
        protomapsApiKey: null,
        protomapsBasemapStyle: null,
      });

      // 8. Verify zero tokens logged to console
      const loggedText = consoleSpies
        .flatMap((spy) => spy.mock.calls.flat())
        .map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg)))
        .join('\n');
      for (const secret of [
        FAKE_PK_COMMUNITY,
        FAKE_PK_HTTPS,
        FAKE_SK_SECRET,
        FAKE_SK_UPPER,
        FAKE_PROTOMAPS_KEY,
      ]) {
        expect(loggedText).not.toContain(secret);
      }
    } finally {
      for (const spy of consoleSpies) {
        spy.mockRestore();
      }
    }
  });

  it('supports authenticated role reads, instance MAPBOX_ACCESS_TOKEN fallback, corrupt DB stripping, and offline mode suppression', async () => {
    // Part A: Instance fallback when no community row exists, and override when community token is set
    const withEnv = await harness.seedCommunityAndActors({
      visibility: 'public',
      slug: 'env-fallback',
      mapboxAccessToken: FAKE_PK_INSTANCE,
    });

    // No community_map_configs row yet: GET /v2/community & GET /v2/community/map-config both receive fallback
    for (const cookie of [
      withEnv.viewerCookie,
      withEnv.memberCookie,
      withEnv.editorCookie,
      withEnv.adminCookie,
    ]) {
      const cfgRes = await jsonRequest(
        withEnv.app,
        'GET',
        '/v2/community/map-config',
        { cookie }
      );
      expect(cfgRes.status).toBe(200);
      // No row: never synthesize a config containing the instance token.
      expect(cfgRes.json.data).toBeNull();
      expect(cfgRes.json.render).toEqual({
        mapboxStyleUrl: null,
        mapboxAccessToken: FAKE_PK_INSTANCE,
        source: 'instance',
      });

      const commRes = await jsonRequest(withEnv.app, 'GET', '/v2/community', {
        cookie,
      });
      expect(commRes.status).toBe(200);
      expect(commRes.json.data.mapConfig).toBeNull();
      expect(commRes.json.data.mapRender).toEqual({
        mapboxStyleUrl: null,
        mapboxAccessToken: FAKE_PK_INSTANCE,
        source: 'instance',
      });
    }

    // Public endpoints NEVER receive the instance MAPBOX_ACCESS_TOKEN fallback
    const pubDetailNoRow = await jsonRequest(
      withEnv.app,
      'GET',
      `/v2/public/communities/${withEnv.communitySlug}`
    );
    expect(pubDetailNoRow.status).toBe(200);
    expect(pubDetailNoRow.rawText).not.toContain(FAKE_PK_INSTANCE);

    const exploreShowNoRow = await jsonRequest(
      withEnv.app,
      'GET',
      `/explore/communities/${withEnv.communitySlug}`
    );
    expect(exploreShowNoRow.status).toBe(200);
    expect(exploreShowNoRow.json.data.mapConfig.mapboxAccessToken).toBeNull();

    // Row exists with mapboxAccessToken: null -> fallback still applies on PUT and GET
    const partialWrite = await jsonRequest(
      withEnv.app,
      'PUT',
      '/v2/community/map-config',
      {
        cookie: withEnv.adminCookie,
        body: {
          basemapStyle: 'liberty',
          protomapsApiKey: FAKE_PROTOMAPS_KEY,
          protomapsBasemapStyle: 'light',
        },
      }
    );
    expect(partialWrite.status).toBe(200);
    // Raw stored field stays null; instance token only appears in render.
    expect(partialWrite.json.data.mapboxAccessToken).toBeNull();
    expect(JSON.stringify(partialWrite.json.data)).not.toContain(
      FAKE_PK_INSTANCE
    );
    expect(partialWrite.json.render).toMatchObject({
      mapboxAccessToken: FAKE_PK_INSTANCE,
      source: 'instance',
    });
    const storedAfterPartial = await harness
      .getDb()
      .select()
      .from(tablesFor(harness.getDb()).communityMapConfigs)
      .where(
        eq(
          tablesFor(harness.getDb()).communityMapConfigs.communityId,
          withEnv.communityId
        )
      );
    expect(JSON.stringify(storedAfterPartial)).not.toContain(FAKE_PK_INSTANCE);

    // Community token overrides instance fallback
    const overrideWrite = await jsonRequest(
      withEnv.app,
      'PUT',
      '/v2/community/map-config',
      {
        cookie: withEnv.adminCookie,
        body: {
          mapboxStyleUrl: 'mapbox://styles/community/override',
          mapboxAccessToken: FAKE_PK_COMMUNITY,
          exposeMapboxCredentials: true,
          protomapsApiKey: FAKE_PROTOMAPS_KEY,
        },
      }
    );
    expect(overrideWrite.status).toBe(200);
    expect(overrideWrite.json.data.mapboxAccessToken).toBe(FAKE_PK_COMMUNITY);
    expect(overrideWrite.json.render).toMatchObject({
      mapboxAccessToken: FAKE_PK_COMMUNITY,
      source: 'community',
    });

    // Part B: Corrupt sk.* persisted directly in DB is stripped defensively across every read
    const db = harness.getDb();
    const tables = tablesFor(db);
    await db
      .update(tables.communityMapConfigs)
      .set({ mapboxAccessToken: FAKE_SK_SECRET })
      .where(eq(tables.communityMapConfigs.communityId, withEnv.communityId));

    const corruptAuthRead = await jsonRequest(
      withEnv.app,
      'GET',
      '/v2/community/map-config',
      { cookie: withEnv.memberCookie }
    );
    expect(corruptAuthRead.status).toBe(200);
    // Corrupt community token is rejected defensively and falls back cleanly (never emits sk.*)
    expect(corruptAuthRead.rawText).not.toContain(FAKE_SK_SECRET);
    expect(corruptAuthRead.json.data.mapboxAccessToken).toBeNull();
    expect(corruptAuthRead.json.render.mapboxAccessToken).toBe(
      FAKE_PK_INSTANCE
    );
    expect(corruptAuthRead.json.render.source).toBe('instance');

    for (const publicPath of [
      '/v2/public/communities',
      `/v2/public/communities/${withEnv.communitySlug}`,
      '/explore/communities',
      `/explore/communities/${withEnv.communitySlug}`,
    ]) {
      const pubRes = await jsonRequest(withEnv.app, 'GET', publicPath);
      expect(pubRes.status).toBe(200);
      expect(pubRes.rawText).not.toContain(FAKE_SK_SECRET);
      expect(pubRes.rawText).not.toContain(FAKE_PK_INSTANCE);
      expect(pubRes.rawText).not.toContain(
        'mapbox://styles/community/override'
      );
    }

    // Restore clean community pk.* before verifying offline mode
    await db
      .update(tables.communityMapConfigs)
      .set({ mapboxAccessToken: FAKE_PK_COMMUNITY })
      .where(eq(tables.communityMapConfigs.communityId, withEnv.communityId));

    // Part C: offlineMode=true suppresses Mapbox style/token & protomapsApiKey across all endpoints
    const { app: offlineApp } = harness.makeApp({
      mapboxAccessToken: FAKE_PK_INSTANCE,
      offlineMode: true,
    });
    for (const authedPath of ['/v2/community/map-config', '/v2/community']) {
      const res = await jsonRequest(offlineApp, 'GET', authedPath, {
        cookie: withEnv.memberCookie,
      });
      expect(res.status).toBe(200);
      const mapCfg =
        authedPath === '/v2/community'
          ? res.json.data.mapConfig
          : res.json.data;
      // Raw stored fields round-trip even offline; only render is suppressed.
      expect(mapCfg.mapboxStyleUrl).toBe('mapbox://styles/community/override');
      expect(mapCfg.mapboxAccessToken).toBe(FAKE_PK_COMMUNITY);
      expect(mapCfg.protomapsApiKey).toBe(FAKE_PROTOMAPS_KEY);
      const render =
        authedPath === '/v2/community'
          ? res.json.data.mapRender
          : res.json.render;
      expect(render).toEqual({
        mapboxStyleUrl: null,
        mapboxAccessToken: null,
        source: 'none',
      });
      expect(res.rawText).not.toContain(FAKE_PK_INSTANCE);
    }

    const offlineWrite = await jsonRequest(
      offlineApp,
      'PUT',
      '/v2/community/map-config',
      {
        cookie: withEnv.adminCookie,
        body: {
          mapboxStyleUrl: 'mapbox://styles/community/override',
          mapboxAccessToken: FAKE_PK_COMMUNITY,
          exposeMapboxCredentials: true,
          protomapsApiKey: FAKE_PROTOMAPS_KEY,
        },
      }
    );
    expect(offlineWrite.status).toBe(200);
    expect(offlineWrite.json.data.mapboxAccessToken).toBe(FAKE_PK_COMMUNITY);
    expect(offlineWrite.json.render.source).toBe('none');

    for (const pubPath of [
      '/v2/public/communities',
      `/v2/public/communities/${withEnv.communitySlug}`,
      '/explore/communities',
      `/explore/communities/${withEnv.communitySlug}`,
    ]) {
      const res = await jsonRequest(offlineApp, 'GET', pubPath);
      expect(res.status).toBe(200);
      expect(res.rawText).not.toContain(FAKE_PK_COMMUNITY);
      expect(res.rawText).not.toContain('mapbox://styles/community/override');
      expect(res.rawText).not.toContain(FAKE_PROTOMAPS_KEY);
    }
  });

  it('keeps stored provider fields when a PUT omits them; explicit null clears; offline save preserves', async () => {
    const ctx = await harness.seedCommunityAndActors({
      visibility: 'public',
      slug: 'omit-preserve',
    });
    const put = (app: typeof ctx.app, body: Record<string, unknown>) =>
      jsonRequest(app, 'PUT', '/v2/community/map-config', {
        cookie: ctx.adminCookie,
        body,
      });
    const seeded = await put(ctx.app, {
      mapboxStyleUrl: 'mapbox://styles/community/keep-me',
      mapboxAccessToken: FAKE_PK_COMMUNITY,
      exposeMapboxCredentials: true,
      mapbox3d: true,
      protomapsApiKey: FAKE_PROTOMAPS_KEY,
      protomapsBasemapStyle: 'light',
    });
    expect(seeded.status).toBe(200);

    // Older client: omits every provider key.
    const omitted = await put(ctx.app, { zoom: 5 });
    expect(omitted.status).toBe(200);
    expect(omitted.json.data).toMatchObject({
      mapboxStyleUrl: 'mapbox://styles/community/keep-me',
      mapboxAccessToken: FAKE_PK_COMMUNITY,
      exposeMapboxCredentials: true,
      mapbox3d: true,
      protomapsApiKey: FAKE_PROTOMAPS_KEY,
      protomapsBasemapStyle: 'light',
      zoom: 5,
    });

    // Partial: replacing only the style keeps the stored token.
    const styleOnly = await put(ctx.app, {
      mapboxStyleUrl: 'mapbox://styles/community/second',
    });
    expect(styleOnly.status).toBe(200);
    expect(styleOnly.json.data.mapboxAccessToken).toBe(FAKE_PK_COMMUNITY);

    // Explicit null on one half of the pair is still a half-pair: 400.
    const halfClear = await put(ctx.app, { mapboxAccessToken: null });
    expect(halfClear.status).toBe(400);

    // Explicit null clears single fields.
    const cleared = await put(ctx.app, {
      protomapsApiKey: null,
      protomapsBasemapStyle: null,
      mapbox3d: false,
    });
    expect(cleared.status).toBe(200);
    expect(cleared.json.data).toMatchObject({
      protomapsApiKey: null,
      protomapsBasemapStyle: null,
      mapbox3d: false,
      mapboxStyleUrl: 'mapbox://styles/community/second',
      mapboxAccessToken: FAKE_PK_COMMUNITY,
    });

    // Offline-mode save omitting provider keys preserves stored values.
    const { app: offlineApp } = harness.makeApp({ offlineMode: true });
    const offlineSave = await put(offlineApp, { zoom: 7 });
    expect(offlineSave.status).toBe(200);
    expect(offlineSave.json.render.source).toBe('none');
    const afterOffline = await jsonRequest(
      ctx.app,
      'GET',
      '/v2/community/map-config',
      { cookie: ctx.adminCookie }
    );
    expect(afterOffline.json.data).toMatchObject({
      mapboxStyleUrl: 'mapbox://styles/community/second',
      mapboxAccessToken: FAKE_PK_COMMUNITY,
      exposeMapboxCredentials: true,
      zoom: 7,
    });
  });

  it('enforces the public exposure matrix and atomic expose reset when visibility transitions to private', async () => {
    const ctx = await harness.seedCommunityAndActors({
      visibility: 'public',
      slug: 'matrix-comm',
    });

    // 1. Public + expose=false -> style/token hidden publicly, protomapsApiKey never exposed
    const setHidden = await jsonRequest(
      ctx.app,
      'PUT',
      '/v2/community/map-config',
      {
        cookie: ctx.adminCookie,
        body: {
          mapboxStyleUrl: 'mapbox://styles/matrix/hidden-v1',
          mapboxAccessToken: FAKE_PK_COMMUNITY,
          exposeMapboxCredentials: false,
          mapbox3d: true,
          protomapsApiKey: FAKE_PROTOMAPS_KEY,
          protomapsBasemapStyle: 'grayscale',
        },
      }
    );
    expect(setHidden.status).toBe(200);

    const pubListBefore = await jsonRequest(
      ctx.app,
      'GET',
      '/v2/public/communities'
    );
    const pubDetailBefore = await jsonRequest(
      ctx.app,
      'GET',
      `/v2/public/communities/${ctx.communitySlug}`
    );
    const exploreIndexBefore = await jsonRequest(
      ctx.app,
      'GET',
      '/explore/communities'
    );
    const exploreShowBefore = await jsonRequest(
      ctx.app,
      'GET',
      `/explore/communities/${ctx.communitySlug}`
    );

    for (const res of [
      pubListBefore,
      pubDetailBefore,
      exploreIndexBefore,
      exploreShowBefore,
    ]) {
      expect(res.status).toBe(200);
      expect(res.rawText).not.toContain(FAKE_PK_COMMUNITY);
      // Rails parity: protomaps key is a public, origin-restricted key.
      expect(res.rawText).toContain(FAKE_PROTOMAPS_KEY);
      expect(res.rawText).not.toContain('mapbox://styles/matrix/hidden-v1');
    }
    expect(pubDetailBefore.json.data.mapConfig).toMatchObject({
      mapboxStyleUrl: null,
      mapboxAccessToken: null,
      mapbox3d: true,
      protomapsBasemapStyle: 'grayscale',
      protomapsApiKey: FAKE_PROTOMAPS_KEY,
    });
    expect(exploreShowBefore.json.data.mapConfig).toMatchObject({
      mapboxAccessToken: null,
      mapboxStyle: null,
      mapbox3dEnabled: true,
    });

    // 2. Public + expose=true -> Mapbox style/token exposed on all 4 public/Explore routes; protomapsApiKey also served (Rails parity)
    const setExposed = await jsonRequest(
      ctx.app,
      'PUT',
      '/v2/community/map-config',
      {
        cookie: ctx.adminCookie,
        body: {
          mapboxStyleUrl: 'mapbox://styles/matrix/exposed-v2',
          mapboxAccessToken: FAKE_PK_COMMUNITY,
          exposeMapboxCredentials: true,
          mapbox3d: true,
          protomapsApiKey: FAKE_PROTOMAPS_KEY,
          protomapsBasemapStyle: 'white',
        },
      }
    );
    expect(setExposed.status).toBe(200);

    const pubListExposed = await jsonRequest(
      ctx.app,
      'GET',
      '/v2/public/communities'
    );
    const pubDetailExposed = await jsonRequest(
      ctx.app,
      'GET',
      `/v2/public/communities/${ctx.communitySlug}`
    );
    const exploreIndexExposed = await jsonRequest(
      ctx.app,
      'GET',
      '/explore/communities'
    );
    const exploreShowExposed = await jsonRequest(
      ctx.app,
      'GET',
      `/explore/communities/${ctx.communitySlug}`
    );

    expect(pubListExposed.status).toBe(200);
    expect(
      pubListExposed.json.data.find(
        (c: { slug: string }) => c.slug === ctx.communitySlug
      ).mapConfig
    ).toMatchObject({
      mapboxStyleUrl: 'mapbox://styles/matrix/exposed-v2',
      mapboxAccessToken: FAKE_PK_COMMUNITY,
    });
    expect(pubDetailExposed.status).toBe(200);
    expect(pubDetailExposed.json.data.mapConfig).toMatchObject({
      mapboxStyleUrl: 'mapbox://styles/matrix/exposed-v2',
      mapboxAccessToken: FAKE_PK_COMMUNITY,
      mapbox3d: true,
      protomapsBasemapStyle: 'white',
    });
    expect(exploreIndexExposed.status).toBe(200);
    expect(
      exploreIndexExposed.json.data.find(
        (c: { slug: string }) => c.slug === ctx.communitySlug
      ).mapConfig
    ).toMatchObject({
      mapboxStyle: 'mapbox://styles/matrix/exposed-v2',
      mapboxAccessToken: FAKE_PK_COMMUNITY,
      mapbox3dEnabled: true,
    });
    expect(exploreShowExposed.status).toBe(200);
    expect(exploreShowExposed.json.data.mapConfig).toMatchObject({
      mapboxStyle: 'mapbox://styles/matrix/exposed-v2',
      mapboxAccessToken: FAKE_PK_COMMUNITY,
      mapbox3dEnabled: true,
    });
    for (const res of [
      pubListExposed,
      pubDetailExposed,
      exploreIndexExposed,
      exploreShowExposed,
    ]) {
      expect(res.rawText).toContain(FAKE_PROTOMAPS_KEY);
    }

    // 3. PATCH /v2/community { visibility: 'private' } atomically resets expose_mapbox_credentials = false
    const makePrivateRes = await jsonRequest(
      ctx.app,
      'PATCH',
      '/v2/community',
      {
        cookie: ctx.adminCookie,
        body: { visibility: 'private' },
      }
    );
    expect(makePrivateRes.status).toBe(200);
    expect(makePrivateRes.json.data.visibility).toBe('private');
    expect(makePrivateRes.json.data.mapConfig.exposeMapboxCredentials).toBe(
      false
    );

    // Private community is absent/404 from public & Explore
    const pubListPriv = await jsonRequest(
      ctx.app,
      'GET',
      '/v2/public/communities'
    );
    expect(pubListPriv.status).toBe(200);
    expect(
      pubListPriv.json.data.some(
        (c: { slug: string }) => c.slug === ctx.communitySlug
      )
    ).toBe(false);
    expect(
      (
        await jsonRequest(
          ctx.app,
          'GET',
          `/v2/public/communities/${ctx.communitySlug}`
        )
      ).status
    ).toBe(404);
    const exploreIndexPriv = await jsonRequest(
      ctx.app,
      'GET',
      '/explore/communities'
    );
    expect(
      exploreIndexPriv.json.data.some(
        (c: { slug: string }) => c.slug === ctx.communitySlug
      )
    ).toBe(false);
    expect(
      (
        await jsonRequest(
          ctx.app,
          'GET',
          `/explore/communities/${ctx.communitySlug}`
        )
      ).status
    ).toBe(404);

    // Re-opening public later keeps exposeMapboxCredentials=false (must be explicitly re-enabled)
    const reopenRes = await jsonRequest(ctx.app, 'PATCH', '/v2/community', {
      cookie: ctx.adminCookie,
      body: { visibility: 'public' },
    });
    expect(reopenRes.status).toBe(200);
    expect(reopenRes.json.data.mapConfig.exposeMapboxCredentials).toBe(false);
    const pubDetailReopened = await jsonRequest(
      ctx.app,
      'GET',
      `/v2/public/communities/${ctx.communitySlug}`
    );
    expect(pubDetailReopened.status).toBe(200);
    expect(pubDetailReopened.json.data.mapConfig.mapboxStyleUrl).toBeNull();
    expect(pubDetailReopened.json.data.mapConfig.mapboxAccessToken).toBeNull();
    expect(pubDetailReopened.rawText).not.toContain(FAKE_PK_COMMUNITY);
  });

  it('coerces exposeMapboxCredentials=true to false on PUT when the community is private', async () => {
    const ctx = await harness.seedCommunityAndActors({
      visibility: 'private',
      slug: 'private-expose-comm',
    });
    const res = await jsonRequest(ctx.app, 'PUT', '/v2/community/map-config', {
      cookie: ctx.adminCookie,
      body: {
        mapboxStyleUrl: 'mapbox://styles/community/private-v1',
        mapboxAccessToken: FAKE_PK_COMMUNITY,
        exposeMapboxCredentials: true,
      },
    });
    expect(res.status).toBe(200);
    expect(res.json.data.exposeMapboxCredentials).toBe(false);
    // Update path (existing row) coerces too.
    const again = await jsonRequest(
      ctx.app,
      'PUT',
      '/v2/community/map-config',
      {
        cookie: ctx.adminCookie,
        body: { exposeMapboxCredentials: true, zoom: 4 },
      }
    );
    expect(again.status).toBe(200);
    expect(again.json.data.exposeMapboxCredentials).toBe(false);
    const read = await jsonRequest(ctx.app, 'GET', '/v2/community/map-config', {
      cookie: ctx.adminCookie,
    });
    expect(read.json.data.exposeMapboxCredentials).toBe(false);
  });

  it('preserves omitted provider fields and guards the merged style/token pair inside the upsert', async () => {
    const ctx = await harness.seedCommunityAndActors({
      visibility: 'public',
      slug: 'atomic-merge-comm',
    });
    const db = harness.getDb();
    const repo = new CommunityWritesRepository(db);
    const base = {
      styleUrl: null,
      basemapStyle: null,
      centerLatitude: null,
      centerLongitude: null,
      southWestLatitude: null,
      southWestLongitude: null,
      northEastLatitude: null,
      northEastLongitude: null,
      zoom: null,
      pitch: null,
      bearing: null,
      threeDimensional: null,
      projection: null,
      staticMapFileId: null,
    };
    const first = await repo.upsertCommunityMapConfig(
      ctx.communityId,
      ctx.adminId,
      {
        ...base,
        mapboxStyleUrl: 'mapbox://styles/atomic/one',
        mapboxAccessToken: FAKE_PK_COMMUNITY,
        exposeMapboxCredentials: true,
        mapbox3d: true,
        protomapsApiKey: FAKE_PROTOMAPS_KEY,
      },
      [],
      harness.getNow()
    );
    expect(first?.exposeMapboxCredentials).toBe(true);
    // Omitted provider keys (undefined) keep stored values.
    const kept = await repo.upsertCommunityMapConfig(
      ctx.communityId,
      ctx.adminId,
      { ...base, zoom: 3 },
      [],
      harness.getNow()
    );
    expect(kept).toMatchObject({
      mapboxStyleUrl: 'mapbox://styles/atomic/one',
      mapboxAccessToken: FAKE_PK_COMMUNITY,
      exposeMapboxCredentials: true,
      mapbox3d: true,
      protomapsApiKey: FAKE_PROTOMAPS_KEY,
      zoom: 3,
    });
    // Clearing only the token would leave a half pair: write is refused.
    const refused = await repo.upsertCommunityMapConfig(
      ctx.communityId,
      ctx.adminId,
      { ...base, mapboxAccessToken: null, zoom: 9 },
      [],
      harness.getNow()
    );
    expect(refused).toBeNull();
    const tables = tablesFor(db);
    const [row] = await db
      .select({
        token: tables.communityMapConfigs.mapboxAccessToken,
        zoom: tables.communityMapConfigs.zoom,
      })
      .from(tables.communityMapConfigs)
      .where(eq(tables.communityMapConfigs.communityId, ctx.communityId));
    expect(row?.token).toBe(FAKE_PK_COMMUNITY);
    expect(row?.zoom).toBe(3);
  });

  it('includes mapConfig fields and classified provider credentials deterministically in export manifests, and clears them on erasure', async () => {
    const ctx = await harness.seedCommunityAndActors({
      visibility: 'public',
      slug: 'export-erase-comm',
    });

    const writeRes = await jsonRequest(
      ctx.app,
      'PUT',
      '/v2/community/map-config',
      {
        cookie: ctx.adminCookie,
        body: {
          mapboxStyleUrl: 'mapbox://styles/export/comm-v1',
          mapboxAccessToken: FAKE_PK_COMMUNITY,
          exposeMapboxCredentials: true,
          mapbox3d: true,
          protomapsApiKey: FAKE_PROTOMAPS_KEY,
          protomapsBasemapStyle: 'black',
        },
      }
    );
    expect(writeRes.status).toBe(200);

    // Export manifest snapshot & determinism check
    const db = harness.getDb();
    const tables = tablesFor(db);
    const exportRepo = new CommunityExportRepository(db);
    const snapshot = await exportRepo.readCommunityExportSnapshot(
      ctx.communityId
    );
    expect(snapshot).not.toBeNull();
    const mediaArchive = {
      checksum: '0'.repeat(64),
      byteSize: 0,
      fileCount: 0,
    };
    const first = await buildCommunityExportManifest(
      snapshot!,
      [],
      mediaArchive
    );
    const second = await buildCommunityExportManifest(
      snapshot!,
      [],
      mediaArchive
    );
    expect(second.checksum).toBe(first.checksum);
    expect(first.manifest.exclusions.credentialsExcluded).toBe(true);
    expect(first.manifest.mapConfig).toMatchObject({
      mapboxStyleUrl: 'mapbox://styles/export/comm-v1',
      exposeMapboxCredentials: true,
      mapbox3d: true,
      protomapsBasemapStyle: 'black',
      credentials: {
        classification: 'community_owned_map_provider_credential',
        containsCredentials: true,
        mapboxAccessToken: FAKE_PK_COMMUNITY,
        protomapsApiKey: FAKE_PROTOMAPS_KEY,
      },
    });
    expect(first.jsonText).not.toContain('passwordHash');
    expect(first.jsonText).not.toContain('passwordVerifier');

    // Erasure clears community_map_configs rows and leaks zero tokens to erasure/audit stores
    const now = harness.getNow();
    await db.insert(tables.communityArchiveCustody).values({
      communityId: ctx.communityId,
      custodianType: 'community',
      custodianUserId: ctx.adminId,
      status: 'destroyed',
      retentionUntil: now.getTime(),
      destroyedAt: now.getTime(),
      destructionAttestationRef: 'attestation-mapbox-test',
      createdAt: 0,
      updatedAt: 0,
    });

    const eraseReq = await jsonRequest(
      ctx.app,
      'POST',
      '/v2/community/erasure',
      {
        cookie: ctx.adminCookie,
        body: {
          confirmFinality: true,
          currentDerivedKey: ctx.adminDerivedKey,
        },
      }
    );
    expect(eraseReq.status).toBe(202);

    await ctx.erasureService.sweep(now);

    expect(
      await db
        .select()
        .from(tables.communityMapConfigs)
        .where(eq(tables.communityMapConfigs.communityId, ctx.communityId))
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(tables.communities)
        .where(eq(tables.communities.id, ctx.communityId))
    ).toHaveLength(0);

    const remainingAudits = JSON.stringify(
      await db.select().from(tables.auditEntries)
    );
    const storeDump = JSON.stringify([...ctx.erasureRecords.values()]);
    for (const secret of [FAKE_PK_COMMUNITY, FAKE_PROTOMAPS_KEY]) {
      expect(remainingAudits).not.toContain(secret);
      expect(storeDump).not.toContain(secret);
    }
  });
}

describe('Mapbox & Protomaps map-config (SQLite + unit + D1 batch)', () => {
  let currentNow = new Date(BASE_TIME.getTime());
  let sqliteClient: Sqlite.Database | null = null;
  let sqliteDb: Database | null = null;

  beforeEach(() => {
    currentNow = new Date(BASE_TIME.getTime());
    sqliteClient = new Sqlite(':memory:');
    sqliteClient.pragma('foreign_keys = ON');
    sqliteDb = drizzleSqlite(sqliteClient);
    migrateSqlite(sqliteDb, { migrationsFolder: 'src/db/migrations' });
  });

  afterEach(() => {
    sqliteClient?.close();
    sqliteClient = null;
    sqliteDb = null;
  });

  registerSharedMapboxTests(
    buildHarnessHelpers(
      'sqlite',
      () => sqliteDb!,
      () => currentNow
    )
  );

  it('executes upsertCommunityMapConfig + audit and visibility=private reset atomically in D1 db.batch()', async () => {
    const batchSqlite = new Sqlite(':memory:');
    batchSqlite.pragma('foreign_keys = ON');
    const localDb = drizzleSqlite(batchSqlite);
    migrateSqlite(localDb, { migrationsFolder: 'src/db/migrations' });
    const tables = tablesFor(localDb);

    try {
      const [comm] = await localDb
        .insert(tables.communities)
        .values({
          name: 'D1 Mapbox Comm',
          slug: 'd1-mapbox-comm',
          publicStories: true,
          isActive: true,
          createdAt: currentNow,
          updatedAt: currentNow,
        })
        .returning({ id: tables.communities.id });
      const email = 'd1mapbox@example.test';
      const [actor] = await localDb
        .insert(tables.users)
        .values({
          email,
          username: 'd1mapbox',
          ...deriveUserIdentityColumns({ email, username: 'd1mapbox' }),
          firstName: 'D1',
          lastName: 'Mapbox',
          passwordHash: 'hash',
          role: 'admin',
          communityId: comm!.id,
          isActive: true,
          createdAt: currentNow,
          updatedAt: currentNow,
        })
        .returning({ id: tables.users.id });

      const batchCalls: string[][] = [];
      const d1Client = {
        prepare(querySql: string) {
          let params: unknown[] = [];
          const stmt = {
            bind(...vals: unknown[]) {
              params = vals;
              return stmt;
            },
            all: async () => ({
              results: batchSqlite.prepare(querySql).all(...params),
              success: true,
              meta: {},
            }),
            raw: async () =>
              batchSqlite
                .prepare(querySql)
                .raw(true)
                .all(...params),
            first: async () =>
              batchSqlite.prepare(querySql).get(...params) ?? null,
            run: async () => {
              const info = batchSqlite.prepare(querySql).run(...params);
              return { success: true, meta: { changes: info.changes } };
            },
            _sql: querySql,
            _exec() {
              const prepared = batchSqlite.prepare(querySql);
              if (prepared.reader) {
                return { results: prepared.all(...params), success: true };
              }
              const info = prepared.run(...params);
              return {
                results: [],
                success: true,
                meta: { changes: info.changes },
              };
            },
          };
          return stmt;
        },
        async batch(stmts: Array<{ _sql: string; _exec: () => unknown }>) {
          batchCalls.push(stmts.map((s) => s._sql));
          return batchSqlite.transaction(() => stmts.map((s) => s._exec()))();
        },
      };
      const d1Db = drizzleD1(
        d1Client as unknown as Parameters<typeof drizzleD1>[0]
      );

      const repo = new CommunityWritesRepository(d1Db as unknown as Database);
      const saved = await repo.upsertCommunityMapConfig(
        comm!.id,
        actor!.id,
        {
          styleUrl: null,
          basemapStyle: null,
          mapboxStyleUrl: 'mapbox://styles/d1/batch-v1',
          mapboxAccessToken: FAKE_PK_COMMUNITY,
          exposeMapboxCredentials: true,
          mapbox3d: true,
          protomapsApiKey: FAKE_PROTOMAPS_KEY,
          protomapsBasemapStyle: 'light',
          centerLatitude: null,
          centerLongitude: null,
          southWestLatitude: null,
          southWestLongitude: null,
          northEastLatitude: null,
          northEastLongitude: null,
          zoom: null,
          pitch: null,
          bearing: null,
          threeDimensional: null,
          projection: null,
          staticMapFileId: null,
        },
        ['exposeMapboxCredentials', 'mapboxAccessToken', 'mapboxStyleUrl'],
        currentNow
      );
      expect(saved?.mapboxStyleUrl).toBe('mapbox://styles/d1/batch-v1');
      expect(saved?.mapboxAccessToken).toBe(FAKE_PK_COMMUNITY);
      expect(saved?.exposeMapboxCredentials).toBe(true);
      expect(saved?.mapbox3d).toBe(true);
      expect(saved?.protomapsApiKey).toBe(FAKE_PROTOMAPS_KEY);
      expect(batchCalls).toHaveLength(1);
      expect(batchCalls[0]).toHaveLength(2);
      expect(batchCalls[0]![0]).toMatch(/^insert into "audit_entries"/i);
      expect(batchCalls[0]![1]).toMatch(/insert into "community_map_configs"/i);

      const privRes = await repo.updateCommunitySettings(
        comm!.id,
        actor!.id,
        { visibility: 'private' },
        currentNow
      );
      expect(privRes.updated).toBe(true);
      expect(batchCalls).toHaveLength(2);
      expect(batchCalls[1]).toHaveLength(3);
      expect(batchCalls[1]![0]).toMatch(/^insert into "audit_entries"/i);
      expect(batchCalls[1]![1]).toMatch(/^update "communities"/i);
      expect(batchCalls[1]![2]).toMatch(/^update "community_map_configs"/i);

      const [rowAfter] = await localDb
        .select({
          exposeMapboxCredentials:
            tables.communityMapConfigs.exposeMapboxCredentials,
        })
        .from(tables.communityMapConfigs)
        .where(eq(tables.communityMapConfigs.communityId, comm!.id));
      expect(Boolean(rowAfter?.exposeMapboxCredentials)).toBe(false);
    } finally {
      batchSqlite.close();
    }
  });

  it('writes no audit row in D1 db.batch() when the merged pair guard rejects the upsert', async () => {
    const batchSqlite = new Sqlite(':memory:');
    batchSqlite.pragma('foreign_keys = ON');
    const localDb = drizzleSqlite(batchSqlite);
    migrateSqlite(localDb, { migrationsFolder: 'src/db/migrations' });
    const tables = tablesFor(localDb);

    try {
      const [comm] = await localDb
        .insert(tables.communities)
        .values({
          name: 'D1 Guard Comm',
          slug: 'd1-guard-comm',
          publicStories: true,
          isActive: true,
          createdAt: currentNow,
          updatedAt: currentNow,
        })
        .returning({ id: tables.communities.id });
      const email = 'd1guard@example.test';
      const [actor] = await localDb
        .insert(tables.users)
        .values({
          email,
          username: 'd1guard',
          ...deriveUserIdentityColumns({ email, username: 'd1guard' }),
          firstName: 'D1',
          lastName: 'Guard',
          passwordHash: 'hash',
          role: 'admin',
          communityId: comm!.id,
          isActive: true,
          createdAt: currentNow,
          updatedAt: currentNow,
        })
        .returning({ id: tables.users.id });

      const d1Client = {
        prepare(querySql: string) {
          let params: unknown[] = [];
          const stmt = {
            bind(...vals: unknown[]) {
              params = vals;
              return stmt;
            },
            all: async () => ({
              results: batchSqlite.prepare(querySql).all(...params),
              success: true,
              meta: {},
            }),
            raw: async () =>
              batchSqlite
                .prepare(querySql)
                .raw(true)
                .all(...params),
            run: async () => {
              const info = batchSqlite.prepare(querySql).run(...params);
              return { success: true, meta: { changes: info.changes } };
            },
            _exec() {
              const prepared = batchSqlite.prepare(querySql);
              if (prepared.reader) {
                return { results: prepared.all(...params), success: true };
              }
              const info = prepared.run(...params);
              return {
                results: [],
                success: true,
                meta: { changes: info.changes },
              };
            },
          };
          return stmt;
        },
        async batch(stmts: Array<{ _exec: () => unknown }>) {
          return batchSqlite.transaction(() => stmts.map((s) => s._exec()))();
        },
      };
      const d1Db = drizzleD1(
        d1Client as unknown as Parameters<typeof drizzleD1>[0]
      );
      const repo = new CommunityWritesRepository(d1Db as unknown as Database);
      const base = {
        styleUrl: null,
        basemapStyle: null,
        centerLatitude: null,
        centerLongitude: null,
        southWestLatitude: null,
        southWestLongitude: null,
        northEastLatitude: null,
        northEastLongitude: null,
        zoom: null,
        pitch: null,
        bearing: null,
        threeDimensional: null,
        projection: null,
        staticMapFileId: null,
      };
      const countAudits = async () =>
        (
          await localDb
            .select({ id: tables.auditEntries.id })
            .from(tables.auditEntries)
            .where(
              eq(tables.auditEntries.action, 'community.map_config.update')
            )
        ).length;

      const first = await repo.upsertCommunityMapConfig(
        comm!.id,
        actor!.id,
        {
          ...base,
          mapboxStyleUrl: 'mapbox://styles/d1/guard-v1',
          mapboxAccessToken: FAKE_PK_COMMUNITY,
        },
        ['mapboxAccessToken', 'mapboxStyleUrl'],
        currentNow
      );
      expect(first?.mapboxStyleUrl).toBe('mapbox://styles/d1/guard-v1');
      expect(await countAudits()).toBe(1);

      // Clearing only the token leaves a half pair: guard rejects, same
      // timestamp as the previous write, no success audit is recorded.
      const refused = await repo.upsertCommunityMapConfig(
        comm!.id,
        actor!.id,
        { ...base, mapboxAccessToken: null, zoom: 9 },
        ['mapboxAccessToken', 'zoom'],
        currentNow
      );
      expect(refused).toBeNull();
      expect(await countAudits()).toBe(1);
      const [row] = await localDb
        .select({
          token: tables.communityMapConfigs.mapboxAccessToken,
          zoom: tables.communityMapConfigs.zoom,
        })
        .from(tables.communityMapConfigs)
        .where(eq(tables.communityMapConfigs.communityId, comm!.id));
      expect(row?.token).toBe(FAKE_PK_COMMUNITY);
      expect(row?.zoom).toBeNull();

      // A valid follow-up save still audits.
      const kept = await repo.upsertCommunityMapConfig(
        comm!.id,
        actor!.id,
        { ...base, zoom: 4 },
        ['zoom'],
        currentNow
      );
      expect(kept?.zoom).toBe(4);
      expect(await countAudits()).toBe(2);
    } finally {
      batchSqlite.close();
    }
  });

  it('validates optional MAPBOX_ACCESS_TOKEN in Node and Worker runtime configs without echoing invalid tokens', () => {
    const validSecret = makeServerSecret();
    const validBootstrap = makeServerSecret();

    const nodeOk = validateNodeV2Runtime({
      NODE_ENV: 'production',
      HONO_PUBLIC_ORIGIN: 'https://api.terrastories.org',
      AUTH_SERVER_SECRET: validSecret,
      BOOTSTRAP_SECRET: validBootstrap,
      MAPBOX_ACCESS_TOKEN: FAKE_PK_INSTANCE,
    });
    expect(nodeOk.mapboxAccessToken).toBe(FAKE_PK_INSTANCE);

    const nodeBlank = validateNodeV2Runtime({
      NODE_ENV: 'production',
      HONO_PUBLIC_ORIGIN: 'https://api.terrastories.org',
      AUTH_SERVER_SECRET: validSecret,
      BOOTSTRAP_SECRET: validBootstrap,
      MAPBOX_ACCESS_TOKEN: '   ',
    });
    expect(nodeBlank.mapboxAccessToken).toBeUndefined();

    const workerOk = validateWorkerV2Runtime({
      ENVIRONMENT: 'production',
      PUBLIC_ORIGIN: 'https://api.terrastories.org',
      AUTH_SERVER_SECRET: validSecret,
      BOOTSTRAP_SECRET: validBootstrap,
      MAPBOX_ACCESS_TOKEN: FAKE_PK_INSTANCE,
      DB: {},
      MEDIA: {},
    });
    expect(workerOk.mapboxAccessToken).toBe(FAKE_PK_INSTANCE);

    for (const badToken of [FAKE_SK_SECRET, 'bad-token-no-prefix']) {
      const nodeError = captureThrown(() =>
        validateNodeV2Runtime({
          NODE_ENV: 'production',
          HONO_PUBLIC_ORIGIN: 'https://api.terrastories.org',
          AUTH_SERVER_SECRET: validSecret,
          BOOTSTRAP_SECRET: validBootstrap,
          MAPBOX_ACCESS_TOKEN: badToken,
        })
      );
      expect(nodeError).toBeInstanceOf(Error);
      expect(nodeError!.message).not.toContain(badToken);

      const workerError = captureThrown(() =>
        validateWorkerV2Runtime({
          ENVIRONMENT: 'production',
          PUBLIC_ORIGIN: 'https://api.terrastories.org',
          AUTH_SERVER_SECRET: validSecret,
          BOOTSTRAP_SECRET: validBootstrap,
          MAPBOX_ACCESS_TOKEN: badToken,
          DB: {},
          MEDIA: {},
        })
      );
      expect(workerError).toBeInstanceOf(Error);
      expect(workerError!.message).not.toContain(badToken);
    }
  });
});

describe.skipIf(pgDecision.status !== 'ready')(
  'Mapbox & Protomaps map-config (PostgreSQL)',
  () => {
    let pgClient: ReturnType<typeof createPostgresClient> | null = null;
    let pgDb: Database | null = null;
    const currentNow = new Date(BASE_TIME.getTime());

    beforeAll(async () => {
      pgClient = createPostgresClient(pgDecision.url!, {
        max: 5,
        onnotice: () => undefined,
      });
      await pgClient`DROP SCHEMA IF EXISTS drizzle CASCADE`;
      await pgClient`DROP SCHEMA IF EXISTS public CASCADE`;
      await pgClient`CREATE SCHEMA public`;
      pgDb = drizzlePostgres(pgClient);
      await migratePostgres(pgDb as any, {
        migrationsFolder: 'src/db/migrations/postgres',
      });
    });

    beforeEach(async () => {
      await pgDb!.execute(
        sql.raw(
          'TRUNCATE TABLE "audit_entries", "auth_throttle", "sessions", "community_archive_custody", "community_sovereignty_requests", "community_stewards", "community_map_configs", "files", "stories", "places", "speakers", "users", "communities" RESTART IDENTITY CASCADE'
        )
      );
    });

    afterAll(async () => {
      await pgClient?.end();
      pgClient = null;
      pgDb = null;
    });

    registerSharedMapboxTests(
      buildHarnessHelpers(
        'postgresql',
        () => pgDb!,
        () => currentNow
      )
    );
  }
);
