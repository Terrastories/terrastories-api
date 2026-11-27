/**
 * Role-by-route matrix, part B (audit #145/#146 rows 54-66): public media,
 * media metadata/delete, direct upload sessions, raw media upload and
 * attachments. Denied cells assert the exact status, that files, attachments
 * and stored bytes are unchanged, and that 404 bodies leak no filename or id.
 * Allowed cells read back the write they performed.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { rawUploadRequest } from '../helpers/raw-upload.js';
import {
  CLIENT,
  MP4,
  PNG,
  sha,
  closeDbs,
  setupMedia,
  type Ctx,
  type Role,
} from './role-matrix-media-fixture.js';

type P = { id?: string; sessionId?: string; ids?: number[]; storyId?: number };
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
async function attachedFile(ctx: Ctx, cookie: string) {
  const fileId = await ctx.upload(cookie);
  const attId = await ctx.attach(cookie, fileId, ctx.storyId);
  return { fileId, attId };
}
const fileRow = (ctx: Ctx, id: string) =>
  ctx.db.select().from(ctx.tables.files).where(eq(ctx.tables.files.id, id));
const bytesFor = (ctx: Ctx, id: string) =>
  [...ctx.mem.store.keys()].filter((k) => k.includes(id));

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
  /** Read-back after an allowed success. */
  verify?: (ctx: Ctx, p: P, res: Response) => Promise<void>;
};
const none = async () => ({}) as P;
const ownerOf = (ctx: Ctx) => ctx.login('editor');

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
    verify: async (_ctx, _p, res) => {
      expect((await json(res)).data.id).toBeTruthy();
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
    prepare: async (ctx) => ({
      sessionId: await newSession(ctx, await ownerOf(ctx)),
    }),
    send: (ctx, _r, cookie, p) =>
      ctx.call('DELETE', `/v2/media/uploads/${p.sessionId}`, cookie),
    alive: async (ctx, p) => {
      const cookie = await ownerOf(ctx);
      expect(
        (
          await ctx.call(
            'POST',
            `/v2/media/uploads/${p.sessionId}/parts/presign`,
            cookie
          )
        ).status
      ).toBe(200);
    },
    verify: async (ctx, p) => {
      // Session is gone: the owner's presign now 404s.
      const cookie = await ownerOf(ctx);
      expect(
        (
          await ctx.call(
            'POST',
            `/v2/media/uploads/${p.sessionId}/parts/presign`,
            cookie
          )
        ).status
      ).toBe(404);
    },
  },
  {
    name: 'PUT /v2/media/uploads/:id/parts/:n',
    expect: {
      anon: 401,
      editor: 200,
      admin: 404,
      super_admin: 404,
      foreign_admin: 404,
    },
    prepare: async (ctx) => ({
      sessionId: await newSession(ctx, await ownerOf(ctx)),
    }),
    send: (ctx, _r, cookie, p) => putPart(ctx, cookie!, p.sessionId!),
    verify: async (_ctx, _p, res) => {
      expect(res.headers.get('etag')).toBe(`"${sha(MP4)}"`);
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
    prepare: async (ctx) => ({
      sessionId: await newSession(ctx, await ownerOf(ctx)),
    }),
    send: (ctx, _r, cookie, p) =>
      ctx.call(
        'POST',
        `/v2/media/uploads/${p.sessionId}/parts/presign`,
        cookie
      ),
  },
  {
    name: 'POST /v2/media/uploads/:id/complete',
    expect: {
      anon: 401,
      editor: 201,
      admin: 404,
      super_admin: 404,
      foreign_admin: 404,
    },
    prepare: async (ctx) => {
      const cookie = await ownerOf(ctx);
      const sessionId = await newSession(ctx, cookie);
      expect((await putPart(ctx, cookie, sessionId)).status).toBe(200);
      return { sessionId };
    },
    send: (ctx, _r, cookie, p) =>
      ctx.call('POST', `/v2/media/uploads/${p.sessionId}/complete`, cookie, {
        parts: [{ partNumber: 1, etag: sha(MP4) }],
      }),
    verify: async (ctx, _p, res) => {
      const id = String((await json(res)).data.id);
      expect(await fileRow(ctx, id)).toHaveLength(1);
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
      expect(bytesFor(ctx, id).length).toBeGreaterThan(0);
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
    prepare: async (ctx) => ({ id: await ctx.upload(await ownerOf(ctx)) }),
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
    prepare: async (ctx) => ({ id: await ctx.upload(await ownerOf(ctx)) }),
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
      id: (await attachedFile(ctx, await ownerOf(ctx))).fileId,
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
      id: (await attachedFile(ctx, await ownerOf(ctx))).fileId,
    }),
    send: (ctx, _r, cookie, p) =>
      ctx.call('GET', `/v2/public/communities/own-media/media/${p.id}`, cookie),
    verify: async (_ctx, _p, res) => {
      expect(new Uint8Array(await res.arrayBuffer()).byteLength).toBe(
        PNG.byteLength
      );
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
      id: await ctx.upload(await ownerOf(ctx)),
      storyId: ctx.storyId,
    }),
    send: (ctx, _r, cookie, p) =>
      ctx.call('POST', '/v2/attachments', cookie, {
        fileId: p.id,
        ownerType: 'story',
        ownerId: p.storyId,
        role: 'story_media',
      }),
    verify: async (ctx, _p, res) => {
      const id = (await json(res)).data.id;
      expect(id).toBeTruthy();
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
      const cookie = await ownerOf(ctx);
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
    prepare: async (ctx) => ({
      ids: [
        await ctx.attach(
          await ownerOf(ctx),
          await ctx.upload(await ownerOf(ctx)),
          ctx.storyId
        ),
      ],
    }),
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
  afterEach(() => closeDbs());

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
        const text = await res.clone().text();
        expect(text).not.toContain('photo.png');
        expect(text).not.toContain('clip.mp4');
        if (p.id) expect(text).not.toContain(p.id);
        expect(await ctx.snapshot()).toBe(before);
        await route.alive?.(ctx, p);
      } else {
        await route.verify?.(ctx, p, res);
      }
    }
  );
});
