import { expect, vi } from 'vitest';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import { createHonoApp } from '../../src/hono-app.js';
import { HonoFoundationRepository } from '../../src/repositories/hono-foundation.repository.js';
import { MediaCleanupCoordinator } from '../../src/services/media-cleanup.service.js';
import type {
  FoundationStorage,
  StorageListOptions,
  StoragePutOptions,
  StorageReadRange,
  StorageReadResult,
} from '../../src/services/hono-foundation.service.js';
import type {
  ErasureRecord,
  ErasureRecordStore,
} from '../../src/services/erasure-record-store.js';
import { tablesFor } from '../../src/db/dialect.js';
import { deriveUserIdentityColumns } from '../../src/shared/utils/derived-columns.js';
import {
  ARGON2ID_ALGORITHM,
  ARGON2ID_PARAMS,
} from '../../src/shared/auth-policy.js';
import { sha256Hex, toBase64Url } from '../../src/shared/auth-crypto.js';
import {
  argon2Seed,
  makeDerivedKey,
  makeServerSecret,
  makeVerifierSalt,
} from './auth-test-utils.js';
import {
  assertPutSha256,
  rawUploadRequest,
  sha256Hex as digestHex,
} from '../helpers/raw-upload.js';

export const API_ORIGIN = 'https://api.example.test';
export const CLIENT_ORIGIN = 'https://app.example.test';
export const RESILIENCE_NOW = new Date('2026-06-01T12:00:00.000Z');
export const CLIENT_IP = '203.0.113.149';

/** Small valid PNG; direct upload still uses the normal 16 MiB part-size floor. */
export const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06,
  0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
]);

export interface ResilienceStorage {
  storage: FoundationStorage;
  store: Map<string, Uint8Array>;
}

/** Listable in-memory storage with the same digest contract as Node storage. */
export function createResilienceStorage(): ResilienceStorage {
  const store = new Map<string, Uint8Array>();
  const storage: FoundationStorage = {
    async read(
      key: string,
      range?: StorageReadRange
    ): Promise<StorageReadResult | null> {
      const bytes = store.get(key);
      if (!bytes) return null;
      return {
        size: bytes.byteLength,
        body: range ? bytes.subarray(range.start, range.end + 1) : bytes,
      };
    },
    async put(
      key: string,
      body: Uint8Array | ReadableStream<Uint8Array>,
      options?: StoragePutOptions
    ) {
      const bytes =
        body instanceof Uint8Array
          ? body
          : new Uint8Array(await new Response(body).arrayBuffer());
      assertPutSha256(bytes, options?.sha256);
      if (
        options?.contentLength !== undefined &&
        bytes.byteLength !== options.contentLength
      )
        throw new Error('Stored body does not match Content-Length');
      store.set(key, bytes);
      return { size: bytes.byteLength };
    },
    async delete(key: string) {
      store.delete(key);
    },
    async fenceCommunity(communityId: number) {
      store.set(`system/erasure-fences/${communityId}`, new Uint8Array(0));
    },
    async list(options?: StorageListOptions) {
      const prefix = options?.prefix ?? '';
      const entries = [...store.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, bytes]) => ({
          key,
          uploaded: new Date(0),
          size: bytes.byteLength,
        }));
      const page = entries.slice(0, options?.limit ?? entries.length);
      return {
        entries: page,
        truncated: page.length < entries.length,
        nextStartAfter:
          page.length < entries.length ? page.at(-1)?.key : undefined,
      };
    },
  };
  return { storage, store };
}

export function createMemoryErasureStore(): {
  records: Map<number, ErasureRecord>;
  store: ErasureRecordStore;
} {
  const records = new Map<number, ErasureRecord>();
  return {
    records,
    store: {
      async list() {
        return [...records.values()];
      },
      async write(record) {
        records.set(record.communityId, record);
      },
    },
  };
}

const openFixtures: Array<{ close: () => void }> = [];

export async function closeResilienceFixtures(): Promise<void> {
  while (openFixtures.length > 0) openFixtures.pop()?.close();
}

export interface ResilienceFixtureOptions {
  storage?: FoundationStorage;
  erasureStore?: ErasureRecordStore;
}

export async function createResilienceFixture(
  options: ResilienceFixtureOptions = {}
) {
  const sqlite = new Sqlite(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: 'src/db/migrations' });
  const tables = tablesFor(db);
  const derivedKey = makeDerivedKey();
  const verifier = await argon2Seed(derivedKey);
  const serverSecret = makeServerSecret();

  const [own] = await db
    .insert(tables.communities)
    .values({
      name: 'Resilience Nation',
      slug: 'resilience-nation',
      locale: 'en',
      publicStories: true,
      isActive: true,
      createdAt: RESILIENCE_NOW,
      updatedAt: RESILIENCE_NOW,
    })
    .returning();
  const [foreign] = await db
    .insert(tables.communities)
    .values({
      name: 'Foreign Nation',
      slug: 'foreign-nation',
      locale: 'en',
      publicStories: true,
      isActive: true,
      createdAt: RESILIENCE_NOW,
      updatedAt: RESILIENCE_NOW,
    })
    .returning();
  const [claimCommunity] = await db
    .insert(tables.communities)
    .values({
      name: 'claimable-nation',
      slug: 'claimable-nation',
      locale: 'en',
      publicStories: false,
      isActive: true,
      createdAt: RESILIENCE_NOW,
      updatedAt: RESILIENCE_NOW,
    })
    .returning();

  const makeUser = async (
    email: string,
    username: string,
    role: 'viewer' | 'member' | 'editor' | 'admin' | 'super_admin',
    communityId: number | null
  ) => {
    const [user] = await db
      .insert(tables.users)
      .values({
        email,
        username,
        ...deriveUserIdentityColumns({ email, username }),
        firstName: 'Resilience',
        lastName: 'User',
        ...verifier,
        role,
        communityId,
        isActive: true,
        createdAt: RESILIENCE_NOW,
        updatedAt: RESILIENCE_NOW,
      })
      .returning();
    return user!;
  };

  const ids = {
    own: own!.id,
    foreign: foreign!.id,
    claimCommunity: claimCommunity!.id,
    superAdmin: 0,
    admin: 0,
    editor: 0,
    editor2: 0,
    member: 0,
    placeA: 0,
    placeB: 0,
    speakerA: 0,
    speakerB: 0,
  };
  ids.superAdmin = (
    await makeUser(
      'super@resilience.example.test',
      'resilience_super',
      'super_admin',
      null
    )
  ).id;
  ids.admin = (
    await makeUser(
      'admin@resilience.example.test',
      'resilience_admin',
      'admin',
      ids.own
    )
  ).id;
  ids.editor = (
    await makeUser(
      'editor@resilience.example.test',
      'resilience_editor',
      'editor',
      ids.own
    )
  ).id;
  ids.editor2 = (
    await makeUser(
      'editor2@resilience.example.test',
      'resilience_editor2',
      'editor',
      ids.own
    )
  ).id;
  ids.member = (
    await makeUser(
      'member@resilience.example.test',
      'resilience_member',
      'member',
      ids.own
    )
  ).id;

  const places = await db
    .insert(tables.places)
    .values([
      {
        name: 'Resilience Place A',
        communityId: ids.own,
        latitude: -3,
        longitude: -60,
        isRestricted: false,
        createdAt: RESILIENCE_NOW,
        updatedAt: RESILIENCE_NOW,
      },
      {
        name: 'Resilience Place B',
        communityId: ids.own,
        latitude: -4,
        longitude: -61,
        isRestricted: false,
        createdAt: RESILIENCE_NOW,
        updatedAt: RESILIENCE_NOW,
      },
    ])
    .returning();
  ids.placeA = places[0]!.id;
  ids.placeB = places[1]!.id;
  const speakers = await db
    .insert(tables.speakers)
    .values([
      {
        name: 'Resilience Speaker A',
        communityId: ids.own,
        isActive: true,
        createdAt: RESILIENCE_NOW,
        updatedAt: RESILIENCE_NOW,
      },
      {
        name: 'Resilience Speaker B',
        communityId: ids.own,
        isActive: true,
        createdAt: RESILIENCE_NOW,
        updatedAt: RESILIENCE_NOW,
      },
    ])
    .returning();
  ids.speakerA = speakers[0]!.id;
  ids.speakerB = speakers[1]!.id;

  const storage = options.storage ?? createResilienceStorage().storage;
  const cleanup = new MediaCleanupCoordinator(db, storage, {
    now: () => RESILIENCE_NOW,
  });
  const app = createHonoApp({
    repository: new HonoFoundationRepository(db),
    storage,
    mediaCleanup: cleanup,
    erasureStore: options.erasureStore,
    serverSecret,
    secureCookies: false,
    publicOrigin: API_ORIGIN,
    corsOrigins: [CLIENT_ORIGIN],
    trustProxy: true,
    now: () => RESILIENCE_NOW,
  });

  const request = async (
    method: string,
    path: string,
    init: {
      cookie?: string;
      body?: unknown;
      headers?: Record<string, string>;
      rawBody?: BodyInit;
    } = {}
  ): Promise<Response> => {
    const headers: Record<string, string> = {
      'x-forwarded-for': CLIENT_IP,
      ...init.headers,
    };
    if (init.cookie) headers.cookie = init.cookie;
    if (
      init.body !== undefined &&
      !Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')
    )
      headers['content-type'] = 'application/json';
    return app.request(`${API_ORIGIN}${path}`, {
      method,
      headers,
      body:
        init.rawBody ??
        (init.body === undefined
          ? undefined
          : typeof init.body === 'string'
            ? init.body
            : JSON.stringify(init.body)),
      duplex: 'half',
    } as RequestInit);
  };

  const login = async (
    email: string,
    communitySlug?: string
  ): Promise<string> => {
    const response = await request('POST', '/v2/auth/login', {
      body: {
        identifier: email,
        derivedKey,
        ...(communitySlug ? { communitySlug } : {}),
      },
    });
    expect(response.status).toBe(200);
    return (response.headers.get('set-cookie') ?? '').split(';')[0]!;
  };

  const cookies = {
    superAdmin: await login('super@resilience.example.test'),
    admin: await login('admin@resilience.example.test', 'resilience-nation'),
    editor: await login('editor@resilience.example.test', 'resilience-nation'),
    editor2: await login(
      'editor2@resilience.example.test',
      'resilience-nation'
    ),
    member: await login('member@resilience.example.test', 'resilience-nation'),
  };

  const uploadMedia = async (
    bytes: Uint8Array = PNG_BYTES,
    cookie = cookies.editor
  ) => {
    const upload = rawUploadRequest({
      filename: 'resilience.png',
      contentType: 'image/png',
      bytes,
    });
    const response = await request('POST', `/v2/media${upload.search}`, {
      cookie,
      headers: upload.headers,
      rawBody: upload.body,
    });
    expect(response.status).toBe(201);
    return (await response.json()) as { data: { id: string } };
  };

  const createStory = async (
    title: string,
    body: Record<string, unknown> = {},
    cookie = cookies.editor
  ) => {
    const response = await request('POST', '/v2/stories', {
      cookie,
      body: { title, visibility: 'editors', ...body },
    });
    expect(response.status).toBe(201);
    return (await response.json()) as { data: { id: number } };
  };

  const attachMedia = async (fileId: string, storyId: number) => {
    const response = await request('POST', '/v2/attachments', {
      cookie: cookies.editor,
      body: {
        fileId,
        ownerType: 'story',
        ownerId: storyId,
        role: 'story_media',
      },
    });
    expect(response.status).toBe(201);
  };

  const createImportPreview = async (
    kind: 'places' | 'stories',
    csvText: string,
    mediaFilename?: string
  ) => {
    const form = new FormData();
    form.set('kind', kind);
    form.set(
      'file',
      new File([csvText], kind === 'stories' ? 'stories.csv' : 'places.csv', {
        type: 'text/csv',
      })
    );
    if (mediaFilename)
      form.set(
        'media',
        new File([PNG_BYTES], mediaFilename, { type: 'image/png' })
      );
    const response = await request('POST', '/v2/imports/preview', {
      cookie: cookies.editor,
      rawBody: form,
    });
    expect(response.status).toBe(201);
    return (await response.json()) as {
      data: { id: number; stagedFileIds: string[] };
    };
  };

  const createDirectUpload = async () => {
    const response = await request('POST', '/v2/media/uploads', {
      cookie: cookies.editor,
      body: {
        filename: 'direct.png',
        contentType: 'image/png',
        size: PNG_BYTES.byteLength,
        sha256: digestHex(PNG_BYTES),
        partSha256: [digestHex(PNG_BYTES)],
      },
    });
    expect(response.status).toBe(201);
    const session = (await response.json()) as {
      data: {
        id: string;
        parts: Array<{ url: string; headers: Record<string, string> }>;
      };
    };
    const target = session.data.parts[0]!;
    const part = await request('PUT', new URL(target.url).pathname, {
      cookie: cookies.editor,
      headers: {
        ...target.headers,
        'content-length': String(PNG_BYTES.byteLength),
      },
      rawBody: PNG_BYTES,
    });
    expect(part.status).toBe(200);
    return {
      id: session.data.id,
      parts: [
        {
          partNumber: 1,
          etag: (part.headers.get('etag') ?? '').replace(/"/g, ''),
        },
      ],
    };
  };

  const insertLoginCode = async (
    userId: number,
    communityId: number | null
  ) => {
    const code = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    await db.insert(tables.loginCodes).values({
      userId,
      communityId,
      purpose: 'admin_issued',
      codeHash: await sha256Hex(code),
      createdBy: ids.admin,
      createdAt: RESILIENCE_NOW.getTime(),
      expiresAt: RESILIENCE_NOW.getTime() + 72 * 60 * 60 * 1000,
    });
    return code;
  };

  const insertClaimToken = async () => {
    const token = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    const [row] = await db
      .insert(tables.claimTokens)
      .values({
        communityId: ids.claimCommunity,
        tokenHash: await sha256Hex(token),
        issuedBy: ids.superAdmin,
        createdAt: RESILIENCE_NOW.getTime(),
        expiresAt: RESILIENCE_NOW.getTime() + 72 * 60 * 60 * 1000,
      })
      .returning();
    return { token, id: row!.id };
  };

  const fixture = {
    sqlite,
    db,
    tables,
    app,
    storage,
    cleanup,
    derivedKey,
    ids,
    cookies,
    request,
    login,
    uploadMedia,
    createStory,
    attachMedia,
    createImportPreview,
    createDirectUpload,
    insertLoginCode,
    insertClaimToken,
    close: () => sqlite.close(),
  };
  openFixtures.push(fixture);
  return fixture;
}

export function passwordPayload(derivedKey = makeDerivedKey()) {
  return {
    algorithm: ARGON2ID_ALGORITHM,
    salt: makeVerifierSalt(),
    params: { ...ARGON2ID_PARAMS },
    derivedKey,
  };
}

/**
 * Execute the matching SQLite statement, then fail once. The surrounding
 * transaction must roll the already-executed write back.
 */
export function failAfterStatement(
  sqlite: Sqlite.Database,
  matches: (sql: string) => boolean,
  method: 'all' | 'run' = 'run'
) {
  let fired = false;
  const originalPrepare = sqlite.prepare.bind(sqlite);
  const spy = vi.spyOn(sqlite, 'prepare').mockImplementation((sql) => {
    const statement = originalPrepare(sql);
    if (!matches(sql)) return statement;
    const original = statement[method].bind(statement);
    vi.spyOn(statement, method).mockImplementation((...params: unknown[]) => {
      const result = original(...params);
      if (!fired) {
        fired = true;
        throw new Error('Injected database failure after statement');
      }
      return result;
    });
    return statement;
  });
  return {
    spy,
    get fired() {
      return fired;
    },
  };
}

export async function storyRow(
  fixture: Awaited<ReturnType<typeof createResilienceFixture>>,
  id: number
) {
  const [row] = await fixture.db
    .select()
    .from(fixture.tables.stories)
    .where(eq(fixture.tables.stories.id, id));
  return row;
}
