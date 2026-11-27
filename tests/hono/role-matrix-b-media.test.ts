/**
 * Role-by-route matrix, part B (audit #145/#146 rows 54-66): public media,
 * media metadata/delete, direct upload sessions, raw media upload and
 * attachments. Denied cells assert the exact error payload, that files,
 * attachments and stored bytes are unchanged, and that the response leaks no
 * filename, file, session, attachment or story id. Allowed cells read back the
 * stored effect of the write.
 */
import { describe, expect, it, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { rawUploadRequest } from '../helpers/raw-upload.js';
import {
  API,
  MP4,
  PNG,
  sha,
  closeDbs,
  setupMedia,
  type Ctx,
  type Role,
} from './role-matrix-media-fixture.js';

const HOUR_MS = 60 * 60 * 1000;
const TTL_MS = 2 * HOUR_MS;

type P = {
  id?: string;
  sessionId?: string;
  ids?: number[];
  storyId?: number;
  beforeKeys?: string[];
  t0?: number;
};
/** Approved denial payloads, by status. */
const DENIED_BODY: Record<number, unknown> = {
  401: { error: 'Unauthorized' },
  403: { error: 'Forbidden' },
  404: { error: 'Not found' },
};
const sessionBody = () => ({
  filename: 'clip.mp4',
  contentType: 'video/mp4',
  size: MP4.byteLength,
  sha256: sha(MP4),
  partSize: 16 * 1024 * 1024,
  partSha256: [sha(MP4)],
});
const json = async (res: Response) =>
  (await res.json()) as { data: Record<string, unknown> };
const keysWith = (ctx: Ctx, part: string) =>
  [...ctx.mem.store.keys()].filter((k) => k.includes(part));
const bodyOf = (ctx: Ctx, key: string) => ctx.mem.store.get(key);

/** Part headers (checksum) from each session the owner created. */
const partHeaders = new Map<string, Record<string, string>>();
async function newSession(ctx: Ctx, cookie: string): Promise<string> {
  const res = await ctx.call(
    'POST',
    '/v2/media/uploads',
    cookie,
    sessionBody()
  );
  if (res.status !== 201) throw new Error(`session -> ${res.status}`);
  const data = (await json(res)).data as {
    id: string;
    parts: Array<{ headers: Record<string, string> }>;
  };
  partHeaders.set(String(data.id), data.parts[0]!.headers);
  return String(data.id);
}
async function putPart(ctx: Ctx, cookie: string, sessionId: string) {
  return ctx.call(
    'PUT',
    `/v2/media/uploads/${sessionId}/parts/1`,
    cookie,
    undefined,
    {
      body: MP4,
      headers: {
        ...(partHeaders.get(sessionId) ?? {}),
        'content-length': String(MP4.byteLength),
      },
    }
  );
}
const presign = (ctx: Ctx, cookie: string | undefined, sessionId: string) =>
  ctx.call('POST', `/v2/media/uploads/${sessionId}/parts/presign`, cookie);
const fileRow = (ctx: Ctx, id: string) =>
  ctx.db.select().from(ctx.tables.files).where(eq(ctx.tables.files.id, id));
const bytesFor = (ctx: Ctx, id: string) => keysWith(ctx, id);
async function attachedFile(ctx: Ctx, cookie: string) {
  const fileId = await ctx.upload(cookie);
  const attId = await ctx.attach(cookie, fileId, ctx.storyId);
  return { fileId, attId };
}
const owner = (ctx: Ctx) => ctx.login('editor');

type Route = {
  name: string;
  expect: Partial<Record<Role, number>>;
  prepare: (ctx: Ctx) => Promise<P>;
  send: (
    ctx: Ctx,
    role: Role,
    cookie: string | undefined,
    p: P
  ) => Promise<Response>;
  /** After a denied write: the session must still be alive (owner presign 200). */
  alive?: (ctx: Ctx, p: P) => Promise<void>;
  /** Read-back of stored effects after an allowed write. */
  verify?: (ctx: Ctx, p: P, res: Response, role: Role) => Promise<void>;
};
const none = async () => ({}) as P;
const sessionAlive = async (ctx: Ctx, p: P) => {
  expect((await presign(ctx, await owner(ctx), p.sessionId!)).status).toBe(200);
};

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
    prepare: none,
    send: (ctx, _r, cookie) =>
      ctx.call('POST', '/v2/media/uploads', cookie, sessionBody()),
    verify: async (ctx, _p, res, role) => {
      const data = (await json(res)).data as {
        id: string;
        partCount: number;
        parts: Array<{ url: string }>;
      };
      expect(data.partCount).toBe(1);
      expect(data.parts[0]?.url).toEqual(expect.any(String));
      // The returned session is retrievable: its presign answers for the owner.
      expect(
        (
          await presign(
            ctx,
            await ctx.login(role as Exclude<Role, 'anon'>),
            String(data.id)
          )
        ).status
      ).toBe(200);
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
      const cookie = await owner(ctx);
      const sessionId = await newSession(ctx, cookie);
      expect((await putPart(ctx, cookie, sessionId)).status).toBe(200);
      return { sessionId };
    },
    send: (ctx, _r, cookie, p) =>
      ctx.call('DELETE', `/v2/media/uploads/${p.sessionId}`, cookie),
    alive: sessionAlive,
    verify: async (ctx, p) => {
      expect(keysWith(ctx, p.sessionId!)).toHaveLength(0);
      expect((await presign(ctx, await owner(ctx), p.sessionId!)).status).toBe(
        404
      );
    },
  },
  {
    name: 'PUT /v2/media/uploads/:id/parts/:n',
    expect: {
      anon: 401,
      editor: 200,
      editor2: 404,
      admin: 404,
      super_admin: 404,
      foreign_admin: 404,
    },
    prepare: async (ctx) => {
      const sessionId = await newSession(ctx, await owner(ctx));
      return { sessionId, beforeKeys: keysWith(ctx, sessionId) };
    },
    send: (ctx, _r, cookie, p) => putPart(ctx, cookie!, p.sessionId!),
    alive: sessionAlive,
    verify: async (ctx, p, res) => {
      expect(res.headers.get('etag')).toBe(`"${sha(MP4)}"`);
      // The part is a new stored object whose bytes are the uploaded part.
      const added = keysWith(ctx, p.sessionId!).filter(
        (k) => !p.beforeKeys!.includes(k)
      );
      expect(added.length).toBeGreaterThan(0);
      expect(added.some((k) => sha(bodyOf(ctx, k)!) === sha(MP4))).toBe(true);
    },
  },
  {
    name: 'POST /v2/media/uploads/:id/parts/presign',
    expect: {
      anon: 401,
      editor: 200,
      editor2: 404,
      admin: 404,
      super_admin: 404,
      foreign_admin: 404,
    },
    prepare: async (ctx) => {
      // Fake only Date: the app's direct-upload service reads the real clock.
      vi.useFakeTimers({ toFake: ['Date'] });
      const t0 = Date.now();
      return { sessionId: await newSession(ctx, await owner(ctx)), t0 };
    },
    send: (ctx, _r, cookie, p) => {
      // Re-issue one hour after creation, so the refreshed expiry is observable.
      vi.setSystemTime(p.t0! + HOUR_MS);
      return presign(ctx, cookie, p.sessionId!);
    },
    verify: async (ctx, p, res) => {
      const sid = p.sessionId!;
      const data = (await json(res)).data as {
        expiresAt: string;
        parts: unknown[];
      };
      const sha256Base64 = Buffer.from(sha(MP4), 'hex').toString('base64');
      expect(data.parts).toEqual([
        {
          partNumber: 1,
          method: 'PUT',
          url: `${API}/v2/media/uploads/${sid}/parts/1`,
          headers: { 'x-amz-checksum-sha256': sha256Base64 },
          size: MP4.byteLength,
        },
      ]);
      // The journal is the session's stored JSON, keyed by its id.
      const journal = keysWith(ctx, sid).filter((k) =>
        k.endsWith(`/.multipart/${sid}.json`)
      );
      expect(journal).toHaveLength(1);
      const stored = JSON.parse(
        new TextDecoder().decode(bodyOf(ctx, journal[0]!)!)
      ) as { expiresAt: number };
      // Creation expiry was t0 + 2h; the presign at t0 + 1h refreshes it to t0 + 3h.
      expect(stored.expiresAt).toBe(p.t0! + HOUR_MS + TTL_MS);
      expect(stored.expiresAt).toBeGreaterThan(p.t0! + TTL_MS);
      expect(data.expiresAt).toBe(new Date(stored.expiresAt).toISOString());
    },
  },
  {
    name: 'POST /v2/media/uploads/:id/complete',
    expect: {
      anon: 401,
      editor: 201,
      editor2: 404,
      admin: 404,
      super_admin: 404,
      foreign_admin: 404,
    },
    prepare: async (ctx) => {
      const cookie = await owner(ctx);
      const sessionId = await newSession(ctx, cookie);
      expect((await putPart(ctx, cookie, sessionId)).status).toBe(200);
      return { sessionId };
    },
    send: (ctx, _r, cookie, p) =>
      ctx.call('POST', `/v2/media/uploads/${p.sessionId}/complete`, cookie, {
        parts: [{ partNumber: 1, etag: sha(MP4) }],
      }),
    alive: sessionAlive,
    verify: async (ctx, p, res) => {
      const id = String((await json(res)).data.id);
      expect(await fileRow(ctx, id)).toHaveLength(1);
      expect(
        bytesFor(ctx, id).some((k) => sha(bodyOf(ctx, k)!) === sha(MP4))
      ).toBe(true);
      expect(keysWith(ctx, p.sessionId!)).toHaveLength(0);
    },
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
    prepare: none,
    send: (ctx, _r, cookie) => {
      const req = rawUploadRequest({
        filename: 'photo.png',
        contentType: 'image/png',
        bytes: PNG,
      });
      return ctx.call('POST', `/v2/media${req.search}`, cookie, undefined, req);
    },
    verify: async (ctx, _p, res) => {
      const id = String((await json(res)).data.id);
      expect(await fileRow(ctx, id)).toHaveLength(1);
      expect(
        bytesFor(ctx, id).some((k) => sha(bodyOf(ctx, k)!) === sha(PNG))
      ).toBe(true);
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
      admin: 204,
      super_admin: 404,
      foreign_admin: 404,
    },
    prepare: async (ctx) => ({ id: await ctx.upload(await owner(ctx)) }),
    send: (ctx, _r, cookie, p) =>
      ctx.call('DELETE', `/v2/media/${p.id}`, cookie),
    verify: async (ctx, p) => {
      expect(await fileRow(ctx, p.id!)).toHaveLength(0);
      expect(bytesFor(ctx, p.id!)).toHaveLength(0);
    },
  },
  {
    name: 'GET /v2/media/:id/metadata (staging)',
    expect: {
      anon: 401,
      viewer: 404,
      member: 404,
      editor2: 404,
      editor: 200,
      admin: 200,
      super_admin: 404,
      foreign_admin: 404,
    },
    prepare: async (ctx) => ({ id: await ctx.upload(await owner(ctx)) }),
    send: (ctx, _r, cookie, p) =>
      ctx.call('GET', `/v2/media/${p.id}/metadata`, cookie),
    verify: async (_ctx, p, res) => {
      expect((await json(res)).data.id).toBe(p.id);
    },
  },
  {
    name: 'GET /v2/media/:id/metadata (attached)',
    expect: {
      anon: 401,
      viewer: 200,
      member: 200,
      editor: 200,
      editor2: 200,
      admin: 200,
      super_admin: 404,
      foreign_admin: 404,
    },
    prepare: async (ctx) => ({
      id: (await attachedFile(ctx, await owner(ctx))).fileId,
    }),
    send: (ctx, _r, cookie, p) =>
      ctx.call('GET', `/v2/media/${p.id}/metadata`, cookie),
    verify: async (_ctx, p, res) => {
      expect((await json(res)).data.id).toBe(p.id);
    },
  },
  {
    name: 'GET /v2/public/communities/:slug/media/:fileId',
    expect: {
      anon: 200,
      viewer: 200,
      member: 200,
      editor: 200,
      editor2: 200,
      admin: 200,
      super_admin: 200,
      foreign_admin: 200,
    },
    prepare: async (ctx) => ({
      id: (await attachedFile(ctx, await owner(ctx))).fileId,
    }),
    send: (ctx, _r, cookie, p) =>
      ctx.call('GET', `/v2/public/communities/own-media/media/${p.id}`, cookie),
    verify: async (_ctx, _p, res) => {
      expect(
        Buffer.from(await res.arrayBuffer()).equals(Buffer.from(PNG))
      ).toBe(true);
    },
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
      id: await ctx.upload(await owner(ctx)),
      storyId: ctx.storyId,
    }),
    send: (ctx, _r, cookie, p) =>
      ctx.call('POST', '/v2/attachments', cookie, {
        fileId: p.id,
        ownerType: 'story',
        ownerId: p.storyId,
        role: 'story_media',
      }),
    verify: async (ctx, p, res) => {
      const id = (await json(res)).data.id as number;
      const row = (await ctx.db.select().from(ctx.tables.attachments)).find(
        (r) => r.id === id
      );
      expect(row).toMatchObject({
        fileId: p.id,
        ownerType: 'story',
        ownerId: p.storyId,
      });
    },
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
      const cookie = await owner(ctx);
      const ids: number[] = [];
      for (let i = 0; i < 2; i++)
        ids.push(
          await ctx.attach(cookie, await ctx.upload(cookie), ctx.storyId)
        );
      return { ids, storyId: ctx.storyId };
    },
    send: (ctx, _r, cookie, p) =>
      ctx.call('PATCH', '/v2/attachments/reorder', cookie, {
        ownerType: 'story',
        ownerId: p.storyId,
        role: 'story_media',
        attachmentIds: [p.ids![1]!, p.ids![0]!],
      }),
    verify: async (ctx, p) => {
      const rows = await ctx.db.select().from(ctx.tables.attachments);
      const ord = (id: number) => rows.find((r) => r.id === id)?.ordinal;
      expect(ord(p.ids![1]!)).toBe(0);
      expect(ord(p.ids![0]!)).toBe(1);
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
      const cookie = await owner(ctx);
      return {
        ids: [await ctx.attach(cookie, await ctx.upload(cookie), ctx.storyId)],
      };
    },
    send: (ctx, _r, cookie, p) =>
      ctx.call('DELETE', `/v2/attachments/${p.ids![0]}`, cookie),
    verify: async (ctx, p) => {
      const rows = await ctx.db.select().from(ctx.tables.attachments);
      expect(rows.find((r) => r.id === p.ids![0])).toBeUndefined();
    },
  },
];

const MATRIX = ROUTES.flatMap((route) =>
  (Object.keys(route.expect) as Role[]).map((role) => ({ route, role }))
);

describe('role matrix B: media, upload sessions and attachments', () => {
  afterEach(() => {
    vi.useRealTimers();
    closeDbs();
  });

  it.each(MATRIX.map((c) => [`${c.route.name} as ${c.role}`, c] as const))(
    '%s',
    async (_label, { route, role }) => {
      const ctx = await setupMedia();
      const p = await route.prepare(ctx);
      const cookie = role === 'anon' ? undefined : await ctx.login(role);
      const before = await ctx.snapshot();
      const res = await route.send(ctx, role, cookie, p);
      const expected = route.expect[role]!;
      expect(res.status).toBe(expected);
      if (expected >= 400) {
        const body = await res.clone().json();
        expect(body).toEqual(DENIED_BODY[expected]);
        const text = JSON.stringify(body);
        expect(text).not.toMatch(/photo\.png|clip\.mp4/);
        for (const id of [
          p.id,
          p.sessionId,
          ...(p.ids ?? []),
          p.storyId,
        ].filter((v) => v !== undefined)) {
          expect(text).not.toMatch(
            new RegExp(`(^|[^A-Za-z0-9-])${id}($|[^A-Za-z0-9-])`)
          );
        }
        expect(await ctx.snapshot()).toBe(before);
        await route.alive?.(ctx, p);
      } else {
        await route.verify?.(ctx, p, res, role);
      }
    }
  );
});

describe('role matrix B: public media visibility boundaries', () => {
  afterEach(() => {
    vi.useRealTimers();
    closeDbs();
  });

  it('public media is 404 for a file that is not attached', async () => {
    const ctx = await setupMedia();
    const fileId = await ctx.upload(await owner(ctx));
    const res = await ctx.call(
      'GET',
      `/v2/public/communities/own-media/media/${fileId}`
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(DENIED_BODY[404]);
  });

  it('public media is 404 for a file attached only to a private story', async () => {
    const ctx = await setupMedia();
    const cookie = await owner(ctx);
    const [story] = await ctx.db
      .insert(ctx.tables.stories)
      .values({
        title: 'Private Story',
        slug: 'private-story',
        privacyLevel: 'private',
        isRestricted: false,
        communityId: ctx.ownId,
        createdBy: ctx.users.editor.id,
        createdAt: new Date('2026-06-01T12:00:00.000Z'),
        updatedAt: new Date('2026-06-01T12:00:00.000Z'),
      })
      .returning({ id: ctx.tables.stories.id });
    const fileId = await ctx.upload(cookie);
    // The attach API refuses private stories, so the row is written directly.
    await ctx.db.insert(ctx.tables.attachments).values({
      communityId: ctx.ownId,
      fileId,
      ownerType: 'story',
      ownerId: story!.id,
      role: 'story_media',
      ordinal: 0,
    });
    const res = await ctx.call(
      'GET',
      `/v2/public/communities/own-media/media/${fileId}`
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(DENIED_BODY[404]);
  });

  it('public media is 404 under the wrong community slug, and 200 with exact bytes under the owner slug', async () => {
    const ctx = await setupMedia();
    const foreignCookie = await ctx.login('foreign_admin');
    const [story] = await ctx.db
      .insert(ctx.tables.stories)
      .values({
        title: 'Other Story',
        slug: 'other-story',
        privacyLevel: 'public',
        isRestricted: false,
        communityId: ctx.otherId,
        createdBy: ctx.users.foreign_admin.id,
        createdAt: new Date('2026-06-01T12:00:00.000Z'),
        updatedAt: new Date('2026-06-01T12:00:00.000Z'),
      })
      .returning({ id: ctx.tables.stories.id });
    const fileId = await ctx.upload(foreignCookie);
    await ctx.attach(foreignCookie, fileId, story!.id);
    const wrong = await ctx.call(
      'GET',
      `/v2/public/communities/own-media/media/${fileId}`
    );
    expect(wrong.status).toBe(404);
    expect(await wrong.json()).toEqual(DENIED_BODY[404]);
    const right = await ctx.call(
      'GET',
      `/v2/public/communities/other-media/media/${fileId}`
    );
    expect(right.status).toBe(200);
    expect(
      Buffer.from(await right.arrayBuffer()).equals(Buffer.from(PNG))
    ).toBe(true);
  });
});
