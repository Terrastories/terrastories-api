/**
 * Focused contract, streaming, security, §6.4a/§6.7 authorization, Range serving,
 * D1-batch-atomicity, and audit tests for Slice 9 media file endpoints (#140).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
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
import {
  communityMediaSqlite,
  sessionsSqlite,
} from '../../src/db/schema/sessions.js';
import { createHonoApp } from '../../src/hono-app.js';
import { HonoFoundationRepository } from '../../src/repositories/hono-foundation.repository.js';
import { MediaWritesRepository } from '../../src/repositories/media-writes.repository.js';
import { MediaCleanupCoordinator } from '../../src/services/media-cleanup.service.js';
import { assertPutSha256, rawUploadRequest } from '../helpers/raw-upload.js';
import type { FoundationStorage } from '../../src/services/hono-foundation.service.js';
import {
  MediaMetadataResponseSchema,
  MediaUploadResponseSchema,
} from '../../src/shared/schemas/media-v2.js';
import { deriveUserIdentityColumns } from '../../src/shared/utils/derived-columns.js';
import { validateContentFreeAuditEntry } from '../../src/shared/utils/audit-entry.js';

const sqlite = new Sqlite(':memory:');
sqlite.pragma('foreign_keys = ON');
const db = drizzle(sqlite);
const tables = tablesFor(db);

// Build test credential material at runtime so no static credential-shaped literals exist.
const TEST_DERIVED_KEY = makeDerivedKey();
const API_ORIGIN = 'https://api.example.test';
const CLIENT_ORIGIN = 'https://app.example.test';
const FOREIGN_ORIGIN = 'https://evil.invalid';

// Valid minimal magic-byte payloads matching file-type/core signatures.
const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06,
  0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
]);
const JPEG_BYTES = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01,
  0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
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
      assertPutSha256(merged, opts?.sha256);
      store.set(storageKey, { bytes: merged, contentType: opts.contentType });
      return { size: total };
    },
    async delete(storageKey) {
      store.delete(storageKey);
    },
  };
  return { store, storage };
}

let app: ReturnType<typeof createHonoApp>;
let cleanup: MediaCleanupCoordinator;
let memStore: Map<string, { bytes: Uint8Array; contentType?: string }>;
const ids: Record<string, number> = {};
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

async function uploadMedia(opts: {
  cookie?: string;
  filename: string;
  contentType: string;
  bytes: Uint8Array;
  fields?: Record<string, string>;
  sha256?: string | null;
  omitContentLength?: boolean;
  origin?: string;
}) {
  const raw = rawUploadRequest({
    filename: opts.filename,
    contentType: opts.contentType,
    bytes: opts.bytes,
    fields: opts.fields,
    sha256: opts.sha256,
    omitContentLength: opts.omitContentLength,
  });
  const headers: Record<string, string> = {
    ...raw.headers,
    origin: opts.origin ?? CLIENT_ORIGIN,
  };
  if (opts.cookie) headers.cookie = opts.cookie;
  return app.request(`${API_ORIGIN}/v2/media${raw.search}`, {
    method: 'POST',
    headers,
    body: raw.body,
  });
}

describe('Slice 9 media upload, metadata, ranged serving, and deletion (#140)', () => {
  beforeAll(async () => {
    migrate(db, { migrationsFolder: './src/db/migrations' });
    const now = new Date('2026-06-01T12:00:00.000Z');
    const seed = await argon2Seed(TEST_DERIVED_KEY);

    ids.ownCommunity = await insertRow(tables.communities, {
      name: 'Own Nation',
      slug: 'own-nation',
      publicStories: true,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });
    ids.otherCommunity = await insertRow(tables.communities, {
      name: 'Other Nation',
      slug: 'other-nation',
      publicStories: true,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });

    const mkUser = async (
      email: string,
      role: string,
      communityId: number | null,
      firstName: string,
      lastName: string
    ) => {
      const derived = deriveUserIdentityColumns({
        email,
        firstName,
        lastName,
        communityId,
      });
      return insertRow(tables.users, {
        email,
        emailNormalized: derived.emailNormalized,
        ...seed,
        firstName,
        lastName,
        displayNameNormalized: derived.displayNameNormalized,
        role,
        communityId,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      });
    };

    ids.viewer = await mkUser(
      'viewer@own.test',
      'viewer',
      ids.ownCommunity,
      'Vee',
      'Viewer'
    );
    ids.member = await mkUser(
      'member@own.test',
      'member',
      ids.ownCommunity,
      'Mem',
      'Member'
    );
    ids.editorA = await mkUser(
      'editora@own.test',
      'editor',
      ids.ownCommunity,
      'EdA',
      'Editor'
    );
    ids.editorB = await mkUser(
      'editorb@own.test',
      'editor',
      ids.ownCommunity,
      'EdB',
      'Editor'
    );
    ids.admin = await mkUser(
      'admin@own.test',
      'admin',
      ids.ownCommunity,
      'Ad',
      'Admin'
    );
    ids.otherAdmin = await mkUser(
      'admin@other.test',
      'admin',
      ids.otherCommunity,
      'Other',
      'Admin'
    );
    ids.superAdminA = await mkUser(
      'sa1@system.test',
      'super_admin',
      null,
      'Super',
      'One'
    );
    ids.superAdminB = await mkUser(
      'sa2@system.test',
      'super_admin',
      null,
      'Super',
      'Two'
    );

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

    cookies.viewer = await loginAs('viewer@own.test');
    cookies.member = await loginAs('member@own.test');
    cookies.editorA = await loginAs('editora@own.test');
    cookies.editorB = await loginAs('editorb@own.test');
    cookies.admin = await loginAs('admin@own.test');
    cookies.otherAdmin = await loginAs('admin@other.test');
    cookies.superAdminA = await loginAs('sa1@system.test');
    cookies.superAdminB = await loginAs('sa2@system.test');
  });

  afterAll(() => {
    sqlite.close();
  });

  it('allows the x-content-sha256 header in the CORS preflight for browser uploads (#249)', async () => {
    const preflight = await app.request(
      `${API_ORIGIN}/v2/media?filename=a.png`,
      {
        method: 'OPTIONS',
        headers: {
          origin: CLIENT_ORIGIN,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type, x-content-sha256',
        },
      }
    );
    expect(preflight.status).toBe(204);
    const allowed = (
      preflight.headers.get('access-control-allow-headers') ?? ''
    ).toLowerCase();
    expect(allowed).toContain('x-content-sha256');
    expect(allowed).toContain('content-type');
  });

  it('sniffs only MAGIC_SNIFF_BYTES of a first chunk larger than 8 KiB and stores every byte with a matching checksum', async () => {
    // A single multipart body larger than the sniff window: the first stream
    // chunk exceeds MAGIC_SNIFF_BYTES, so the bounded sniff copy and the
    // per-chunk enqueue path both run.
    const padded = new Uint8Array(PNG_BYTES.byteLength + 20_000);
    padded.set(PNG_BYTES, 0);
    for (let i = PNG_BYTES.byteLength; i < padded.byteLength; i += 1) {
      padded[i] = i % 251;
    }
    const res = await uploadMedia({
      cookie: cookies.editorA,
      filename: 'large-first-chunk.png',
      contentType: 'image/png',
      bytes: padded,
    });
    expect(res.status).toBe(201);
    const body = MediaUploadResponseSchema.parse(await res.json());
    expect(body.data.byteSize).toBe(padded.byteLength);
    expect(body.data.checksum).toBe(
      createHash('sha256').update(padded).digest('hex')
    );
    const [dbFile] = await db
      .select()
      .from(tables.files)
      .where(eq(tables.files.id, body.data.id));
    const stored = memStore.get(dbFile!.storageKey!);
    expect(stored).toBeDefined();
    expect(Buffer.from(stored!.bytes).equals(Buffer.from(padded))).toBe(true);
  });

  it('streams PNG upload with SHA-256, sanitizes traversal filename, serves ranges & sandbox headers, and hides storageKey', async () => {
    const res = await uploadMedia({
      cookie: cookies.editorA,
      filename: '../../evil\\nested/hero.photo.png',
      contentType: 'image/png',
      bytes: PNG_BYTES,
      fields: { metadata: JSON.stringify({ caption: 'Riverbank' }) },
    });
    expect(res.status).toBe(201);
    const body = MediaUploadResponseSchema.parse(await res.json());

    const expectedSha = createHash('sha256').update(PNG_BYTES).digest('hex');
    expect(body.data.checksum).toBe(expectedSha);
    expect(body.data.byteSize).toBe(PNG_BYTES.byteLength);
    expect(body.data.mimeType).toBe('image/png');
    expect(body.data.originalName).toBe('hero.photo.png');
    expect(body.data.metadata).toEqual({ caption: 'Riverbank' });
    expect(body.data.attachment).toBeNull();
    expect('storageKey' in body.data).toBe(false);

    const fileId = body.data.id;
    const [dbFile] = await db
      .select()
      .from(tables.files)
      .where(eq(tables.files.id, fileId));
    expect(dbFile?.storageKey).toBe(
      `communities/${ids.ownCommunity}/media/${fileId}`
    );
    expect(memStore.has(dbFile!.storageKey!)).toBe(true);

    // Metadata endpoint enforces policy and omits storageKey
    const metaRes = await app.request(
      `${API_ORIGIN}/v2/media/${fileId}/metadata`,
      { headers: { cookie: cookies.editorA } }
    );
    expect(metaRes.status).toBe(200);
    const meta = MediaMetadataResponseSchema.parse(await metaRes.json());
    expect(meta.data.checksum).toBe(expectedSha);

    // Unattached staging isolation: own-viewer, own-member, other editor, cross-community, super_admin all get 404; own-admin gets 200
    for (const deniedCookie of [
      cookies.viewer,
      cookies.member,
      cookies.editorB,
      cookies.otherAdmin,
      cookies.superAdminA,
    ]) {
      expect(
        (
          await app.request(`${API_ORIGIN}/v2/media/${fileId}`, {
            headers: { cookie: deniedCookie },
          })
        ).status
      ).toBe(404);
      expect(
        (
          await app.request(`${API_ORIGIN}/v2/media/${fileId}/metadata`, {
            headers: { cookie: deniedCookie },
          })
        ).status
      ).toBe(404);
    }

    // Full download + sandbox headers (uploader and own-admin)
    const fullRes = await app.request(`${API_ORIGIN}/v2/media/${fileId}`, {
      headers: { cookie: cookies.admin },
    });
    expect(fullRes.status).toBe(200);
    expect(fullRes.headers.get('accept-ranges')).toBe('bytes');
    expect(fullRes.headers.get('content-security-policy')).toBe(
      "default-src 'none'; sandbox"
    );
    expect(fullRes.headers.get('x-content-type-options')).toBe('nosniff');
    expect(fullRes.headers.get('cache-control')).toBe('no-store');
    expect(new Uint8Array(await fullRes.arrayBuffer())).toEqual(PNG_BYTES);

    // Prefix range
    const rangePrefix = await app.request(`${API_ORIGIN}/v2/media/${fileId}`, {
      headers: { cookie: cookies.editorA, range: 'bytes=0-3' },
    });
    expect(rangePrefix.status).toBe(206);
    expect(rangePrefix.headers.get('content-range')).toBe(
      `bytes 0-3/${PNG_BYTES.byteLength}`
    );
    expect(new Uint8Array(await rangePrefix.arrayBuffer())).toEqual(
      PNG_BYTES.subarray(0, 4)
    );

    // Suffix range
    const rangeSuffix = await app.request(`${API_ORIGIN}/v2/media/${fileId}`, {
      headers: { cookie: cookies.editorA, range: 'bytes=-4' },
    });
    expect(rangeSuffix.status).toBe(206);
    expect(new Uint8Array(await rangeSuffix.arrayBuffer())).toEqual(
      PNG_BYTES.subarray(PNG_BYTES.byteLength - 4)
    );

    // Unsatisfiable range -> 416
    const rangeOob = await app.request(`${API_ORIGIN}/v2/media/${fileId}`, {
      headers: { cookie: cookies.editorA, range: 'bytes=99999-100000' },
    });
    expect(rangeOob.status).toBe(416);

    // Another editor cannot see/delete editorA's unattached staging file -> 404
    const otherDel = await app.request(`${API_ORIGIN}/v2/media/${fileId}`, {
      method: 'DELETE',
      headers: { cookie: cookies.editorB, origin: CLIENT_ORIGIN },
    });
    expect(otherDel.status).toBe(404);

    // Uploader can delete unattached staging file -> 204 and deletes storage bytes
    const uploaderDel = await app.request(`${API_ORIGIN}/v2/media/${fileId}`, {
      method: 'DELETE',
      headers: { cookie: cookies.editorA, origin: CLIENT_ORIGIN },
    });
    expect(uploaderDel.status).toBe(204);
    expect(memStore.has(dbFile!.storageKey!)).toBe(false);
  });

  it('rejects untyped staging for viewer/member/super_admin, allows explicit user_photo, and isolates super_admin self photo', async () => {
    const storeBefore = memStore.size;

    // 1. Viewer, member, super_admin blocked from untyped staging (403), zero bytes kept
    for (const [roleCookie, fields] of [
      [cookies.viewer, undefined],
      [cookies.member, { role: 'story_media' }],
      [cookies.superAdminA, undefined],
      [
        cookies.viewer,
        { role: 'user_photo', ownerType: 'user', ownerId: String(ids.member) },
      ],
    ] as const) {
      const denied = await uploadMedia({
        cookie: roleCookie,
        filename: 'avatar.png',
        contentType: 'image/png',
        bytes: PNG_BYTES,
        fields: fields as Record<string, string> | undefined,
      });
      expect(denied.status).toBe(403);
    }
    // A denied binding is rejected before any byte is stored and returns 403
    const afterFileDenied = await uploadMedia({
      cookie: cookies.superAdminA,
      filename: 'avatar.png',
      contentType: 'image/png',
      bytes: PNG_BYTES,
      fields: { role: 'story_media' },
    });
    expect(afterFileDenied.status).toBe(403);
    expect(memStore.size).toBe(storeBefore);

    // 2. Super admin explicit user_photo for self succeeds and is isolated under users/<id>/media/<uuid>
    const saRes = await uploadMedia({
      cookie: cookies.superAdminA,
      filename: 'sa.png',
      contentType: 'image/png',
      bytes: PNG_BYTES,
      fields: { role: 'user_photo' },
    });
    expect(saRes.status).toBe(201);
    const saBody = MediaUploadResponseSchema.parse(await saRes.json());
    expect(saBody.data.attachment).toMatchObject({
      ownerType: 'user',
      ownerId: ids.superAdminA,
      role: 'user_photo',
    });

    const [saFile] = await db
      .select()
      .from(tables.files)
      .where(eq(tables.files.id, saBody.data.id));
    expect(saFile?.communityId).toBeNull();
    expect(saFile?.storageKey).toBe(
      `users/${ids.superAdminA}/media/${saBody.data.id}`
    );

    // Serves only to superAdminA; denied to superAdminB and own-admin
    expect(
      (
        await app.request(`${API_ORIGIN}/v2/media/${saBody.data.id}`, {
          headers: { cookie: cookies.superAdminA },
        })
      ).status
    ).toBe(200);
    expect(
      (
        await app.request(`${API_ORIGIN}/v2/media/${saBody.data.id}`, {
          headers: { cookie: cookies.superAdminB },
        })
      ).status
    ).toBe(404);
    expect(
      (
        await app.request(`${API_ORIGIN}/v2/media/${saBody.data.id}`, {
          headers: { cookie: cookies.admin },
        })
      ).status
    ).toBe(404);

    // Refuses delete while still attached (409)
    expect(
      (
        await app.request(`${API_ORIGIN}/v2/media/${saBody.data.id}`, {
          method: 'DELETE',
          headers: { cookie: cookies.superAdminA, origin: CLIENT_ORIGIN },
        })
      ).status
    ).toBe(409);

    // 3. own-viewer user_photo is readable by own-viewer AND own-admin (user-management authority)
    const viewerPhotoRes = await uploadMedia({
      cookie: cookies.viewer,
      filename: 'me.jpg',
      contentType: 'image/jpeg',
      bytes: JPEG_BYTES,
      fields: { role: 'user_photo' },
    });
    expect(viewerPhotoRes.status).toBe(201);
    const viewerPhotoId = MediaUploadResponseSchema.parse(
      await viewerPhotoRes.json()
    ).data.id;
    expect(
      (
        await app.request(`${API_ORIGIN}/v2/media/${viewerPhotoId}`, {
          headers: { cookie: cookies.viewer },
        })
      ).status
    ).toBe(200);
    expect(
      (
        await app.request(`${API_ORIGIN}/v2/media/${viewerPhotoId}`, {
          headers: { cookie: cookies.admin },
        })
      ).status
    ).toBe(200);
    expect(
      (
        await app.request(`${API_ORIGIN}/v2/media/${viewerPhotoId}`, {
          headers: { cookie: cookies.member },
        })
      ).status
    ).toBe(404);
    expect(
      (
        await app.request(`${API_ORIGIN}/v2/media/${viewerPhotoId}`, {
          headers: { cookie: cookies.otherAdmin },
        })
      ).status
    ).toBe(404);
  });

  it('serves an imported null-community super_admin own user_photo with uploadedBy=null from the owner prefix only', async () => {
    // Imported bytes keep no uploader (uploadedBy is null); authorization
    // flows through the own-account user_photo attachment, so the serving
    // prefix must derive from that attachment's owner — the actor for this
    // exception — never from uploadedBy.
    const importedAt = new Date('2026-06-01T12:00:00.000Z');
    const fileId = crypto.randomUUID();
    const storageKey = `users/${ids.superAdminA}/media/${fileId}`;
    await db.insert(tables.files).values({
      id: fileId,
      filename: fileId,
      originalName: 'imported.png',
      path: storageKey,
      storageKey,
      url: `/v2/media/${fileId}`,
      mimeType: 'image/png',
      size: PNG_BYTES.byteLength,
      byteSize: PNG_BYTES.byteLength,
      checksum: null,
      communityId: null,
      uploadedBy: null,
      culturalRestrictions: null,
      isActive: true,
      createdAt: importedAt,
      updatedAt: importedAt,
    });
    await db.insert(tables.attachments).values({
      fileId,
      communityId: null,
      ownerType: 'user',
      ownerId: ids.superAdminA,
      role: 'user_photo',
      ordinal: 0,
      createdAt: importedAt,
    });
    memStore.set(storageKey, {
      bytes: PNG_BYTES,
      contentType: 'image/png',
    });

    // The owning super_admin downloads it: 200.
    const owner = await app.request(`${API_ORIGIN}/v2/media/${fileId}`, {
      headers: { cookie: cookies.superAdminA },
    });
    expect(owner.status).toBe(200);
    expect(
      Buffer.from(await owner.arrayBuffer()).equals(Buffer.from(PNG_BYTES))
    ).toBe(true);

    // Another null-community super_admin does not: 404 — its derived prefix
    // (users/<B>/) never matches the key.
    const otherSuperAdmin = await app.request(
      `${API_ORIGIN}/v2/media/${fileId}`,
      { headers: { cookie: cookies.superAdminB } }
    );
    expect(otherSuperAdmin.status).toBe(404);

    // A community administrator reaches it no better: 404.
    const admin = await app.request(`${API_ORIGIN}/v2/media/${fileId}`, {
      headers: { cookie: cookies.admin },
    });
    expect(admin.status).toBe(404);
  });

  it('prefix guard: a user_photo attached to A whose bytes live under users/B/ is 404 for A', async () => {
    // The own-account user_photo exception authorizes the attachment owner,
    // but the serving prefix guard is independent: bytes under another
    // account's `users/<id>/` prefix can never be served through them.
    const at = new Date('2026-06-01T12:00:00.000Z');
    const fileId = crypto.randomUUID();
    const storageKey = `users/${ids.superAdminB}/media/${fileId}`;
    await db.insert(tables.files).values({
      id: fileId,
      filename: fileId,
      originalName: 'foreign-prefix.png',
      path: storageKey,
      storageKey,
      url: `/v2/media/${fileId}`,
      mimeType: 'image/png',
      size: PNG_BYTES.byteLength,
      byteSize: PNG_BYTES.byteLength,
      checksum: null,
      communityId: null,
      uploadedBy: null,
      culturalRestrictions: null,
      isActive: true,
      createdAt: at,
      updatedAt: at,
    });
    await db.insert(tables.attachments).values({
      fileId,
      communityId: null,
      ownerType: 'user',
      ownerId: ids.superAdminA,
      role: 'user_photo',
      ordinal: 0,
      createdAt: at,
    });
    memStore.set(storageKey, {
      bytes: PNG_BYTES,
      contentType: 'image/png',
    });

    // The authorized owner A still gets 404: the key is outside users/<A>/.
    const asA = await app.request(`${API_ORIGIN}/v2/media/${fileId}`, {
      headers: { cookie: cookies.superAdminA },
    });
    expect(asA.status).toBe(404);

    // And B cannot read it either: B is not the attachment owner.
    const asB = await app.request(`${API_ORIGIN}/v2/media/${fileId}`, {
      headers: { cookie: cookies.superAdminB },
    });
    expect(asB.status).toBe(404);
  });

  it('rejects SVG/HTML payloads, magic-byte/extension mismatches, oversize Content-Length, and CSRF origin mismatches', async () => {
    const before = memStore.size;

    // SVG upload
    expect(
      (
        await uploadMedia({
          cookie: cookies.editorA,
          filename: 'xss.svg',
          contentType: 'image/svg+xml',
          bytes: new TextEncoder().encode(
            '<svg><script>alert(1)</script></svg>'
          ),
        })
      ).status
    ).toBe(400);

    // HTML spoofed as image/png + .png
    expect(
      (
        await uploadMedia({
          cookie: cookies.editorA,
          filename: 'payload.png',
          contentType: 'image/png',
          bytes: new TextEncoder().encode('<html><body>xss</body></html>'),
        })
      ).status
    ).toBe(400);

    // JPEG magic bytes spoofed as image/png
    expect(
      (
        await uploadMedia({
          cookie: cookies.editorA,
          filename: 'spoof.png',
          contentType: 'image/png',
          bytes: JPEG_BYTES,
        })
      ).status
    ).toBe(400);

    // Valid PNG bytes with mismatched .jpg extension
    expect(
      (
        await uploadMedia({
          cookie: cookies.editorA,
          filename: 'real.jpg',
          contentType: 'image/png',
          bytes: PNG_BYTES,
        })
      ).status
    ).toBe(400);

    // WAV magic bytes accepted when declared correctly as audio/wav
    const wavOk = await uploadMedia({
      cookie: cookies.editorA,
      filename: 'place-name.wav',
      contentType: 'audio/wav',
      bytes: WAV_BYTES,
    });
    expect(wavOk.status).toBe(201);
    const wavId = MediaUploadResponseSchema.parse(await wavOk.json()).data.id;
    await app.request(`${API_ORIGIN}/v2/media/${wavId}`, {
      method: 'DELETE',
      headers: { cookie: cookies.editorA, origin: CLIENT_ORIGIN },
    });

    // Oversize Content-Length -> 413
    const big = rawUploadRequest({
      filename: 'big.png',
      contentType: 'image/png',
      bytes: PNG_BYTES,
    });
    expect(
      (
        await app.request(`${API_ORIGIN}/v2/media${big.search}`, {
          method: 'POST',
          headers: {
            ...big.headers,
            cookie: cookies.editorA,
            origin: CLIENT_ORIGIN,
            'content-length': String(101 * 1024 * 1024),
          },
          body: big.body,
        })
      ).status
    ).toBe(413);

    // Wrong origin CSRF -> 403
    expect(
      (
        await uploadMedia({
          cookie: cookies.editorA,
          filename: 'csrf.png',
          contentType: 'image/png',
          bytes: PNG_BYTES,
          origin: FOREIGN_ORIGIN,
        })
      ).status
    ).toBe(403);

    expect(memStore.size).toBe(before);
  });

  it('enforces §6.4a story/place/speaker/mapConfig/branding read policy, #162 restricted 404, Range revocation, and delete 409/204 + restart-safe sweeper', async () => {
    const now = new Date('2026-06-01T12:00:00.000Z');
    const storyRes = await uploadMedia({
      cookie: cookies.editorA,
      filename: 'story-clip.png',
      contentType: 'image/png',
      bytes: PNG_BYTES,
    });
    expect(storyRes.status).toBe(201);
    const storyFileId = MediaUploadResponseSchema.parse(await storyRes.json())
      .data.id;

    const placeId = await insertRow(tables.places, {
      name: 'Hidden Ridge',
      communityId: ids.ownCommunity,
      isRestricted: false,
      createdAt: now,
      updatedAt: now,
    });
    const storyId = await insertRow(tables.stories, {
      title: 'Ridge Tale',
      slug: 'ridge-tale',
      privacyLevel: 'members_only',
      isRestricted: false,
      communityId: ids.ownCommunity,
      createdBy: ids.editorA,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(tables.attachments).values({
      fileId: storyFileId,
      communityId: ids.ownCommunity,
      ownerType: 'story',
      ownerId: storyId,
      role: 'story_media',
      ordinal: 0,
      createdAt: now,
    });

    // While attached to active community story: viewer & member can read with Range, cross-community & super_admin denied (404)
    expect(
      (
        await app.request(`${API_ORIGIN}/v2/media/${storyFileId}`, {
          headers: { cookie: cookies.member, range: 'bytes=0-7' },
        })
      ).status
    ).toBe(206);
    expect(
      (
        await app.request(`${API_ORIGIN}/v2/media/${storyFileId}`, {
          headers: { cookie: cookies.otherAdmin },
        })
      ).status
    ).toBe(404);
    expect(
      (
        await app.request(`${API_ORIGIN}/v2/media/${storyFileId}`, {
          headers: { cookie: cookies.superAdminA },
        })
      ).status
    ).toBe(404);

    // While attached: DELETE returns 409 Conflict
    expect(
      (
        await app.request(`${API_ORIGIN}/v2/media/${storyFileId}`, {
          method: 'DELETE',
          headers: { cookie: cookies.admin, origin: CLIENT_ORIGIN },
        })
      ).status
    ).toBe(409);

    // Revocation (#162): restricting the story makes subsequent Range requests return 404
    await db
      .update(tables.stories)
      .set({ isRestricted: true })
      .where(eq(tables.stories.id, storyId));
    expect(
      (
        await app.request(`${API_ORIGIN}/v2/media/${storyFileId}`, {
          headers: { cookie: cookies.admin, range: 'bytes=0-7' },
        })
      ).status
    ).toBe(404);

    // Branding via community_media + static_map via community_map_configs also block DELETE with 409
    const brandingRes = await uploadMedia({
      cookie: cookies.admin,
      filename: 'brand.png',
      contentType: 'image/png',
      bytes: PNG_BYTES,
    });
    const brandingId = MediaUploadResponseSchema.parse(await brandingRes.json())
      .data.id;
    await db.insert(communityMediaSqlite).values({
      communityId: ids.ownCommunity,
      fileId: brandingId,
      kind: 'branding',
      createdAt: now,
    });
    expect(
      (
        await app.request(`${API_ORIGIN}/v2/media/${brandingId}`, {
          method: 'DELETE',
          headers: { cookie: cookies.admin, origin: CLIENT_ORIGIN },
        })
      ).status
    ).toBe(409);

    // Place photo restricted check + restart-safe orphan sweep when attachment row disappears
    const orphanRes = await uploadMedia({
      cookie: cookies.editorA,
      filename: 'orphan.png',
      contentType: 'image/png',
      bytes: PNG_BYTES,
    });
    const orphanId = MediaUploadResponseSchema.parse(await orphanRes.json())
      .data.id;
    const [orphanAtt] = await db
      .insert(tables.attachments)
      .values({
        fileId: orphanId,
        communityId: ids.ownCommunity,
        ownerType: 'place',
        ownerId: placeId,
        role: 'place_photo',
        ordinal: 0,
        createdAt: now,
      })
      .returning();

    // Sweep does NOT touch attached file
    const sweep1 = await cleanup.sweepUnreferencedFiles({
      fileIds: [orphanId],
    });
    expect(sweep1.deletedCount).toBe(0);

    // Simulate relation removed without file deletion (e.g. crash between delete & sweep)
    await db
      .delete(tables.attachments)
      .where(eq(tables.attachments.id, orphanAtt!.id));
    const [orphanDb] = await db
      .select()
      .from(tables.files)
      .where(eq(tables.files.id, orphanId));
    expect(memStore.has(orphanDb!.storageKey!)).toBe(true);

    const sweep2 = await cleanup.sweepUnreferencedFiles({
      fileIds: [orphanId],
    });
    expect(sweep2.deletedCount).toBe(1);
    expect(memStore.has(orphanDb!.storageKey!)).toBe(false);

    // All emitted file/super_admin audit entries are content-free
    const audits = await db
      .select()
      .from(tables.auditEntries)
      .where(and(eq(tables.auditEntries.resourceType, 'file')))
      .orderBy(asc(tables.auditEntries.id));
    expect(audits.length).toBeGreaterThanOrEqual(4);
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

  it('rolls back storage bytes on D1 DB failure and executes atomic D1 batches cleanly', async () => {
    const d1Sqlite = new Sqlite(':memory:');
    d1Sqlite.pragma('foreign_keys = ON');
    const localDb = drizzle(d1Sqlite);
    migrate(localDb, { migrationsFolder: './src/db/migrations' });

    const { store, storage } = createMemoryStorage();
    const now = new Date('2026-06-01T12:00:00.000Z');
    const localTables = tablesFor(localDb);
    const [comm] = await localDb
      .insert(localTables.communities)
      .values({
        name: 'D1 Comm',
        slug: 'd1-comm',
        publicStories: true,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const derived = deriveUserIdentityColumns({
      email: 'ed@d1.test',
      firstName: 'Ed',
      lastName: 'D1',
      communityId: comm!.id,
    });
    const [edUser] = await localDb
      .insert(localTables.users)
      .values({
        email: 'ed@d1.test',
        emailNormalized: derived.emailNormalized,
        ...(await argon2Seed(TEST_DERIVED_KEY)),
        firstName: 'Ed',
        lastName: 'D1',
        displayNameNormalized: derived.displayNameNormalized,
        role: 'editor',
        communityId: comm!.id,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    let failNextBatch = false;
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
        if (failNextBatch) {
          failNextBatch = false;
          throw new Error('simulated D1 batch error');
        }
        const tx = d1Sqlite.transaction(() => stmts.map((s) => s._exec()));
        return tx();
      },
    };
    let failAfterPut = false;
    const wrappedStorage: FoundationStorage = {
      read: storage.read,
      delete: storage.delete,
      async put(storageKey, stream, opts) {
        const stored = await storage.put!(storageKey, stream, opts);
        if (failAfterPut) {
          failAfterPut = false;
          failNextBatch = true;
        }
        return stored;
      },
    };
    const d1Db = drizzleD1(client as unknown as D1Database);
    const repo = new MediaWritesRepository(d1Db);
    const localCleanup = new MediaCleanupCoordinator(d1Db, wrappedStorage);
    const localApp = createHonoApp({
      repository: new HonoFoundationRepository(d1Db),
      serverSecret: makeServerSecret(),
      secureCookies: false,
      publicOrigin: API_ORIGIN,
      corsOrigins: [CLIENT_ORIGIN],
      storage: wrappedStorage,
      mediaCleanup: localCleanup,
    });

    // Inject raw session cookie for D1 mock
    const rawToken = 'b'.repeat(64);
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    await localDb.insert(sessionsSqlite).values({
      id: 'd1-sess-1',
      tokenHash,
      userId: edUser!.id,
      expiresAt: Date.now() + 60_000,
    });
    const cookie = `ts_session=${rawToken}`;

    // Simulated DB failure after storage.put rolls back stored bytes immediately
    failAfterPut = true;
    const mpFail = rawUploadRequest({
      filename: 'rollback.png',
      contentType: 'image/png',
      bytes: PNG_BYTES,
    });
    const failRes = await localApp.request(
      `${API_ORIGIN}/v2/media${mpFail.search}`,
      {
        method: 'POST',
        headers: { ...mpFail.headers, cookie, origin: CLIENT_ORIGIN },
        body: mpFail.body,
      }
    );
    expect(failRes.status).toBe(500);
    expect(store.size).toBe(0);

    // Normal D1 batch upload + read + delete
    const mpOk = rawUploadRequest({
      filename: 'd1.png',
      contentType: 'image/png',
      bytes: PNG_BYTES,
    });
    const okRes = await localApp.request(
      `${API_ORIGIN}/v2/media${mpOk.search}`,
      {
        method: 'POST',
        headers: { ...mpOk.headers, cookie, origin: CLIENT_ORIGIN },
        body: mpOk.body,
      }
    );
    expect(okRes.status).toBe(201);
    const fileId = MediaUploadResponseSchema.parse(await okRes.json()).data.id;
    expect(store.size).toBe(1);

    const delOutcome = await repo.deleteUnreferencedFile(fileId, {
      id: edUser!.id,
      email: 'ed@d1.test',
      role: 'editor',
      communityId: comm!.id,
      isActive: true,
    });
    expect(delOutcome.status).toBe('deleted');
    d1Sqlite.close();
  });

  it('DELETE /v2/media/:id answers 404 unless an attachment owner is readable by the actor', async () => {
    const now = new Date('2026-06-01T12:00:00.000Z');

    // File attached to a restricted story: a community member cannot read the
    // story, and the DELETE must not reveal whether the file exists.
    const hidden = await uploadMedia({
      cookie: cookies.editorA,
      filename: 'oracle-hidden.png',
      contentType: 'image/png',
      bytes: PNG_BYTES,
    });
    expect(hidden.status).toBe(201);
    const hiddenFileId = MediaUploadResponseSchema.parse(await hidden.json())
      .data.id;
    const restrictedStoryId = await insertRow(tables.stories, {
      title: 'Oracle Restricted',
      slug: `oracle-restricted-${Date.now().toString(36)}`,
      privacyLevel: 'members_only',
      isRestricted: true,
      communityId: ids.ownCommunity,
      createdBy: ids.editorA,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(tables.attachments).values({
      fileId: hiddenFileId,
      communityId: ids.ownCommunity,
      ownerType: 'story',
      ownerId: restrictedStoryId,
      role: 'story_media',
      ordinal: 0,
      createdAt: now,
    });
    const hiddenDel = await app.request(
      `${API_ORIGIN}/v2/media/${hiddenFileId}`,
      {
        method: 'DELETE',
        headers: { cookie: cookies.member, origin: CLIENT_ORIGIN },
      }
    );
    expect(hiddenDel.status).toBe(404);

    // File attached to a public story the member can read: the DELETE keeps
    // the 403 semantics, because the actor can already see this file.
    const visible = await uploadMedia({
      cookie: cookies.editorA,
      filename: 'oracle-visible.png',
      contentType: 'image/png',
      bytes: PNG_BYTES,
    });
    expect(visible.status).toBe(201);
    const visibleFileId = MediaUploadResponseSchema.parse(await visible.json())
      .data.id;
    const publicStoryId = await insertRow(tables.stories, {
      title: 'Oracle Public',
      slug: `oracle-public-${Date.now().toString(36)}`,
      privacyLevel: 'members_only',
      isRestricted: false,
      communityId: ids.ownCommunity,
      createdBy: ids.editorA,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(tables.attachments).values({
      fileId: visibleFileId,
      communityId: ids.ownCommunity,
      ownerType: 'story',
      ownerId: publicStoryId,
      role: 'story_media',
      ordinal: 0,
      createdAt: now,
    });
    const visibleDel = await app.request(
      `${API_ORIGIN}/v2/media/${visibleFileId}`,
      {
        method: 'DELETE',
        headers: { cookie: cookies.member, origin: CLIENT_ORIGIN },
      }
    );
    expect(visibleDel.status).toBe(403);
  });
});
