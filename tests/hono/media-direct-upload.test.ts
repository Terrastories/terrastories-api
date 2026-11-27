/**
 * Direct multipart media upload routes (#286): `api` mode over a stream-capable
 * in-memory storage (Node profiles) and `presigned` mode over a fake R2 bucket
 * plus a fake S3 endpoint that verifies the SigV4 URL (Workers profile).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { asc, eq } from 'drizzle-orm';
import {
  argon2Seed,
  makeDerivedKey,
  makeServerSecret,
} from './auth-test-utils.js';
import { tablesFor } from '../../src/db/dialect.js';
import { createHonoApp } from '../../src/hono-app.js';
import { HonoFoundationRepository } from '../../src/repositories/hono-foundation.repository.js';
import { MediaCleanupCoordinator } from '../../src/services/media-cleanup.service.js';
import { createR2Storage } from '../../src/worker.js';
import {
  StorageChecksumMismatchError,
  type FoundationStorage,
} from '../../src/services/hono-foundation.service.js';
import { deriveUserIdentityColumns } from '../../src/shared/utils/derived-columns.js';
import { validateContentFreeAuditEntry } from '../../src/shared/utils/audit-entry.js';
import { MediaUploadResponseSchema } from '../../src/shared/schemas/media-v2.js';
import { DirectUploadSessionResponseSchema } from '../../src/shared/schemas/media-uploads-v2.js';
import {
  FakeR2Bucket,
  handleFakeR2PartRequest,
  startFakeS3,
} from '../helpers/fake-r2-s3.js';

const MIB = 1024 * 1024;
const API = 'https://api.example.test';
const CLIENT = 'https://app.example.test';
const KEY = makeDerivedKey();

const sqlite = new Sqlite(':memory:');
sqlite.pragma('foreign_keys = ON');
const db = drizzle(sqlite);
const tables = tablesFor(db);

const sha256Hex = (b: Uint8Array) =>
  createHash('sha256').update(b).digest('hex');

/** Sparse video: a valid MP4 `ftyp` header and zeros (allocated lazily by the OS). */
function sparseMp4(size: number): Uint8Array {
  const bytes = new Uint8Array(Buffer.alloc(size));
  const header = [
    0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0,
    0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x31,
  ];
  bytes.set(header, 0);
  return bytes;
}

const partsOf = (bytes: Uint8Array, partSize: number) => {
  const out: Uint8Array[] = [];
  for (let at = 0; at < bytes.byteLength; at += partSize)
    out.push(bytes.subarray(at, Math.min(at + partSize, bytes.byteLength)));
  return out;
};

/** Stream-capable storage, like Node local disk (verifies sha256 on put). */
function createStreamStorage() {
  const store = new Map<string, Uint8Array>();
  const storage: FoundationStorage = {
    async read(key, range) {
      const bytes = store.get(key);
      if (!bytes) return null;
      return {
        size: bytes.byteLength,
        body: range ? bytes.subarray(range.start, range.end + 1) : bytes,
      };
    },
    async put(key, body, options) {
      const bytes =
        body instanceof Uint8Array
          ? body
          : new Uint8Array(await new Response(body).arrayBuffer());
      if (options?.sha256 && sha256Hex(bytes) !== options.sha256)
        throw new StorageChecksumMismatchError();
      store.set(key, bytes);
      return { size: bytes.byteLength };
    },
    async delete(key) {
      store.delete(key);
    },
  };
  return { store, storage };
}

const ids: Record<string, number> = {};
const mediaKeys = () =>
  [...apiStore.store.keys()].filter((k) => k.includes('/media/')).length;
const cookies: Record<string, string> = {};
let apiApp: ReturnType<typeof createHonoApp>;
let r2App: ReturnType<typeof createHonoApp>;
let unconfiguredApp: ReturnType<typeof createHonoApp>;
const apiStore = createStreamStorage();
const bucket = new FakeR2Bucket();
const s3Config = {
  accountId: randomBytes(8).toString('hex'),
  bucketName: 'media-test',
  accessKeyId: randomBytes(10).toString('hex'),
  secretAccessKey: randomBytes(20).toString('hex'),
};
let fakeS3: Awaited<ReturnType<typeof startFakeS3>>;

async function insert(table: any, values: any): Promise<number> {
  const [row] = await db
    .insert(table)
    .values(values)
    .returning({ id: table.id });
  return row.id as number;
}

async function login(app: typeof apiApp, email: string) {
  const res = await app.request(`${API}/v2/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: email, derivedKey: KEY }),
  });
  expect(res.status).toBe(200);
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

function createBody(
  bytes: Uint8Array,
  overrides: Record<string, unknown> = {}
) {
  const partSize = (overrides.partSize as number | undefined) ?? 16 * MIB;
  return {
    filename: 'field-recording.mp4',
    contentType: 'video/mp4',
    size: bytes.byteLength,
    sha256: sha256Hex(bytes),
    partSha256: partsOf(bytes, partSize).map(sha256Hex),
    ...overrides,
  };
}

const post = (
  app: typeof apiApp,
  path: string,
  cookie: string,
  body?: unknown
) =>
  app.request(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, origin: CLIENT },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function createSession(
  app: typeof apiApp,
  cookie: string,
  bytes: Uint8Array,
  overrides: Record<string, unknown> = {}
) {
  const res = await post(
    app,
    '/v2/media/uploads',
    cookie,
    createBody(bytes, overrides)
  );
  const json = (await res.json()) as any;
  return { res, json };
}

describe('direct multipart media upload (#286)', () => {
  beforeAll(async () => {
    migrate(db, { migrationsFolder: './src/db/migrations' });
    const now = new Date('2026-06-01T12:00:00.000Z');
    const seed = await argon2Seed(KEY);
    for (const [name, slug] of [
      ['Own', 'own'],
      ['Other', 'other'],
    ] as const) {
      ids[slug] = await insert(tables.communities, {
        name,
        slug,
        publicStories: true,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      });
    }
    const mk = async (
      email: string,
      role: string,
      communityId: number | null,
      first: string
    ) => {
      const d = deriveUserIdentityColumns({
        email,
        firstName: first,
        lastName: 'T',
        communityId,
      });
      return insert(tables.users, {
        email,
        emailNormalized: d.emailNormalized,
        ...seed,
        firstName: first,
        lastName: 'T',
        displayNameNormalized: d.displayNameNormalized,
        role,
        communityId,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      });
    };
    ids.editor = await mk('editor@own.test', 'editor', ids.own!, 'Ed');
    ids.editor2 = await mk('editor2@own.test', 'editor', ids.own!, 'Ed2');
    ids.admin = await mk('admin@own.test', 'admin', ids.own!, 'Ad');
    ids.viewer = await mk('viewer@own.test', 'viewer', ids.own!, 'Vi');
    ids.otherEditor = await mk('editor@other.test', 'editor', ids.other!, 'Oe');

    const common = {
      repository: new HonoFoundationRepository(db),
      serverSecret: makeServerSecret(),
      secureCookies: false,
      publicOrigin: API,
      corsOrigins: [CLIENT],
    };
    apiApp = createHonoApp({
      ...common,
      storage: apiStore.storage,
      mediaCleanup: new MediaCleanupCoordinator(db, apiStore.storage),
    });
    const r2Storage = createR2Storage(bucket.asR2Bucket(), s3Config);
    r2App = createHonoApp({
      ...common,
      storage: r2Storage,
      mediaCleanup: new MediaCleanupCoordinator(db, r2Storage),
    });
    const noS3 = createR2Storage(bucket.asR2Bucket());
    unconfiguredApp = createHonoApp({
      ...common,
      storage: noS3,
      mediaCleanup: new MediaCleanupCoordinator(db, noS3),
    });
    fakeS3 = await startFakeS3(bucket, s3Config);
    for (const [name, email] of [
      ['editor', 'editor@own.test'],
      ['editor2', 'editor2@own.test'],
      ['admin', 'admin@own.test'],
      ['viewer', 'viewer@own.test'],
      ['otherEditor', 'editor@other.test'],
    ] as const) {
      cookies[name] = await login(apiApp, email);
    }
  });

  afterAll(async () => {
    await fakeS3.close();
    sqlite.close();
  });

  describe('api mode (Node profiles)', () => {
    it('uploads a >100 MiB video through parts, verifies every digest, and creates the File row', async () => {
      const bytes = sparseMp4(101 * MIB + 5);
      const { res, json } = await createSession(apiApp, cookies.editor!, bytes);
      expect(res.status).toBe(201);
      const session = DirectUploadSessionResponseSchema.parse(json).data;
      expect(session.mode).toBe('api');
      expect(session.partCount).toBe(7);
      expect(session.maxBytes).toBe(512 * MIB);
      expect(JSON.stringify(json)).not.toContain('communities/');

      const chunks = partsOf(bytes, session.partSize);
      const etags: Array<{ partNumber: number; etag: string }> = [];
      for (const target of session.parts) {
        const body = chunks[target.partNumber - 1]!;
        const put = await apiApp.request(target.url, {
          method: 'PUT',
          headers: {
            ...target.headers,
            cookie: cookies.editor!,
            'content-length': String(body.byteLength),
          },
          body,
        });
        expect(put.status).toBe(200);
        const etag = put.headers.get('etag')!.replace(/"/g, '');
        expect(etag).toBe(sha256Hex(body));
        etags.push({ partNumber: target.partNumber, etag });
      }
      const done = await post(
        apiApp,
        `/v2/media/uploads/${session.id}/complete`,
        cookies.editor!,
        { parts: etags }
      );
      expect(done.status).toBe(201);
      const file = MediaUploadResponseSchema.parse(await done.json()).data;
      expect(file.byteSize).toBe(bytes.byteLength);
      expect(file.checksum).toBe(sha256Hex(bytes));
      expect(file.mimeType).toBe('video/mp4');
      const stored = [...apiStore.store.entries()].find(([k]) =>
        k.endsWith(file.id)
      );
      expect(stored?.[1].byteLength).toBe(bytes.byteLength);
      // Journal and staged parts are gone once the row exists.
      expect(
        [...apiStore.store.keys()].filter((k) => k.includes('.multipart/'))
      ).toEqual([]);
      // A finished session replays as a stable conflict, never a duplicate.
      const again = await post(
        apiApp,
        `/v2/media/uploads/${session.id}/complete`,
        cookies.editor!,
        { parts: etags }
      );
      expect(again.status).toBe(409);
      expect(await again.json()).toEqual({ error: 'Conflict' });
    });

    it('keeps request metadata through completion', async () => {
      const bytes = sparseMp4(1024);
      const { res, json } = await createSession(
        apiApp,
        cookies.editor!,
        bytes,
        {
          metadata: { caption: 'River', year: 1987, public: true },
        }
      );
      expect(res.status).toBe(201);
      const session = DirectUploadSessionResponseSchema.parse(json).data;
      const target = session.parts[0]!;
      const put = await apiApp.request(target.url, {
        method: 'PUT',
        headers: {
          ...target.headers,
          cookie: cookies.editor!,
          'content-length': String(bytes.byteLength),
        },
        body: bytes,
      });
      expect(put.status).toBe(200);
      const etag = put.headers.get('etag')!.replace(/"/g, '');
      const done = await post(
        apiApp,
        `/v2/media/uploads/${session.id}/complete`,
        cookies.editor!,
        { parts: [{ partNumber: 1, etag }] }
      );
      expect(done.status).toBe(201);
      const file = MediaUploadResponseSchema.parse(await done.json()).data;
      const meta = await apiApp.request(`${API}/v2/media/${file.id}/metadata`, {
        headers: { cookie: cookies.editor! },
      });
      expect(meta.status).toBe(200);
      const body = (await meta.json()) as { data: { metadata: unknown } };
      expect(body.data.metadata).toEqual({
        caption: 'River',
        year: 1987,
        public: true,
      });
    });

    it('rejects part uploads that do not match the declared size or digest', async () => {
      const bytes = sparseMp4(17 * MIB);
      const { json } = await createSession(apiApp, cookies.editor!, bytes);
      const session = DirectUploadSessionResponseSchema.parse(json).data;
      const first = session.parts[0]!;
      const chunk = partsOf(bytes, session.partSize)[0]!;
      const send = (headers: Record<string, string>, body: Uint8Array) =>
        apiApp.request(first.url, {
          method: 'PUT',
          headers: { cookie: cookies.editor!, ...headers },
          body,
        });
      expect(
        (
          await send(
            {
              ...first.headers,
              'content-length': String(chunk.byteLength - 1),
            },
            chunk.subarray(1)
          )
        ).status
      ).toBe(400);
      expect(
        (await send({ 'content-length': String(chunk.byteLength) }, chunk))
          .status
      ).toBe(400);
      const corrupted = chunk.slice();
      corrupted[100] = 7;
      expect(
        (
          await send(
            {
              ...first.headers,
              'content-length': String(corrupted.byteLength),
            },
            corrupted
          )
        ).status
      ).toBe(422);
      // An admin may abort a session but never write parts into it.
      const adminPut = await apiApp.request(first.url, {
        method: 'PUT',
        headers: {
          ...first.headers,
          cookie: cookies.admin!,
          'content-length': String(chunk.byteLength),
        },
        body: chunk,
      });
      expect(adminPut.status).toBe(404);
      // Another editor cannot use the session, and a missing part fails completion.
      const foreign = await apiApp.request(first.url, {
        method: 'PUT',
        headers: {
          ...first.headers,
          cookie: cookies.editor2!,
          'content-length': String(chunk.byteLength),
        },
        body: chunk,
      });
      expect(foreign.status).toBe(404);
      const incomplete = await post(
        apiApp,
        `/v2/media/uploads/${session.id}/complete`,
        cookies.editor!,
        {
          parts: [{ partNumber: 1, etag: sha256Hex(chunk) }],
        }
      );
      expect(incomplete.status).toBe(400);
      expect(
        (
          await apiApp.request(`${API}/v2/media/uploads/${session.id}`, {
            method: 'DELETE',
            headers: { cookie: cookies.editor! },
          })
        ).status
      ).toBe(204);
    });

    it('rejects a whole-file digest that the assembled bytes do not match and leaves nothing staged', async () => {
      const bytes = sparseMp4(17 * MIB);
      const { json } = await createSession(apiApp, cookies.editor!, bytes, {
        sha256: 'ab'.repeat(32),
      });
      const session = DirectUploadSessionResponseSchema.parse(json).data;
      const chunks = partsOf(bytes, session.partSize);
      const etags = [];
      for (const target of session.parts) {
        const body = chunks[target.partNumber - 1]!;
        const put = await apiApp.request(target.url, {
          method: 'PUT',
          headers: {
            ...target.headers,
            cookie: cookies.editor!,
            'content-length': String(body.byteLength),
          },
          body,
        });
        etags.push({
          partNumber: target.partNumber,
          etag: put.headers.get('etag')!.replace(/"/g, ''),
        });
      }
      const done = await post(
        apiApp,
        `/v2/media/uploads/${session.id}/complete`,
        cookies.editor!,
        { parts: etags }
      );
      expect(done.status).toBe(422);
      const leftovers = [...apiStore.store.keys()].filter(
        (k) => k.includes(`${session.id}`) || k.endsWith(session.id)
      );
      expect(leftovers).toEqual([]);
    });

    it('rejects bytes whose signature does not match the declared type and cleans up', async () => {
      const before = mediaKeys();
      const bytes = new Uint8Array(Buffer.alloc(17 * MIB, 1));
      const { json } = await createSession(apiApp, cookies.editor!, bytes);
      const session = DirectUploadSessionResponseSchema.parse(json).data;
      const chunks = partsOf(bytes, session.partSize);
      const etags = [];
      for (const target of session.parts) {
        const body = chunks[target.partNumber - 1]!;
        const put = await apiApp.request(target.url, {
          method: 'PUT',
          headers: {
            ...target.headers,
            cookie: cookies.editor!,
            'content-length': String(body.byteLength),
          },
          body,
        });
        etags.push({
          partNumber: target.partNumber,
          etag: put.headers.get('etag')!.replace(/"/g, ''),
        });
      }
      const done = await post(
        apiApp,
        `/v2/media/uploads/${session.id}/complete`,
        cookies.editor!,
        { parts: etags }
      );
      expect(done.status).toBe(400);
      expect(mediaKeys()).toBe(before);
    });

    it('applies POST /v2/media authorization, type, role and cap rules at create', async () => {
      const bytes = sparseMp4(17 * MIB);
      expect(
        (await createSession(apiApp, cookies.viewer!, bytes)).res.status
      ).toBe(403);
      expect(
        (
          await createSession(apiApp, cookies.editor!, bytes, {
            role: 'story_media',
          })
        ).res.status
      ).toBe(400);
      expect(
        (
          await createSession(apiApp, cookies.editor!, bytes, {
            role: 'user_photo',
          })
        ).res.status
      ).toBe(400);
      expect(
        (
          await createSession(apiApp, cookies.editor!, bytes, {
            role: 'user_photo',
            ownerId: ids.admin,
          })
        ).res.status
      ).toBe(403);
      expect(
        (
          await createSession(apiApp, cookies.editor!, bytes, {
            contentType: 'text/html',
          })
        ).res.status
      ).toBe(400);
      expect(
        (
          await createSession(apiApp, cookies.editor!, bytes, {
            filename: 'clip.webm',
          })
        ).res.status
      ).toBe(400);
      expect(
        (
          await createSession(apiApp, cookies.editor!, bytes, {
            partSize: 1 * MIB,
          })
        ).res.status
      ).toBe(400);
      expect(
        (
          await createSession(apiApp, cookies.editor!, bytes, {
            partSha256: ['aa'.repeat(32)],
          })
        ).res.status
      ).toBe(400);
      const unauth = await apiApp.request(`${API}/v2/media/uploads`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(unauth.status).toBe(401);
      // Caps: video 512 MiB, audio 200 MiB (declared sizes; no bytes are sent).
      const over = (size: number, extra: Record<string, unknown>) =>
        post(apiApp, '/v2/media/uploads', cookies.editor!, {
          filename: 'a.mp4',
          contentType: 'video/mp4',
          size,
          sha256: 'cd'.repeat(32),
          partSha256: Array.from({ length: Math.ceil(size / (16 * MIB)) }, () =>
            'ef'.repeat(32)
          ),
          ...extra,
        });
      expect((await over(512 * MIB + 1, {})).status).toBe(413);
      expect(
        (
          await over(200 * MIB + 1, {
            filename: 'a.mp3',
            contentType: 'audio/mpeg',
          })
        ).status
      ).toBe(413);
      expect(
        (await over(11 * MIB, { filename: 'a.png', contentType: 'image/png' }))
          .status
      ).toBe(413);
      const ok = await over(512 * MIB, {});
      expect(ok.status).toBe(201);
      const okSession = DirectUploadSessionResponseSchema.parse(
        await ok.json()
      ).data;
      expect(okSession.partCount).toBe(32);
      await apiApp.request(`${API}/v2/media/uploads/${okSession.id}`, {
        method: 'DELETE',
        headers: { cookie: cookies.editor! },
      });
    });

    it('aborts, expires and isolates sessions across tenants', async () => {
      const bytes = sparseMp4(17 * MIB);
      const { json } = await createSession(apiApp, cookies.editor!, bytes);
      const id = DirectUploadSessionResponseSchema.parse(json).data.id;
      const del = (cookie: string) =>
        apiApp.request(`${API}/v2/media/uploads/${id}`, {
          method: 'DELETE',
          headers: { cookie },
        });
      expect((await del(cookies.otherEditor!)).status).toBe(404);
      expect((await del(cookies.editor2!)).status).toBe(404);
      // An admin of the same community may abort a stale session.
      expect((await del(cookies.admin!)).status).toBe(204);
      expect((await del(cookies.editor!)).status).toBe(404);

      const second = DirectUploadSessionResponseSchema.parse(
        (await createSession(apiApp, cookies.editor!, bytes)).json
      ).data;
      const journalKey = [...apiStore.store.keys()].find((k) =>
        k.endsWith(`${second.id}.json`)
      )!;
      const session = JSON.parse(
        new TextDecoder().decode(apiStore.store.get(journalKey))
      );
      session.expiresAt = Date.now() - 60 * 60 * 1000; // past the 15 min completion grace
      apiStore.store.set(
        journalKey,
        new TextEncoder().encode(JSON.stringify(session))
      );
      const expired = await post(
        apiApp,
        `/v2/media/uploads/${second.id}/complete`,
        cookies.editor!,
        {
          parts: [{ partNumber: 1, etag: 'x' }],
        }
      );
      expect(expired.status).toBe(410);
      expect(apiStore.store.has(journalKey)).toBe(false);
    });

    it('records content-free audit entries for session create and abort', async () => {
      const rows = await db
        .select()
        .from(tables.auditEntries)
        .where(eq(tables.auditEntries.resourceType, 'file'))
        .orderBy(asc(tables.auditEntries.id));
      const actions = rows.map((r) => r.action);
      expect(actions).toContain('media.upload.session');
      expect(actions).toContain('media.upload.abort');
      expect(actions).toContain('media.upload');
      for (const row of rows) {
        expect(() =>
          validateContentFreeAuditEntry({
            communityId: row.communityId,
            actorId: row.actorId,
            action: row.action,
            resourceType: row.resourceType,
            resourceIds: (typeof row.resourceIds === 'string'
              ? JSON.parse(row.resourceIds)
              : row.resourceIds) as string[],
            outcome: row.outcome as 'success' | 'denied',
            ipAddress: row.ipAddress,
            userAgent: row.userAgent,
          })
        ).not.toThrow();
        expect(JSON.stringify(row)).not.toMatch(
          /field-recording|communities\//
        );
      }
    });
  });

  describe('presigned mode (Workers profile over fake R2 + fake S3)', () => {
    it('uploads a >100 MiB video straight to the S3 endpoint and completes via the binding', async () => {
      const bytes = sparseMp4(101 * MIB + 5);
      const { res, json } = await createSession(r2App, cookies.editor!, bytes);
      expect(res.status).toBe(201);
      const session = DirectUploadSessionResponseSchema.parse(json).data;
      expect(session.mode).toBe('presigned');
      const chunks = partsOf(bytes, session.partSize);
      expect(
        session.parts[0]!.url.startsWith(
          `https://${s3Config.accountId}.r2.cloudflarestorage.com/media-test/communities/${ids.own}/media/`
        )
      ).toBe(true);
      expect(
        new URL(session.parts[0]!.url).searchParams.get('X-Amz-Expires')
      ).toBe('7200');
      const etags = [];
      for (const target of session.parts) {
        const body = chunks[target.partNumber - 1]!;
        const put = await fakeS3.putPart(target, body);
        expect(put.status).toBe(200);
        etags.push({ partNumber: target.partNumber, etag: put.etag! });
      }
      const done = await post(
        r2App,
        `/v2/media/uploads/${session.id}/complete`,
        cookies.editor!,
        { parts: etags }
      );
      expect(done.status).toBe(201);
      const file = MediaUploadResponseSchema.parse(await done.json()).data;
      expect(file.byteSize).toBe(bytes.byteLength);
      // Not server-verified on Workers, so never stored as a checksum.
      expect(file.checksum).toBeNull();
      const object = await bucket.head(
        `communities/${ids.own}/media/${file.id}`
      );
      expect(object?.size).toBe(bytes.byteLength);
      expect(
        [...bucket.objects.keys()].filter((k) => k.includes('.multipart/'))
      ).toEqual([]);
      const replay = await post(
        r2App,
        `/v2/media/uploads/${session.id}/complete`,
        cookies.editor!,
        { parts: etags }
      );
      expect(replay.status).toBe(409);
      expect(await replay.json()).toEqual({ error: 'Conflict' });
      expect(
        (await bucket.head(`communities/${ids.own}/media/${file.id}`))?.size
      ).toBe(bytes.byteLength);
      // The API part route is api-mode only.
      const apiPart = await r2App.request(
        `${API}/v2/media/uploads/${session.id}/parts/1`,
        {
          method: 'PUT',
          headers: { cookie: cookies.editor! },
          body: new Uint8Array(1),
        }
      );
      expect(apiPart.status).toBe(404);
    });

    it('avoids R2 UploadPart 501 and rejects tampered URLs and wrong bodies', async () => {
      const bytes = sparseMp4(17 * MIB);
      const { json } = await createSession(r2App, cookies.editor!, bytes);
      const session = DirectUploadSessionResponseSchema.parse(json).data;
      const target = session.parts[0]!;
      const chunk = partsOf(bytes, session.partSize)[0]!;
      const tampered = {
        ...target,
        url: target.url.replace('partNumber=1', 'partNumber=2'),
      };
      expect((await fakeS3.putPart(tampered, chunk)).status).toBe(403);
      // The signed Content-Length binds the part size.
      expect((await fakeS3.putPart(target, chunk.subarray(1))).status).toBe(
        403
      );
      expect(target.headers).toEqual({
        'x-amz-content-sha256': sha256Hex(chunk),
      });
      expect(new URL(target.url).searchParams.get('X-Amz-SignedHeaders')).toBe(
        'content-length;host;x-amz-content-sha256'
      );
      const corrupted = chunk.slice();
      corrupted[0] ^= 1;
      expect((await fakeS3.putPart(target, corrupted)).status).toBe(400);
      expect((await fakeS3.putPart(target, chunk)).status).toBe(200);
      // Completion with a part never uploaded fails and keeps the session retryable.
      const incomplete = await post(
        r2App,
        `/v2/media/uploads/${session.id}/complete`,
        cookies.editor!,
        {
          parts: session.parts.map((p) => ({
            partNumber: p.partNumber,
            etag: 'nope',
          })),
        }
      );
      expect(incomplete.status).toBe(400);
      expect(
        (
          await r2App.request(`${API}/v2/media/uploads/${session.id}`, {
            method: 'DELETE',
            headers: { cookie: cookies.editor! },
          })
        ).status
      ).toBe(204);
      expect(
        [...bucket.uploads.keys()].includes(
          new URL(target.url).searchParams.get('uploadId')!
        )
      ).toBe(false);
      expect(
        [...bucket.objects.keys()].filter((k) =>
          k.endsWith(`${session.id}.json`)
        )
      ).toEqual([]);
    });

    it('deletes the object and answers 422 when the assembled size differs from the session', async () => {
      const declared = sparseMp4(17 * MIB);
      const { json } = await createSession(r2App, cookies.editor!, declared);
      const session = DirectUploadSessionResponseSchema.parse(json).data;
      // Upload a shorter last part straight into the bucket (a client that
      // ignores the signed Content-Length): totals no longer match.
      const upload = bucket.resumeMultipartUpload(
        [...bucket.uploads.values()].at(-1)!.key,
        [...bucket.uploads.keys()].at(-1)!
      );
      const p1 = await upload.uploadPart(1, declared.subarray(0, 16 * MIB));
      const p2 = await upload.uploadPart(
        2,
        declared.subarray(16 * MIB, 16 * MIB + 10)
      );
      const done = await post(
        r2App,
        `/v2/media/uploads/${session.id}/complete`,
        cookies.editor!,
        {
          parts: [p1, p2].map((p) => ({
            partNumber: p.partNumber,
            etag: p.etag,
          })),
        }
      );
      expect(done.status).toBe(422);
      expect(
        [...bucket.objects.keys()].filter((k) => k.includes('/media/'))
      ).toHaveLength(1);
    });

    const uploadAllParts = async (
      app: typeof apiApp,
      bytes: Uint8Array,
      overrides: Record<string, unknown> = {}
    ) => {
      const { json } = await createSession(
        app,
        cookies.editor!,
        bytes,
        overrides
      );
      const session = DirectUploadSessionResponseSchema.parse(json).data;
      const chunks = partsOf(bytes, session.partSize);
      const etags: Array<{ partNumber: number; etag: string }> = [];
      for (const target of session.parts) {
        const put = await fakeS3.putPart(
          target,
          chunks[target.partNumber - 1]!
        );
        expect(put.status).toBe(200);
        etags.push({ partNumber: target.partNumber, etag: put.etag! });
      }
      const first = new URL(session.parts[0]!.url);
      return {
        session,
        etags,
        key: decodeURIComponent(first.pathname).replace('/media-test/', ''),
        uploadId: first.searchParams.get('uploadId')!,
      };
    };

    it('stores a null checksum for a false client digest so exports can never fail on it', async () => {
      const bytes = sparseMp4(17 * MIB);
      const { session, etags } = await uploadAllParts(r2App, bytes, {
        sha256: 'ab'.repeat(32),
      });
      const done = await post(
        r2App,
        `/v2/media/uploads/${session.id}/complete`,
        cookies.editor!,
        { parts: etags }
      );
      expect(done.status).toBe(201);
      const file = MediaUploadResponseSchema.parse(await done.json()).data;
      expect(file.checksum).toBeNull();
      // Export streams the bytes and records the digest it computes itself;
      // a null expected checksum skips the claim comparison.
      const [row] = await db
        .select({ checksum: tables.files.checksum })
        .from(tables.files)
        .where(eq(tables.files.id, file.id));
      expect(row?.checksum).toBeNull();
    });

    it('a retried complete or an abort racing a finished completion never deletes the object', async () => {
      const bytes = sparseMp4(17 * MIB);
      const { session, etags, key, uploadId } = await uploadAllParts(
        r2App,
        bytes
      );
      // The winning completion has finished in R2 but has not created its row.
      await bucket.resumeMultipartUpload(key, uploadId).complete(etags);
      expect(bucket.objects.has(key)).toBe(true);
      const retried = await post(
        r2App,
        `/v2/media/uploads/${session.id}/complete`,
        cookies.editor!,
        { parts: etags }
      );
      expect(retried.status).toBe(400);
      expect(bucket.objects.has(key)).toBe(true);
      const aborted = await r2App.request(
        `${API}/v2/media/uploads/${session.id}`,
        { method: 'DELETE', headers: { cookie: cookies.editor! } }
      );
      expect(aborted.status).toBe(204);
      expect(bucket.objects.has(key)).toBe(true);
    });

    it('rejects an expired signed part PUT and accepts it before expiry', async () => {
      const bytes = sparseMp4(1024);
      const { res, json } = await createSession(r2App, cookies.editor!, bytes);
      expect(res.status).toBe(201);
      const session = DirectUploadSessionResponseSchema.parse(json).data;
      const target = session.parts[0]!;
      const url = new URL(target.url);
      const request = {
        method: 'PUT',
        url,
        header: (name: string) =>
          name === 'content-length'
            ? String(bytes.byteLength)
            : (target.headers[name] ?? ''),
        body: bytes,
      };
      // SigV4 timestamps have second precision.
      const expiresAt = Math.floor(Date.parse(session.expiresAt) / 1000) * 1000;
      const put = (now: number) =>
        handleFakeR2PartRequest(
          bucket,
          { ...s3Config, now: () => now },
          request
        );

      const expired = await put(expiresAt + 1000);
      expect(expired.status).toBe(403);
      expect(expired.body).toContain('<Code>AccessDenied</Code>');
      expect(expired.body).toContain('<Message>Request has expired</Message>');
      expect((await put(expiresAt - 1000)).status).toBe(200);
      await r2App.request(`${API}/v2/media/uploads/${session.id}`, {
        method: 'DELETE',
        headers: { cookie: cookies.editor! },
      });
    });

    it('re-issues part targets within the session lifetime and refuses other users', async () => {
      const bytes = sparseMp4(17 * MIB);
      const { json } = await createSession(r2App, cookies.editor!, bytes);
      const session = DirectUploadSessionResponseSchema.parse(json).data;
      const again = await post(
        r2App,
        `/v2/media/uploads/${session.id}/parts/presign`,
        cookies.editor!
      );
      expect(again.status).toBe(200);
      const reissued = DirectUploadSessionResponseSchema.parse(
        await again.json()
      ).data;
      expect(reissued.parts).toHaveLength(session.parts.length);
      expect(Date.parse(reissued.expiresAt)).toBeGreaterThanOrEqual(
        Date.parse(session.expiresAt)
      );
      expect(
        (
          await post(
            r2App,
            `/v2/media/uploads/${session.id}/parts/presign`,
            cookies.editor2!
          )
        ).status
      ).toBe(404);
      await r2App.request(`${API}/v2/media/uploads/${session.id}`, {
        method: 'DELETE',
        headers: { cookie: cookies.editor! },
      });
    });

    it('answers 501 when R2 S3 credentials are not configured', async () => {
      const bytes = sparseMp4(17 * MIB);
      expect(
        (await createSession(unconfiguredApp, cookies.editor!, bytes)).res
          .status
      ).toBe(501);
      expect(
        (
          await post(
            unconfiguredApp,
            `/v2/media/uploads/${crypto.randomUUID()}/complete`,
            cookies.editor!,
            { parts: [{ partNumber: 1, etag: 'x' }] }
          )
        ).status
      ).toBe(501);
    });

    it('refuses to create or complete once the community storage is fenced for erasure', async () => {
      const bytes = sparseMp4(17 * MIB);
      const ok = await createSession(r2App, cookies.editor!, bytes);
      expect(ok.res.status).toBe(201);
      await bucket.put(`system/erasure-fences/${ids.own}`, new Uint8Array(0));
      try {
        expect(
          (await createSession(r2App, cookies.editor!, bytes)).res.status
        ).toBe(500);
        const id = ok.json.data.id as string;
        const done = await post(
          r2App,
          `/v2/media/uploads/${id}/complete`,
          cookies.editor!,
          {
            parts: [
              { partNumber: 1, etag: 'x' },
              { partNumber: 2, etag: 'y' },
            ],
          }
        );
        expect(done.status).toBe(500);
      } finally {
        await bucket.delete(`system/erasure-fences/${ids.own}`);
      }
    });
  });

  describe('sweeper abort failures (#287 review)', () => {
    it('keeps a journal whose abort keeps failing, marks it abandoned and never forgets it', async () => {
      const failing = new FakeR2Bucket();
      const storage = createR2Storage(failing.asR2Bucket());
      const journalKey = 'communities/1/.multipart/stuck.json';
      const key = 'communities/1/media/stuck';
      await failing.put(journalKey, JSON.stringify({ key, uploadId: 'up-1' }));
      failing.resumeMultipartUpload = () =>
        ({
          abort: async () => {
            throw new Error('R2 unavailable');
          },
        }) as never;
      for (let i = 0; i < 7; i++) {
        await expect(storage.delete!(journalKey)).rejects.toThrow();
      }
      const journal = JSON.parse(
        new TextDecoder().decode(failing.objects.get(journalKey))
      );
      expect(journal.abortAttempts).toBe(7);
      expect(journal.abandoned).toBe(true);
      expect(journal.uploadId).toBe('up-1');
    });
  });
});
