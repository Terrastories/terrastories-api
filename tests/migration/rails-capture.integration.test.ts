import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  writeFile,
} from 'node:fs/promises';
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

function permissionBits(mode: number): number {
  return mode & 0o777;
}

describeWithPostgres('Rails source capture', () => {
  const pool = sourceUrl ? new Pool({ connectionString: sourceUrl }) : null;

  beforeAll(async () => {
    if (!pool) return;
    const schemaSql = await readFile(join(fixtureDir, 'schema.sql'), 'utf8');
    const dataSql = await readFile(join(fixtureDir, 'data.sql'), 'utf8');
    const edgeDataSql = await readFile(join(fixtureDir, 'edge-data.sql'), 'utf8');
    await pool.query(schemaSql);
    await pool.query(dataSql);
    await pool.query(edgeDataSql);

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

  it('captures every source table, schema semantic, attachment role, and edge value deterministically', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'rails-capture-'));
    const outputDir = join(parent, 'bundle');
    const secondOutputDir = join(parent, 'bundle-second');

    const manifest = await captureRailsToBundle({
      sourceUrl: sourceUrl!,
      outputDir,
      blobRoot: join(fixtureDir, 'blobs'),
    });
    const secondManifest = await captureRailsToBundle({
      sourceUrl: sourceUrl!,
      outputDir: secondOutputDir,
      blobRoot: join(fixtureDir, 'blobs'),
    });

    expect(secondManifest).toEqual(manifest);
    expect(manifest.source.legacyCommit).toBe(
      'f6f033a17bd4a4c600ffea8bc2e773d243f88f72'
    );
    expect(manifest.source.pinnedRailsSchemaVersion).toBe('2024_04_10_210545');
    expect(manifest.source.observedSchemaVersion).toBe('20240410210545');
    expect(manifest.tables.community_extension?.rowCount).toBe(1);
    expect(manifest.tables.community_extension_wide?.rowCount).toBe(1);
    expect(manifest.blobs).toHaveLength(1);
    expect(manifest.blobs[0]?.sha256).toBe(
      '0ec70a2413d61dfe7639d725d34f3781ece06b44f6b41c386a5605700c00c4e1'
    );

    const placeTable = manifest.tables.places as unknown as {
      columns: Array<{
        columnName: string;
        formattedType?: string;
        numericPrecision?: number | null;
        numericScale?: number | null;
      }>;
      indexes?: Array<{ name: string; definition: string }>;
    };
    const latitude = placeTable.columns.find(
      (column) => column.columnName === 'lat'
    );
    expect(latitude).toMatchObject({
      formattedType: 'numeric(10,6)',
      numericPrecision: 10,
      numericScale: 6,
    });

    const usersTable = manifest.tables.users as unknown as {
      columns: Array<{ columnName: string; columnDefault?: string | null }>;
      indexes?: Array<{ name: string; definition: string }>;
    };
    expect(
      usersTable.columns.find((column) => column.columnName === 'sign_in_count')
    ).toMatchObject({ columnDefault: '0' });
    expect(usersTable.indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'index_users_on_username' }),
      ])
    );

    const curriculumStories = manifest.tables.curriculum_stories as unknown as {
      constraints?: Array<{ name: string; type: string; definition: string }>;
    };
    expect(curriculumStories.constraints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'FOREIGN KEY',
          definition: expect.stringContaining('curriculum_id'),
        }),
        expect.objectContaining({
          type: 'FOREIGN KEY',
          definition: expect.stringContaining('story_id'),
        }),
      ])
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

    const wide = archive
      .prepare(
        `SELECT row_json AS rowJson FROM source_rows WHERE table_name = ? ORDER BY ordinal`
      )
      .get('community_extension_wide') as { rowJson: string };
    expect(JSON.parse(wide.rowJson)).toMatchObject({
      id: '1',
      c01: '01',
      c55: '55',
    });

    const attachments = archive
      .prepare(
        `SELECT row_json AS rowJson FROM source_rows WHERE table_name = ? ORDER BY ordinal`
      )
      .all('active_storage_attachments') as Array<{ rowJson: string }>;
    expect(
      attachments.map((row) => {
        const attachment = JSON.parse(row.rowJson) as {
          name: string;
          record_type: string;
        };
        return `${attachment.record_type}:${attachment.name}`;
      })
    ).toContain('Theme:static_map');

    archive.close();

    expect(
      await readFile(join(outputDir, 'blobs', 'fixtureblob'), 'utf8')
    ).toBe("<svg xmlns='http://www.w3.org/2000/svg'></svg>\n");
    expect(await pathExists(join(outputDir, 'manifest.json'))).toBe(true);
    expect(permissionBits((await stat(outputDir)).mode)).toBe(0o700);
    expect(permissionBits((await stat(join(outputDir, 'legacy.sqlite'))).mode)).toBe(
      0o600
    );
    expect(permissionBits((await stat(join(outputDir, 'manifest.json'))).mode)).toBe(
      0o600
    );
    expect(
      permissionBits((await stat(join(outputDir, 'blobs', 'fixtureblob'))).mode)
    ).toBe(0o600);
  });

  it('fails closed and leaves no final bundle when an ActiveStorage blob is corrupt', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'rails-corrupt-capture-'));
    const blobRoot = join(parent, 'blobs');
    const outputDir = join(parent, 'bundle');
    await mkdir(blobRoot, { recursive: true });
    await writeFile(join(blobRoot, 'fixtureblob'), 'corrupt');

    await expect(
      captureRailsToBundle({
        sourceUrl: sourceUrl!,
        outputDir,
        blobRoot,
      })
    ).rejects.toThrow(/size|checksum/i);

    expect(await pathExists(outputDir)).toBe(false);
    expect((await readdir(parent)).some((name) => name.includes('.tmp-'))).toBe(
      false
    );
  });

  it('fails closed when ActiveStorage bytes are missing', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'rails-missing-capture-'));
    const blobRoot = join(parent, 'blobs');
    const outputDir = join(parent, 'bundle');
    await mkdir(blobRoot, { recursive: true });

    await expect(
      captureRailsToBundle({
        sourceUrl: sourceUrl!,
        outputDir,
        blobRoot,
      })
    ).rejects.toThrow(/missing ActiveStorage blob bytes/i);

    expect(await pathExists(outputDir)).toBe(false);
    expect((await readdir(parent)).some((name) => name.includes('.tmp-'))).toBe(
      false
    );
  });

  it('never overwrites an existing migration destination', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'rails-existing-capture-'));
    const outputDir = join(parent, 'bundle');
    await mkdir(outputDir);
    await writeFile(join(outputDir, 'sentinel'), 'keep-me');

    await expect(
      captureRailsToBundle({
        sourceUrl: sourceUrl!,
        outputDir,
        blobRoot: join(fixtureDir, 'blobs'),
      })
    ).rejects.toThrow(/destination already exists/i);

    expect(await readFile(join(outputDir, 'sentinel'), 'utf8')).toBe('keep-me');
  });
});
