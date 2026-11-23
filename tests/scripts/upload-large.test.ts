/**
 * Unit tests for scripts/staging/upload-large.ts: the upload plan and the
 * create -> parts -> complete -> delete flow, driven by a fake fetch (no
 * network, no Cloudflare). Also checks the secret hygiene the procedure
 * promises: cookie, password and presigned URLs never reach the log.
 */
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PART_SIZE,
  buildCreateBody,
  cleanEtag,
  loginSuper,
  main,
  planParts,
  runUpload,
  sha256Hex,
  uploadViaThrowawayCommunity,
  type FetchLike,
} from '../../scripts/staging/upload-large.js';
import { PNG_BYTES } from '../../scripts/walkthrough/client.js';

const BASE = 'https://terrastories-staging-api.x.workers.dev';
const COOKIE = 'ts_session=secret-cookie-value';
const MIB = 1024 * 1024;

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string | Uint8Array;
  redirect?: string;
}

/** A fetch stand-in that records every call and answers from a route fn. */
function fakeFetch(
  route: (call: Call) => Response | Promise<Response> | undefined
) {
  const calls: Call[] = [];
  const impl: FetchLike = async (url, init = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const call: Call = {
      method: init.method ?? 'GET',
      url,
      redirect: init.redirect,
      headers,
      body:
        typeof init.body === 'string' || init.body instanceof Uint8Array
          ? init.body
          : undefined,
    };
    calls.push(call);
    const res = await route(call);
    if (!res) throw new Error(`unexpected request: ${call.method} ${url}`);
    return res;
  };
  return { calls, impl };
}

const sha = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');

const partTarget = (over: Record<string, unknown> = {}) => ({
  partNumber: 1,
  method: 'PUT',
  url: 'https://acct.r2.cloudflarestorage.com/terrastories-staging-media/key?partNumber=1&uploadId=u&X-Amz-Signature=SECRET',
  headers: {},
  size: PNG_BYTES.byteLength,
  ...over,
});

const sessionResponse = (
  parts: Array<Record<string, unknown>>,
  mode: 'presigned' | 'api' = 'presigned',
  id = 'sess-1'
) =>
  Response.json(
    {
      data: {
        id,
        mode,
        expiresAt: '2026-01-01T02:00:00.000Z',
        partSize: DEFAULT_PART_SIZE,
        partCount: parts.length,
        maxBytes: 512 * MIB,
        parts,
      },
    },
    { status: 201 }
  );

describe('planParts', () => {
  it('splits an exact multiple into full parts', () => {
    expect(planParts(32 * MIB, 16 * MIB)).toEqual([
      { partNumber: 1, offset: 0, size: 16 * MIB },
      { partNumber: 2, offset: 16 * MIB, size: 16 * MIB },
    ]);
  });

  it('gives the remainder to the last part', () => {
    expect(planParts(33 * MIB, 16 * MIB)).toEqual([
      { partNumber: 1, offset: 0, size: 16 * MIB },
      { partNumber: 2, offset: 16 * MIB, size: 16 * MIB },
      { partNumber: 3, offset: 32 * MIB, size: 1 * MIB },
    ]);
  });

  it('plans one part for a file under the part size', () => {
    expect(planParts(10, 16 * MIB)).toEqual([
      { partNumber: 1, offset: 0, size: 10 },
    ]);
  });

  it('refuses invalid sizes and part sizes outside the API contract', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => planParts(bad, 16 * MIB), String(bad)).toThrow();
    }
    for (const bad of [8 * MIB, 128 * MIB, 0, 16 * MIB + 0.5]) {
      expect(() => planParts(33 * MIB, bad), String(bad)).toThrow(
        /between 16 MiB and 64 MiB/
      );
    }
  });
});

describe('buildCreateBody', () => {
  it('declares the whole-file and per-part digests the API expects', () => {
    // 2 part sizes + a remainder: the plan must be 16 MiB / 16 MiB / 1 MiB
    const bytes = Buffer.alloc(33 * MIB, 7);
    const body = buildCreateBody({
      name: 'sample.mp4',
      contentType: 'video/mp4',
      bytes,
    });
    expect(body).toEqual({
      filename: 'sample.mp4',
      contentType: 'video/mp4',
      size: 33 * MIB,
      sha256: sha(bytes),
      partSize: DEFAULT_PART_SIZE,
      partSha256: [
        sha(bytes.subarray(0, 16 * MIB)),
        sha(bytes.subarray(16 * MIB, 32 * MIB)),
        sha(bytes.subarray(32 * MIB, 33 * MIB)),
      ],
    });
  });
});

describe('cleanEtag', () => {
  it('strips the S3 quote wrapping and tolerates a missing header', () => {
    expect(cleanEtag('"abc123"')).toBe('abc123');
    expect(cleanEtag('abc123')).toBe('abc123');
    expect(cleanEtag(null)).toBe('');
  });
});

describe('runUpload (fake fetch)', () => {
  it('presigned single part: create -> PUT (exact headers, no cookie) -> complete -> delete', async () => {
    const { calls, impl } = fakeFetch((call) => {
      if (call.method === 'POST' && call.url === `${BASE}/v2/media/uploads`)
        return sessionResponse([partTarget()]);
      if (call.method === 'PUT')
        return new Response(null, {
          status: 200,
          headers: { ETag: '"etag-1"' },
        });
      if (
        call.method === 'POST' &&
        call.url === `${BASE}/v2/media/uploads/sess-1/complete`
      )
        return Response.json({ data: { id: 'media-1' } }, { status: 201 });
      if (call.method === 'DELETE' && call.url === `${BASE}/v2/media/media-1`)
        return new Response(null, { status: 204 });
      return undefined;
    });
    const lines: string[] = [];
    const outcome = await runUpload(
      {
        baseUrl: BASE,
        cookie: COOKIE,
        file: {
          name: 'sample.mp4',
          contentType: 'video/mp4',
          bytes: PNG_BYTES,
        },
      },
      { fetch: impl, log: (l) => lines.push(l) }
    );
    expect(outcome.sessionId).toBe('sess-1');
    expect(outcome.mediaId).toBe('media-1');
    expect(outcome.partCount).toBe(1);
    expect(calls.map((c) => `${c.method} ${c.url.split('?')[0]}`)).toEqual([
      `POST ${BASE}/v2/media/uploads`,
      'PUT https://acct.r2.cloudflarestorage.com/terrastories-staging-media/key',
      `POST ${BASE}/v2/media/uploads/sess-1/complete`,
      `DELETE ${BASE}/v2/media/media-1`,
    ]);
    // create body matches the plan; the session cookie rides the API calls
    const create = JSON.parse(String(calls[0]!.body));
    expect(create).toEqual(
      buildCreateBody({
        name: 'sample.mp4',
        contentType: 'video/mp4',
        bytes: PNG_BYTES,
      })
    );
    for (const i of [0, 2, 3]) expect(calls[i]!.headers.cookie).toBe(COOKIE);
    // the presigned part gets EXACTLY the returned headers (empty) and the
    // exact bytes; the session cookie must never go to the R2 endpoint
    expect(calls[1]!.headers.cookie).toBeUndefined();
    expect(calls[1]!.headers['content-type']).toBeUndefined();
    expect(calls[1]!.body).toEqual(PNG_BYTES);
    // complete carries the unquoted ETag
    expect(JSON.parse(String(calls[2]!.body))).toEqual({
      parts: [{ partNumber: 1, etag: 'etag-1' }],
    });
    // secret hygiene: no cookie value, no presigned URL/signature in the log
    const log = lines.join('\n');
    expect(log).not.toContain('secret-cookie-value');
    expect(log).not.toContain('X-Amz-Signature');
    expect(log).not.toContain('cloudflarestorage.com');
  });

  it('api mode, three parts: cookie + returned checksum header per part, etag from the JSON body, sorted completion', async () => {
    // default 16 MiB parts over 33 MiB -> 16 MiB / 16 MiB / 1 MiB
    const bytes = Buffer.alloc(33 * MIB, 9);
    const target = (n: number, size: number) =>
      partTarget({
        partNumber: n,
        url: `${BASE}/v2/media/uploads/sess-2/parts/${n}`,
        headers: { 'x-amz-checksum-sha256': `b64-${n}` },
        size,
      });
    const { calls, impl } = fakeFetch((call) => {
      if (call.method === 'POST' && call.url === `${BASE}/v2/media/uploads`)
        // deliberately out of order: the flow must sort by partNumber
        return sessionResponse(
          [target(2, 16 * MIB), target(1, 16 * MIB), target(3, MIB)],
          'api',
          'sess-2'
        );
      const part = /\/parts\/(\d+)$/.exec(call.url);
      if (call.method === 'PUT' && part)
        return Response.json({
          data: { partNumber: Number(part[1]), etag: `e${part[1]}` },
        });
      if (
        call.method === 'POST' &&
        call.url === `${BASE}/v2/media/uploads/sess-2/complete`
      )
        return Response.json({ data: { id: 'media-2' } }, { status: 201 });
      if (call.method === 'DELETE' && call.url === `${BASE}/v2/media/media-2`)
        return new Response(null, { status: 204 });
      return undefined;
    });
    const outcome = await runUpload(
      {
        baseUrl: BASE,
        cookie: COOKIE,
        file: { name: 'large.bin', contentType: 'video/mp4', bytes },
      },
      { fetch: impl }
    );
    expect(outcome.partCount).toBe(3);
    const puts = calls.filter((c) => c.method === 'PUT');
    expect(puts.map((c) => c.url)).toEqual([
      `${BASE}/v2/media/uploads/sess-2/parts/1`,
      `${BASE}/v2/media/uploads/sess-2/parts/2`,
      `${BASE}/v2/media/uploads/sess-2/parts/3`,
    ]);
    puts.forEach((put, i) => {
      expect(put.headers.cookie).toBe(COOKIE);
      expect(put.headers['x-amz-checksum-sha256']).toBe(`b64-${i + 1}`);
      const offset = i * 16 * MIB;
      const size = i === 2 ? MIB : 16 * MIB;
      const expected = bytes.subarray(offset, offset + size);
      expect(
        Buffer.from(put.body as Uint8Array).equals(Buffer.from(expected))
      ).toBe(true);
    });
    const complete = calls.find((c) => c.url.endsWith('/complete'))!;
    expect(JSON.parse(String(complete.body))).toEqual({
      parts: [
        { partNumber: 1, etag: 'e1' },
        { partNumber: 2, etag: 'e2' },
        { partNumber: 3, etag: 'e3' },
      ],
    });
  });

  it('a failed part aborts the session and never completes', async () => {
    const { calls, impl } = fakeFetch((call) => {
      if (call.method === 'POST' && call.url === `${BASE}/v2/media/uploads`)
        return sessionResponse([partTarget()]);
      if (call.method === 'PUT') return new Response(null, { status: 403 });
      if (
        call.method === 'DELETE' &&
        call.url === `${BASE}/v2/media/uploads/sess-1`
      )
        return new Response(null, { status: 204 });
      return undefined;
    });
    await expect(
      runUpload(
        {
          baseUrl: BASE,
          cookie: COOKIE,
          file: { name: 's.mp4', contentType: 'video/mp4', bytes: PNG_BYTES },
        },
        { fetch: impl }
      )
    ).rejects.toThrow(/part 1 PUT answered 403/);
    expect(calls.some((c) => c.url.endsWith('/complete'))).toBe(false);
    const abort = calls.find(
      (c) =>
        c.method === 'DELETE' && c.url === `${BASE}/v2/media/uploads/sess-1`
    );
    expect(abort?.headers.cookie).toBe(COOKIE);
  });

  it('create 501 fails with the not-configured hint and makes no other call', async () => {
    const { calls, impl } = fakeFetch(() =>
      Response.json(
        { error: 'Direct upload is not available on this deployment' },
        { status: 501 }
      )
    );
    await expect(
      runUpload(
        {
          baseUrl: BASE,
          cookie: COOKIE,
          file: { name: 's.mp4', contentType: 'video/mp4', bytes: PNG_BYTES },
        },
        { fetch: impl }
      )
    ).rejects.toThrow(/answered 501.*not configured/);
    expect(calls).toHaveLength(1);
  });

  it('a failed complete aborts the session; a failed delete after complete does not', async () => {
    const failComplete = fakeFetch((call) => {
      if (call.method === 'POST' && call.url === `${BASE}/v2/media/uploads`)
        return sessionResponse([partTarget()]);
      if (call.method === 'PUT')
        return new Response(null, { status: 200, headers: { ETag: '"e"' } });
      if (call.url.endsWith('/complete'))
        return new Response(null, { status: 422 });
      if (
        call.method === 'DELETE' &&
        call.url === `${BASE}/v2/media/uploads/sess-1`
      )
        return new Response(null, { status: 204 });
      return undefined;
    });
    await expect(
      runUpload(
        {
          baseUrl: BASE,
          cookie: COOKIE,
          file: { name: 's.mp4', contentType: 'video/mp4', bytes: PNG_BYTES },
        },
        { fetch: failComplete.impl }
      )
    ).rejects.toThrow(/complete answered 422/);
    expect(
      failComplete.calls.some(
        (c) =>
          c.method === 'DELETE' && c.url === `${BASE}/v2/media/uploads/sess-1`
      )
    ).toBe(true);

    const failDelete = fakeFetch((call) => {
      if (call.method === 'POST' && call.url === `${BASE}/v2/media/uploads`)
        return sessionResponse([partTarget()]);
      if (call.method === 'PUT')
        return new Response(null, { status: 200, headers: { ETag: '"e"' } });
      if (call.url.endsWith('/complete'))
        return Response.json({ data: { id: 'media-9' } }, { status: 201 });
      if (call.method === 'DELETE' && call.url === `${BASE}/v2/media/media-9`)
        return new Response(null, { status: 500 });
      return undefined;
    });
    await expect(
      runUpload(
        {
          baseUrl: BASE,
          cookie: COOKIE,
          file: { name: 's.mp4', contentType: 'video/mp4', bytes: PNG_BYTES },
        },
        { fetch: failDelete.impl }
      )
    ).rejects.toThrow(/media-9.*manually/);
    // the session is already gone after a successful complete: no abort
    expect(
      failDelete.calls.some(
        (c) =>
          c.method === 'DELETE' && c.url === `${BASE}/v2/media/uploads/sess-1`
      )
    ).toBe(false);
  });
});

describe('loginSuper (fake fetch)', () => {
  const salt = Buffer.from('0123456789abcdef').toString('base64');
  const argonAnswer = {
    algorithm: 'client-argon2id+sha256',
    salt,
    params: { memoryKiB: 19 * 1024, iterations: 2, parallelism: 1 },
  };
  const loginOk = () => {
    const res = Response.json({ user: { id: 1, role: 'super_admin' } });
    res.headers.append(
      'set-cookie',
      'ts_session=secret-cookie-value; Path=/; HttpOnly; Secure'
    );
    return res;
  };

  it('stretches the password client-side and returns the session cookie', async () => {
    const { calls, impl } = fakeFetch((call) => {
      if (call.url === `${BASE}/v2/auth/prelogin`)
        return Response.json(argonAnswer);
      if (call.url === `${BASE}/v2/auth/login`) return loginOk();
      return undefined;
    });
    const cookie = await loginSuper(
      impl,
      BASE,
      'staging-super',
      'test-password-123'
    );
    expect(cookie).toBe('ts_session=secret-cookie-value');
    expect(JSON.parse(String(calls[0]!.body))).toEqual({
      identifier: 'staging-super',
    });
    const login = JSON.parse(String(calls[1]!.body));
    expect(login.identifier).toBe('staging-super');
    expect(login.derivedKey).toMatch(/^[0-9a-f]{64}$/);
    // the password itself never goes on the wire
    for (const call of calls)
      expect(String(call.body)).not.toContain('test-password-123');
  });

  it('sends the Argon2id upgrade with a migrated Rails bcrypt login', async () => {
    const { calls, impl } = fakeFetch((call) => {
      if (call.url === `${BASE}/v2/auth/prelogin`)
        return Response.json({
          algorithm: 'client-bcrypt-rails+sha256',
          salt: 'abcdefghijklmnopqrstuu',
          params: { cost: 4 },
        });
      if (call.url === `${BASE}/v2/auth/login`) return loginOk();
      return undefined;
    });
    await loginSuper(impl, BASE, 'migrated-admin', 'test-password-123');
    const login = JSON.parse(String(calls[1]!.body));
    expect(login.derivedKey).toMatch(/^\$2a\$04\$/);
    expect(login.upgrade.algorithm).toBe('client-argon2id+sha256');
    expect(login.upgrade.derivedKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it('fails closed on a rejected login or a missing cookie', async () => {
    const rejected = fakeFetch((call) => {
      if (call.url === `${BASE}/v2/auth/prelogin`)
        return Response.json(argonAnswer);
      return new Response(null, { status: 401 });
    });
    await expect(
      loginSuper(rejected.impl, BASE, 'x', 'test-password-123')
    ).rejects.toThrow(/login answered 401/);
    const noCookie = fakeFetch((call) => {
      if (call.url === `${BASE}/v2/auth/prelogin`)
        return Response.json(argonAnswer);
      return Response.json({ user: {} });
    });
    await expect(
      loginSuper(noCookie.impl, BASE, 'x', 'test-password-123')
    ).rejects.toThrow(/no ts_session cookie/);
  });
});

describe('runUpload target validation and redirects', () => {
  const file = {
    name: 'sample.mp4',
    contentType: 'video/mp4',
    bytes: PNG_BYTES,
  };
  const input = { baseUrl: BASE, cookie: COOKIE, file };

  it('wrong-origin API target throws before any PUT and never sends the cookie there', async () => {
    const { calls, impl } = fakeFetch((call) => {
      if (call.method === 'POST' && call.url === `${BASE}/v2/media/uploads`)
        return sessionResponse(
          [
            partTarget({
              url: 'https://evil.example.com/v2/media/uploads/s/parts/1',
            }),
          ],
          'api'
        );
      if (call.method === 'DELETE') return new Response(null, { status: 204 });
      return undefined;
    });
    await expect(runUpload(input, { fetch: impl })).rejects.toThrow(
      /origin does not match/
    );
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    expect(
      calls.filter((c) => c.url.includes('evil.example.com'))
    ).toHaveLength(0);
  });

  it.each([
    [
      'non-staging bucket',
      'https://acct.r2.cloudflarestorage.com/prod-media/k?x=1',
    ],
    ['wrong host', 'https://acct.example.com/terrastories-staging-media/k'],
    [
      'http scheme',
      'http://acct.r2.cloudflarestorage.com/terrastories-staging-media/k',
    ],
  ])('presigned target with %s throws before any PUT', async (_n, url) => {
    const { calls, impl } = fakeFetch((call) => {
      if (call.method === 'POST' && call.url === `${BASE}/v2/media/uploads`)
        return sessionResponse([partTarget({ url })]);
      if (call.method === 'DELETE') return new Response(null, { status: 204 });
      return undefined;
    });
    await expect(runUpload(input, { fetch: impl })).rejects.toThrow(
      /not an https R2 URL/
    );
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('every fetch of a full flow uses redirect: error', async () => {
    const { calls, impl } = fakeFetch((call) => {
      if (call.method === 'POST' && call.url === `${BASE}/v2/media/uploads`)
        return sessionResponse([partTarget()]);
      if (call.method === 'PUT')
        return new Response(null, { status: 200, headers: { ETag: '"e"' } });
      if (call.url.endsWith('/complete'))
        return Response.json({ data: { id: 'm' } }, { status: 201 });
      if (call.method === 'DELETE') return new Response(null, { status: 204 });
      return undefined;
    });
    await runUpload(input, { fetch: impl });
    expect(calls.length).toBe(4);
    for (const c of calls) expect(c.redirect).toBe('error');
  });

  it('a 307 redirect fails the real fetch (nothing follows it)', async () => {
    const seen: string[] = [];
    const landed: string[] = [];
    // A LIVE handler the redirect points at: it must receive nothing.
    const target = createServer((req, res) => {
      landed.push(`${req.method} ${req.url}`);
      res.writeHead(200);
      res.end();
    });
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
    const targetPort = (target.address() as { port: number }).port;
    const server = createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      res.writeHead(307, {
        location: `http://127.0.0.1:${targetPort}/elsewhere`,
      });
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      await expect(
        runUpload(
          { ...input, baseUrl: `http://127.0.0.1:${port}` },
          { fetch: (u, i) => fetch(u, i) }
        )
      ).rejects.toThrow(/redirect|fetch failed/i);
      expect(seen).toEqual(['POST /v2/media/uploads']);
      expect(landed).toEqual([]);
    } finally {
      server.close();
      target.close();
    }
  });
});

describe('upload-large CLI', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const tmpFile = () => {
    const dir = mkdtempSync(join(tmpdir(), 'upload-large-'));
    const path = join(dir, 'sample.mp4');
    writeFileSync(path, PNG_BYTES);
    return path;
  };

  it('an empty --file exits 2 with a message, not a stack trace', async () => {
    const err: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      err.push(String(chunk));
      return true;
    });
    const dir = mkdtempSync(join(tmpdir(), 'upload-large-'));
    const empty = join(dir, 'empty.mp4');
    writeFileSync(empty, '');
    expect(await main(['--file', empty], {})).toBe(2);
    expect(await main(['--file', empty, '--dry-run'], {})).toBe(2);
    expect(err.join('')).toMatch(/cannot plan an upload/);
    expect(err.join('')).not.toMatch(/\n\s+at /);
  });

  it('--dry-run prints the plan and makes no network call', async () => {
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    const fetchSpy = vi.fn(() => {
      throw new Error('dry run must not fetch');
    });
    vi.stubGlobal('fetch', fetchSpy);
    const code = await main(['--file', tmpFile(), '--dry-run'], {});
    expect(code).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    const text = out.join('');
    expect(text).toContain('dry run');
    expect(text).toContain(`parts: 1`);
    expect(text).toContain(sha256Hex(PNG_BYTES));
    expect(text).toContain('POST /v2/media/uploads');
    expect(text).toContain('DELETE /v2/media/<fileId>');
  });

  it('refuses a production URL before any call and requires env credentials', async () => {
    const err: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      err.push(String(chunk));
      return true;
    });
    const fetchSpy = vi.fn(() => {
      throw new Error('must not fetch');
    });
    vi.stubGlobal('fetch', fetchSpy);
    const file = tmpFile();
    expect(
      await main(['--file', file], {
        STAGING_URL: 'https://our.terrastories.app',
        WT_SUPER_IDENTIFIER: 'x',
        WT_SUPER_PASSWORD: 'y',
      })
    ).toBe(1);
    expect(err.join('')).toMatch(/not a staging host/);
    expect(await main(['--file', file], { STAGING_URL: BASE })).toBe(2);
    expect(err.join('')).toMatch(/WT_SUPER_IDENTIFIER and WT_SUPER_PASSWORD/);
    expect(await main(['--file', file], {})).toBe(2);
    expect(err.join('')).toMatch(/STAGING_URL is required/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('uploadViaThrowawayCommunity (fake fetch)', () => {
  const SUPER = 'ts_session=super-cookie-value';
  const ADMIN = 'ts_session=admin-cookie-value';
  const salt = Buffer.from('0123456789abcdef').toString('base64');
  const argonAnswer = {
    algorithm: 'client-argon2id+sha256',
    salt,
    params: { memoryKiB: 19 * 1024, iterations: 2, parallelism: 1 },
  };

  function world(
    opts: {
      putStatus?: number;
      disableStatus?: number;
      disableBody?: 'empty' | 'mismatch';
      claimStatus?: number;
      createSlug?: string;
      listed?: boolean;
      /** Create misbehaviour; the server row exists for all but 'reject'. */
      create?: 'reject' | 'throw' | 'badjson' | 'error5xx';
      createStatus?: number;
      /** Row sits on this list offset (total 250 rows, filler elsewhere). */
      listedOffset?: number;
      /** Holds the create response until released. */
      gate?: Promise<void>;
    } = {}
  ) {
    let slug = '';
    return fakeFetch((call) => {
      const u = call.url.replace(BASE, '');
      if (call.method === 'POST' && u === '/v2/admin/communities') {
        slug = JSON.parse(String(call.body)).slug;
        if (opts.create === 'reject')
          return new Response(null, { status: opts.createStatus ?? 409 });
        if (opts.create === 'throw') throw new Error('socket hang up');
        if (opts.create === 'badjson')
          return new Response('<html>', { status: 201 });
        if (opts.create === 'error5xx')
          return new Response(null, { status: 502 });
        if (opts.gate)
          return opts.gate.then(() =>
            Response.json({ data: { id: 42, slug } }, { status: 201 })
          );
        return Response.json(
          { data: { id: 42, slug: opts.createSlug ?? slug } },
          { status: 201 }
        );
      }
      if (
        call.method === 'GET' &&
        u.split('?')[0] === '/v2/admin/communities' &&
        opts.listedOffset !== undefined
      ) {
        const offset = Number(new URL(call.url).searchParams.get('offset'));
        const filler = (n: number) =>
          Array.from({ length: n }, (_, i) => ({
            id: 1000 + offset + i,
            slug: `other-${offset + i}`,
            status: 'active',
            claimStatus: 'unclaimed',
          }));
        return Response.json({
          data:
            offset === opts.listedOffset
              ? [
                  ...filler(10),
                  { id: 77, slug, status: 'active', claimStatus: 'unclaimed' },
                ]
              : filler(offset === 200 ? 50 : 100),
          meta: { total: 250, limit: 100, offset },
        });
      }
      if (call.method === 'GET' && u.split('?')[0] === '/v2/admin/communities')
        return Response.json({
          data: opts.listed
            ? [{ id: 77, slug, status: 'active', claimStatus: 'unclaimed' }]
            : [],
          meta: { total: opts.listed ? 1 : 0, limit: 100, offset: 0 },
        });
      if (u === '/v2/admin/communities/42/claim-tokens')
        return Response.json(
          { data: { token: 'claim-token-secret' } },
          { status: 201 }
        );
      if (u === '/v2/bootstrap/claim')
        return opts.claimStatus
          ? new Response(null, { status: opts.claimStatus })
          : Response.json({ data: {} }, { status: 201 });
      if (u === '/v2/auth/prelogin') return Response.json(argonAnswer);
      if (u === '/v2/auth/login') {
        const res = Response.json({ user: { id: 7 } });
        res.headers.append(
          'set-cookie',
          'ts_session=admin-cookie-value; Path=/; HttpOnly'
        );
        return res;
      }
      if (call.method === 'POST' && u === '/v2/media/uploads')
        return sessionResponse([partTarget()]);
      if (call.method === 'PUT')
        return new Response(null, {
          status: opts.putStatus ?? 200,
          headers: { ETag: '"e1"' },
        });
      if (u === '/v2/media/uploads/sess-1/complete')
        return Response.json({ data: { id: 'media-1' } }, { status: 201 });
      if (call.method === 'DELETE' && u === '/v2/media/media-1')
        return new Response(null, { status: 204 });
      if (call.method === 'DELETE' && u === '/v2/media/uploads/sess-1')
        return new Response(null, { status: 204 });
      const patch = /^\/v2\/admin\/communities\/(\d+)\/status$/.exec(u);
      if (call.method === 'PATCH' && patch) {
        const status = opts.disableStatus ?? 200;
        if (opts.disableBody === 'empty') return new Response(null, { status });
        const id = opts.disableBody === 'mismatch' ? 999 : Number(patch[1]);
        return Response.json(
          { data: { id, slug, status: 'disabled', claimStatus: 'claimed' } },
          { status }
        );
      }
      return undefined;
    });
  }

  const input = {
    baseUrl: BASE,
    superCookie: SUPER,
    file: { name: 's.mp4', contentType: 'video/mp4', bytes: PNG_BYTES },
  };

  it('provisions a stg-upload-* community and admin, uploads as the admin, disables the community as super', async () => {
    const { calls, impl } = world();
    const lines: string[] = [];
    const res = await uploadViaThrowawayCommunity(input, {
      fetch: impl,
      log: (l) => lines.push(l),
    });
    expect(res.error).toBeUndefined();
    expect(res.community?.slug).toMatch(/^stg-upload-[0-9a-f]{8}$/);
    expect(res.mediaDeleted).toBe(true);
    expect(res.communityDisabled).toBe(true);
    expect(res.disableStatus).toBe(200);
    expect(res.outcome?.mediaId).toBe('media-1');
    const seq = calls.map(
      (c) => `${c.method} ${c.url.replace(BASE, '').split('?')[0]}`
    );
    expect(seq.slice(0, 3)).toEqual([
      'POST /v2/admin/communities',
      'POST /v2/admin/communities/42/claim-tokens',
      'POST /v2/bootstrap/claim',
    ]);
    expect(seq.at(-1)).toBe('PATCH /v2/admin/communities/42/status');
    expect(JSON.parse(String(calls[0]!.body)).slug).toBe(res.community!.slug);
    // super cookie only on super calls; the claim call carries no cookie
    expect(calls[0]!.headers.cookie).toBe(SUPER);
    expect(calls[1]!.headers.cookie).toBe(SUPER);
    expect(calls[2]!.headers.cookie).toBeUndefined();
    expect(calls.at(-1)!.headers.cookie).toBe(SUPER);
    // the upload runs as the throwaway admin
    for (const c of calls.filter((x) => x.url.startsWith(`${BASE}/v2/media`)))
      expect(c.headers.cookie).toBe(ADMIN);
    expect(JSON.parse(String(calls.at(-1)!.body))).toEqual({
      status: 'disabled',
    });
  });

  it('still disables the community when the upload fails, and aborts the session', async () => {
    const { calls, impl } = world({ putStatus: 403 });
    const res = await uploadViaThrowawayCommunity(input, { fetch: impl });
    expect(res.error).toMatch(/part 1 PUT answered 403/);
    expect(res.mediaDeleted).toBe(false);
    expect(res.communityDisabled).toBe(true);
    expect(calls.some((c) => c.url.endsWith('/complete'))).toBe(false);
    expect(
      calls.some(
        (c) =>
          c.method === 'DELETE' && c.url.endsWith('/v2/media/uploads/sess-1')
      )
    ).toBe(true);
    expect(calls.at(-1)!.method).toBe('PATCH');
  });

  it('reports a failed disable instead of hiding it', async () => {
    const { impl } = world({ disableStatus: 500 });
    const res = await uploadViaThrowawayCommunity(input, { fetch: impl });
    expect(res.communityDisabled).toBe(false);
    expect(res.disableStatus).toBe(500);
  });

  it('does not try to disable when the community was never created', async () => {
    const { calls, impl } = fakeFetch(
      () => new Response(null, { status: 403 })
    );
    const res = await uploadViaThrowawayCommunity(input, { fetch: impl });
    expect(res.error).toMatch(/POST \/v2\/admin\/communities answered 403/);
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('never leaks cookies, claim token, password or derived key into the log', async () => {
    const { calls, impl } = world();
    const lines: string[] = [];
    await uploadViaThrowawayCommunity(input, {
      fetch: impl,
      log: (l) => lines.push(l),
    });
    const log = lines.join('\n');
    for (const secret of [
      'super-cookie-value',
      'admin-cookie-value',
      'claim-token-secret',
      'X-Amz-Signature',
    ])
      expect(log).not.toContain(secret);
    const claim = JSON.parse(
      String(calls.find((c) => c.url.endsWith('/bootstrap/claim'))!.body)
    );
    expect(log).not.toContain(claim.password.derivedKey);
    expect(JSON.stringify(calls.map((c) => c.body ?? '')).includes('wt-')).toBe(
      false
    );
  });

  it('prints the slug before the create call is sent', async () => {
    const lines: string[] = [];
    const { calls, impl } = world();
    const log = (l: string) => lines.push(`${calls.length}|${l}`);
    await uploadViaThrowawayCommunity(input, { fetch: impl, log });
    const first = lines.find((l) => /creating community stg-upload-/.test(l))!;
    expect(first.startsWith('0|')).toBe(true);
  });

  it('reports a disable with an empty 200 or a mismatched body as FAILED', async () => {
    for (const disableBody of ['empty', 'mismatch'] as const) {
      const { impl } = world({ disableBody });
      const res = await uploadViaThrowawayCommunity(input, { fetch: impl });
      expect(res.communityDisabled, disableBody).toBe(false);
      expect(res.disableStatus).toBe(200);
    }
  });

  it('a claim failure (401 or 500) after create still PATCHes and reports disabled', async () => {
    for (const claimStatus of [401, 500]) {
      const { calls, impl } = world({ claimStatus });
      const res = await uploadViaThrowawayCommunity(input, { fetch: impl });
      expect(res.error, String(claimStatus)).toMatch(
        new RegExp(`bootstrap/claim answered ${claimStatus}`)
      );
      expect(res.communityDisabled).toBe(true);
      expect(
        calls.some(
          (c) =>
            c.method === 'PATCH' && c.url.endsWith('/communities/42/status')
        )
      ).toBe(true);
    }
  });

  it('a create response with another slug stops before claim-token and never PATCHes that id', async () => {
    const { calls, impl } = world({ createSlug: 'someone-else' });
    const res = await uploadViaThrowawayCommunity(input, { fetch: impl });
    expect(res.error).toMatch(/does not match the requested slug/);
    expect(calls.some((c) => c.url.includes('claim-tokens'))).toBe(false);
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    expect(res.communityDisabled).toBe(false);
  });

  it('after a lost create response, finds the community by exact slug and disables it', async () => {
    const { calls, impl } = world({ createSlug: 'someone-else', listed: true });
    const res = await uploadViaThrowawayCommunity(input, { fetch: impl });
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.url).toBe(`${BASE}/v2/admin/communities/77/status`);
    expect(res.communityDisabled).toBe(true);
    expect(calls.some((c) => c.url.includes('claim-tokens'))).toBe(false);
  });

  const noRetry = { attempts: 1, delayMs: 0 };
  const patches = (calls: Call[]) => calls.filter((c) => c.method === 'PATCH');
  const lists = (calls: Call[]) =>
    calls.filter(
      (c) => c.method === 'GET' && c.url.includes('/admin/communities')
    );

  it('a definitive create rejection (409, 400, 401, 403) makes no list call and no PATCH', async () => {
    for (const createStatus of [409, 400, 401, 403]) {
      const { calls, impl } = world({ create: 'reject', createStatus });
      const res = await uploadViaThrowawayCommunity(
        { ...input, lookupRetry: noRetry },
        { fetch: impl }
      );
      expect(res.error, String(createStatus)).toMatch(
        new RegExp(`answered ${createStatus}`)
      );
      expect(lists(calls)).toHaveLength(0);
      expect(patches(calls)).toHaveLength(0);
      expect(res.communityDisabled).toBe(false);
    }
  });

  it('lost response (a): fetch rejects after the server created the row -> found by slug and disabled', async () => {
    const { calls, impl } = world({ create: 'throw', listed: true });
    const res = await uploadViaThrowawayCommunity(
      { ...input, lookupRetry: noRetry },
      { fetch: impl }
    );
    expect(patches(calls)[0]!.url).toBe(
      `${BASE}/v2/admin/communities/77/status`
    );
    expect(res.communityDisabled).toBe(true);
    expect(calls.some((c) => c.url.includes('claim-tokens'))).toBe(false);
  });

  it('lost response (a2): a 502 is ambiguous too', async () => {
    const { calls, impl } = world({ create: 'error5xx', listed: true });
    const res = await uploadViaThrowawayCommunity(
      { ...input, lookupRetry: noRetry },
      { fetch: impl }
    );
    expect(patches(calls)).toHaveLength(1);
    expect(res.communityDisabled).toBe(true);
  });

  it('lost response (b): 201 with unreadable JSON -> found by slug and disabled', async () => {
    const { calls, impl } = world({ create: 'badjson', listed: true });
    const res = await uploadViaThrowawayCommunity(
      { ...input, lookupRetry: noRetry },
      { fetch: impl }
    );
    expect(patches(calls)[0]!.url).toBe(
      `${BASE}/v2/admin/communities/77/status`
    );
    expect(res.communityDisabled).toBe(true);
  });

  it('lost response (c): row on a later list page (not page 0) -> disabled', async () => {
    const { calls, impl } = world({ create: 'throw', listedOffset: 100 });
    const res = await uploadViaThrowawayCommunity(
      { ...input, lookupRetry: noRetry },
      { fetch: impl }
    );
    expect(lists(calls).some((c) => c.url.includes('offset=100'))).toBe(true);
    expect(patches(calls)[0]!.url).toBe(
      `${BASE}/v2/admin/communities/77/status`
    );
    expect(res.communityDisabled).toBe(true);
  });

  it('a signal during the in-flight create: no claim token, no upload; awaits the create, then disables the confirmed community', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { calls, impl } = world({ gate });
    let cleanup!: () => Promise<void>;
    const run = uploadViaThrowawayCommunity(
      { ...input, onCleanupReady: (fn) => (cleanup = fn) },
      { fetch: impl }
    );
    await vi.waitFor(() =>
      expect(calls.some((c) => c.method === 'POST')).toBe(true)
    );
    const stopped = cleanup();
    await new Promise((r) => setTimeout(r, 20));
    expect(patches(calls)).toHaveLength(0);
    release();
    await stopped;
    const res = await run;
    expect(calls.some((c) => c.url.includes('claim-tokens'))).toBe(false);
    expect(calls.some((c) => c.url.includes('/media/uploads'))).toBe(false);
    expect(patches(calls)[0]!.url).toBe(
      `${BASE}/v2/admin/communities/42/status`
    );
    expect(res.communityDisabled).toBe(true);
  });

  it('a signal then an ambiguous create: retries the slug lookup, then reports the REAL slug when giving up', async () => {
    const { calls, impl } = world({ create: 'throw' });
    let cleanup!: () => Promise<void>;
    let status!: () => { slug?: string; disabled: boolean };
    const logs: string[] = [];
    const run = uploadViaThrowawayCommunity(
      {
        ...input,
        lookupRetry: { attempts: 3, delayMs: 5 },
        onCleanupReady: (fn, st) => {
          cleanup = fn;
          status = st;
        },
      },
      { fetch: impl, log: (l) => logs.push(l) }
    );
    await cleanup();
    await run;
    expect(lists(calls).length).toBeGreaterThanOrEqual(3);
    expect(patches(calls)).toHaveLength(0);
    const st = status();
    expect(st.disabled).toBe(false);
    expect(st.slug).toMatch(/^stg-upload-[0-9a-f]{8}$/);
  });

  it('a signal during the password derivation: no bootstrap claim call', async () => {
    const { calls, impl } = world();
    let cleanup!: () => Promise<void>;
    const inner = impl;
    const wrapped: FetchLike = async (url, init) => {
      const res = await inner(url, init);
      // the argon derivation that follows takes far longer than this timer
      if (url.endsWith('/claim-tokens')) setTimeout(() => void cleanup(), 5);
      return res;
    };
    const res = await uploadViaThrowawayCommunity(
      { ...input, onCleanupReady: (fn) => (cleanup = fn) },
      { fetch: wrapped }
    );
    expect(res.error).toMatch(/stopped by signal/);
    expect(calls.some((c) => c.url.endsWith('/bootstrap/claim'))).toBe(false);
    expect(patches(calls)).toHaveLength(1);
  });

  it('a signal after a definitive 409: no manual-disable claim; status says no row may exist', async () => {
    const { calls, impl } = world({ create: 'reject', createStatus: 409 });
    let cleanup!: () => Promise<void>;
    let status!: () => { slug?: string; disabled: boolean; mayExist?: boolean };
    const res = await uploadViaThrowawayCommunity(
      {
        ...input,
        onCleanupReady: (fn, st) => {
          cleanup = fn;
          status = st;
        },
      },
      { fetch: impl }
    );
    await cleanup();
    expect(res.communityMayExist).toBe(false);
    expect(status().mayExist).toBe(false);
    expect(patches(calls)).toHaveLength(0);
  });

  it('a stalled slug-lookup request is aborted and the disable still runs', async () => {
    const calls: string[] = [];
    const base = world({ create: 'throw', listed: true });
    const impl: FetchLike = (url, init) => {
      if (init?.method === 'GET' && url.includes('/admin/communities')) {
        calls.push('GET');
        return new Promise<Response>((_, reject) =>
          init.signal?.addEventListener('abort', () =>
            reject(new Error('aborted'))
          )
        );
      }
      return base.impl(url, init);
    };
    const res = await uploadViaThrowawayCommunity(
      {
        ...input,
        lookupRetry: {
          attempts: 2,
          delayMs: 1,
          requestTimeoutMs: 30,
          budgetMs: 200,
        },
      },
      { fetch: impl }
    );
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(res.communityMayExist).toBe(true);
    expect(res.communityDisabled).toBe(false);
  });

  it('refuses a non-staging URL itself, before any call', async () => {
    const { calls, impl } = world();
    const res = await uploadViaThrowawayCommunity(
      { ...input, baseUrl: 'https://our.terrastories.app' },
      { fetch: impl }
    );
    expect(res.error).toMatch(/not a staging host/);
    expect(calls).toHaveLength(0);
  });

  it('with a known password: never in the log, nor the claim or login derived keys (success and failure)', async () => {
    const KNOWN = 'wt-KNOWN-PASSWORD-for-test';
    for (const putStatus of [200, 403]) {
      const { calls, impl } = world({ putStatus });
      const lines: string[] = [];
      const res = await uploadViaThrowawayCommunity(input, {
        fetch: impl,
        log: (l) => lines.push(l),
        randomPassword: () => KNOWN,
      });
      const text = [...lines, res.error ?? ''].join('\n');
      const claim = JSON.parse(
        String(calls.find((c) => c.url.endsWith('/bootstrap/claim'))!.body)
      );
      const login = JSON.parse(
        String(calls.find((c) => c.url.endsWith('/v2/auth/login'))!.body)
      );
      for (const secret of [
        KNOWN,
        claim.password.derivedKey,
        login.derivedKey,
      ]) {
        expect(secret).toBeTruthy();
        expect(text).not.toContain(secret);
      }
      // the password itself never goes on the wire either
      for (const c of calls) expect(String(c.body ?? '')).not.toContain(KNOWN);
    }
  });

  it('CLI stdout and stderr never contain the password or derived keys, on success and failure', async () => {
    const KNOWN = 'wt-KNOWN-PASSWORD-for-test';
    const dir = mkdtempSync(join(tmpdir(), 'upload-large-'));
    const path = join(dir, 'sample.mp4');
    writeFileSync(path, PNG_BYTES);
    for (const putStatus of [200, 403]) {
      const { calls, impl } = world({ putStatus });
      const out: string[] = [];
      const err: string[] = [];
      vi.spyOn(process.stdout, 'write').mockImplementation((c) => {
        out.push(String(c));
        return true;
      });
      vi.spyOn(process.stderr, 'write').mockImplementation((c) => {
        err.push(String(c));
        return true;
      });
      vi.stubGlobal('fetch', impl);
      const code = await main(
        ['--file', path],
        {
          STAGING_URL: BASE,
          WT_SUPER_IDENTIFIER: 'super',
          WT_SUPER_PASSWORD: 'super-password-secret',
        },
        { randomPassword: () => KNOWN }
      );
      expect(code).toBe(putStatus === 200 ? 0 : 1);
      const text = out.join('') + err.join('');
      const claim = JSON.parse(
        String(calls.find((c) => c.url.endsWith('/bootstrap/claim'))!.body)
      );
      const logins = calls
        .filter((c) => c.url.endsWith('/v2/auth/login'))
        .map((c) => JSON.parse(String(c.body)).derivedKey as string);
      for (const secret of [
        KNOWN,
        'super-password-secret',
        claim.password.derivedKey,
        ...logins,
        'admin-cookie-value',
        'super-cookie-value',
      ]) {
        expect(text).not.toContain(secret);
      }
      expect(text).toMatch(/community: stg-upload-/);
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });
});
