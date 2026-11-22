import { createHash } from 'node:crypto';
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { captureRailsToBundle } from '../../src/migration/rails/capture.js';
import {
  LEGACY_RAILS_COMMIT_2024,
  LEGACY_RAILS_COMMIT_2025,
  RAILS_MIGRATION_VERSION_2024,
  RAILS_MIGRATION_VERSION_2025,
  RAILS_SCHEMA_VERSION_2024,
  RAILS_SCHEMA_VERSION_2025,
  RAILS_SOURCE_PROFILE,
} from '../../src/migration/rails/contract.js';
import {
  fixtureDir,
  loadFixtureSql,
  withIsolatedRailsDatabase,
  type RailsSchemaPin,
} from './pg-test-helper.js';

const sourceUrl = process.env.RAILS_MIGRATION_TEST_DATABASE_URL;
const describeWithPostgres = sourceUrl ? describe : describe.skip;

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
  describe.each(['2024', '2025'] as const satisfies readonly RailsSchemaPin[])(
    'pinned schema %s',
    (pin) => {
      it('captures every source table, schema semantic, attachment role, and edge value deterministically', async () => {
        await withIsolatedRailsDatabase(sourceUrl!, async (dbUrl, pool) => {
          await loadFixtureSql(pool, pin);

          if (pin === '2025') {
            await pool.query(
              `UPDATE themes SET expose_mapbox_credentials = true WHERE id = 60`
            );
          }

          // A deployment may contain community-specific/custom tables that our
          // pinned fixture cannot know about. They must be archived rather than discarded.
          await pool.query(
            `CREATE TABLE community_extension (id bigint PRIMARY KEY, payload text NOT NULL)`
          );
          await pool.query(
            `INSERT INTO community_extension(id, payload) VALUES (1, 'custom-data')`
          );
          // PostgreSQL permits identifiers that collide with JavaScript object
          // prototype keys. They are still ordinary source tables and must survive.
          await pool.query(
            `CREATE TABLE "__proto__" (id bigint PRIMARY KEY, payload text NOT NULL)`
          );
          await pool.query(
            `INSERT INTO "__proto__"(id, payload) VALUES (1, 'prototype-name-data')`
          );

          const parent = await mkdtemp(join(tmpdir(), `rails-capture-${pin}-`));
          const outputDir = join(parent, 'bundle');
          const secondOutputDir = join(parent, 'bundle-second');

          const manifest = await captureRailsToBundle({
            sourceUrl: dbUrl,
            outputDir,
            blobRoot: join(fixtureDir, 'blobs'),
          });
          const secondManifest = await captureRailsToBundle({
            sourceUrl: dbUrl,
            outputDir: secondOutputDir,
            blobRoot: join(fixtureDir, 'blobs'),
          });

          expect(secondManifest).toEqual(manifest);
          expect(manifest.source.profile).toBe(RAILS_SOURCE_PROFILE);
          if (pin === '2024') {
            expect(manifest.source.contractProfile).toBe(
              'rails-2024_04_10_210545'
            );
            expect(manifest.source.legacyCommit).toBe(LEGACY_RAILS_COMMIT_2024);
            expect(manifest.source.pinnedRailsSchemaVersion).toBe(
              RAILS_SCHEMA_VERSION_2024
            );
            expect(manifest.source.observedSchemaVersion).toBe(
              RAILS_MIGRATION_VERSION_2024
            );
          } else {
            expect(manifest.source.contractProfile).toBe(
              'rails-2025_11_20_170000'
            );
            expect(manifest.source.legacyCommit).toBe(LEGACY_RAILS_COMMIT_2025);
            expect(manifest.source.pinnedRailsSchemaVersion).toBe(
              RAILS_SCHEMA_VERSION_2025
            );
            expect(manifest.source.observedSchemaVersion).toBe(
              RAILS_MIGRATION_VERSION_2025
            );
          }

          expect(manifest.tables.community_notes?.rowCount).toBe(1);
          expect(manifest.tables.community_extension?.rowCount).toBe(1);
          expect(manifest.tables.community_extension_wide?.rowCount).toBe(1);
          expect(
            Object.prototype.hasOwnProperty.call(manifest.tables, '__proto__')
          ).toBe(true);
          expect(manifest.tables['__proto__']?.rowCount).toBe(1);
          expect(manifest.blobs).toHaveLength(14);

          const placeTable = manifest.tables.places!;
          const latitude = placeTable.columns.find(
            (column) => column.columnName === 'lat'
          );
          expect(latitude).toMatchObject({
            formattedType: 'numeric(10,6)',
            numericPrecision: 10,
            numericScale: 6,
          });

          const usersTable = manifest.tables.users!;
          expect(
            usersTable.columns.find(
              (column) => column.columnName === 'sign_in_count'
            )
          ).toMatchObject({ columnDefault: '0' });
          expect(usersTable.indexes).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ name: 'index_users_on_username' }),
            ])
          );

          const themesTable = manifest.tables.themes!;
          const exposeCol = themesTable.columns.find(
            (column) => column.columnName === 'expose_mapbox_credentials'
          );
          if (pin === '2025') {
            expect(exposeCol).toMatchObject({ dataType: 'boolean' });
          } else {
            expect(exposeCol).toBeUndefined();
          }

          const curriculumStories = manifest.tables.curriculum_stories!;
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

          const readRows = (tableName: string) =>
            (
              archive
                .prepare(
                  `SELECT row_json AS rowJson FROM source_rows WHERE table_name = ? ORDER BY ordinal`
                )
                .all(tableName) as Array<{ rowJson: string }>
            ).map(
              (row) => JSON.parse(row.rowJson) as Record<string, string | null>
            );

          const communityRows = readRows('communities');
          expect(communityRows).toHaveLength(3);
          expect(communityRows[0]?.name).toBe(
            'Comunidade Rio Verde — Amazônia'
          );
          expect(communityRows[1]?.name).toBe('Comunidad Sierra Alta — Ñandú');
          expect(communityRows[2]).toMatchObject({
            id: '12',
            name: 'Община Северная Река',
            locale: null,
            slug: null,
          });

          const placeRows = readRows('places');
          expect(placeRows[1]?.lat).toBeNull();
          expect(placeRows[1]?.long).toBeNull();
          expect(placeRows[2]?.lat).toBe('89.999999');
          expect(placeRows[2]?.long).toBe('-179.999999');

          const speakerRows = readRows('speakers');
          expect(speakerRows[1]?.birthdate).toBe('1948-12-31 23:59:59');
          expect(speakerRows[2]?.birthdate).toBe('1960-01-01 00:00:01');

          const userRows = readRows('users');
          // capture.ts orders rows deterministically by `"id"::text`, so '201' precedes '21'.
          expect(
            userRows.map((u) => `${u.id}:${u.role}:${u.super_admin}`)
          ).toEqual([
            '20:3:false',
            '201:2:true',
            '202:100:false',
            '203:0:false',
            '21:0:false',
            '22:1:false',
            '23:2:false',
            '24:100:true',
            '25:0:false',
            '26:0:false',
            '27:3:false',
            '28:3:false',
            '29:0:false',
          ]);
          expect(userRows.find((u) => u.id === '24')?.community_id).toBeNull();
          expect(userRows.find((u) => u.id === '26')).toMatchObject({
            username: '',
            encrypted_password: '',
          });
          expect(userRows.find((u) => u.id === '27')?.email).toBeNull();
          expect(userRows.find((u) => u.id === '28')?.email).toBe(
            'VIEWER@EXAMPLE.ORG'
          );
          expect(userRows.find((u) => u.id === '29')?.username).toBe(
            'editor@example.org'
          );

          // Verify bcrypt rows (valid $2a$/$2b$ and malformed/empty) survive byte-exact.
          const fixtureUserSql = `${await readFile(join(fixtureDir, 'data.sql'), 'utf8')}\n${await readFile(join(fixtureDir, 'edge-data.sql'), 'utf8')}`;
          const expectedHashesById = new Map<string, string>();
          for (const block of fixtureUserSql.matchAll(
            /INSERT INTO users\([\s\S]*?\)\s*VALUES\s*([\s\S]*?);/g
          )) {
            for (const row of block[1]!.matchAll(
              /\((\d+),\s*(?:'[^']*'|NULL),\s*'([^']*)'/g
            )) {
              expectedHashesById.set(row[1]!, row[2]!);
            }
          }
          expect(expectedHashesById.size).toBe(13);
          for (const [userId, expectedHash] of expectedHashesById) {
            expect(
              userRows.find((u) => u.id === userId)?.encrypted_password
            ).toBe(expectedHash);
          }

          const storyRows = readRows('stories');
          expect(storyRows.map((s) => `${s.id}:${s.permission_level}`)).toEqual(
            ['30:0', '31:1', '32:2', '33:null', '34:0']
          );
          expect(storyRows.find((s) => s.id === '31')?.topic).toBe('');
          expect(storyRows.find((s) => s.id === '32')).toMatchObject({
            topic: null,
            language: null,
          });
          expect(storyRows.find((s) => s.id === '33')?.interviewer_id).toBe(
            '42'
          );

          expect(readRows('places_stories')).toHaveLength(5);
          const mediaLinks = readRows('media_links');
          expect(mediaLinks).toHaveLength(2);
          expect(mediaLinks[1]?.url).toBeNull();

          const themeRows = readRows('themes');
          expect(themeRows[0]?.map_projection).toBe('7');
          if (pin === '2025') {
            expect(themeRows[0]?.expose_mapbox_credentials).toBe('true');
          }

          const flipperKeys = readRows('flipper_features').map((f) => f.key);
          expect(flipperKeys).toEqual([
            'public_communities',
            'split_settings',
            'custom_pilot_flag',
          ]);

          expect(readRows('community_notes')).toEqual([
            {
              id: '1',
              community_id: '10',
              note: 'Custom table community note payload',
              created_at: '2024-02-15 10:00:00',
            },
          ]);
          expect(readRows('community_extension')).toEqual([
            { id: '1', payload: 'custom-data' },
          ]);
          expect(readRows('__proto__')).toEqual([
            { id: '1', payload: 'prototype-name-data' },
          ]);
          expect(readRows('community_extension_wide')[0]).toMatchObject({
            id: '1',
            c01: '01',
            c55: '55',
          });

          const attachments = readRows('active_storage_attachments');
          expect(attachments).toHaveLength(14);
          expect(attachments.map((a) => `${a.record_type}:${a.name}`)).toEqual(
            expect.arrayContaining([
              'Media:media',
              'Place:photo',
              'Place:name_audio',
              'Speaker:photo',
              'User:photo',
              'Community:display_image',
              'Community:background_img',
              'Community:sponsor_logos',
              'Theme:static_map',
              'ActiveStorage::VariantRecord:image',
            ])
          );
          expect(
            attachments.filter((a) => a.name === 'sponsor_logos')
          ).toHaveLength(3);
          expect(attachments.filter((a) => a.blob_id === '111')).toHaveLength(
            2
          );
          expect(readRows('active_storage_variant_records')).toEqual([
            {
              id: '120',
              blob_id: '101',
              variation_digest: 'variant-digest-place-thumb',
            },
          ]);

          archive.close();

          for (const blob of manifest.blobs) {
            const copiedPath = join(outputDir, 'blobs', blob.key);
            const copiedBytes = await readFile(copiedPath);
            expect(createHash('sha256').update(copiedBytes).digest('hex')).toBe(
              blob.sha256
            );
            expect(permissionBits((await stat(copiedPath)).mode)).toBe(0o600);
          }

          expect(
            manifest.blobs.some((blob) => blob.key === 'orphanblob01')
          ).toBe(true);
          expect(await pathExists(join(outputDir, 'manifest.json'))).toBe(true);

          const validationSummary = await readFile(
            join(outputDir, 'validation-summary.txt'),
            'utf8'
          );
          expect(validationSummary).toContain(
            'Terrastories Rails Stage-1 Capture Validation Summary'
          );
          expect(validationSummary).toContain(
            `Contract profile: ${manifest.source.contractProfile}`
          );
          expect(validationSummary).toContain(
            `Tables: ${manifest.totals.tables}`
          );
          expect(validationSummary).toContain(`Rows: ${manifest.totals.rows}`);
          expect(validationSummary).toContain(
            `Blobs: ${manifest.totals.blobs}`
          );
          expect(validationSummary).toContain(manifest.archive.sha256);

          for (const secretOrRowValue of [
            dbUrl,
            '$2a$',
            '$2b$',
            '$2x$',
            'legacy-map-token',
            'legacy-protomaps-key',
            'fixture-reset-token-placeholder',
            'Custom table community note payload',
            'custom-data',
            'prototype-name-data',
            'orphanblob01',
          ]) {
            expect(validationSummary).not.toContain(secretOrRowValue);
          }

          expect(permissionBits((await stat(outputDir)).mode)).toBe(0o700);
          expect(
            permissionBits((await stat(join(outputDir, 'legacy.sqlite'))).mode)
          ).toBe(0o600);
          expect(
            permissionBits((await stat(join(outputDir, 'manifest.json'))).mode)
          ).toBe(0o600);
          expect(
            permissionBits(
              (await stat(join(outputDir, 'validation-summary.txt'))).mode
            )
          ).toBe(0o600);
        });
      });
    }
  );

  it('fails closed on an unknown schema_migrations version', async () => {
    await withIsolatedRailsDatabase(sourceUrl!, async (dbUrl, pool) => {
      await loadFixtureSql(pool, '2024');
      await pool.query(
        `INSERT INTO schema_migrations(version) VALUES ('20260101000000')`
      );

      const parent = await mkdtemp(join(tmpdir(), 'rails-unknown-ver-'));
      const outputDir = join(parent, 'bundle');

      await expect(
        captureRailsToBundle({
          sourceUrl: dbUrl,
          outputDir,
          blobRoot: join(fixtureDir, 'blobs'),
        })
      ).rejects.toThrow(
        /unsupported rails schema_migrations version: 20260101000000/i
      );

      expect(await pathExists(outputDir)).toBe(false);
      expect(
        (await readdir(parent)).some((name) => name.includes('.tmp-'))
      ).toBe(false);
    });
  });

  it('fails closed when schema_migrations has no version rows', async () => {
    await withIsolatedRailsDatabase(sourceUrl!, async (dbUrl, pool) => {
      await loadFixtureSql(pool, '2024');
      await pool.query(`DELETE FROM schema_migrations`);

      const parent = await mkdtemp(join(tmpdir(), 'rails-empty-ver-'));
      const outputDir = join(parent, 'bundle');

      await expect(
        captureRailsToBundle({
          sourceUrl: dbUrl,
          outputDir,
          blobRoot: join(fixtureDir, 'blobs'),
        })
      ).rejects.toThrow(
        /unsupported rails schema_migrations version: missing/i
      );

      expect(await pathExists(outputDir)).toBe(false);
      expect(
        (await readdir(parent)).some((name) => name.includes('.tmp-'))
      ).toBe(false);
    });
  });

  it('fails closed when schema_migrations declares 20251120170000 without expose_mapbox_credentials', async () => {
    await withIsolatedRailsDatabase(sourceUrl!, async (dbUrl, pool) => {
      await loadFixtureSql(pool, '2024');
      await pool.query(
        `INSERT INTO schema_migrations(version) VALUES ('20251120170000')`
      );

      const parent = await mkdtemp(join(tmpdir(), 'rails-missing-col-2025-'));
      const outputDir = join(parent, 'bundle');

      await expect(
        captureRailsToBundle({
          sourceUrl: dbUrl,
          outputDir,
          blobRoot: join(fixtureDir, 'blobs'),
        })
      ).rejects.toThrow(
        /required rails column is missing: themes\.expose_mapbox_credentials/i
      );

      expect(await pathExists(outputDir)).toBe(false);
      expect(
        (await readdir(parent)).some((name) => name.includes('.tmp-'))
      ).toBe(false);
    });
  });

  it('fails closed and leaves no final bundle when an ActiveStorage blob has corrupt size or checksum', async () => {
    await withIsolatedRailsDatabase(sourceUrl!, async (dbUrl, pool) => {
      await loadFixtureSql(pool, '2024');

      // Case 1: byte-size mismatch.
      const sizeParent = await mkdtemp(join(tmpdir(), 'rails-corrupt-size-'));
      const sizeBlobRoot = join(sizeParent, 'blobs');
      const sizeOutputDir = join(sizeParent, 'bundle');
      await cp(join(fixtureDir, 'blobs'), sizeBlobRoot, { recursive: true });
      await writeFile(
        join(sizeBlobRoot, 'st', 'or', 'storymedia01'),
        'corrupt'
      );

      await expect(
        captureRailsToBundle({
          sourceUrl: dbUrl,
          outputDir: sizeOutputDir,
          blobRoot: sizeBlobRoot,
        })
      ).rejects.toThrow(/size mismatch/i);
      expect(await pathExists(sizeOutputDir)).toBe(false);
      expect(
        (await readdir(sizeParent)).some((name) => name.includes('.tmp-'))
      ).toBe(false);

      // Case 2: exact byte size preserved, MD5 checksum corrupted.
      const csumParent = await mkdtemp(join(tmpdir(), 'rails-corrupt-md5-'));
      const csumBlobRoot = join(csumParent, 'blobs');
      const csumOutputDir = join(csumParent, 'bundle');
      await cp(join(fixtureDir, 'blobs'), csumBlobRoot, { recursive: true });
      const targetPath = join(csumBlobRoot, 'st', 'or', 'storymedia01');
      const original = await readFile(targetPath);
      const tampered = Buffer.from(original);
      tampered[0] = tampered[0]! ^ 0x01;
      await writeFile(targetPath, tampered);

      await expect(
        captureRailsToBundle({
          sourceUrl: dbUrl,
          outputDir: csumOutputDir,
          blobRoot: csumBlobRoot,
        })
      ).rejects.toThrow(/checksum mismatch/i);
      expect(await pathExists(csumOutputDir)).toBe(false);
      expect(
        (await readdir(csumParent)).some((name) => name.includes('.tmp-'))
      ).toBe(false);
    });
  });

  it('fails closed when ActiveStorage bytes are missing', async () => {
    await withIsolatedRailsDatabase(sourceUrl!, async (dbUrl, pool) => {
      await loadFixtureSql(pool, '2024');

      const parent = await mkdtemp(join(tmpdir(), 'rails-missing-capture-'));
      const blobRoot = join(parent, 'blobs');
      const outputDir = join(parent, 'bundle');
      await cp(join(fixtureDir, 'blobs'), blobRoot, { recursive: true });
      await rm(join(blobRoot, 'or', 'ph', 'orphanblob01'));

      await expect(
        captureRailsToBundle({
          sourceUrl: dbUrl,
          outputDir,
          blobRoot,
        })
      ).rejects.toThrow(/missing ActiveStorage blob bytes/i);

      expect(await pathExists(outputDir)).toBe(false);
      expect(
        (await readdir(parent)).some((name) => name.includes('.tmp-'))
      ).toBe(false);
    });
  });

  it('never overwrites an existing migration destination', async () => {
    await withIsolatedRailsDatabase(sourceUrl!, async (dbUrl, pool) => {
      await loadFixtureSql(pool, '2024');

      const parent = await mkdtemp(join(tmpdir(), 'rails-existing-capture-'));
      const outputDir = join(parent, 'bundle');
      await mkdir(outputDir);
      await writeFile(join(outputDir, 'sentinel'), 'keep-me');

      await expect(
        captureRailsToBundle({
          sourceUrl: dbUrl,
          outputDir,
          blobRoot: join(fixtureDir, 'blobs'),
        })
      ).rejects.toThrow(/destination already exists/i);

      expect(await readFile(join(outputDir, 'sentinel'), 'utf8')).toBe(
        'keep-me'
      );
    });
  });

  it('fails closed instead of silently skipping application tables outside public', async () => {
    await withIsolatedRailsDatabase(sourceUrl!, async (dbUrl, pool) => {
      await loadFixtureSql(pool, '2024');

      const parent = await mkdtemp(join(tmpdir(), 'rails-extra-schema-'));
      const outputDir = join(parent, 'bundle');

      await pool.query(`CREATE SCHEMA community_extra`);
      await pool.query(
        `CREATE TABLE community_extra.protected_history (id bigint PRIMARY KEY, payload text NOT NULL)`
      );
      await pool.query(
        `INSERT INTO community_extra.protected_history(id, payload) VALUES (1, 'must-not-disappear')`
      );

      await expect(
        captureRailsToBundle({
          sourceUrl: dbUrl,
          outputDir,
          blobRoot: join(fixtureDir, 'blobs'),
        })
      ).rejects.toThrow(/unsupported source schema|non-public.*table/i);
      expect(await pathExists(outputDir)).toBe(false);
    });
  });
});
