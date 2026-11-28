/**
 * Security response headers on every V2 response (issue #138): JSON route,
 * error routes, a media download, a CORS preflight, and https-only HSTS.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import {
  argon2Seed,
  makeDerivedKey,
  makeServerSecret,
} from './auth-test-utils.js';
import { tablesFor } from '../../src/db/dialect.js';
import { Hono } from 'hono';
import { createHonoApp, v2SecurityHeaders } from '../../src/hono-app.js';
import { HonoFoundationRepository } from '../../src/repositories/hono-foundation.repository.js';
import { MediaCleanupCoordinator } from '../../src/services/media-cleanup.service.js';
import { assertPutSha256, rawUploadRequest } from '../helpers/raw-upload.js';
import type { FoundationStorage } from '../../src/services/hono-foundation.service.js';
import { deriveUserIdentityColumns } from '../../src/shared/utils/derived-columns.js';

const sqlite = new Sqlite(':memory:');
sqlite.pragma('foreign_keys = ON');
const db = drizzle(sqlite);
const tables = tablesFor(db);

const KEY = makeDerivedKey();
const API_ORIGIN = 'https://api.example.test';
const CLIENT_ORIGIN = 'https://app.example.test';
const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06,
  0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
]);
const CSP = "default-src 'none'; frame-ancestors 'none'; sandbox";

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
  async put(key, stream, opts) {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    const merged = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
    let pos = 0;
    for (const c of chunks) {
      merged.set(c, pos);
      pos += c.byteLength;
    }
    assertPutSha256(merged, opts?.sha256);
    store.set(key, merged);
    return { size: merged.byteLength };
  },
  async delete(key) {
    store.delete(key);
  },
};

let app: ReturnType<typeof createHonoApp>;
let cookie = '';
let mediaId = 0;

function expectBaseline(res: Response) {
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  expect(res.headers.get('content-security-policy')).toBe(CSP);
  expect(res.headers.get('x-frame-options')).toBe('DENY');
  expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  expect(res.headers.get('x-powered-by')).toBeNull();
}

const HSTS = 'max-age=31536000';

describe('V2 security response headers (#138)', () => {
  beforeAll(async () => {
    migrate(db, { migrationsFolder: './src/db/migrations' });
    const now = new Date('2026-06-01T12:00:00.000Z');
    const seed = await argon2Seed(KEY);
    const [community] = await db
      .insert(tables.communities)
      .values({
        name: 'Hdr Nation',
        slug: 'hdr-nation',
        publicStories: true,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: tables.communities.id });
    const derived = deriveUserIdentityColumns({
      email: 'admin@hdr.test',
      firstName: 'Ad',
      lastName: 'Admin',
      communityId: community!.id,
    });
    await db.insert(tables.users).values({
      email: 'admin@hdr.test',
      emailNormalized: derived.emailNormalized,
      ...seed,
      firstName: 'Ad',
      lastName: 'Admin',
      displayNameNormalized: derived.displayNameNormalized,
      role: 'admin',
      communityId: community!.id,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });
    app = createHonoApp({
      repository: new HonoFoundationRepository(db),
      serverSecret: makeServerSecret(),
      secureCookies: false,
      publicOrigin: API_ORIGIN,
      corsOrigins: [CLIENT_ORIGIN],
      storage,
      mediaCleanup: new MediaCleanupCoordinator(db, storage),
    });
    const login = await app.request(`${API_ORIGIN}/v2/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: 'admin@hdr.test', derivedKey: KEY }),
    });
    expect(login.status).toBe(200);
    cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const raw = rawUploadRequest({
      filename: 'a.png',
      contentType: 'image/png',
      bytes: PNG_BYTES,
    });
    const up = await app.request(`${API_ORIGIN}/v2/media${raw.search}`, {
      method: 'POST',
      headers: { ...raw.headers, origin: CLIENT_ORIGIN, cookie },
      body: raw.body,
    });
    expect(up.status).toBe(201);
    mediaId = ((await up.json()) as { data: { id: number } }).data.id;
  });

  afterAll(() => {
    sqlite.close();
  });

  it('sets the baseline headers on a JSON route', async () => {
    const res = await app.request(`${API_ORIGIN}/health`);
    expect(res.status).toBe(200);
    expectBaseline(res);
    expect(res.headers.get('cross-origin-resource-policy')).toBe('same-site');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('sets them on 404 and 401 responses', async () => {
    const notFound = await app.request(`${API_ORIGIN}/v2/media/999999`, {
      headers: { cookie },
    });
    expect(notFound.status).toBe(404);
    expectBaseline(notFound);
    const unauth = await app.request(`${API_ORIGIN}/v2/auth/me`);
    expect(unauth.status).toBe(401);
    expectBaseline(unauth);
  });

  it('sets them on a refused cross-origin mutation', async () => {
    const res = await app.request(`${API_ORIGIN}/v2/auth/logout`, {
      method: 'POST',
      headers: { origin: 'https://evil.invalid', cookie },
    });
    expect(res.status).toBe(403);
    expectBaseline(res);
    // The refused request must not have revoked the session.
    const me = await app.request(`${API_ORIGIN}/v2/auth/me`, {
      headers: { cookie },
    });
    expect(me.status).toBe(200);
  });

  it('removes a handler-set X-Powered-By', async () => {
    const probe = new Hono();
    probe.use('*', v2SecurityHeaders());
    probe.get('/probe-powered', (c) => {
      c.header('X-Powered-By', 'something');
      return c.json({ ok: true });
    });
    const res = await probe.request(`${API_ORIGIN}/probe-powered`);
    expect(res.status).toBe(200);
    expectBaseline(res);
  });

  it('limits cross-origin CORP to GET/HEAD even when a mutation returns 200', async () => {
    const probe = new Hono();
    probe.use('*', v2SecurityHeaders());
    probe.all('/v2/media/:id', (c) => c.text('ok', 200));
    for (const method of ['GET', 'HEAD']) {
      const res = await probe.request(`${API_ORIGIN}/v2/media/1`, { method });
      expect(res.status).toBe(200);
      expect(res.headers.get('cross-origin-resource-policy')).toBe(
        'cross-origin'
      );
    }
    for (const method of ['DELETE', 'PUT', 'PATCH', 'POST']) {
      const res = await probe.request(`${API_ORIGIN}/v2/media/1`, { method });
      expect(res.status, method).toBe(200);
      expect(res.headers.get('cross-origin-resource-policy'), method).toBe(
        'same-site'
      );
    }
  });

  it('keeps CORP same-site on media denials and mutations', async () => {
    const denied = await app.request(`${API_ORIGIN}/v2/media/${mediaId}`);
    expect(denied.status).toBe(401);
    expect(denied.headers.get('cross-origin-resource-policy')).toBe(
      'same-site'
    );
    const missingDelete = await app.request(`${API_ORIGIN}/v2/media/999999`, {
      method: 'DELETE',
      headers: { cookie, origin: CLIENT_ORIGIN },
    });
    expect(missingDelete.status).toBe(404);
    // A successful delete is a mutation too: CORP stays same-site.
    const raw = rawUploadRequest({
      filename: 'b.png',
      contentType: 'image/png',
      bytes: PNG_BYTES,
    });
    const up = await app.request(`${API_ORIGIN}/v2/media${raw.search}`, {
      method: 'POST',
      headers: { ...raw.headers, origin: CLIENT_ORIGIN, cookie },
      body: raw.body,
    });
    expect(up.status).toBe(201);
    const deleteId = ((await up.json()) as { data: { id: number } }).data.id;
    const deleted = await app.request(`${API_ORIGIN}/v2/media/${deleteId}`, {
      method: 'DELETE',
      headers: { cookie, origin: CLIENT_ORIGIN },
    });
    expect(deleted.status).toBe(204);
    expect(deleted.headers.get('cross-origin-resource-policy')).toBe(
      'same-site'
    );
    expect(missingDelete.headers.get('cross-origin-resource-policy')).toBe(
      'same-site'
    );
  });

  it('keeps media embeddable by the frontend origin and sandboxed', async () => {
    const res = await app.request(`${API_ORIGIN}/v2/media/${mediaId}`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    expectBaseline(res);
    expect(res.headers.get('content-disposition')).toBe('attachment');
    expect(res.headers.get('cross-origin-resource-policy')).toBe(
      'cross-origin'
    );
    const ranged = await app.request(`${API_ORIGIN}/v2/media/${mediaId}`, {
      headers: { cookie, range: 'bytes=0-3' },
    });
    expect(ranged.status).toBe(206);
    expectBaseline(ranged);
    expect(ranged.headers.get('cross-origin-resource-policy')).toBe(
      'cross-origin'
    );
  });

  it('sets them on a CORS preflight alongside the CORS headers', async () => {
    const res = await app.request(`${API_ORIGIN}/v2/media?filename=a.png`, {
      method: 'OPTIONS',
      headers: {
        origin: CLIENT_ORIGIN,
        'access-control-request-method': 'POST',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(CLIENT_ORIGIN);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expectBaseline(res);
  });

  it('exposes ETag and Retry-After to allowed cross-origin clients', async () => {
    const res = await app.request(`${API_ORIGIN}/health`, {
      headers: { origin: CLIENT_ORIGIN },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe(CLIENT_ORIGIN);
    const exposed = (res.headers.get('access-control-expose-headers') ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase());
    expect(exposed).toEqual(expect.arrayContaining(['etag', 'retry-after']));
  });

  it('sends HSTS only over https', async () => {
    const https = await app.request(`${API_ORIGIN}/health`);
    expect(https.headers.get('strict-transport-security')).toBe(HSTS);
    const http = await app.request('http://api.example.test/health');
    expect(http.headers.get('strict-transport-security')).toBeNull();
    // A forwarded proto is honoured only behind a configured trusted proxy.
    const forwarded = await app.request('http://api.example.test/health', {
      headers: { 'x-forwarded-proto': 'https' },
    });
    expect(forwarded.headers.get('strict-transport-security')).toBeNull();
  });

  it('honours x-forwarded-proto https only with trustProxy', async () => {
    const proxied = createHonoApp({
      repository: new HonoFoundationRepository(db),
      serverSecret: makeServerSecret(),
      secureCookies: false,
      publicOrigin: API_ORIGIN,
      corsOrigins: [CLIENT_ORIGIN],
      storage,
      trustProxy: true,
    });
    const https = await proxied.request('http://api.example.test/health', {
      headers: { 'x-forwarded-proto': 'https' },
    });
    expect(https.headers.get('strict-transport-security')).toBe(HSTS);
    // Ambiguous (appended) multi-value input is not trusted.
    for (const value of ['http, https', 'https, http', 'https,https']) {
      const multi = await proxied.request('http://api.example.test/health', {
        headers: { 'x-forwarded-proto': value },
      });
      expect(multi.headers.get('strict-transport-security'), value).toBeNull();
    }
    const http = await proxied.request('http://api.example.test/health', {
      headers: { 'x-forwarded-proto': 'http' },
    });
    expect(http.headers.get('strict-transport-security')).toBeNull();
  });
});
