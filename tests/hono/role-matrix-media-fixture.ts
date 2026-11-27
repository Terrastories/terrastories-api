/**
 * Shared media fixture for the role-matrix-b media cells: two communities,
 * one story, users for every role, and an in-memory byte store that the
 * snapshot reads so denied writes to bytes or sessions are caught.
 */
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

export const API = 'https://api.example.test';
export const CLIENT = 'https://app.example.test';
export const MIB = 1024 * 1024;
const KEY = makeDerivedKey();
export const PNG = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64'
  )
);
export const sha = (b: Uint8Array) =>
  createHash('sha256').update(b).digest('hex');
/** One-part MP4-shaped body: an ftyp header and zeros. */
export const MP4 = (() => {
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

export type Role =
  | 'anon'
  | 'viewer'
  | 'member'
  | 'editor'
  | 'editor2'
  | 'admin'
  | 'super_admin'
  | 'foreign_admin';
export type Ctx = Awaited<ReturnType<typeof setupMedia>>;

/** Every SQLite handle opened here; test files close them in afterEach. */
export const openDbs: Sqlite.Database[] = [];
export function closeDbs(): void {
  while (openDbs.length > 0) openDbs.pop()?.close();
}

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

export async function setupMedia() {
  const sqlite = new Sqlite(':memory:');
  openDbs.push(sqlite);
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

  const attach = async (
    cookie: string,
    fileId: string,
    storyId: number
  ): Promise<number> => {
    const res = await call('POST', '/v2/attachments', cookie, {
      fileId,
      ownerType: 'story',
      ownerId: storyId,
      role: 'story_media',
    });
    if (res.status !== 201) throw new Error(`attach -> ${res.status}`);
    return ((await res.json()) as { data: { id: number } }).data.id;
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
  const storyId = story[0]!.id;

  /** Files, attachments and every stored byte: what a denied write must not change. */
  const snapshot = async () =>
    JSON.stringify({
      files: await db.select().from(tables.files),
      attachments: await db.select().from(tables.attachments),
      bytes: [...mem.store.entries()].map(([k, v]) => [k, sha(v)]).sort(),
    });

  return {
    db,
    tables,
    app,
    call,
    login,
    upload,
    attach,
    snapshot,
    storyId,
    mem,
    users,
    ownId,
    otherId,
  };
}
