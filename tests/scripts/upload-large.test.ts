/**
 * Unit tests for scripts/staging/upload-large.ts: the upload plan and the
 * create -> parts -> complete -> delete flow, driven by a fake fetch (no
 * network, no Cloudflare). Also checks the secret hygiene the procedure
 * promises: cookie, password and presigned URLs never reach the log.
 */
import { createHash } from 'node:crypto';
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
}

/** A fetch stand-in that records every call and answers from a route fn. */
function fakeFetch(route: (call: Call) => Response | undefined) {
  const calls: Call[] = [];
  const impl: FetchLike = async (url, init = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const call: Call = {
      method: init.method ?? 'GET',
      url,
      headers,
      body:
        typeof init.body === 'string' || init.body instanceof Uint8Array
          ? init.body
          : undefined,
    };
    calls.push(call);
    const res = route(call);
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
  url: 'https://acct.r2.cloudflarestorage.com/bucket/key?partNumber=1&uploadId=u&X-Amz-Signature=SECRET',
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
      'PUT https://acct.r2.cloudflarestorage.com/bucket/key',
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
