import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { captureRailsToBundle } from '../../src/migration/rails/capture.js';

const sourceUrl = process.env.RAILS_MIGRATION_TEST_DATABASE_URL;
const describeWithPostgres = sourceUrl ? describe : describe.skip;
const fixtureDir = dirname(
  fileURLToPath(new URL('../fixtures/rails/schema.sql', import.meta.url))
);

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describeWithPostgres('Rails source capture', () => {
  const pool = sourceUrl ? new Pool({ connectionString: sourceUrl }) : null;

  beforeAll(async () => {
    if (!pool) return;
    const schemaSql = await readFile(join(fixtureDir, 'schema.sql'), 'utf8');
    const dataSql = await readFile(join(fixtureDir, 'data.sql'), 'utf8');
    await pool.query(schemaSql);
    await pool.query(dataSql);

    // A deployment may contain community-specific/custom tables that our pinned
    // fixture cannot know about. They must be archived rather than discarded.
    await pool.query(
      `CREATE TABLE community_extension (id bigint PRIMARY KEY, payload text NOT NULL)`
    );
    await pool.query(
      `INSERT INTO community_extension(id, payload) VALUES (1, 'custom-data')`
    );
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('captures every source table and edge value into a deterministic SQLite archive', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'rails-capture-'));
    const outputDir = join(parent, 'bundle');

    const manifest = await captureRailsToBundle({
      sourceUrl: sourceUrl!,
      outputDir,
      blobRoot: join(fixtureDir, 'blobs'),
    });

    expect(manifest.source.legacyCommit).toBe(
      'f6f033a17bd4a4c600ffea8bc2e773d243f88f72'
    );
    expect(manifest.source.pinnedRailsSchemaVersion).toBe('2024_04_10_210545');
    expect(manifest.source.observedSchemaVersion).toBe('20240410210545');
    expect(manifest.tables.community_extension?.rowCount).toBe(1);
    expect(manifest.blobs).toHaveLength(1);
    expect(manifest.blobs[0]?.sha256).toBe(
      '0ec70a2413d61dfe7639d725d34f3781ece06b44f6b41c386a5605700c00c4e1'
    );

    const archive = new Database(join(outputDir, 'legacy.sqlite'), {
      readonly: true,
    });

    const placeRows = archive
      .prepare(
        `SELECT row_json AS rowJson FROM source_rows WHERE table_name = ? ORDER BY ordinal`
      )
      .all('places') as Array<{ rowJson: string }>;
    const unmappedPlace = JSON.parse(placeRows[1]!.rowJson) as Record<
      string,
      string | null
    >;
    expect(unmappedPlace.lat).toBeNull();
    expect(unmappedPlace.long).toBeNull();

    const users = archive
      .prepare(
        `SELECT row_json AS rowJson FROM source_rows WHERE table_name = ? ORDER BY ordinal`
      )
      .all('users') as Array<{ rowJson: string }>;
    expect(users.map((row) => JSON.parse(row.rowJson).role)).toEqual([
      '3',
      '0',
      '1',
      '2',
      '100',
    ]);
    expect(JSON.parse(users[4]!.rowJson).community_id).toBeNull();

    const custom = archive
      .prepare(
        `SELECT row_json AS rowJson FROM source_rows WHERE table_name = ? ORDER BY ordinal`
      )
      .get('community_extension') as { rowJson: string };
    expect(JSON.parse(custom.rowJson)).toEqual({
      id: '1',
      payload: 'custom-data',
    });

    archive.close();

    expect(await readFile(join(outputDir, 'blobs', 'fixtureblob'), 'utf8')).toBe(
      "<svg xmlns='http://www.w3.org/2000/svg'></svg>\n"
    );
    expect(await pathExists(join(outputDir, 'manifest.json'))).toBe(true);
  });

  it('fails closed and leaves no final bundle when an ActiveStorage blob is corrupt', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'rails-corrupt-capture-'));
    const blobRoot = join(parent, 'blobs');
    const outputDir = join(parent, 'bundle');
    await writeFile(join(parent, 'placeholder'), 'placeholder');
    await import('node:fs/promises').then(({ mkdir }) =>
      mkdir(blobRoot, { recursive: true })
    );
    await writeFile(join(blobRoot, 'fixtureblob'), 'corrupt');

    await expect(
      captureRailsToBundle({
        sourceUrl: sourceUrl!,
        outputDir,
        blobRoot,
      })
    ).rejects.toThrow(/size|checksum/i);

    expect(await pathExists(outputDir)).toBe(false);
  });
});
