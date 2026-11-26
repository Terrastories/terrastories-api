/**
 * Adversarial media suite on the Hono V2 app (#140): polyglot files, declared
 * vs sniffed MIME, hostile filenames, SVG, zero-byte and oversize bodies,
 * image/archive bombs, and cross-community read/attach/delete denial.
 *
 * Every denied case asserts the exact status and that neither the database nor
 * the byte store changed; the owner re-reads the file afterwards.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import {
  argon2Seed,
  makeDerivedKey,
  makeServerSecret,
} from './auth-test-utils.js';
import { tablesFor } from '../../src/db/dialect.js';
import { createHonoApp } from '../../src/hono-app.js';
import { HonoFoundationRepository } from '../../src/repositories/hono-foundation.repository.js';
import { MediaCleanupCoordinator } from '../../src/services/media-cleanup.service.js';
import { assertPutSha256, rawUploadRequest } from '../helpers/raw-upload.js';
import type { FoundationStorage } from '../../src/services/hono-foundation.service.js';
import {
  AttachmentResponseSchema,
  MAX_IMAGE_UPLOAD_BYTES,
  MediaMetadataResponseSchema,
  MediaUploadResponseSchema,
} from '../../src/shared/schemas/media-v2.js';
import { deriveUserIdentityColumns } from '../../src/shared/utils/derived-columns.js';

const sqlite = new Sqlite(':memory:');
sqlite.pragma('foreign_keys = ON');
const db = drizzle(sqlite);
const tables = tablesFor(db);

const TEST_DERIVED_KEY = makeDerivedKey();
const API = 'https://api.example.test';
const ORIGIN = 'https://app.example.test';
const enc = (s: string) => new TextEncoder().encode(s);
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
};

const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06,
  0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
]);
const JPEG = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01,
  0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]);
const PDF = enc('%PDF-1.4\n%%EOF');
const WAV = (() => {
  const buf = new Uint8Array(44);
  buf.set(enc('RIFF'), 0);
  new DataView(buf.buffer).setUint32(4, 36, true);
  buf.set(enc('WAVEfmt '), 8);
  new DataView(buf.buffer).setUint32(16, 16, true);
  new DataView(buf.buffer).setUint16(20, 1, true);
  new DataView(buf.buffer).setUint16(22, 1, true);
  new DataView(buf.buffer).setUint32(24, 8000, true);
  new DataView(buf.buffer).setUint32(28, 8000, true);
  new DataView(buf.buffer).setUint16(32, 1, true);
  new DataView(buf.buffer).setUint16(34, 8, true);
  buf.set(enc('data'), 36);
  return buf;
})();

type Entry = { bytes: Uint8Array; contentType?: string };
function createMemoryStorage(): {
  store: Map<string, Entry>;
  storage: FoundationStorage;
} {
  const store = new Map<string, Entry>();
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
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
      const merged = concat(...chunks);
      assertPutSha256(merged, opts?.sha256);
      store.set(storageKey, { bytes: merged, contentType: opts.contentType });
      return { size: merged.byteLength };
    },
    async delete(storageKey) {
      store.delete(storageKey);
    },
  };
  return { store, storage };
}

let app: ReturnType<typeof createHonoApp>;
let memStore: Map<string, Entry>;
const ids: Record<string, number> = {};
const cookies: Record<string, string> = {};

async function insertRow(table: any, values: any): Promise<number> {
  const [row] = await db
    .insert(table)
    .values(values)
    .returning({ id: table.id });
  return row.id as number;
}

async function loginAs(email: string): Promise<string> {
  const res = await app.request(API + '/v2/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: email, derivedKey: TEST_DERIVED_KEY }),
  });
  expect(res.status).toBe(200);
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

async function upload(opts: {
  cookie?: string;
  filename: string;
  contentType: string;
  bytes: Uint8Array;
  omitContentLength?: boolean;
}) {
  const raw = rawUploadRequest(opts);
  const headers: Record<string, string> = { ...raw.headers, origin: ORIGIN };
  if (opts.cookie) headers.cookie = opts.cookie;
  return app.request(API + '/v2/media' + raw.search, {
    method: 'POST',
    headers,
    body: raw.body,
  });
}

async function uploadOk(opts: Parameters<typeof upload>[0]) {
  const res = await upload(opts);
  expect(res.status).toBe(201);
  return MediaUploadResponseSchema.parse(await res.json()).data;
}

function get(
  path: string,
  cookie?: string,
  extra: Record<string, string> = {}
) {
  return app.request(API + path, {
    headers: { ...(cookie ? { cookie } : {}), ...extra },
  });
}

function send(
  method: string,
  path: string,
  cookie: string | undefined,
  body?: unknown
) {
  return app.request(API + path, {
    method,
    headers: {
      origin: ORIGIN,
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Everything a denied request must leave untouched. */
async function snapshot() {
  const files = await db.select().from(tables.files);
  const attachments = await db.select().from(tables.attachments);
  return JSON.stringify({
    files,
    attachments,
    bytes: [...memStore.entries()].map(([k, v]) => [
      k,
      Buffer.from(v.bytes).toString('base64'),
    ]),
  });
}

async function expectDenied(
  label: string,
  run: () => Promise<Response>,
  status: number
) {
  const before = await snapshot();
  const res = await run();
  expect(res.status, label).toBe(status);
  expect(await snapshot(), label + ' changed state').toBe(before);
  return res;
}

function expectSafeDownload(res: Response) {
  expect(res.headers.get('content-disposition')).toBe('attachment');
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  expect(res.headers.get('content-security-policy')).toBe(
    "default-src 'none'; sandbox"
  );
  expect(res.headers.get('cache-control')).toBe('no-store');
  // A rolling session cookie may ride along; it must never carry file input.
  expect(res.headers.get('set-cookie') ?? '').not.toMatch(/pwn|filename/i);
}

describe('media adversarial suite on the Hono V2 app (#140)', () => {
  beforeAll(async () => {
    migrate(db, { migrationsFolder: './src/db/migrations' });
    const now = new Date('2026-06-01T12:00:00.000Z');
    const seed = await argon2Seed(TEST_DERIVED_KEY);
    const mkCommunity = (name: string, slug: string) =>
      insertRow(tables.communities, {
        name,
        slug,
        publicStories: true,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      });
    ids.a = await mkCommunity('Adv A', 'adv-a');
    ids.b = await mkCommunity('Adv B', 'adv-b');
    const mkUser = async (
      email: string,
      role: string,
      communityId: number | null
    ) => {
      const derived = deriveUserIdentityColumns({
        email,
        firstName: 'Adv',
        lastName: role,
        communityId,
      });
      return insertRow(tables.users, {
        email,
        emailNormalized: derived.emailNormalized,
        ...seed,
        firstName: 'Adv',
        lastName: role,
        displayNameNormalized: derived.displayNameNormalized,
        role,
        communityId,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      });
    };
    ids.viewerA = await mkUser('viewer@a.test', 'viewer', ids.a);
    ids.editorA = await mkUser('editor@a.test', 'editor', ids.a);
    ids.editorB = await mkUser('editor@b.test', 'editor', ids.b);
    ids.adminB = await mkUser('admin@b.test', 'admin', ids.b);
    ids.superAdmin = await mkUser('super@system.test', 'super_admin', null);
    const mkStory = (slug: string, communityId: number, createdBy: number) =>
      insertRow(tables.stories, {
        title: slug,
        slug,
        privacyLevel: 'public',
        isRestricted: false,
        communityId,
        createdBy,
        createdAt: now,
        updatedAt: now,
      });
    ids.storyA = await mkStory('adv-story-a', ids.a, ids.editorA);
    ids.storyB = await mkStory('adv-story-b', ids.b, ids.editorB);

    const mem = createMemoryStorage();
    memStore = mem.store;
    app = createHonoApp({
      repository: new HonoFoundationRepository(db),
      serverSecret: makeServerSecret(),
      secureCookies: false,
      publicOrigin: API,
      corsOrigins: [ORIGIN],
      storage: mem.storage,
      mediaCleanup: new MediaCleanupCoordinator(db, mem.storage),
    });
    cookies.viewerA = await loginAs('viewer@a.test');
    cookies.editorA = await loginAs('editor@a.test');
    cookies.editorB = await loginAs('editor@b.test');
    cookies.adminB = await loginAs('admin@b.test');
    cookies.superAdmin = await loginAs('super@system.test');
  });

  afterAll(() => {
    sqlite.close();
  });

  describe('polyglot files', () => {
    const cases: Array<[string, string, string, Uint8Array]> = [
      [
        'PNG with an HTML tail',
        'polyglot.png',
        'image/png',
        concat(
          PNG,
          enc('<html><script>alert(document.cookie)</script></html>')
        ),
      ],
      [
        'PNG with a JavaScript tail',
        'polyglot-js.png',
        'image/png',
        concat(PNG, enc('\n/*/;alert(1);//*/')),
      ],
      [
        'JPEG with an appended zip',
        'photo-zip.jpg',
        'image/jpeg',
        concat(
          JPEG,
          Uint8Array.from([0x50, 0x4b, 0x03, 0x04]),
          new Uint8Array(40)
        ),
      ],
      [
        'PDF with an HTML tail',
        'doc.pdf',
        'application/pdf',
        concat(PDF, enc('\n<html><script>alert(1)</script>')),
      ],
    ];

    for (const [label, filename, contentType, bytes] of cases) {
      it(
        label +
          ': stored verbatim, served only as a sandboxed attachment with the sniffed type',
        async () => {
          const created = await uploadOk({
            cookie: cookies.editorA,
            filename,
            contentType,
            bytes,
          });
          expect(created.mimeType).toBe(contentType);
          const [row] = await db
            .select()
            .from(tables.files)
            .where(eq(tables.files.id, created.id));
          expect(Buffer.from(memStore.get(row!.storageKey!)!.bytes)).toEqual(
            Buffer.from(bytes)
          );
          const res = await get('/v2/media/' + created.id, cookies.editorA);
          expect(res.status).toBe(200);
          expect(res.headers.get('content-type')).toBe(contentType);
          expectSafeDownload(res);
          expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
          const ranged = await get('/v2/media/' + created.id, cookies.editorA, {
            range: 'bytes=0-3',
          });
          expect(ranged.status).toBe(206);
          expectSafeDownload(ranged);
        }
      );
    }

    it('rejects a file whose HTML prefix hides a trailing PNG', async () => {
      for (const prefix of ['<html>', '<!doctype html><script>1</script>']) {
        await expectDenied(
          prefix,
          () =>
            upload({
              cookie: cookies.editorA,
              filename: 'reverse.png',
              contentType: 'image/png',
              bytes: concat(enc(prefix), PNG),
            }),
          400
        );
      }
    });
  });

  describe('declared MIME versus sniffed bytes', () => {
    const mismatches: Array<[string, string, string, Uint8Array]> = [
      ['PDF bytes declared image/png', 'a.png', 'image/png', PDF],
      ['PNG bytes declared application/pdf', 'a.pdf', 'application/pdf', PNG],
      ['WAV bytes declared audio/mpeg', 'a.mp3', 'audio/mpeg', WAV],
      ['JPEG bytes declared image/png', 'a.png', 'image/png', JPEG],
      ['PNG bytes declared image/jpeg', 'a.jpg', 'image/jpeg', PNG],
      ['PNG bytes with a .jpg extension', 'a.jpg', 'image/png', PNG],
      ['PNG bytes with a .png.html extension', 'a.png.html', 'image/png', PNG],
      ['PNG bytes declared text/html', 'a.html', 'text/html', PNG],
      [
        'PNG bytes declared octet-stream',
        'a.png',
        'application/octet-stream',
        PNG,
      ],
      ['PNG bytes with no Content-Type', 'a.png', '', PNG],
      ['PNG bytes without an extension', 'noext', 'image/png', PNG],
      [
        'HTML declared as image/png',
        'a.png',
        'image/png',
        enc('<html></html>'),
      ],
    ];
    for (const [label, filename, contentType, bytes] of mismatches) {
      it(label + ' is a 400 and stores nothing', async () => {
        await expectDenied(
          label,
          () =>
            upload({ cookie: cookies.editorA, filename, contentType, bytes }),
          400
        );
      });
    }

    it('accepts a Content-Type parameter and stores the sniffed base type', async () => {
      const created = await uploadOk({
        cookie: cookies.editorA,
        filename: 'param.png',
        contentType: 'image/png; charset=binary',
        bytes: PNG,
      });
      expect(created.mimeType).toBe('image/png');
    });
  });

  describe('hostile filenames', () => {
    const names: Array<[string, string]> = [
      ['crlf header injection', 'a\r\nSet-Cookie: pwn=1\r\n\r\n<script>.png'],
      ['double quote and header parameter', "a\"; filename*=UTF-8''x.png"],
      ['unicode and emoji', 'fot\u{f3}-\u{65e5}\u{672c}\u{8a9e}-\u{1f642}.png'],
      ['right-to-left override', 'photo\u{202e}gnp.exe.png'],
      ['posix traversal', '../../../etc/passwd.png'],
      ['windows traversal', '..\\..\\windows\\system32\\x.png'],
      ['encoded traversal', '..%2f..%2fetc%2fpasswd.png'],
      ['null byte', 'safe.png\0.html.png'],
      ['leading dots', '...x.png'],
    ];
    for (const [label, filename] of names) {
      it(
        label + ': sanitized, never reflected in headers, fixed storage key',
        async () => {
          const created = await uploadOk({
            cookie: cookies.editorA,
            filename,
            contentType: 'image/png',
            bytes: PNG,
          });
          expect(created.originalName).toMatch(/^[A-Za-z0-9._ -]{1,180}$/);
          expect(created.originalName).not.toContain('..');
          const meta = MediaMetadataResponseSchema.parse(
            await (
              await get(
                '/v2/media/' + created.id + '/metadata',
                cookies.editorA
              )
            ).json()
          );
          expect(meta.data.originalName).toBe(created.originalName);
          const [row] = await db
            .select()
            .from(tables.files)
            .where(eq(tables.files.id, created.id));
          expect(row!.storageKey).toBe(
            'communities/' + ids.a + '/media/' + created.id
          );
          const res = await get('/v2/media/' + created.id, cookies.editorA);
          expect(res.status).toBe(200);
          expectSafeDownload(res);
          for (const [name, value] of res.headers) {
            expect(value, name).not.toMatch(/[\r\n"]/);
            expect(value, name).not.toContain(created.originalName);
            expect(value, name).toMatch(/^[\x20-\x7e]*$/);
          }
        }
      );
    }

    it('pins the sanitizer output for traversal and injection names', async () => {
      const expected: Array<[string, string]> = [
        ['../../../etc/passwd.png', 'passwd.png'],
        ['..\\..\\windows\\system32\\x.png', 'x.png'],
        ['a\r\nSet-Cookie: pwn=1.png', 'a--Set-Cookie- pwn-1.png'],
      ];
      for (const [filename, originalName] of expected) {
        const created = await uploadOk({
          cookie: cookies.editorA,
          filename,
          contentType: 'image/png',
          bytes: PNG,
        });
        expect(created.originalName).toBe(originalName);
      }
    });

    it('rejects a blank, extensionless or dot-only filename with 400 and stores nothing', async () => {
      for (const filename of ['', '   ', '.png', '..', '\u{65e5}\u{672c}']) {
        await expectDenied(
          JSON.stringify(filename),
          () =>
            upload({
              cookie: cookies.editorA,
              filename,
              contentType: 'image/png',
              bytes: PNG,
            }),
          400
        );
      }
    });
  });

  describe('SVG and other active content', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    const cases: Array<[string, string, string, Uint8Array]> = [
      ['svg declared image/svg+xml', 'x.svg', 'image/svg+xml', enc(svg)],
      [
        'svg with xml prolog',
        'x.svg',
        'image/svg+xml',
        enc('<?xml version="1.0"?>' + svg),
      ],
      ['svg declared image/png', 'x.png', 'image/png', enc(svg)],
      ['svg declared text/xml', 'x.svg', 'text/xml', enc(svg)],
      ['svgz extension', 'x.svgz', 'image/svg+xml', enc(svg)],
      ['html document', 'x.html', 'text/html', enc('<script>1</script>')],
      ['javascript', 'x.js', 'application/javascript', enc('alert(1)')],
    ];
    for (const [label, filename, contentType, bytes] of cases) {
      it(
        label +
          ' is not accepted (400), so nothing active is ever stored or served',
        async () => {
          await expectDenied(
            label,
            () =>
              upload({ cookie: cookies.editorA, filename, contentType, bytes }),
            400
          );
        }
      );
    }
  });

  describe('zero-byte and oversize bodies', () => {
    it('rejects an empty body with 400, with and without Content-Length', async () => {
      for (const omitContentLength of [false, true]) {
        await expectDenied(
          'empty ' + omitContentLength,
          () =>
            upload({
              cookie: cookies.editorA,
              filename: 'empty.png',
              contentType: 'image/png',
              bytes: new Uint8Array(0),
              omitContentLength,
            }),
          400
        );
      }
    });

    it('rejects an image above the per-type cap with 413 (declared and chunked) and stores nothing', async () => {
      const over = new Uint8Array(MAX_IMAGE_UPLOAD_BYTES + 1);
      over.set(PNG, 0);
      for (const omitContentLength of [false, true]) {
        await expectDenied(
          'oversize ' + omitContentLength,
          () =>
            upload({
              cookie: cookies.editorA,
              filename: 'huge.png',
              contentType: 'image/png',
              bytes: over,
              omitContentLength,
            }),
          413
        );
      }
    });

    it('rejects a Content-Length above the global ceiling with 413', async () => {
      const raw = rawUploadRequest({
        filename: 'lie.png',
        contentType: 'image/png',
        bytes: PNG,
      });
      await expectDenied(
        'ceiling',
        () =>
          app.request(API + '/v2/media' + raw.search, {
            method: 'POST',
            headers: {
              ...raw.headers,
              cookie: cookies.editorA,
              origin: ORIGIN,
              'content-length': String(101 * 1024 * 1024),
            },
            body: raw.body,
          }),
        413
      );
    });
  });

  describe('image and archive bombs', () => {
    it('stores a PNG declaring 2^31-1 by 2^31-1 pixels verbatim and never decodes it', async () => {
      const bomb = Uint8Array.from(PNG);
      new DataView(bomb.buffer).setUint32(16, 0x7fffffff);
      new DataView(bomb.buffer).setUint32(20, 0x7fffffff);
      const created = await uploadOk({
        cookie: cookies.editorA,
        filename: 'bomb.png',
        contentType: 'image/png',
        bytes: bomb,
      });
      expect(created.byteSize).toBe(bomb.byteLength);
      expect('width' in created || 'height' in created).toBe(false);
      const res = await get('/v2/media/' + created.id, cookies.editorA);
      expect(res.status).toBe(200);
      expectSafeDownload(res);
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(bomb);
    });

    it('stores a docx whose entry declares a 4 GiB uncompressed size verbatim', async () => {
      const name = enc('[Content_Types].xml');
      const header = new Uint8Array(30 + name.byteLength);
      header.set([0x50, 0x4b, 0x03, 0x04], 0);
      const view = new DataView(header.buffer);
      view.setUint32(18, 0xffffffff, true);
      view.setUint32(22, 0xffffffff, true);
      view.setUint16(26, name.byteLength, true);
      header.set(name, 30);
      const created = await uploadOk({
        cookie: cookies.editorA,
        filename: 'bomb.docx',
        contentType:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        bytes: header,
      });
      const res = await get('/v2/media/' + created.id, cookies.editorA);
      expectSafeDownload(res);
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(header);
    });

    it('guard: the V2 media path imports no image or archive decoder', () => {
      // sharp is a dependency, but only the legacy Fastify file.service uses it.
      const decoders = [
        'sharp',
        'jimp',
        'pngjs',
        'canvas',
        '@napi-rs/canvas',
        'jpeg-js',
        'upng-js',
        'image-size',
        'jszip',
        'adm-zip',
        'fflate',
        'unzipper',
        'yauzl',
        'pako',
        'node-stream-zip',
      ];
      const walk = (dir: string): string[] =>
        readdirSync(dir).flatMap((entry) => {
          const full = join(dir, entry);
          if (statSync(full).isDirectory()) return walk(full);
          return full.endsWith('.ts') ? [full] : [];
        });
      const escaped = decoders.map((d) => d.replace(/[/@.-]/g, '\\$&'));
      const importPattern = new RegExp(
        'from\\s+[\'"](' + escaped.join('|') + ')[\'"]'
      );
      const legacy = join('src', 'services', 'file.service.ts');
      for (const file of walk('src')) {
        if (file === legacy) continue;
        expect(readFileSync(file, 'utf8'), file).not.toMatch(importPattern);
      }
      // No Hono-side module reaches the decoding legacy service.
      const honoSide = walk('src').filter(
        (f) =>
          /\.hono\.ts$/.test(f) ||
          /[\\/]hono-[^\\/]*\.ts$/.test(f) ||
          /[\\/]media-[^\\/]*\.ts$/.test(f)
      );
      expect(honoSide.length).toBeGreaterThan(5);
      for (const file of honoSide) {
        expect(readFileSync(file, 'utf8'), file).not.toMatch(
          /services\/file\.service|\.\/file\.service/
        );
      }
    });
  });

  describe('cross-community and role denial', () => {
    it('denies read, metadata, delete, attach, detach and reorder across communities and below editor, with no change', async () => {
      const file = await uploadOk({
        cookie: cookies.editorA,
        filename: 'owned.png',
        contentType: 'image/png',
        bytes: PNG,
      });
      const attachRes = await send('POST', '/v2/attachments', cookies.editorA, {
        fileId: file.id,
        ownerType: 'story',
        ownerId: ids.storyA,
        role: 'story_media',
      });
      expect(attachRes.status).toBe(201);
      const attachment = AttachmentResponseSchema.parse(
        await attachRes.json()
      ).data;
      const own = await uploadOk({
        cookie: cookies.editorB,
        filename: 'b-own.png',
        contentType: 'image/png',
        bytes: PNG,
      });
      const staged = await uploadOk({
        cookie: cookies.editorA,
        filename: 'staged.png',
        contentType: 'image/png',
        bytes: PNG,
      });

      const notFound = await (
        await get('/v2/media/999999', cookies.adminB)
      ).text();
      const foreign = await expectDenied(
        'foreign read',
        () => get('/v2/media/' + file.id, cookies.adminB),
        404
      );
      // A guessed id and a foreign id are indistinguishable.
      expect(await foreign.text()).toBe(notFound);

      const attachBody = (fileId: number, ownerId: number) => ({
        fileId,
        ownerType: 'story',
        ownerId,
        role: 'story_media',
      });
      const reorderBody = {
        ownerType: 'story',
        ownerId: ids.storyA,
        role: 'story_media',
        attachmentIds: [attachment.id],
      };
      const attPath = '/v2/attachments/' + attachment.id;
      const denied: Array<[string, () => Promise<Response>, number]> = [
        ['anon read', () => get('/v2/media/' + file.id), 401],
        [
          'foreign editor read',
          () => get('/v2/media/' + file.id, cookies.editorB),
          404,
        ],
        [
          'foreign admin metadata',
          () => get('/v2/media/' + file.id + '/metadata', cookies.adminB),
          404,
        ],
        [
          'foreign range read',
          () =>
            get('/v2/media/' + file.id, cookies.adminB, { range: 'bytes=0-3' }),
          404,
        ],
        [
          'super_admin read',
          () => get('/v2/media/' + file.id, cookies.superAdmin),
          404,
        ],
        [
          'anon delete',
          () => send('DELETE', '/v2/media/' + file.id, undefined),
          401,
        ],
        [
          'foreign admin delete',
          () => send('DELETE', '/v2/media/' + file.id, cookies.adminB),
          404,
        ],
        [
          'foreign editor delete staged',
          () => send('DELETE', '/v2/media/' + staged.id, cookies.editorB),
          404,
        ],
        [
          'viewer delete',
          () => send('DELETE', '/v2/media/' + file.id, cookies.viewerA),
          403,
        ],
        [
          'anon attach',
          () =>
            send(
              'POST',
              '/v2/attachments',
              undefined,
              attachBody(staged.id, ids.storyA!)
            ),
          401,
        ],
        [
          'viewer attach',
          () =>
            send(
              'POST',
              '/v2/attachments',
              cookies.viewerA,
              attachBody(staged.id, ids.storyA!)
            ),
          403,
        ],
        [
          'foreign file onto own story',
          () =>
            send(
              'POST',
              '/v2/attachments',
              cookies.adminB,
              attachBody(staged.id, ids.storyB!)
            ),
          404,
        ],
        [
          'own file onto foreign story',
          () =>
            send(
              'POST',
              '/v2/attachments',
              cookies.adminB,
              attachBody(own.id, ids.storyA!)
            ),
          404,
        ],
        [
          'reuse of a foreign attached file',
          () =>
            send(
              'POST',
              '/v2/attachments',
              cookies.adminB,
              attachBody(file.id, ids.storyB!)
            ),
          404,
        ],
        [
          'super_admin attach',
          () =>
            send(
              'POST',
              '/v2/attachments',
              cookies.superAdmin,
              attachBody(staged.id, ids.storyA!)
            ),
          403,
        ],
        ['anon detach', () => send('DELETE', attPath, undefined), 401],
        ['viewer detach', () => send('DELETE', attPath, cookies.viewerA), 403],
        [
          'foreign admin detach',
          () => send('DELETE', attPath, cookies.adminB),
          404,
        ],
        [
          'foreign admin reorder',
          () =>
            send(
              'PATCH',
              '/v2/attachments/reorder',
              cookies.adminB,
              reorderBody
            ),
          404,
        ],
        [
          'viewer reorder',
          () =>
            send(
              'PATCH',
              '/v2/attachments/reorder',
              cookies.viewerA,
              reorderBody
            ),
          403,
        ],
      ];
      for (const [label, run, status] of denied) {
        await expectDenied(label, run, status);
      }

      // The owner still reads the exact bytes after every denied write.
      const reread = await get('/v2/media/' + file.id, cookies.editorA);
      expect(reread.status).toBe(200);
      expect(new Uint8Array(await reread.arrayBuffer())).toEqual(PNG);
      const [stillThere] = await db
        .select()
        .from(tables.attachments)
        .where(eq(tables.attachments.id, attachment.id));
      expect(stillThere).toBeDefined();
    });
  });
});
