import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveActiveStorageBlobPath } from '../../src/migration/rails/active-storage.js';
import { captureRailsToBundle } from '../../src/migration/rails/capture.js';
import { startFakeS3Server, type FakeS3Server } from './fake-s3.js';
import {
  fixtureDir,
  loadFixtureSql,
  withIsolatedRailsDatabase,
} from './pg-test-helper.js';

const sourceUrl = process.env.RAILS_MIGRATION_TEST_DATABASE_URL;
const describeWithPostgres = sourceUrl ? describe : describe.skip;

const FAKE_S3_CREDS = {
  AWS_ACCESS_KEY_ID: 'fixture-s3-access-id',
  AWS_SECRET_ACCESS_KEY: 'fixture-s3-secret-value',
};

const ALL_FIXTURE_KEYS = [
  'storymedia01',
  'placephoto01',
  'placeaudio01',
  'spkrphoto01',
  'userphoto01',
  'commdisp01',
  'commbgimg01',
  'sponsorlogo1',
  'sponsorlogo2',
  'sponsorlogo3',
  'staticmap01',
  'sharedblob01',
  'orphanblob01',
  'variantblob1',
  'sierraimg01',
  'previewimg01',
] as const;

const tempDirs: string[] = [];
const fakeServers: FakeS3Server[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function loadFixtureBlobsByKey(): Promise<Map<string, Buffer>> {
  const map = new Map<string, Buffer>();
  for (const key of ALL_FIXTURE_KEYS) {
    const blobPath = await resolveActiveStorageBlobPath(
      join(fixtureDir, 'blobs'),
      key
    );
    map.set(key, await readFile(blobPath));
  }
  return map;
}

afterEach(async () => {
  for (const server of fakeServers.splice(0)) {
    await server.close();
  }
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describeWithPostgres(
  'Rails S3 blob source and community allowlist capture',
  () => {
    it('captures all fixture blobs over SigV4 S3 without leaking credentials', async () => {
      const blobBytes = await loadFixtureBlobsByKey();
      const server = await startFakeS3Server({
        expectedCredentials: {
          accessKeyId: FAKE_S3_CREDS.AWS_ACCESS_KEY_ID,
          secretAccessKey: FAKE_S3_CREDS.AWS_SECRET_ACCESS_KEY,
          region: 'us-east-2',
        },
        onGetObject: async (objectKey) => {
          const body = blobBytes.get(objectKey);
          if (!body) return { kind: 'status', status: 404, body: 'NoSuchKey' };
          await new Promise((resolve) => setTimeout(resolve, 10));
          return { kind: 'ok', body };
        },
      });
      fakeServers.push(server);

      await withIsolatedRailsDatabase(sourceUrl!, async (dbUrl, pool) => {
        await loadFixtureSql(pool, '2024');

        const parent = await makeTempDir('rails-s3-full-');
        const outputDir = join(parent, 'bundle');
        const manifest = await captureRailsToBundle({
          sourceUrl: dbUrl,
          outputDir,
          blobSource: {
            kind: 's3',
            bucket: 'terrastories-fixture',
            region: 'us-east-2',
            endpoint: server.endpoint,
            env: FAKE_S3_CREDS,
            retryBaseDelayMs: 5,
          },
        });

        expect(manifest.storage).toEqual({
          kind: 's3',
          bucket: 'terrastories-fixture',
          region: 'us-east-2',
          prefix: null,
        });
        expect(manifest.blobSelection).toEqual({
          mode: 'all',
          selectors: [],
          communities: [],
        });
        expect(manifest.totals.blobs).toBe(16);
        expect(manifest.totals.blobsSelected).toBe(16);
        expect(manifest.totals.blobsNotSelected).toBe(0);
        expect(server.getMaxInFlight()).toBeLessThanOrEqual(4);
        expect(server.getMaxInFlight()).toBeGreaterThanOrEqual(2);

        for (const blob of manifest.blobs) {
          expect(blob.disposition).toBe('captured');
          const copiedPath = join(outputDir, 'blobs', blob.key);
          const copiedBytes = await readFile(copiedPath);
          expect(createHash('sha256').update(copiedBytes).digest('hex')).toBe(
            blob.sha256
          );
          expect((await stat(copiedPath)).mode & 0o777).toBe(0o600);
        }

        const manifestText = await readFile(
          join(outputDir, 'manifest.json'),
          'utf8'
        );
        const summaryText = await readFile(
          join(outputDir, 'validation-summary.txt'),
          'utf8'
        );
        expect(manifestText).not.toContain(FAKE_S3_CREDS.AWS_ACCESS_KEY_ID);
        expect(manifestText).not.toContain(FAKE_S3_CREDS.AWS_SECRET_ACCESS_KEY);
        expect(summaryText).not.toContain(FAKE_S3_CREDS.AWS_ACCESS_KEY_ID);
        expect(summaryText).not.toContain(FAKE_S3_CREDS.AWS_SECRET_ACCESS_KEY);
        expect(summaryText).not.toContain('terrastories-fixture');
        expect(summaryText).toContain('Blob source: s3');
        expect(summaryText).toContain('Blobs selected: 16');
        expect(summaryText).toContain('Blobs not_selected: 0');
      });
    });

    it('fails closed on fake S3 404, checksum mismatch, and size mismatch during capture', async () => {
      const blobBytes = await loadFixtureBlobsByKey();
      let mode: '404' | 'checksum' | 'size' = '404';

      const server = await startFakeS3Server({
        expectedCredentials: {
          accessKeyId: FAKE_S3_CREDS.AWS_ACCESS_KEY_ID,
          secretAccessKey: FAKE_S3_CREDS.AWS_SECRET_ACCESS_KEY,
          region: 'us-east-2',
        },
        onGetObject: (objectKey) => {
          const body = blobBytes.get(objectKey);
          if (!body) return { kind: 'status', status: 404 };
          if (objectKey === 'orphanblob01') {
            if (mode === '404') return { kind: 'status', status: 404 };
            if (mode === 'checksum') {
              const bad = Buffer.from(body);
              bad[0] = bad[0]! ^ 0x01;
              return { kind: 'ok', body: bad };
            }
            return { kind: 'ok', body: body.subarray(0, 4) };
          }
          return { kind: 'ok', body };
        },
      });
      fakeServers.push(server);

      await withIsolatedRailsDatabase(sourceUrl!, async (dbUrl, pool) => {
        await loadFixtureSql(pool, '2024');

        for (const testCase of [
          { currentMode: '404' as const, pattern: /404/i },
          { currentMode: 'checksum' as const, pattern: /checksum mismatch/i },
          { currentMode: 'size' as const, pattern: /size mismatch/i },
        ]) {
          mode = testCase.currentMode;
          const parent = await makeTempDir(`rails-s3-fail-${mode}-`);
          const outputDir = join(parent, 'bundle');

          await expect(
            captureRailsToBundle({
              sourceUrl: dbUrl,
              outputDir,
              blobSource: {
                kind: 's3',
                bucket: 'terrastories-fixture',
                region: 'us-east-2',
                endpoint: server.endpoint,
                env: FAKE_S3_CREDS,
                maxAttempts: 2,
                retryBaseDelayMs: 5,
              },
            })
          ).rejects.toThrow(testCase.pattern);

          expect(await pathExists(outputDir)).toBe(false);
          expect(
            (await readdir(parent)).some((name) => name.includes('.tmp-'))
          ).toBe(false);
        }
      });
    });

    it('captures all relational rows and restricts blob downloads to community allowlist + derived variants/previews', async () => {
      await withIsolatedRailsDatabase(sourceUrl!, async (dbUrl, pool) => {
        await loadFixtureSql(pool, '2024');

        // Add a multi-hop derived variant of previewimg01 (blob 115 -> variant 121 -> blob 116)
        // to confirm transitive closure of preview_image + variant_record chains.
        const extraVariantPayload = Buffer.from(
          "<svg xmlns='http://www.w3.org/2000/svg'><rect width='4' height='4'/></svg>\n",
          'utf8'
        );
        const extraMd5 = createHash('md5')
          .update(extraVariantPayload)
          .digest('base64');
        await pool.query(
          `INSERT INTO active_storage_blobs(
           id, key, filename, content_type, metadata, byte_size, checksum, created_at, service_name
         ) VALUES (116, 'previewvar01', 'preview-thumb.svg', 'image/svg+xml', '{"identified":true}', $1, $2, '2020-10-01 00:16:00', 'local')`,
          [extraVariantPayload.length, extraMd5]
        );
        await pool.query(
          `INSERT INTO active_storage_variant_records(id, blob_id, variation_digest)
         VALUES (121, 115, 'variant-digest-preview-thumb')`
        );
        await pool.query(
          `INSERT INTO active_storage_attachments(id, name, record_type, record_id, blob_id, created_at)
         VALUES (117, 'image', 'ActiveStorage::VariantRecord', 121, 116, '2020-10-02 00:00:00')`
        );

        const blobBytes = await loadFixtureBlobsByKey();
        blobBytes.set('previewvar01', extraVariantPayload);

        // Community 11 (sierra_alta) via S3 where ONLY sierraimg01 and sharedblob01 exist;
        // community 10 blobs and orphanblob01 return 404 to prove they are never fetched.
        const server = await startFakeS3Server({
          expectedCredentials: {
            accessKeyId: FAKE_S3_CREDS.AWS_ACCESS_KEY_ID,
            secretAccessKey: FAKE_S3_CREDS.AWS_SECRET_ACCESS_KEY,
            region: 'us-east-2',
          },
          onGetObject: (objectKey) => {
            if (objectKey === 'sierraimg01' || objectKey === 'sharedblob01') {
              return { kind: 'ok', body: blobBytes.get(objectKey)! };
            }
            return { kind: 'status', status: 404, body: 'UnexpectedFetch' };
          },
        });
        fakeServers.push(server);

        const sierraParent = await makeTempDir('rails-allowlist-sierra-');
        const sierraOut = join(sierraParent, 'bundle');
        const sierraManifest = await captureRailsToBundle({
          sourceUrl: dbUrl,
          outputDir: sierraOut,
          communities: ['sierra_alta'],
          blobSource: {
            kind: 's3',
            bucket: 'terrastories-fixture',
            region: 'us-east-2',
            endpoint: server.endpoint,
            env: FAKE_S3_CREDS,
            retryBaseDelayMs: 5,
          },
        });

        expect(sierraManifest.blobSelection).toEqual({
          mode: 'community_allowlist',
          selectors: ['sierra_alta'],
          communities: [{ id: '11', slug: 'sierra_alta' }],
        });
        expect(sierraManifest.totals.blobs).toBe(17);
        expect(sierraManifest.totals.blobsSelected).toBe(2);
        expect(sierraManifest.totals.blobsNotSelected).toBe(15);

        const sierraArchive = new Database(join(sierraOut, 'legacy.sqlite'), {
          readonly: true,
        });
        const communityCount = sierraArchive
          .prepare(
            `SELECT row_count AS rowCount FROM source_tables WHERE table_name = 'communities'`
          )
          .get() as { rowCount: number };
        expect(communityCount.rowCount).toBe(3);
        sierraArchive.close();

        expect(server.requests.map((req) => req.objectKey).sort()).toEqual([
          'sharedblob01',
          'sierraimg01',
        ]);
        expect((await readdir(join(sierraOut, 'blobs'))).sort()).toEqual([
          'sharedblob01',
          'sierraimg01',
        ]);

        for (const blob of sierraManifest.blobs) {
          if (blob.key === 'sierraimg01' || blob.key === 'sharedblob01') {
            expect(blob.disposition).toBe('captured');
            expect(blob.sha256).toMatch(/^[0-9a-f]{64}$/);
          } else {
            expect(blob.disposition).toBe('not_selected');
            expect(blob.sha256).toBeNull();
            expect(blob.byteSize).toMatch(/^\d+$/);
          }
        }

        const summary = await readFile(
          join(sierraOut, 'validation-summary.txt'),
          'utf8'
        );
        expect(summary).toContain('Blob selection: community_allowlist (11)');
        expect(summary).toContain('Blobs: 17');
        expect(summary).toContain('Blobs selected: 2');
        expect(summary).toContain('Blobs not_selected: 15');

        // Community 10 via S3 (with all blobs present except sierraimg01/orphanblob01):
        // captures 15 blobs (12 direct + variantblob1 + previewimg01 + previewvar01).
        const rioServer = await startFakeS3Server({
          expectedCredentials: {
            accessKeyId: FAKE_S3_CREDS.AWS_ACCESS_KEY_ID,
            secretAccessKey: FAKE_S3_CREDS.AWS_SECRET_ACCESS_KEY,
            region: 'us-east-2',
          },
          onGetObject: (objectKey) => {
            if (objectKey === 'sierraimg01' || objectKey === 'orphanblob01') {
              return { kind: 'status', status: 404 };
            }
            const body = blobBytes.get(objectKey);
            return body
              ? { kind: 'ok', body }
              : { kind: 'status', status: 404 };
          },
        });
        fakeServers.push(rioServer);

        const rioParent = await makeTempDir('rails-allowlist-rio-');
        const rioOut = join(rioParent, 'bundle');
        const rioManifest = await captureRailsToBundle({
          sourceUrl: dbUrl,
          outputDir: rioOut,
          communities: ['10'],
          blobSource: {
            kind: 's3',
            bucket: 'terrastories-fixture',
            region: 'us-east-2',
            endpoint: rioServer.endpoint,
            env: FAKE_S3_CREDS,
            retryBaseDelayMs: 5,
          },
        });
        expect(rioManifest.totals.blobsSelected).toBe(15);
        expect(rioManifest.totals.blobsNotSelected).toBe(2);
        const rioNotSelected = rioManifest.blobs
          .filter((blob) => blob.disposition === 'not_selected')
          .map((blob) => blob.key)
          .sort();
        expect(rioNotSelected).toEqual(['orphanblob01', 'sierraimg01']);

        // Repeatable --community 10 --community sierra_alta: only orphanblob01 excluded.
        const bothParent = await makeTempDir('rails-allowlist-both-');
        const bothOut = join(bothParent, 'bundle');
        const bothManifest = await captureRailsToBundle({
          sourceUrl: dbUrl,
          outputDir: bothOut,
          communities: ['10', 'sierra_alta'],
          blobSource: {
            kind: 's3',
            bucket: 'terrastories-fixture',
            region: 'us-east-2',
            endpoint: await (async () => {
              const bothServer = await startFakeS3Server({
                expectedCredentials: {
                  accessKeyId: FAKE_S3_CREDS.AWS_ACCESS_KEY_ID,
                  secretAccessKey: FAKE_S3_CREDS.AWS_SECRET_ACCESS_KEY,
                  region: 'us-east-2',
                },
                onGetObject: (objectKey) => {
                  if (objectKey === 'orphanblob01') {
                    return { kind: 'status', status: 404 };
                  }
                  const body = blobBytes.get(objectKey);
                  return body
                    ? { kind: 'ok', body }
                    : { kind: 'status', status: 404 };
                },
              });
              fakeServers.push(bothServer);
              return bothServer.endpoint;
            })(),
            env: FAKE_S3_CREDS,
            retryBaseDelayMs: 5,
          },
        });
        expect(bothManifest.blobSelection.communities).toEqual([
          { id: '10', slug: 'rio_verde' },
          { id: '11', slug: 'sierra_alta' },
        ]);
        expect(bothManifest.totals.blobsSelected).toBe(16);
        expect(bothManifest.totals.blobsNotSelected).toBe(1);
        expect(
          bothManifest.blobs.find((b) => b.key === 'orphanblob01')?.disposition
        ).toBe('not_selected');

        // Community 12 (no blobs): 0 selected, all 17 marked not_selected, no blobs/ dir needed.
        const zeroParent = await makeTempDir('rails-allowlist-zero-');
        const zeroOut = join(zeroParent, 'bundle');
        const zeroManifest = await captureRailsToBundle({
          sourceUrl: dbUrl,
          outputDir: zeroOut,
          communities: ['12'],
          blobRoot: join(fixtureDir, 'blobs'),
        });
        expect(zeroManifest.totals.blobsSelected).toBe(0);
        expect(zeroManifest.totals.blobsNotSelected).toBe(17);
        expect(await pathExists(join(zeroOut, 'blobs'))).toBe(false);
      });
    });

    it('fails closed on unknown or ambiguous community selectors', async () => {
      await withIsolatedRailsDatabase(sourceUrl!, async (dbUrl, pool) => {
        await loadFixtureSql(pool, '2024');
        await pool.query(
          `UPDATE communities SET slug = 'rio_verde' WHERE id = 12`
        );

        const parent = await makeTempDir('rails-allowlist-bad-');

        await expect(
          captureRailsToBundle({
            sourceUrl: dbUrl,
            outputDir: join(parent, 'missing'),
            communities: ['no-such-community'],
            blobRoot: join(fixtureDir, 'blobs'),
          })
        ).rejects.toThrow(/community selector not found/i);

        await expect(
          captureRailsToBundle({
            sourceUrl: dbUrl,
            outputDir: join(parent, 'ambiguous'),
            communities: ['rio_verde'],
            blobRoot: join(fixtureDir, 'blobs'),
          })
        ).rejects.toThrow(/ambiguous/i);

        expect(await pathExists(join(parent, 'missing'))).toBe(false);
        expect(await pathExists(join(parent, 'ambiguous'))).toBe(false);
      });
    });
  }
);
