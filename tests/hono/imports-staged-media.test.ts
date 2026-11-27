/**
 * #282: `POST /v2/imports/preview` with media staged ahead of the request
 * through raw-body `POST /v2/media` and referenced by file id
 * (`mediaFileIds`). The preview never parses multipart media or hashes media
 * bytes on Workers; it only holds rows that already exist.
 *
 * Covered on Node SQLite, on the D1 batch path, and on the workerd runtime.
 */
import { assertPutSha256, rawUploadRequest } from '../helpers/raw-upload.js';
import {
  applyD1Migrations,
  bundleWorkerModule,
  startWorkerRuntime,
} from '../helpers/worker-runtime.js';
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  vi,
} from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { and, eq, inArray, like } from 'drizzle-orm';
import {
  argon2Seed,
  makeDerivedKey,
  makeServerSecret,
} from './auth-test-utils.js';
import { deriveUserIdentityColumns } from '../../src/shared/utils/derived-columns.js';
import { tablesFor } from '../../src/db/dialect.js';
import { createHonoApp } from '../../src/hono-app.js';
import { HonoFoundationRepository } from '../../src/repositories/hono-foundation.repository.js';
import { MediaWritesRepository } from '../../src/repositories/media-writes.repository.js';
import { MediaCleanupCoordinator } from '../../src/services/media-cleanup.service.js';
import type { FoundationStorage } from '../../src/services/hono-foundation.service.js';
import {
  ImportManifestDetailResponseSchema,
  MAX_IMPORT_MEDIA_FILES,
  MAX_IMPORT_MEDIA_REFS_PER_ROW,
  MAX_OPEN_IMPORT_PREVIEWS_PER_COMMUNITY,
} from '../../src/shared/schemas/imports.js';
import { MediaUploadResponseSchema } from '../../src/shared/schemas/media-v2.js';
import { DirectUploadSessionResponseSchema } from '../../src/shared/schemas/media-uploads-v2.js';

const sqlite = new Sqlite(':memory:');
sqlite.pragma('foreign_keys = ON');
const db = drizzle(sqlite);
const tables = tablesFor(db);

const TEST_DERIVED_KEY = makeDerivedKey();
const API_ORIGIN = 'https://api.example.test';
const CLIENT_ORIGIN = 'https://app.example.test';
const WORKER_ORIGIN = 'https://worker.test';
const APP_NOW = new Date('2026-06-15T12:00:00.000Z');

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

const sha256Hex = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');

/** An id no upload can hold: UUID v4, fixed, never issued. */
const MISSING_ID = '4d1e0000-0000-4000-8000-00000000dead';
const NOT_FOUND = { error: 'Not found' };

type MemEntry = { bytes: Uint8Array; contentType?: string; uploaded: Date };

function createListableMemoryStorage(): {
  store: Map<string, MemEntry>;
  storage: FoundationStorage;
} {
  const store = new Map<string, MemEntry>();
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
    async put(storageKey, body, opts) {
      // The direct-upload journal is written as plain bytes (Node api mode).
      const merged =
        body instanceof Uint8Array
          ? body
          : await new Response(body)
              .arrayBuffer()
              .then((buffer) => new Uint8Array(buffer));
      assertPutSha256(merged, opts?.sha256);
      store.set(storageKey, {
        bytes: merged,
        contentType: opts?.contentType,
        uploaded: APP_NOW,
      });
      return { size: merged.byteLength };
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

interface PreviewFormOptions {
  csvFilename?: string;
  csvText: string;
  fields?: Record<string, string>;
  /** Legacy multipart media parts (Node only; rejected on Workers). */
  mediaParts?: Array<{
    filename: string;
    contentType: string;
    bytes: Uint8Array;
  }>;
  /** Send the legacy media parts before the CSV part. */
  mediaFirst?: boolean;
}

/** `multipart/form-data` body for `POST /v2/imports/preview`. */
function buildPreviewForm(options: PreviewFormOptions): {
  bytes: Uint8Array;
  contentTypeHeader: string;
} {
  const boundary = `staged-bound-${Math.random().toString(16).slice(2)}`;
  const enc = new TextEncoder();
  const fieldChunks: Uint8Array[] = [];
  for (const [key, value] of Object.entries(options.fields ?? {})) {
    fieldChunks.push(
      enc.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`
      )
    );
  }
  const csvChunks = [
    enc.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${options.csvFilename ?? 'import.csv'}"\r\nContent-Type: text/csv\r\n\r\n`
    ),
    enc.encode(options.csvText),
    enc.encode('\r\n'),
  ];
  const mediaChunks = (options.mediaParts ?? []).flatMap((media) => [
    enc.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="media"; filename="${media.filename}"\r\nContent-Type: ${media.contentType}\r\n\r\n`
    ),
    media.bytes,
    enc.encode('\r\n'),
  ]);
  const chunks = [
    ...fieldChunks,
    ...(options.mediaFirst ? mediaChunks : []),
    ...csvChunks,
    ...(options.mediaFirst ? [] : mediaChunks),
    enc.encode(`--${boundary}--\r\n`),
  ];
  const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const bytes = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    bytes.set(c, pos);
    pos += c.byteLength;
  }
  return {
    bytes,
    contentTypeHeader: `multipart/form-data; boundary=${boundary}`,
  };
}

type App = ReturnType<typeof createHonoApp>;

async function postPreview(
  target: App,
  options: PreviewFormOptions & { cookie?: string; origin?: string }
): Promise<Response> {
  const { cookie, origin, ...formOptions } = options;
  const form = buildPreviewForm(formOptions);
  const headers: Record<string, string> = {
    'content-type': form.contentTypeHeader,
    origin: origin ?? CLIENT_ORIGIN,
  };
  if (cookie) headers.cookie = cookie;
  return target.request(`${API_ORIGIN}/v2/imports/preview`, {
    method: 'POST',
    headers,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(form.bytes);
        controller.close();
      },
    }),
    duplex: 'half',
  } as RequestInit);
}

/** The `mediaFileIds` form field: ids returned by `POST /v2/media`. */
const declared = (fileIds: string[]) => ({
  mediaFileIds: JSON.stringify(fileIds),
});

/**
 * One D1-shaped client over an in-memory SQLite database. `onBeforeBatch`
 * receives the SQL of the statements a batch is about to run, after every
 * read the request made before it and before the batch's own writes.
 */
function createFakeD1(hooks?: {
  onBeforeBatch?: (queries: string[]) => Promise<void>;
}) {
  const d1Sqlite = new Sqlite(':memory:');
  d1Sqlite.pragma('foreign_keys = ON');
  migrate(drizzle(d1Sqlite), { migrationsFolder: './src/db/migrations' });
  const boundParams: number[] = [];
  const client = {
    prepare(query: string) {
      let params: unknown[] = [];
      const stmt = {
        query,
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
            .all(...params) as unknown[],
        first: async () => d1Sqlite.prepare(query).get(...params) ?? null,
        run: async () => {
          const info = d1Sqlite.prepare(query).run(...params);
          return { success: true, meta: { changes: info.changes } };
        },
        _exec() {
          boundParams.push(params.length);
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
    async batch(stmts: Array<{ _exec: () => unknown; query: string }>) {
      await hooks?.onBeforeBatch?.(stmts.map((statement) => statement.query));
      return d1Sqlite.transaction(() => stmts.map((s) => s._exec()))();
    },
  };
  return {
    db: drizzleD1(client as unknown as D1Database),
    sqlite: d1Sqlite,
    boundParams,
  };
}

let app: App;
let cleanup: MediaCleanupCoordinator;
let memStore: Map<string, MemEntry>;
const ids: Record<string, number> = {};
const cookies: Record<string, string> = {};
let ownPlaceId = 0;

async function insertRow(table: any, values: any): Promise<number> {
  const [inserted] = await db
    .insert(table)
    .values(values)
    .returning({ id: table.id });
  return inserted.id as number;
}

async function loginAs(email: string, communityId?: number): Promise<string> {
  const [row] = await db
    .select({ slug: tables.communities.slug })
    .from(tables.communities)
    .where(eq(tables.communities.id, communityId))
    .limit(1);
  const res = await app.request(`${API_ORIGIN}/v2/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      identifier: email,
      derivedKey: TEST_DERIVED_KEY,
      communitySlug: row?.slug,
    }),
  });
  expect(res.status).toBe(200);
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

async function rawUpload(
  target: App,
  cookie: string,
  filename: string,
  bytes = PNG_BYTES
): Promise<Response> {
  const up = rawUploadRequest({
    filename,
    contentType: filename.endsWith('.wav') ? 'audio/wav' : 'image/png',
    bytes,
  });
  return target.request(`${API_ORIGIN}/v2/media${up.search}`, {
    method: 'POST',
    headers: { ...up.headers, cookie, origin: CLIENT_ORIGIN },
    body: up.body,
  });
}

/** Stage one media file the way a client does before an import preview. */
async function stageMedia(
  cookie: string,
  filename: string,
  bytes = PNG_BYTES
): Promise<string> {
  const res = await rawUpload(app, cookie, filename, bytes);
  expect(res.status).toBe(201);
  return MediaUploadResponseSchema.parse(await res.json()).data.id;
}

function getMedia(cookie: string, fileId: string, suffix = '') {
  return app.request(`${API_ORIGIN}/v2/media/${fileId}${suffix}`, {
    headers: { cookie },
  });
}

async function fileRow(fileId: string) {
  const [row] = await db
    .select()
    .from(tables.files)
    .where(eq(tables.files.id, fileId));
  return row;
}

/** Everything a denied preview must leave untouched. */
async function snapshotState() {
  const files = await db
    .select({
      id: tables.files.id,
      isActive: tables.files.isActive,
      communityId: tables.files.communityId,
    })
    .from(tables.files)
    .orderBy(tables.files.id);
  const manifests = await db
    .select({
      id: tables.importManifests.id,
      status: tables.importManifests.status,
    })
    .from(tables.importManifests)
    .orderBy(tables.importManifests.id);
  const attachments = await db
    .select({ id: tables.attachments.id, fileId: tables.attachments.fileId })
    .from(tables.attachments)
    .orderBy(tables.attachments.id);
  const audits = await db
    .select({ id: tables.auditEntries.id, action: tables.auditEntries.action })
    .from(tables.auditEntries)
    .orderBy(tables.auditEntries.id);
  return {
    files,
    manifests,
    attachments,
    audits,
    keys: [...memStore.keys()].sort(),
  };
}

async function commitManifest(cookie: string, manifestId: number) {
  return app.request(`${API_ORIGIN}/v2/imports/${manifestId}/commit`, {
    method: 'POST',
    headers: { cookie, origin: CLIENT_ORIGIN },
  });
}

describe('POST /v2/imports/preview with media staged ahead of the request (#282)', () => {
  beforeAll(async () => {
    migrate(db, { migrationsFolder: './src/db/migrations' });
    const now = new Date('2026-06-01T12:00:00.000Z');
    const seed = await argon2Seed(TEST_DERIVED_KEY);

    ids.ownCommunity = await insertRow(tables.communities, {
      name: 'Staged Import Community',
      slug: 'staged-import-comm',
      publicStories: true,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });
    ids.foreignCommunity = await insertRow(tables.communities, {
      name: 'Staged Import Foreign Community',
      slug: 'staged-import-foreign-comm',
      publicStories: true,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });

    const addUser = async (email: string, role: string, communityId: number) =>
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
    await addUser('staged-editor@example.test', 'editor', ids.ownCommunity);
    await addUser('staged-editor2@example.test', 'editor', ids.ownCommunity);
    await addUser('staged-admin@example.test', 'admin', ids.ownCommunity);
    await addUser(
      'staged-foreign@example.test',
      'editor',
      ids.foreignCommunity
    );

    ownPlaceId = await insertRow(tables.places, {
      name: 'Staged Creek',
      communityId: ids.ownCommunity,
      latitude: 1.5,
      longitude: 2.5,
      isRestricted: false,
      createdAt: now,
      updatedAt: now,
    });

    const mem = createListableMemoryStorage();
    memStore = mem.store;
    cleanup = new MediaCleanupCoordinator(db, mem.storage, {
      now: () => APP_NOW,
    });
    app = createHonoApp({
      repository: new HonoFoundationRepository(db),
      storage: mem.storage,
      mediaCleanup: cleanup,
      publicOrigin: API_ORIGIN,
      corsOrigins: [CLIENT_ORIGIN],
      secureCookies: false,
      serverSecret: makeServerSecret(),
      now: () => APP_NOW,
    });

    cookies.editor = await loginAs(
      'staged-editor@example.test',
      ids.ownCommunity
    );
    cookies.editor2 = await loginAs(
      'staged-editor2@example.test',
      ids.ownCommunity
    );
    cookies.admin = await loginAs(
      'staged-admin@example.test',
      ids.ownCommunity
    );
    cookies.foreign = await loginAs(
      'staged-foreign@example.test',
      ids.foreignCommunity
    );
  });

  beforeEach(async () => {
    // Keep the open-preview cap free; earlier previews keep their held rows.
    await db
      .update(tables.importManifests)
      .set({ status: 'discarded' })
      .where(eq(tables.importManifests.status, 'previewed'));
  });

  afterAll(() => {
    sqlite.close();
  });

  it('holds media matched by file id and by filename, keeps it unreachable, and activates it on commit', async () => {
    const picId = await stageMedia(cookies.editor, 'cedar.png');
    const wavId = await stageMedia(cookies.editor, 'cedar.wav', WAV_BYTES);
    const keysBefore = new Set(memStore.keys());
    // While they are plain staging uploads the uploader can still read them.
    expect((await getMedia(cookies.editor, picId)).status).toBe(200);

    const res = await postPreview(app, {
      cookie: cookies.editor,
      csvFilename: 'places.csv',
      csvText: `name,photo,name_audio\nCedar Point,${picId},cedar.wav\n`,
      fields: { kind: 'places', ...declared([picId, wavId]) },
    });
    expect(res.status).toBe(201);
    const data = ImportManifestDetailResponseSchema.parse(
      await res.json()
    ).data;
    expect(data.status).toBe('previewed');
    expect(data.canCommit).toBe(true);
    expect(data.stagedMediaCount).toBe(2);
    expect(data.mediaSummary).toEqual({
      stagedCount: 2,
      existingReferencedCount: 0,
      totalAttachmentRefs: 2,
    });
    expect(data.previewRows).toEqual([
      {
        kind: 'places',
        rowNumber: 1,
        name: 'Cedar Point',
        descriptionExcerpt: null,
        typeOfPlace: null,
        region: null,
        latitude: null,
        longitude: null,
        attachments: [
          { role: 'place_photo', ordinal: 0, source: 'staged' },
          { role: 'place_name_audio', ordinal: 0, source: 'staged' },
        ],
      },
    ]);
    const wire = JSON.stringify(data);
    for (const secret of [picId, wavId, 'storageKey', 'checksum']) {
      expect(wire).not.toContain(secret);
    }

    // The preview stored only its source CSV; media bytes were never moved.
    const newKeys = [...memStore.keys()].filter((key) => !keysBefore.has(key));
    expect(newKeys).toHaveLength(1);
    expect(newKeys[0]).toContain('/imports/');
    expect(memStore.has(`communities/${ids.ownCommunity}/media/${picId}`)).toBe(
      true
    );

    // The existing rows are held: inactive, and unreachable on every surface.
    for (const [id, bytes] of [
      [picId, PNG_BYTES],
      [wavId, WAV_BYTES],
    ] as const) {
      const row = await fileRow(id);
      expect(row?.isActive).toBe(false);
      expect(row?.checksum).toBe(sha256Hex(bytes));
      expect((await getMedia(cookies.admin, id)).status).toBe(404);
      expect((await getMedia(cookies.admin, id, '/metadata')).status).toBe(404);
      const deleted = await app.request(`${API_ORIGIN}/v2/media/${id}`, {
        method: 'DELETE',
        headers: { cookie: cookies.admin, origin: CLIENT_ORIGIN },
      });
      expect(deleted.status).toBe(404);
    }

    // Held rows are protected from the unreferenced-file sweep.
    const swept = await cleanup.sweepUnreferencedFiles({
      fileIds: [picId, wavId],
      olderThan: new Date('2000-01-01T00:00:00.000Z'),
    });
    expect(swept.deletedCount).toBe(0);
    expect(await fileRow(picId)).toBeDefined();

    const commit = await commitManifest(cookies.editor, data.id);
    expect(commit.status).toBe(200);
    expect(
      ImportManifestDetailResponseSchema.parse(await commit.json()).data
        .resultSummary
    ).toMatchObject({ createdPlaces: 1, createdAttachments: 2 });
    expect((await fileRow(picId))?.isActive).toBe(true);
    expect((await fileRow(wavId))?.isActive).toBe(true);
    const served = await getMedia(cookies.editor, picId);
    expect(served.status).toBe(200);
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG_BYTES);
  });

  it('holds a file staged through the direct-upload flow when its whole-file checksum was verified, and refuses one without a checksum', async () => {
    // Node api mode: the assembled digest is verified natively and stored.
    const create = await app.request(`${API_ORIGIN}/v2/media/uploads`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: cookies.editor,
        origin: CLIENT_ORIGIN,
      },
      body: JSON.stringify({
        filename: 'direct-pic.png',
        contentType: 'image/png',
        size: PNG_BYTES.byteLength,
        sha256: sha256Hex(PNG_BYTES),
        partSha256: [sha256Hex(PNG_BYTES)],
      }),
    });
    expect(create.status).toBe(201);
    const session = DirectUploadSessionResponseSchema.parse(
      await create.json()
    ).data;
    expect(session.mode).toBe('api');
    const etags: Array<{ partNumber: number; etag: string }> = [];
    for (const target of session.parts) {
      const part = PNG_BYTES.subarray(
        (target.partNumber - 1) * session.partSize,
        target.partNumber * session.partSize
      );
      const put = await app.request(target.url, {
        method: 'PUT',
        headers: {
          ...target.headers,
          cookie: cookies.editor,
          origin: CLIENT_ORIGIN,
          'content-length': String(part.byteLength),
        },
        body: part,
      });
      expect(put.status).toBe(200);
      etags.push({
        partNumber: target.partNumber,
        etag: put.headers.get('etag')!.replace(/"/g, ''),
      });
    }
    const done = await app.request(
      `${API_ORIGIN}/v2/media/uploads/${session.id}/complete`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: cookies.editor,
          origin: CLIENT_ORIGIN,
        },
        body: JSON.stringify({ parts: etags }),
      }
    );
    expect(done.status).toBe(201);
    const directFile = MediaUploadResponseSchema.parse(await done.json()).data;
    expect(directFile.checksum).toBe(sha256Hex(PNG_BYTES));

    const preview = await postPreview(app, {
      cookie: cookies.editor,
      csvText: `name,photo\nDirect Upload Place,${directFile.id}\n`,
      fields: { kind: 'places', ...declared([directFile.id]) },
    });
    expect(preview.status).toBe(201);
    expect(
      ImportManifestDetailResponseSchema.parse(await preview.json()).data
        .stagedMediaCount
    ).toBe(1);
    expect((await fileRow(directFile.id))?.isActive).toBe(false);

    // A file with no stored checksum (a direct upload completed on Workers)
    // cannot be held: commit re-verifies held bytes against that checksum.
    const uncheckedId = randomUUID();
    const uncheckedKey = `communities/${ids.ownCommunity}/media/${uncheckedId}`;
    const now = new Date('2026-06-15T12:00:00.000Z');
    await db.insert(tables.files).values({
      id: uncheckedId,
      filename: uncheckedId,
      originalName: 'unchecked.png',
      path: uncheckedKey,
      storageKey: uncheckedKey,
      url: `/v2/media/${uncheckedId}`,
      mimeType: 'image/png',
      size: PNG_BYTES.byteLength,
      byteSize: PNG_BYTES.byteLength,
      checksum: null,
      communityId: ids.ownCommunity,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });
    const before = await snapshotState();
    const unchecked = await postPreview(app, {
      cookie: cookies.editor,
      csvText: `name,photo\nUnchecked Place,${uncheckedId}\n`,
      fields: { kind: 'places', ...declared([uncheckedId]) },
    });
    expect(unchecked.status).toBe(404);
    expect(await unchecked.json()).toEqual(NOT_FOUND);
    expect(await snapshotState()).toEqual(before);
  });

  it('lets an admin hold another editor’s staging upload', async () => {
    const sharedId = await stageMedia(cookies.editor2, 'shared-pic.png');
    const res = await postPreview(app, {
      cookie: cookies.admin,
      csvText: `name,photo\nAdmin Held Place,${sharedId}\n`,
      fields: { kind: 'places', ...declared([sharedId]) },
    });
    expect(res.status).toBe(201);
    expect((await fileRow(sharedId))?.isActive).toBe(false);
  });

  it('discard removes the held staged media rows and bytes', async () => {
    const keysBefore = new Set(memStore.keys());
    const picId = await stageMedia(cookies.editor, 'discarded-pic.png');
    const res = await postPreview(app, {
      cookie: cookies.editor,
      csvText: `name,photo\nDiscarded Place,${picId}\n`,
      fields: { kind: 'places', ...declared([picId]) },
    });
    expect(res.status).toBe(201);
    const data = ImportManifestDetailResponseSchema.parse(
      await res.json()
    ).data;
    const heldKey = (await fileRow(picId))?.storageKey;
    const [manifestRow] = await db
      .select({ sourceFileId: tables.importManifests.sourceFileId })
      .from(tables.importManifests)
      .where(eq(tables.importManifests.id, data.id));
    const sourceKey = (await fileRow(manifestRow!.sourceFileId))?.storageKey;
    expect(memStore.has(heldKey!)).toBe(true);

    const discarded = await app.request(`${API_ORIGIN}/v2/imports/${data.id}`, {
      method: 'DELETE',
      headers: { cookie: cookies.editor, origin: CLIENT_ORIGIN },
    });
    expect(discarded.status).toBe(200);
    expect(
      ImportManifestDetailResponseSchema.parse(await discarded.json()).data
        .status
    ).toBe('discarded');
    // The held media row is gone with its bytes ...
    expect(await fileRow(picId)).toBeUndefined();
    expect(memStore.has(heldKey!)).toBe(false);
    // ... and the source CSV keeps only its inactive tombstone row (#280).
    const [sourceAfter] = await db
      .select()
      .from(tables.files)
      .where(eq(tables.files.id, manifestRow!.sourceFileId));
    expect(sourceAfter?.isActive).toBe(false);
    expect(memStore.has(sourceKey!)).toBe(false);
    expect([...memStore.keys()]).toEqual([...keysBefore]);
  });

  it('the expired-preview sweep purges held staged media rows and bytes', async () => {
    const keysBefore = new Set(memStore.keys());
    const picId = await stageMedia(cookies.editor, 'expired-pic.png');
    const res = await postPreview(app, {
      cookie: cookies.editor,
      csvText: `name,photo\nExpired Place,${picId}\n`,
      fields: { kind: 'places', ...declared([picId]) },
    });
    expect(res.status).toBe(201);
    const data = ImportManifestDetailResponseSchema.parse(
      await res.json()
    ).data;
    const heldKey = (await fileRow(picId))?.storageKey;

    const swept = await cleanup.sweepExpiredImportPreviews({
      olderThan: new Date('2026-06-22T12:00:00.000Z'),
    });
    expect(swept.expiredCount).toBe(1);
    expect(swept.deletedBytesCount).toBe(2);
    const [manifestAfter] = await db
      .select({ status: tables.importManifests.status })
      .from(tables.importManifests)
      .where(eq(tables.importManifests.id, data.id));
    expect(manifestAfter?.status).toBe('discarded');
    expect(await fileRow(picId)).toBeUndefined();
    expect(memStore.has(heldKey!)).toBe(false);
    expect([...memStore.keys()]).toEqual([...keysBefore]);
  });

  it('answers an exact 404 and changes nothing for a foreign-community file id', async () => {
    const foreignId = await stageMedia(cookies.foreign, 'foreign-pic.png');
    const before = await snapshotState();

    // Referenced by id ...
    const byId = await postPreview(app, {
      cookie: cookies.editor,
      csvText: `name,photo\nCross Community Place,${foreignId}\n`,
      fields: { kind: 'places', ...declared([foreignId]) },
    });
    expect(byId.status).toBe(404);
    expect(await byId.json()).toEqual(NOT_FOUND);

    // ... and by filename: the answer does not reveal that the id exists.
    const byName = await postPreview(app, {
      cookie: cookies.editor,
      csvText: 'name,photo\nCross Community Place,foreign-pic.png\n',
      fields: { kind: 'places', ...declared([foreignId]) },
    });
    expect(byName.status).toBe(404);
    expect(await byName.json()).toEqual(NOT_FOUND);
    expect(await snapshotState()).toEqual(before);

    // One valid id never carries an invalid one through.
    const ownId = await stageMedia(cookies.editor, 'mixed-pic.png');
    const mixedBefore = await snapshotState();
    const mixed = await postPreview(app, {
      cookie: cookies.editor,
      csvText: `name,photo\nMixed Place,${ownId}|${foreignId}\n`,
      fields: { kind: 'places', ...declared([ownId, foreignId]) },
    });
    expect(mixed.status).toBe(404);
    expect(await mixed.json()).toEqual(NOT_FOUND);
    expect(await snapshotState()).toEqual(mixedBefore);
    expect((await fileRow(ownId))?.isActive).toBe(true);
    // The foreign upload itself is untouched and still private to its uploader.
    expect((await fileRow(foreignId))?.isActive).toBe(true);
    expect((await getMedia(cookies.foreign, foreignId)).status).toBe(200);
  });

  it('rejects an already-attached id, which stays usable only as an undeclared existing file', async () => {
    const attachedId = await stageMedia(cookies.editor, 'attached-pic.png');
    const attach = await app.request(`${API_ORIGIN}/v2/attachments`, {
      method: 'POST',
      headers: {
        cookie: cookies.editor,
        origin: CLIENT_ORIGIN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        fileId: attachedId,
        ownerType: 'place',
        ownerId: ownPlaceId,
        role: 'place_photo',
      }),
    });
    expect(attach.status).toBe(201);
    const before = await snapshotState();

    const declaredRes = await postPreview(app, {
      cookie: cookies.editor,
      csvText: `name,photo\nAttached Place,${attachedId}\n`,
      fields: { kind: 'places', ...declared([attachedId]) },
    });
    expect(declaredRes.status).toBe(404);
    expect(await declaredRes.json()).toEqual(NOT_FOUND);
    expect(await snapshotState()).toEqual(before);

    // Undeclared, the same attached file is still an ordinary existing
    // reference: the pre-#282 behaviour for file-id references is unchanged.
    const existing = await postPreview(app, {
      cookie: cookies.editor,
      csvText: `name,photo\nExisting Ref Place,${attachedId}\n`,
      fields: { kind: 'places' },
    });
    expect(existing.status).toBe(201);
    expect(
      ImportManifestDetailResponseSchema.parse(await existing.json()).data
        .mediaSummary
    ).toEqual({
      stagedCount: 0,
      existingReferencedCount: 1,
      totalAttachmentRefs: 1,
    });
  });

  it('answers the same 404 for a missing id and for an upload deleted before the preview', async () => {
    const missing = await postPreview(app, {
      cookie: cookies.editor,
      csvText: `name,photo\nMissing Place,${MISSING_ID}\n`,
      fields: { kind: 'places', ...declared([MISSING_ID]) },
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual(NOT_FOUND);

    const removedId = await stageMedia(cookies.editor, 'removed-pic.png');
    const removed = await app.request(`${API_ORIGIN}/v2/media/${removedId}`, {
      method: 'DELETE',
      headers: { cookie: cookies.editor, origin: CLIENT_ORIGIN },
    });
    expect(removed.status).toBe(204);
    expect(await fileRow(removedId)).toBeUndefined();
    // The delete wrote its own audit entry; compare against the state after it.
    const afterDelete = await snapshotState();

    const gone = await postPreview(app, {
      cookie: cookies.editor,
      csvText: `name,photo\nRemoved Place,${removedId}\n`,
      fields: { kind: 'places', ...declared([removedId]) },
    });
    expect(gone.status).toBe(404);
    expect(await gone.json()).toEqual(NOT_FOUND);
    expect(await snapshotState()).toEqual(afterDelete);
  });

  it('keeps another editor’s private staging upload private', async () => {
    const privateId = await stageMedia(cookies.editor2, 'private-pic.png');
    const before = await snapshotState();
    const res = await postPreview(app, {
      cookie: cookies.editor,
      csvText: `name,photo\nTaken Place,${privateId}\n`,
      fields: { kind: 'places', ...declared([privateId]) },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(NOT_FOUND);
    expect(await snapshotState()).toEqual(before);
    expect((await fileRow(privateId))?.isActive).toBe(true);
  });

  it('holds a staged upload for exactly one preview', async () => {
    const picId = await stageMedia(cookies.editor, 'once-pic.png');
    const keysBefore = new Set(memStore.keys());
    const first = await postPreview(app, {
      cookie: cookies.editor,
      csvText: `name,photo\nFirst Place,${picId}\n`,
      fields: { kind: 'places', ...declared([picId]) },
    });
    expect(first.status).toBe(201);
    const heldBefore = await snapshotState();

    // The same editor, another editor and an admin all get the same answer.
    for (const cookie of [cookies.editor, cookies.editor2, cookies.admin]) {
      const second = await postPreview(app, {
        cookie,
        csvText: `name,photo\nSecond Place,${picId}\n`,
        fields: { kind: 'places', ...declared([picId]) },
      });
      expect(second.status).toBe(404);
      expect(await second.json()).toEqual(NOT_FOUND);
    }
    // No manifest, no source CSV and no change to the held row.
    expect(await snapshotState()).toEqual(heldBefore);
    expect(
      [...memStore.keys()].filter((key) => !keysBefore.has(key))
    ).toHaveLength(1);
  });

  // The other side of that race: the attach resolved the upload while it was
  // still an active staging upload, and a preview held it before the attach's
  // own write. The hold is placed between the two, after the attach's last
  // read, so only a check made by the write itself can refuse it.
  it('refuses an attach that resolved a staging upload before a preview held it', async () => {
    const picId = await stageMedia(cookies.editor, 'held-before-attach.png');
    const resolveReuse = MediaWritesRepository.prototype.authorizeAttachReuse;
    let holding: Response | undefined;
    const reuse = vi
      .spyOn(MediaWritesRepository.prototype, 'authorizeAttachReuse')
      .mockImplementation(async function (this: MediaWritesRepository, input) {
        const verdict = await resolveReuse.call(this, input);
        if (input.file.id === picId && !holding) {
          holding = await postPreview(app, {
            cookie: cookies.editor,
            csvText: `name,photo\nHeld First Place,${picId}\n`,
            fields: { kind: 'places', ...declared([picId]) },
          });
        }
        return verdict;
      });
    let attach: Response;
    try {
      attach = await app.request(`${API_ORIGIN}/v2/attachments`, {
        method: 'POST',
        headers: {
          cookie: cookies.editor,
          origin: CLIENT_ORIGIN,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          fileId: picId,
          ownerType: 'place',
          ownerId: ownPlaceId,
          role: 'place_photo',
        }),
      });
    } finally {
      reuse.mockRestore();
    }
    expect(holding?.status).toBe(201);
    expect(attach.status).toBe(404);
    expect(await attach.json()).toEqual(NOT_FOUND);

    // The upload belongs to the preview alone: nothing was attached to it ...
    const relations = await db
      .select({ id: tables.attachments.id })
      .from(tables.attachments)
      .where(eq(tables.attachments.fileId, picId));
    expect(relations).toEqual([]);
    // ... the preview still holds it, unreachable on every surface ...
    expect((await fileRow(picId))?.isActive).toBe(false);
    expect((await getMedia(cookies.editor, picId)).status).toBe(404);
    expect((await getMedia(cookies.admin, picId)).status).toBe(404);
    // ... and the refused attach left a denied audit entry, never a success.
    const attachAudits = await db
      .select({ outcome: tables.auditEntries.outcome })
      .from(tables.auditEntries)
      .where(
        and(
          eq(tables.auditEntries.action, 'attachment.create'),
          like(tables.auditEntries.resourceIds, `%${picId}%`)
        )
      );
    expect(attachAudits).toEqual([{ outcome: 'denied' }]);
  });

  // The uniform 404 must not depend on where a dead id sits in `mediaFileIds`:
  // every listed id is judged available first, and only then is a file refused
  // for its filename or its references.
  it('answers the same 404 in either order when one listed id is not adoptable, whatever another listed file would be refused for', async () => {
    const idleId = await stageMedia(cookies.editor, 'order-idle.png');
    const twinA = await stageMedia(cookies.editor, 'order-twin.png');
    const twinB = await stageMedia(cookies.editor, 'order-twin.png');
    const attachedId = await stageMedia(cookies.editor, 'order-attached.png');
    const attached = await app.request(`${API_ORIGIN}/v2/attachments`, {
      method: 'POST',
      headers: {
        cookie: cookies.editor,
        origin: CLIENT_ORIGIN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        fileId: attachedId,
        ownerType: 'place',
        ownerId: ownPlaceId,
        role: 'place_photo',
      }),
    });
    expect(attached.status).toBe(201);
    const heldId = await stageMedia(cookies.editor, 'order-held.png');
    const holding = await postPreview(app, {
      cookie: cookies.editor,
      csvText: `name,photo\nOrder Holder,${heldId}\n`,
      fields: { kind: 'places', ...declared([heldId]) },
    });
    expect(holding.status).toBe(201);
    const foreignId = await stageMedia(cookies.foreign, 'order-foreign.png');
    const before = await snapshotState();

    // The CSV names an unreferenced file, or the two files with one name.
    const unreferenced = 'name,photo\nOrder Place,\n';
    const twins = `name,photo\nTwin Place One,${twinA}\nTwin Place Two,${twinB}\n`;
    // Listed alone, the caller's own files are refused with 400 ...
    for (const [listed, csvText] of [
      [[idleId], unreferenced],
      [[twinA, twinB], twins],
    ] as const) {
      const ownFiles = await postPreview(app, {
        cookie: cookies.editor,
        csvText,
        fields: { kind: 'places', ...declared([...listed]) },
      });
      expect(ownFiles.status).toBe(400);
    }
    // ... but that refusal never outranks a missing, foreign, attached or
    // held id, wherever it sits in the list.
    for (const [reason, deadId] of Object.entries({
      missing: MISSING_ID,
      foreign: foreignId,
      attached: attachedId,
      held: heldId,
    })) {
      const orders: Array<[string, string[], string]> = [
        ['after an unreferenced file', [idleId, deadId], unreferenced],
        ['before an unreferenced file', [deadId, idleId], unreferenced],
        ['after a duplicate filename', [twinA, twinB, deadId], twins],
        ['before a duplicate filename', [deadId, twinA, twinB], twins],
      ];
      for (const [position, listed, csvText] of orders) {
        const res = await postPreview(app, {
          cookie: cookies.editor,
          csvText,
          fields: { kind: 'places', ...declared(listed) },
        });
        expect(res.status, `a ${reason} id ${position}`).toBe(404);
        expect(await res.json(), `a ${reason} id ${position}`).toEqual(
          NOT_FOUND
        );
      }
    }
    expect(await snapshotState()).toEqual(before);
    expect((await fileRow(idleId))?.isActive).toBe(true);
    expect((await fileRow(twinA))?.isActive).toBe(true);
    expect((await fileRow(twinB))?.isActive).toBe(true);
    expect((await getMedia(cookies.foreign, foreignId)).status).toBe(200);
  });

  it('rejects a declared file the CSV does not reference, naming its index, and holds nothing for invalid rows', async () => {
    const usedId = await stageMedia(cookies.editor, 'used-pic.png');
    const idleId = await stageMedia(cookies.editor, 'idle-pic.png');
    const before = await snapshotState();

    const unreferenced = await postPreview(app, {
      cookie: cookies.editor,
      csvText: `name,photo\nGood Place,${usedId}\n`,
      fields: { kind: 'places', ...declared([usedId, idleId]) },
    });
    expect(unreferenced.status).toBe(400);
    expect(await unreferenced.json()).toEqual({
      error: 'Validation failed',
      code: 'validation_error',
      details: {
        fields: [
          {
            path: 'mediaFileIds[1]',
            message:
              'Staged media file is not referenced by any CSV media column',
          },
        ],
      },
    });
    expect(await snapshotState()).toEqual(before);

    // A file referenced only by a row with errors is not held: it stays the
    // uploader's active staging upload, ready for a corrected preview.
    const res = await postPreview(app, {
      cookie: cookies.editor,
      csvText: `name,photo\nGood Place Two,${usedId}\n,${idleId}\n`,
      fields: { kind: 'places', ...declared([usedId, idleId]) },
    });
    expect(res.status).toBe(201);
    const data = ImportManifestDetailResponseSchema.parse(
      await res.json()
    ).data;
    expect(data.canCommit).toBe(false);
    expect(data.validRowCount).toBe(1);
    expect(data.stagedMediaCount).toBe(1);
    expect((await fileRow(usedId))?.isActive).toBe(false);
    expect((await fileRow(idleId))?.isActive).toBe(true);
    expect((await getMedia(cookies.editor, idleId)).status).toBe(200);
  });

  it('still rejects an unreferenced declared file when another row has an over-limit media cell', async () => {
    const usedId = await stageMedia(cookies.editor, 'crowded-pic.png');
    const idleId = await stageMedia(cookies.editor, 'idle-crowded-pic.png');
    const before = await snapshotState();
    // One reference over the per-column cap makes the row a `too_many_refs`
    // error. The cell still references `usedId`, by id, and nothing else, so
    // the idle file is referenced by no CSV media column.
    const crowded = [
      usedId,
      ...Array.from({ length: MAX_IMPORT_MEDIA_REFS_PER_ROW }, () =>
        randomUUID()
      ),
    ].join('|');

    const res = await postPreview(app, {
      cookie: cookies.editor,
      csvText: `name,photo\nCrowded Place,${crowded}\n`,
      fields: { kind: 'places', ...declared([usedId, idleId]) },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Validation failed',
      code: 'validation_error',
      details: {
        fields: [
          {
            path: 'mediaFileIds[1]',
            message:
              'Staged media file is not referenced by any CSV media column',
          },
        ],
      },
    });
    expect(await snapshotState()).toEqual(before);
  });

  it('counts a file referenced only inside an over-limit media cell as referenced, and holds nothing for that row', async () => {
    const crowdedId = await stageMedia(cookies.editor, 'crowded-name.png');
    // Referenced by filename, past the per-column cap: the row is still an
    // error, so the file is referenced yet never held.
    const crowded = Array.from(
      { length: MAX_IMPORT_MEDIA_REFS_PER_ROW + 1 },
      () => randomUUID()
    );
    crowded[MAX_IMPORT_MEDIA_REFS_PER_ROW] = 'crowded-name.png';

    const res = await postPreview(app, {
      cookie: cookies.editor,
      csvText: `name,photo\nCrowded Place,${crowded.join('|')}\n`,
      fields: { kind: 'places', ...declared([crowdedId]) },
    });
    expect(res.status).toBe(201);
    const data = ImportManifestDetailResponseSchema.parse(
      await res.json()
    ).data;
    expect(data.canCommit).toBe(false);
    expect(data.validRowCount).toBe(0);
    expect(data.stagedMediaCount).toBe(0);
    expect(
      data.rowErrors.map((rowError) => [rowError.field, rowError.code])
    ).toEqual([['photo', 'too_many_refs']]);
    expect((await fileRow(crowdedId))?.isActive).toBe(true);
    expect((await getMedia(cookies.editor, crowdedId)).status).toBe(200);
  });

  // `POST /v2/media` stores a sanitized display name, so `café.png` is stored
  // as `caf-.png`. A CSV is written against the filename the uploader sent, so
  // a media column must find the file under that name as well.
  it('finds a listed file by the filename the uploader sent, which is not its stored name', async () => {
    const picId = await stageMedia(cookies.editor, 'café.png');
    expect((await fileRow(picId))?.originalName).toBe('caf-.png');

    // Named as it was sent ...
    const asSent = await postPreview(app, {
      cookie: cookies.editor,
      csvText: 'name,photo\nCafé Place,café.png\n',
      fields: { kind: 'places', ...declared([picId]) },
    });
    expect(asSent.status).toBe(201);
    const data = ImportManifestDetailResponseSchema.parse(
      await asSent.json()
    ).data;
    expect(data.canCommit).toBe(true);
    expect(data.stagedMediaCount).toBe(1);
    expect(data.previewRows).toEqual([
      {
        kind: 'places',
        rowNumber: 1,
        name: 'Café Place',
        descriptionExcerpt: null,
        typeOfPlace: null,
        region: null,
        latitude: null,
        longitude: null,
        attachments: [{ role: 'place_photo', ordinal: 0, source: 'staged' }],
      },
    ]);
    expect((await fileRow(picId))?.isActive).toBe(false);
    const committed = await commitManifest(cookies.editor, data.id);
    expect(committed.status).toBe(200);
    expect(
      ImportManifestDetailResponseSchema.parse(await committed.json()).data
        .resultSummary
    ).toMatchObject({ createdPlaces: 1, createdAttachments: 1 });

    // ... and as it is stored: both spellings name the upload.
    const storedId = await stageMedia(cookies.editor, 'café.png');
    const asStored = await postPreview(app, {
      cookie: cookies.editor,
      csvText: 'name,photo\nStored Name Place,caf-.png\n',
      fields: { kind: 'places', ...declared([storedId]) },
    });
    expect(asStored.status).toBe(201);
    expect(
      ImportManifestDetailResponseSchema.parse(await asStored.json()).data
        .stagedMediaCount
    ).toBe(1);
    expect((await fileRow(storedId))?.isActive).toBe(false);

    // A file id is still matched exactly as written: cleaning a token never
    // turns it into the id of a listed file.
    const exactId = await stageMedia(cookies.editor, 'exact-id.png');
    const decorated = await postPreview(app, {
      cookie: cookies.editor,
      csvText: `name,photo\nDecorated Id Place,photos/${exactId}\n`,
      fields: { kind: 'places', ...declared([exactId]) },
    });
    expect(decorated.status).toBe(400);
    expect(await decorated.json()).toEqual({
      error: 'Validation failed',
      code: 'validation_error',
      details: {
        fields: [
          {
            path: 'mediaFileIds[0]',
            message:
              'Staged media file is not referenced by any CSV media column',
          },
        ],
      },
    });
    expect((await fileRow(exactId))?.isActive).toBe(true);

    // A filename is matched the same way inside an over-limit media cell.
    const crowdedId = await stageMedia(cookies.editor, 'café.png');
    const crowded: string[] = Array.from(
      { length: MAX_IMPORT_MEDIA_REFS_PER_ROW + 1 },
      () => randomUUID()
    );
    crowded[MAX_IMPORT_MEDIA_REFS_PER_ROW] = 'café.png';
    const overLimit = await postPreview(app, {
      cookie: cookies.editor,
      csvText: `name,photo\nCrowded Café,${crowded.join('|')}\n`,
      fields: { kind: 'places', ...declared([crowdedId]) },
    });
    expect(overLimit.status).toBe(201);
    const overLimitData = ImportManifestDetailResponseSchema.parse(
      await overLimit.json()
    ).data;
    expect(overLimitData.canCommit).toBe(false);
    expect(overLimitData.stagedMediaCount).toBe(0);
    expect((await fileRow(crowdedId))?.isActive).toBe(true);

    // An upload named before the sanitizer existed keeps its name as sent.
    // It is still found by that name, exactly as before.
    const legacyId = randomUUID();
    const legacyKey = `communities/${ids.ownCommunity}/media/${legacyId}`;
    const now = new Date('2026-06-15T12:00:00.000Z');
    await db.insert(tables.files).values({
      id: legacyId,
      filename: legacyId,
      originalName: 'café.png',
      path: legacyKey,
      storageKey: legacyKey,
      url: `/v2/media/${legacyId}`,
      mimeType: 'image/png',
      size: PNG_BYTES.byteLength,
      byteSize: PNG_BYTES.byteLength,
      checksum: sha256Hex(PNG_BYTES),
      communityId: ids.ownCommunity,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });
    const legacy = await postPreview(app, {
      cookie: cookies.admin,
      csvText: 'name,photo\nLegacy Name Place,café.png\n',
      fields: { kind: 'places', ...declared([legacyId]) },
    });
    expect(legacy.status).toBe(201);
    expect(
      ImportManifestDetailResponseSchema.parse(await legacy.json()).data
        .stagedMediaCount
    ).toBe(1);
    expect((await fileRow(legacyId))?.isActive).toBe(false);
  });

  it('rejects malformed mediaFileIds and duplicate filenames with a field error, rolling back any legacy multipart media', async () => {
    const picId = await stageMedia(cookies.editor, 'valid-pic.png');
    const twinA = await stageMedia(cookies.editor, 'twin.png');
    const twinB = await stageMedia(cookies.editor, 'twin.png');
    const before = await snapshotState();
    const legacyMedia = [
      { filename: 'legacy.png', contentType: 'image/png', bytes: PNG_BYTES },
    ];

    const invalid = [
      'not-json',
      JSON.stringify({ id: picId }),
      JSON.stringify(['not-a-uuid']),
      JSON.stringify([picId, picId]),
      JSON.stringify(
        Array.from({ length: MAX_IMPORT_MEDIA_FILES + 1 }, () => randomUUID())
      ),
    ];
    for (const value of invalid) {
      const res = await postPreview(app, {
        cookie: cookies.editor,
        csvText: `name,photo\nMalformed Place,${picId}\n`,
        fields: { kind: 'places', mediaFileIds: value },
        // Legacy multipart media sent alongside is rolled back, never kept.
        mediaParts: legacyMedia,
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        code: string;
        details: { fields: Array<{ path: string; message: string }> };
      };
      expect(body.code).toBe('validation_error');
      expect(body.details.fields).toEqual([
        { path: 'mediaFileIds', message: expect.any(String) },
      ]);
      expect(JSON.stringify(body)).not.toContain(picId);
    }

    const twins = await postPreview(app, {
      cookie: cookies.editor,
      csvText: 'name,photo\nTwin Place,twin.png\n',
      fields: { kind: 'places', ...declared([twinA, twinB]) },
    });
    expect(twins.status).toBe(400);
    expect(await twins.json()).toEqual({
      error: 'Validation failed',
      code: 'validation_error',
      details: {
        fields: [
          {
            path: 'mediaFileIds[1]',
            message: 'Duplicate staged media filename',
          },
        ],
      },
    });

    expect(await snapshotState()).toEqual(before);
  });

  it('rejects multipart media before storing a byte on the Workers runtime, while CSV-only and staged previews succeed', async () => {
    // The same storage serves both apps, so a spy on it sees every write.
    const mem = createListableMemoryStorage();
    for (const [key, entry] of memStore) mem.store.set(key, entry);
    const storage: FoundationStorage = {
      ...mem.storage,
      put: vi.fn(mem.storage.put),
    };
    const workersApp = createHonoApp({
      repository: new HonoFoundationRepository(db),
      storage,
      mediaCleanup: new MediaCleanupCoordinator(db, storage, {
        now: () => APP_NOW,
      }),
      publicOrigin: API_ORIGIN,
      corsOrigins: [CLIENT_ORIGIN],
      secureCookies: false,
      serverSecret: makeServerSecret(),
      now: () => APP_NOW,
      // The 1-import-per-day D1 cap is orthogonal here (an earlier test in
      // this file committed today) and is covered by the workerd run below.
      isWorkers: true,
      enforceD1Budget: false,
    });
    const put = vi.mocked(storage.put!);
    const legacyMedia = [
      { filename: 'legacy.png', contentType: 'image/png', bytes: PNG_BYTES },
    ];
    const manifestsBefore = (await snapshotState()).manifests.length;

    // After the CSV part ...
    put.mockClear();
    const afterCsv = await postPreview(workersApp, {
      cookie: cookies.editor,
      csvText: 'name,photo\nWorkers Legacy Place,legacy.png\n',
      fields: { kind: 'places' },
      mediaParts: legacyMedia,
    });
    expect(afterCsv.status).toBe(422);
    expect(await afterCsv.json()).toEqual({
      error: expect.stringContaining('mediaFileIds'),
      code: 'import_media_must_be_staged',
    });
    // ... and before it: no media byte is ever handed to storage.
    put.mockClear();
    const beforeCsv = await postPreview(workersApp, {
      cookie: cookies.editor,
      csvText: 'name,photo\nWorkers Legacy Place,legacy.png\n',
      fields: { kind: 'places' },
      mediaParts: legacyMedia,
      mediaFirst: true,
    });
    expect(beforeCsv.status).toBe(422);
    expect(await beforeCsv.json()).toEqual({
      error: expect.stringContaining('mediaFileIds'),
      code: 'import_media_must_be_staged',
    });
    expect(put).toHaveBeenCalledTimes(0);
    expect((await snapshotState()).manifests).toHaveLength(manifestsBefore);

    // A CSV-only preview is unaffected on Workers ...
    const csvOnly = await postPreview(workersApp, {
      cookie: cookies.editor,
      csvText: 'name\nWorkers Csv Place\n',
      fields: { kind: 'places' },
    });
    expect(csvOnly.status).toBe(201);

    // ... and staged media goes through without a multipart media part.
    const picId = await stageMedia(cookies.editor, 'workers-pic.png');
    const staged = await postPreview(workersApp, {
      cookie: cookies.editor,
      csvText: `name,photo\nWorkers Staged Place,${picId}\n`,
      fields: { kind: 'places', ...declared([picId]) },
    });
    expect(staged.status).toBe(201);
    expect(
      ImportManifestDetailResponseSchema.parse(await staged.json()).data
        .stagedMediaCount
    ).toBe(1);
    // Only the two source CSVs were written; never a media object.
    expect(put).toHaveBeenCalledTimes(2);
    for (const [key] of put.mock.calls) {
      expect(key).toContain('/imports/');
    }
  });
});

describe('POST /v2/imports/preview staged media on the D1 batch path (#282)', () => {
  async function setupD1App(hooks?: {
    onBeforeBatch?: (queries: string[]) => Promise<void>;
  }) {
    const d1 = createFakeD1(hooks);
    const now = new Date('2026-06-15T12:00:00.000Z');
    const d1Tables = tablesFor(d1.db);
    const seed = await argon2Seed(TEST_DERIVED_KEY);
    await d1.db.insert(d1Tables.communities).values({
      name: 'D1 Staged Import',
      slug: 'd1-staged-import',
      publicStories: false,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });
    await d1.db.insert(d1Tables.users).values({
      email: 'd1-staged-editor@example.test',
      username: 'd1_staged_editor',
      ...deriveUserIdentityColumns({
        email: 'd1-staged-editor@example.test',
        username: 'd1_staged_editor',
      }),
      firstName: 'D1',
      lastName: 'Staged',
      ...seed,
      role: 'editor',
      communityId: 1,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });
    const d1Mem = createListableMemoryStorage();
    const d1App = createHonoApp({
      repository: new HonoFoundationRepository(d1.db),
      storage: d1Mem.storage,
      mediaCleanup: new MediaCleanupCoordinator(d1.db, d1Mem.storage, {
        now: () => now,
      }),
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
        identifier: 'd1-staged-editor@example.test',
        communitySlug: 'd1-staged-import',
        derivedKey: TEST_DERIVED_KEY,
      }),
    });
    expect(loginRes.status).toBe(200);
    const cookie = (loginRes.headers.get('set-cookie') ?? '').split(';')[0]!;
    return { d1, d1Tables, d1Mem, d1App, cookie };
  }

  async function stageOnD1(d1App: App, cookie: string, filename: string) {
    const res = await rawUpload(d1App, cookie, filename);
    expect(res.status).toBe(201);
    return MediaUploadResponseSchema.parse(await res.json()).data.id;
  }

  it('holds every staged upload inside the bound-parameter limit and activates them on commit', async () => {
    // 73 ids crosses the 70-id adoption chunk boundary of the D1 batch.
    const count = 73;
    const { d1, d1Tables, d1Mem, d1App, cookie } = await setupD1App();
    try {
      const fileIds: string[] = [];
      for (let i = 0; i < count; i += 1) {
        fileIds.push(await stageOnD1(d1App, cookie, `bulk-${i}.png`));
      }
      const keysWithUploads = d1Mem.store.size;
      d1.boundParams.length = 0;

      const preview = await postPreview(d1App, {
        cookie,
        csvText:
          'name,photo\n' +
          fileIds.map((id, i) => `Bulk Place ${i},${id}\n`).join(''),
        fields: { kind: 'places', ...declared(fileIds) },
      });
      expect(preview.status).toBe(201);
      const data = ImportManifestDetailResponseSchema.parse(
        await preview.json()
      ).data;
      expect(data.stagedMediaCount).toBe(count);
      expect(Math.max(...d1.boundParams)).toBeLessThanOrEqual(100);
      // The preview added exactly one object: its source CSV.
      expect(d1Mem.store.size).toBe(keysWithUploads + 1);

      const heldRows = () =>
        d1.db
          .select({ id: d1Tables.files.id, isActive: d1Tables.files.isActive })
          .from(d1Tables.files)
          .where(inArray(d1Tables.files.id, fileIds));
      const held = await heldRows();
      expect(held).toHaveLength(count);
      expect(held.every((row) => Number(row.isActive) === 0)).toBe(true);

      const committed = await d1App.request(
        `${API_ORIGIN}/v2/imports/${data.id}/commit`,
        { method: 'POST', headers: { cookie, origin: CLIENT_ORIGIN } }
      );
      expect(committed.status).toBe(200);
      const activated = await heldRows();
      expect(activated).toHaveLength(count);
      expect(activated.every((row) => Number(row.isActive) === 1)).toBe(true);
    } finally {
      d1.sqlite.close();
    }
  });

  it('lets exactly one of two concurrent previews hold the same staged upload', async () => {
    let raceActive = false;
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { d1, d1Tables, d1Mem, d1App, cookie } = await setupD1App({
      onBeforeBatch: async () => {
        if (!raceActive) return;
        arrived += 1;
        if (arrived >= 2) {
          raceActive = false;
          release();
        } else {
          await gate;
        }
      },
    });
    try {
      const contestedId = await stageOnD1(d1App, cookie, 'contested-pic.png');
      const keysWithUpload = d1Mem.store.size;

      raceActive = true;
      const [raceA, raceB] = await Promise.all([
        postPreview(d1App, {
          cookie,
          csvFilename: 'race-a.csv',
          csvText: `name,photo\nRace Place A,${contestedId}\n`,
          fields: { kind: 'places', ...declared([contestedId]) },
        }),
        postPreview(d1App, {
          cookie,
          csvFilename: 'race-b.csv',
          csvText: `name,photo\nRace Place B,${contestedId}\n`,
          fields: { kind: 'places', ...declared([contestedId]) },
        }),
      ]);
      const statuses = [raceA.status, raceB.status].sort((a, b) => a - b);
      expect(statuses).toEqual([201, 404]);
      const loser = raceA.status === 404 ? raceA : raceB;
      expect(await loser.json()).toEqual(NOT_FOUND);

      const manifests = await d1.db
        .select({
          id: d1Tables.importManifests.id,
          status: d1Tables.importManifests.status,
        })
        .from(d1Tables.importManifests);
      expect(manifests).toHaveLength(1);
      expect(manifests[0]?.status).toBe('previewed');
      // The loser's source CSV was rolled back; the winner stored one object.
      expect(d1Mem.store.size).toBe(keysWithUpload + 1);
      const [contestedRow] = await d1.db
        .select({ isActive: d1Tables.files.isActive })
        .from(d1Tables.files)
        .where(eq(d1Tables.files.id, contestedId));
      expect(Number(contestedRow?.isActive)).toBe(0);
      // The loser left no source CSV row behind either: only the winner's.
      expect(await previewWrites({ d1, d1Tables })).toEqual({
        csvRows: [expect.anything()],
        manifests: [expect.anything()],
        audits: [expect.anything()],
      });
    } finally {
      release();
      d1.sqlite.close();
    }
  });

  /**
   * Rows only a persisted preview writes: its source CSV file row, its
   * manifest and its `import.preview` audit entry.
   */
  async function previewWrites(context: {
    d1: ReturnType<typeof createFakeD1>;
    d1Tables: ReturnType<typeof tablesFor>;
  }) {
    const { d1, d1Tables } = context;
    const csvRows = await d1.db
      .select({ id: d1Tables.files.id })
      .from(d1Tables.files)
      .where(like(d1Tables.files.path, 'communities/%/imports/%'));
    const manifests = await d1.db
      .select({ id: d1Tables.importManifests.id })
      .from(d1Tables.importManifests);
    const audits = await d1.db
      .select({ id: d1Tables.auditEntries.id })
      .from(d1Tables.auditEntries)
      .where(eq(d1Tables.auditEntries.action, 'import.preview'));
    return { csvRows, manifests, audits };
  }

  /** `is_active` per upload id: `1` is the uploader's staging upload, `0` held. */
  async function uploadStates(
    context: {
      d1: ReturnType<typeof createFakeD1>;
      d1Tables: ReturnType<typeof tablesFor>;
    },
    fileIds: string[]
  ) {
    const { d1, d1Tables } = context;
    const rows = await d1.db
      .select({ id: d1Tables.files.id, isActive: d1Tables.files.isActive })
      .from(d1Tables.files)
      .where(inArray(d1Tables.files.id, fileIds));
    return Object.fromEntries(
      rows.map((row) => [row.id, Number(row.isActive)])
    );
  }

  /**
   * Change the database after the service resolved the declared uploads and
   * before the preview's D1 batch runs. The change fires once, for the batch
   * that inserts the manifest, so requests made inside it never retrigger it.
   */
  async function setupD1AppWithBatchMutation() {
    let mutate: (() => Promise<void>) | undefined;
    const state = { mutated: false };
    const context = await setupD1App({
      onBeforeBatch: async (queries) => {
        const run = mutate;
        if (
          !run ||
          !queries.some((query) => query.includes('"import_manifests"'))
        ) {
          return;
        }
        mutate = undefined;
        state.mutated = true;
        await run();
      },
    });
    return {
      ...context,
      state,
      beforePreviewBatch: (mutation: () => Promise<void>) => {
        mutate = mutation;
      },
    };
  }

  // A D1 batch is one transaction, but a statement that matches no row is no
  // error: the batch still commits what ran before it. So a preview denied
  // after its reads must not have written anything either.

  it('writes nothing when a declared upload is attached after the preview resolved it', async () => {
    const context = await setupD1AppWithBatchMutation();
    const { d1, d1Tables, d1Mem, d1App, cookie, state, beforePreviewBatch } =
      context;
    try {
      const keptId = await stageOnD1(d1App, cookie, 'still-adoptable.png');
      const lostId = await stageOnD1(d1App, cookie, 'attached-later.png');
      const now = new Date('2026-06-15T12:00:00.000Z');
      const [owner] = await d1.db
        .insert(d1Tables.places)
        .values({
          name: 'Attachment Owner',
          communityId: 1,
          latitude: 1.5,
          longitude: 2.5,
          isRestricted: false,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: d1Tables.places.id });
      const keysWithUploads = d1Mem.store.size;

      beforePreviewBatch(async () => {
        const attach = await d1App.request(`${API_ORIGIN}/v2/attachments`, {
          method: 'POST',
          headers: {
            cookie,
            origin: CLIENT_ORIGIN,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            fileId: lostId,
            ownerType: 'place',
            ownerId: owner?.id,
            role: 'place_photo',
          }),
        });
        expect(attach.status).toBe(201);
      });

      const preview = await postPreview(d1App, {
        cookie,
        csvText: `name,photo\nKept Place,${keptId}\nLost Place,${lostId}\n`,
        fields: { kind: 'places', ...declared([keptId, lostId]) },
      });
      // One upload became unadoptable between the service's read and the
      // batch; the other is still exactly as adoptable as before.
      expect(state.mutated).toBe(true);
      expect(preview.status).toBe(404);
      expect(await preview.json()).toEqual(NOT_FOUND);
      expect(await uploadStates(context, [keptId, lostId])).toEqual({
        [keptId]: 1,
        [lostId]: 1,
      });
      expect(await previewWrites(context)).toEqual({
        csvRows: [],
        manifests: [],
        audits: [],
      });
      // The preview's source CSV bytes were not kept either.
      expect(d1Mem.store.size).toBe(keysWithUploads);
    } finally {
      d1.sqlite.close();
    }
  });

  // The other side of that race. The attach resolved the upload while it was
  // an active staging upload, and a preview held it before the attach's batch
  // ran. The relation and its success audit are two statements of one batch,
  // so each must refuse on its own.
  it('answers 404 and writes nothing for an attach whose upload a preview held after the attach resolved it', async () => {
    const race: {
      cookie: string;
      picId: string;
      armed: boolean;
      target?: App;
      preview?: Response;
    } = { cookie: '', picId: '', armed: false };
    const context = await setupD1App({
      onBeforeBatch: async (queries) => {
        if (
          !race.armed ||
          !race.target ||
          !queries.some((query) => query.includes('into "attachments"'))
        ) {
          return;
        }
        race.armed = false;
        race.preview = await postPreview(race.target, {
          cookie: race.cookie,
          csvText: `name,photo\nHeld First Place,${race.picId}\n`,
          fields: { kind: 'places', ...declared([race.picId]) },
        });
      },
    });
    const { d1, d1Tables, d1App, cookie } = context;
    race.cookie = cookie;
    race.target = d1App;
    try {
      race.picId = await stageOnD1(d1App, cookie, 'held-before-attach.png');
      const now = new Date('2026-06-15T12:00:00.000Z');
      const [owner] = await d1.db
        .insert(d1Tables.places)
        .values({
          name: 'Attachment Owner',
          communityId: 1,
          latitude: 1.5,
          longitude: 2.5,
          isRestricted: false,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: d1Tables.places.id });

      race.armed = true;
      const attach = await d1App.request(`${API_ORIGIN}/v2/attachments`, {
        method: 'POST',
        headers: {
          cookie,
          origin: CLIENT_ORIGIN,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          fileId: race.picId,
          ownerType: 'place',
          ownerId: owner?.id,
          role: 'place_photo',
        }),
      });
      expect(race.preview?.status).toBe(201);
      expect(attach.status).toBe(404);
      expect(await attach.json()).toEqual(NOT_FOUND);

      // Nothing was attached to the upload ...
      expect(
        await d1.db
          .select({ id: d1Tables.attachments.id })
          .from(d1Tables.attachments)
      ).toEqual([]);
      // ... which the preview alone holds ...
      expect(await uploadStates(context, [race.picId])).toEqual({
        [race.picId]: 0,
      });
      const manifests = await d1.db
        .select({
          status: d1Tables.importManifests.status,
          stagedFileIds: d1Tables.importManifests.stagedFileIds,
        })
        .from(d1Tables.importManifests);
      expect(manifests).toHaveLength(1);
      expect(manifests[0]?.status).toBe('previewed');
      const stagedIds: unknown = manifests[0]?.stagedFileIds;
      expect(
        typeof stagedIds === 'string' ? JSON.parse(stagedIds) : stagedIds
      ).toEqual([race.picId]);
      // ... and the attach left a denied audit entry, never a success one.
      const attachAudits = await d1.db
        .select({ outcome: d1Tables.auditEntries.outcome })
        .from(d1Tables.auditEntries)
        .where(
          and(
            eq(d1Tables.auditEntries.action, 'attachment.create'),
            like(d1Tables.auditEntries.resourceIds, `%${race.picId}%`)
          )
        );
      expect(attachAudits).toEqual([{ outcome: 'denied' }]);
    } finally {
      d1.sqlite.close();
    }
  });

  it('writes nothing when a declared upload is made inactive after the preview resolved it', async () => {
    const context = await setupD1AppWithBatchMutation();
    const { d1, d1Tables, d1Mem, d1App, cookie, state, beforePreviewBatch } =
      context;
    try {
      const keptId = await stageOnD1(d1App, cookie, 'kept-active.png');
      const lostId = await stageOnD1(d1App, cookie, 'made-inactive.png');
      const keysWithUploads = d1Mem.store.size;
      beforePreviewBatch(async () => {
        await d1.db
          .update(d1Tables.files)
          .set({ isActive: false })
          .where(eq(d1Tables.files.id, lostId));
      });

      const preview = await postPreview(d1App, {
        cookie,
        csvText: `name,photo\nKept Place,${keptId}\nLost Place,${lostId}\n`,
        fields: { kind: 'places', ...declared([keptId, lostId]) },
      });
      expect(state.mutated).toBe(true);
      // An upload that was already inactive is not taken for one the batch
      // holds: the preview is refused and the other upload is left alone.
      expect(preview.status).toBe(404);
      expect(await preview.json()).toEqual(NOT_FOUND);
      expect(await uploadStates(context, [keptId, lostId])).toEqual({
        [keptId]: 1,
        [lostId]: 0,
      });
      expect(await previewWrites(context)).toEqual({
        csvRows: [],
        manifests: [],
        audits: [],
      });
      expect(d1Mem.store.size).toBe(keysWithUploads);
    } finally {
      d1.sqlite.close();
    }
  });

  it('writes nothing when the caller loses the editor role after the preview resolved its uploads', async () => {
    const context = await setupD1AppWithBatchMutation();
    const { d1, d1Tables, d1Mem, d1App, cookie, state, beforePreviewBatch } =
      context;
    try {
      const firstId = await stageOnD1(d1App, cookie, 'demoted-first.png');
      const secondId = await stageOnD1(d1App, cookie, 'demoted-second.png');
      const keysWithUploads = d1Mem.store.size;
      beforePreviewBatch(async () => {
        await d1.db
          .update(d1Tables.users)
          .set({ role: 'viewer' })
          .where(eq(d1Tables.users.email, 'd1-staged-editor@example.test'));
      });

      const preview = await postPreview(d1App, {
        cookie,
        csvText: `name,photo\nFirst Place,${firstId}\nSecond Place,${secondId}\n`,
        fields: { kind: 'places', ...declared([firstId, secondId]) },
      });
      expect(state.mutated).toBe(true);
      expect(preview.status).toBe(403);
      expect(await preview.json()).toEqual({ error: 'Forbidden' });
      expect(await uploadStates(context, [firstId, secondId])).toEqual({
        [firstId]: 1,
        [secondId]: 1,
      });
      expect(await previewWrites(context)).toEqual({
        csvRows: [],
        manifests: [],
        audits: [],
      });
      expect(d1Mem.store.size).toBe(keysWithUploads);
    } finally {
      d1.sqlite.close();
    }
  });

  it('writes nothing when the open-preview cap is reached after the preview resolved its uploads', async () => {
    const context = await setupD1AppWithBatchMutation();
    const { d1, d1Tables, d1Mem, d1App, cookie, state, beforePreviewBatch } =
      context;
    try {
      const firstId = await stageOnD1(d1App, cookie, 'capped-first.png');
      const secondId = await stageOnD1(d1App, cookie, 'capped-second.png');
      const keysWithUploads = d1Mem.store.size;
      beforePreviewBatch(async () => {
        for (let i = 0; i < MAX_OPEN_IMPORT_PREVIEWS_PER_COMMUNITY; i += 1) {
          const filler = await postPreview(d1App, {
            cookie,
            csvFilename: `filler-${i}.csv`,
            csvText: `name\nFiller Place ${i}\n`,
            fields: { kind: 'places' },
          });
          expect(filler.status).toBe(201);
        }
      });

      const preview = await postPreview(d1App, {
        cookie,
        csvText: `name,photo\nFirst Place,${firstId}\nSecond Place,${secondId}\n`,
        fields: { kind: 'places', ...declared([firstId, secondId]) },
      });
      expect(state.mutated).toBe(true);
      expect(preview.status).toBe(429);
      expect(await uploadStates(context, [firstId, secondId])).toEqual({
        [firstId]: 1,
        [secondId]: 1,
      });
      // Exactly the previews that filled the cap were persisted.
      const writes = await previewWrites(context);
      expect(writes.csvRows).toHaveLength(
        MAX_OPEN_IMPORT_PREVIEWS_PER_COMMUNITY
      );
      expect(writes.manifests).toHaveLength(
        MAX_OPEN_IMPORT_PREVIEWS_PER_COMMUNITY
      );
      expect(writes.audits).toHaveLength(
        MAX_OPEN_IMPORT_PREVIEWS_PER_COMMUNITY
      );
      expect(d1Mem.store.size).toBe(
        keysWithUploads + MAX_OPEN_IMPORT_PREVIEWS_PER_COMMUNITY
      );
    } finally {
      d1.sqlite.close();
    }
  });
});

describe('POST /v2/imports/preview staged media on workerd D1/R2 (#282)', () => {
  it('stages media through raw POST /v2/media, previews by file id, commits, and never takes multipart media', async () => {
    const mf = startWorkerRuntime(
      await bundleWorkerModule(
        `import worker from './src/worker.js'; export default worker;`
      ),
      {
        ENVIRONMENT: 'test',
        AUTH_SERVER_SECRET: randomBytes(24).toString('hex'),
      }
    );
    try {
      const d1 = await mf.getD1Database('DB');
      const bucket = await mf.getR2Bucket('MEDIA');
      await applyD1Migrations(d1);
      const token = randomBytes(32).toString('hex');
      await d1.batch([
        d1.prepare(
          "INSERT INTO communities(id,name,slug,created_at,updated_at) VALUES(1,'Worker Import','worker-import',0,0)"
        ),
        d1.prepare(
          "INSERT INTO users(id,email,password_hash,first_name,last_name,role,community_id,created_at,updated_at) VALUES(1,'weditor@example.org','source-hash','Worker','Editor','editor',1,0,0)"
        ),
        d1
          .prepare(
            'INSERT INTO sessions(id,token_hash,user_id,expires_at) VALUES(?,?,1,?)'
          )
          .bind(
            randomUUID(),
            sha256Hex(new TextEncoder().encode(token)),
            Date.now() + 3_600_000
          ),
      ]);
      const cookie = `ts_session=${token}`;
      const post = (
        path: string,
        headers: Record<string, string>,
        body?: Uint8Array
      ) =>
        mf.dispatchFetch(`${WORKER_ORIGIN}${path}`, {
          method: 'POST',
          headers: { cookie, origin: WORKER_ORIGIN, ...headers },
          body,
        });
      const keys = async (prefix: string) =>
        (await bucket.list({ prefix })).objects
          .map((object) => object.key)
          .sort();

      // 1. Stage the media: R2 verifies the client digest outside Worker CPU.
      const staged = await post(
        '/v2/media?filename=worker-pic.png',
        {
          'content-type': 'image/png',
          'content-length': String(PNG_BYTES.byteLength),
          'x-content-sha256': sha256Hex(PNG_BYTES),
        },
        PNG_BYTES
      );
      expect(staged.status).toBe(201);
      const picId = MediaUploadResponseSchema.parse(await staged.json()).data
        .id;
      const mediaKey = `communities/1/media/${picId}`;
      expect(await keys('communities/1/media/')).toEqual([mediaKey]);
      const checksumRow = await d1
        .prepare('SELECT checksum FROM files WHERE id = ?')
        .bind(picId)
        .first<{ checksum: string | null }>();
      expect(checksumRow?.checksum).toBe(sha256Hex(PNG_BYTES));

      // 2. Multipart media is refused before any byte is stored.
      const legacy = buildPreviewForm({
        csvText: 'name,photo\nWorker Legacy Place,worker-pic.png\n',
        fields: { kind: 'places' },
        mediaParts: [
          {
            filename: 'worker-pic.png',
            contentType: 'image/png',
            bytes: PNG_BYTES,
          },
        ],
      });
      const legacyRes = await post(
        '/v2/imports/preview',
        { 'content-type': legacy.contentTypeHeader },
        legacy.bytes
      );
      expect(legacyRes.status).toBe(422);
      expect(await legacyRes.json()).toEqual({
        error: expect.stringContaining('mediaFileIds'),
        code: 'import_media_must_be_staged',
      });
      expect(await keys('communities/')).toEqual([mediaKey]);
      expect(
        await d1.prepare('SELECT COUNT(*) AS n FROM import_manifests').first<{
          n: number;
        }>()
      ).toEqual({ n: 0 });

      // 3. The preview carries only the CSV and the staged file id.
      const form = buildPreviewForm({
        csvText: `name,photo\nWorker Staged Place,${picId}\n`,
        fields: { kind: 'places', ...declared([picId]) },
      });
      const preview = await post(
        '/v2/imports/preview',
        { 'content-type': form.contentTypeHeader },
        form.bytes
      );
      expect(preview.status).toBe(201);
      const data = ImportManifestDetailResponseSchema.parse(
        await preview.json()
      ).data;
      expect(data.stagedMediaCount).toBe(1);
      expect(data.canCommit).toBe(true);
      expect(await keys('communities/1/media/')).toEqual([mediaKey]);
      expect(await keys('communities/1/imports/')).toHaveLength(1);
      // The held row is inactive and unreachable until commit.
      expect(
        await d1
          .prepare('SELECT is_active FROM files WHERE id = ?')
          .bind(picId)
          .first<{ is_active: number }>()
      ).toEqual({ is_active: 0 });
      expect(
        (
          await mf.dispatchFetch(`${WORKER_ORIGIN}/v2/media/${picId}`, {
            headers: { cookie },
          })
        ).status
      ).toBe(404);

      // 4. Commit activates the same row; the bytes were stored exactly once.
      const committed = await post(`/v2/imports/${data.id}/commit`, {});
      expect(committed.status).toBe(200);
      expect(
        await d1
          .prepare('SELECT is_active FROM files WHERE id = ?')
          .bind(picId)
          .first<{ is_active: number }>()
      ).toEqual({ is_active: 1 });
      const served = await mf.dispatchFetch(
        `${WORKER_ORIGIN}/v2/media/${picId}`,
        { headers: { cookie } }
      );
      expect(served.status).toBe(200);
      expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG_BYTES);
      expect(await keys('communities/1/media/')).toEqual([mediaKey]);
    } finally {
      await mf.dispose();
    }
  });
});
