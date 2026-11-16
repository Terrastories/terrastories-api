/**
 * Focused §6.7 Attachment create/reorder/delete, null-community tenant check,
 * owner-delete byte cleanup, and D1 batch-bound tests for Slice 9 (#140).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { and, asc, eq } from 'drizzle-orm';
import {
  argon2Seed,
  makeDerivedKey,
  makeServerSecret,
} from './auth-test-utils.js';
import { tablesFor } from '../../src/db/dialect.js';
import { createHonoApp } from '../../src/hono-app.js';
import { HonoFoundationRepository } from '../../src/repositories/hono-foundation.repository.js';
import { MediaWritesRepository } from '../../src/repositories/media-writes.repository.js';
import { StoryWritesRepository } from '../../src/repositories/story-writes.repository.js';
import { CommunityWritesRepository } from '../../src/repositories/community-writes.repository.js';
import {
  MediaCleanupCoordinator,
  type FileByteCleanup,
} from '../../src/services/media-cleanup.service.js';
import type { FoundationStorage } from '../../src/services/hono-foundation.service.js';
import {
  AttachmentListResponseSchema,
  AttachmentResponseSchema,
  MediaUploadResponseSchema,
} from '../../src/shared/schemas/media-v2.js';
import { deriveUserIdentityColumns } from '../../src/shared/utils/derived-columns.js';
import { validateContentFreeAuditEntry } from '../../src/shared/utils/audit-entry.js';

const sqlite = new Sqlite(':memory:');
sqlite.pragma('foreign_keys = ON');
const db = drizzle(sqlite);
const tables = tablesFor(db);

const TEST_DERIVED_KEY = makeDerivedKey();
const API_ORIGIN = 'https://api.example.test';
const CLIENT_ORIGIN = 'https://app.example.test';

const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06,
  0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
]);

function createMemoryStorage(): {
  store: Map<string, { bytes: Uint8Array; contentType?: string }>;
  storage: FoundationStorage;
} {
  const store = new Map<string, { bytes: Uint8Array; contentType?: string }>();
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
      store.set(storageKey, { bytes: merged, contentType: opts.contentType });
    },
    async delete(storageKey) {
      store.delete(storageKey);
    },
  };
  return { store, storage };
}

function buildMultipartBody(options: {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}): { body: ReadableStream<Uint8Array>; contentTypeHeader: string } {
  const boundary = `bound-${Math.random().toString(16).slice(2)}`;
  const enc = new TextEncoder();
  const head = enc.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${options.filename}"\r\nContent-Type: ${options.contentType}\r\n\r\n`
  );
  const tail = enc.encode(`\r\n--${boundary}--\r\n`);
  const total = head.byteLength + options.bytes.byteLength + tail.byteLength;
  const combined = new Uint8Array(total);
  combined.set(head, 0);
  combined.set(options.bytes, head.byteLength);
  combined.set(tail, head.byteLength + options.bytes.byteLength);
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

let app: ReturnType<typeof createHonoApp>;
let cleanup: MediaCleanupCoordinator;
let memStore: Map<string, { bytes: Uint8Array; contentType?: string }>;
const ids: Record<string, number> = {};
const cookies: Record<string, string> = {};

async function insertRow(table: any, values: any): Promise<number> {
  const [inserted] = await db
    .insert(table)
    .values(values)
    .returning({ id: table.id });
  return inserted.id as number;
}

async function loginAs(email: string): Promise<string> {
  const res = await app.request(`${API_ORIGIN}/v2/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      identifier: email,
      derivedKey: TEST_DERIVED_KEY,
    }),
  });
  expect(res.status).toBe(200);
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

async function upload(opts: {
  cookie: string;
  filename?: string;
  contentType?: string;
  bytes?: Uint8Array;
}) {
  const mp = buildMultipartBody({
    filename: opts.filename ?? 'photo.png',
    contentType: opts.contentType ?? 'image/png',
    bytes: opts.bytes ?? PNG_BYTES,
  });
  const res = await app.request(`${API_ORIGIN}/v2/media`, {
    method: 'POST',
    headers: {
      cookie: opts.cookie,
      origin: CLIENT_ORIGIN,
      'content-type': mp.contentTypeHeader,
    },
    body: mp.body,
    duplex: 'half',
  } as RequestInit);
  return {
    res,
    fileId:
      res.status === 201
        ? MediaUploadResponseSchema.parse(await res.clone().json()).data.id
        : null,
  };
}

async function attach(
  cookie: string,
  body: Record<string, unknown>
): Promise<Response> {
  return app.request(`${API_ORIGIN}/v2/attachments`, {
    method: 'POST',
    headers: {
      cookie,
      origin: CLIENT_ORIGIN,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

/**
 * A D1-shaped drizzle client over better-sqlite3: `batch()` runs every
 * statement in one SQLite transaction and records their SQL/params, so a test
 * can assert exactly what a Workers D1 batch would execute.
 */
type D1BatchDb = ReturnType<typeof drizzle> & {
  batch: (
    stmts: Array<{ toSQL: () => { sql: string; params: unknown[] } }>
  ) => Promise<unknown[]>;
};

function createD1BatchDb(): {
  db: D1BatchDb;
  sqlite: Sqlite.Database;
  batchCalls: Array<Array<{ sql: string; params: unknown[] }>>;
} {
  const sqlite = new Sqlite(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const base = drizzle(sqlite);
  const batchCalls: Array<Array<{ sql: string; params: unknown[] }>> = [];
  const d1Like = Object.create(base) as D1BatchDb;
  d1Like.batch = async (stmts) => {
    const queries = stmts.map((s) => s.toSQL());
    batchCalls.push(queries);
    return sqlite.transaction(() =>
      queries.map(({ sql, params }) => {
        const stmt = sqlite.prepare(sql);
        return stmt.reader ? stmt.all(...params) : stmt.run(...params);
      })
    )();
  };
  return { db: d1Like, sqlite, batchCalls };
}

/**
 * A D1Database-shaped client over better-sqlite3, driven through the real
 * drizzle-orm/d1 driver. The better-sqlite3-shaped batch mock above cannot
 * express everything the hosted Workers D1 accepts (e.g. it tolerates SQL the
 * D1 driver rejects), so D1-specific bugs need this harness.
 */
function createRealD1Db(
  hooks: {
    /** Invoked inside the D1 batch, before any statement executes. */
    beforeBatch?: () => void | Promise<void>;
  } = {}
): {
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
      if (hooks.beforeBatch) await hooks.beforeBatch();
      return d1Sqlite.transaction(() => stmts.map((s) => s._exec()))();
    },
  };
  return { db: drizzleD1(client as unknown as D1Database), sqlite: d1Sqlite };
}

/** Seed one community, editor, and public story for D1-batch delete tests. */
async function seedD1MediaFixture(
  db: D1BatchDb,
  now: Date
): Promise<{
  communityId: number;
  actorId: number;
  email: string;
  storyId: number;
}> {
  const seedTables = tablesFor(db);
  const [comm] = await db
    .insert(seedTables.communities)
    .values({
      name: 'D1 Media Comm',
      slug: `d1-media-${crypto.randomUUID()}`,
      publicStories: true,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  const email = `d1-media-${crypto.randomUUID()}@example.test`;
  const derived = deriveUserIdentityColumns({
    email,
    firstName: 'D1',
    lastName: 'Media',
    communityId: comm!.id,
  });
  const [actor] = await db
    .insert(seedTables.users)
    .values({
      email,
      emailNormalized: derived.emailNormalized,
      ...(await argon2Seed(TEST_DERIVED_KEY)),
      firstName: 'D1',
      lastName: 'Media',
      displayNameNormalized: derived.displayNameNormalized,
      role: 'editor',
      communityId: comm!.id,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  const [story] = await db
    .insert(seedTables.stories)
    .values({
      title: 'D1 Media Story',
      slug: `d1-media-story-${crypto.randomUUID()}`,
      privacyLevel: 'public',
      isRestricted: false,
      communityId: comm!.id,
      createdBy: actor!.id,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return {
    communityId: comm!.id,
    actorId: actor!.id,
    email,
    storyId: story!.id,
  };
}

describe('Slice 9 attachments, byte cleanup, and D1 bounds (#140)', () => {
  beforeAll(async () => {
    migrate(db, { migrationsFolder: './src/db/migrations' });
    const now = new Date('2026-06-01T12:00:00.000Z');
    const seed = await argon2Seed(TEST_DERIVED_KEY);

    ids.community = await insertRow(tables.communities, {
      name: 'Attach Nation',
      slug: 'attach-nation',
      publicStories: true,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });
    ids.otherCommunity = await insertRow(tables.communities, {
      name: 'Other Attach',
      slug: 'other-attach',
      publicStories: true,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });

    const mkUser = async (
      email: string,
      role: string,
      communityId: number | null
    ) => {
      const derived = deriveUserIdentityColumns({
        email,
        firstName: 'QA',
        lastName: role,
        communityId,
      });
      return insertRow(tables.users, {
        email,
        emailNormalized: derived.emailNormalized,
        ...seed,
        firstName: 'QA',
        lastName: role,
        displayNameNormalized: derived.displayNameNormalized,
        role,
        communityId,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      });
    };

    ids.viewer = await mkUser('viewer@attach.test', 'viewer', ids.community);
    ids.member = await mkUser('member@attach.test', 'member', ids.community);
    ids.editor = await mkUser('editor@attach.test', 'editor', ids.community);
    ids.admin = await mkUser('admin@attach.test', 'admin', ids.community);
    ids.otherAdmin = await mkUser(
      'other@attach.test',
      'admin',
      ids.otherCommunity
    );
    ids.superAdmin = await mkUser('sa@system.test', 'super_admin', null);

    const mem = createMemoryStorage();
    memStore = mem.store;
    cleanup = new MediaCleanupCoordinator(db, mem.storage);

    app = createHonoApp({
      repository: new HonoFoundationRepository(db),
      serverSecret: makeServerSecret(),
      secureCookies: false,
      publicOrigin: API_ORIGIN,
      corsOrigins: [CLIENT_ORIGIN],
      storage: mem.storage,
      mediaCleanup: cleanup,
    });

    cookies.viewer = await loginAs('viewer@attach.test');
    cookies.member = await loginAs('member@attach.test');
    cookies.editor = await loginAs('editor@attach.test');
    cookies.admin = await loginAs('admin@attach.test');
    cookies.otherAdmin = await loginAs('other@attach.test');
    cookies.superAdmin = await loginAs('sa@system.test');
  });

  afterAll(() => {
    sqlite.close();
  });

  it('creates, reorders, and deletes typed attachments with deterministic ordinals', async () => {
    const storyId = await insertRow(tables.stories, {
      title: 'Attach Story',
      slug: 'attach-story',
      privacyLevel: 'public',
      isRestricted: false,
      communityId: ids.community,
      createdBy: ids.editor,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const first = await upload({ cookie: cookies.editor });
    expect(first.res.status).toBe(201);
    const firstId = first.fileId!;
    const second = await upload({ cookie: cookies.editor });
    expect(second.res.status).toBe(201);
    const secondId = second.fileId!;

    const a1 = await attach(cookies.editor, {
      fileId: firstId,
      ownerType: 'story',
      ownerId: storyId,
      role: 'story_media',
    });
    expect(a1.status).toBe(201);
    const att1 = AttachmentResponseSchema.parse(await a1.json()).data;
    expect(att1.ordinal).toBe(0);

    const a2 = await attach(cookies.editor, {
      fileId: secondId,
      ownerType: 'story',
      ownerId: storyId,
      role: 'story_media',
    });
    expect(a2.status).toBe(201);
    const att2 = AttachmentResponseSchema.parse(await a2.json()).data;
    expect(att2.ordinal).toBe(1);

    const reorder = await app.request(`${API_ORIGIN}/v2/attachments/reorder`, {
      method: 'PATCH',
      headers: {
        cookie: cookies.editor,
        origin: CLIENT_ORIGIN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        ownerType: 'story',
        ownerId: storyId,
        role: 'story_media',
        attachmentIds: [att2.id, att1.id],
      }),
    });
    expect(reorder.status).toBe(200);
    const reordered = AttachmentListResponseSchema.parse(await reorder.json());
    expect(reordered.data.map((row) => row.id)).toEqual([att2.id, att1.id]);
    expect(reordered.data.map((row) => row.ordinal)).toEqual([0, 1]);

    const del = await app.request(`${API_ORIGIN}/v2/attachments/${att1.id}`, {
      method: 'DELETE',
      headers: { cookie: cookies.editor, origin: CLIENT_ORIGIN },
    });
    expect(del.status).toBe(204);

    // Deleting the last relation of the first file removes its files row and
    // bytes in the same transaction; the second file stays attached.
    const [firstRow] = await db
      .select()
      .from(tables.files)
      .where(eq(tables.files.id, firstId));
    expect(firstRow).toBeUndefined();
    // The first file's bytes are gone from storage.
    const firstKey = `communities/${ids.community}/media/${firstId}`;
    expect(memStore.has(firstKey)).toBe(false);
    // The remaining relation keeps the second file referenced.
    const [secondRow] = await db
      .select()
      .from(tables.files)
      .where(eq(tables.files.id, secondId));
    expect(secondRow).toBeDefined();
    expect(memStore.has(secondRow!.storageKey!)).toBe(true);

    // Deleting the last relation of the second file now removes its row+bytes.
    const delLast = await app.request(
      `${API_ORIGIN}/v2/attachments/${att2.id}`,
      {
        method: 'DELETE',
        headers: { cookie: cookies.editor, origin: CLIENT_ORIGIN },
      }
    );
    expect(delLast.status).toBe(204);
    const [secondRowAfter] = await db
      .select()
      .from(tables.files)
      .where(eq(tables.files.id, secondId));
    expect(secondRowAfter).toBeUndefined();
    const secondKey = `communities/${ids.community}/media/${secondId}`;
    expect(memStore.has(secondKey)).toBe(false);
  });

  it('enforces the §6.7 null-community check and the owner/role matrix', async () => {
    // super_admin own null-community user_photo upload (role field required).
    const ownRes = await app.request(`${API_ORIGIN}/v2/media`, {
      method: 'POST',
      headers: {
        cookie: cookies.superAdmin,
        origin: CLIENT_ORIGIN,
        // role field is required for super_admin; boundary matches below.
        'content-type': 'multipart/form-data; boundary=bound-super',
      },
      body: (() => {
        const boundary = 'bound-super';
        const enc = new TextEncoder();
        const head = enc.encode(
          `--${boundary}\r\nContent-Disposition: form-data; name="role"\r\n\r\nuser_photo\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="me.png"\r\nContent-Type: image/png\r\n\r\n`
        );
        const tail = enc.encode(`\r\n--${boundary}--\r\n`);
        const all = new Uint8Array(
          head.byteLength + PNG_BYTES.byteLength + tail.byteLength
        );
        all.set(head, 0);
        all.set(PNG_BYTES, head.byteLength);
        all.set(tail, head.byteLength + PNG_BYTES.byteLength);
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(all);
            controller.close();
          },
        });
      })(),
      duplex: 'half',
    } as RequestInit);
    expect(ownRes.status).toBe(201);
    const ownPhotoId = MediaUploadResponseSchema.parse(await ownRes.json()).data
      .id;

    // A community-owned file is never attachable to a null-community owner.
    const communityFile = await upload({ cookie: cookies.editor });
    const communityFileId = communityFile.fileId!;
    const nullAttach = await attach(cookies.superAdmin, {
      fileId: communityFileId,
      ownerType: 'user',
      ownerId: ids.superAdmin,
      role: 'user_photo',
    });
    expect(nullAttach.status).toBe(404);

    // The null-community file is not visible to a community editor's owner.
    const storyId = await insertRow(tables.stories, {
      title: 'Null Check Story',
      slug: 'null-check-story',
      privacyLevel: 'public',
      isRestricted: false,
      communityId: ids.community,
      createdBy: ids.editor,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const crossTenant = await attach(cookies.editor, {
      fileId: ownPhotoId,
      ownerType: 'story',
      ownerId: storyId,
      role: 'story_media',
    });
    expect(crossTenant.status).toBe(404);

    // Owner/role matrix.
    expect(
      (
        await attach(cookies.viewer, {
          fileId: communityFileId,
          ownerType: 'story',
          ownerId: storyId,
          role: 'story_media',
        })
      ).status
    ).toBe(403);
    expect(
      (
        await attach(cookies.editor, {
          fileId: communityFileId,
          ownerType: 'user',
          ownerId: ids.member,
          role: 'user_photo',
        })
      ).status
    ).toBe(403);
    // §6.7 staging: an admin may attach its own staging upload to a member's
    // user_photo. Reusing another uploader's staging bytes stays a 404
    // (covered in the reuse test below).
    const adminFile = await upload({ cookie: cookies.admin });
    const adminUserPhoto = await attach(cookies.admin, {
      fileId: adminFile.fileId!,
      ownerType: 'user',
      ownerId: ids.member,
      role: 'user_photo',
    });
    expect(adminUserPhoto.status).toBe(201);
    expect(
      (
        await attach(cookies.editor, {
          fileId: communityFileId,
          ownerType: 'community',
          ownerId: ids.community,
          role: 'community_display_image',
        })
      ).status
    ).toBe(403);
  });

  it('answers 403 (not 404) for a disabled community', async () => {
    // Dedicated community: sessions are revoked when a community is
    // disabled, so toggling the shared fixture would invalidate the other
    // tests' cookies.
    const now = new Date();
    const disabledCommId = await insertRow(tables.communities, {
      name: 'Disabled Attach Nation',
      slug: 'disabled-attach-nation',
      publicStories: true,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });
    const derived = deriveUserIdentityColumns({
      email: 'admin@disabled-attach.test',
      firstName: 'QA',
      lastName: 'Disabled',
      communityId: disabledCommId,
    });
    await insertRow(tables.users, {
      email: 'admin@disabled-attach.test',
      emailNormalized: derived.emailNormalized,
      ...(await argon2Seed(TEST_DERIVED_KEY)),
      firstName: 'QA',
      lastName: 'Disabled',
      displayNameNormalized: derived.displayNameNormalized,
      role: 'admin',
      communityId: disabledCommId,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });
    const activeCookie = await loginAs('admin@disabled-attach.test');
    const uploadRes = await upload({ cookie: activeCookie });
    expect(uploadRes.res.status).toBe(201);
    const stagedId = uploadRes.fileId!;
    const storyId = await insertRow(tables.stories, {
      title: 'Disabled Community Story',
      slug: 'disabled-community-story',
      privacyLevel: 'public',
      isRestricted: false,
      communityId: disabledCommId,
      createdAt: now,
      updatedAt: now,
    });
    await db
      .update(tables.communities)
      .set({ isActive: false })
      .where(eq(tables.communities.id, disabledCommId));
    // Sessions are revoked on disable; a fresh admin login on the disabled
    // community reaches the repository.
    const disabledCookie = await loginAs('admin@disabled-attach.test');
    expect(
      (
        await attach(disabledCookie, {
          fileId: stagedId,
          ownerType: 'story',
          ownerId: storyId,
          role: 'story_media',
        })
      ).status
    ).toBe(403);
  });

  it('answers 404 (not 403) for an unauthorized non-target owner', async () => {
    const storyId = await insertRow(tables.stories, {
      title: 'Non-target authority story',
      slug: 'non-target-authority-story',
      privacyLevel: 'public',
      isRestricted: false,
      communityId: ids.community,
      createdBy: ids.editor,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // A file already attached as community branding: the community owner is
    // not this editor's to authorize, so the reuse is rejected as 404 (a 403
    // would disclose the protected relation).
    const brandingFile = await upload({ cookie: cookies.admin });
    const brandingFileId = brandingFile.fileId!;
    expect(
      (
        await attach(cookies.admin, {
          fileId: brandingFileId,
          ownerType: 'community',
          ownerId: ids.community,
          role: 'community_display_image',
        })
      ).status
    ).toBe(201);
    expect(
      (
        await attach(cookies.editor, {
          fileId: brandingFileId,
          ownerType: 'story',
          ownerId: storyId,
          role: 'story_media',
        })
      ).status
    ).toBe(404);

    // ...and likewise for a file already attached as another user's user_photo.
    const userFile = await upload({ cookie: cookies.admin });
    const userFileId = userFile.fileId!;
    expect(
      (
        await attach(cookies.admin, {
          fileId: userFileId,
          ownerType: 'user',
          ownerId: ids.member,
          role: 'user_photo',
        })
      ).status
    ).toBe(201);
    expect(
      (
        await attach(cookies.editor, {
          fileId: userFileId,
          ownerType: 'story',
          ownerId: storyId,
          role: 'story_media',
        })
      ).status
    ).toBe(404);
  });

  it('rejects §6.7 reuse that broadens the bytes audience and allows the uploader/admin to attach staging', async () => {
    const publicStory = await insertRow(tables.stories, {
      title: 'Reuse Story',
      slug: 'reuse-story',
      privacyLevel: 'public',
      isRestricted: false,
      communityId: ids.community,
      createdBy: ids.editor,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const publicPlace = await insertRow(tables.places, {
      name: 'Reuse Place',
      communityId: ids.community,
      isRestricted: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const restrictedStory = await insertRow(tables.stories, {
      title: 'Reuse Restricted Story',
      slug: 'reuse-restricted-story',
      privacyLevel: 'public',
      isRestricted: true,
      communityId: ids.community,
      createdBy: ids.editor,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Editor stages bytes and attaches them to a story whose change authority
    // it holds (a public story), then the story is restricted underneath it.
    // Reusing those bytes onto a public place is then a §6.7 audience-broadening
    // reuse: the restricted owner resolves to 404, uniformly with not-found,
    // and the bytes stay unserved through the refused relation.
    const restrictedSource = await upload({ cookie: cookies.editor });
    const restrictedSourceId = restrictedSource.fileId!;
    const restrictedAttach = await attach(cookies.editor, {
      fileId: restrictedSourceId,
      ownerType: 'story',
      ownerId: publicStory,
      role: 'story_media',
    });
    expect(restrictedAttach.status).toBe(201);
    await db
      .update(tables.stories)
      .set({ isRestricted: true })
      .where(eq(tables.stories.id, publicStory));

    const broaden = await attach(cookies.editor, {
      fileId: restrictedSourceId,
      ownerType: 'place',
      ownerId: publicPlace,
      role: 'place_photo',
    });
    expect(broaden.status).toBe(404);
    const served = await app.request(
      `${API_ORIGIN}/v2/media/${restrictedSourceId}`,
      { headers: { cookie: cookies.editor } }
    );
    expect(served.status).toBe(404);
    // The original restricted relation is untouched and still the only one.
    const relations = await db
      .select()
      .from(tables.attachments)
      .where(eq(tables.attachments.fileId, restrictedSourceId));
    expect(relations).toHaveLength(1);
    expect(relations[0]!.ownerType).toBe('story');
    expect(relations[0]!.ownerId).toBe(publicStory);
    const [restrictedRow] = await db
      .select()
      .from(tables.stories)
      .where(eq(tables.stories.id, publicStory));
    expect(restrictedRow?.isRestricted).toBe(true);

    // Viewer cannot reuse a story's bytes as its own user_photo: the editor's
    // public story file is not the viewer's to publish. Use a fresh, readable
    // public story (the earlier one is restricted above).
    const reuseStory = await insertRow(tables.stories, {
      title: 'Reuse Public Story',
      slug: 'reuse-public-story',
      privacyLevel: 'public',
      isRestricted: false,
      communityId: ids.community,
      createdBy: ids.editor,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const storyFile = await upload({ cookie: cookies.editor });
    const storyFileId = storyFile.fileId!;
    expect(
      (
        await attach(cookies.editor, {
          fileId: storyFileId,
          ownerType: 'story',
          ownerId: reuseStory,
          role: 'story_media',
        })
      ).status
    ).toBe(201);
    const viewerSelf = await attach(cookies.viewer, {
      fileId: storyFileId,
      ownerType: 'user',
      ownerId: ids.viewer,
      role: 'user_photo',
    });
    expect(viewerSelf.status).toBe(404);
    // And the viewer never gains the bytes.
    expect(
      (
        await app.request(`${API_ORIGIN}/v2/media/${storyFileId}`, {
          headers: { cookie: cookies.viewer },
        })
      ).status
    ).toBe(200);

    // A same-community admin is allowed to adopt staging; an editor may not
    // attach another uploader's unattached staging file.
    const editorAStaging = await upload({ cookie: cookies.editor });
    const editorAStagingId = editorAStaging.fileId!;
    const stolenStaging = await attach(cookies.member, {
      fileId: editorAStagingId,
      ownerType: 'user',
      ownerId: ids.member,
      role: 'user_photo',
    });
    expect(stolenStaging.status).toBe(404);
    // And the admin positive path: adopting another uploader's staging bytes
    // is allowed for a same-community admin.
    const adoptedStaging = await attach(cookies.admin, {
      fileId: editorAStagingId,
      ownerType: 'place',
      ownerId: publicPlace,
      role: 'place_photo',
    });
    expect(adoptedStaging.status).toBe(201);

    // Positive: the uploader attaches its own staging file.
    const ownStaging = await upload({ cookie: cookies.editor });
    const ownStagingId = ownStaging.fileId!;
    expect(
      (
        await attach(cookies.editor, {
          fileId: ownStagingId,
          ownerType: 'place',
          ownerId: publicPlace,
          role: 'place_photo',
        })
      ).status
    ).toBe(201);

    // Positive: an admin attaches its own staging file.
    const adminStaging = await upload({ cookie: cookies.admin });
    const adminStagingId = adminStaging.fileId!;
    expect(
      (
        await attach(cookies.admin, {
          fileId: adminStagingId,
          ownerType: 'place',
          ownerId: publicPlace,
          role: 'place_photo',
        })
      ).status
    ).toBe(201);
  });

  it('returns 404 for restricted/unknown-privacy owners and maps FK misses to 404', async () => {
    const restrictedStory = await insertRow(tables.stories, {
      title: 'Restricted Story',
      slug: 'restricted-story',
      privacyLevel: 'public',
      isRestricted: true,
      communityId: ids.community,
      createdBy: ids.editor,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const restrictedPlace = await insertRow(tables.places, {
      name: 'Restricted Place',
      communityId: ids.community,
      isRestricted: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const file = await upload({ cookie: cookies.editor });
    const fileId = file.fileId!;

    expect(
      (
        await attach(cookies.editor, {
          fileId,
          ownerType: 'story',
          ownerId: restrictedStory,
          role: 'story_media',
        })
      ).status
    ).toBe(404);
    expect(
      (
        await attach(cookies.editor, {
          fileId,
          ownerType: 'place',
          ownerId: restrictedPlace,
          role: 'place_photo',
        })
      ).status
    ).toBe(404);
    expect(
      (
        await attach(cookies.editor, {
          fileId: '00000000-0000-4000-8000-000000000000',
          ownerType: 'story',
          ownerId: restrictedStory,
          role: 'story_media',
        })
      ).status
    ).toBe(404);

    // Content-free file-authorization audit entries.
    const audits = await db
      .select()
      .from(tables.auditEntries)
      .where(eq(tables.auditEntries.resourceType, 'attachment'))
      .orderBy(asc(tables.auditEntries.id));
    expect(audits.length).toBeGreaterThan(0);
    for (const row of audits) {
      const parsedIds = Array.isArray(row.resourceIds)
        ? row.resourceIds
        : row.resourceIds
          ? JSON.parse(String(row.resourceIds))
          : [];
      expect(() =>
        validateContentFreeAuditEntry({
          communityId: row.communityId,
          actorId: row.actorId,
          action: row.action,
          resourceType: row.resourceType,
          resourceIds: parsedIds,
          outcome: row.outcome as 'success' | 'denied',
          ipAddress: row.ipAddress,
          userAgent: row.userAgent,
        })
      ).not.toThrow();
    }
  });

  it('removes files rows and bytes for files that become unreferenced on story/place/speaker delete, keeping shared ones', async () => {
    const storyFile = await upload({ cookie: cookies.editor });
    const storyFileId = storyFile.fileId!;
    const placeFile = await upload({ cookie: cookies.editor });
    const placeFileId = placeFile.fileId!;
    const speakerFile = await upload({ cookie: cookies.editor });
    const speakerFileId = speakerFile.fileId!;
    // A file shared by the doomed story and a surviving place must survive.
    const sharedFile = await upload({ cookie: cookies.editor });
    const sharedFileId = sharedFile.fileId!;

    const storyId = await insertRow(tables.stories, {
      title: 'Doomed Story',
      slug: 'doomed-story',
      privacyLevel: 'public',
      isRestricted: false,
      communityId: ids.community,
      createdBy: ids.editor,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const placeId = await insertRow(tables.places, {
      name: 'Doomed Place',
      communityId: ids.community,
      isRestricted: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const speakerId = await insertRow(tables.speakers, {
      name: 'Doomed Speaker',
      communityId: ids.community,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const survivorPlaceId = await insertRow(tables.places, {
      name: 'Survivor Place',
      communityId: ids.community,
      isRestricted: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    for (const [fileId, ownerType, ownerId, role] of [
      [storyFileId, 'story', storyId, 'story_media'],
      [placeFileId, 'place', placeId, 'place_photo'],
      [speakerFileId, 'speaker', speakerId, 'speaker_photo'],
      [sharedFileId, 'story', storyId, 'story_media'],
      [sharedFileId, 'place', survivorPlaceId, 'place_photo'],
    ] as const) {
      const res = await attach(cookies.editor, {
        fileId,
        ownerType,
        ownerId,
        role,
      });
      expect(res.status).toBe(201);
    }

    expect(
      (
        await app.request(`${API_ORIGIN}/v2/stories/${storyId}`, {
          method: 'DELETE',
          headers: { cookie: cookies.editor, origin: CLIENT_ORIGIN },
        })
      ).status
    ).toBe(204);
    expect(
      (
        await app.request(`${API_ORIGIN}/v2/places/${placeId}`, {
          method: 'DELETE',
          headers: { cookie: cookies.editor, origin: CLIENT_ORIGIN },
        })
      ).status
    ).toBe(204);
    expect(
      (
        await app.request(`${API_ORIGIN}/v2/speakers/${speakerId}`, {
          method: 'DELETE',
          headers: { cookie: cookies.editor, origin: CLIENT_ORIGIN },
        })
      ).status
    ).toBe(204);

    // Files whose last relation was removed are gone from DB and storage.
    for (const fileId of [storyFileId, placeFileId, speakerFileId]) {
      const [row] = await db
        .select()
        .from(tables.files)
        .where(eq(tables.files.id, fileId));
      expect(row, `files row removed for ${fileId}`).toBeUndefined();
      const key = `communities/${ids.community}/media/${fileId}`;
      expect(memStore.has(key), `bytes removed for ${fileId}`).toBe(false);
    }

    // The shared file is still attached to the surviving place, so it stays.
    const [sharedRow] = await db
      .select()
      .from(tables.files)
      .where(eq(tables.files.id, sharedFileId));
    expect(sharedRow, 'shared file row kept').toBeDefined();
    expect(memStore.has(sharedRow!.storageKey!)).toBe(true);
  });

  it('keeps each D1 attachment write within one bounded batch and <=100 params per statement', async () => {
    const batchSqlite = new Sqlite(':memory:');
    batchSqlite.pragma('foreign_keys = ON');
    const batchDb = drizzle(batchSqlite);
    migrate(batchDb, { migrationsFolder: './src/db/migrations' });
    const batchTables = tablesFor(batchDb);
    const now = new Date();

    const [comm] = await batchDb
      .insert(batchTables.communities)
      .values({
        name: 'D1 Attach',
        slug: 'd1-attach',
        publicStories: true,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const derived = deriveUserIdentityColumns({
      email: 'd1-attach@example.test',
      firstName: 'D1',
      lastName: 'Attach',
      communityId: comm!.id,
    });
    const [actor] = await batchDb
      .insert(batchTables.users)
      .values({
        email: 'd1-attach@example.test',
        emailNormalized: derived.emailNormalized,
        ...(await argon2Seed(TEST_DERIVED_KEY)),
        firstName: 'D1',
        lastName: 'Attach',
        displayNameNormalized: derived.displayNameNormalized,
        role: 'editor',
        communityId: comm!.id,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const [story] = await batchDb
      .insert(batchTables.stories)
      .values({
        title: 'D1 Story',
        slug: 'd1-story',
        privacyLevel: 'public',
        isRestricted: false,
        communityId: comm!.id,
        createdBy: actor!.id,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const fileId = crypto.randomUUID();
    await batchDb.insert(batchTables.files).values({
      id: fileId,
      filename: fileId,
      originalName: 'd1.png',
      path: `communities/${comm!.id}/media/${fileId}`,
      storageKey: `communities/${comm!.id}/media/${fileId}`,
      url: `/v2/media/${fileId}`,
      mimeType: 'image/png',
      size: PNG_BYTES.byteLength,
      byteSize: PNG_BYTES.byteLength,
      checksum: null,
      communityId: comm!.id,
      uploadedBy: actor!.id,
      culturalRestrictions: null,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });

    const batchCalls: Array<Array<{ sql: string; params: unknown[] }>> = [];
    const d1Like = Object.create(batchDb) as typeof batchDb & {
      batch: (
        stmts: Array<{ toSQL: () => { sql: string; params: unknown[] } }>
      ) => Promise<unknown[]>;
    };
    d1Like.batch = async (stmts) => {
      const queries = stmts.map((s) => s.toSQL());
      batchCalls.push(queries);
      return batchSqlite.transaction(() =>
        queries.map(({ sql, params }) => {
          const stmt = batchSqlite.prepare(sql);
          return stmt.reader ? stmt.all(...params) : stmt.run(...params);
        })
      )();
    };

    try {
      const repo = new MediaWritesRepository(d1Like as never);
      const created = await repo.createAttachment({
        actor: {
          id: actor!.id,
          email: 'd1-attach@example.test',
          role: 'editor',
          communityId: comm!.id,
          isActive: true,
        },
        fileId,
        ownerType: 'story',
        ownerId: story!.id,
        role: 'story_media',
      });
      expect(created.status).toBe('created');
      expect(batchCalls).toHaveLength(1);
      expect(batchCalls[0]).toHaveLength(2);
      for (const statement of batchCalls[0]!) {
        expect(statement.params.length).toBeLessThanOrEqual(100);
      }
    } finally {
      batchSqlite.close();
    }
  });

  it('records the attachment.delete success audit inside the D1 delete batch', async () => {
    const { db: batchDb, sqlite: batchSqlite, batchCalls } = createD1BatchDb();
    try {
      migrate(batchDb, { migrationsFolder: './src/db/migrations' });
      const batchTables = tablesFor(batchDb);
      const now = new Date('2026-06-01T12:00:00.000Z');
      const seeded = await seedD1MediaFixture(batchDb, now);
      const fileId = crypto.randomUUID();
      await batchDb.insert(batchTables.files).values({
        id: fileId,
        filename: fileId,
        originalName: 'd1-audit.png',
        path: `communities/${seeded.communityId}/media/${fileId}`,
        storageKey: `communities/${seeded.communityId}/media/${fileId}`,
        url: `/v2/media/${fileId}`,
        mimeType: 'image/png',
        size: PNG_BYTES.byteLength,
        byteSize: PNG_BYTES.byteLength,
        checksum: null,
        communityId: seeded.communityId,
        uploadedBy: seeded.actorId,
        culturalRestrictions: null,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      });
      const [attachment] = await batchDb
        .insert(batchTables.attachments)
        .values({
          communityId: seeded.communityId,
          fileId,
          ownerType: 'story',
          ownerId: seeded.storyId,
          role: 'story_media',
          ordinal: 0,
          createdAt: now,
        })
        .returning();

      const repo = new MediaWritesRepository(batchDb as never);
      const outcome = await repo.deleteAttachment(
        {
          id: seeded.actorId,
          email: seeded.email,
          role: 'editor',
          communityId: seeded.communityId,
          isActive: true,
        },
        attachment!.id,
        now
      );
      expect(outcome.status).toBe('deleted');

      // One atomic batch: relation delete, success audit insert, files delete.
      expect(batchCalls).toHaveLength(1);
      expect(
        batchCalls[0]!.filter((statement) =>
          statement.sql.includes('"audit_entries"')
        )
      ).toHaveLength(1);

      // The relation and the now-unreferenced files row are both gone.
      expect(await batchDb.select().from(batchTables.attachments)).toHaveLength(
        0
      );
      expect(await batchDb.select().from(batchTables.files)).toHaveLength(0);

      // The success audit row exists and is content-free.
      const audits = await batchDb.select().from(batchTables.auditEntries);
      expect(audits).toHaveLength(1);
      const row = audits[0]!;
      expect(row.action).toBe('attachment.delete');
      expect(row.outcome).toBe('success');
      expect(row.resourceType).toBe('attachment');
      expect(row.communityId).toBe(seeded.communityId);
      expect(row.actorId).toBe(seeded.actorId);
      const parsedIds = (
        Array.isArray(row.resourceIds)
          ? row.resourceIds
          : JSON.parse(String(row.resourceIds))
      ) as Array<string | number>;
      expect(parsedIds).toEqual([attachment!.id]);
      expect(() =>
        validateContentFreeAuditEntry({
          communityId: row.communityId,
          actorId: row.actorId,
          action: row.action,
          resourceType: row.resourceType,
          resourceIds: parsedIds,
          outcome: row.outcome as 'success' | 'denied',
          ipAddress: row.ipAddress,
          userAgent: row.userAgent,
        })
      ).not.toThrow();
      // Content-free: no file name, storage key, or URL in the audit row.
      const serialized = JSON.stringify(row);
      expect(serialized).not.toContain('d1-audit.png');
      expect(serialized).not.toContain(fileId);
    } finally {
      batchSqlite.close();
    }
  });

  it('writes no attachment.delete success audit when the row is already gone at D1 batch time', async () => {
    const { db: batchDb, sqlite: batchSqlite, batchCalls } = createD1BatchDb();
    try {
      migrate(batchDb, { migrationsFolder: './src/db/migrations' });
      const batchTables = tablesFor(batchDb);
      const now = new Date('2026-06-01T12:00:00.000Z');
      const seeded = await seedD1MediaFixture(batchDb, now);
      const fileId = crypto.randomUUID();
      await batchDb.insert(batchTables.files).values({
        id: fileId,
        filename: fileId,
        originalName: 'd1-race.png',
        path: `communities/${seeded.communityId}/media/${fileId}`,
        storageKey: `communities/${seeded.communityId}/media/${fileId}`,
        url: `/v2/media/${fileId}`,
        mimeType: 'image/png',
        size: PNG_BYTES.byteLength,
        byteSize: PNG_BYTES.byteLength,
        checksum: null,
        communityId: seeded.communityId,
        uploadedBy: seeded.actorId,
        culturalRestrictions: null,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      });
      const [attachment] = await batchDb
        .insert(batchTables.attachments)
        .values({
          communityId: seeded.communityId,
          fileId,
          ownerType: 'story',
          ownerId: seeded.storyId,
          role: 'story_media',
          ordinal: 0,
          createdAt: now,
        })
        .returning();

      // Simulate a concurrent DELETE that commits after this call has read the
      // attachment but before its D1 batch runs: the conditional audit
      // INSERT ... SELECT then matches no attachment row and the DELETE matches
      // nothing, so the outcome is 404 and no success audit is written.
      batchDb.batch = async (stmts) => {
        const queries = stmts.map((s) => s.toSQL());
        batchCalls.push(queries);
        return batchSqlite.transaction(() => {
          batchSqlite
            .prepare('DELETE FROM attachments WHERE id = ?')
            .run(attachment!.id);
          batchSqlite.prepare('DELETE FROM files WHERE id = ?').run(fileId);
          return queries.map(({ sql, params }) => {
            const stmt = batchSqlite.prepare(sql);
            return stmt.reader ? stmt.all(...params) : stmt.run(...params);
          });
        })();
      };

      const repo = new MediaWritesRepository(batchDb as never);
      const outcome = await repo.deleteAttachment(
        {
          id: seeded.actorId,
          email: seeded.email,
          role: 'editor',
          communityId: seeded.communityId,
          isActive: true,
        },
        attachment!.id,
        now
      );
      expect(outcome.status).toBe('not_found');

      // The conditional audit insert produced no row: the delete was a 404.
      expect(
        await batchDb.select().from(batchTables.auditEntries)
      ).toHaveLength(0);
    } finally {
      batchSqlite.close();
    }
  });

  it('removes unreferenced files in the D1 delete batch for story, place, and speaker deletes', async () => {
    const { db: batchDb, sqlite: batchSqlite } = createD1BatchDb();
    try {
      migrate(batchDb, { migrationsFolder: './src/db/migrations' });
      const batchTables = tablesFor(batchDb);
      const now = new Date('2026-06-01T12:00:00.000Z');
      const seeded = await seedD1MediaFixture(batchDb, now);
      const [place] = await batchDb
        .insert(batchTables.places)
        .values({
          communityId: seeded.communityId,
          name: 'D1 Place',
          isRestricted: false,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      const [speaker] = await batchDb
        .insert(batchTables.speakers)
        .values({
          communityId: seeded.communityId,
          name: 'D1 Speaker',
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      const owners = [
        ['story', seeded.storyId, 'story_media'],
        ['place', place!.id, 'place_photo'],
        ['speaker', speaker!.id, 'speaker_photo'],
      ] as const;
      const ownerFileIds: string[] = [];
      for (const [ownerType, ownerId, role] of owners) {
        const fileId = crypto.randomUUID();
        await batchDb.insert(batchTables.files).values({
          id: fileId,
          filename: fileId,
          originalName: `${ownerType}.png`,
          path: `communities/${seeded.communityId}/media/${fileId}`,
          storageKey: `communities/${seeded.communityId}/media/${fileId}`,
          url: `/v2/media/${fileId}`,
          mimeType: 'image/png',
          size: PNG_BYTES.byteLength,
          byteSize: PNG_BYTES.byteLength,
          checksum: null,
          communityId: seeded.communityId,
          uploadedBy: seeded.actorId,
          culturalRestrictions: null,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        });
        await batchDb.insert(batchTables.attachments).values({
          communityId: seeded.communityId,
          fileId,
          ownerType,
          ownerId,
          role,
          ordinal: 0,
          createdAt: now,
        });
        ownerFileIds.push(fileId);
      }

      const storyRepo = new StoryWritesRepository(batchDb as never);
      const communityRepo = new CommunityWritesRepository(batchDb as never);

      const storyRemoved: FileByteCleanup[] = [];
      expect(
        await storyRepo.deleteStory(
          seeded.communityId,
          seeded.storyId,
          storyRemoved
        )
      ).toBe(true);
      expect(storyRemoved.map((file) => file.fileId)).toEqual([
        ownerFileIds[0],
      ]);

      expect(
        await communityRepo.deletePlace(seeded.communityId, place!.id)
      ).toBe('deleted');
      expect(
        await communityRepo.deleteSpeaker(seeded.communityId, speaker!.id)
      ).toBe('deleted');

      // Every owner's now-unreferenced file row was removed by its own batch,
      // and no attachments survive either.
      expect(await batchDb.select().from(batchTables.files)).toHaveLength(0);
      expect(await batchDb.select().from(batchTables.attachments)).toHaveLength(
        0
      );
    } finally {
      batchSqlite.close();
    }
  });

  // Regression: the hosted Workers D1 driver's select builder has no `.for()`
  // (row locks are PostgreSQL-only), so any lock on the D1 path crashed the
  // request with a TypeError. The better-sqlite3 batch mock cannot express
  // this, which is why the suite stayed green while qa:personas:workers 500'd.
  it('creates an attachment through the real D1 driver (no row locks)', async () => {
    const { db: d1Db, sqlite: d1Sqlite } = createRealD1Db();
    try {
      const seed = drizzle(d1Sqlite);
      const seedTables = tablesFor(seed);
      const now = new Date();
      const [comm] = await seed
        .insert(seedTables.communities)
        .values({
          name: 'Real D1 Comm',
          slug: `real-d1-${crypto.randomUUID().slice(0, 8)}`,
          publicStories: true,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      const realEmail = `real-d1-${crypto.randomUUID().slice(0, 8)}@example.test`;
      const derived = deriveUserIdentityColumns({
        email: realEmail,
        firstName: 'Real',
        lastName: 'D1',
        communityId: comm!.id,
      });
      const [actor] = await seed
        .insert(seedTables.users)
        .values({
          email: realEmail,
          emailNormalized: derived.emailNormalized,
          ...(await argon2Seed(TEST_DERIVED_KEY)),
          firstName: 'Real',
          lastName: 'D1',
          displayNameNormalized: derived.displayNameNormalized,
          role: 'editor',
          communityId: comm!.id,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      const [story] = await seed
        .insert(seedTables.stories)
        .values({
          title: 'Real D1 Story',
          slug: `real-d1-story-${crypto.randomUUID().slice(0, 8)}`,
          privacyLevel: 'public',
          isRestricted: false,
          communityId: comm!.id,
          createdBy: actor!.id,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      const fileId = crypto.randomUUID();
      await seed.insert(seedTables.files).values({
        id: fileId,
        filename: fileId,
        originalName: 'real-d1.png',
        path: `communities/${comm!.id}/media/${fileId}`,
        storageKey: `communities/${comm!.id}/media/${fileId}`,
        url: `/v2/media/${fileId}`,
        mimeType: 'image/png',
        size: PNG_BYTES.byteLength,
        byteSize: PNG_BYTES.byteLength,
        checksum: null,
        communityId: comm!.id,
        uploadedBy: actor!.id,
        culturalRestrictions: null,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      });

      // Seed an existing relation so the attach takes the reuse path — the
      // one that runs row locks on the PostgreSQL driver.
      await seed.insert(seedTables.attachments).values({
        communityId: comm!.id,
        fileId,
        ownerType: 'story',
        ownerId: story!.id,
        role: 'story_media',
        ordinal: 0,
        createdAt: now,
      });
      const [place] = await seed
        .insert(seedTables.places)
        .values({
          name: 'Real D1 Place',
          communityId: comm!.id,
          isRestricted: false,
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      const repo = new MediaWritesRepository(d1Db as never);
      const created = await repo.createAttachment({
        actor: {
          id: actor!.id,
          email: realEmail,
          role: 'editor',
          communityId: comm!.id,
          isActive: true,
        },
        fileId,
        ownerType: 'place',
        ownerId: place!.id,
        role: 'place_photo',
      });
      expect(created.status).toBe('created');
    } finally {
      d1Sqlite.close();
    }
  });

  // TOCTOU: the owner vanishes between the authorize-time reads and the D1
  // batch (story deleted in between). The guarded statements in the batch
  // must produce nothing — no orphan attachment, no reordered rows, no
  // deleted relation — and the service must answer 404.
  it('returns 404 and inserts no attachment when the owner is deleted between check and D1 batch', async () => {
    const seedState: { storyId?: number } = {};
    const { db: d1Db, sqlite: d1Sqlite } = createRealD1Db({
      beforeBatch: () => {
        d1Sqlite
          .prepare('DELETE FROM stories WHERE id = ?')
          .run(seedState.storyId);
      },
    });
    try {
      const seed = drizzle(d1Sqlite);
      const seedTables = tablesFor(seed);
      const now = new Date();
      const [comm] = await seed
        .insert(seedTables.communities)
        .values({
          name: 'TOCTOU Comm',
          slug: `toctou-${crypto.randomUUID().slice(0, 8)}`,
          publicStories: true,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      const email = `toctou-${crypto.randomUUID().slice(0, 8)}@example.test`;
      const derived = deriveUserIdentityColumns({
        email,
        firstName: 'TOCTOU',
        lastName: 'Editor',
        communityId: comm!.id,
      });
      const [actor] = await seed
        .insert(seedTables.users)
        .values({
          email,
          emailNormalized: derived.emailNormalized,
          ...(await argon2Seed(TEST_DERIVED_KEY)),
          firstName: 'TOCTOU',
          lastName: 'Editor',
          displayNameNormalized: derived.displayNameNormalized,
          role: 'editor',
          communityId: comm!.id,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      const [story] = await seed
        .insert(seedTables.stories)
        .values({
          title: 'TOCTOU Story',
          slug: `toctou-story-${crypto.randomUUID().slice(0, 8)}`,
          privacyLevel: 'public',
          isRestricted: false,
          communityId: comm!.id,
          createdBy: actor!.id,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      seedState.storyId = story!.id;
      const fileId = crypto.randomUUID();
      await seed.insert(seedTables.files).values({
        id: fileId,
        filename: fileId,
        originalName: 'toctou.png',
        path: `communities/${comm!.id}/media/${fileId}`,
        storageKey: `communities/${comm!.id}/media/${fileId}`,
        url: `/v2/media/${fileId}`,
        mimeType: 'image/png',
        size: PNG_BYTES.byteLength,
        byteSize: PNG_BYTES.byteLength,
        checksum: null,
        communityId: comm!.id,
        uploadedBy: actor!.id,
        culturalRestrictions: null,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      });

      const repo = new MediaWritesRepository(d1Db as never);
      const created = await repo.createAttachment({
        actor: {
          id: actor!.id,
          email,
          role: 'editor',
          communityId: comm!.id,
          isActive: true,
        },
        fileId,
        ownerType: 'story',
        ownerId: story!.id,
        role: 'story_media',
      });
      expect(created.status).toBe('not_found');
      expect(
        await seed
          .select({ id: seedTables.attachments.id })
          .from(seedTables.attachments)
      ).toHaveLength(0);
    } finally {
      d1Sqlite.close();
    }
  });

  it('returns 404 and leaves ordinals untouched on reorder when the owner is deleted between check and D1 batch', async () => {
    const seedState: { storyId?: number } = {};
    const { db: d1Db, sqlite: d1Sqlite } = createRealD1Db({
      beforeBatch: () => {
        d1Sqlite
          .prepare('DELETE FROM stories WHERE id = ?')
          .run(seedState.storyId);
      },
    });
    try {
      const seed = drizzle(d1Sqlite);
      const seedTables = tablesFor(seed);
      const now = new Date();
      const [comm] = await seed
        .insert(seedTables.communities)
        .values({
          name: 'TOCTOU Reorder Comm',
          slug: `toctou-reorder-${crypto.randomUUID().slice(0, 8)}`,
          publicStories: true,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      const email = `toctou-reorder-${crypto.randomUUID().slice(0, 8)}@example.test`;
      const derived = deriveUserIdentityColumns({
        email,
        firstName: 'TOCTOU',
        lastName: 'Editor',
        communityId: comm!.id,
      });
      const [actor] = await seed
        .insert(seedTables.users)
        .values({
          email,
          emailNormalized: derived.emailNormalized,
          ...(await argon2Seed(TEST_DERIVED_KEY)),
          firstName: 'TOCTOU',
          lastName: 'Editor',
          displayNameNormalized: derived.displayNameNormalized,
          role: 'editor',
          communityId: comm!.id,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      const [story] = await seed
        .insert(seedTables.stories)
        .values({
          title: 'TOCTOU Reorder Story',
          slug: `toctou-reorder-${crypto.randomUUID().slice(0, 8)}`,
          privacyLevel: 'public',
          isRestricted: false,
          communityId: comm!.id,
          createdBy: actor!.id,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      seedState.storyId = story!.id;
      const attachmentIds: number[] = [];
      for (let i = 0; i < 2; i += 1) {
        const fileId = crypto.randomUUID();
        await seed.insert(seedTables.files).values({
          id: fileId,
          filename: fileId,
          originalName: `toctou-${i}.png`,
          path: `communities/${comm!.id}/media/${fileId}`,
          storageKey: `communities/${comm!.id}/media/${fileId}`,
          url: `/v2/media/${fileId}`,
          mimeType: 'image/png',
          size: PNG_BYTES.byteLength,
          byteSize: PNG_BYTES.byteLength,
          checksum: null,
          communityId: comm!.id,
          uploadedBy: actor!.id,
          culturalRestrictions: null,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        });
        const [att] = await seed
          .insert(seedTables.attachments)
          .values({
            communityId: comm!.id,
            fileId,
            ownerType: 'story',
            ownerId: story!.id,
            role: 'story_media',
            ordinal: i,
            createdAt: now,
          })
          .returning();
        attachmentIds.push(att!.id);
      }
      const repo = new MediaWritesRepository(d1Db as never);
      const result = await repo.reorderAttachments({
        actor: {
          id: actor!.id,
          email,
          role: 'editor',
          communityId: comm!.id,
          isActive: true,
        },
        ownerType: 'story',
        ownerId: story!.id,
        role: 'story_media',
        attachmentIds: [attachmentIds[1]!, attachmentIds[0]!],
      });
      expect(result.status).toBe('not_found');
      const rows = await seed
        .select({
          id: seedTables.attachments.id,
          ordinal: seedTables.attachments.ordinal,
        })
        .from(seedTables.attachments);
      const byId = new Map(rows.map((row) => [row.id, row.ordinal]));
      expect(byId.get(attachmentIds[0]!)).toBe(0);
      expect(byId.get(attachmentIds[1]!)).toBe(1);
    } finally {
      d1Sqlite.close();
    }
  });

  it('returns 404 and keeps the attachment when the owner is deleted between check and D1 batch on delete', async () => {
    const seedState: { storyId?: number } = {};
    const { db: d1Db, sqlite: d1Sqlite } = createRealD1Db({
      beforeBatch: () => {
        d1Sqlite
          .prepare('DELETE FROM stories WHERE id = ?')
          .run(seedState.storyId);
      },
    });
    try {
      const seed = drizzle(d1Sqlite);
      const seedTables = tablesFor(seed);
      const now = new Date();
      const [comm] = await seed
        .insert(seedTables.communities)
        .values({
          name: 'TOCTOU Delete Comm',
          slug: `toctou-delete-${crypto.randomUUID().slice(0, 8)}`,
          publicStories: true,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      const email = `toctou-delete-${crypto.randomUUID().slice(0, 8)}@example.test`;
      const derived = deriveUserIdentityColumns({
        email,
        firstName: 'TOCTOU',
        lastName: 'Editor',
        communityId: comm!.id,
      });
      const [actor] = await seed
        .insert(seedTables.users)
        .values({
          email,
          emailNormalized: derived.emailNormalized,
          ...(await argon2Seed(TEST_DERIVED_KEY)),
          firstName: 'TOCTOU',
          lastName: 'Editor',
          displayNameNormalized: derived.displayNameNormalized,
          role: 'editor',
          communityId: comm!.id,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      const [story] = await seed
        .insert(seedTables.stories)
        .values({
          title: 'TOCTOU Delete Story',
          slug: `toctou-delete-${crypto.randomUUID().slice(0, 8)}`,
          privacyLevel: 'public',
          isRestricted: false,
          communityId: comm!.id,
          createdBy: actor!.id,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      seedState.storyId = story!.id;
      const fileId = crypto.randomUUID();
      await seed.insert(seedTables.files).values({
        id: fileId,
        filename: fileId,
        originalName: 'toctou-delete.png',
        path: `communities/${comm!.id}/media/${fileId}`,
        storageKey: `communities/${comm!.id}/media/${fileId}`,
        url: `/v2/media/${fileId}`,
        mimeType: 'image/png',
        size: PNG_BYTES.byteLength,
        byteSize: PNG_BYTES.byteLength,
        checksum: null,
        communityId: comm!.id,
        uploadedBy: actor!.id,
        culturalRestrictions: null,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      });
      const [att] = await seed
        .insert(seedTables.attachments)
        .values({
          communityId: comm!.id,
          fileId,
          ownerType: 'story',
          ownerId: story!.id,
          role: 'story_media',
          ordinal: 0,
          createdAt: now,
        })
        .returning();

      const repo = new MediaWritesRepository(d1Db as never);
      const result = await repo.deleteAttachment(
        {
          id: actor!.id,
          email,
          role: 'editor',
          communityId: comm!.id,
          isActive: true,
        },
        att!.id
      );
      expect(result.status).toBe('not_found');
      expect(
        await seed
          .select({ id: seedTables.attachments.id })
          .from(seedTables.attachments)
      ).toHaveLength(1);
      expect(
        await seed.select({ id: seedTables.files.id }).from(seedTables.files)
      ).toHaveLength(1);
    } finally {
      d1Sqlite.close();
    }
  });

  it('assigns distinct, sequential ordinals to consecutive attaches in one owner/role', async () => {
    const { db: d1Db, sqlite: d1Sqlite } = createRealD1Db();
    try {
      const seed = drizzle(d1Sqlite);
      const seedTables = tablesFor(seed);
      const now = new Date();
      const [comm] = await seed
        .insert(seedTables.communities)
        .values({
          name: 'Ordinal Comm',
          slug: `ordinal-${crypto.randomUUID().slice(0, 8)}`,
          publicStories: true,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      const email = `ordinal-${crypto.randomUUID().slice(0, 8)}@example.test`;
      const derived = deriveUserIdentityColumns({
        email,
        firstName: 'Ordinal',
        lastName: 'Editor',
        communityId: comm!.id,
      });
      const [actor] = await seed
        .insert(seedTables.users)
        .values({
          email,
          emailNormalized: derived.emailNormalized,
          ...(await argon2Seed(TEST_DERIVED_KEY)),
          firstName: 'Ordinal',
          lastName: 'Editor',
          displayNameNormalized: derived.displayNameNormalized,
          role: 'editor',
          communityId: comm!.id,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      const [story] = await seed
        .insert(seedTables.stories)
        .values({
          title: 'Ordinal Story',
          slug: `ordinal-${crypto.randomUUID().slice(0, 8)}`,
          privacyLevel: 'public',
          isRestricted: false,
          communityId: comm!.id,
          createdBy: actor!.id,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      const fileIds: string[] = [
        crypto.randomUUID(),
        crypto.randomUUID(),
        crypto.randomUUID(),
      ];
      for (const fileId of fileIds) {
        await seed.insert(seedTables.files).values({
          id: fileId,
          filename: fileId,
          originalName: `ordinal-${fileId.slice(0, 4)}.png`,
          path: `communities/${comm!.id}/media/${fileId}`,
          storageKey: `communities/${comm!.id}/media/${fileId}`,
          url: `/v2/media/${fileId}`,
          mimeType: 'image/png',
          size: PNG_BYTES.byteLength,
          byteSize: PNG_BYTES.byteLength,
          checksum: null,
          communityId: comm!.id,
          uploadedBy: actor!.id,
          culturalRestrictions: null,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        });
      }
      const repo = new MediaWritesRepository(d1Db as never);
      const ordinals: number[] = [];
      for (const fileId of fileIds) {
        const created = await repo.createAttachment({
          actor: {
            id: actor!.id,
            email,
            role: 'editor',
            communityId: comm!.id,
            isActive: true,
          },
          fileId,
          ownerType: 'story',
          ownerId: story!.id,
          role: 'story_media',
        });
        expect(created.status).toBe('created');
        if (created.status !== 'created') return;
        ordinals.push(created.attachment.ordinal);
      }
      expect(new Set(ordinals).size).toBe(fileIds.length);
      expect([...ordinals].sort((a, b) => a - b)).toEqual([0, 1, 2]);
      const rows = await seed
        .select({
          id: seedTables.attachments.id,
          ordinal: seedTables.attachments.ordinal,
        })
        .from(seedTables.attachments);
      expect(new Set(rows.map((row) => row.ordinal)).size).toBe(fileIds.length);
    } finally {
      d1Sqlite.close();
    }
  });
});
