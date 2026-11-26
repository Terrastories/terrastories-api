/**
 * Role-by-route matrix, part B (audit #145/#146 rows 54-66): public media,
 * media metadata/delete, direct upload sessions, raw media upload and
 * attachments. Denied cells assert the exact status and that the stored
 * files/attachments are unchanged after the denied write.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { tablesFor } from '../../src/db/dialect.js';
import { createHonoApp } from '../../src/hono-app.js';
import { HonoFoundationRepository } from '../../src/repositories/hono-foundation.repository.js';
import { StorageChecksumMismatchError } from '../../src/services/hono-foundation.service.js';
import { deriveUserIdentityColumns } from '../../src/shared/utils/derived-columns.js';
import {
  argon2Seed,
  makeDerivedKey,
  makeServerSecret,
} from './auth-test-utils.js';
import { rawUploadRequest } from '../helpers/raw-upload.js';

const API = 'https://api.example.test';
const CLIENT = 'https://app.example.test';
const MIB = 1024 * 1024;
const KEY = makeDerivedKey();
const PNG = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64'
  )
);
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
/** A small MP4-shaped session body: an ftyp header and zeros, one part. */
const MP4 = (() => {
  const b = new Uint8Array(64 * 1024);
  b.set(
    [
      0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0,
      0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x31,
    ],
    0
  );
  return b;
})();

type Role =
  | 'anon'
  | 'viewer'
  | 'member'
  | 'editor'
  | 'editor2'
  | 'admin'
  | 'super_admin'
  | 'foreign_admin';
type Ctx = Awaited<ReturnType<typeof setup>>;

function memoryStorage() {
  const store = new Map<string, Uint8Array>();
  return {
    store,
    storage: {
      async fenceCommunity() {},
      async read(key: string) {
        const body = store.get(key);
        return body ? { size: body.byteLength, body } : null;
      },
      async put(
        key: string,
        body: Uint8Array | ReadableStream,
        options?: { sha256?: string }
      ) {
        const bytes =
          body instanceof Uint8Array
            ? body
            : new Uint8Array(await new Response(body).arrayBuffer());
        if (options?.sha256 && sha(bytes) !== options.sha256)
          throw new StorageChecksumMismatchError();
        store.set(key, bytes);
        return { size: bytes.byteLength };
      },
      async delete(key: string) {
        store.delete(key);
      },
      async list() {
        return { entries: [], truncated: false };
      },
    },
  };
}

async function setup() {
  const sqlite = new Sqlite(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: 'src/db/migrations' });
  const tables = tablesFor(db);
  const now = new Date('2026-06-01T12:00:00.000Z');
  const seed = await argon2Seed(KEY);

  const communities = await db
    .insert(tables.communities)
    .values([
      {
        name: 'Own Media',
        slug: 'own-media',
        publicStories: true,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        name: 'Other Media',
        slug: 'other-media',
        publicStories: true,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      },
    ])
    .returning({ id: tables.communities.id });
  const ownId = communities[0]!.id;
  const otherId = communities[1]!.id;

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
    const [row] = await db
      .insert(tables.users)
      .values({
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
      })
      .returning({ id: tables.users.id });
    return { id: row!.id, email };
  };
  const users: Record<Exclude<Role, 'anon'>, { id: number; email: string }> = {
    editor: await mk('editor@own-media.test', 'editor', ownId, 'Ed'),
    editor2: await mk('editor2@own-media.test', 'editor', ownId, 'Ed2'),
    viewer: await mk('viewer@own-media.test', 'viewer', ownId, 'Vi'),
    member: await mk('member@own-media.test', 'member', ownId, 'Me'),
    admin: await mk('admin@own-media.test', 'admin', ownId, 'Ad'),
    super_admin: await mk('super@media.test', 'super_admin', null, 'Su'),
    foreign_admin: await mk('admin@other-media.test', 'admin', otherId, 'Fa'),
  };

  const mem = memoryStorage();
  const app = createHonoApp({
    repository: new HonoFoundationRepository(db),
    storage: mem.storage,
    serverSecret: makeServerSecret(),
    secureCookies: false,
    publicOrigin: API,
    corsOrigins: [CLIENT],
  } as never);

  const login = async (role: Exclude<Role, 'anon'>) => {
    const res = await app.request(`${API}/v2/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: users[role].email, derivedKey: KEY }),
    });
    if (res.status !== 200) throw new Error(`login ${role} -> ${res.status}`);
    return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  };

  const call = (
    method: string,
    path: string,
    cookie?: string,
    body?: unknown,
    raw?: { body: Uint8Array; headers: Record<string, string> }
  ) => {
    const headers: Record<string, string> = {
      origin: CLIENT,
      ...(raw?.headers ?? {}),
    };
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    return app.request(`${API}${path}`, {
      method,
      headers,
      body: raw
        ? raw.body
        : body !== undefined
          ? JSON.stringify(body)
          : undefined,
    });
  };

  const upload = async (cookie: string) => {
    const req = rawUploadRequest({
      filename: 'photo.png',
      contentType: 'image/png',
      bytes: PNG,
    });
    const res = await call(
      'POST',
      `/v2/media${req.search}`,
      cookie,
      undefined,
      req
    );
    if (res.status !== 201) throw new Error(`upload -> ${res.status}`);
    return ((await res.json()) as { data: { id: string } }).data.id;
  };

  const story = await db
    .insert(tables.stories)
    .values({
      title: 'Matrix Story',
      slug: 'matrix-story',
      privacyLevel: 'public',
      isRestricted: false,
      communityId: ownId,
      createdBy: users.editor.id,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: tables.stories.id });

  const snapshot = async () =>
    JSON.stringify({
      files: await db.select().from(tables.files),
      attachments: await db.select().from(tables.attachments),
    });

  return {
    db,
    tables,
    app,
    call,
    login,
    upload,
    snapshot,
    storyId: story[0]!.id,
    mem,
  };
}

type Cell = Partial<Record<Role, number>>;
type Route = {
  name: string;
  expect: Cell;
  /** Setup by the owner (editor); returns ids used by the request. */
  prepare: (
    ctx: Ctx
  ) => Promise<{ id?: string | number; ownerId?: number; storyId?: number }>;
  send: (
    ctx: Ctx,
    role: Role,
    cookie: string | undefined,
    p: { id?: string | number; storyId?: number }
  ) => Promise<Response>;
};

const DEL = (path: string, ctx: Ctx, cookie?: string) =>
  ctx.call('DELETE', path, cookie);

const ROUTES: Route[] = [
  {
    name: 'POST /v2/media/uploads',
    expect: {
      anon: 401,
      viewer: 403,
      member: 403,
      editor: 201,
      admin: 201,
      super_admin: 403,
    },
    prepare: async () => ({}),
    send: (ctx, _role, cookie) => {
      const body = {
        filename: 'clip.mp4',
        contentType: 'video/mp4',
        size: MP4.byteLength,
        sha256: sha(MP4),
        partSize: 16 * MIB,
        partSha256: [sha(MP4)],
      };
      return ctx.call('POST', '/v2/media/uploads', cookie, body);
    },
  },
  {
    name: 'DELETE /v2/media/uploads/:id',
    expect: {
      anon: 401,
      editor: 204,
      editor2: 404,
      admin: 204,
      super_admin: 404,
      foreign_admin: 404,
    },
    prepare: async (ctx) => {
      const res = await ctx.call(
        'POST',
        '/v2/media/uploads',
        await ctx.login('editor'),
        {
          filename: 'clip.mp4',
          contentType: 'video/mp4',
          size: MP4.byteLength,
          sha256: sha(MP4),
          partSize: 16 * MIB,
          partSha256: [sha(MP4)],
        }
      );
      if (res.status !== 201) throw new Error(`session -> ${res.status}`);
      return { id: ((await res.json()) as { data: { id: string } }).data.id };
    },
    send: (ctx, _role, cookie, p) =>
      DEL(`/v2/media/uploads/${p.id}`, ctx, cookie),
  },
  {
    name: 'POST /v2/media',
    expect: {
      anon: 401,
      viewer: 403,
      member: 403,
      editor: 201,
      admin: 201,
      super_admin: 403,
    },
    prepare: async () => ({}),
    send: (ctx, _role, cookie) => {
      const req = rawUploadRequest({
        filename: 'photo.png',
        contentType: 'image/png',
        bytes: PNG,
      });
      return ctx.call('POST', `/v2/media${req.search}`, cookie, undefined, req);
    },
  },
  {
    name: 'DELETE /v2/media/:id',
    expect: {
      anon: 401,
      viewer: 404,
      member: 404,
      editor2: 404,
      editor: 204,
      super_admin: 404,
      foreign_admin: 404,
    },
    prepare: async (ctx) => ({
      id: await ctx.upload(await ctx.login('editor')),
    }),
    send: (ctx, _role, cookie, p) => DEL(`/v2/media/${p.id}`, ctx, cookie),
  },
  {
    name: 'GET /v2/media/:id/metadata',
    expect: {
      anon: 401,
      viewer: 404,
      member: 404,
      editor: 200,
      editor2: 404,
      super_admin: 404,
      foreign_admin: 404,
    },
    prepare: async (ctx) => ({
      id: await ctx.upload(await ctx.login('editor')),
    }),
    send: (ctx, _role, cookie, p) =>
      ctx.call('GET', `/v2/media/${p.id}/metadata`, cookie),
  },
  {
    name: 'POST /v2/attachments',
    expect: {
      anon: 401,
      viewer: 403,
      member: 403,
      editor: 201,
      admin: 201,
      super_admin: 403,
      foreign_admin: 404,
    },
    prepare: async (ctx) => ({
      id: await ctx.upload(await ctx.login('editor')),
      storyId: ctx.storyId,
    }),
    send: (ctx, _role, cookie, p) =>
      ctx.call('POST', '/v2/attachments', cookie, {
        fileId: p.id,
        ownerType: 'story',
        ownerId: p.storyId,
        role: 'story_media',
      }),
  },
  {
    name: 'PATCH /v2/attachments/reorder',
    expect: {
      anon: 401,
      viewer: 403,
      member: 403,
      editor: 200,
      admin: 200,
      super_admin: 403,
      foreign_admin: 404,
    },
    prepare: async (ctx) => {
      const cookie = await ctx.login('editor');
      const ids: string[] = [];
      for (let i = 0; i < 2; i++) {
        const fileId = await ctx.upload(cookie);
        const res = await ctx.call('POST', '/v2/attachments', cookie, {
          fileId,
          ownerType: 'story',
          ownerId: ctx.storyId,
          role: 'story_media',
        });
        if (res.status !== 201) throw new Error(`attach -> ${res.status}`);
        ids.push(((await res.json()) as { data: { id: string } }).data.id);
      }
      return { id: ids.join(','), storyId: ctx.storyId };
    },
    send: (ctx, _role, cookie, p) => {
      const [a1, a2] = String(p.id).split(',');
      return ctx.call('PATCH', '/v2/attachments/reorder', cookie, {
        ownerType: 'story',
        ownerId: p.storyId,
        role: 'story_media',
        attachmentIds: [Number(a2), Number(a1)],
      });
    },
  },
  {
    name: 'DELETE /v2/attachments/:id',
    expect: {
      anon: 401,
      viewer: 403,
      member: 403,
      editor: 204,
      admin: 204,
      super_admin: 403,
      foreign_admin: 404,
    },
    prepare: async (ctx) => {
      const cookie = await ctx.login('editor');
      const fileId = await ctx.upload(cookie);
      const res = await ctx.call('POST', '/v2/attachments', cookie, {
        fileId,
        ownerType: 'story',
        ownerId: ctx.storyId,
        role: 'story_media',
      });
      if (res.status !== 201) throw new Error(`attach -> ${res.status}`);
      return { id: ((await res.json()) as { data: { id: string } }).data.id };
    },
    send: (ctx, _role, cookie, p) =>
      DEL(`/v2/attachments/${p.id}`, ctx, cookie),
  },
];

const MATRIX = ROUTES.flatMap((route) =>
  (Object.keys(route.expect) as Role[]).map((role) => ({ route, role }))
);

describe('role matrix B: media, upload sessions and attachments', () => {
  it.each(MATRIX.map((c) => [`${c.route.name} as ${c.role}`, c] as const))(
    '%s',
    async (_label, { route, role }) => {
      const ctx = await setup();
      const p = await route.prepare(ctx);
      const cookie = role === 'anon' ? undefined : await ctx.login(role);
      const before = await ctx.snapshot();
      const res = await route.send(ctx, role, cookie, p);
      const expected = route.expect[role]!;
      expect(res.status).toBe(expected);
      if (expected >= 400) {
        expect(await ctx.snapshot()).toBe(before);
      }
    }
  );
});
