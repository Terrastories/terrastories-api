/**
 * Stage-3 R2 upload at scale and under failure, plus the node-sqlite and D1
 * guards that do not need a Rails source database. The transform output is a
 * small synthetic one; large objects are sparse files so nothing big is held
 * in memory by the test or by the fake server.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  open,
  readdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  loadTransformOutput,
  signR2Request,
} from '../../src/migration/v2/load.js';
import { startFakeR2, type FakeR2, type FakeR2Fault } from './fake-r2.js';

const MIB = 1024 * 1024;
const accessKeyId = 'ak' + randomBytes(8).toString('hex');
const secretAccessKey = randomBytes(16).toString('hex');
const env = {
  R2_ACCESS_KEY_ID: accessKeyId,
  R2_SECRET_ACCESS_KEY: secretAccessKey,
  R2_ACCOUNT_ID: 'acct',
};

interface SyntheticObject {
  key: string;
  size: number;
  mime: string;
}

async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path))
    hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** Sparse file with distinct head and tail so parts hash differently. */
async function makeSparse(path: string, size: number): Promise<void> {
  const handle = await open(path, 'w');
  try {
    await handle.write(Buffer.from('head-' + path), 0);
    await handle.truncate(size);
    await handle.write(Buffer.from('tail-marker'), null, null, size - 11);
  } finally {
    await handle.close();
  }
}

async function makeOutput(
  root: string,
  objects: SyntheticObject[],
  options: { extraTable?: boolean } = {}
): Promise<string> {
  const dir = await mkdtemp(join(root, 'out-'));
  const db = new Database(join(dir, 'v2.sqlite'));
  db.exec(
    'CREATE TABLE files (id TEXT PRIMARY KEY, storage_key TEXT, checksum TEXT, byte_size INTEGER, mime_type TEXT)'
  );
  if (options.extraTable) {
    db.exec(
      'CREATE TABLE attachments (id INTEGER PRIMARY KEY AUTOINCREMENT, file_id TEXT REFERENCES files(id))'
    );
  }
  const blobs = [];
  let n = 0;
  for (const object of objects) {
    n += 1;
    const path = join(dir, 'v2-media', object.key);
    await mkdir(join(path, '..'), { recursive: true });
    if (object.size > 64 * 1024) await makeSparse(path, object.size);
    else await writeFile(path, randomBytes(object.size));
    const sha256 = await sha256Of(path);
    const fileId = 'file-' + String(n);
    db.prepare('INSERT INTO files VALUES (?, ?, ?, ?, ?)').run(
      fileId,
      object.key,
      sha256,
      object.size,
      object.mime
    );
    if (options.extraTable) {
      db.prepare('INSERT INTO attachments (file_id) VALUES (?)').run(fileId);
    }
    blobs.push({ blobId: String(n), sha256, destinations: [{ fileId }] });
  }
  db.close();
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify({ formatVersion: 1, media: { blobs } })
  );
  return dir;
}

describe('R2 upload: streaming, multipart, retries', () => {
  let root: string;
  let r2: FakeR2;
  let fault: (r: {
    method: string;
    key: string;
    query: Record<string, string>;
    attempt: number;
  }) => FakeR2Fault;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'rails-r2-'));
    r2 = await startFakeR2({
      accessKeyId,
      secretAccessKey,
      fault: (r) => fault(r),
    });
  });
  afterAll(async () => {
    await r2.close();
  });

  const run = (
    dir: string,
    extra: Partial<Parameters<typeof loadTransformOutput>[0]> = {}
  ): ReturnType<typeof loadTransformOutput> =>
    loadTransformOutput({
      transformDir: dir,
      target: 'r2',
      bucket: 'media',
      endpoint: r2.endpoint,
      env,
      sleepImpl: () => Promise.resolve(),
      ...extra,
    });

  it('uploads an object over the 100 MiB threshold in streamed 64 MiB parts', async () => {
    fault = () => undefined;
    const dir = await makeOutput(root, [
      { key: 'communities/1/media/big', size: 101 * MIB, mime: 'video/mp4' },
    ]);
    const bodies: unknown[] = [];
    const spy: typeof fetch = (input, init) => {
      if (init?.method === 'PUT') bodies.push(init.body);
      return fetch(input, init);
    };
    const report = await run(dir, { fetchImpl: spy });
    expect(report).toMatchObject({ uploaded: 1, multipart: 1 });
    // Bodies are streams, never a whole-object Buffer or string.
    expect(bodies).toHaveLength(2);
    for (const body of bodies) expect(body).toBeInstanceOf(ReadableStream);
    const stored = r2.objects.get('/media/communities/1/media/big')!;
    expect(stored.size).toBe(101 * MIB);
    expect(stored.parts!.map((p) => p.size)).toEqual([64 * MIB, 37 * MIB]);
    const { sha256 } = new Database(join(dir, 'v2.sqlite'), { readonly: true })
      .prepare('SELECT checksum AS sha256 FROM files')
      .get() as { sha256: string };
    expect(stored.sha256Meta).toBe(sha256);
    expect(report.peakBytesInFlight).toBeLessThanOrEqual(4 * 64 * MIB);
    expect(r2.peakBodyBytesInFlight()).toBeLessThanOrEqual(64 * MIB);
    const again = await run(dir);
    expect(again).toMatchObject({ uploaded: 0, alreadyPresent: 1 });
  }, 120_000);

  it('caps bytes in flight at concurrency x part size', async () => {
    fault = () => undefined;
    const dir = await makeOutput(
      root,
      [1, 2, 3, 4].map((i) => ({
        key: 'communities/2/media/cap' + String(i),
        size: 3 * MIB,
        mime: 'audio/mpeg',
      }))
    );
    r2.resetPeak();
    const report = await run(dir, {
      concurrency: 2,
      multipartThresholdBytes: MIB,
      partSizeBytes: MIB,
    });
    expect(report).toMatchObject({ uploaded: 4, multipart: 4 });
    expect(report.peakBytesInFlight).toBeLessThanOrEqual(2 * MIB);
    expect(r2.peakBodyBytesInFlight()).toBeLessThanOrEqual(2 * MIB);
  });

  it('retries 503, 429 and network errors with exponential backoff on a single PUT', async () => {
    const dir = await makeOutput(root, [
      { key: 'communities/3/media/small', size: 2048, mime: 'image/png' },
    ]);
    fault = (r) => {
      if (r.method !== 'PUT') return undefined;
      if (r.attempt === 1) return 503;
      if (r.attempt === 2) return 429;
      if (r.attempt === 3) return 'reset';
      return undefined;
    };
    const delays: number[] = [];
    const report = await run(dir, {
      sleepImpl: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
    });
    expect(report.uploaded).toBe(1);
    expect(delays).toEqual([250, 500, 1000]);
  });

  it('gives up after the bounded attempts without leaking secrets, and never retries a 403', async () => {
    const dir = await makeOutput(root, [
      { key: 'communities/4/media/always503', size: 1024, mime: 'image/png' },
    ]);
    fault = (r) => (r.method === 'PUT' ? 500 : undefined);
    let message = '';
    try {
      await run(dir, { retry: { maxAttempts: 3 } });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe('R2 PUT failed with status 500');
    expect(
      r2.requests.filter(
        (r) => r.key.endsWith('always503') && r.method === 'PUT'
      ).length
    ).toBe(3);

    const forbidden = await makeOutput(root, [
      { key: 'communities/4/media/denied', size: 1024, mime: 'image/png' },
    ]);
    fault = (r) => (r.key.endsWith('denied') ? 403 : undefined);
    let denied = '';
    try {
      await run(forbidden);
    } catch (error) {
      denied = (error as Error).message;
    }
    expect(denied).toBe('R2 HEAD failed with status 403');
    expect(denied).not.toContain(secretAccessKey);
    expect(denied).not.toContain(accessKeyId);
    expect(r2.requests.filter((r) => r.key.endsWith('denied')).length).toBe(1);
  });

  it('retries only the failed part, then aborts the upload on a permanent part failure', async () => {
    const dir = await makeOutput(root, [
      { key: 'communities/5/media/parts', size: 5 * MIB, mime: 'video/mp4' },
    ]);
    fault = (r) =>
      r.query.partNumber === '2' && r.attempt === 1 ? 500 : undefined;
    const report = await run(dir, {
      multipartThresholdBytes: MIB,
      partSizeBytes: 2 * MIB,
    });
    expect(report).toMatchObject({ uploaded: 1, multipart: 1 });
    const partAttempts = (n: string): number =>
      r2.requests.filter(
        (r) => r.key.endsWith('/parts') && r.query.partNumber === n
      ).length;
    expect([partAttempts('1'), partAttempts('2'), partAttempts('3')]).toEqual([
      1, 2, 1,
    ]);
    expect(
      r2.objects.get('/media/communities/5/media/parts')!.parts
    ).toHaveLength(3);

    const failing = await makeOutput(root, [
      { key: 'communities/5/media/doomed', size: 5 * MIB, mime: 'video/mp4' },
    ]);
    fault = (r) => (r.query.partNumber === '2' ? 400 : undefined);
    const before = r2.aborted.length;
    await expect(
      run(failing, { multipartThresholdBytes: MIB, partSizeBytes: 2 * MIB })
    ).rejects.toThrow(/multipart part failed with status 400/);
    expect(r2.aborted.length).toBe(before + 1);
    expect(r2.objects.has('/media/communities/5/media/doomed')).toBe(false);
  });

  it('aborts when the file is mutated mid-upload (hash of streamed bytes vs manifest)', async () => {
    const dir = await makeOutput(root, [
      { key: 'communities/8/media/mutated', size: 5 * MIB, mime: 'video/mp4' },
    ]);
    fault = () => undefined;
    const path = join(dir, 'v2-media', 'communities/8/media/mutated');
    let mutated = false;
    const spy: typeof fetch = async (input, init) => {
      // Same size, different bytes in a later part, after the pre-upload check.
      if (!mutated && String(input).includes('partNumber=1')) {
        mutated = true;
        const handle = await open(path, 'r+');
        await handle.write(Buffer.from('MUTATED'), 0, 7, 4 * MIB + 10);
        await handle.close();
      }
      return fetch(input, init);
    };
    const before = r2.aborted.length;
    await expect(
      run(dir, {
        fetchImpl: spy,
        multipartThresholdBytes: MIB,
        partSizeBytes: 2 * MIB,
      })
    ).rejects.toThrow(/changed during upload/);
    expect(mutated).toBe(true);
    expect(r2.aborted.length).toBe(before + 1);
    expect(r2.objects.has('/media/communities/8/media/mutated')).toBe(false);
  });

  it('accepts NoSuchUpload on a retried complete when the object already matches', async () => {
    const dir = await makeOutput(root, [
      { key: 'communities/9/media/lost', size: 3 * MIB, mime: 'video/mp4' },
    ]);
    // first complete is processed by the server but its response is lost
    fault = (r) =>
      r.method === 'POST' && r.query.uploadId && r.attempt === 1
        ? 'drop'
        : undefined;
    const report = await run(dir, {
      multipartThresholdBytes: MIB,
      partSizeBytes: 2 * MIB,
    });
    expect(report).toMatchObject({ uploaded: 1, multipart: 1 });
    const completes = r2.requests.filter(
      (r) => r.method === 'POST' && r.key.endsWith('/lost') && r.query.uploadId
    );
    expect(completes.length).toBe(2);
    expect(r2.objects.get('/media/communities/9/media/lost')!.size).toBe(
      3 * MIB
    );
  });

  it('signs a collapsed-whitespace header value like the single-spaced one, and signs the query', () => {
    const base = {
      method: 'PUT' as const,
      endpoint: 'https://acct.r2.cloudflarestorage.com',
      bucket: 'media',
      key: 'k',
      accessKeyId: 'id',
      secretAccessKey: 'secret',
      payloadSha256: createHash('sha256').update('x').digest('hex'),
      now: new Date('2026-01-02T03:04:05Z'),
    };
    const spaced = signR2Request({
      ...base,
      extraHeaders: { 'content-type': '  text/plain;   charset=utf-8 ' },
    });
    const single = signR2Request({
      ...base,
      extraHeaders: { 'content-type': 'text/plain; charset=utf-8' },
    });
    expect(spaced.headers.authorization).toBe(single.headers.authorization);
    const withQuery = signR2Request({
      ...base,
      query: { uploadId: 'a b', partNumber: '2' },
    });
    expect(withQuery.url).toBe(
      'https://acct.r2.cloudflarestorage.com/media/k?partNumber=2&uploadId=a%20b'
    );
    expect(withQuery.headers.authorization).not.toBe(
      signR2Request(base).headers.authorization
    );
  });
});

describe('node-sqlite load recovers from interrupted runs', () => {
  it('replaces stale temporary files only, and leaves no temporaries behind', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rails-nsq-'));
    const dir = await makeOutput(root, [
      { key: 'communities/6/media/one', size: 4096, mime: 'image/png' },
    ]);
    const data = join(root, 'data');
    const storage = join(root, 'storage');
    await mkdir(join(storage, 'communities/6/media'), { recursive: true });
    await mkdir(data, { recursive: true });
    await writeFile(join(storage, 'communities/6/media/one.loading'), 'torn');
    await writeFile(join(data, 'v2.sqlite.loading'), 'torn');
    const report = await loadTransformOutput({
      transformDir: dir,
      target: 'node-sqlite',
      dataDir: data,
      storageRoot: storage,
    });
    expect(report.objects).toBe(1);
    expect(await readdir(data)).toEqual(['v2.sqlite']);
    expect(await readdir(join(storage, 'communities/6/media'))).toEqual([
      'one',
    ]);
    expect((await stat(join(storage, 'communities/6/media/one'))).size).toBe(
      4096
    );
  });
});

describe('d1 dump requires sqlite_sequence', () => {
  it('refuses a source whose AUTOINCREMENT sequence is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rails-d1seq-'));
    const dir = await makeOutput(
      root,
      [{ key: 'communities/7/media/a', size: 1024, mime: 'image/png' }],
      { extraTable: true }
    );
    const ok = await loadTransformOutput({
      transformDir: dir,
      target: 'd1',
      sqlOut: join(root, 'd1-ok'),
    });
    expect(ok.sqlFiles).toBeGreaterThan(2);
    const db = new Database(join(dir, 'v2.sqlite'));
    db.exec("DELETE FROM sqlite_sequence WHERE name = 'attachments'");
    db.close();
    await expect(
      loadTransformOutput({
        transformDir: dir,
        target: 'd1',
        sqlOut: join(root, 'd1-bad'),
      })
    ).rejects.toThrow(/sqlite_sequence is missing/);
  });
});
