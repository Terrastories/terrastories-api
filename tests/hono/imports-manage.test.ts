/**
 * Focused contract, authorization, cross-community isolation, staged-byte
 * cleanup, restart-safe orphan sweep, and concurrent race tests for Slice 12-B:
 * - GET /v2/imports
 * - GET /v2/imports/:id
 * - DELETE /v2/imports/:id
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { and, eq, inArray } from 'drizzle-orm';
import {
  argon2Seed,
  makeDerivedKey,
  makeServerSecret,
} from './auth-test-utils.js';
import { tablesFor } from '../../src/db/dialect.js';
import { createHonoApp } from '../../src/hono-app.js';
import { HonoFoundationRepository } from '../../src/repositories/hono-foundation.repository.js';
import { MediaCleanupCoordinator } from '../../src/services/media-cleanup.service.js';
import type { FoundationStorage } from '../../src/services/hono-foundation.service.js';
import {
  ImportManifestDetailResponseSchema,
  ImportManifestListResponseSchema,
} from '../../src/shared/schemas/imports.js';
import { MediaUploadResponseSchema } from '../../src/shared/schemas/media-v2.js';
import { deriveUserIdentityColumns } from '../../src/shared/utils/derived-columns.js';
import { validateContentFreeAuditEntry } from '../../src/shared/utils/audit-entry.js';

const sqlite = new Sqlite(':memory:');
sqlite.pragma('foreign_keys = ON');
const db = drizzle(sqlite);
const tables = tablesFor(db);

const TEST_DERIVED_KEY = makeDerivedKey();
const API_ORIGIN = 'https://api.example.test';
const CLIENT_ORIGIN = 'https://app.example.test';
const FOREIGN_ORIGIN = 'https://evil.invalid';

const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06,
  0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
]);

function createListableMemoryStorage(): {
  store: Map<
    string,
    { bytes: Uint8Array; contentType?: string; uploaded: Date }
  >;
  storage: FoundationStorage;
} {
  const store = new Map<
    string,
    { bytes: Uint8Array; contentType?: string; uploaded: Date }
  >();
  const storage: FoundationStorage = {
    async read(storageKey, range) {
      const entry = store.get(storageKey);
      if (!entry) return null;
      return {
        size: entry.bytes.byteLength,
        body: range
          ? entry.bytes.subarray(range.start, range.end + 1)
          : entry.bytes,
      };
    },
    async put(storageKey, stream, opts) {
      if (stream instanceof Uint8Array) {
        store.set(storageKey, {
          bytes: stream,
          contentType: opts.contentType,
          uploaded: new Date('2026-06-01T12:00:00.000Z'),
        });
        return;
      }
      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          total += value.byteLength;
        }
      }
      const merged = new Uint8Array(total);
      let pos = 0;
      for (const c of chunks) {
        merged.set(c, pos);
        pos += c.byteLength;
      }
      store.set(storageKey, {
        bytes: merged,
        contentType: opts.contentType,
        uploaded: new Date('2026-06-01T12:00:00.000Z'),
      });
    },
    async delete(storageKey) {
      store.delete(storageKey);
    },
    async list(options) {
      const prefix = options?.prefix ?? '';
      const entries = [...store.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => ({ key, uploaded: entry.uploaded }));
      return { entries, truncated: false };
    },
  };
  return { store, storage };
}

function buildImportMultipart(options: {
  csvFilename?: string;
  csvText?: string;
  fields?: Record<string, string>;
  mediaParts?: Array<{
    fieldName?: string;
    filename: string;
    contentType: string;
    bytes: Uint8Array;
  }>;
}): { body: ReadableStream<Uint8Array>; contentTypeHeader: string } {
  const boundary = `imp-mgr-${Math.random().toString(16).slice(2)}`;
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];

  for (const [key, value] of Object.entries(options.fields ?? {})) {
    chunks.push(
      enc.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`
      )
    );
  }

  if (options.csvText !== undefined) {
    const filename = options.csvFilename ?? 'import.csv';
    chunks.push(
      enc.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/csv\r\n\r\n`
      )
    );
    chunks.push(enc.encode(options.csvText));
    chunks.push(enc.encode('\r\n'));
  }

  for (const media of options.mediaParts ?? []) {
    chunks.push(
      enc.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="${media.fieldName ?? 'media'}"; filename="${media.filename}"\r\nContent-Type: ${media.contentType}\r\n\r\n`
      )
    );
    chunks.push(media.bytes);
    chunks.push(enc.encode('\r\n'));
  }

  chunks.push(enc.encode(`--${boundary}--\r\n`));
  const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const combined = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    combined.set(c, pos);
    pos += c.byteLength;
  }

  return {
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(combined);
        controller.close();
      },
    }),
    contentTypeHeader: `multipart/form-data; boundary=${boundary}`,
  };
}

function createRealD1Db(): {
  db: ReturnType<typeof drizzleD1>;
  sqlite: Sqlite.Database;
} {
  const d1Sqlite = new Sqlite(':memory:');
  d1Sqlite.pragma('foreign_keys = ON');
  migrate(drizzle(d1Sqlite), { migrationsFolder: './src/db/migrations' });
  const client = {
    prepare(query: string) {
      let params: unknown[] = [];
      const stmt = {
        bind(...vals: unknown[]) {
          params = vals;
          return stmt;
        },
        all: async () => ({
          results: d1Sqlite.prepare(query).all(...params),
          success: true,
          meta: {},
        }),
        raw: async () =>
          d1Sqlite
            .prepare(query)
            .raw(true)
            .all(...params),
        first: async () => d1Sqlite.prepare(query).get(...params) ?? null,
        run: async () => {
          const info = d1Sqlite.prepare(query).run(...params);
          return { success: true, meta: { changes: info.changes } };
        },
        _exec() {
          const prepared = d1Sqlite.prepare(query);
          if (prepared.reader) {
            return { results: prepared.all(...params) };
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
      return d1Sqlite.transaction(() => stmts.map((s) => s._exec()))();
    },
  };
  return { db: drizzleD1(client as unknown as D1Database), sqlite: d1Sqlite };
}

let app: ReturnType<typeof createHonoApp>;
let cleanup: MediaCleanupCoordinator;
let memStore: Map<
  string,
  { bytes: Uint8Array; contentType?: string; uploaded: Date }
>;
let currentNow = new Date('2026-06-15T12:00:00.000Z');
const ids: Record<string, number> = {};
const cookies: Record<string, string> = {};
let existingOwnFileId = '';

async function insertRow(table: any, values: any): Promise<number> {
  const [inserted] = await db
    .insert(table)
    .values(values)
    .returning({ id: table.id });
  return inserted.id as number;
}

async function loginOnApp(
  targetApp: ReturnType<typeof createHonoApp>,
  targetDb: any,
  email: string,
  communityId?: number
): Promise<string> {
  const targetTables = tablesFor(targetDb);
  let communitySlug: string | undefined;
  if (communityId !== undefined) {
    const [row] = await targetDb
      .select({ slug: targetTables.communities.slug })
      .from(targetTables.communities)
      .where(eq(targetTables.communities.id, communityId))
      .limit(1);
    communitySlug = row?.slug;
  }
  const res = await targetApp.request(`${API_ORIGIN}/v2/auth/login`, {
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

async function createPreviewOnApp(
  targetApp: ReturnType<typeof createHonoApp>,
  cookie: string,
  opts: {
    kind: 'places' | 'speakers' | 'stories';
    csvFilename: string;
    csvText: string;
    mediaParts?: Array<{
      filename: string;
      contentType: string;
      bytes: Uint8Array;
    }>;
  }
) {
  const mp = buildImportMultipart({
    csvFilename: opts.csvFilename,
    csvText: opts.csvText,
    fields: { kind: opts.kind },
    mediaParts: opts.mediaParts,
  });
  const res = await targetApp.request(`${API_ORIGIN}/v2/imports/preview`, {
    method: 'POST',
    headers: {
      cookie,
      origin: CLIENT_ORIGIN,
      'content-type': mp.contentTypeHeader,
    },
    body: mp.body,
    duplex: 'half',
  } as RequestInit);
  expect(res.status).toBe(201);
  return ImportManifestDetailResponseSchema.parse(await res.json()).data;
}

describe('Slice 12-B GET /v2/imports, GET /v2/imports/:id, DELETE /v2/imports/:id', () => {
  beforeAll(async () => {
    migrate(db, { migrationsFolder: './src/db/migrations' });
    const seedTime = new Date('2026-06-01T12:00:00.000Z');
    const seed = await argon2Seed(TEST_DERIVED_KEY);

    ids.ownCommunity = await insertRow(tables.communities, {
      name: 'Manage Import Own',
      slug: 'manage-imp-own',
      publicStories: true,
      isActive: true,
      createdAt: seedTime,
      updatedAt: seedTime,
    });
    ids.foreignCommunity = await insertRow(tables.communities, {
      name: 'Manage Import Foreign',
      slug: 'manage-imp-foreign',
      publicStories: true,
      isActive: true,
      createdAt: seedTime,
      updatedAt: seedTime,
    });
    ids.disabledCommunity = await insertRow(tables.communities, {
      name: 'Manage Import Disabled',
      slug: 'manage-imp-disabled',
      publicStories: false,
      isActive: false,
      createdAt: seedTime,
      updatedAt: seedTime,
    });

    const addUser = async (
      email: string,
      role: string,
      communityId: number | null
    ) =>
      insertRow(tables.users, {
        email,
        username: email.split('@')[0],
        ...deriveUserIdentityColumns({
          email,
          username: email.split('@')[0],
        }),
        firstName: role,
        lastName: 'Manager',
        ...seed,
        role,
        communityId,
        isActive: true,
        createdAt: seedTime,
        updatedAt: seedTime,
      });

    await addUser('mgr-viewer@example.test', 'viewer', ids.ownCommunity);
    await addUser('mgr-member@example.test', 'member', ids.ownCommunity);
    ids.editorA = await addUser(
      'mgr-editor-a@example.test',
      'editor',
      ids.ownCommunity
    );
    ids.editorB = await addUser(
      'mgr-editor-b@example.test',
      'editor',
      ids.ownCommunity
    );
    ids.erasedEditor = await addUser(
      'mgr-editor-erased@example.test',
      'editor',
      ids.ownCommunity
    );
    await addUser('mgr-admin@example.test', 'admin', ids.ownCommunity);
    await addUser('mgr-foreign@example.test', 'editor', ids.foreignCommunity);
    await addUser('mgr-super@example.test', 'super_admin', null);
    await addUser('mgr-dis-admin@example.test', 'admin', ids.disabledCommunity);

    const mem = createListableMemoryStorage();
    memStore = mem.store;
    cleanup = new MediaCleanupCoordinator(db, mem.storage, {
      now: () => currentNow,
    });
    app = createHonoApp({
      repository: new HonoFoundationRepository(db),
      storage: mem.storage,
      mediaCleanup: cleanup,
      publicOrigin: API_ORIGIN,
      corsOrigins: [CLIENT_ORIGIN],
      secureCookies: false,
      serverSecret: makeServerSecret(),
      now: () => currentNow,
    });

    cookies.viewer = await loginOnApp(
      app,
      db,
      'mgr-viewer@example.test',
      ids.ownCommunity
    );
    cookies.member = await loginOnApp(
      app,
      db,
      'mgr-member@example.test',
      ids.ownCommunity
    );
    cookies.editorA = await loginOnApp(
      app,
      db,
      'mgr-editor-a@example.test',
      ids.ownCommunity
    );
    cookies.editorB = await loginOnApp(
      app,
      db,
      'mgr-editor-b@example.test',
      ids.ownCommunity
    );
    cookies.erasedEditor = await loginOnApp(
      app,
      db,
      'mgr-editor-erased@example.test',
      ids.ownCommunity
    );
    cookies.admin = await loginOnApp(
      app,
      db,
      'mgr-admin@example.test',
      ids.ownCommunity
    );
    cookies.foreign = await loginOnApp(
      app,
      db,
      'mgr-foreign@example.test',
      ids.foreignCommunity
    );
    cookies.superAdmin = await loginOnApp(app, db, 'mgr-super@example.test');
    cookies.disabledAdmin = await loginOnApp(
      app,
      db,
      'mgr-dis-admin@example.test',
      ids.disabledCommunity
    );

    const mp = buildImportMultipart({
      mediaParts: [
        {
          fieldName: 'file',
          filename: 'keep-active.png',
          contentType: 'image/png',
          bytes: PNG_BYTES,
        },
      ],
    });
    const up = await app.request(`${API_ORIGIN}/v2/media`, {
      method: 'POST',
      headers: {
        cookie: cookies.editorA,
        origin: CLIENT_ORIGIN,
        'content-type': mp.contentTypeHeader,
      },
      body: mp.body,
      duplex: 'half',
    } as RequestInit);
    expect(up.status).toBe(201);
    existingOwnFileId = MediaUploadResponseSchema.parse(await up.json()).data
      .id;
  });

  afterAll(() => {
    sqlite.close();
  });

  it('lists, filters, paginates, orders newest-first with id tie-break, and enforces tenant/role isolation on GET /v2/imports', async () => {
    currentNow = new Date('2026-06-15T12:00:00.000Z');
    const m1 = await createPreviewOnApp(app, cookies.editorA, {
      kind: 'places',
      csvFilename: 'places-first.csv',
      csvText: 'name,region\nSecret Place Alpha,North\n',
    });

    currentNow = new Date('2026-06-15T12:01:00.000Z');
    const m2 = await createPreviewOnApp(app, cookies.editorA, {
      kind: 'speakers',
      csvFilename: 'speakers-second.csv',
      csvText: 'name,affiliation\nSecret Speaker Beta,Coast\n',
    });

    // Exact same timestamp as m2 to assert `id DESC` tie-breaker.
    const m3 = await createPreviewOnApp(app, cookies.editorB, {
      kind: 'stories',
      csvFilename: 'stories-third.csv',
      csvText: 'title,visibility\nSecret Story Gamma,community\n',
    });

    // Mark m1 committed and m2 failed directly in DB so all filter statuses exist.
    await db
      .update(tables.importManifests)
      .set({
        status: 'committed',
        committedAt: currentNow.getTime(),
        resultSummary: {
          createdPlaces: 1,
          createdSpeakers: 0,
          createdStories: 0,
          createdStoryPlaces: 0,
          createdStorySpeakers: 0,
          createdAttachments: 0,
          createdExternalLinks: 0,
          skippedDuplicates: 0,
        },
      })
      .where(eq(tables.importManifests.id, m1.id));
    await db
      .update(tables.importManifests)
      .set({ status: 'failed' })
      .where(eq(tables.importManifests.id, m2.id));

    const foreignManifest = await createPreviewOnApp(app, cookies.foreign, {
      kind: 'places',
      csvFilename: 'foreign-places.csv',
      csvText: 'name\nForeign Secret Hill\n',
    });

    // Unauthenticated & disallowed roles
    const unauth = await app.request(`${API_ORIGIN}/v2/imports`);
    expect(unauth.status).toBe(401);

    for (const deniedCookie of [
      cookies.viewer,
      cookies.member,
      cookies.superAdmin,
      cookies.disabledAdmin,
    ]) {
      const denied = await app.request(`${API_ORIGIN}/v2/imports`, {
        headers: { cookie: deniedCookie },
      });
      expect(denied.status).toBe(403);
    }

    // Ordering & pagination for editor + admin
    for (const allowedCookie of [cookies.editorA, cookies.admin]) {
      const page1 = await app.request(
        `${API_ORIGIN}/v2/imports?limit=2&offset=0`,
        { headers: { cookie: allowedCookie } }
      );
      expect(page1.status).toBe(200);
      const parsed1 = ImportManifestListResponseSchema.parse(
        await page1.json()
      );
      expect(parsed1.meta).toEqual({
        total: 3,
        limit: 2,
        offset: 0,
        hasNextPage: true,
      });
      expect(parsed1.data.map((d) => d.id)).toEqual([m3.id, m2.id]);
      expect(parsed1.data.some((d) => d.id === foreignManifest.id)).toBe(false);

      const wireText = JSON.stringify(parsed1);
      expect(wireText).not.toContain('Secret Place Alpha');
      expect(wireText).not.toContain('Secret Speaker Beta');
      expect(wireText).not.toContain('Secret Story Gamma');
      expect(wireText).not.toContain('storageKey');
      expect(wireText).not.toContain('checksum');
      expect(wireText).not.toContain('sourceFileId');
      expect(wireText).not.toContain('normalizedRows');
      expect(wireText).not.toContain('rowErrors');
      expect(wireText).not.toContain('mappings');

      const page2 = await app.request(
        `${API_ORIGIN}/v2/imports?limit=2&offset=2`,
        { headers: { cookie: allowedCookie } }
      );
      expect(page2.status).toBe(200);
      const parsed2 = ImportManifestListResponseSchema.parse(
        await page2.json()
      );
      expect(parsed2.meta).toEqual({
        total: 3,
        limit: 2,
        offset: 2,
        hasNextPage: false,
      });
      expect(parsed2.data.map((d) => d.id)).toEqual([m1.id]);
    }

    // Status + kind filters
    const committedRes = await app.request(
      `${API_ORIGIN}/v2/imports?status=committed&kind=places`,
      { headers: { cookie: cookies.admin } }
    );
    expect(committedRes.status).toBe(200);
    const committedBody = ImportManifestListResponseSchema.parse(
      await committedRes.json()
    );
    expect(committedBody.data.map((d) => d.id)).toEqual([m1.id]);
    expect(committedBody.data[0]?.canCommit).toBe(false);
    expect(committedBody.data[0]?.committedAt).toBe(
      new Date('2026-06-15T12:01:00.000Z').toISOString()
    );

    const foreignList = await app.request(`${API_ORIGIN}/v2/imports`, {
      headers: { cookie: cookies.foreign },
    });
    expect(foreignList.status).toBe(200);
    const foreignParsed = ImportManifestListResponseSchema.parse(
      await foreignList.json()
    );
    expect(foreignParsed.data.map((d) => d.id)).toEqual([foreignManifest.id]);

    // Invalid query parameters rejected 400
    for (const qs of [
      '?limit=0',
      '?limit=101',
      '?offset=-1',
      '?status=committing',
      '?kind=users',
      '?extra=unexpected',
      '?status=previewed&status=committed',
    ]) {
      const badRes = await app.request(`${API_ORIGIN}/v2/imports${qs}`, {
        headers: { cookie: cookies.editorA },
      });
      expect(badRes.status).toBe(400);
    }
  });

  it('returns detail for own editor/admin and enforces 400/403/404 without content/storage leaks on GET /v2/imports/:id', async () => {
    const manifest = await createPreviewOnApp(app, cookies.editorA, {
      kind: 'places',
      csvFilename: 'detail-check.csv',
      csvText:
        `name,description,latitude,longitude,photo\n` +
        `Detail Secret Ridge,"<p>Desc</p>",10.5,-60.1,${existingOwnFileId}\n` +
        `Bad Row,"<p>Oops</p>",not-a-lat,10.0,missing.png\n`,
    });

    const unauth = await app.request(`${API_ORIGIN}/v2/imports/${manifest.id}`);
    expect(unauth.status).toBe(401);

    for (const deniedCookie of [
      cookies.viewer,
      cookies.member,
      cookies.superAdmin,
      cookies.disabledAdmin,
    ]) {
      const denied = await app.request(
        `${API_ORIGIN}/v2/imports/${manifest.id}`,
        { headers: { cookie: deniedCookie } }
      );
      expect(denied.status).toBe(403);
    }

    for (const badId of ['abc', '0', '-5', '2147483648']) {
      const bad = await app.request(`${API_ORIGIN}/v2/imports/${badId}`, {
        headers: { cookie: cookies.editorA },
      });
      expect(bad.status).toBe(400);
    }

    const notFoundOwn = await app.request(`${API_ORIGIN}/v2/imports/999999`, {
      headers: { cookie: cookies.editorA },
    });
    expect(notFoundOwn.status).toBe(404);
    expect(await notFoundOwn.json()).toEqual({ error: 'Not found' });

    const crossTenant = await app.request(
      `${API_ORIGIN}/v2/imports/${manifest.id}`,
      { headers: { cookie: cookies.foreign } }
    );
    expect(crossTenant.status).toBe(404);
    expect(await crossTenant.json()).toEqual({ error: 'Not found' });

    // Peer own-editor and own-admin can inspect manifest details.
    for (const okCookie of [cookies.editorB, cookies.admin]) {
      const ok = await app.request(`${API_ORIGIN}/v2/imports/${manifest.id}`, {
        headers: { cookie: okCookie },
      });
      expect(ok.status).toBe(200);
      const body = ImportManifestDetailResponseSchema.parse(await ok.json());
      expect(body.data.id).toBe(manifest.id);
      expect(body.data.rowCount).toBe(2);
      expect(body.data.validRowCount).toBe(1);
      expect(body.data.errorCount).toBe(2);
      expect(body.data.canCommit).toBe(false);
      expect(body.data.previewRows).toEqual([
        {
          kind: 'places',
          rowNumber: 1,
          name: 'Detail Secret Ridge',
          descriptionExcerpt: 'Desc',
          typeOfPlace: null,
          region: null,
          latitude: 10.5,
          longitude: -60.1,
          attachments: [
            { role: 'place_photo', ordinal: 0, source: 'existing' },
          ],
        },
      ]);
      const wire = JSON.stringify(body);
      expect(wire).not.toContain('Bad Row');
      expect(wire).not.toContain('storageKey');
      expect(wire).not.toContain('checksum');
      expect(wire).not.toContain('sourceFileId');
      expect(wire).not.toContain(existingOwnFileId);
    }
  });

  it('enforces creator/admin discard auth, lifecycle 409 conflicts, staged-byte deletion, CSV preservation, and audit on DELETE /v2/imports/:id', async () => {
    const manifestA = await createPreviewOnApp(app, cookies.editorA, {
      kind: 'places',
      csvFilename: 'discard-a.csv',
      csvText: `name,photo\nSecret Discard Creek,"staged-a.png|${existingOwnFileId}"\n`,
      mediaParts: [
        {
          filename: 'staged-a.png',
          contentType: 'image/png',
          bytes: PNG_BYTES,
        },
      ],
    });

    const [rowA] = await db
      .select()
      .from(tables.importManifests)
      .where(eq(tables.importManifests.id, manifestA.id));
    expect(rowA!.stagedFileIds).toHaveLength(1);
    const stagedIdA = rowA!.stagedFileIds[0]!;
    const sourceIdA = rowA!.sourceFileId;
    const [stagedFileRowA] = await db
      .select()
      .from(tables.files)
      .where(eq(tables.files.id, stagedIdA));
    const [sourceFileRowA] = await db
      .select()
      .from(tables.files)
      .where(eq(tables.files.id, sourceIdA));
    expect(memStore.has(stagedFileRowA!.storageKey!)).toBe(true);
    expect(memStore.has(sourceFileRowA!.storageKey!)).toBe(true);

    // Unauthenticated & CSRF failures
    const unauth = await app.request(
      `${API_ORIGIN}/v2/imports/${manifestA.id}`,
      { method: 'DELETE', headers: { origin: CLIENT_ORIGIN } }
    );
    expect(unauth.status).toBe(401);

    const badOrigin = await app.request(
      `${API_ORIGIN}/v2/imports/${manifestA.id}`,
      {
        method: 'DELETE',
        headers: { cookie: cookies.editorA, origin: FOREIGN_ORIGIN },
      }
    );
    expect(badOrigin.status).toBe(403);

    for (const deniedCookie of [
      cookies.viewer,
      cookies.member,
      cookies.superAdmin,
      cookies.disabledAdmin,
    ]) {
      const denied = await app.request(
        `${API_ORIGIN}/v2/imports/${manifestA.id}`,
        {
          method: 'DELETE',
          headers: { cookie: deniedCookie, origin: CLIENT_ORIGIN },
        }
      );
      expect(denied.status).toBe(403);
    }

    const badId = await app.request(`${API_ORIGIN}/v2/imports/not-an-id`, {
      method: 'DELETE',
      headers: { cookie: cookies.editorA, origin: CLIENT_ORIGIN },
    });
    expect(badId.status).toBe(400);

    // Foreign editor gets 404 (no cross-community existence oracle)
    const crossTenantDel = await app.request(
      `${API_ORIGIN}/v2/imports/${manifestA.id}`,
      {
        method: 'DELETE',
        headers: { cookie: cookies.foreign, origin: CLIENT_ORIGIN },
      }
    );
    expect(crossTenantDel.status).toBe(404);
    expect(await crossTenantDel.json()).toEqual({ error: 'Not found' });

    // Non-creator own-editor gets 403
    const peerDel = await app.request(
      `${API_ORIGIN}/v2/imports/${manifestA.id}`,
      {
        method: 'DELETE',
        headers: { cookie: cookies.editorB, origin: CLIENT_ORIGIN },
      }
    );
    expect(peerDel.status).toBe(403);

    // Creator own-editor succeeds 200 -> discarded, staged media purged, source CSV preserved
    const okCreatorDel = await app.request(
      `${API_ORIGIN}/v2/imports/${manifestA.id}`,
      {
        method: 'DELETE',
        headers: { cookie: cookies.editorA, origin: CLIENT_ORIGIN },
      }
    );
    expect(okCreatorDel.status).toBe(200);
    const discardedBody = ImportManifestDetailResponseSchema.parse(
      await okCreatorDel.json()
    );
    expect(discardedBody.data.status).toBe('discarded');
    expect(discardedBody.data.canCommit).toBe(false);

    // Staged media files row & bytes removed; source CSV bytes & normalized_rows cleared while inactive FK row, counts, and active file remain intact.
    const stagedAfter = await db
      .select()
      .from(tables.files)
      .where(eq(tables.files.id, stagedIdA));
    expect(stagedAfter).toHaveLength(0);
    expect(memStore.has(stagedFileRowA!.storageKey!)).toBe(false);

    const [sourceAfter] = await db
      .select()
      .from(tables.files)
      .where(eq(tables.files.id, sourceIdA));
    expect(sourceAfter?.isActive).toBe(false);
    expect(memStore.has(sourceFileRowA!.storageKey!)).toBe(false);

    const [manifestRowAfterDiscard] = await db
      .select()
      .from(tables.importManifests)
      .where(eq(tables.importManifests.id, manifestA.id));
    expect(manifestRowAfterDiscard?.status).toBe('discarded');
    expect(
      (manifestRowAfterDiscard?.normalizedRows as { rows?: unknown[] })?.rows
    ).toEqual([]);
    expect(discardedBody.data.rowCount).toBe(1);
    expect(discardedBody.data.validRowCount).toBe(1);
    expect(discardedBody.data.mediaSummary.existingReferencedCount).toBe(1);
    expect(discardedBody.data.mediaSummary.totalAttachmentRefs).toBe(2);
    expect(discardedBody.data.previewRows).toEqual([]);

    const [activeKeep] = await db
      .select()
      .from(tables.files)
      .where(eq(tables.files.id, existingOwnFileId));
    expect(activeKeep?.isActive).toBe(true);

    // Audit entry check
    const audits = await db
      .select()
      .from(tables.auditEntries)
      .where(
        and(
          eq(tables.auditEntries.communityId, ids.ownCommunity),
          eq(tables.auditEntries.action, 'import.discard')
        )
      );
    const matchingAudit = audits.find((a) =>
      JSON.stringify(a.resourceIds).includes(String(manifestA.id))
    );
    expect(matchingAudit).toBeDefined();
    expect(() =>
      validateContentFreeAuditEntry({
        communityId: matchingAudit!.communityId,
        actorId: matchingAudit!.actorId,
        action: matchingAudit!.action,
        resourceType: matchingAudit!.resourceType,
        resourceIds: matchingAudit!.resourceIds,
        outcome: matchingAudit!.outcome,
        ipAddress: matchingAudit!.ipAddress,
        userAgent: matchingAudit!.userAgent,
      })
    ).not.toThrow();

    // Discarding already-discarded -> 409; committed -> 409; failed -> 409
    const repeatDiscard = await app.request(
      `${API_ORIGIN}/v2/imports/${manifestA.id}`,
      {
        method: 'DELETE',
        headers: { cookie: cookies.admin, origin: CLIENT_ORIGIN },
      }
    );
    expect(repeatDiscard.status).toBe(409);

    const mCommitted = await createPreviewOnApp(app, cookies.editorA, {
      kind: 'places',
      csvFilename: 'committed-conflict.csv',
      csvText: 'name\nCommitted Conflict\n',
    });
    await db
      .update(tables.importManifests)
      .set({ status: 'committed', committedAt: Date.now() })
      .where(eq(tables.importManifests.id, mCommitted.id));
    const committedConflict = await app.request(
      `${API_ORIGIN}/v2/imports/${mCommitted.id}`,
      {
        method: 'DELETE',
        headers: { cookie: cookies.admin, origin: CLIENT_ORIGIN },
      }
    );
    expect(committedConflict.status).toBe(409);

    const mFailed = await createPreviewOnApp(app, cookies.editorA, {
      kind: 'places',
      csvFilename: 'failed-conflict.csv',
      csvText: 'name\nFailed Conflict\n',
    });
    await db
      .update(tables.importManifests)
      .set({ status: 'failed' })
      .where(eq(tables.importManifests.id, mFailed.id));
    const failedConflict = await app.request(
      `${API_ORIGIN}/v2/imports/${mFailed.id}`,
      {
        method: 'DELETE',
        headers: { cookie: cookies.admin, origin: CLIENT_ORIGIN },
      }
    );
    expect(failedConflict.status).toBe(409);

    // Own-admin CAN discard another editor's manifest
    const mPeerOwned = await createPreviewOnApp(app, cookies.editorB, {
      kind: 'places',
      csvFilename: 'admin-override.csv',
      csvText: 'name\nAdmin Can Discard\n',
    });
    const adminOverride = await app.request(
      `${API_ORIGIN}/v2/imports/${mPeerOwned.id}`,
      {
        method: 'DELETE',
        headers: { cookie: cookies.admin, origin: CLIENT_ORIGIN },
      }
    );
    expect(adminOverride.status).toBe(200);
    expect(
      ImportManifestDetailResponseSchema.parse(await adminOverride.json()).data
        .status
    ).toBe('discarded');

    // Erased creator (`createdBy = NULL`): peer own-editor -> 403, own-admin -> 200
    const mErased = await createPreviewOnApp(app, cookies.erasedEditor, {
      kind: 'places',
      csvFilename: 'erased-creator.csv',
      csvText: 'name\nErased Creator Place\n',
    });
    await db
      .update(tables.files)
      .set({ uploadedBy: null })
      .where(eq(tables.files.uploadedBy, ids.erasedEditor));
    await db
      .delete(tables.auditEntries)
      .where(eq(tables.auditEntries.actorId, ids.erasedEditor));
    await db
      .delete(tables.sessions)
      .where(eq(tables.sessions.userId, ids.erasedEditor));
    await db.delete(tables.users).where(eq(tables.users.id, ids.erasedEditor));

    const peerOnErased = await app.request(
      `${API_ORIGIN}/v2/imports/${mErased.id}`,
      {
        method: 'DELETE',
        headers: { cookie: cookies.editorA, origin: CLIENT_ORIGIN },
      }
    );
    expect(peerOnErased.status).toBe(403);

    const adminOnErased = await app.request(
      `${API_ORIGIN}/v2/imports/${mErased.id}`,
      {
        method: 'DELETE',
        headers: { cookie: cookies.admin, origin: CLIENT_ORIGIN },
      }
    );
    expect(adminOnErased.status).toBe(200);
    const adminOnErasedBody = ImportManifestDetailResponseSchema.parse(
      await adminOnErased.json()
    );
    expect(adminOnErasedBody.data.createdBy).toBeNull();
    expect(adminOnErasedBody.data.status).toBe('discarded');
  });

  it('recovers restart-safely via sweepOrphanObjects when storage.delete throws on discard while keeping previewed/committed source CSVs protected', async () => {
    const flakyMem = createListableMemoryStorage();
    let failDelete = true;
    const flakyLogs: string[] = [];
    const flakyStorage: FoundationStorage = {
      ...flakyMem.storage,
      async delete(storageKey) {
        if (failDelete) {
          throw new Error('transient R2 outage');
        }
        await flakyMem.storage.delete!(storageKey);
      },
    };
    const flakyCleanup = new MediaCleanupCoordinator(db, flakyStorage, {
      now: () => currentNow,
      log: (line) => flakyLogs.push(line),
    });
    const flakyApp = createHonoApp({
      repository: new HonoFoundationRepository(db),
      storage: flakyStorage,
      mediaCleanup: flakyCleanup,
      publicOrigin: API_ORIGIN,
      corsOrigins: [CLIENT_ORIGIN],
      secureCookies: false,
      serverSecret: makeServerSecret(),
      now: () => currentNow,
    });

    const manifest = await createPreviewOnApp(flakyApp, cookies.editorA, {
      kind: 'places',
      csvFilename: 'flaky-discard.csv',
      csvText: 'name,photo\nSecret Flaky Place,flaky.png\n',
      mediaParts: [
        {
          filename: 'flaky.png',
          contentType: 'image/png',
          bytes: PNG_BYTES,
        },
      ],
    });
    const stillPreviewedManifest = await createPreviewOnApp(
      flakyApp,
      cookies.editorA,
      {
        kind: 'places',
        csvFilename: 'keep-previewed.csv',
        csvText: 'name\nKeep Previewed Place\n',
      }
    );
    const committedManifest = await createPreviewOnApp(
      flakyApp,
      cookies.editorA,
      {
        kind: 'places',
        csvFilename: 'keep-committed.csv',
        csvText: 'name\nKeep Committed Place\n',
      }
    );
    await db
      .update(tables.importManifests)
      .set({ status: 'committed', committedAt: currentNow.getTime() })
      .where(eq(tables.importManifests.id, committedManifest.id));

    const [row] = await db
      .select()
      .from(tables.importManifests)
      .where(eq(tables.importManifests.id, manifest.id));
    const [previewedRow] = await db
      .select()
      .from(tables.importManifests)
      .where(eq(tables.importManifests.id, stillPreviewedManifest.id));
    const [committedRow] = await db
      .select()
      .from(tables.importManifests)
      .where(eq(tables.importManifests.id, committedManifest.id));
    const stagedId = row!.stagedFileIds[0]!;
    const [stagedFileRow] = await db
      .select()
      .from(tables.files)
      .where(eq(tables.files.id, stagedId));
    const [sourceFileRow] = await db
      .select()
      .from(tables.files)
      .where(eq(tables.files.id, row!.sourceFileId));
    const [previewedSourceRow] = await db
      .select()
      .from(tables.files)
      .where(eq(tables.files.id, previewedRow!.sourceFileId));
    const [committedSourceRow] = await db
      .select()
      .from(tables.files)
      .where(eq(tables.files.id, committedRow!.sourceFileId));

    const delRes = await flakyApp.request(
      `${API_ORIGIN}/v2/imports/${manifest.id}`,
      {
        method: 'DELETE',
        headers: { cookie: cookies.editorA, origin: CLIENT_ORIGIN },
      }
    );
    expect(delRes.status).toBe(200);
    expect(
      ImportManifestDetailResponseSchema.parse(await delRes.json()).data.status
    ).toBe('discarded');

    // Content-free log emitted; DB staged file row is gone; both staged & source CSV bytes remain until outage clears.
    expect(flakyLogs.length).toBeGreaterThanOrEqual(1);
    expect(flakyLogs.join('\n')).not.toContain(stagedFileRow!.storageKey!);
    expect(flakyLogs.join('\n')).not.toContain('flaky.png');
    expect(
      await db.select().from(tables.files).where(eq(tables.files.id, stagedId))
    ).toHaveLength(0);
    expect(flakyMem.store.has(stagedFileRow!.storageKey!)).toBe(true);
    expect(flakyMem.store.has(sourceFileRow!.storageKey!)).toBe(true);

    // Recover after storage outage resolves: orphan sweep removes both staged media AND discarded source CSV bytes,
    // while keeping source CSV bytes for active previewed and committed manifests protected.
    failDelete = false;
    const sweepRes = await flakyCleanup.sweepOrphanObjects({
      olderThan: new Date('2030-01-01T00:00:00.000Z'),
    });
    expect(sweepRes.deletedCount).toBeGreaterThanOrEqual(2);
    expect(flakyMem.store.has(stagedFileRow!.storageKey!)).toBe(false);
    expect(flakyMem.store.has(sourceFileRow!.storageKey!)).toBe(false);
    expect(flakyMem.store.has(previewedSourceRow!.storageKey!)).toBe(true);
    expect(flakyMem.store.has(committedSourceRow!.storageKey!)).toBe(true);
  });

  it('allows only one winner [200, 409] on concurrent DELETE /v2/imports/:id across both SQLite and D1 batch', async () => {
    // 1. Concurrent race on Node SQLite
    const sqliteManifest = await createPreviewOnApp(app, cookies.editorA, {
      kind: 'places',
      csvFilename: 'race-sqlite.csv',
      csvText: 'name,photo\nRace SQLite,race-sqlite.png\n',
      mediaParts: [
        {
          filename: 'race-sqlite.png',
          contentType: 'image/png',
          bytes: PNG_BYTES,
        },
      ],
    });
    const [sqliteRow] = await db
      .select()
      .from(tables.importManifests)
      .where(eq(tables.importManifests.id, sqliteManifest.id));

    const sqliteResponses = await Promise.all([
      app.request(`${API_ORIGIN}/v2/imports/${sqliteManifest.id}`, {
        method: 'DELETE',
        headers: { cookie: cookies.editorA, origin: CLIENT_ORIGIN },
      }),
      app.request(`${API_ORIGIN}/v2/imports/${sqliteManifest.id}`, {
        method: 'DELETE',
        headers: { cookie: cookies.admin, origin: CLIENT_ORIGIN },
      }),
    ]);
    expect(sqliteResponses.map((r) => r.status).sort((a, b) => a - b)).toEqual([
      200, 409,
    ]);
    const sqliteAudits = await db
      .select()
      .from(tables.auditEntries)
      .where(
        and(
          eq(tables.auditEntries.communityId, ids.ownCommunity),
          eq(tables.auditEntries.action, 'import.discard')
        )
      );
    const matchingSqliteAudits = sqliteAudits.filter((a) =>
      JSON.stringify(a.resourceIds).includes(String(sqliteManifest.id))
    );
    expect(matchingSqliteAudits).toHaveLength(1);
    expect(
      await db
        .select()
        .from(tables.files)
        .where(inArray(tables.files.id, sqliteRow!.stagedFileIds))
    ).toHaveLength(0);

    // 2. Concurrent race on Workers D1 batch
    const { db: d1Db, sqlite: d1Sqlite } = createRealD1Db();
    try {
      const d1Tables = tablesFor(d1Db);
      const d1Now = new Date('2026-06-15T12:00:00.000Z');
      const d1Seed = await argon2Seed(TEST_DERIVED_KEY);
      const [d1Comm] = await d1Db
        .insert(d1Tables.communities)
        .values({
          name: 'D1 Race Community',
          slug: 'd1-race-comm',
          publicStories: false,
          isActive: true,
          createdAt: d1Now,
          updatedAt: d1Now,
        })
        .returning({ id: d1Tables.communities.id });

      for (const [email, role] of [
        ['d1-editor@example.test', 'editor'],
        ['d1-admin@example.test', 'admin'],
      ] as const) {
        await d1Db.insert(d1Tables.users).values({
          email,
          username: email.split('@')[0]!,
          ...deriveUserIdentityColumns({
            email,
            username: email.split('@')[0]!,
          }),
          firstName: role,
          lastName: 'D1',
          ...d1Seed,
          role,
          communityId: d1Comm.id,
          isActive: true,
          createdAt: d1Now,
          updatedAt: d1Now,
        });
      }

      const d1Mem = createListableMemoryStorage();
      const d1Cleanup = new MediaCleanupCoordinator(d1Db, d1Mem.storage, {
        now: () => d1Now,
      });
      const d1App = createHonoApp({
        repository: new HonoFoundationRepository(d1Db),
        storage: d1Mem.storage,
        mediaCleanup: d1Cleanup,
        publicOrigin: API_ORIGIN,
        corsOrigins: [CLIENT_ORIGIN],
        secureCookies: false,
        serverSecret: makeServerSecret(),
        now: () => d1Now,
      });

      const d1EditorCookie = await loginOnApp(
        d1App,
        d1Db,
        'd1-editor@example.test',
        d1Comm.id
      );
      const d1AdminCookie = await loginOnApp(
        d1App,
        d1Db,
        'd1-admin@example.test',
        d1Comm.id
      );

      const d1Manifest = await createPreviewOnApp(d1App, d1EditorCookie, {
        kind: 'places',
        csvFilename: 'race-d1.csv',
        csvText: 'name,photo\nRace D1 Place,race-d1.png\n',
        mediaParts: [
          {
            filename: 'race-d1.png',
            contentType: 'image/png',
            bytes: PNG_BYTES,
          },
        ],
      });
      const [d1Row] = await d1Db
        .select()
        .from(d1Tables.importManifests)
        .where(eq(d1Tables.importManifests.id, d1Manifest.id));
      const d1StagedId = d1Row!.stagedFileIds[0]!;
      const [d1StagedFileRow] = await d1Db
        .select()
        .from(d1Tables.files)
        .where(eq(d1Tables.files.id, d1StagedId));
      const [d1SourceFileRow] = await d1Db
        .select()
        .from(d1Tables.files)
        .where(eq(d1Tables.files.id, d1Row!.sourceFileId));

      const d1Responses = await Promise.all([
        d1App.request(`${API_ORIGIN}/v2/imports/${d1Manifest.id}`, {
          method: 'DELETE',
          headers: { cookie: d1EditorCookie, origin: CLIENT_ORIGIN },
        }),
        d1App.request(`${API_ORIGIN}/v2/imports/${d1Manifest.id}`, {
          method: 'DELETE',
          headers: { cookie: d1AdminCookie, origin: CLIENT_ORIGIN },
        }),
      ]);
      expect(d1Responses.map((r) => r.status).sort((a, b) => a - b)).toEqual([
        200, 409,
      ]);

      const [d1After] = await d1Db
        .select()
        .from(d1Tables.importManifests)
        .where(eq(d1Tables.importManifests.id, d1Manifest.id));
      expect(d1After?.status).toBe('discarded');

      expect(
        await d1Db
          .select()
          .from(d1Tables.files)
          .where(eq(d1Tables.files.id, d1StagedId))
      ).toHaveLength(0);
      expect(d1Mem.store.has(d1StagedFileRow!.storageKey!)).toBe(false);
      expect(d1Mem.store.has(d1SourceFileRow!.storageKey!)).toBe(false);
      expect((d1After?.normalizedRows as { rows?: unknown[] })?.rows).toEqual(
        []
      );

      const d1Audits = await d1Db
        .select()
        .from(d1Tables.auditEntries)
        .where(
          and(
            eq(d1Tables.auditEntries.communityId, d1Comm.id),
            eq(d1Tables.auditEntries.action, 'import.discard')
          )
        );
      expect(d1Audits).toHaveLength(1);
      expect(() =>
        validateContentFreeAuditEntry({
          communityId: d1Audits[0]!.communityId,
          actorId: d1Audits[0]!.actorId,
          action: d1Audits[0]!.action,
          resourceType: d1Audits[0]!.resourceType,
          resourceIds: d1Audits[0]!.resourceIds,
          outcome: d1Audits[0]!.outcome,
          ipAddress: d1Audits[0]!.ipAddress,
          userAgent: d1Audits[0]!.userAgent,
        })
      ).not.toThrow();
    } finally {
      d1Sqlite.close();
    }
  });

  it('keeps POST /v2/community/export succeeding after a preview is discarded or expires, but still fails closed for missing bytes of live files', async () => {
    // Dedicated community: earlier tests leave previewed/committed manifests
    // whose bytes were deliberately removed, which would mask this assertion.
    const seedTime = new Date('2026-06-01T12:00:00.000Z');
    const seed = await argon2Seed(TEST_DERIVED_KEY);
    const exportCommunityId = await insertRow(tables.communities, {
      name: 'Manage Import Export',
      slug: 'manage-imp-export',
      publicStories: true,
      isActive: true,
      createdAt: seedTime,
      updatedAt: seedTime,
    });
    const addExportUser = async (email: string, role: string) =>
      insertRow(tables.users, {
        email,
        username: email.split('@')[0],
        ...deriveUserIdentityColumns({
          email,
          username: email.split('@')[0],
        }),
        firstName: role,
        lastName: 'Manager',
        ...seed,
        role,
        communityId: exportCommunityId,
        isActive: true,
        createdAt: seedTime,
        updatedAt: seedTime,
      });
    await addExportUser('mgr-exp-editor@example.test', 'editor');
    await addExportUser('mgr-exp-admin@example.test', 'admin');
    const editorCookie = await loginOnApp(
      app,
      db,
      'mgr-exp-editor@example.test',
      exportCommunityId
    );
    const adminCookie = await loginOnApp(
      app,
      db,
      'mgr-exp-admin@example.test',
      exportCommunityId
    );
    const upMp = buildImportMultipart({
      mediaParts: [
        {
          fieldName: 'file',
          filename: 'export-live.png',
          contentType: 'image/png',
          bytes: PNG_BYTES,
        },
      ],
    });
    const upRes = await app.request(`${API_ORIGIN}/v2/media`, {
      method: 'POST',
      headers: {
        cookie: editorCookie,
        origin: CLIENT_ORIGIN,
        'content-type': upMp.contentTypeHeader,
      },
      body: upMp.body,
      duplex: 'half',
    } as RequestInit);
    expect(upRes.status).toBe(201);
    const liveFileId = MediaUploadResponseSchema.parse(await upRes.json()).data
      .id;
    const exportOnce = () =>
      app.request(`${API_ORIGIN}/v2/community/export`, {
        method: 'POST',
        headers: { cookie: adminCookie, origin: CLIENT_ORIGIN },
      });
    // Advance the clock so per-community export quotas of earlier calls reset.
    const bump = () => {
      currentNow = new Date(currentNow.getTime() + 2 * 60 * 60 * 1000);
    };

    const discarded = await createPreviewOnApp(app, editorCookie, {
      kind: 'places',
      csvFilename: 'export-after-discard.csv',
      csvText: 'name\nExport Discard Place\n',
    });
    const expiring = await createPreviewOnApp(app, editorCookie, {
      kind: 'places',
      csvFilename: 'export-after-expiry.csv',
      csvText: 'name\nExport Expiry Place\n',
    });
    const sourceIds = new Map<number, string>();
    for (const m of [discarded, expiring]) {
      const [row] = await db
        .select()
        .from(tables.importManifests)
        .where(eq(tables.importManifests.id, m.id));
      sourceIds.set(m.id, row!.sourceFileId);
    }

    const del = await app.request(`${API_ORIGIN}/v2/imports/${discarded.id}`, {
      method: 'DELETE',
      headers: { cookie: editorCookie, origin: CLIENT_ORIGIN },
    });
    expect(del.status).toBe(200);

    bump();
    const afterDiscard = await exportOnce();
    expect(afterDiscard.status).toBe(201);

    // Expiry sweep variant: same inactive tombstone, same export outcome.
    const swept = await cleanup.sweepExpiredImportPreviews({
      olderThan: new Date(currentNow.getTime() + 60_000),
    });
    expect(swept.expiredCount).toBeGreaterThanOrEqual(1);
    const [expiredRow] = await db
      .select()
      .from(tables.importManifests)
      .where(eq(tables.importManifests.id, expiring.id));
    expect(expiredRow?.status).toBe('discarded');
    const [expiredSource] = await db
      .select()
      .from(tables.files)
      .where(eq(tables.files.id, sourceIds.get(expiring.id)!));
    expect(expiredSource?.isActive).toBe(false);
    expect(memStore.has(expiredSource!.storageKey!)).toBe(false);

    bump();
    const afterExpiry = await exportOnce();
    expect(afterExpiry.status).toBe(201);

    // Fail-closed stays for a genuinely missing live (referenced) file.
    const [live] = await db
      .select()
      .from(tables.files)
      .where(eq(tables.files.id, liveFileId));
    const liveEntry = memStore.get(live!.storageKey!)!;
    memStore.delete(live!.storageKey!);
    try {
      bump();
      const broken = await exportOnce();
      expect(broken.status).toBe(503);
    } finally {
      memStore.set(live!.storageKey!, liveEntry);
    }
  });
});
