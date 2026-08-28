import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { Pool, type PoolClient } from 'pg';
import {
  LEGACY_RAILS_COMMIT,
  RAILS_SCHEMA_VERSION,
  REQUIRED_RAILS_TABLES,
} from './contract.js';
import {
  type CapturedBlob,
  verifyAndCopyActiveStorageBlob,
} from './active-storage.js';

const PAGE_SIZE = 500;
const JSON_BUILD_OBJECT_COLUMN_CHUNK = 40;

interface SourceColumn {
  columnName: string;
  dataType: string;
  udtName: string;
  nullable: boolean;
  ordinal: number;
}

interface SourceTable {
  tableName: string;
  columns: SourceColumn[];
  primaryKey: string[];
}

export interface RailsCaptureManifest {
  formatVersion: 1;
  source: {
    legacyCommit: typeof LEGACY_RAILS_COMMIT;
    pinnedRailsSchemaVersion: typeof RAILS_SCHEMA_VERSION;
    observedSchemaVersion: string | null;
    schemaSha256: string;
  };
  tables: Record<
    string,
    {
      rowCount: number;
      rowSha256: string;
      primaryKey: string[];
      columns: SourceColumn[];
    }
  >;
  blobs: CapturedBlob[];
  totals: {
    tables: number;
    rows: number;
    blobs: number;
  };
}

export interface CaptureRailsOptions {
  sourceUrl: string;
  outputDir: string;
  blobRoot?: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function assertPathDoesNotExist(path: string): Promise<void> {
  try {
    await stat(path);
    throw new Error(`Migration destination already exists: ${path}`);
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return;
    }
    throw error;
  }
}

async function discoverTables(client: PoolClient): Promise<SourceTable[]> {
  const tableResult = await client.query<{ table_name: string }>(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);

  const tables: SourceTable[] = [];
  for (const { table_name: tableName } of tableResult.rows) {
    const [columnResult, primaryKeyResult] = await Promise.all([
      client.query<{
        column_name: string;
        data_type: string;
        udt_name: string;
        is_nullable: 'YES' | 'NO';
        ordinal_position: number;
      }>(
        `
          SELECT column_name, data_type, udt_name, is_nullable, ordinal_position
          FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1
          ORDER BY ordinal_position
        `,
        [tableName]
      ),
      client.query<{ column_name: string }>(
        `
          SELECT kcu.column_name
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
           AND tc.table_schema = kcu.table_schema
           AND tc.table_name = kcu.table_name
          WHERE tc.table_schema = 'public'
            AND tc.table_name = $1
            AND tc.constraint_type = 'PRIMARY KEY'
          ORDER BY kcu.ordinal_position
        `,
        [tableName]
      ),
    ]);

    tables.push({
      tableName,
      columns: columnResult.rows.map((column) => ({
        columnName: column.column_name,
        dataType: column.data_type,
        udtName: column.udt_name,
        nullable: column.is_nullable === 'YES',
        ordinal: column.ordinal_position,
      })),
      primaryKey: primaryKeyResult.rows.map((row) => row.column_name),
    });
  }

  return tables;
}

function validateRequiredRailsSchema(tables: SourceTable[]): void {
  const byName = new Map(tables.map((table) => [table.tableName, table]));

  for (const [tableName, requiredColumns] of Object.entries(
    REQUIRED_RAILS_TABLES
  )) {
    const table = byName.get(tableName);
    if (!table) {
      throw new Error(`Required Rails table is missing: ${tableName}`);
    }

    const actualColumns = new Set(
      table.columns.map((column) => column.columnName)
    );
    for (const columnName of requiredColumns) {
      if (!actualColumns.has(columnName)) {
        throw new Error(
          `Required Rails column is missing: ${tableName}.${columnName}`
        );
      }
    }
  }
}

async function readObservedSchemaVersion(
  client: PoolClient,
  tableNames: Set<string>
): Promise<string | null> {
  if (!tableNames.has('schema_migrations')) return null;
  const result = await client.query<{ version: string | null }>(
    `SELECT max(version)::text AS version FROM schema_migrations`
  );
  return result.rows[0]?.version ?? null;
}

function initializeArchive(path: string): Database.Database {
  const archive = new Database(path);
  archive.pragma('journal_mode = DELETE');
  archive.pragma('synchronous = FULL');
  archive.exec(`
    CREATE TABLE source_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE source_tables (
      table_name TEXT PRIMARY KEY,
      columns_json TEXT NOT NULL,
      primary_key_json TEXT NOT NULL,
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
  archive.pragma('foreign_keys = ON');
  return archive;
}

function buildRowJsonExpression(columns: SourceColumn[]): string {
  if (columns.length === 0) return `'{}'::jsonb`;

  const chunks: string[] = [];
  for (
    let offset = 0;
    offset < columns.length;
    offset += JSON_BUILD_OBJECT_COLUMN_CHUNK
  ) {
    const argumentsForChunk = columns
      .slice(offset, offset + JSON_BUILD_OBJECT_COLUMN_CHUNK)
      .flatMap((column) => [
        quoteLiteral(column.columnName),
        `${quoteIdentifier(column.columnName)}::text`,
      ])
      .join(', ');
    chunks.push(`jsonb_build_object(${argumentsForChunk})`);
  }

  return chunks.join(' || ');
}

function buildRowQuery(table: SourceTable): string {
  const rowJsonExpression = buildRowJsonExpression(table.columns);
  const orderColumns =
    table.primaryKey.length > 0
      ? table.primaryKey
      : table.columns.map((column) => column.columnName);
  const orderBy =
    orderColumns.length > 0
      ? ` ORDER BY ${orderColumns
          .map((column) => `${quoteIdentifier(column)}::text NULLS FIRST`)
          .join(', ')}`
      : '';

  return `SELECT (${rowJsonExpression})::text AS row_json FROM ${quoteIdentifier(
    table.tableName
  )}${orderBy} LIMIT $1 OFFSET $2`;
}

async function captureTable(
  client: PoolClient,
  archive: Database.Database,
  table: SourceTable
): Promise<{ rowCount: number; rowSha256: string }> {
  const countResult = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM ${quoteIdentifier(table.tableName)}`
  );
  const expectedCount = Number(countResult.rows[0]?.count ?? '0');
  if (!Number.isSafeInteger(expectedCount)) {
    throw new Error(`Unsafe row count for table ${table.tableName}`);
  }

  archive
    .prepare(
      `INSERT INTO source_tables(table_name, columns_json, primary_key_json, row_count, row_sha256)
       VALUES (?, ?, ?, ?, '')`
    )
    .run(
      table.tableName,
      JSON.stringify(table.columns),
      JSON.stringify(table.primaryKey),
      expectedCount
    );

  const insertRow = archive.prepare(
    `INSERT INTO source_rows(table_name, ordinal, row_json, row_sha256)
     VALUES (?, ?, ?, ?)`
  );
  const insertPage = archive.transaction(
    (rows: Array<{ ordinal: number; rowJson: string; digest: string }>) => {
      for (const row of rows) {
        insertRow.run(table.tableName, row.ordinal, row.rowJson, row.digest);
      }
    }
  );

  const tableHash = createHash('sha256');
  const query = buildRowQuery(table);
  let capturedCount = 0;

  for (let offset = 0; offset < expectedCount; offset += PAGE_SIZE) {
    const page = await client.query<{ row_json: string }>(query, [
      PAGE_SIZE,
      offset,
    ]);
    const rows = page.rows.map((row, index) => {
      const digest = sha256(row.row_json);
      tableHash.update(digest);
      return {
        ordinal: offset + index,
        rowJson: row.row_json,
        digest,
      };
    });
    insertPage(rows);
    capturedCount += rows.length;
  }

  if (capturedCount !== expectedCount) {
    throw new Error(
      `Row count changed while capturing ${table.tableName}: expected ${expectedCount}, captured ${capturedCount}`
    );
  }

  const rowSha256 = tableHash.digest('hex');
  archive
    .prepare(`UPDATE source_tables SET row_sha256 = ? WHERE table_name = ?`)
    .run(rowSha256, table.tableName);

  return { rowCount: capturedCount, rowSha256 };
}

async function captureBlobs(
  client: PoolClient,
  blobRoot: string | undefined,
  destinationRoot: string,
  tableNames: Set<string>
): Promise<CapturedBlob[]> {
  if (!tableNames.has('active_storage_blobs')) return [];

  const result = await client.query<{
    id: string;
    key: string;
    filename: string;
    content_type: string | null;
    byte_size: string;
    checksum: string | null;
    service_name: string;
  }>(`
    SELECT
      id::text,
      key,
      filename,
      content_type,
      byte_size::text,
      checksum,
      service_name
    FROM active_storage_blobs
    ORDER BY id
  `);

  if (result.rows.length > 0 && !blobRoot) {
    throw new Error(
      'ActiveStorage blobs exist but no blobRoot was supplied. Export/provide all blob bytes before migration.'
    );
  }

  const blobs: CapturedBlob[] = [];
  for (const blob of result.rows) {
    blobs.push(
      await verifyAndCopyActiveStorageBlob({
        blobRoot: blobRoot!,
        destinationRoot,
        id: blob.id,
        key: blob.key,
        filename: blob.filename,
        contentType: blob.content_type,
        byteSize: blob.byte_size,
        checksum: blob.checksum,
        serviceName: blob.service_name,
      })
    );
  }
  return blobs;
}

export async function captureRailsToBundle(
  options: CaptureRailsOptions
): Promise<RailsCaptureManifest> {
  await assertPathDoesNotExist(options.outputDir);
  await mkdir(dirname(options.outputDir), { recursive: true });

  const temporaryDir = `${options.outputDir}.tmp-${randomUUID()}`;
  await mkdir(temporaryDir, { recursive: false, mode: 0o700 });

  const archivePath = join(temporaryDir, 'legacy.sqlite');
  const pool = new Pool({ connectionString: options.sourceUrl, max: 1 });
  let client: PoolClient | null = null;
  let archive: Database.Database | null = null;
  let transactionOpen = false;

  try {
    client = await pool.connect();
    await client.query(
      'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'
    );
    transactionOpen = true;

    const tables = await discoverTables(client);
    validateRequiredRailsSchema(tables);
    const tableNames = new Set(tables.map((table) => table.tableName));
    const observedSchemaVersion = await readObservedSchemaVersion(
      client,
      tableNames
    );
    const schemaSha256 = sha256(JSON.stringify(tables));

    archive = initializeArchive(archivePath);
    archive
      .prepare(`INSERT INTO source_metadata(key, value) VALUES (?, ?)`)
      .run('legacy_commit', LEGACY_RAILS_COMMIT);
    archive
      .prepare(`INSERT INTO source_metadata(key, value) VALUES (?, ?)`)
      .run('pinned_rails_schema_version', RAILS_SCHEMA_VERSION);
    archive
      .prepare(`INSERT INTO source_metadata(key, value) VALUES (?, ?)`)
      .run('observed_schema_version', observedSchemaVersion ?? 'unknown');
    archive
      .prepare(`INSERT INTO source_metadata(key, value) VALUES (?, ?)`)
      .run('source_schema_sha256', schemaSha256);

    const manifestTables: RailsCaptureManifest['tables'] = {};
    let totalRows = 0;
    for (const table of tables) {
      const captured = await captureTable(client, archive, table);
      manifestTables[table.tableName] = {
        rowCount: captured.rowCount,
        rowSha256: captured.rowSha256,
        primaryKey: table.primaryKey,
        columns: table.columns,
      };
      totalRows += captured.rowCount;
    }

    const blobs = await captureBlobs(
      client,
      options.blobRoot,
      join(temporaryDir, 'blobs'),
      tableNames
    );

    const manifest: RailsCaptureManifest = {
      formatVersion: 1,
      source: {
        legacyCommit: LEGACY_RAILS_COMMIT,
        pinnedRailsSchemaVersion: RAILS_SCHEMA_VERSION,
        observedSchemaVersion,
        schemaSha256,
      },
      tables: manifestTables,
      blobs,
      totals: {
        tables: tables.length,
        rows: totalRows,
        blobs: blobs.length,
      },
    };

    archive.close();
    archive = null;
    await chmod(archivePath, 0o600);
    await writeFile(
      join(temporaryDir, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 }
    );

    await client.query('COMMIT');
    transactionOpen = false;
    await rename(temporaryDir, options.outputDir);
    return manifest;
  } catch (error) {
    archive?.close();
    if (transactionOpen && client) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the original migration failure.
      }
    }
    await rm(temporaryDir, { recursive: true, force: true });
    throw error;
  } finally {
    client?.release();
    await pool.end();
  }
}
