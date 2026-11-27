/**
 * Adversarial media suite on the Hono V2 app (#140): polyglot files, declared
 * vs sniffed MIME, hostile filenames, SVG, zero-byte and oversize bodies,
 * image/archive bombs, and cross-community read/attach/delete denial.
 *
 * Every denied case asserts the exact status and that neither the database nor
 * the byte store changed; the owner re-reads the file afterwards.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq, getTableColumns } from 'drizzle-orm';
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
import { DirectUploadSessionResponseSchema } from '../../src/shared/schemas/media-uploads-v2.js';
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
/** Bytes any storage put() consumed; lets a test prove a guard stopped early. */
const counters = { putBytes: 0 };
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
      const chunks: Uint8Array[] = [];
      if (stream instanceof Uint8Array) {
        chunks.push(stream);
        counters.putBytes += stream.byteLength;
      } else {
        const reader = stream.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            chunks.push(value);
            counters.putBytes += value.byteLength;
          }
        }
      }
      const merged = concat(...chunks);
      assertPutSha256(merged, opts?.sha256);
      store.set(storageKey, { bytes: merged, contentType: opts?.contentType });
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
      v.contentType ?? null,
      Buffer.from(v.bytes).toString('base64'),
    ]),
  });
}

/** Strings that must never appear in any denial body. */
const leaks: string[] = [];

const LEAK_HEADERS = [
  'content-disposition',
  'content-range',
  'accept-ranges',
  'etag',
];

/**
 * Exact status, unchanged state, and a non-disclosing response: a JSON error
 * envelope, no file headers, no leaked names/ids/keys, and (for concealed
 * resources) a body identical to a request for a valid nonexistent resource.
 */
async function expectDenied(
  label: string,
  run: () => Promise<Response>,
  status: number,
  control?: () => Promise<Response>
) {
  const before = await snapshot();
  const res = await run();
  const text = await res.text();
  expect(res.status, label).toBe(status);
  expect(await snapshot(), label + ' changed state').toBe(before);
  expect(res.headers.get('content-type') ?? '', label).toMatch(
    /application\/json/
  );
  const parsed = JSON.parse(text) as Record<string, unknown>;
  expect(typeof parsed.error, label + ' envelope').toBe('string');
  for (const h of LEAK_HEADERS) {
    expect(res.headers.get(h), label + ' ' + h).toBeNull();
  }
  for (const secret of [...leaks, 'communities/', 'storageKey', 'checksum']) {
    expect(text, label + ' leaked ' + secret).not.toContain(secret);
  }
  if (control) {
    const ctl = await control();
    expect(ctl.status, label + ' control').toBe(status);
    expect(text, label + ' differs from nonexistent').toBe(await ctl.text());
  }
  return res;
}

/** Parses Set-Cookie: only the session cookie, only known attributes. */
function expectOnlySessionCookie(res: Response) {
  const raw = res.headers.get('set-cookie');
  if (raw === null) return;
  const [pair, ...attrs] = raw.split(';').map((x) => x.trim());
  expect(pair!.split('=')[0]).toBe('ts_session');
  for (const attr of attrs) {
    expect(attr.split('=')[0]!.toLowerCase()).toMatch(
      /^(max-age|path|httponly|samesite|secure|expires)$/
    );
  }
}

function expectSafeDownload(res: Response) {
  expect(res.headers.get('content-disposition')).toBe('attachment');
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  expect(res.headers.get('content-security-policy')).toBe(
    "default-src 'none'; sandbox"
  );
  expect(res.headers.get('cache-control')).toBe('no-store');
  expectOnlySessionCookie(res);
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
    ids.memberA = await mkUser('member@a.test', 'member', ids.a);
    ids.editorA = await mkUser('editor@a.test', 'editor', ids.a);
    ids.editorA2 = await mkUser('editor2@a.test', 'editor', ids.a);
    ids.adminA = await mkUser('admin@a.test', 'admin', ids.a);
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
    cookies.memberA = await loginAs('member@a.test');
    cookies.editorA = await loginAs('editor@a.test');
    cookies.editorA2 = await loginAs('editor2@a.test');
    cookies.adminA = await loginAs('admin@a.test');
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
          expect(ranged.headers.get('content-type')).toBe(contentType);
          expect(ranged.headers.get('content-range')).toBe(
            'bytes 0-3/' + bytes.byteLength
          );
          expect(ranged.headers.get('content-length')).toBe('4');
          expectSafeDownload(ranged);
          expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(
            bytes.subarray(0, 4)
          );
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
            expect(value, name).toMatch(/^[\x20-\x7e]*$/);
            if (name !== 'set-cookie') {
              expect(value, name).not.toContain(created.originalName);
            }
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
    const MIB = 1024 * 1024;
    /** A pull-driven multi-chunk request body; counts chunks the server read. */
    function streamed(chunks: Uint8Array[], contentLength?: number) {
      const state = { pulled: 0 };
      let next = 0;
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            const chunk = chunks[next++];
            if (!chunk) return controller.close();
            state.pulled += 1;
            controller.enqueue(chunk);
          },
        },
        { highWaterMark: 0 }
      );
      const digest = createHash('sha256');
      for (const c of chunks) digest.update(c);
      const headers: Record<string, string> = {
        'content-type': 'image/png',
        'x-content-sha256': digest.digest('hex'),
        cookie: cookies.editorA!,
        origin: ORIGIN,
      };
      if (contentLength !== undefined) {
        headers['content-length'] = String(contentLength);
      }
      const request = new Request(API + '/v2/media?filename=big.png', {
        method: 'POST',
        headers,
        body,
        duplex: 'half',
      } as RequestInit);
      return { request, state };
    }

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

    it('rejects a declared image above the per-type cap with 413 and stores nothing', async () => {
      const over = new Uint8Array(MAX_IMAGE_UPLOAD_BYTES + 1);
      over.set(PNG, 0);
      await expectDenied(
        'oversize declared',
        () =>
          upload({
            cookie: cookies.editorA,
            filename: 'huge.png',
            contentType: 'image/png',
            bytes: over,
          }),
        413
      );
    });

    it('stops a chunked image without Content-Length at the cap: 413, nothing stored, bounded bytes into storage', async () => {
      const chunks = Array.from({ length: 12 }, () => new Uint8Array(MIB));
      chunks[0]!.set(PNG, 0);
      const before = await snapshot();
      const putBefore = counters.putBytes;
      const { request, state } = streamed(chunks);
      const res = await app.request(request);
      expect(res.status).toBe(413);
      expect(await snapshot()).toBe(before);
      expect(counters.putBytes - putBefore).toBeLessThanOrEqual(
        MAX_IMAGE_UPLOAD_BYTES + MIB
      );
    });

    it('rejects a Content-Length above the global ceiling with 413 before reading any body byte', async () => {
      const chunks = Array.from({ length: 12 }, () => new Uint8Array(MIB));
      chunks[0]!.set(PNG, 0);
      const { request, state } = streamed(chunks, 101 * MIB);
      const putBefore = counters.putBytes;
      const before = await snapshot();
      const res = await app.request(request);
      expect(res.status).toBe(413);
      // The stream has no prefetch: the guard must answer before any read.
      expect(state.pulled).toBe(0);
      expect(counters.putBytes).toBe(putBefore);
      expect(await snapshot()).toBe(before);
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

    it('guard: nothing reachable from the Hono entrypoints imports an image or archive decoder', () => {
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
      const specifier = /(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g;
      const resolveRel = (from: string, spec: string): string | null => {
        const base = resolve(dirname(from), spec.replace(/\.js$/, ''));
        for (const c of [base + '.ts', join(base, 'index.ts')]) {
          if (existsSync(c)) return c;
        }
        return null;
      };
      const seen = new Set<string>();
      const queue = ['src/hono-app.ts', 'src/worker.ts', 'src/hono-server.ts']
        .map((f) => resolve(f))
        .filter((f) => existsSync(f));
      expect(queue.length).toBeGreaterThan(0);
      while (queue.length > 0) {
        const file = queue.pop()!;
        if (seen.has(file)) continue;
        seen.add(file);
        const text = readFileSync(file, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^\s*\/\/.*$/gm, '');
        for (const m of text.matchAll(specifier)) {
          const spec = m[1]!;
          if (spec.startsWith('.') || spec.startsWith('@/')) {
            if (spec.endsWith('.json')) continue;
            const next = spec.startsWith('@/')
              ? resolveRel(resolve('src', '_'), spec.slice(2))
              : resolveRel(file, spec);
            // An import the guard cannot follow is a failure, not a skip.
            expect(next, file + ' imports unresolvable ' + spec).not.toBeNull();
            queue.push(next!);
            continue;
          }
          const pkg = spec.startsWith('@')
            ? spec.split('/').slice(0, 2).join('/')
            : spec.split('/')[0]!;
          expect(decoders, file + ' imports ' + spec).not.toContain(pkg);
        }
      }
      expect(seen.size).toBeGreaterThan(50);
      expect([...seen].some((f) => f.endsWith('file.service.ts'))).toBe(false);
    });
  });

  describe('cross-community and role matrix', () => {
    const NOT_FOUND_FILE = '00000000-0000-4000-8000-000000000000';
    const NOT_FOUND_ID = 999999;

    it('keeps no signed or absolute URL identity: the legacy url column holds only the stable API path', async () => {
      const created = await uploadOk({
        cookie: cookies.editorA,
        filename: 'url-check.png',
        contentType: 'image/png',
        bytes: PNG,
      });
      const [row] = await db
        .select()
        .from(tables.files)
        .where(eq(tables.files.id, created.id));
      expect((row as { url: string }).url).toBe('/v2/media/' + created.id);
      for (const table of [tables.files, tables.attachments]) {
        for (const name of Object.keys(getTableColumns(table))) {
          expect(name, name).not.toMatch(/signed|expires|token|presign/i);
        }
      }
    });

    it('denies read, metadata, upload, delete, attach, detach and reorder across communities and below editor, with no change', async () => {
      const file = await uploadOk({
        cookie: cookies.editorA,
        filename: 'owned.png',
        contentType: 'image/png',
        bytes: PNG,
      });
      const file2 = await uploadOk({
        cookie: cookies.editorA,
        filename: 'owned-two.png',
        contentType: 'image/png',
        bytes: PNG,
      });
      leaks.push('owned.png', 'owned-two.png', file.id, file2.id);
      const attachOne = async (fileId: string) => {
        const res = await send('POST', '/v2/attachments', cookies.editorA, {
          fileId,
          ownerType: 'story',
          ownerId: ids.storyA,
          role: 'story_media',
        });
        expect(res.status).toBe(201);
        return AttachmentResponseSchema.parse(await res.json()).data;
      };
      const att1 = await attachOne(file.id);
      const att2 = await attachOne(file2.id);
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
      leaks.push('staged.png', staged.id);

      const readOf =
        (id: string, cookie?: string, extra = {}) =>
        () =>
          get('/v2/media/' + id, cookie, extra);
      const metaOf = (id: string, cookie?: string) => () =>
        get('/v2/media/' + id + '/metadata', cookie);
      const delOf = (id: string, cookie?: string) => () =>
        send('DELETE', '/v2/media/' + id, cookie);
      const attachBody = (fileId: string, ownerId: number) => ({
        fileId,
        ownerType: 'story',
        ownerId,
        role: 'story_media',
      });
      const attachOf =
        (cookie: string | undefined, fileId: string, owner: number) => () =>
          send('POST', '/v2/attachments', cookie, attachBody(fileId, owner));
      const detachOf = (id: number, cookie?: string) => () =>
        send('DELETE', '/v2/attachments/' + id, cookie);
      // Reverse order of two attachments: a leaked write would show in the snapshot.
      const reorderBody = (owner: number) => ({
        ownerType: 'story',
        ownerId: owner,
        role: 'story_media',
        attachmentIds: [att2.id, att1.id],
      });
      const reorderOf =
        (cookie: string | undefined, owner = ids.storyA!) =>
        () =>
          send('PATCH', '/v2/attachments/reorder', cookie, reorderBody(owner));

      type Cell = [
        string,
        () => Promise<Response>,
        number,
        (() => Promise<Response>)?,
      ];
      const denied: Cell[] = [
        // read and metadata
        ['anon read', readOf(file.id), 401],
        ['anon metadata', metaOf(file.id), 401],
        [
          'foreign editor read',
          readOf(file.id, cookies.editorB),
          404,
          readOf(NOT_FOUND_FILE, cookies.editorB),
        ],
        [
          'foreign admin read',
          readOf(file.id, cookies.adminB),
          404,
          readOf(NOT_FOUND_FILE, cookies.adminB),
        ],
        [
          'foreign admin metadata',
          metaOf(file.id, cookies.adminB),
          404,
          metaOf(NOT_FOUND_FILE, cookies.adminB),
        ],
        [
          'foreign range read',
          readOf(file.id, cookies.adminB, { range: 'bytes=0-3' }),
          404,
          readOf(NOT_FOUND_FILE, cookies.adminB, { range: 'bytes=0-3' }),
        ],
        [
          'super_admin read',
          readOf(file.id, cookies.superAdmin),
          404,
          readOf(NOT_FOUND_FILE, cookies.superAdmin),
        ],
        [
          'super_admin metadata',
          metaOf(file.id, cookies.superAdmin),
          404,
          metaOf(NOT_FOUND_FILE, cookies.superAdmin),
        ],
        [
          'member read of foreign staged file',
          readOf(own.id, cookies.memberA),
          404,
          readOf(NOT_FOUND_FILE, cookies.memberA),
        ],
        [
          'member read of unattached staged file',
          readOf(staged.id, cookies.memberA),
          404,
          readOf(NOT_FOUND_FILE, cookies.memberA),
        ],
        [
          'member metadata of unattached staged file',
          metaOf(staged.id, cookies.memberA),
          404,
          metaOf(NOT_FOUND_FILE, cookies.memberA),
        ],
        [
          'viewer read of unattached staged file',
          readOf(staged.id, cookies.viewerA),
          404,
          readOf(NOT_FOUND_FILE, cookies.viewerA),
        ],
        // upload
        [
          'anon upload',
          () =>
            upload({ filename: 'a.png', contentType: 'image/png', bytes: PNG }),
          401,
        ],
        [
          'viewer upload',
          () =>
            upload({
              cookie: cookies.viewerA,
              filename: 'a.png',
              contentType: 'image/png',
              bytes: PNG,
            }),
          403,
        ],
        [
          'member upload',
          () =>
            upload({
              cookie: cookies.memberA,
              filename: 'a.png',
              contentType: 'image/png',
              bytes: PNG,
            }),
          403,
        ],
        [
          'super_admin upload',
          () =>
            upload({
              cookie: cookies.superAdmin,
              filename: 'a.png',
              contentType: 'image/png',
              bytes: PNG,
            }),
          403,
        ],
        // delete
        ['anon delete', delOf(file.id), 401],
        [
          'foreign admin delete',
          delOf(file.id, cookies.adminB),
          404,
          delOf(NOT_FOUND_FILE, cookies.adminB),
        ],
        [
          'foreign editor delete staged',
          delOf(staged.id, cookies.editorB),
          404,
          delOf(NOT_FOUND_FILE, cookies.editorB),
        ],
        [
          'super_admin delete',
          delOf(file.id, cookies.superAdmin),
          404,
          delOf(NOT_FOUND_FILE, cookies.superAdmin),
        ],
        ['member delete', delOf(file.id, cookies.memberA), 403],
        ['viewer delete', delOf(file.id, cookies.viewerA), 403],
        // attach
        ['anon attach', attachOf(undefined, staged.id, ids.storyA!), 401],
        [
          'viewer attach',
          attachOf(cookies.viewerA, staged.id, ids.storyA!),
          403,
        ],
        [
          'member attach',
          attachOf(cookies.memberA, staged.id, ids.storyA!),
          403,
        ],
        [
          'super_admin attach',
          attachOf(cookies.superAdmin, staged.id, ids.storyA!),
          403,
        ],
        [
          'foreign file onto own story',
          attachOf(cookies.adminB, staged.id, ids.storyB!),
          404,
          attachOf(cookies.adminB, NOT_FOUND_FILE, ids.storyB!),
        ],
        [
          'own file onto foreign story',
          attachOf(cookies.adminB, own.id, ids.storyA!),
          404,
          attachOf(cookies.adminB, own.id, NOT_FOUND_ID),
        ],
        [
          'reuse of a foreign attached file',
          attachOf(cookies.adminB, file.id, ids.storyB!),
          404,
          attachOf(cookies.adminB, NOT_FOUND_FILE, ids.storyB!),
        ],
        // detach
        ['anon detach', detachOf(att1.id), 401],
        ['viewer detach', detachOf(att1.id, cookies.viewerA), 403],
        ['member detach', detachOf(att1.id, cookies.memberA), 403],
        ['super_admin detach', detachOf(att1.id, cookies.superAdmin), 403],
        [
          'foreign admin detach',
          detachOf(att1.id, cookies.adminB),
          404,
          detachOf(NOT_FOUND_ID, cookies.adminB),
        ],
        // reorder
        ['anon reorder', reorderOf(undefined), 401],
        ['viewer reorder', reorderOf(cookies.viewerA), 403],
        ['member reorder', reorderOf(cookies.memberA), 403],
        ['super_admin reorder', reorderOf(cookies.superAdmin), 403],
        [
          'foreign admin reorder',
          reorderOf(cookies.adminB),
          404,
          reorderOf(cookies.adminB, NOT_FOUND_ID),
        ],
      ];
      for (const [label, run, status, control] of denied) {
        await expectDenied(label, run, status, control);
      }

      // The owner still reads the exact bytes, and the order is unchanged.
      const reread = await get('/v2/media/' + file.id, cookies.editorA);
      expect(reread.status).toBe(200);
      expect(new Uint8Array(await reread.arrayBuffer())).toEqual(PNG);
      const order = async () =>
        (
          await db
            .select()
            .from(tables.attachments)
            .where(eq(tables.attachments.ownerId, ids.storyA!))
        )
          .sort((x, y) => x.ordinal - y.ordinal)
          .map((r) => r.id);
      expect(await order()).toEqual([att1.id, att2.id]);

      // Allowed paths: read by every community role, then admin write paths.
      for (const cookie of [cookies.viewerA, cookies.memberA, cookies.adminA]) {
        const ok = await get('/v2/media/' + file.id, cookie);
        expect(ok.status).toBe(200);
        expect(new Uint8Array(await ok.arrayBuffer())).toEqual(PNG);
      }
      expect((await metaOf(file.id, cookies.memberA)()).status).toBe(200);
      const reordered = await reorderOf(cookies.adminA)();
      expect(reordered.status).toBe(200);
      expect(await order()).toEqual([att2.id, att1.id]);
      expect(
        (await attachOf(cookies.adminA, staged.id, ids.storyA!)()).status
      ).toBe(201);
      expect((await detachOf(att1.id, cookies.adminA)()).status).toBe(204);
      const toDelete = await uploadOk({
        cookie: cookies.editorA,
        filename: 'to-delete.png',
        contentType: 'image/png',
        bytes: PNG,
      });
      expect((await delOf(toDelete.id, cookies.adminA)()).status).toBe(204);
      expect(
        (await get('/v2/media/' + toDelete.id, cookies.editorA)).status
      ).toBe(404);
    });
  });

  describe('direct multipart upload routes', () => {
    const video = (() => {
      const bytes = new Uint8Array(1024);
      bytes.set([
        0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2,
        0, 0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x31,
      ]);
      return bytes;
    })();
    const sha = createHash('sha256').update(video).digest('hex');
    const NOT_FOUND = '00000000-0000-4000-8000-000000000000';

    const create = (cookie?: string) =>
      send('POST', '/v2/media/uploads', cookie, {
        filename: 'clip.mp4',
        contentType: 'video/mp4',
        size: video.byteLength,
        sha256: sha,
        partSha256: [sha],
      });
    async function session(cookie: string) {
      const res = await create(cookie);
      expect(res.status, await res.clone().text()).toBe(201);
      return DirectUploadSessionResponseSchema.parse(await res.json()).data;
    }
    const presign = (id: string, cookie?: string) => () =>
      send('POST', '/v2/media/uploads/' + id + '/parts/presign', cookie);
    const putPart =
      (
        target: { url: string; headers: Record<string, string> },
        cookie?: string
      ) =>
      () =>
        app.request(target.url, {
          method: 'PUT',
          headers: {
            ...target.headers,
            ...(cookie ? { cookie } : {}),
            'content-length': String(video.byteLength),
          },
          body: video,
        });
    const complete = (id: string, etag: string, cookie?: string) => () =>
      send('POST', '/v2/media/uploads/' + id + '/complete', cookie, {
        parts: [{ partNumber: 1, etag }],
      });
    const abort = (id: string, cookie?: string) => () =>
      send('DELETE', '/v2/media/uploads/' + id, cookie);

    it('denies session create for anon, viewer, member and super_admin and allows editor and admin', async () => {
      for (const [label, cookie, status] of [
        ['anon', undefined, 401],
        ['viewer', cookies.viewerA, 403],
        ['member', cookies.memberA, 403],
        ['super_admin', cookies.superAdmin, 403],
      ] as Array<[string, string | undefined, number]>) {
        await expectDenied('create ' + label, () => create(cookie), status);
      }
      for (const cookie of [cookies.editorA, cookies.adminA]) {
        const created = await session(cookie!);
        expect((await abort(created.id, cookie)()).status).toBe(204);
      }
    });

    it('isolates presign, part upload, complete and abort to the owner session', async () => {
      const owned = await session(cookies.editorA!);
      leaks.push(owned.id);
      const target = owned.parts[0]!;
      const other = [
        ['anon', undefined, 401],
        ['same-community editor', cookies.editorA2, 404],
        ['foreign editor', cookies.editorB, 404],
        ['foreign admin', cookies.adminB, 404],
      ] as Array<[string, string | undefined, number]>;
      for (const [label, cookie, status] of other) {
        const concealed = status === 404;
        await expectDenied(
          'presign ' + label,
          presign(owned.id, cookie),
          status,
          concealed ? presign(NOT_FOUND, cookie) : undefined
        );
        await expectDenied(
          'put part ' + label,
          putPart(target, cookie),
          status,
          concealed
            ? putPart(
                {
                  ...target,
                  url: target.url.replace(owned.id, NOT_FOUND),
                },
                cookie
              )
            : undefined
        );
        await expectDenied(
          'complete ' + label,
          complete(owned.id, sha, cookie),
          status,
          concealed ? complete(NOT_FOUND, sha, cookie) : undefined
        );
        await expectDenied(
          'abort ' + label,
          abort(owned.id, cookie),
          status,
          concealed ? abort(NOT_FOUND, cookie) : undefined
        );
      }
      for (const [label, cookie] of [
        ['viewer', cookies.viewerA],
        ['member', cookies.memberA],
        ['super_admin', cookies.superAdmin],
      ] as Array<[string, string]>) {
        // A role that cannot own sessions sees the session as nonexistent.
        await expectDenied(
          'presign ' + label,
          presign(owned.id, cookie),
          404,
          presign(NOT_FOUND, cookie)
        );
        await expectDenied(
          'put part ' + label,
          putPart(target, cookie),
          404,
          putPart(
            { ...target, url: target.url.replace(owned.id, NOT_FOUND) },
            cookie
          )
        );
        await expectDenied(
          'complete ' + label,
          complete(owned.id, sha, cookie),
          404,
          complete(NOT_FOUND, sha, cookie)
        );
        await expectDenied(
          'abort ' + label,
          abort(owned.id, cookie),
          404,
          abort(NOT_FOUND, cookie)
        );
      }

      // The owner path still works after every denial.
      expect((await presign(owned.id, cookies.editorA)()).status).toBe(200);
      const put = await putPart(target, cookies.editorA)();
      expect(put.status).toBe(200);
      const etag = put.headers.get('etag')!.replace(/"/g, '');
      const done = await complete(owned.id, etag, cookies.editorA)();
      expect(done.status).toBe(201);
      const created = MediaUploadResponseSchema.parse(await done.json()).data;
      expect(created.checksum).toBe(sha);
      const read = await get('/v2/media/' + created.id, cookies.editorA);
      expect(new Uint8Array(await read.arrayBuffer())).toEqual(video);
      // A finished session is gone.
      expect((await complete(owned.id, etag, cookies.editorA)()).status).toBe(
        404
      );
    });

    it('lets an admin of the same community abort a stale session', async () => {
      const owned = await session(cookies.editorA!);
      expect((await abort(owned.id, cookies.adminA)()).status).toBe(204);
      expect((await abort(owned.id, cookies.editorA)()).status).toBe(404);
    });
  });
});
