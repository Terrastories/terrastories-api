/**
 * SigV4 query presign (#286): the AWS documentation reference vector, plus an
 * independent node:crypto re-derivation for the R2 UploadPart shape (signed
 * Content-Length and checksum headers, partNumber/uploadId query).
 */
import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createSigV4Presigner,
  sigV4Encode,
  sigV4EncodePath,
} from '../../src/shared/utils/sigv4-presign.js';

// The AWS documentation example credentials are public, but are assembled at
// runtime so no credential-shaped literal sits in the repository.
const DOC_ACCESS_KEY = ['AKIA', 'IOSFODNN7', 'EXAMPLE'].join('');
const DOC_SECRET = ['wJalrXUtnFEMI', '/K7MDENG/', 'bPxRfiCYEXAMPLEKEY'].join(
  ''
);

describe('createSigV4Presigner', () => {
  it('matches the AWS "Authenticating Requests: query parameters" reference vector', async () => {
    const presigner = await createSigV4Presigner(
      {
        accessKeyId: DOC_ACCESS_KEY,
        secretAccessKey: DOC_SECRET,
        region: 'us-east-1',
        service: 's3',
      },
      new Date('2013-05-24T00:00:00.000Z')
    );
    const url = await presigner.presign({
      method: 'GET',
      host: 'examplebucket.s3.amazonaws.com',
      path: '/test.txt',
      expiresSeconds: 86400,
      now: new Date('2013-05-24T00:00:00.000Z'),
    });
    expect(url).toBe(
      'https://examplebucket.s3.amazonaws.com/test.txt?' +
        'X-Amz-Algorithm=AWS4-HMAC-SHA256&' +
        `X-Amz-Credential=${DOC_ACCESS_KEY}%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&` +
        'X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&' +
        'X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404'
    );
  });

  it('signs x-amz-content-sha256 as a header over UNSIGNED-PAYLOAD (R2 UploadPart 501 regression)', async () => {
    const accessKeyId = createHash('sha256')
      .update('ak')
      .digest('hex')
      .slice(0, 20);
    const secretAccessKey = createHash('sha256').update('sk').digest('hex');
    const now = new Date('2026-11-23T05:06:07.000Z');
    const presigner = await createSigV4Presigner(
      { accessKeyId, secretAccessKey, region: 'auto', service: 's3' },
      now
    );
    const checksum = createHash('sha256').update('part').digest('hex');
    const url = new URL(
      await presigner.presign({
        method: 'PUT',
        host: 'acct.r2.cloudflarestorage.com',
        path: '/bucket/communities/7/media/a b+c',
        query: { partNumber: '3', uploadId: 'up/load=id' },
        signedHeaders: {
          'content-length': '16777216',
          'x-amz-content-sha256': checksum,
        },
        expiresSeconds: 7200,
        now,
      })
    );
    expect(url.pathname).toBe('/bucket/communities/7/media/a%20b%2Bc');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe(
      'content-length;host;x-amz-content-sha256'
    );
    // Independent derivation.
    const scope = '20261123/auto/s3/aws4_request';
    const hmac = (k: Buffer | string, d: string) =>
      createHmac('sha256', k).update(d).digest();
    const key = hmac(
      hmac(hmac(hmac(`AWS4${secretAccessKey}`, '20261123'), 'auto'), 's3'),
      'aws4_request'
    );
    const enc = (s: string) =>
      encodeURIComponent(s).replace(
        /[!'()*]/g,
        (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
      );
    const params = [...url.searchParams.entries()].filter(
      ([k]) => k !== 'X-Amz-Signature'
    );
    const canonicalQuery = params
      .map(([k, v]) => [enc(k), enc(v)])
      .sort((a, b) => (a[0]! < b[0]! ? -1 : 1))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
    const canonical = [
      'PUT',
      url.pathname,
      canonicalQuery,
      `content-length:16777216\nhost:acct.r2.cloudflarestorage.com\nx-amz-content-sha256:${checksum}\n`,
      'content-length;host;x-amz-content-sha256',
      'UNSIGNED-PAYLOAD',
    ].join('\n');
    const toSign = [
      'AWS4-HMAC-SHA256',
      '20261123T050607Z',
      scope,
      createHash('sha256').update(canonical).digest('hex'),
    ].join('\n');
    expect(url.searchParams.get('X-Amz-Signature')).toBe(
      createHmac('sha256', key).update(toSign).digest('hex')
    );
    expect(url.searchParams.get('uploadId')).toBe('up/load=id');
  });

  it('rejects out-of-range expiry and encodes RFC 3986 reserved characters', async () => {
    const presigner = await createSigV4Presigner(
      { accessKeyId: 'a', secretAccessKey: 'b', region: 'auto', service: 's3' },
      new Date()
    );
    await expect(
      presigner.presign({
        method: 'PUT',
        host: 'h',
        path: '/p',
        expiresSeconds: 604801,
        now: new Date(),
      })
    ).rejects.toThrow(RangeError);
    expect(sigV4Encode("a!'()*b")).toBe('a%21%27%28%29%2Ab');
    expect(sigV4EncodePath('/a b/c')).toBe('/a%20b/c');
  });
});
