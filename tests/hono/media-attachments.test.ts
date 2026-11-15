/**
 * Focused §6.7 Attachment create/reorder/delete, null-community tenant check,
 * owner-delete byte cleanup, and D1 batch-bound tests for Slice 9 (#140).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { and, asc, eq } from 'drizzle-orm';
import { hash } from 'bcrypt';
import { nodePasswordVerifier } from '../../src/node-password.js';
import { tablesFor } from '../../src/db/dialect.js';
import { createHonoApp } from '../../src/hono-app.js';
import { HonoFoundationRepository } from '../../src/repositories/hono-foundation.repository.js';
import { MediaWritesRepository } from '../../src/repositories/media-writes.repository.js';
import { MediaCleanupCoordinator } from '../../src/services/media-cleanup.service.js';
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

const TEST_PASS = ['Slice9', 'Attachments', '2026!'].join('-');
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
    body: JSON.stringify({ email, password: TEST_PASS }),
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

describe('Slice 9 attachments, byte cleanup, and D1 bounds (#140)', () => {
  beforeAll(async () => {
    migrate(db, { migrationsFolder: './src/db/migrations' });
    const now = new Date('2026-06-01T12:00:00.000Z');
    const passwordHash = await hash(TEST_PASS, 4);

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
        passwordHash,
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
      verifier: nodePasswordVerifier,
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
    const adminUserPhoto = await attach(cookies.admin, {
      fileId: communityFileId,
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
        passwordHash: await hash(TEST_PASS, 4),
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
});
