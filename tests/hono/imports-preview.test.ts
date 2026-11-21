/**
 * Focused contract, staging-isolation, D1 budget/batch, security, and
 * negative tests for Slice 12 `POST /v2/imports/preview` (#123, #197).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { and, eq } from 'drizzle-orm';
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
  MAX_IMPORT_CSV_BYTES,
} from '../../src/shared/schemas/imports.js';
import { MediaUploadResponseSchema } from '../../src/shared/schemas/media-v2.js';
import {
  MAX_CSV_CELL_LENGTH,
  MAX_CSV_ROWS,
} from '../../src/shared/utils/csv-parser.js';
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

const WAV_BYTES = (() => {
  const buf = new Uint8Array(44);
  buf.set(new TextEncoder().encode('RIFF'), 0);
  new DataView(buf.buffer).setUint32(4, 36, true);
  buf.set(new TextEncoder().encode('WAVEfmt '), 8);
  new DataView(buf.buffer).setUint32(16, 16, true);
  new DataView(buf.buffer).setUint16(20, 1, true);
  new DataView(buf.buffer).setUint16(22, 1, true);
  new DataView(buf.buffer).setUint32(24, 8000, true);
  new DataView(buf.buffer).setUint32(28, 8000, true);
  new DataView(buf.buffer).setUint16(32, 1, true);
  new DataView(buf.buffer).setUint16(34, 8, true);
  buf.set(new TextEncoder().encode('data'), 36);
  return buf;
})();

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
  csvContentType?: string;
  csvBytes?: Uint8Array;
  includeCsv?: boolean;
  fields?: Record<string, string>;
  mediaParts?: Array<{
    fieldName?: string;
    filename: string;
    contentType: string;
    bytes: Uint8Array;
  }>;
}): { body: ReadableStream<Uint8Array>; contentTypeHeader: string } {
  const boundary = `imp-bound-${Math.random().toString(16).slice(2)}`;
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];

  for (const [key, value] of Object.entries(options.fields ?? {})) {
    chunks.push(
      enc.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`
      )
    );
  }

  if (options.includeCsv !== false) {
    const filename = options.csvFilename ?? 'import.csv';
    const contentType = options.csvContentType ?? 'text/csv';
    const bytes = options.csvBytes ?? new Uint8Array(0);
    chunks.push(
      enc.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`
      )
    );
    chunks.push(bytes);
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

function createRealD1Db(boundParamsOut?: number[]): {
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
          boundParamsOut?.push(params.length);
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
const ids: Record<string, number> = {};
const cookies: Record<string, string> = {};
let existingOwnPlaceId = 0;
let existingForeignPlaceId = 0;
let existingOwnSpeakerId = 0;
let existingForeignSpeakerId = 0;
let existingOwnStoryId = 0;
let existingOwnFileId = '';
let existingForeignFileId = '';

async function insertRow(table: any, values: any): Promise<number> {
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

async function postPreview(
  targetApp: ReturnType<typeof createHonoApp>,
  opts: {
    cookie?: string;
    origin?: string;
    csvFilename?: string;
    csvContentType?: string;
    csvText?: string;
    csvBytes?: Uint8Array;
    includeCsv?: boolean;
    fields?: Record<string, string>;
    mediaParts?: Array<{
      fieldName?: string;
      filename: string;
      contentType: string;
      bytes: Uint8Array;
    }>;
  }
) {
  const csvBytes =
    opts.csvBytes ??
    (opts.csvText !== undefined
      ? new TextEncoder().encode(opts.csvText)
      : undefined);
  const mp = buildImportMultipart({
    csvFilename: opts.csvFilename,
    csvContentType: opts.csvContentType,
    csvBytes,
    includeCsv: opts.includeCsv,
    fields: opts.fields,
    mediaParts: opts.mediaParts,
  });
  const headers: Record<string, string> = {
    'content-type': mp.contentTypeHeader,
    origin: opts.origin ?? CLIENT_ORIGIN,
  };
  if (opts.cookie) headers.cookie = opts.cookie;
  return targetApp.request(`${API_ORIGIN}/v2/imports/preview`, {
    method: 'POST',
    headers,
    body: mp.body,
    duplex: 'half',
  } as RequestInit);
}

describe('Slice 12 POST /v2/imports/preview (#123, #197)', () => {
  beforeAll(async () => {
    migrate(db, { migrationsFolder: './src/db/migrations' });
    const now = new Date('2026-06-01T12:00:00.000Z');
    const seed = await argon2Seed(TEST_DERIVED_KEY);

    ids.ownCommunity = await insertRow(tables.communities, {
      name: 'Import Own Community',
      slug: 'import-own-comm',
      publicStories: true,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });
    ids.foreignCommunity = await insertRow(tables.communities, {
      name: 'Import Foreign Community',
      slug: 'import-foreign-comm',
      publicStories: true,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });
    ids.disabledCommunity = await insertRow(tables.communities, {
      name: 'Import Disabled Community',
      slug: 'import-disabled-comm',
      publicStories: false,
      isActive: false,
      createdAt: now,
      updatedAt: now,
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
        lastName: 'Tester',
        ...seed,
        role,
        communityId,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      });

    await addUser('imp-viewer@example.test', 'viewer', ids.ownCommunity);
    await addUser('imp-member@example.test', 'member', ids.ownCommunity);
    await addUser('imp-editor@example.test', 'editor', ids.ownCommunity);
    await addUser('imp-admin@example.test', 'admin', ids.ownCommunity);
    await addUser('imp-foreign@example.test', 'editor', ids.foreignCommunity);
    await addUser('imp-super@example.test', 'super_admin', null);
    await addUser('imp-dis-admin@example.test', 'admin', ids.disabledCommunity);

    existingOwnPlaceId = await insertRow(tables.places, {
      name: 'Existing Creek',
      communityId: ids.ownCommunity,
      latitude: 1.5,
      longitude: 2.5,
      isRestricted: false,
      createdAt: now,
      updatedAt: now,
    });
    existingForeignPlaceId = await insertRow(tables.places, {
      name: 'Foreign Peak',
      communityId: ids.foreignCommunity,
      latitude: 3.5,
      longitude: 4.5,
      isRestricted: false,
      createdAt: now,
      updatedAt: now,
    });
    existingOwnSpeakerId = await insertRow(tables.speakers, {
      name: 'Existing Elder',
      communityId: ids.ownCommunity,
      createdAt: now,
      updatedAt: now,
    });
    existingForeignSpeakerId = await insertRow(tables.speakers, {
      name: 'Foreign Speaker',
      communityId: ids.foreignCommunity,
      createdAt: now,
      updatedAt: now,
    });
    existingOwnStoryId = await insertRow(tables.stories, {
      title: 'Existing Song',
      slug: 'existing-song',
      communityId: ids.ownCommunity,
      privacyLevel: 'public',
      isRestricted: false,
      createdAt: now,
      updatedAt: now,
    });
    expect(existingOwnStoryId).toBeGreaterThan(0);

    const mem = createListableMemoryStorage();
    memStore = mem.store;
    cleanup = new MediaCleanupCoordinator(db, mem.storage);
    app = createHonoApp({
      repository: new HonoFoundationRepository(db),
      storage: mem.storage,
      mediaCleanup: cleanup,
      publicOrigin: API_ORIGIN,
      corsOrigins: [CLIENT_ORIGIN],
      secureCookies: false,
      serverSecret: makeServerSecret(),
      now: () => new Date('2026-06-15T12:00:00.000Z'),
    });

    cookies.viewer = await loginAs('imp-viewer@example.test', ids.ownCommunity);
    cookies.member = await loginAs('imp-member@example.test', ids.ownCommunity);
    cookies.editor = await loginAs('imp-editor@example.test', ids.ownCommunity);
    cookies.admin = await loginAs('imp-admin@example.test', ids.ownCommunity);
    cookies.foreign = await loginAs(
      'imp-foreign@example.test',
      ids.foreignCommunity
    );
    cookies.superAdmin = await loginAs('imp-super@example.test');
    cookies.disabledAdmin = await loginAs(
      'imp-dis-admin@example.test',
      ids.disabledCommunity
    );

    // Upload one authorized existing own-community media file and one foreign file.
    const upOwnMultipart = buildImportMultipart({
      csvFilename: 'not-used.csv',
      includeCsv: false,
      mediaParts: [
        {
          fieldName: 'file',
          filename: 'existing-own.png',
          contentType: 'image/png',
          bytes: PNG_BYTES,
        },
      ],
    });
    const upOwn = await app.request(`${API_ORIGIN}/v2/media`, {
      method: 'POST',
      headers: {
        cookie: cookies.editor,
        origin: CLIENT_ORIGIN,
        'content-type': upOwnMultipart.contentTypeHeader,
      },
      body: upOwnMultipart.body,
      duplex: 'half',
    } as RequestInit);
    expect(upOwn.status).toBe(201);
    existingOwnFileId = MediaUploadResponseSchema.parse(await upOwn.json()).data
      .id;

    // Seed foreign file row via direct DB insert + memory store for cross-community test.
    existingForeignFileId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01';
    const foreignKey = `communities/${ids.foreignCommunity}/media/${existingForeignFileId}`;
    memStore.set(foreignKey, {
      bytes: PNG_BYTES,
      contentType: 'image/png',
      uploaded: now,
    });
    await db.insert(tables.files).values({
      id: existingForeignFileId,
      filename: existingForeignFileId,
      originalName: 'foreign.png',
      path: foreignKey,
      storageKey: foreignKey,
      url: `/v2/media/${existingForeignFileId}`,
      mimeType: 'image/png',
      size: PNG_BYTES.byteLength,
      byteSize: PNG_BYTES.byteLength,
      checksum: createHash('sha256').update(PNG_BYTES).digest('hex'),
      communityId: ids.foreignCommunity,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });
  });

  afterAll(() => {
    sqlite.close();
  });

  it('enforces authentication, roles, disabled community, CSRF origin, and media Content-Type/size gates', async () => {
    const unauth = await postPreview(app, {
      csvText: 'name\nAlpha\n',
      fields: { kind: 'places' },
    });
    expect(unauth.status).toBe(401);

    for (const c of [
      cookies.viewer,
      cookies.member,
      cookies.superAdmin,
      cookies.disabledAdmin,
    ]) {
      const res = await postPreview(app, {
        cookie: c,
        csvText: 'name\nAlpha\n',
        fields: { kind: 'places' },
      });
      expect(res.status).toBe(403);
    }

    const csrfRes = await postPreview(app, {
      cookie: cookies.editor,
      origin: FOREIGN_ORIGIN,
      csvText: 'name\nAlpha\n',
      fields: { kind: 'places' },
    });
    expect(csrfRes.status).toBe(403);

    const nonMultipart = await app.request(`${API_ORIGIN}/v2/imports/preview`, {
      method: 'POST',
      headers: {
        cookie: cookies.editor,
        origin: CLIENT_ORIGIN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ kind: 'places' }),
    });
    expect(nonMultipart.status).toBe(415);

    const tooLargeHeader = await app.request(
      `${API_ORIGIN}/v2/imports/preview`,
      {
        method: 'POST',
        headers: {
          cookie: cookies.editor,
          origin: CLIENT_ORIGIN,
          'content-type': 'multipart/form-data; boundary=abc',
          'content-length': String(200 * 1024 * 1024),
        },
        body: '',
      }
    );
    expect(tooLargeHeader.status).toBe(413);

    const oversizeCsv = await postPreview(app, {
      cookie: cookies.editor,
      csvBytes: new Uint8Array(MAX_IMPORT_CSV_BYTES + 1),
      fields: { kind: 'places' },
    });
    expect(oversizeCsv.status).toBe(413);
  });

  it('previews places CSV with UTF-8 BOM, negative coordinates, HTML sanitisation, staged media + SHA-256, and strict pre-commit staging isolation', async () => {
    const csvText =
      '\uFEFFname,description,type_of_place,region,latitude,longitude,photo,name_audio\r\n' +
      `"Cedar Point","<p>Lookout <a href=""https://example.org"">link</a></p>",ridge,North,-3.119,-60.021,"cedar.png|${existingOwnFileId}",cedar.wav\r\n`;

    const res = await postPreview(app, {
      cookie: cookies.editor,
      csvFilename: '../nested/places.csv',
      csvText,
      fields: { kind: 'places' },
      mediaParts: [
        {
          filename: 'cedar.png',
          contentType: 'image/png',
          bytes: PNG_BYTES,
        },
        {
          filename: 'cedar.wav',
          contentType: 'audio/wav',
          bytes: WAV_BYTES,
        },
      ],
    });
    expect(res.status).toBe(201);
    const parsed = ImportManifestDetailResponseSchema.parse(await res.json());
    const data = parsed.data;
    expect(data.kind).toBe('places');
    expect(data.status).toBe('previewed');
    expect(data.sourceFileName).toBe('places.csv');
    expect(data.rowCount).toBe(1);
    expect(data.validRowCount).toBe(1);
    expect(data.errorCount).toBe(0);
    expect(data.stagedMediaCount).toBe(2);
    expect(data.mediaSummary).toEqual({
      stagedCount: 2,
      existingReferencedCount: 1,
      totalAttachmentRefs: 3,
    });
    expect(data.canCommit).toBe(true);
    expect(data.commitPlan.withinD1Budget).toBe(true);

    // No internal storage keys, checksums, or raw CSV content leaked.
    const serializedText = JSON.stringify(data);
    expect(serializedText).not.toContain('storageKey');
    expect(serializedText).not.toContain('checksum');
    expect(serializedText).not.toContain('Cedar Point');

    const [manifestRow] = await db
      .select()
      .from(tables.importManifests)
      .where(eq(tables.importManifests.id, data.id));
    expect(manifestRow).toBeDefined();
    expect(manifestRow!.stagedFileIds).toHaveLength(2);

    // Verify SHA-256 checksums & is_active = false on source CSV and staged media.
    const [sourceFileRow] = await db
      .select()
      .from(tables.files)
      .where(eq(tables.files.id, manifestRow!.sourceFileId));
    expect(sourceFileRow?.isActive).toBe(false);
    expect(sourceFileRow?.checksum).toBe(
      createHash('sha256')
        .update(new TextEncoder().encode(csvText))
        .digest('hex')
    );

    const expectedPngHash = createHash('sha256')
      .update(PNG_BYTES)
      .digest('hex');
    for (const stagedId of manifestRow!.stagedFileIds) {
      const [f] = await db
        .select()
        .from(tables.files)
        .where(eq(tables.files.id, stagedId));
      expect(f?.isActive).toBe(false);
      expect(f?.checksum).toBeTruthy();
      if (f?.mimeType === 'image/png') {
        expect(f.checksum).toBe(expectedPngHash);
      }

      // Staged files MUST stay unreachable on every media/attachment surface pre-commit.
      const mediaGet = await app.request(`${API_ORIGIN}/v2/media/${stagedId}`, {
        headers: { cookie: cookies.admin },
      });
      expect(mediaGet.status).toBe(404);

      const metaGet = await app.request(
        `${API_ORIGIN}/v2/media/${stagedId}/metadata`,
        { headers: { cookie: cookies.admin } }
      );
      expect(metaGet.status).toBe(404);

      const delMedia = await app.request(`${API_ORIGIN}/v2/media/${stagedId}`, {
        method: 'DELETE',
        headers: { cookie: cookies.admin, origin: CLIENT_ORIGIN },
      });
      expect(delMedia.status).toBe(404);
    }

    // Source CSV must also be unreachable via /v2/media/:id and cannot be deleted.
    const srcGet = await app.request(
      `${API_ORIGIN}/v2/media/${manifestRow!.sourceFileId}`,
      { headers: { cookie: cookies.admin } }
    );
    expect(srcGet.status).toBe(404);

    // Orphan & unreferenced sweeps must NOT remove staged files or source CSV!
    const manifestFileIds = [
      manifestRow!.sourceFileId,
      ...manifestRow!.stagedFileIds,
    ];
    const sweepDbRes = await cleanup.sweepUnreferencedFiles({
      fileIds: manifestFileIds,
      olderThan: new Date('2030-01-01T00:00:00.000Z'),
    });
    expect(sweepDbRes.deletedCount).toBe(0);
    const sweepObjRes = await cleanup.sweepOrphanObjects({
      olderThan: new Date('2030-01-01T00:00:00.000Z'),
    });
    expect(sweepObjRes.deletedCount).toBe(0);
    expect(memStore.has(sourceFileRow!.storageKey!)).toBe(true);
    for (const stagedId of manifestRow!.stagedFileIds) {
      const [rowAfterSweep] = await db
        .select({ storageKey: tables.files.storageKey })
        .from(tables.files)
        .where(eq(tables.files.id, stagedId));
      expect(rowAfterSweep?.storageKey).toBeTruthy();
      expect(memStore.has(rowAfterSweep!.storageKey!)).toBe(true);
    }

    // Content-free import.preview audit entry was written atomically.
    const audits = await db
      .select()
      .from(tables.auditEntries)
      .where(
        and(
          eq(tables.auditEntries.communityId, ids.ownCommunity),
          eq(tables.auditEntries.action, 'import.preview')
        )
      );
    expect(
      audits.some((a) =>
        JSON.stringify(a.resourceIds).includes(String(data.id))
      )
    ).toBe(true);
    const matchingAudit = audits.find((a) =>
      JSON.stringify(a.resourceIds).includes(String(data.id))
    )!;
    expect(matchingAudit.resourceType).toBe('import_manifest');
    expect(matchingAudit.ipAddress).toBeNull();
    expect(matchingAudit.userAgent).toBeNull();
    expect(() =>
      validateContentFreeAuditEntry({
        communityId: matchingAudit.communityId,
        actorId: matchingAudit.actorId,
        action: matchingAudit.action,
        resourceType: matchingAudit.resourceType,
        resourceIds: matchingAudit.resourceIds,
        outcome: matchingAudit.outcome,
        ipAddress: matchingAudit.ipAddress,
        userAgent: matchingAudit.userAgent,
      })
    ).not.toThrow();
  });

  it('previews stories with explicit header/audience mappings, related records, and records unknown audience without coercing to public', async () => {
    const csvText =
      'Story Name,Audience,Summary,Location Name,Narrator Name,Places,Speakers,Links,Attachment\n' +
      `"River Tale","anon","<p>Oral history</p>","New Landing","New Narrator","${existingOwnPlaceId}","${existingOwnSpeakerId}","https://example.org/watch","tale.png"\n` +
      '"Restricted Tale","elders_only","<p>Unknown</p>","","","","","",""\n' +
      '"Blank Audience Tale","","<p>Blank</p>","","","","","",""\n';

    const res = await postPreview(app, {
      cookie: cookies.editor,
      csvText,
      fields: {
        kind: 'stories',
        mappings: JSON.stringify({
          title: 'Story Name',
          visibility: 'Audience',
          description: 'Summary',
          interviewLocationName: 'Location Name',
          interviewerName: 'Narrator Name',
          placeIds: 'Places',
          speakerIds: 'Speakers',
          externalMediaLinks: 'Links',
          media: 'Attachment',
        }),
        audienceMapping: JSON.stringify({ anon: 'public' }),
      },
      mediaParts: [
        { filename: 'tale.png', contentType: 'image/png', bytes: PNG_BYTES },
      ],
    });
    expect(res.status).toBe(201);
    const parsed = ImportManifestDetailResponseSchema.parse(await res.json());
    const data = parsed.data;
    expect(data.rowCount).toBe(3);
    expect(data.validRowCount).toBe(1);
    expect(data.errorCount).toBe(2);
    expect(data.canCommit).toBe(false);
    expect(data.audienceSummary).toEqual({
      public: 1,
      community: 0,
      editors: 0,
    });
    expect(data.relatedRecords).toEqual({
      placesToCreateCount: 1,
      speakersToCreateCount: 1,
    });
    expect(data.rowErrors).toEqual([
      {
        row: 2,
        field: 'visibility',
        code: 'unknown_audience',
        message: expect.any(String),
      },
      {
        row: 3,
        field: 'visibility',
        code: 'missing_required',
        message: expect.any(String),
      },
    ]);
    // Never echo raw unknown audience text!
    expect(JSON.stringify(data.rowErrors)).not.toContain('elders_only');
  });

  it('rejects missing media, media category mismatch, cross-community refs, formula injection, bad HTML href, and cleans up unused staged media', async () => {
    const csvText =
      'title,visibility,description,placeIds,speakerIds,media,externalMediaLinks\n' +
      `"=SUM(1,2)",public,"<p>ok</p>",${existingOwnPlaceId},${existingOwnSpeakerId},,""\n` +
      `"Bad Href",community,"<p><a href=""javascript:alert(1)"">x</a></p>",${existingOwnPlaceId},${existingOwnSpeakerId},,""\n` +
      `"Cross Place",editors,"<p>ok</p>",${existingForeignPlaceId},${existingOwnSpeakerId},,""\n` +
      `"Cross Speaker",editors,"<p>ok</p>",${existingOwnPlaceId},${existingForeignSpeakerId},,""\n` +
      `"Cross File",editors,"<p>ok</p>",${existingOwnPlaceId},${existingOwnSpeakerId},${existingForeignFileId},""\n` +
      `"Missing Media",editors,"<p>ok</p>",${existingOwnPlaceId},${existingOwnSpeakerId},missing.png,""\n` +
      `"Bad External",editors,"<p>ok</p>",${existingOwnPlaceId},${existingOwnSpeakerId},,"javascript:alert(1)"\n` +
      `"Unused Staged On Bad Row",unknown_aud,"<p>ok</p>",${existingOwnPlaceId},${existingOwnSpeakerId},unused-bad-row.png,""\n`;

    const keysBefore = new Set(memStore.keys());
    const res = await postPreview(app, {
      cookie: cookies.editor,
      csvText,
      fields: { kind: 'stories' },
      mediaParts: [
        {
          filename: 'unused-bad-row.png',
          contentType: 'image/png',
          bytes: PNG_BYTES,
        },
      ],
    });
    expect(res.status).toBe(201);
    const parsed = ImportManifestDetailResponseSchema.parse(await res.json());
    expect(parsed.data.validRowCount).toBe(0);
    expect(parsed.data.canCommit).toBe(false);
    expect(parsed.data.stagedMediaCount).toBe(0);
    expect(parsed.data.rowErrors.map((e) => e.code)).toEqual(
      expect.arrayContaining([
        'formula_injection',
        'invalid_description',
        'missing_place',
        'missing_speaker',
        'missing_media',
        'invalid_url',
        'unknown_audience',
      ])
    );

    // Media uploaded for failed row was immediately cleaned from storage, leaving only source CSV.
    const newKeys = [...memStore.keys()].filter((k) => !keysBefore.has(k));
    expect(newKeys).toHaveLength(1);
    expect(newKeys[0]).toContain('/imports/');
  });

  it('rejects media category mismatch on places/speakers and supports duplicateStrategy error vs skip', async () => {
    const placeRes = await postPreview(app, {
      cookie: cookies.editor,
      csvText:
        'name,photo,name_audio\nExisting Creek,song.wav,pic.png\nNew Hill,pic.png,song.wav\n',
      fields: { kind: 'places', duplicateStrategy: 'skip' },
      mediaParts: [
        { filename: 'pic.png', contentType: 'image/png', bytes: PNG_BYTES },
        { filename: 'song.wav', contentType: 'audio/wav', bytes: WAV_BYTES },
      ],
    });
    expect(placeRes.status).toBe(201);
    const placeParsed = ImportManifestDetailResponseSchema.parse(
      await placeRes.json()
    );
    expect(placeParsed.data.skippedDuplicateCount).toBe(1);
    expect(placeParsed.data.validRowCount).toBe(1);
    expect(placeParsed.data.canCommit).toBe(true);

    const mismatchRes = await postPreview(app, {
      cookie: cookies.editor,
      csvText: 'name,birth_date,photo\nSpeaker One,2026-02-30,song.wav\n',
      fields: { kind: 'speakers' },
      mediaParts: [
        { filename: 'song.wav', contentType: 'audio/wav', bytes: WAV_BYTES },
      ],
    });
    expect(mismatchRes.status).toBe(201);
    const mismatchParsed = ImportManifestDetailResponseSchema.parse(
      await mismatchRes.json()
    );
    expect(mismatchParsed.data.rowErrors.map((e) => e.code)).toEqual([
      'invalid_date',
      'media_type_mismatch',
    ]);
  });

  it('rejects malformed CSV, bad media bytes, disallowed mappings (communityId/elderStatus), and cleans up storage on error', async () => {
    const keysBefore = new Set(memStore.keys());

    // Spoofed media bytes (PNG bytes declared as audio/mpeg .mp3)
    const spoofRes = await postPreview(app, {
      cookie: cookies.editor,
      csvText: 'name,photo\nHill,spoof.mp3\n',
      fields: { kind: 'places' },
      mediaParts: [
        {
          filename: 'spoof.mp3',
          contentType: 'audio/mpeg',
          bytes: PNG_BYTES,
        },
      ],
    });
    expect(spoofRes.status).toBe(400);

    // Invalid UTF-8 bytes
    const invalidUtf8 = await postPreview(app, {
      cookie: cookies.editor,
      csvBytes: Uint8Array.from([0x6e, 0x61, 0x6d, 0x65, 0x0a, 0xff]),
      fields: { kind: 'places' },
    });
    expect(invalidUtf8.status).toBe(400);

    // Disallowed mappings (tenant override / removed V1 elderStatus)
    const disallowedMap = await postPreview(app, {
      cookie: cookies.editor,
      csvText: 'name,c\nHill,1\n',
      fields: {
        kind: 'places',
        mappings: JSON.stringify({ name: 'name', communityId: 'c' }),
      },
    });
    expect(disallowedMap.status).toBe(400);

    const elderMap = await postPreview(app, {
      cookie: cookies.editor,
      csvText: 'name,e\nSpeaker,true\n',
      fields: {
        kind: 'speakers',
        mappings: JSON.stringify({ name: 'name', elderStatus: 'e' }),
      },
    });
    expect(elderMap.status).toBe(400);

    // Non-.csv extension
    const nonCsv = await postPreview(app, {
      cookie: cookies.editor,
      csvFilename: 'places.txt',
      csvText: 'name\nHill\n',
      fields: { kind: 'places' },
    });
    expect(nonCsv.status).toBe(400);

    // Verify no leaked storage objects left behind from any of those failures.
    expect([...memStore.keys()]).toEqual([...keysBefore]);
  });

  it('enforces D1 commit-plan budget (422) and 1-import-per-UTC-day limit (429) on D1, rolling back storage', async () => {
    const boundCounts: number[] = [];
    const d1 = createRealD1Db(boundCounts);
    try {
      const now = new Date('2026-06-15T12:00:00.000Z');
      const d1Tables = tablesFor(d1.db);
      const seed = await argon2Seed(TEST_DERIVED_KEY);
      const [comm] = await d1.db
        .insert(d1Tables.communities)
        .values({
          name: 'D1 Import Comm',
          slug: 'd1-import-comm',
          publicStories: false,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: d1Tables.communities.id });
      const [editor] = await d1.db
        .insert(d1Tables.users)
        .values({
          email: 'd1-editor@example.test',
          username: 'd1_editor',
          ...deriveUserIdentityColumns({
            email: 'd1-editor@example.test',
            username: 'd1_editor',
          }),
          firstName: 'D1',
          lastName: 'Editor',
          ...seed,
          role: 'editor',
          communityId: comm.id,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: d1Tables.users.id });

      const d1Mem = createListableMemoryStorage();
      const d1Cleanup = new MediaCleanupCoordinator(d1.db, d1Mem.storage);
      const d1App = createHonoApp({
        repository: new HonoFoundationRepository(d1.db as any),
        storage: d1Mem.storage,
        mediaCleanup: d1Cleanup,
        publicOrigin: API_ORIGIN,
        corsOrigins: [CLIENT_ORIGIN],
        secureCookies: false,
        serverSecret: makeServerSecret(),
        now: () => now,
      });

      const loginRes = await d1App.request(`${API_ORIGIN}/v2/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          identifier: 'd1-editor@example.test',
          communitySlug: 'd1-import-comm',
          derivedKey: TEST_DERIVED_KEY,
        }),
      });
      expect(loginRes.status).toBe(200);
      const d1Cookie = (loginRes.headers.get('set-cookie') ?? '').split(
        ';'
      )[0]!;

      // 1. Over-statement budget (> 1,000 statements) -> 422 + rollback storage
      const manyStoriesCsv =
        'title,visibility\n' +
        Array.from(
          { length: 1_005 },
          (_, i) => `D1 Story ${i + 1},public`
        ).join('\n') +
        '\n';
      const overRes = await postPreview(d1App, {
        cookie: d1Cookie,
        csvText: manyStoriesCsv,
        fields: { kind: 'stories' },
        mediaParts: [
          { filename: 'tmp.png', contentType: 'image/png', bytes: PNG_BYTES },
        ],
      });
      expect(overRes.status).toBe(422);
      const overBody = (await overRes.json()) as {
        code: string;
        error: string;
        details: { alternatives: string };
      };
      expect(overBody.code).toBe('d1_budget_exceeded');
      expect(overBody.error).toContain('1000');
      expect(overBody.details.alternatives).toContain('field kit');
      expect(d1Mem.store.size).toBe(0);

      // 2. Valid preview on real D1 driver succeeds + stays <= 100 bound params/stmt
      boundCounts.length = 0;
      const okRes = await postPreview(d1App, {
        cookie: d1Cookie,
        csvText: 'name,region\nD1 Valley,West\n',
        fields: { kind: 'places' },
        mediaParts: [],
      });
      expect(okRes.status).toBe(201);
      expect(Math.max(...boundCounts)).toBeLessThanOrEqual(100);

      // 3. Committed import today triggers 429 on D1; committed yesterday does not.
      const okJson = ImportManifestDetailResponseSchema.parse(
        await okRes.json()
      );
      await d1.db
        .update(d1Tables.importManifests)
        .set({
          status: 'committed',
          committedAt: now.getTime() - 60_000,
        })
        .where(eq(d1Tables.importManifests.id, okJson.data.id));

      const dailyRes = await postPreview(d1App, {
        cookie: d1Cookie,
        csvText: 'name,region\nD1 Valley Two,East\n',
        fields: { kind: 'places' },
      });
      expect(dailyRes.status).toBe(429);
      const dailyBody = (await dailyRes.json()) as {
        code: string;
        error: string;
      };
      expect(dailyBody.code).toBe('d1_daily_import_limit');
      expect(dailyBody.error).toContain('field kit');

      // Move committedAt to yesterday UTC -> allowed again.
      await d1.db
        .update(d1Tables.importManifests)
        .set({
          committedAt: Date.UTC(2026, 5, 14, 23, 59, 0),
        })
        .where(eq(d1Tables.importManifests.id, okJson.data.id));

      const nextDayRes = await postPreview(d1App, {
        cookie: d1Cookie,
        csvText: 'name,region\nD1 Valley Next Day,South\n',
        fields: { kind: 'places' },
      });
      expect(nextDayRes.status).toBe(201);
      expect(editor.id).toBeGreaterThan(0);
    } finally {
      d1.sqlite.close();
    }
  });

  it('rejects CSV exceeding MAX_CSV_ROWS or MAX_CSV_CELL_LENGTH with 400 and content-free errors', async () => {
    const secretRowMarker = 'SECRET_OVER_CAP_ROW_VALUE';
    const overRowsCsv =
      'name\n' +
      Array.from(
        { length: MAX_CSV_ROWS + 1 },
        (_, i) => `${secretRowMarker}_${i}`
      ).join('\n') +
      '\n';
    const overRowsRes = await postPreview(app, {
      cookie: cookies.editor,
      csvText: overRowsCsv,
      fields: { kind: 'places' },
    });
    expect(overRowsRes.status).toBe(400);
    const overRowsText = await overRowsRes.text();
    expect(overRowsText).not.toContain(secretRowMarker);

    const secretCellMarker = 'SECRET_OVER_CELL_VALUE_';
    const oversizedCell =
      secretCellMarker +
      'x'.repeat(MAX_CSV_CELL_LENGTH + 1 - secretCellMarker.length);
    const overCellRes = await postPreview(app, {
      cookie: cookies.editor,
      csvText: `name\n${oversizedCell}\n`,
      fields: { kind: 'places' },
    });
    expect(overCellRes.status).toBe(400);
    const overCellText = await overCellRes.text();
    expect(overCellText).not.toContain(secretCellMarker);
  });
});
