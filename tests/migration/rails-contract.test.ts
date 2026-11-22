import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { BCRYPT_HASH_PATTERN } from '../../src/shared/auth-policy.js';
import {
  assertSafeActiveStorageKey,
  mapWithConcurrency,
  resolveActiveStorageBlobPath,
  verifyAndCopyActiveStorageBlob,
} from '../../src/migration/rails/active-storage.js';
import {
  buildS3ObjectUrl,
  normalizeS3Prefix,
  resolveS3CredentialsFromEnv,
  signS3GetRequest,
  validateS3Config,
  verifyAndDownloadS3Blob,
} from '../../src/migration/rails/s3-client.js';
import { parseArgs as parseCliArgs } from '../../scripts/migrate-rails.js';
import { startFakeS3Server, type FakeS3Server } from './fake-s3.js';
import {
  verifyCapturedArchive,
  type RailsCaptureManifest,
} from '../../src/migration/rails/capture.js';
import {
  LEGACY_RAILS_COMMIT_2024,
  LEGACY_RAILS_COMMIT_2025,
  RAILS_MIGRATION_VERSION_2024,
  RAILS_MIGRATION_VERSION_2025,
  RAILS_SCHEMA_VERSION_2024,
  RAILS_SCHEMA_VERSION_2025,
  RAILS_SOURCE_PROFILE,
  REQUIRED_RAILS_TABLES,
  REQUIRED_RAILS_TABLES_2025,
  SUPPORTED_RAILS_SOURCES,
  selectRailsSourceContract,
  validateRailsSourceSchema,
} from '../../src/migration/rails/contract.js';
import { buildCaptureValidationSummary } from '../../src/migration/rails/validation-summary.js';

const fixtureDir = dirname(
  fileURLToPath(new URL('../fixtures/rails/schema.sql', import.meta.url))
);

const tempDirs: string[] = [];
const fakeServers: FakeS3Server[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const server of fakeServers.splice(0)) {
    await server.close();
  }
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

function buildMockTables(options?: {
  includeExposeMapboxCredentials?: boolean;
  exposeMapboxCredentialsType?: string;
  omitTable?: string;
  omitColumn?: { table: string; column: string };
  swapCommunityBetaPublic?: boolean;
}) {
  const tableMap: Record<string, readonly string[]> =
    options?.includeExposeMapboxCredentials
      ? REQUIRED_RAILS_TABLES_2025
      : REQUIRED_RAILS_TABLES;

  return Object.entries(tableMap)
    .filter(([tableName]) => tableName !== options?.omitTable)
    .map(([tableName, columns]) => {
      let orderedColumns = [...columns];
      if (tableName === 'communities' && options?.swapCommunityBetaPublic) {
        orderedColumns = orderedColumns.map((col) => {
          if (col === 'beta') return 'public';
          if (col === 'public') return 'beta';
          return col;
        });
      }
      if (options?.omitColumn?.table === tableName) {
        orderedColumns = orderedColumns.filter(
          (col) => col !== options.omitColumn?.column
        );
      }
      return {
        tableName,
        columns: orderedColumns.map((columnName) => ({
          columnName,
          dataType:
            tableName === 'themes' && columnName === 'expose_mapbox_credentials'
              ? (options?.exposeMapboxCredentialsType ?? 'boolean')
              : 'character varying',
        })),
      };
    });
}

function createSyntheticArchiveManifest(
  archivePath: string,
  archiveBytes: Buffer,
  rowJson: string
): RailsCaptureManifest {
  const rowSha = createHash('sha256').update(rowJson).digest('hex');
  const tableSha = createHash('sha256').update(rowSha).digest('hex');
  const columns = [
    {
      columnName: 'id',
      dataType: 'bigint',
      udtName: 'int8',
      formattedType: 'bigint',
      nullable: false,
      ordinal: 1,
      columnDefault: null,
      characterMaximumLength: null,
      numericPrecision: 64,
      numericScale: 0,
      datetimePrecision: null,
      collationName: null,
      isIdentity: false,
      identityGeneration: null,
      isGenerated: false,
      generationExpression: null,
    },
  ];
  const tables = {
    communities: {
      rowCount: 1,
      rowSha256: tableSha,
      primaryKey: ['id'],
      columns,
      constraints: [],
      indexes: [],
      rowSecurityEnabled: false,
      rowSecurityForced: false,
    },
  };

  return {
    formatVersion: 1,
    source: {
      profile: RAILS_SOURCE_PROFILE,
      contractProfile: 'rails-2024_04_10_210545',
      legacyCommit: LEGACY_RAILS_COMMIT_2024,
      pinnedRailsSchemaVersion: RAILS_SCHEMA_VERSION_2024,
      observedSchemaVersion: RAILS_MIGRATION_VERSION_2024,
      schemaSha256: createHash('sha256')
        .update(JSON.stringify(tables))
        .digest('hex'),
    },
    storage: { kind: 'disk' },
    blobSelection: { mode: 'all', selectors: [], communities: [] },
    archive: {
      filename: 'legacy.sqlite',
      byteSize: String(archiveBytes.length),
      sha256: createHash('sha256').update(archiveBytes).digest('hex'),
    },
    tables,
    blobs: [],
    totals: {
      tables: 1,
      rows: 1,
      blobs: 0,
      blobsSelected: 0,
      blobsNotSelected: 0,
    },
  };
}

async function writeSyntheticArchive(
  dir: string,
  rowJson = '{"id":"10"}'
): Promise<{ archivePath: string; manifest: RailsCaptureManifest }> {
  const archivePath = join(dir, 'legacy.sqlite');
  const db = new Database(archivePath);
  db.exec(`
    CREATE TABLE source_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE source_tables (
      table_name TEXT PRIMARY KEY,
      columns_json TEXT NOT NULL,
      primary_key_json TEXT NOT NULL,
      constraints_json TEXT NOT NULL,
      indexes_json TEXT NOT NULL,
      row_security_enabled INTEGER NOT NULL,
      row_security_forced INTEGER NOT NULL,
      row_count INTEGER NOT NULL,
      row_sha256 TEXT NOT NULL
    );
    CREATE TABLE source_rows (
      table_name TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      row_json TEXT NOT NULL,
      row_sha256 TEXT NOT NULL,
      PRIMARY KEY (table_name, ordinal),
      FOREIGN KEY (table_name) REFERENCES source_tables(table_name)
    );
  `);

  const rowSha = createHash('sha256').update(rowJson).digest('hex');
  const tableSha = createHash('sha256').update(rowSha).digest('hex');
  const columns = [
    {
      columnName: 'id',
      dataType: 'bigint',
      udtName: 'int8',
      formattedType: 'bigint',
      nullable: false,
      ordinal: 1,
      columnDefault: null,
      characterMaximumLength: null,
      numericPrecision: 64,
      numericScale: 0,
      datetimePrecision: null,
      collationName: null,
      isIdentity: false,
      identityGeneration: null,
      isGenerated: false,
      generationExpression: null,
    },
  ];
  const tables = {
    communities: {
      rowCount: 1,
      rowSha256: tableSha,
      primaryKey: ['id'],
      columns,
      constraints: [],
      indexes: [],
      rowSecurityEnabled: false,
      rowSecurityForced: false,
    },
  };
  const schemaSha256 = createHash('sha256')
    .update(JSON.stringify(tables))
    .digest('hex');

  const insertMeta = db.prepare(
    'INSERT INTO source_metadata(key, value) VALUES (?, ?)'
  );
  insertMeta.run('source_profile', RAILS_SOURCE_PROFILE);
  insertMeta.run('contract_profile', 'rails-2024_04_10_210545');
  insertMeta.run('legacy_commit', LEGACY_RAILS_COMMIT_2024);
  insertMeta.run('pinned_rails_schema_version', RAILS_SCHEMA_VERSION_2024);
  insertMeta.run('observed_schema_version', RAILS_MIGRATION_VERSION_2024);
  insertMeta.run('source_schema_sha256', schemaSha256);

  db.prepare(
    `INSERT INTO source_tables VALUES (?, ?, ?, ?, ?, 0, 0, 1, ?)`
  ).run('communities', JSON.stringify(columns), '["id"]', '[]', '[]', tableSha);
  db.prepare(`INSERT INTO source_rows VALUES (?, 0, ?, ?)`).run(
    'communities',
    rowJson,
    rowSha
  );
  db.close();

  const archiveBytes = await readFile(archivePath);
  const manifest = createSyntheticArchiveManifest(
    archivePath,
    archiveBytes,
    rowJson
  );
  manifest.source.schemaSha256 = schemaSha256;
  return { archivePath, manifest };
}

describe('legacy Rails migration dual-pin contract', () => {
  it('pins both audited legacy repository revisions and schema versions', () => {
    expect(RAILS_SOURCE_PROFILE).toBe('rails-postgresql');
    expect(LEGACY_RAILS_COMMIT_2024).toBe(
      'f6f033a17bd4a4c600ffea8bc2e773d243f88f72'
    );
    expect(LEGACY_RAILS_COMMIT_2025).toBe(
      '3983848d9ba483e8bf14dcb38d9bafda68685870'
    );
    expect(RAILS_SCHEMA_VERSION_2024).toBe('2024_04_10_210545');
    expect(RAILS_SCHEMA_VERSION_2025).toBe('2025_11_20_170000');
    expect(SUPPORTED_RAILS_SOURCES).toHaveLength(2);
  });

  it('requires every data-bearing Rails domain and ActiveStorage table', () => {
    expect(Object.keys(REQUIRED_RAILS_TABLES).sort()).toEqual(
      [
        'active_storage_attachments',
        'active_storage_blobs',
        'active_storage_variant_records',
        'communities',
        'curriculum_stories',
        'curriculums',
        'flipper_features',
        'flipper_gates',
        'media',
        'media_links',
        'places',
        'places_stories',
        'speaker_stories',
        'speakers',
        'stories',
        'themes',
        'users',
      ].sort()
    );

    expect(REQUIRED_RAILS_TABLES.users).toContain('encrypted_password');
    expect(REQUIRED_RAILS_TABLES.users).toContain('super_admin');
    expect(REQUIRED_RAILS_TABLES.stories).toContain('permission_level');
    expect(REQUIRED_RAILS_TABLES.places).toContain('lat');
    expect(REQUIRED_RAILS_TABLES.places).toContain('long');
    expect(REQUIRED_RAILS_TABLES.themes).toContain('protomaps_basemap_style');
    expect(REQUIRED_RAILS_TABLES.themes).not.toContain(
      'expose_mapbox_credentials'
    );
    expect(REQUIRED_RAILS_TABLES_2025.themes).toContain(
      'expose_mapbox_credentials'
    );
  });

  it('selects contract deterministically by observed schema_migrations version and fails closed on any other', () => {
    const c2024 = selectRailsSourceContract(RAILS_MIGRATION_VERSION_2024);
    expect(c2024.profile).toBe('rails-2024_04_10_210545');
    expect(c2024.legacyCommit).toBe(LEGACY_RAILS_COMMIT_2024);
    expect(c2024.railsSchemaVersion).toBe(RAILS_SCHEMA_VERSION_2024);

    const c2025 = selectRailsSourceContract(RAILS_MIGRATION_VERSION_2025);
    expect(c2025.profile).toBe('rails-2025_11_20_170000');
    expect(c2025.legacyCommit).toBe(LEGACY_RAILS_COMMIT_2025);
    expect(c2025.railsSchemaVersion).toBe(RAILS_SCHEMA_VERSION_2025);

    for (const invalid of [
      null,
      '',
      '20230101000000',
      '20260101000000',
      '2024_04_10_210545',
    ]) {
      expect(() => selectRailsSourceContract(invalid)).toThrow(
        /unsupported rails schema_migrations version/i
      );
    }
  });

  it('validates schema by column name/type regardless of ordinal order and fails closed on regressions', () => {
    const c2024 = selectRailsSourceContract(RAILS_MIGRATION_VERSION_2024);
    const c2025 = selectRailsSourceContract(RAILS_MIGRATION_VERSION_2025);

    expect(() =>
      validateRailsSourceSchema(
        buildMockTables({ swapCommunityBetaPublic: true }),
        c2024
      )
    ).not.toThrow();

    expect(() =>
      validateRailsSourceSchema(
        buildMockTables({
          includeExposeMapboxCredentials: true,
          swapCommunityBetaPublic: true,
        }),
        c2025
      )
    ).not.toThrow();

    expect(() =>
      validateRailsSourceSchema(
        buildMockTables({ omitTable: 'stories' }),
        c2024
      )
    ).toThrow(/required rails table is missing: stories/i);

    expect(() =>
      validateRailsSourceSchema(
        buildMockTables({ includeExposeMapboxCredentials: false }),
        c2025
      )
    ).toThrow(
      /required rails column is missing: themes\.expose_mapbox_credentials/i
    );

    expect(() =>
      validateRailsSourceSchema(
        buildMockTables({
          includeExposeMapboxCredentials: true,
          exposeMapboxCredentialsType: 'character varying',
        }),
        c2025
      )
    ).toThrow(/required rails column type mismatch/i);
  });
});

describe('ActiveStorage blob resolution and copy verification', () => {
  it('accepts a flat object-store export by ActiveStorage key', async () => {
    const root = await makeTempDir('rails-flat-blobs-');
    const expected = join(root, 'fixtureblob');
    await writeFile(expected, 'fixture');

    await expect(
      resolveActiveStorageBlobPath(root, 'fixtureblob')
    ).resolves.toBe(expected);
  });

  it('accepts Rails DiskService two-level key layout', async () => {
    const root = await makeTempDir('rails-disk-blobs-');
    const nested = join(root, 'fi', 'xt');
    await mkdir(nested, { recursive: true });
    const expected = join(nested, 'fixtureblob');
    await writeFile(expected, 'fixture');

    await expect(
      resolveActiveStorageBlobPath(root, 'fixtureblob')
    ).resolves.toBe(expected);
  });

  it('rejects unsafe blob keys before touching the filesystem', async () => {
    const root = await makeTempDir('rails-unsafe-blobs-');
    await expect(
      resolveActiveStorageBlobPath(root, '../secret')
    ).rejects.toThrow(/unsafe ActiveStorage key/i);
  });

  it('rejects symlinks instead of following blob paths outside the trusted export', async () => {
    const root = await makeTempDir('rails-symlink-blobs-');
    const outside = join(await makeTempDir('rails-secret-'), 'secret');
    await writeFile(outside, 'not-an-exported-blob');
    await symlink(outside, join(root, 'fixtureblob'));

    await expect(
      resolveActiveStorageBlobPath(root, 'fixtureblob')
    ).rejects.toThrow(/symlink|outside|missing ActiveStorage blob bytes/i);
  });

  it('rejects DiskService paths whose parent directory escapes through a symlink', async () => {
    const root = await makeTempDir('rails-parent-symlink-blobs-');
    const outsideRoot = await makeTempDir('rails-parent-secret-');
    const outsideNested = join(outsideRoot, 'xt');
    await mkdir(outsideNested);
    await writeFile(join(outsideNested, 'fixtureblob'), 'outside-root');
    await symlink(outsideRoot, join(root, 'fi'));

    await expect(
      resolveActiveStorageBlobPath(root, 'fixtureblob')
    ).rejects.toThrow(/outside|symlink|missing ActiveStorage blob bytes/i);
  });

  it('verifies size, MD5 checksum, copies with 0600 perms, and records SHA-256', async () => {
    const root = await makeTempDir('rails-copy-src-');
    const dest = await makeTempDir('rails-copy-dst-');
    const payload = Buffer.from('deterministic-blob-payload\n', 'utf8');
    const nested = join(root, 'bl', 'ob');
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, 'blobkey01'), payload);

    const md5 = createHash('md5').update(payload).digest('base64');
    const sha256 = createHash('sha256').update(payload).digest('hex');

    const copied = await verifyAndCopyActiveStorageBlob({
      blobRoot: root,
      destinationRoot: dest,
      id: '1',
      key: 'blobkey01',
      filename: 'payload.txt',
      contentType: 'text/plain',
      byteSize: String(payload.length),
      checksum: md5,
      serviceName: 'local',
    });

    expect(copied).toEqual({
      disposition: 'captured',
      id: '1',
      key: 'blobkey01',
      filename: 'payload.txt',
      contentType: 'text/plain',
      byteSize: String(payload.length),
      railsChecksum: md5,
      sha256,
      serviceName: 'local',
    });
    expect((await stat(join(dest, 'blobkey01'))).mode & 0o777).toBe(0o600);
  });

  it('rejects byte-size and same-size MD5 checksum mismatches', async () => {
    const root = await makeTempDir('rails-copy-bad-');
    const dest = await makeTempDir('rails-copy-bad-dst-');
    const payload = Buffer.from('actual-bytes', 'utf8');
    await writeFile(join(root, 'blobkey02'), payload);

    await expect(
      verifyAndCopyActiveStorageBlob({
        blobRoot: root,
        destinationRoot: dest,
        id: '2',
        key: 'blobkey02',
        filename: 'bad.txt',
        contentType: 'text/plain',
        byteSize: String(payload.length + 5),
        checksum: null,
        serviceName: 'local',
      })
    ).rejects.toThrow(/size mismatch/i);

    const wrongMd5 = createHash('md5').update('other-bytes!').digest('base64');
    await expect(
      verifyAndCopyActiveStorageBlob({
        blobRoot: root,
        destinationRoot: dest,
        id: '2',
        key: 'blobkey02',
        filename: 'bad.txt',
        contentType: 'text/plain',
        byteSize: String(payload.length),
        checksum: wrongMd5,
        serviceName: 'local',
      })
    ).rejects.toThrow(/checksum mismatch/i);
  });
});

describe('capture validation summary and offline archive verification', () => {
  it('renders a deterministic secret-free validation summary', async () => {
    const dir = await makeTempDir('rails-summary-');
    const { manifest } = await writeSyntheticArchive(dir);
    const multiTableManifest: RailsCaptureManifest = {
      ...manifest,
      tables: {
        users: { ...manifest.tables.communities!, rowCount: 2 },
        communities: manifest.tables.communities!,
      },
      totals: { ...manifest.totals, tables: 2, rows: 3 },
    };
    const summary = buildCaptureValidationSummary(multiTableManifest);

    expect(summary).toContain('Source profile: rails-postgresql');
    expect(summary).toContain('Contract profile: rails-2024_04_10_210545');
    expect(summary).toContain(`Legacy commit: ${LEGACY_RAILS_COMMIT_2024}`);
    expect(summary).toContain('Pinned Rails schema version: 2024_04_10_210545');
    expect(summary).toContain('Observed Rails schema version: 20240410210545');
    expect(summary).toContain('Blob source: disk');
    expect(summary).toContain('Blob selection: all');
    expect(summary).toContain('Blobs selected: 0');
    expect(summary).toContain('Blobs not_selected: 0');
    expect(summary).toContain('  - communities: 1 rows\n  - users: 2 rows');
    expect(summary).toContain('intentionally excludes source row contents');

    const allowlistSummary = buildCaptureValidationSummary({
      ...multiTableManifest,
      storage: {
        kind: 's3',
        bucket: 'fixture-bucket',
        region: 'us-east-2',
        prefix: null,
      },
      blobSelection: {
        mode: 'community_allowlist',
        selectors: ['rio_verde'],
        communities: [{ id: '10', slug: 'rio_verde' }],
      },
      totals: {
        ...multiTableManifest.totals,
        blobs: 16,
        blobsSelected: 14,
        blobsNotSelected: 2,
      },
    });
    expect(allowlistSummary).toContain('Blob source: s3');
    expect(allowlistSummary).toContain(
      'Blob selection: community_allowlist (10)'
    );
    expect(allowlistSummary).toContain('Blobs: 16');
    expect(allowlistSummary).toContain('Blobs selected: 14');
    expect(allowlistSummary).toContain('Blobs not_selected: 2');
    expect(allowlistSummary).not.toContain('fixture-bucket');
  });

  it('verifies a valid archive and rejects metadata, digest, and size tampering', async () => {
    const dir = await makeTempDir('rails-verify-offline-');
    const { archivePath, manifest } = await writeSyntheticArchive(dir);

    await expect(
      verifyCapturedArchive(archivePath, manifest)
    ).resolves.toBeUndefined();

    await expect(
      verifyCapturedArchive(archivePath, {
        ...manifest,
        archive: { ...manifest.archive, byteSize: '999999' },
      })
    ).rejects.toThrow(/archive size mismatch/i);

    await expect(
      verifyCapturedArchive(archivePath, {
        ...manifest,
        archive: { ...manifest.archive, sha256: '0'.repeat(64) },
      })
    ).rejects.toThrow(/archive sha-256 digest mismatch/i);

    await expect(
      verifyCapturedArchive(archivePath, {
        ...manifest,
        source: {
          ...manifest.source,
          observedSchemaVersion: RAILS_MIGRATION_VERSION_2025,
        },
      })
    ).rejects.toThrow(/source metadata does not match manifest/i);

    await expect(
      verifyCapturedArchive(archivePath, {
        ...manifest,
        tables: {
          ...manifest.tables,
          extra_table: manifest.tables.communities!,
        },
        totals: { ...manifest.totals, tables: 2 },
      })
    ).rejects.toThrow(/table inventory does not match manifest/i);

    const db = new Database(archivePath);
    db.prepare(
      `UPDATE source_rows SET row_json = '{"tampered":true}' WHERE table_name = 'communities'`
    ).run();
    db.close();

    const tamperedBytes = await readFile(archivePath);
    const tamperedManifest: RailsCaptureManifest = {
      ...manifest,
      archive: {
        ...manifest.archive,
        byteSize: String(tamperedBytes.length),
        sha256: createHash('sha256').update(tamperedBytes).digest('hex'),
      },
    };
    await expect(
      verifyCapturedArchive(archivePath, tamperedManifest)
    ).rejects.toThrow(/row digest mismatch/i);
  });
});

describe('Rails fixture integrity', () => {
  it('ships valid DiskService blobs matching data.sql and edge-data.sql checksums', async () => {
    const dataSql = await readFile(join(fixtureDir, 'data.sql'), 'utf8');
    const edgeDataSql = await readFile(
      join(fixtureDir, 'edge-data.sql'),
      'utf8'
    );
    const combinedSql = `${dataSql}\n${edgeDataSql}`;
    const blobMatches = [
      ...combinedSql.matchAll(
        /\(\d+,\s*'([a-z0-9]+)',\s*'[^']+',\s*'[^']+',\s*'[^']+',\s*(\d+),\s*'([^']+)',/g
      ),
    ];

    expect(blobMatches).toHaveLength(16);
    for (const [, key, sizeText, expectedMd5] of blobMatches) {
      const resolved = await resolveActiveStorageBlobPath(
        join(fixtureDir, 'blobs'),
        key!
      );
      const bytes = await readFile(resolved);
      expect(String(bytes.length)).toBe(sizeText);
      expect(createHash('md5').update(bytes).digest('base64')).toBe(
        expectedMd5
      );
    }
  });

  it('ships dual schema provenance files and bcrypt pattern edge cases', async () => {
    const schema2025Rb = await readFile(
      join(fixtureDir, 'schema-2025_11_20.rb'),
      'utf8'
    );
    const deltaSql = await readFile(
      join(fixtureDir, 'schema-2025_11_20.delta.sql'),
      'utf8'
    );
    const dataSql = await readFile(join(fixtureDir, 'data.sql'), 'utf8');
    const edgeSql = await readFile(join(fixtureDir, 'edge-data.sql'), 'utf8');

    expect(schema2025Rb).toContain('version: 2025_11_20_170000');
    expect(schema2025Rb).toContain('t.boolean "expose_mapbox_credentials"');
    expect(deltaSql).toContain('ADD COLUMN expose_mapbox_credentials boolean');
    expect(deltaSql).toContain("'20251120170000'");

    const validHashes = [
      ...dataSql.matchAll(/'(\$2[aby]\$\d{2}\$[^']+)'/g),
    ].map((match) => match[1]!);
    expect(validHashes.length).toBeGreaterThanOrEqual(6);
    for (const hash of validHashes) {
      expect(BCRYPT_HASH_PATTERN.test(hash)).toBe(true);
    }

    expect(edgeSql).toContain("'$2x$10$");
    expect(edgeSql).toContain("'$2a$15$");
    const malformed = [...edgeSql.matchAll(/'(\$2[ax]\$[^']+)'/g)]
      .map((match) => match[1]!)
      .filter(
        (hash) =>
          hash.startsWith('$2x$') ||
          hash.startsWith('$2a$15$') ||
          hash.length < 60
      );
    expect(malformed).toHaveLength(3);
    for (const bad of malformed) {
      expect(BCRYPT_HASH_PATTERN.test(bad)).toBe(false);
    }
  });
});

describe('S3 SigV4 client and streaming verification', () => {
  it('resolves credentials strictly from environment variables and fails closed when missing', () => {
    expect(
      resolveS3CredentialsFromEnv({
        AWS_ACCESS_KEY_ID: 'fixture-s3-access-id',
        AWS_SECRET_ACCESS_KEY: 'fixture-s3-secret-value',
      })
    ).toEqual({
      accessKeyId: 'fixture-s3-access-id',
      secretAccessKey: 'fixture-s3-secret-value',
    });

    expect(
      resolveS3CredentialsFromEnv({
        AWS_ACCESS_KEY_ID: 'fixture-s3-access-id',
        AWS_SECRET_ACCESS_KEY: 'fixture-s3-secret-value',
        AWS_SESSION_TOKEN: 'fixture-session-token',
      })
    ).toEqual({
      accessKeyId: 'fixture-s3-access-id',
      secretAccessKey: 'fixture-s3-secret-value',
      sessionToken: 'fixture-session-token',
    });

    expect(() =>
      resolveS3CredentialsFromEnv({
        AWS_ACCESS_KEY_ID: 'fixture-only-id',
      })
    ).toThrow(/AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY/);
  });

  it('validates S3 config, normalizes prefixes, and rejects unsafe keys or prefixes', () => {
    expect(normalizeS3Prefix(undefined)).toBeNull();
    expect(normalizeS3Prefix('///')).toBeNull();
    expect(normalizeS3Prefix('/prod/blobs/')).toBe('prod/blobs');
    expect(() => normalizeS3Prefix('prod/../secret')).toThrow(
      /unsafe s3 prefix/i
    );
    expect(() => assertSafeActiveStorageKey('../evil')).toThrow(
      /unsafe ActiveStorage key/i
    );

    const vhost = validateS3Config({
      bucket: 'terrastories-demo',
      region: 'us-east-2',
    });
    expect(buildS3ObjectUrl(vhost, 'blobKey_1').toString()).toBe(
      'https://terrastories-demo.s3.us-east-2.amazonaws.com/blobKey_1'
    );

    const dotted = validateS3Config({
      bucket: 'terrastories.demo',
      region: 'us-east-2',
      prefix: '/media/',
    });
    expect(buildS3ObjectUrl(dotted, 'blobKey_1').toString()).toBe(
      'https://s3.us-east-2.amazonaws.com/terrastories.demo/media/blobKey_1'
    );

    expect(() =>
      validateS3Config({ bucket: 'Invalid_Bucket', region: 'us-east-2' })
    ).toThrow(/invalid s3 bucket/i);
    expect(() =>
      validateS3Config({ bucket: 'valid-bucket', region: 'us_east_2' })
    ).toThrow(/invalid s3 region/i);
  });

  it('computes deterministic AWS SigV4 GET headers with optional session token', () => {
    const url = new URL(
      'https://terrastories-demo.s3.us-east-2.amazonaws.com/blobKey01'
    );
    const headers = signS3GetRequest({
      url,
      region: 'us-east-2',
      credentials: {
        accessKeyId: 'fixture-s3-access-id',
        secretAccessKey: 'fixture-s3-secret-value',
        sessionToken: 'fixture-session-token',
      },
      now: new Date('2026-11-22T12:00:00.000Z'),
    });

    expect(headers['x-amz-date']).toBe('20261122T120000Z');
    expect(headers['x-amz-content-sha256']).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    );
    expect(headers['x-amz-security-token']).toBe('fixture-session-token');
    expect(headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=fixture-s3-access-id\/20261122\/us-east-2\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/
    );
  });

  it('downloads and verifies blobs from a SigV4 fake S3 server including prefix, retries, and concurrency', async () => {
    const dest = await makeTempDir('rails-s3-ok-');
    const payload = Buffer.from('fake-s3-stream-payload-01\n', 'utf8');
    const md5 = createHash('md5').update(payload).digest('base64');
    const expectedSha = createHash('sha256').update(payload).digest('hex');

    const credentials = {
      accessKeyId: 'fixture-s3-access-id',
      secretAccessKey: 'fixture-s3-secret-value',
      sessionToken: 'fixture-session-token',
    };

    const server = await startFakeS3Server({
      expectedCredentials: { ...credentials, region: 'us-east-2' },
      onGetObject: async (objectKey, attempt) => {
        if (objectKey === 'prefix/retryblob01' && attempt < 3) {
          return { kind: 'status', status: 503, body: 'SlowDown' };
        }
        await new Promise((resolve) => setTimeout(resolve, 15));
        return { kind: 'ok', body: payload };
      },
    });
    fakeServers.push(server);

    const downloaded = await verifyAndDownloadS3Blob({
      s3: {
        bucket: 'fixture-bucket',
        region: 'us-east-2',
        prefix: '/prefix/',
        endpoint: server.endpoint,
        maxAttempts: 4,
        retryBaseDelayMs: 5,
      },
      credentials,
      destinationRoot: dest,
      id: '1',
      key: 'retryblob01',
      filename: 'retry.txt',
      contentType: 'text/plain',
      byteSize: String(payload.length),
      checksum: md5,
      serviceName: 'amazon',
    });

    expect(downloaded).toEqual({
      disposition: 'captured',
      id: '1',
      key: 'retryblob01',
      filename: 'retry.txt',
      contentType: 'text/plain',
      byteSize: String(payload.length),
      railsChecksum: md5,
      sha256: expectedSha,
      serviceName: 'amazon',
    });
    expect(server.getAttemptCount('prefix/retryblob01')).toBe(3);
    expect((await stat(join(dest, 'retryblob01'))).mode & 0o777).toBe(0o600);

    const keys = Array.from(
      { length: 10 },
      (_, idx) => `concblob${String(idx).padStart(2, '0')}`
    );
    const results = await mapWithConcurrency(keys, 4, (key, signal) =>
      verifyAndDownloadS3Blob({
        s3: {
          bucket: 'fixture-bucket',
          region: 'us-east-2',
          prefix: 'prefix',
          endpoint: server.endpoint,
          retryBaseDelayMs: 5,
        },
        credentials,
        destinationRoot: dest,
        id: key,
        key,
        filename: `${key}.txt`,
        contentType: 'text/plain',
        byteSize: String(payload.length),
        checksum: md5,
        serviceName: 'amazon',
        signal,
      })
    );
    expect(results.map((entry) => entry.key)).toEqual(keys);
    expect(server.getMaxInFlight()).toBeLessThanOrEqual(4);
    expect(server.getMaxInFlight()).toBeGreaterThanOrEqual(2);
  });

  it('fails closed on fake S3 404 missing, checksum mismatch, and size mismatch without leaving part files', async () => {
    const dest = await makeTempDir('rails-s3-neg-');
    const payload = Buffer.from('expected-s3-bytes', 'utf8');
    const md5 = createHash('md5').update(payload).digest('base64');
    const credentials = {
      accessKeyId: 'fixture-s3-access-id',
      secretAccessKey: 'fixture-s3-secret-value',
    };

    const server = await startFakeS3Server({
      expectedCredentials: { ...credentials, region: 'us-east-2' },
      onGetObject: (objectKey) => {
        if (objectKey === 'missingkey01') {
          return { kind: 'status', status: 404, body: 'NoSuchKey' };
        }
        if (objectKey === 'badsumkey01') {
          const tampered = Buffer.from(payload);
          tampered[0] = tampered[0]! ^ 0x01;
          return { kind: 'ok', body: tampered };
        }
        if (objectKey === 'shortkey01') {
          return { kind: 'ok', body: payload.subarray(0, 5) };
        }
        if (objectKey === 'longkey01') {
          return {
            kind: 'custom',
            handle: (_req, res) => {
              res.statusCode = 200;
              res.end(Buffer.concat([payload, Buffer.from('extra')]));
            },
          };
        }
        return { kind: 'status', status: 503 };
      },
    });
    fakeServers.push(server);

    const s3 = {
      bucket: 'fixture-bucket',
      region: 'us-east-2',
      endpoint: server.endpoint,
      maxAttempts: 3,
      retryBaseDelayMs: 5,
    };

    await expect(
      verifyAndDownloadS3Blob({
        s3,
        credentials,
        destinationRoot: dest,
        id: '1',
        key: 'missingkey01',
        filename: 'missing.bin',
        contentType: null,
        byteSize: String(payload.length),
        checksum: md5,
        serviceName: 'amazon',
      })
    ).rejects.toThrow(/missing ActiveStorage blob bytes in S3.*404/i);
    expect(server.getAttemptCount('missingkey01')).toBe(1);

    await expect(
      verifyAndDownloadS3Blob({
        s3,
        credentials,
        destinationRoot: dest,
        id: '2',
        key: 'badsumkey01',
        filename: 'badsum.bin',
        contentType: null,
        byteSize: String(payload.length),
        checksum: md5,
        serviceName: 'amazon',
      })
    ).rejects.toThrow(/checksum mismatch/i);
    expect(server.getAttemptCount('badsumkey01')).toBe(1);

    await expect(
      verifyAndDownloadS3Blob({
        s3,
        credentials,
        destinationRoot: dest,
        id: '3',
        key: 'shortkey01',
        filename: 'short.bin',
        contentType: null,
        byteSize: String(payload.length),
        checksum: md5,
        serviceName: 'amazon',
      })
    ).rejects.toThrow(/size mismatch/i);

    await expect(
      verifyAndDownloadS3Blob({
        s3,
        credentials,
        destinationRoot: dest,
        id: '4',
        key: 'longkey01',
        filename: 'long.bin',
        contentType: null,
        byteSize: String(payload.length),
        checksum: md5,
        serviceName: 'amazon',
      })
    ).rejects.toThrow(/size mismatch/i);

    const { readdir } = await import('node:fs/promises');
    expect(await readdir(dest)).toEqual([]);
  });
});

describe('migrate-rails CLI argument parsing', () => {
  it('supports disk and s3 blob sources plus repeatable --community flags and fails closed on conflicts', () => {
    expect(parseCliArgs(['--help'])).toEqual({ help: true });

    const s3Parsed = parseCliArgs([
      '--source',
      'postgresql://postgres@127.0.0.1:5432/rails',
      '--output',
      '/tmp/out',
      '--blob-source',
      's3',
      '--s3-bucket',
      'terrastories-demo',
      '--s3-region',
      'us-east-2',
      '--s3-prefix',
      'prod',
      '--blob-concurrency',
      '8',
      '--community',
      '10',
      '--community',
      'sierra_alta',
    ]);
    expect(s3Parsed).toEqual({
      help: false,
      sourceUrl: 'postgresql://postgres@127.0.0.1:5432/rails',
      outputDir: '/tmp/out',
      blobSource: {
        kind: 's3',
        bucket: 'terrastories-demo',
        region: 'us-east-2',
        prefix: 'prod',
      },
      blobConcurrency: 8,
      communities: ['10', 'sierra_alta'],
    });

    expect(() =>
      parseCliArgs([
        '--source',
        'postgresql://postgres@127.0.0.1:5432/rails',
        '--output',
        '/tmp/out',
        '--blob-source',
        's3',
      ])
    ).toThrow(/--s3-bucket is required/);

    expect(() =>
      parseCliArgs([
        '--source',
        'postgresql://postgres@127.0.0.1:5432/rails',
        '--output',
        '/tmp/out',
        '--blob-source',
        's3',
        '--s3-bucket',
        'b',
        '--s3-region',
        'us-east-2',
        '--blob-root',
        '/tmp/blobs',
      ])
    ).toThrow(/--blob-root cannot be combined/);

    expect(() =>
      parseCliArgs([
        '--source',
        'postgresql://postgres@127.0.0.1:5432/rails',
        '--output',
        '/tmp/out',
        '--s3-bucket',
        'b',
      ])
    ).toThrow(/--s3-\* options require --blob-source s3/);

    expect(() =>
      parseCliArgs([
        '--source',
        'postgresql://postgres@127.0.0.1:5432/rails',
        '--output',
        '/tmp/out',
        '--aws-secret-access-key',
        'nope',
      ])
    ).toThrow(/Unknown argument/);
  });
});
