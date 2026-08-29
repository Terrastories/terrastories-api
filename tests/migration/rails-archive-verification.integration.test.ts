import { createHash } from 'node:crypto';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  captureRailsToBundle,
  verifyCapturedArchive,
} from '../../src/migration/rails/capture.js';

const sourceUrl = process.env.RAILS_MIGRATION_TEST_DATABASE_URL;
const describeWithPostgres = sourceUrl ? describe : describe.skip;
const fixtureDir = dirname(
  fileURLToPath(new URL('../fixtures/rails/schema.sql', import.meta.url))
);

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describeWithPostgres('Rails capture archive verification', () => {
  const pool = sourceUrl ? new Pool({ connectionString: sourceUrl }) : null;

  beforeAll(async () => {
    if (!pool) return;
    await pool.query(await readFile(join(fixtureDir, 'schema.sql'), 'utf8'));
    await pool.query(await readFile(join(fixtureDir, 'data.sql'), 'utf8'));
    await pool.query(await readFile(join(fixtureDir, 'edge-data.sql'), 'utf8'));
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('records the final SQLite archive digest and detects post-write row corruption', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'rails-archive-verify-'));
    const outputDir = join(parent, 'bundle');

    const manifest = await captureRailsToBundle({
      sourceUrl: sourceUrl!,
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
        `UPDATE source_rows SET row_json = '{"tampered":"yes"}' WHERE table_name = (SELECT table_name FROM source_rows ORDER BY table_name, ordinal LIMIT 1) AND ordinal = (SELECT min(ordinal) FROM source_rows)`
      )
      .run();
    archive.close();

    await expect(verifyCapturedArchive(archivePath, manifest)).rejects.toThrow(
      /archive.*(digest|hash|row|integrity)|row.*(digest|hash)/i
    );
  });
});
