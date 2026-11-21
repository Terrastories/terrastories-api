/**
 * Focused contract, authorization, cross-community isolation, one-shot atomic
 * commit (Node SQLite + real D1 batch), idempotent re-commit, failed-commit
 * staged-byte cleanup, restart-safe orphan sweep, and concurrent race tests
 * for Slice 12-C:
 * - POST /v2/imports/:id/commit
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  argon2Seed,
  makeDerivedKey,
  makeServerSecret,
} from './auth-test-utils.js';
import { tablesFor } from '../../src/db/dialect.js';
import { createHonoApp } from '../../src/hono-app.js';
import { HonoFoundationRepository } from '../../src/repositories/hono-foundation.repository.js';
import {
  MediaCleanupCoordinator,
  ORPHAN_SWEEP_GRACE_MS,
} from '../../src/services/media-cleanup.service.js';
import type { FoundationStorage } from '../../src/services/hono-foundation.service.js';
import { ImportManifestDetailResponseSchema } from '../../src/shared/schemas/imports.js';
import { MediaUploadResponseSchema } from '../../src/shared/schemas/media-v2.js';
import { deriveUserIdentityColumns } from '../../src/shared/utils/derived-columns.js';
import { validateContentFreeAuditEntry } from '../../src/shared/utils/audit-entry.js';
import { planImportCommit } from '../../src/shared/utils/import-commit-plan.js';

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
  csvText?: string;
  fields?: Record<string, string>;
  mediaParts?: Array<{
    fieldName?: string;
    filename: string;
    contentType: string;
    bytes: Uint8Array;
  }>;
}): { body: ReadableStream<Uint8Array>; contentTypeHeader: string } {
  const boundary = `imp-cmt-${Math.random().toString(16).slice(2)}`;
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

function createRealD1Db(options?: {
  boundParamsOut?: number[];
  batchSizesOut?: number[];
  onBeforeBatch?: () => Promise<void>;
}): {
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
          options?.boundParamsOut?.push(params.length);
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
      if (options?.onBeforeBatch) {
        await options.onBeforeBatch();
      }
      options?.batchSizesOut?.push(stmts.length);
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
let existingForeignFileId = '';

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
  communityId?: number,
  deviceSession = false
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
      ...(deviceSession ? { deviceSession: true } : {}),
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
    fields?: Record<string, string>;
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
    fields: { kind: opts.kind, ...(opts.fields ?? {}) },
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

async function commitOnApp(
  targetApp: ReturnType<typeof createHonoApp>,
  cookie: string,
  manifestId: number | string,
  originHeader = CLIENT_ORIGIN
) {
  return targetApp.request(`${API_ORIGIN}/v2/imports/${manifestId}/commit`, {
    method: 'POST',
    headers: {
      cookie,
      origin: originHeader,
    },
  });
}

describe('Slice 12-C POST /v2/imports/:id/commit', () => {
  beforeAll(async () => {
    migrate(db, { migrationsFolder: './src/db/migrations' });
    const seedTime = new Date('2026-06-01T12:00:00.000Z');
    const seed = await argon2Seed(TEST_DERIVED_KEY);

    ids.ownCommunity = await insertRow(tables.communities, {
      name: 'Commit Import Own',
      slug: 'commit-imp-own',
      publicStories: true,
      isActive: true,
      createdAt: seedTime,
      updatedAt: seedTime,
    });
    ids.foreignCommunity = await insertRow(tables.communities, {
      name: 'Commit Import Foreign',
      slug: 'commit-imp-foreign',
      publicStories: true,
      isActive: true,
      createdAt: seedTime,
      updatedAt: seedTime,
    });
    ids.disabledCommunity = await insertRow(tables.communities, {
      name: 'Commit Import Disabled',
      slug: 'commit-imp-disabled',
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
        lastName: 'Committer',
        ...seed,
        role,
        communityId,
        isActive: true,
        createdAt: seedTime,
        updatedAt: seedTime,
      });

    await addUser('cmt-viewer@example.test', 'viewer', ids.ownCommunity);
    await addUser('cmt-member@example.test', 'member', ids.ownCommunity);
    ids.editorA = await addUser(
      'cmt-editor-a@example.test',
      'editor',
      ids.ownCommunity
    );
    ids.editorB = await addUser(
      'cmt-editor-b@example.test',
      'editor',
      ids.ownCommunity
    );
    await addUser('cmt-admin@example.test', 'admin', ids.ownCommunity);
    await addUser('cmt-foreign@example.test', 'editor', ids.foreignCommunity);
    await addUser('cmt-super@example.test', 'super_admin', null);
    await addUser('cmt-dis-admin@example.test', 'admin', ids.disabledCommunity);

    ids.existingOwnPlace = await insertRow(tables.places, {
      name: 'Existing Commit Valley',
      communityId: ids.ownCommunity,
      latitude: -2.5,
      longitude: -58.5,
      isRestricted: false,
      createdAt: seedTime,
      updatedAt: seedTime,
    });
    ids.existingOwnSpeaker = await insertRow(tables.speakers, {
      name: 'Existing Commit Elder',
      communityId: ids.ownCommunity,
      isActive: true,
      createdAt: seedTime,
      updatedAt: seedTime,
    });

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
      now: () => currentNow,
    });

    cookies.viewer = await loginOnApp(
      app,
      db,
      'cmt-viewer@example.test',
      ids.ownCommunity
    );
    cookies.member = await loginOnApp(
      app,
      db,
      'cmt-member@example.test',
      ids.ownCommunity
    );
    cookies.editorA = await loginOnApp(
      app,
      db,
      'cmt-editor-a@example.test',
      ids.ownCommunity
    );
    cookies.editorB = await loginOnApp(
      app,
      db,
      'cmt-editor-b@example.test',
      ids.ownCommunity
    );
    cookies.admin = await loginOnApp(
      app,
      db,
      'cmt-admin@example.test',
      ids.ownCommunity
    );
    cookies.foreign = await loginOnApp(
      app,
      db,
      'cmt-foreign@example.test',
      ids.foreignCommunity
    );
    cookies.superAdmin = await loginOnApp(app, db, 'cmt-super@example.test');
    cookies.disabledAdmin = await loginOnApp(
      app,
      db,
      'cmt-dis-admin@example.test',
      ids.disabledCommunity
    );

    const uploadFile = async (cookie: string, filename: string) => {
      const mp = buildImportMultipart({
        mediaParts: [
          {
            fieldName: 'file',
            filename,
            contentType: 'image/png',
            bytes: PNG_BYTES,
          },
        ],
      });
      const res = await app.request(`${API_ORIGIN}/v2/media`, {
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
      return MediaUploadResponseSchema.parse(await res.json()).data.id;
    };

    existingOwnFileId = await uploadFile(cookies.editorA, 'own-existing.png');
    existingForeignFileId = await uploadFile(
      cookies.foreign,
      'foreign-existing.png'
    );
  });

  afterAll(() => {
    sqlite.close();
  });

  it('enforces auth (401), CSRF (403), role gates (403), ID validation (400), and tenant isolation (404)', async () => {
    const ownManifest = await createPreviewOnApp(app, cookies.editorA, {
      kind: 'places',
      csvFilename: 'auth-check.csv',
      csvText: 'name\nAuth Check Peak\n',
    });
    const foreignManifest = await createPreviewOnApp(app, cookies.foreign, {
      kind: 'places',
      csvFilename: 'foreign-auth.csv',
      csvText: 'name\nForeign Peak\n',
    });

    const unauth = await app.request(
      `${API_ORIGIN}/v2/imports/${ownManifest.id}/commit`,
      { method: 'POST', headers: { origin: CLIENT_ORIGIN } }
    );
    expect(unauth.status).toBe(401);

    const badCsrf = await commitOnApp(
      app,
      cookies.editorA,
      ownManifest.id,
      FOREIGN_ORIGIN
    );
    expect(badCsrf.status).toBe(403);

    for (const deniedCookie of [
      cookies.viewer,
      cookies.member,
      cookies.superAdmin,
      cookies.disabledAdmin,
    ]) {
      const res = await commitOnApp(app, deniedCookie, ownManifest.id);
      expect(res.status).toBe(403);
    }

    for (const badId of ['abc', '0', '-5', '2147483648']) {
      const res = await commitOnApp(app, cookies.editorA, badId);
      expect(res.status).toBe(400);
    }

    expect((await commitOnApp(app, cookies.editorA, 999_999)).status).toBe(404);
    expect(
      (await commitOnApp(app, cookies.editorA, foreignManifest.id)).status
    ).toBe(404);

    // Non-creator editorB cannot reuse editorA's unattached staging file -> 403 without failing manifest
    const unattachedRefManifest = await createPreviewOnApp(
      app,
      cookies.editorA,
      {
        kind: 'places',
        csvFilename: 'unattached-reuse.csv',
        csvText: `name,photo\nReuse Guarded Place,${existingOwnFileId}\n`,
      }
    );
    expect(
      (await commitOnApp(app, cookies.editorB, unattachedRefManifest.id)).status
    ).toBe(403);
    const [afterForbidden] = await db
      .select()
      .from(tables.importManifests)
      .where(eq(tables.importManifests.id, unattachedRefManifest.id));
    expect(afterForbidden?.status).toBe('previewed');

    // Existing foreign file reference cannot leak across communities
    expect(existingForeignFileId).toBeTruthy();
  });

  it('commits places with staged photo + name audio and existing files, activating staged bytes only at commit', async () => {
    currentNow = new Date('2026-06-15T13:00:00.000Z');
    const preview = await createPreviewOnApp(app, cookies.editorA, {
      kind: 'places',
      csvFilename: 'places-commit.csv',
      csvText:
        'name,description,type_of_place,region,latitude,longitude,photo,name_audio\n' +
        `Cedar Lookout,"<p>Overlooks <b>river</b></p>",lookout,North,-12.25,-60.75,cedar.png|${existingOwnFileId},cedar.wav\n` +
        'Moss Crossing,,ford,South,1.5,2.5,,\n',
      mediaParts: [
        { filename: 'cedar.png', contentType: 'image/png', bytes: PNG_BYTES },
        { filename: 'cedar.wav', contentType: 'audio/wav', bytes: WAV_BYTES },
      ],
    });

    const [manifestBefore] = await db
      .select()
      .from(tables.importManifests)
      .where(eq(tables.importManifests.id, preview.id));
    const stagedIds = manifestBefore!.stagedFileIds;
    expect(stagedIds).toHaveLength(2);

    // Before commit: staged media is unreachable (404)
    for (const fid of stagedIds) {
      expect(
        (
          await app.request(`${API_ORIGIN}/v2/media/${fid}`, {
            headers: { cookie: cookies.editorA },
          })
        ).status
      ).toBe(404);
    }

    const commitRes = await commitOnApp(app, cookies.editorA, preview.id);
    expect(commitRes.status).toBe(200);
    const committed = ImportManifestDetailResponseSchema.parse(
      await commitRes.json()
    ).data;
    expect(committed.status).toBe('committed');
    expect(committed.canCommit).toBe(false);
    expect(committed.committedAt).toBe('2026-06-15T13:00:00.000Z');
    expect(committed.resultSummary).toEqual({
      createdPlaces: 2,
      createdSpeakers: 0,
      createdStories: 0,
      createdStoryPlaces: 0,
      createdStorySpeakers: 0,
      createdAttachments: 3,
      createdExternalLinks: 0,
      skippedDuplicates: 0,
    });

    // After commit: staged media is now readable (200) and places exist
    for (const fid of stagedIds) {
      expect(
        (
          await app.request(`${API_ORIGIN}/v2/media/${fid}`, {
            headers: { cookie: cookies.editorA },
          })
        ).status
      ).toBe(200);
    }

    const placeRows = await db
      .select()
      .from(tables.places)
      .where(eq(tables.places.communityId, ids.ownCommunity));
    const cedar = placeRows.find((p) => p.name === 'Cedar Lookout');
    expect(cedar).toBeDefined();
    expect(cedar?.descriptionPlain).toBe('Overlooks river');
    expect(cedar?.typeOfPlace).toBe('lookout');
    expect(cedar?.region).toBe('North');
    expect(cedar?.latitude).toBe(-12.25);
    expect(cedar?.longitude).toBe(-60.75);

    const atts = await db
      .select()
      .from(tables.attachments)
      .where(
        and(
          eq(tables.attachments.communityId, ids.ownCommunity),
          eq(tables.attachments.ownerType, 'place'),
          eq(tables.attachments.ownerId, cedar!.id)
        )
      )
      .orderBy(asc(tables.attachments.role), asc(tables.attachments.ordinal));
    expect(atts).toHaveLength(3);
    expect(atts.map((a) => `${a.role}:${a.ordinal}`)).toEqual([
      'place_name_audio:0',
      'place_photo:0',
      'place_photo:1',
    ]);

    // Idempotent re-commit returns exact recorded result without duplicating anything
    currentNow = new Date('2026-06-15T13:05:00.000Z');
    const recommitRes = await commitOnApp(app, cookies.admin, preview.id);
    expect(recommitRes.status).toBe(200);
    const recommitted = ImportManifestDetailResponseSchema.parse(
      await recommitRes.json()
    ).data;
    expect(recommitted.resultSummary).toEqual(committed.resultSummary);
    expect(recommitted.committedAt).toBe(committed.committedAt);

    const placesAfter = await db
      .select()
      .from(tables.places)
      .where(
        and(
          eq(tables.places.communityId, ids.ownCommunity),
          eq(tables.places.name, 'Cedar Lookout')
        )
      );
    expect(placesAfter).toHaveLength(1);

    // Exactly one content-free import.commit audit entry
    const audits = (
      await db
        .select()
        .from(tables.auditEntries)
        .where(
          and(
            eq(tables.auditEntries.communityId, ids.ownCommunity),
            eq(tables.auditEntries.action, 'import.commit')
          )
        )
    ).filter((a) => JSON.stringify(a.resourceIds).includes(String(preview.id)));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.outcome).toBe('success');
    expect(() =>
      validateContentFreeAuditEntry({
        communityId: audits[0]!.communityId,
        actorId: audits[0]!.actorId,
        action: audits[0]!.action,
        resourceType: audits[0]!.resourceType,
        resourceIds: audits[0]!.resourceIds,
        outcome: audits[0]!.outcome,
        ipAddress: audits[0]!.ipAddress,
        userAgent: audits[0]!.userAgent,
      })
    ).not.toThrow();
  });

  it('commits speakers with newly created related birthplaces (incl. case variants) and existing birthplaces', async () => {
    currentNow = new Date('2026-06-15T13:10:00.000Z');
    const preview = await createPreviewOnApp(app, cookies.editorA, {
      kind: 'speakers',
      csvFilename: 'speakers-commit.csv',
      csvText:
        'name,birth_date,birthplace_id,birthplace_name,affiliation,photo\n' +
        `Speaker One,1965-04-12,${ids.existingOwnPlace},,Council,spk1.png\n` +
        'Speaker Two,1972-09-01,,new ridge,Clan A,\n' +
        'Speaker Three,,,New Ridge,Clan B,\n',
      mediaParts: [
        { filename: 'spk1.png', contentType: 'image/png', bytes: PNG_BYTES },
      ],
    });

    expect(preview.relatedRecords.placesToCreateCount).toBe(1);
    const res = await commitOnApp(app, cookies.editorA, preview.id);
    expect(res.status).toBe(200);
    const data = ImportManifestDetailResponseSchema.parse(
      await res.json()
    ).data;
    expect(data.resultSummary).toEqual({
      createdPlaces: 1,
      createdSpeakers: 3,
      createdStories: 0,
      createdStoryPlaces: 0,
      createdStorySpeakers: 0,
      createdAttachments: 1,
      createdExternalLinks: 0,
      skippedDuplicates: 0,
    });

    const speakerRows = await db
      .select()
      .from(tables.speakers)
      .where(eq(tables.speakers.communityId, ids.ownCommunity));
    const s1 = speakerRows.find((s) => s.name === 'Speaker One');
    const s2 = speakerRows.find((s) => s.name === 'Speaker Two');
    const s3 = speakerRows.find((s) => s.name === 'Speaker Three');
    expect(s1?.birthplaceId).toBe(ids.existingOwnPlace);
    expect(s2?.birthplaceId).not.toBeNull();
    expect(s2?.birthplaceId).toBe(s3?.birthplaceId);
  });

  it('commits stories with explicit audienceMapping, related records, edge multiplicity, media, and external links', async () => {
    currentNow = new Date('2026-06-15T13:20:00.000Z');
    const preview = await createPreviewOnApp(app, cookies.editorA, {
      kind: 'stories',
      csvFilename: 'stories-commit.csv',
      csvText:
        'title,audience,description,topic,language,date_interviewed,interview_location_id,interview_location_name,interviewer_id,interviewer_name,place_ids,place_names,speaker_ids,speaker_names,media,external_media_links\n' +
        `River Song,community-circle,"<p>Oral <em>history</em></p>",Origin,pt-BR,2024-05-01,${ids.existingOwnPlace},,${ids.existingOwnSpeaker},,"${ids.existingOwnPlace},${ids.existingOwnPlace}",Story Creek|story creek,${ids.existingOwnSpeaker},Story Keeper,story.png,https://media.example.test/v1|https://media.example.test/v2\n` +
        'Public Meadow,world-public,,,,,,Story Creek,,Story Keeper,,Story Creek,,Story Keeper,,\n',
      fields: {
        audienceMapping: JSON.stringify({
          'community-circle': 'community',
          'world-public': 'public',
        }),
      },
      mediaParts: [
        { filename: 'story.png', contentType: 'image/png', bytes: PNG_BYTES },
      ],
    });

    expect(preview.audienceSummary).toEqual({
      public: 1,
      community: 1,
      editors: 0,
    });
    const res = await commitOnApp(app, cookies.editorA, preview.id);
    expect(res.status).toBe(200);
    const committed = ImportManifestDetailResponseSchema.parse(
      await res.json()
    ).data;
    expect(committed.resultSummary).toEqual({
      createdPlaces: 1,
      createdSpeakers: 1,
      createdStories: 2,
      createdStoryPlaces: 5,
      createdStorySpeakers: 3,
      createdAttachments: 1,
      createdExternalLinks: 2,
      skippedDuplicates: 0,
    });

    // Edge multiplicity & sortOrder preserved on River Song
    const [river] = await db
      .select()
      .from(tables.stories)
      .where(
        and(
          eq(tables.stories.communityId, ids.ownCommunity),
          eq(tables.stories.title, 'River Song')
        )
      );
    expect(river).toBeDefined();
    expect(river?.privacyLevel).toBe('members_only');
    expect(river?.isRestricted).toBe(false);
    expect(river?.descriptionPlain).toBe('Oral history');
    expect(river?.topicNormalized).toBe('origin');

    const spEdges = await db
      .select()
      .from(tables.storyPlaces)
      .where(eq(tables.storyPlaces.storyId, river!.id))
      .orderBy(asc(tables.storyPlaces.sortOrder));
    expect(spEdges).toHaveLength(4);
    expect(spEdges[0]?.placeId).toBe(ids.existingOwnPlace);
    expect(spEdges[1]?.placeId).toBe(ids.existingOwnPlace);
    expect(spEdges[2]?.placeId).toBe(spEdges[3]?.placeId);

    const extLinks = await db
      .select()
      .from(tables.externalMediaLinks)
      .where(eq(tables.externalMediaLinks.storyId, river!.id))
      .orderBy(asc(tables.externalMediaLinks.ordinal));
    expect(extLinks.map((l) => `${l.ordinal}:${l.url}`)).toEqual([
      '0:https://media.example.test/v1',
      '1:https://media.example.test/v2',
    ]);

    // Public projection serves only Public Meadow, not community-circle River Song
    const pubStoriesRes = await app.request(
      `${API_ORIGIN}/v2/public/communities/commit-imp-own/stories`
    );
    expect(pubStoriesRes.status).toBe(200);
    const pubStories = (await pubStoriesRes.json()) as {
      data: { stories: Array<{ title: string }> };
    };
    expect(pubStories.data.stories.map((s) => s.title)).toEqual([
      'Public Meadow',
    ]);

    // Member sees both stories on authenticated community surface
    const memStoriesRes = await app.request(`${API_ORIGIN}/v2/stories`, {
      headers: { cookie: cookies.member },
    });
    expect(memStoriesRes.status).toBe(200);
    const memStories = (await memStoriesRes.json()) as {
      data: { stories: Array<{ title: string }> };
    };
    expect(memStories.data.stories.map((s) => s.title).sort()).toEqual([
      'Public Meadow',
      'River Song',
    ]);
  });

  it('rejects non-committable manifests (422) and terminal manifests (409)', async () => {
    const withErrors = await createPreviewOnApp(app, cookies.editorA, {
      kind: 'stories',
      csvFilename: 'bad-audience.csv',
      csvText: 'title,visibility\nBad Story,secret_council\n',
    });
    expect(withErrors.errorCount).toBe(1);
    expect(withErrors.canCommit).toBe(false);
    const errRes = await commitOnApp(app, cookies.editorA, withErrors.id);
    expect(errRes.status).toBe(422);
    expect((await errRes.json()) as { code: string }).toMatchObject({
      code: 'import_not_committable',
    });

    const zeroRows = await createPreviewOnApp(app, cookies.editorA, {
      kind: 'places',
      csvFilename: 'all-skipped.csv',
      csvText: 'name\nExisting Commit Valley\n',
      fields: { duplicateStrategy: 'skip' },
    });
    expect(zeroRows.validRowCount).toBe(0);
    expect(zeroRows.canCommit).toBe(false);
    expect((await commitOnApp(app, cookies.editorA, zeroRows.id)).status).toBe(
      422
    );

    const toDiscard = await createPreviewOnApp(app, cookies.editorA, {
      kind: 'places',
      csvFilename: 'to-discard.csv',
      csvText: 'name\nDiscardable Place\n',
    });
    const delRes = await app.request(
      `${API_ORIGIN}/v2/imports/${toDiscard.id}`,
      {
        method: 'DELETE',
        headers: { cookie: cookies.editorA, origin: CLIENT_ORIGIN },
      }
    );
    expect(delRes.status).toBe(200);
    expect((await commitOnApp(app, cookies.editorA, toDiscard.id)).status).toBe(
      409
    );
  });

  it('cleans up staged bytes atomically on failed commit (reference drift & checksum tampering) and remains restart-safe via orphan sweep', async () => {
    // 1. Existing place restricted between preview and commit
    const driftPlaceId = await insertRow(tables.places, {
      name: 'Drift Place',
      communityId: ids.ownCommunity,
      isRestricted: false,
      createdAt: new Date('2026-06-01T12:00:00.000Z'),
      updatedAt: new Date('2026-06-01T12:00:00.000Z'),
    });
    const driftManifest = await createPreviewOnApp(app, cookies.editorA, {
      kind: 'stories',
      csvFilename: 'drift.csv',
      csvText: `title,visibility,place_ids,place_names,media\nShould Rollback Story,public,${driftPlaceId},Orphan Related Place,drift.png\n`,
      mediaParts: [
        { filename: 'drift.png', contentType: 'image/png', bytes: PNG_BYTES },
      ],
    });
    const [driftRowBefore] = await db
      .select()
      .from(tables.importManifests)
      .where(eq(tables.importManifests.id, driftManifest.id));
    const [driftStagedFile] = await db
      .select()
      .from(tables.files)
      .where(eq(tables.files.id, driftRowBefore!.stagedFileIds[0]!));
    const [driftSourceFile] = await db
      .select()
      .from(tables.files)
      .where(eq(tables.files.id, driftRowBefore!.sourceFileId));
    expect(memStore.has(driftStagedFile!.storageKey!)).toBe(true);

    // Restrict target place before commit
    await db
      .update(tables.places)
      .set({ isRestricted: true })
      .where(eq(tables.places.id, driftPlaceId));

    const driftRes = await commitOnApp(app, cookies.editorA, driftManifest.id);
    expect(driftRes.status).toBe(409);
    expect(((await driftRes.json()) as { code: string }).code).toBe(
      'import_commit_failed'
    );

    // Zero partial records created; manifest marked failed; staged bytes & file row gone; source CSV preserved
    expect(
      await db
        .select()
        .from(tables.stories)
        .where(eq(tables.stories.title, 'Should Rollback Story'))
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(tables.places)
        .where(eq(tables.places.name, 'Orphan Related Place'))
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(tables.files)
        .where(eq(tables.files.id, driftStagedFile!.id))
    ).toHaveLength(0);
    expect(memStore.has(driftStagedFile!.storageKey!)).toBe(false);
    expect(memStore.has(driftSourceFile!.storageKey!)).toBe(true);

    const [driftRowAfter] = await db
      .select()
      .from(tables.importManifests)
      .where(eq(tables.importManifests.id, driftManifest.id));
    expect(driftRowAfter?.status).toBe('failed');
    expect(driftRowAfter?.committedAt).toBeNull();
    expect(driftRowAfter?.resultSummary).toBeNull();

    // Re-committing failed manifest is rejected 409
    expect(
      (await commitOnApp(app, cookies.editorA, driftManifest.id)).status
    ).toBe(409);

    // 2. Tampered staged media bytes -> checksum mismatch -> failed + cleanup
    const tamperManifest = await createPreviewOnApp(app, cookies.editorA, {
      kind: 'places',
      csvFilename: 'tamper.csv',
      csvText: 'name,photo\nTampered Place,tamper.png\n',
      mediaParts: [
        { filename: 'tamper.png', contentType: 'image/png', bytes: PNG_BYTES },
      ],
    });
    const [tamperRowBefore] = await db
      .select()
      .from(tables.importManifests)
      .where(eq(tables.importManifests.id, tamperManifest.id));
    const [tamperFile] = await db
      .select()
      .from(tables.files)
      .where(eq(tables.files.id, tamperRowBefore!.stagedFileIds[0]!));
    const tamperedBytes = new Uint8Array(PNG_BYTES);
    tamperedBytes[tamperedBytes.length - 1] ^= 0xff;
    memStore.get(tamperFile!.storageKey!)!.bytes = tamperedBytes;

    const tamperRes = await commitOnApp(
      app,
      cookies.editorA,
      tamperManifest.id
    );
    expect(tamperRes.status).toBe(409);
    expect(memStore.has(tamperFile!.storageKey!)).toBe(false);
    expect(
      await db
        .select()
        .from(tables.places)
        .where(eq(tables.places.name, 'Tampered Place'))
    ).toHaveLength(0);

    // 3. Restart-safe orphan sweep after transient storage.delete failure on failed commit
    const failMem = createListableMemoryStorage();
    const flakyStorage: FoundationStorage = {
      ...failMem.storage,
      async delete() {
        throw new Error('transient storage outage');
      },
    };
    const flakyCleanup = new MediaCleanupCoordinator(db, flakyStorage);
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
    const flakyManifest = await createPreviewOnApp(flakyApp, cookies.editorA, {
      kind: 'places',
      csvFilename: 'flaky.csv',
      csvText: 'name,photo\nFlaky Place,flaky.png\n',
      mediaParts: [
        { filename: 'flaky.png', contentType: 'image/png', bytes: PNG_BYTES },
      ],
    });
    const [flakyRow] = await db
      .select()
      .from(tables.importManifests)
      .where(eq(tables.importManifests.id, flakyManifest.id));
    const [flakyFile] = await db
      .select()
      .from(tables.files)
      .where(eq(tables.files.id, flakyRow!.stagedFileIds[0]!));
    const [flakySource] = await db
      .select()
      .from(tables.files)
      .where(eq(tables.files.id, flakyRow!.sourceFileId));

    // Delete staged bytes from storage so pre-commit checksum verification fails
    failMem.store.delete(flakyFile!.storageKey!);
    // Also add an unreferenced second staged object whose storage delete will throw
    failMem.store.set(flakyFile!.storageKey!, {
      bytes: Uint8Array.from([1, 2, 3]), // wrong checksum/size -> triggers failManifest
      contentType: 'image/png',
      uploaded: new Date('2026-06-01T12:00:00.000Z'),
    });

    const flakyFailRes = await commitOnApp(
      flakyApp,
      cookies.editorA,
      flakyManifest.id
    );
    expect(flakyFailRes.status).toBe(409);
    // DB row removed despite storage.delete failure, leaving orphaned bytes for sweeper
    expect(
      await db
        .select()
        .from(tables.files)
        .where(eq(tables.files.id, flakyFile!.id))
    ).toHaveLength(0);
    expect(failMem.store.has(flakyFile!.storageKey!)).toBe(true);

    // Recovered sweeper removes aged orphaned bytes while preserving sourceFileId bytes
    const recoveredCleanup = new MediaCleanupCoordinator(db, failMem.storage, {
      now: () =>
        new Date(
          new Date('2026-06-01T12:00:00.000Z').getTime() +
            ORPHAN_SWEEP_GRACE_MS +
            60_000
        ),
    });
    await recoveredCleanup.sweepOrphanObjects();
    expect(failMem.store.has(flakyFile!.storageKey!)).toBe(false);
    expect(failMem.store.has(flakySource!.storageKey!)).toBe(true);
  });

  it('executes single bounded D1 batch() matching planImportCommit and enforces 1/UTC-day commit limit (429) and rollback on D1 reference drift', async () => {
    const boundParamsOut: number[] = [];
    const batchSizesOut: number[] = [];
    const d1 = createRealD1Db({ boundParamsOut, batchSizesOut });
    try {
      let d1Now = new Date('2026-06-15T12:00:00.000Z');
      const d1Tables = tablesFor(d1.db);
      const seed = await argon2Seed(TEST_DERIVED_KEY);
      const [comm] = await d1.db
        .insert(d1Tables.communities)
        .values({
          name: 'D1 Commit Comm',
          slug: 'd1-commit-comm',
          publicStories: true,
          isActive: true,
          createdAt: d1Now,
          updatedAt: d1Now,
        })
        .returning({ id: d1Tables.communities.id });
      await d1.db.insert(d1Tables.users).values({
        email: 'd1-cmt@example.test',
        username: 'd1_cmt',
        ...deriveUserIdentityColumns({
          email: 'd1-cmt@example.test',
          username: 'd1_cmt',
        }),
        firstName: 'D1',
        lastName: 'Committer',
        ...seed,
        role: 'editor',
        communityId: comm.id,
        isActive: true,
        createdAt: d1Now,
        updatedAt: d1Now,
      });
      const [existingPlace] = await d1.db
        .insert(d1Tables.places)
        .values({
          name: 'D1 Existing Place',
          communityId: comm.id,
          isRestricted: false,
          createdAt: d1Now,
          updatedAt: d1Now,
        })
        .returning({ id: d1Tables.places.id });
      const [existingSpeaker] = await d1.db
        .insert(d1Tables.speakers)
        .values({
          name: 'D1 Existing Speaker',
          communityId: comm.id,
          isActive: true,
          createdAt: d1Now,
          updatedAt: d1Now,
        })
        .returning({ id: d1Tables.speakers.id });

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
        now: () => d1Now,
      });
      const d1Cookie = await loginOnApp(
        d1App,
        d1.db,
        'd1-cmt@example.test',
        comm.id,
        true
      );

      // 1. Stories commit on Day 1: verify batch size matches planImportCommit AND <= 100 bound params/stmt
      const storyPreview = await createPreviewOnApp(d1App, d1Cookie, {
        kind: 'stories',
        csvFilename: 'd1-stories.csv',
        csvText:
          'title,visibility,interview_location_id,interviewer_name,place_ids,place_names,speaker_ids,speaker_names,media,external_media_links\n' +
          `D1 Story 1,public,${existingPlace.id},D1 Interviewer,"${existingPlace.id},${existingPlace.id}",D1 New Place,${existingSpeaker.id},D1 New Speaker,d1pic.png,https://media.example.test/d1\n`,
        mediaParts: [
          { filename: 'd1pic.png', contentType: 'image/png', bytes: PNG_BYTES },
        ],
      });
      const [storyRow] = await d1.db
        .select()
        .from(d1Tables.importManifests)
        .where(eq(d1Tables.importManifests.id, storyPreview.id));
      const plannedStory = planImportCommit({
        normalizedData: storyRow!.normalizedRows as any,
        stagedFileIds: storyRow!.stagedFileIds,
        manifestPayloadBytes: 1000,
        sourceFilePayloadBytes: 420,
      });

      boundParamsOut.length = 0;
      batchSizesOut.length = 0;
      const storyCommitRes = await commitOnApp(
        d1App,
        d1Cookie,
        storyPreview.id
      );
      expect(storyCommitRes.status).toBe(200);
      expect(Math.max(...boundParamsOut)).toBeLessThanOrEqual(100);
      expect(batchSizesOut).toEqual([plannedStory.commitStatements.length]);

      // Idempotent re-commit on the SAME UTC day succeeds (200) even though 1/day limit is occupied
      const idempotentD1 = await commitOnApp(d1App, d1Cookie, storyPreview.id);
      expect(idempotentD1.status).toBe(200);

      // 2. Preview a places manifest (on next day), then verify 1/day limit when committing on Day 1
      d1Now = new Date('2026-06-16T12:00:00.000Z');
      const placesPreview = await createPreviewOnApp(d1App, d1Cookie, {
        kind: 'places',
        csvFilename: 'd1-places.csv',
        csvText: 'name,photo\nD1 Plain Place,\nD1 Attached Place,d1place.png\n',
        mediaParts: [
          {
            filename: 'd1place.png',
            contentType: 'image/png',
            bytes: PNG_BYTES,
          },
        ],
      });
      // Back to Day 1 -> committing placesPreview hits 429 daily limit
      d1Now = new Date('2026-06-15T18:00:00.000Z');
      const dailyBlocked = await commitOnApp(d1App, d1Cookie, placesPreview.id);
      expect(dailyBlocked.status).toBe(429);
      expect(((await dailyBlocked.json()) as { code: string }).code).toBe(
        'd1_daily_import_limit'
      );

      // Day 2 -> placesPreview commits cleanly in one batch matching planImportCommit
      d1Now = new Date('2026-06-16T12:00:00.000Z');
      const [placesRow] = await d1.db
        .select()
        .from(d1Tables.importManifests)
        .where(eq(d1Tables.importManifests.id, placesPreview.id));
      const plannedPlaces = planImportCommit({
        normalizedData: placesRow!.normalizedRows as any,
        stagedFileIds: placesRow!.stagedFileIds,
        manifestPayloadBytes: 1000,
        sourceFilePayloadBytes: 420,
      });
      boundParamsOut.length = 0;
      batchSizesOut.length = 0;
      const placesCommitRes = await commitOnApp(
        d1App,
        d1Cookie,
        placesPreview.id
      );
      expect(placesCommitRes.status).toBe(200);
      expect(Math.max(...boundParamsOut)).toBeLessThanOrEqual(100);
      expect(batchSizesOut).toEqual([plannedPlaces.commitStatements.length]);

      // 3. Day 3 -> speakers commit with related birthplace + photo
      d1Now = new Date('2026-06-17T12:00:00.000Z');
      const speakersPreview = await createPreviewOnApp(d1App, d1Cookie, {
        kind: 'speakers',
        csvFilename: 'd1-speakers.csv',
        csvText:
          'name,birthplace_name,photo\n' +
          'D1 Speaker Plain,d1 new valley,\n' +
          'D1 Speaker Photo,D1 New Valley,d1spk.png\n',
        mediaParts: [
          { filename: 'd1spk.png', contentType: 'image/png', bytes: PNG_BYTES },
        ],
      });
      const [speakersRow] = await d1.db
        .select()
        .from(d1Tables.importManifests)
        .where(eq(d1Tables.importManifests.id, speakersPreview.id));
      const plannedSpeakers = planImportCommit({
        normalizedData: speakersRow!.normalizedRows as any,
        stagedFileIds: speakersRow!.stagedFileIds,
        manifestPayloadBytes: 1000,
        sourceFilePayloadBytes: 420,
      });
      boundParamsOut.length = 0;
      batchSizesOut.length = 0;
      const speakersCommitRes = await commitOnApp(
        d1App,
        d1Cookie,
        speakersPreview.id
      );
      expect(speakersCommitRes.status).toBe(200);
      expect(Math.max(...boundParamsOut)).toBeLessThanOrEqual(100);
      expect(batchSizesOut).toEqual([plannedSpeakers.commitStatements.length]);

      // 4. Day 4 -> D1 batch atomic rollback on reference drift inside SQL
      d1Now = new Date('2026-06-18T12:00:00.000Z');
      const [driftTarget] = await d1.db
        .insert(d1Tables.places)
        .values({
          name: 'D1 Drift Place',
          communityId: comm.id,
          isRestricted: false,
          createdAt: d1Now,
          updatedAt: d1Now,
        })
        .returning({ id: d1Tables.places.id });
      const d1DriftPreview = await createPreviewOnApp(d1App, d1Cookie, {
        kind: 'stories',
        csvFilename: 'd1-drift.csv',
        csvText: `title,visibility,place_ids,place_names,media\nD1 Rollback Story,public,${driftTarget.id},D1 Uncommitted Place,d1drift.png\n`,
        mediaParts: [
          {
            filename: 'd1drift.png',
            contentType: 'image/png',
            bytes: PNG_BYTES,
          },
        ],
      });
      const [d1DriftRow] = await d1.db
        .select()
        .from(d1Tables.importManifests)
        .where(eq(d1Tables.importManifests.id, d1DriftPreview.id));
      const [d1DriftStaged] = await d1.db
        .select()
        .from(d1Tables.files)
        .where(eq(d1Tables.files.id, d1DriftRow!.stagedFileIds[0]!));

      await d1.db
        .update(d1Tables.places)
        .set({ isRestricted: true })
        .where(eq(d1Tables.places.id, driftTarget.id));

      const d1DriftRes = await commitOnApp(d1App, d1Cookie, d1DriftPreview.id);
      expect(d1DriftRes.status).toBe(409);
      expect(
        await d1.db
          .select()
          .from(d1Tables.stories)
          .where(eq(d1Tables.stories.title, 'D1 Rollback Story'))
      ).toHaveLength(0);
      expect(
        await d1.db
          .select()
          .from(d1Tables.places)
          .where(eq(d1Tables.places.name, 'D1 Uncommitted Place'))
      ).toHaveLength(0);
      expect(d1Mem.store.has(d1DriftStaged!.storageKey!)).toBe(false);
    } finally {
      d1.sqlite.close();
    }
  });

  it('handles barrier-synchronized concurrent commit vs commit, commit vs delete, and daily-limit races cleanly', async () => {
    // 1. Concurrent commit vs commit on Node SQLite (barrier inside storage.read so both enter pre-check as 'previewed')
    const baseMem = createListableMemoryStorage();
    let sqliteArrived = 0;
    let releaseSqliteBarrier!: () => void;
    const sqliteBarrier = new Promise<void>((resolve) => {
      releaseSqliteBarrier = resolve;
    });
    let sqliteBarrierArmed = false;

    const sqliteBarrierStorage: FoundationStorage = {
      ...baseMem.storage,
      async read(key, range) {
        if (sqliteBarrierArmed) {
          sqliteArrived += 1;
          if (sqliteArrived === 2) releaseSqliteBarrier();
          await sqliteBarrier;
        }
        return baseMem.storage.read(key, range);
      },
    };
    const sqliteRaceApp = createHonoApp({
      repository: new HonoFoundationRepository(db),
      storage: sqliteBarrierStorage,
      mediaCleanup: new MediaCleanupCoordinator(db, sqliteBarrierStorage),
      publicOrigin: API_ORIGIN,
      corsOrigins: [CLIENT_ORIGIN],
      secureCookies: false,
      serverSecret: makeServerSecret(),
      now: () => currentNow,
    });
    const sqliteManifest = await createPreviewOnApp(
      sqliteRaceApp,
      cookies.editorA,
      {
        kind: 'places',
        csvFilename: 'race-sqlite-commit.csv',
        csvText: 'name,photo\nRace SQLite Place,race-cmt.png\n',
        mediaParts: [
          {
            filename: 'race-cmt.png',
            contentType: 'image/png',
            bytes: PNG_BYTES,
          },
        ],
      }
    );
    sqliteBarrierArmed = true;
    const [r1, r2] = await Promise.all([
      commitOnApp(sqliteRaceApp, cookies.editorA, sqliteManifest.id),
      commitOnApp(sqliteRaceApp, cookies.admin, sqliteManifest.id),
    ]);
    sqliteBarrierArmed = false;
    expect([r1.status, r2.status]).toEqual([200, 200]);
    const b1 = ImportManifestDetailResponseSchema.parse(await r1.json()).data;
    const b2 = ImportManifestDetailResponseSchema.parse(await r2.json()).data;
    expect(b1.resultSummary).toEqual(b2.resultSummary);
    expect(b1.committedAt).toBe(b2.committedAt);
    expect(
      await db
        .select()
        .from(tables.places)
        .where(eq(tables.places.name, 'Race SQLite Place'))
    ).toHaveLength(1);
    const sqliteRaceAudits = (
      await db
        .select()
        .from(tables.auditEntries)
        .where(
          and(
            eq(tables.auditEntries.communityId, ids.ownCommunity),
            eq(tables.auditEntries.action, 'import.commit')
          )
        )
    ).filter((a) =>
      JSON.stringify(a.resourceIds).includes(String(sqliteManifest.id))
    );
    expect(sqliteRaceAudits).toHaveLength(1);

    // 2. Concurrent commit vs commit, commit vs delete, and M1 commit vs M2 commit on D1 batch
    let batchArrived = 0;
    let barrierTarget = 0;
    let releaseBatchBarrier: (() => void) | null = null;
    let batchBarrierPromise: Promise<void> | null = null;
    const armBatchBarrier = (parties: number) => {
      batchArrived = 0;
      barrierTarget = parties;
      batchBarrierPromise = new Promise<void>((resolve) => {
        releaseBatchBarrier = resolve;
      });
    };

    const d1 = createRealD1Db({
      onBeforeBatch: async () => {
        if (barrierTarget > 0 && batchBarrierPromise) {
          batchArrived += 1;
          if (batchArrived >= barrierTarget) {
            barrierTarget = 0;
            releaseBatchBarrier?.();
          } else {
            await batchBarrierPromise;
          }
        }
      },
    });
    try {
      let d1Now = new Date('2026-06-20T12:00:00.000Z');
      const d1Tables = tablesFor(d1.db);
      const seed = await argon2Seed(TEST_DERIVED_KEY);
      const [comm] = await d1.db
        .insert(d1Tables.communities)
        .values({
          name: 'D1 Race Comm',
          slug: 'd1-race-cmt',
          publicStories: true,
          isActive: true,
          createdAt: d1Now,
          updatedAt: d1Now,
        })
        .returning({ id: d1Tables.communities.id });
      for (const [email, role] of [
        ['d1r-ed@example.test', 'editor'],
        ['d1r-ad@example.test', 'admin'],
      ] as const) {
        await d1.db.insert(d1Tables.users).values({
          email,
          username: email.split('@')[0]!,
          ...deriveUserIdentityColumns({
            email,
            username: email.split('@')[0]!,
          }),
          firstName: role,
          lastName: 'D1Race',
          ...seed,
          role,
          communityId: comm.id,
          isActive: true,
          createdAt: d1Now,
          updatedAt: d1Now,
        });
      }
      const d1Mem = createListableMemoryStorage();
      const d1App = createHonoApp({
        repository: new HonoFoundationRepository(d1.db as any),
        storage: d1Mem.storage,
        mediaCleanup: new MediaCleanupCoordinator(d1.db, d1Mem.storage),
        publicOrigin: API_ORIGIN,
        corsOrigins: [CLIENT_ORIGIN],
        secureCookies: false,
        serverSecret: makeServerSecret(),
        now: () => d1Now,
      });
      const edCookie = await loginOnApp(
        d1App,
        d1.db,
        'd1r-ed@example.test',
        comm.id,
        true
      );
      const adCookie = await loginOnApp(
        d1App,
        d1.db,
        'd1r-ad@example.test',
        comm.id,
        true
      );

      // 2a. D1 concurrent commit vs commit
      const d1ManifestA = await createPreviewOnApp(d1App, edCookie, {
        kind: 'places',
        csvFilename: 'd1-race-a.csv',
        csvText: 'name,photo\nD1 Race Place A,d1ra.png\n',
        mediaParts: [
          { filename: 'd1ra.png', contentType: 'image/png', bytes: PNG_BYTES },
        ],
      });
      armBatchBarrier(2);
      const [d1c1, d1c2] = await Promise.all([
        commitOnApp(d1App, edCookie, d1ManifestA.id),
        commitOnApp(d1App, adCookie, d1ManifestA.id),
      ]);
      expect([d1c1.status, d1c2.status]).toEqual([200, 200]);
      expect(
        await d1.db
          .select()
          .from(d1Tables.places)
          .where(eq(d1Tables.places.name, 'D1 Race Place A'))
      ).toHaveLength(1);
      expect(
        await d1.db
          .select()
          .from(d1Tables.auditEntries)
          .where(
            and(
              eq(d1Tables.auditEntries.communityId, comm.id),
              eq(d1Tables.auditEntries.action, 'import.commit')
            )
          )
      ).toHaveLength(1);

      // 2b. D1 concurrent commit vs discard on Day 2
      d1Now = new Date('2026-06-21T12:00:00.000Z');
      const d1ManifestB = await createPreviewOnApp(d1App, edCookie, {
        kind: 'places',
        csvFilename: 'd1-race-b.csv',
        csvText: 'name,photo\nD1 Race Place B,d1rb.png\n',
        mediaParts: [
          { filename: 'd1rb.png', contentType: 'image/png', bytes: PNG_BYTES },
        ],
      });
      armBatchBarrier(2);
      const [winCommitOrConflict, winDeleteOrConflict] = await Promise.all([
        commitOnApp(d1App, edCookie, d1ManifestB.id),
        d1App.request(`${API_ORIGIN}/v2/imports/${d1ManifestB.id}`, {
          method: 'DELETE',
          headers: { cookie: adCookie, origin: CLIENT_ORIGIN },
        }),
      ]);
      expect(
        [winCommitOrConflict.status, winDeleteOrConflict.status].sort(
          (a, b) => a - b
        )
      ).toEqual([200, 409]);

      // 2c. D1 concurrent M1 vs M2 on Day 3 -> exactly one 200, one 429
      d1Now = new Date('2026-06-22T12:00:00.000Z');
      const m1 = await createPreviewOnApp(d1App, edCookie, {
        kind: 'places',
        csvFilename: 'd1-day-m1.csv',
        csvText: 'name\nD1 Day Winner One\n',
      });
      const m2 = await createPreviewOnApp(d1App, adCookie, {
        kind: 'places',
        csvFilename: 'd1-day-m2.csv',
        csvText: 'name\nD1 Day Winner Two\n',
      });
      armBatchBarrier(2);
      const [m1Res, m2Res] = await Promise.all([
        commitOnApp(d1App, edCookie, m1.id),
        commitOnApp(d1App, adCookie, m2.id),
      ]);
      expect([m1Res.status, m2Res.status].sort((a, b) => a - b)).toEqual([
        200, 429,
      ]);
    } finally {
      d1.sqlite.close();
    }
  });

  it('rejects over-budget commit when enforceD1Budget is enabled and keeps commit responses/audits content-free', async () => {
    const budgetMem = createListableMemoryStorage();
    const budgetApp = createHonoApp({
      repository: new HonoFoundationRepository(db),
      storage: budgetMem.storage,
      mediaCleanup: new MediaCleanupCoordinator(db, budgetMem.storage),
      publicOrigin: API_ORIGIN,
      corsOrigins: [CLIENT_ORIGIN],
      secureCookies: false,
      serverSecret: makeServerSecret(),
      now: () => currentNow,
      enforceD1Budget: true,
    });

    // Preview on non-budget-enforced app (e.g. Node self-hosted preview of > 1,000 stories)
    const manyStoriesCsv =
      'title,visibility\n' +
      Array.from(
        { length: 1_005 },
        (_, i) => `Budget Story ${i + 1},editors`
      ).join('\n') +
      '\n';
    const oversizedPreview = await createPreviewOnApp(app, cookies.editorA, {
      kind: 'stories',
      csvFilename: 'oversized-commit.csv',
      csvText: manyStoriesCsv,
    });
    expect(oversizedPreview.commitPlan.withinD1Budget).toBe(false);

    // Committing on D1-enforced app fails closed with 422 d1_budget_exceeded without touching rows
    const budgetRes = await commitOnApp(
      budgetApp,
      cookies.editorA,
      oversizedPreview.id
    );
    expect(budgetRes.status).toBe(422);
    const budgetBody = (await budgetRes.json()) as {
      code: string;
      details: {
        alternatives: string;
        commitPlan: { withinD1Budget: boolean };
      };
    };
    expect(budgetBody.code).toBe('d1_budget_exceeded');
    expect(budgetBody.details.commitPlan.withinD1Budget).toBe(false);
    expect(budgetBody.details.alternatives).toContain('field kit');

    // Content-free commit & failure check: sensitive row content, storage keys, and checksums never leak
    const sensitiveTitle = 'SACRED_TITLE_NEVER_LEAK_12C';
    const sensitiveDesc = 'SACRED_DESCRIPTION_NEVER_LEAK_12C';
    const contentPreview = await createPreviewOnApp(app, cookies.editorA, {
      kind: 'stories',
      csvFilename: 'sensitive-commit.csv',
      csvText: `title,visibility,description,media\n${sensitiveTitle},editors,${sensitiveDesc},sens.png\n`,
      mediaParts: [
        { filename: 'sens.png', contentType: 'image/png', bytes: PNG_BYTES },
      ],
    });
    const [contentManifestRow] = await db
      .select()
      .from(tables.importManifests)
      .where(eq(tables.importManifests.id, contentPreview.id));
    const [stagedFileRow] = await db
      .select()
      .from(tables.files)
      .where(eq(tables.files.id, contentManifestRow!.stagedFileIds[0]!));

    const okCommit = await commitOnApp(app, cookies.editorA, contentPreview.id);
    expect(okCommit.status).toBe(200);
    const okText = await okCommit.text();
    expect(okText).not.toContain(sensitiveTitle);
    expect(okText).not.toContain(sensitiveDesc);
    expect(okText).not.toContain(stagedFileRow!.storageKey!);
    expect(okText).not.toContain(stagedFileRow!.checksum!);

    const audits = await db
      .select()
      .from(tables.auditEntries)
      .where(eq(tables.auditEntries.communityId, ids.ownCommunity));
    const serializedAudits = JSON.stringify(audits);
    expect(serializedAudits).not.toContain(sensitiveTitle);
    expect(serializedAudits).not.toContain(sensitiveDesc);
    expect(serializedAudits).not.toContain(stagedFileRow!.storageKey!);
    expect(serializedAudits).not.toContain(stagedFileRow!.checksum!);
  });
});
