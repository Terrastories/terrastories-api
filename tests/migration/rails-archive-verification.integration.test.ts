import { createHash } from 'node:crypto';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  captureRailsToBundle,
  verifyCapturedArchive,
} from '../../src/migration/rails/capture.js';
import {
  fixtureDir,
  loadFixtureSql,
  withIsolatedRailsDatabase,
  type RailsSchemaPin,
} from './pg-test-helper.js';

const sourceUrl = process.env.RAILS_MIGRATION_TEST_DATABASE_URL;
const describeWithPostgres = sourceUrl ? describe : describe.skip;

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describeWithPostgres('Rails capture archive verification', () => {
  describe.each(['2024', '2025'] as const satisfies readonly RailsSchemaPin[])(
    'pinned schema %s',
    (pin) => {
      it('records the final SQLite archive digest and detects post-write row corruption', async () => {
        await withIsolatedRailsDatabase(sourceUrl!, async (dbUrl, pool) => {
          await loadFixtureSql(pool, pin);

          const parent = await mkdtemp(
            join(tmpdir(), `rails-archive-verify-${pin}-`)
          );
          const outputDir = join(parent, 'bundle');

          const manifest = await captureRailsToBundle({
            sourceUrl: dbUrl,
            outputDir,
            blobRoot: join(fixtureDir, 'blobs'),
          });
          const archivePath = join(outputDir, 'legacy.sqlite');
          const archiveBytes = await readFile(archivePath);
          const archiveStat = await stat(archivePath);

          expect(manifest.archive).toEqual({
            filename: 'legacy.sqlite',
            byteSize: String(archiveStat.size),
            sha256: sha256(archiveBytes),
          });
          await expect(
            verifyCapturedArchive(archivePath, manifest)
          ).resolves.toBeUndefined();

          const archive = new Database(archivePath);
          archive
            .prepare(
              `UPDATE source_rows SET row_json = '{"tampered":"yes"}'
               WHERE table_name = (SELECT table_name FROM source_rows ORDER BY table_name, ordinal LIMIT 1)
                 AND ordinal = (SELECT min(ordinal) FROM source_rows)`
            )
            .run();
          archive.close();

          await expect(
            verifyCapturedArchive(archivePath, manifest)
          ).rejects.toThrow(
            /archive.*(digest|hash|row|integrity)|row.*(digest|hash)/i
          );
        });
      });
    }
  );
});
