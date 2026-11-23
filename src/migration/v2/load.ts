/**
 * Load a verified Stage-2 transform output into a V2 runtime target
 * (SPEC-V2 10.4). Three targets share one pre-flight that re-verifies every
 * media object against the manifest ledger and the files table:
 *
 *   node-sqlite  copy v2.sqlite + v2-media into a data directory / storage
 *                root (objects first, database last; never overwrites)
 *   d1           write a data-only, FK-ordered, chunked SQL dump for
 *                "wrangler d1 execute --file" plus an R2 upload manifest
 *   r2           upload each object to R2 over the S3-compatible API (SigV4,
 *                credentials from the environment only) and verify it by HEAD
 *
 * No credentials are accepted on the command line or written anywhere, and
 * reports contain counts only.
 */
import { createHash, createHmac } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  copyFile,
  mkdir,
  readFile,
  link,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import Database from 'better-sqlite3';
import { fsyncPath } from '../rails/fsync.js';
import { sha256OfFile, MEDIA_DIRECTORY } from './media.js';
import { V2_DATABASE_FILENAME, type TransformManifest } from './transform.js';

type BodyInit = NonNullable<RequestInit['body']>;

export type LoadTarget = 'node-sqlite' | 'd1' | 'r2';

export interface LoadOptions {
  transformDir: string;
  target: LoadTarget;
  dryRun?: boolean;
  /** node-sqlite: directory that receives v2.sqlite. */
  dataDir?: string;
  /** node-sqlite: storage root that receives the media objects. */
  storageRoot?: string;
  /** d1: output directory for the SQL dump and the R2 manifest. */
  sqlOut?: string;
  /** d1: soft limit for one SQL file (default 1 MiB). */
  maxFileBytes?: number;
  /** r2: bucket name. */
  bucket?: string;
  /** r2: endpoint override (tests); default https://<account>.r2.cloudflarestorage.com */
  endpoint?: string;
  /** r2: parallel uploads (default 4). */
  concurrency?: number;
  /** r2: objects larger than this use multipart upload (default 100 MiB). */
  multipartThresholdBytes?: number;
  /** r2: multipart part size (default 64 MiB; raised to stay under 10000 parts). */
  partSizeBytes?: number;
  /** r2: retry policy for 5xx, 429 and network errors (per request). */
  retry?: { maxAttempts?: number; baseDelayMs?: number };
  /** Test seam replacing the backoff sleep. */
  sleepImpl?: (ms: number) => Promise<void>;
  /** d1: proceed although the estimated rows written exceed the Free daily budget. */
  allowOverBudget?: boolean;
  /** Test seam: rows-written budget (default D1_FREE_DAILY_ROWS_WRITTEN). */
  rowBudget?: number;
  /** Environment source for R2 credentials (default process.env). */
  env?: Record<string, string | undefined>;
  /** Test seam replacing fetch. */
  fetchImpl?: typeof fetch;
}

export interface LoadReport {
  target: LoadTarget;
  dryRun: boolean;
  objects: number;
  bytes: number;
  tables?: number;
  rows?: number;
  sqlFiles?: number;
  uploaded?: number;
  alreadyPresent?: number;
  /** r2: objects sent through multipart upload. */
  multipart?: number;
  /** r2: highest number of request body bytes in flight at once. */
  peakBytesInFlight?: number;
  /** d1: rows written estimate (rows plus index entries plus ledger). */
  estimatedRowsWritten?: number;
  /** Human-readable next steps and warnings; never contain secrets. */
  instructions?: string[];
  warnings?: string[];
}

export interface MediaObject {
  fileId: string;
  storageKey: string;
  sha256: string;
  byteSize: number;
  mimeType: string;
}

/** D1 rejects statements over 100,000 bytes; stay below it. */
export const D1_MAX_STATEMENT_BYTES = 90_000;
const D1_DEFAULT_FILE_BYTES = 1024 * 1024;
/** Workers Free plan: 100,000 D1 rows written per day. */
export const D1_FREE_DAILY_ROWS_WRITTEN = 100_000;
export const D1_LEDGER_TABLE = '_rails_migration_load';
export const R2_MULTIPART_THRESHOLD_BYTES = 100 * 1024 * 1024;
export const R2_PART_SIZE_BYTES = 64 * 1024 * 1024;
const R2_MAX_PARTS = 10_000;

async function readManifest(dir: string): Promise<TransformManifest> {
  let text: string;
  try {
    text = await readFile(join(dir, 'manifest.json'), 'utf8');
  } catch {
    throw new Error('Transform output manifest.json is missing or unreadable');
  }
  const manifest = JSON.parse(text) as TransformManifest;
  if (manifest?.formatVersion !== 1 || !Array.isArray(manifest.media?.blobs)) {
    throw new Error('Not a supported Stage-2 transform output manifest');
  }
  return manifest;
}

/**
 * Re-verify the output before touching any target: the files table, the
 * manifest ledger and every object's size and SHA-256 must agree.
 */
export async function verifyTransformOutput(
  dir: string
): Promise<{ manifest: TransformManifest; objects: MediaObject[] }> {
  const manifest = await readManifest(dir);
  const database = new Database(join(dir, V2_DATABASE_FILENAME), {
    readonly: true,
    fileMustExist: true,
  });
  let objects: MediaObject[];
  try {
    objects = (
      database
        .prepare(
          'SELECT id, storage_key, checksum, byte_size, mime_type FROM files ORDER BY storage_key'
        )
        .all() as Array<{
        id: string;
        storage_key: string | null;
        checksum: string | null;
        byte_size: number | null;
        mime_type: string;
      }>
    ).map((row) => {
      if (!row.storage_key || !row.checksum || row.byte_size === null) {
        throw new Error('A files row has no storage key, checksum or size');
      }
      return {
        fileId: row.id,
        storageKey: row.storage_key,
        sha256: row.checksum,
        byteSize: row.byte_size,
        mimeType: row.mime_type,
      };
    });
  } finally {
    database.close();
  }

  const ledger = new Map<string, string>();
  for (const entry of manifest.media.blobs) {
    for (const destination of entry.destinations) {
      ledger.set(destination.fileId, entry.sha256 ?? '');
    }
  }
  if (ledger.size !== objects.length) {
    throw new Error('Manifest ledger and files table disagree on file count');
  }
  for (const object of objects) {
    if (ledger.get(object.fileId) !== object.sha256) {
      throw new Error('Manifest ledger and files table disagree on a checksum');
    }
    const path = join(dir, MEDIA_DIRECTORY, object.storageKey);
    let info;
    try {
      info = await stat(path);
    } catch {
      throw new Error('A media object is missing from the transform output');
    }
    if (info.size !== object.byteSize) {
      throw new Error('A media object has the wrong size');
    }
    const digest = await sha256OfFile(path);
    if (digest.sha256 !== object.sha256) {
      throw new Error('A media object failed SHA-256 verification');
    }
  }
  return { manifest, objects };
}

// ---- node-sqlite ------------------------------------------------------------

/**
 * Copy through a "<destination>.loading" temporary, verify it, then rename.
 * A stale temporary from an interrupted run is overwritten (only temporary
 * files are ever replaced); a final path therefore never holds a partial
 * object, and an existing final path is never overwritten.
 */
async function copyExclusive(
  source: string,
  destination: string,
  expected: { sha256: string; size: number },
  occupiedMessage = 'A different object already exists at a target key'
): Promise<void> {
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = destination + '.loading';
  await copyFile(source, temporary);
  await fsyncPath(temporary);
  const written = await sha256OfFile(temporary);
  if (written.sha256 !== expected.sha256 || written.size !== expected.size) {
    await unlink(temporary).catch(() => undefined);
    throw new Error('A copied file failed SHA-256 verification');
  }
  // Publish without ever replacing an existing target: link() fails with
  // EEXIST if the destination appeared meanwhile (a server may create the
  // database while media is copying). Filesystems without hard links fall back
  // to an existence check followed by rename.
  try {
    await link(temporary, destination);
    await unlink(temporary);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      await unlink(temporary).catch(() => undefined);
      throw new Error(occupiedMessage);
    }
    if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EXDEV') {
      throw error;
    }
  }
  const occupied = await stat(destination).then(
    () => true,
    () => false
  );
  if (occupied) {
    await unlink(temporary).catch(() => undefined);
    throw new Error(occupiedMessage);
  }
  await rename(temporary, destination);
}

async function loadNodeSqlite(
  options: LoadOptions,
  objects: MediaObject[]
): Promise<LoadReport> {
  if (!options.dataDir) {
    throw new Error('--data-dir is required for node-sqlite');
  }
  if (!options.storageRoot) {
    throw new Error('--storage-root is required for node-sqlite');
  }
  const dir = resolve(options.transformDir);
  const dataDir = resolve(options.dataDir);
  const storageRoot = resolve(options.storageRoot);
  const target = join(dataDir, V2_DATABASE_FILENAME);
  const report: LoadReport = {
    target: 'node-sqlite',
    dryRun: options.dryRun === true,
    objects: objects.length,
    bytes: objects.reduce((sum, o) => sum + o.byteSize, 0),
  };
  let exists = false;
  try {
    await stat(target);
    exists = true;
  } catch {
    // free
  }
  if (exists) {
    throw new Error('Refusing to overwrite an existing database at the target');
  }
  // Conflicting objects are detected before anything is written.
  const present = new Set<string>();
  for (const object of objects) {
    const destination = join(storageRoot, object.storageKey);
    try {
      const existing = await sha256OfFile(destination);
      if (existing.sha256 !== object.sha256) {
        throw new Error('A different object already exists at a target key');
      }
      present.add(object.storageKey);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  report.alreadyPresent = present.size;
  if (options.dryRun) return report;

  await mkdir(storageRoot, { recursive: true, mode: 0o700 });
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const touchedDirs = new Set<string>();
  for (const object of objects) {
    if (present.has(object.storageKey)) continue;
    const destination = join(storageRoot, object.storageKey);
    await copyExclusive(
      join(dir, MEDIA_DIRECTORY, object.storageKey),
      destination,
      { sha256: object.sha256, size: object.byteSize }
    );
    // Remember every directory whose entries changed, up to the storage root.
    for (
      let folder = dirname(destination);
      folder.length >= storageRoot.length;
      folder = dirname(folder)
    ) {
      touchedDirs.add(folder);
      if (folder === storageRoot) break;
    }
  }
  // Make the new directory entries durable before the database is published,
  // so a power loss cannot leave a database that references vanished media.
  for (const folder of [...touchedDirs].sort().reverse()) {
    await fsyncPath(folder);
  }
  // Database last: it never references a missing object.
  const source = join(dir, V2_DATABASE_FILENAME);
  const digest = await sha256OfFile(source);
  await copyExclusive(
    source,
    target,
    digest,
    'Refusing to overwrite an existing database at the target'
  );
  await fsyncPath(dataDir);
  return report;
}

// ---- d1 ---------------------------------------------------------------------

function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Non-finite number in row');
    return String(value);
  }
  if (Buffer.isBuffer(value)) return "X'" + value.toString('hex') + "'";
  if (typeof value === 'string') {
    if (value.includes(String.fromCharCode(0))) {
      throw new Error('NUL character in text value');
    }
    return "'" + value.replace(/'/g, "''") + "'";
  }
  throw new Error('Unsupported SQLite value type');
}

function quoteIdent(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}

/** Application tables, parents before children (foreign-key topological order). */
function orderedTables(database: Database.Database): string[] {
  const names = (
    database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%drizzle%' AND name NOT LIKE 'd1_%' ORDER BY name"
      )
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
  const parents = new Map<string, Set<string>>();
  for (const name of names) {
    const refs = database
      .prepare('PRAGMA foreign_key_list(' + quoteIdent(name) + ')')
      .all() as Array<{ table: string }>;
    parents.set(
      name,
      new Set(
        refs.map((r) => r.table).filter((t) => t !== name && names.includes(t))
      )
    );
  }
  const ordered: string[] = [];
  const visiting = new Set<string>();
  const visit = (name: string): void => {
    if (ordered.includes(name) || visiting.has(name)) return;
    visiting.add(name);
    for (const parent of [...(parents.get(name) ?? [])].sort()) visit(parent);
    visiting.delete(name);
    ordered.push(name);
  };
  for (const name of names) visit(name);
  return ordered;
}

export function buildR2Manifest(objects: MediaObject[]): {
  formatVersion: 1;
  objects: Array<{
    key: string;
    size: number;
    sha256: string;
    contentType: string;
  }>;
} {
  return {
    formatVersion: 1,
    objects: objects.map((o) => ({
      key: o.storageKey,
      size: o.byteSize,
      sha256: o.sha256,
      contentType: o.mimeType,
    })),
  };
}

const LEDGER_DDL =
  'CREATE TABLE IF NOT EXISTS ' +
  D1_LEDGER_TABLE +
  ' (file TEXT PRIMARY KEY NOT NULL, sha256 TEXT NOT NULL, applied_at INTEGER NOT NULL);\n';

function ledgerInsert(name: string, sha256: string): string {
  return (
    'INSERT INTO ' +
    D1_LEDGER_TABLE +
    ' (file, sha256, applied_at) VALUES (' +
    sqlLiteral(name) +
    ', ' +
    sqlLiteral(sha256) +
    ", CAST(strftime('%s', 'now') AS INTEGER) * 1000);\n"
  );
}

/** One assertion row: the INSERT violates a CHECK (and the file aborts) when the test is false. */
function assertion(table: string, name: string, test: string): string {
  return (
    'INSERT INTO ' +
    table +
    ' (check_name, ok) SELECT ' +
    sqlLiteral(name) +
    ', CASE WHEN ' +
    test +
    ' THEN 1 ELSE 0 END;\n'
  );
}

const CHECK_TABLE_DDL = (table: string): string =>
  'DROP TABLE IF EXISTS ' +
  table +
  ';\nCREATE TABLE ' +
  table +
  ' (check_name TEXT NOT NULL, ok INTEGER NOT NULL CHECK (ok = 1));\n';

function loadD1Instructions(
  files: string[],
  verify: string,
  wipe: string
): string[] {
  return [
    'Apply the V2 migrations to the target D1 first, then run each of these files in order: wrangler d1 execute <database> --remote --file <file>. First file: ' +
      (files[0] ?? '') +
      '; last file: ' +
      (files[files.length - 1] ?? '') +
      '.',
    'The first file refuses a target whose dump tables are not empty. Every file records itself as its last statement in ' +
      D1_LEDGER_TABLE +
      '; list applied files with: SELECT file FROM ' +
      D1_LEDGER_TABLE +
      ' ORDER BY file.',
    'If a file fails, it may have been partially applied. Do not re-run it: run ' +
      wipe +
      " (deletes only the rows this dump writes and drops the ledger; it fails without deleting anything unless the ledger shows this dump's preflight succeeded, so it never erases a target that was populated beforehand) and restart from the first file. If the preflight itself failed, nothing was written: fix the target instead.",
    'After the last file run ' +
      verify +
      ' with wrangler d1 execute; it fails when a row count, an applied file or a sqlite_sequence floor does not match.',
  ];
}

async function loadD1(
  options: LoadOptions,
  objects: MediaObject[]
): Promise<LoadReport> {
  // A dry run writes nothing, so it does not need an output directory.
  if (!options.sqlOut && !options.dryRun) {
    throw new Error('--sql-out is required for d1');
  }
  const dir = resolve(options.transformDir);
  const out = resolve(options.sqlOut ?? '.');
  const fileLimit = options.maxFileBytes ?? D1_DEFAULT_FILE_BYTES;
  // Room for the trailing ledger statement of each file.
  const LEDGER_RESERVE = 400;
  const database = new Database(join(dir, V2_DATABASE_FILENAME), {
    readonly: true,
    fileMustExist: true,
  });
  const bodies: Array<{ label: string; text: string }> = [];
  const writtenTables: Array<{ table: string; rows: number }> = [];
  let sequences: Array<{ name: string; seq: number }> = [];
  let tables = 0;
  let rows = 0;
  let indexEntries = 0;
  try {
    const header = 'PRAGMA defer_foreign_keys = true;\n';
    const indexCount = (table: string): number =>
      (
        database
          .prepare(
            "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND tbl_name = ?"
          )
          .get(table) as { n: number }
      ).n;
    for (const table of orderedTables(database)) {
      const columns = (
        database
          .prepare('PRAGMA table_info(' + quoteIdent(table) + ')')
          .all() as Array<{ name: string }>
      ).map((c) => c.name);
      const statement = database.prepare(
        'SELECT * FROM ' + quoteIdent(table) + ' ORDER BY rowid'
      );
      statement.safeIntegers(true);
      const prefix =
        'INSERT INTO ' +
        quoteIdent(table) +
        ' (' +
        columns.map(quoteIdent).join(', ') +
        ') VALUES\n';
      const prefixBytes = Buffer.byteLength(prefix);
      // Statements for this table; each table starts its own file(s) so a
      // failed chunk is easy to rerun.
      const statements: string[] = [];
      let pending: string[] = [];
      let pendingBytes = 0;
      let tableRows = 0;
      const emit = (): void => {
        if (pending.length === 0) return;
        statements.push(prefix + pending.join(',\n') + ';\n');
        pending = [];
        pendingBytes = 0;
      };
      for (const row of statement.iterate() as Iterable<
        Record<string, unknown>
      >) {
        const tuple =
          '(' + columns.map((c) => sqlLiteral(row[c])).join(', ') + ')';
        const tupleBytes = Buffer.byteLength(tuple) + 2;
        if (prefixBytes + tupleBytes > D1_MAX_STATEMENT_BYTES) {
          throw new Error(
            'A row in table ' + table + ' exceeds the D1 statement size limit'
          );
        }
        if (
          pending.length > 0 &&
          prefixBytes + pendingBytes + tupleBytes > D1_MAX_STATEMENT_BYTES
        ) {
          emit();
        }
        pending.push(tuple);
        pendingBytes += tupleBytes;
        tableRows += 1;
      }
      emit();
      if (tableRows === 0) continue;
      tables += 1;
      rows += tableRows;
      indexEntries += tableRows * indexCount(table);
      writtenTables.push({ table, rows: tableRows });
      let text = header;
      const flush = (): void => {
        if (text === header) return;
        bodies.push({ label: table, text });
        text = header;
      };
      for (const sql of statements) {
        if (
          text !== header &&
          Buffer.byteLength(text) + Buffer.byteLength(sql) + LEDGER_RESERVE >
            fileLimit
        ) {
          flush();
        }
        text += sql;
      }
      flush();
    }

    // sqlite_sequence is required: AUTOINCREMENT tables must not restart
    // below their highest id.
    sequences = database
      .prepare('SELECT name, seq FROM sqlite_sequence ORDER BY name')
      .all() as Array<{ name: string; seq: number }>;
    const autoincrement = (
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE '%AUTOINCREMENT%' ORDER BY name"
        )
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    for (const table of autoincrement) {
      const top = (
        database
          .prepare('SELECT MAX(rowid) AS top FROM ' + quoteIdent(table))
          .get() as { top: number | null }
      ).top;
      if (top === null) continue;
      const entry = sequences.find((s) => s.name === table);
      if (!entry || entry.seq < top) {
        throw new Error(
          'sqlite_sequence is missing or below the highest id for table ' +
            table
        );
      }
    }
    if (sequences.length > 0) {
      let text = '';
      for (const entry of sequences) {
        text +=
          'DELETE FROM sqlite_sequence WHERE name = ' +
          sqlLiteral(entry.name) +
          ';\nINSERT INTO sqlite_sequence (name, seq) VALUES (' +
          sqlLiteral(entry.name) +
          ', ' +
          String(entry.seq) +
          ');\n';
      }
      bodies.push({ label: 'sqlite-sequence', text });
    }
  } finally {
    database.close();
  }

  // Apply files: the preflight first, then data, each ending in its ledger row.
  const preflightName = '0000-preflight.sql';
  // Identifies this dump: wipe-and-retry only acts when the ledger holds the
  // preflight row of this exact dump.
  const dumpId = createHash('sha256')
    .update(
      JSON.stringify([
        writtenTables,
        sequences,
        bodies.map((b) => [b.label, b.text]),
      ]),
      'utf8'
    )
    .digest('hex');
  let preflight =
    '-- rails-migration-load dump ' +
    dumpId +
    '\n' +
    LEDGER_DDL +
    CHECK_TABLE_DDL('_rails_preflight') +
    assertion(
      '_rails_preflight',
      'ledger-empty',
      '(SELECT COUNT(*) FROM ' + D1_LEDGER_TABLE + ') = 0'
    );
  for (const { table } of writtenTables) {
    preflight += assertion(
      '_rails_preflight',
      'empty:' + table,
      '(SELECT COUNT(*) FROM ' + quoteIdent(table) + ') = 0'
    );
  }
  preflight += 'DROP TABLE _rails_preflight;\n';
  const files: Array<{ name: string; text: string }> = [
    {
      name: preflightName,
      text:
        preflight +
        ledgerInsert(
          preflightName,
          createHash('sha256').update(preflight, 'utf8').digest('hex')
        ),
    },
  ];
  const preflightSha = createHash('sha256')
    .update(preflight, 'utf8')
    .digest('hex');
  bodies.forEach((body, index) => {
    const name = String(index + 1).padStart(4, '0') + '-' + body.label + '.sql';
    files.push({
      name,
      text:
        body.text +
        ledgerInsert(
          name,
          createHash('sha256').update(body.text, 'utf8').digest('hex')
        ),
    });
  });

  let verify =
    CHECK_TABLE_DDL('_rails_verify') +
    assertion(
      '_rails_verify',
      'applied-files',
      '(SELECT COUNT(*) FROM ' + D1_LEDGER_TABLE + ') = ' + String(files.length)
    );
  for (const { table, rows: count } of writtenTables) {
    verify += assertion(
      '_rails_verify',
      'rows:' + table,
      '(SELECT COUNT(*) FROM ' + quoteIdent(table) + ') = ' + String(count)
    );
  }
  for (const entry of sequences) {
    verify += assertion(
      '_rails_verify',
      'sequence:' + entry.name,
      'COALESCE((SELECT seq FROM sqlite_sequence WHERE name = ' +
        sqlLiteral(entry.name) +
        '), -1) >= ' +
        String(entry.seq)
    );
  }
  verify += 'DROP TABLE _rails_verify;\n';

  // Guard first: fails (and deletes nothing) unless the ledger shows that the
  // preflight of THIS dump succeeded, so a pre-existing populated target, or
  // another dump's data, is never erased.
  let wipe =
    CHECK_TABLE_DDL('_rails_wipe_guard') +
    assertion(
      '_rails_wipe_guard',
      'this-dump-preflight-recorded',
      '(SELECT COUNT(*) FROM ' +
        D1_LEDGER_TABLE +
        ' WHERE file = ' +
        sqlLiteral(preflightName) +
        ' AND sha256 = ' +
        sqlLiteral(preflightSha) +
        ') = 1'
    ) +
    'DROP TABLE _rails_wipe_guard;\n' +
    'PRAGMA defer_foreign_keys = true;\n';
  for (const { table } of [...writtenTables].reverse()) {
    wipe += 'DELETE FROM ' + quoteIdent(table) + ';\n';
  }
  for (const entry of sequences) {
    wipe +=
      'DELETE FROM sqlite_sequence WHERE name = ' +
      sqlLiteral(entry.name) +
      ';\n';
  }
  wipe +=
    'DROP TABLE IF EXISTS _rails_preflight;\nDROP TABLE IF EXISTS _rails_wipe_guard;\nDROP TABLE IF EXISTS _rails_verify;\nDROP TABLE IF EXISTS ' +
    D1_LEDGER_TABLE +
    ';\n';
  const verifyName = 'verify.sql';
  const wipeName = 'wipe-and-retry.sql';

  const estimatedRowsWritten =
    rows + indexEntries + files.length + sequences.length * 2;
  const warnings: string[] = [];
  const rowBudget = options.rowBudget ?? D1_FREE_DAILY_ROWS_WRITTEN;
  const overBudget = estimatedRowsWritten > rowBudget;
  if (overBudget && !options.allowOverBudget) {
    const message =
      'Estimated D1 rows written (' +
      String(estimatedRowsWritten) +
      ') exceed the Workers Free budget of ' +
      String(rowBudget) +
      ' per day. Use a paid plan, or split the import over several days; pass --allow-over-budget to proceed anyway.';
    if (!options.dryRun) throw new Error(message);
    warnings.push(message);
  }

  const instructions = loadD1Instructions(
    files.map((f) => f.name),
    verifyName,
    wipeName
  );
  const report: LoadReport = {
    target: 'd1',
    dryRun: options.dryRun === true,
    objects: objects.length,
    bytes: objects.reduce((sum, o) => sum + o.byteSize, 0),
    tables,
    rows,
    sqlFiles: files.length,
    estimatedRowsWritten,
    instructions,
    warnings,
  };
  if (options.dryRun) return report;

  await mkdir(dirname(out), { recursive: true });
  try {
    await mkdir(out, { recursive: false, mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('Refusing to write into an existing --sql-out directory');
    }
    throw error;
  }
  const put = (name: string, text: string): Promise<void> =>
    writeFile(join(out, name), text, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
  for (const file of files) await put(file.name, file.text);
  await put(verifyName, verify);
  await put(wipeName, wipe);
  await put(
    'r2-upload-manifest.json',
    JSON.stringify(buildR2Manifest(objects), null, 2) + '\n'
  );
  await put(
    'd1-import.json',
    JSON.stringify(
      {
        formatVersion: 2,
        note: 'Apply the V2 migrations first, then run each file in order with wrangler d1 execute <database> --remote --file <file>.',
        files: files.map((f) => f.name),
        sequencesFileRequired: sequences.length > 0,
        verify: verifyName,
        wipeAndRetry: wipeName,
        ledgerTable: D1_LEDGER_TABLE,
        estimatedRowsWritten,
        instructions,
      },
      null,
      2
    ) + '\n'
  );
  for (const name of await readdir(out)) await fsyncPath(join(out, name));
  await fsyncPath(out);
  return report;
}

// ---- r2 ---------------------------------------------------------------------

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

function sha256Text(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

function encodeKeyPath(bucket: string, key: string): string {
  return (
    '/' +
    [bucket, ...key.split('/')]
      .map((segment) =>
        encodeURIComponent(segment).replace(
          /[!'()*]/g,
          (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
        )
      )
      .join('/')
  );
}

export interface SignedRequest {
  url: string;
  headers: Record<string, string>;
}

function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

/** SigV4 canonical header value: trimmed, internal whitespace collapsed. */
function canonicalHeaderValue(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

/** AWS Signature Version 4 for an R2/S3 object request. */
export function signR2Request(input: {
  method: 'PUT' | 'HEAD' | 'POST' | 'DELETE';
  endpoint: string;
  bucket: string;
  key: string;
  accessKeyId: string;
  secretAccessKey: string;
  payloadSha256: string;
  extraHeaders?: Record<string, string>;
  /** Query parameters (multipart: uploads, uploadId, partNumber). */
  query?: Record<string, string>;
  now?: Date;
}): SignedRequest {
  const url = new URL(input.endpoint);
  const path = encodeKeyPath(input.bucket, input.key);
  const queryPairs = Object.entries(input.query ?? {})
    .map(([k, v]) => [rfc3986(k), rfc3986(v)] as const)
    .sort((x, y) =>
      x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] < y[1] ? -1 : 1
    );
  const canonicalQuery = queryPairs.map(([k, v]) => k + '=' + v).join('&');
  const now = input.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    host: url.host,
    'x-amz-content-sha256': input.payloadSha256,
    'x-amz-date': amzDate,
    ...Object.fromEntries(
      Object.entries(input.extraHeaders ?? {}).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ])
    ),
  };
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names
    .map((n) => n + ':' + canonicalHeaderValue(headers[n]!) + '\n')
    .join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [
    input.method,
    path,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    input.payloadSha256,
  ].join('\n');
  const scope = dateStamp + '/auto/s3/aws4_request';
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256Text(canonicalRequest),
  ].join('\n');
  const kSigning = hmac(
    hmac(hmac(hmac('AWS4' + input.secretAccessKey, dateStamp), 'auto'), 's3'),
    'aws4_request'
  );
  const signature = hmac(kSigning, stringToSign).toString('hex');
  const sendable = Object.fromEntries(
    Object.entries(headers).filter(([name]) => name !== 'host')
  );
  return {
    url: url.origin + path + (canonicalQuery ? '?' + canonicalQuery : ''),
    headers: {
      ...sendable,
      authorization:
        'AWS4-HMAC-SHA256 Credential=' +
        input.accessKeyId +
        '/' +
        scope +
        ', SignedHeaders=' +
        signedHeaders +
        ', Signature=' +
        signature,
    },
  };
}

function r2Credentials(env: Record<string, string | undefined>): {
  accessKeyId: string;
  secretAccessKey: string;
  accountId: string;
} {
  const accessKeyId = env.R2_ACCESS_KEY_ID;
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY;
  const accountId = env.R2_ACCOUNT_ID;
  if (!accessKeyId || !secretAccessKey || !accountId) {
    throw new Error(
      'R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_ACCOUNT_ID must be set in the environment'
    );
  }
  return { accessKeyId, secretAccessKey, accountId };
}

/** Caps the request-body bytes concurrently in flight. */
class ByteBudget {
  private used = 0;
  peak = 0;
  private waiters: Array<() => void> = [];
  constructor(private readonly capacity: number) {}

  async acquire(bytes: number): Promise<number> {
    const want = Math.min(bytes, this.capacity);
    while (this.used + want > this.capacity) {
      await new Promise<void>((resolveWait) => this.waiters.push(resolveWait));
    }
    this.used += want;
    if (this.used > this.peak) this.peak = this.used;
    return want;
  }

  release(held: number): void {
    this.used -= held;
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

/** Streams a byte range of a file, feeding every chunk to a hash as it is sent. */
async function* tapped(
  path: string,
  start: number,
  end: number,
  tap: (chunk: Buffer) => void
): AsyncGenerator<Buffer> {
  for await (const chunk of createReadStream(path, { start, end })) {
    tap(chunk as Buffer);
    yield chunk as Buffer;
  }
}

async function loadR2(
  options: LoadOptions,
  objects: MediaObject[]
): Promise<LoadReport> {
  if (!options.bucket) throw new Error('--bucket is required for r2');
  const report: LoadReport = {
    target: 'r2',
    dryRun: options.dryRun === true,
    objects: objects.length,
    bytes: objects.reduce((sum, o) => sum + o.byteSize, 0),
    uploaded: 0,
    alreadyPresent: 0,
    multipart: 0,
    peakBytesInFlight: 0,
  };
  const credentials = r2Credentials(options.env ?? process.env);
  if (options.dryRun) return report;
  const bucket = options.bucket;
  const endpoint =
    options.endpoint ??
    'https://' + credentials.accountId + '.r2.cloudflarestorage.com';
  const doFetch = options.fetchImpl ?? fetch;
  const dir = resolve(options.transformDir);
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, 16));
  const threshold =
    options.multipartThresholdBytes ?? R2_MULTIPART_THRESHOLD_BYTES;
  const basePartSize = options.partSizeBytes ?? R2_PART_SIZE_BYTES;
  const maxAttempts = Math.max(1, options.retry?.maxAttempts ?? 5);
  const baseDelay = options.retry?.baseDelayMs ?? 250;
  const sleep =
    options.sleepImpl ??
    ((ms: number): Promise<void> =>
      new Promise((resolveSleep) => setTimeout(resolveSleep, ms)));
  const budget = new ByteBudget(
    Math.max(concurrency * basePartSize, threshold)
  );

  interface Call {
    method: 'PUT' | 'HEAD' | 'POST' | 'DELETE';
    key: string;
    payloadSha256: string;
    headers?: Record<string, string>;
    query?: Record<string, string>;
    /** Fresh body per attempt (streams cannot be replayed). */
    body?: () => BodyInit;
    contentLength?: number;
  }

  /**
   * One signed request with bounded exponential backoff on network errors,
   * 429, 408 and 5xx. Other statuses are returned for the caller to judge.
   * Messages never contain credentials, endpoints or keys.
   */
  const send = async (label: string, call: Call): Promise<Response> => {
    for (let attempt = 1; ; attempt += 1) {
      const signed = signR2Request({
        method: call.method,
        endpoint,
        bucket,
        key: call.key,
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
        payloadSha256: call.payloadSha256,
        ...(call.headers ? { extraHeaders: call.headers } : {}),
        ...(call.query ? { query: call.query } : {}),
      });
      const headers = { ...signed.headers };
      if (call.contentLength !== undefined) {
        headers['content-length'] = String(call.contentLength);
      }
      let response: Response | undefined;
      try {
        const init: RequestInit & { duplex?: 'half' } = {
          method: call.method,
          headers,
        };
        if (call.body) {
          init.body = call.body();
          init.duplex = 'half';
        }
        response = await doFetch(signed.url, init);
      } catch {
        response = undefined;
      }
      if (response && !isRetryableStatus(response.status)) return response;
      if (response) {
        await response.body?.cancel().catch(() => undefined);
      }
      if (attempt >= maxAttempts) {
        throw new Error(
          response
            ? 'R2 ' + label + ' failed with status ' + response.status
            : 'R2 ' +
              label +
              ' failed (network error after ' +
              String(attempt) +
              ' attempts)'
        );
      }
      await sleep(Math.min(baseDelay * 2 ** (attempt - 1), 8000));
    }
  };

  const head = async (object: MediaObject): Promise<'match' | 'absent'> => {
    const response = await send('HEAD', {
      method: 'HEAD',
      key: object.storageKey,
      payloadSha256: sha256Text(''),
    });
    if (response.status === 404) return 'absent';
    if (!response.ok) {
      throw new Error('R2 HEAD failed with status ' + response.status);
    }
    if (
      response.headers.get('content-length') !== String(object.byteSize) ||
      response.headers.get('x-amz-meta-sha256') !== object.sha256
    ) {
      throw new Error('R2 object verification failed (size or checksum)');
    }
    return 'match';
  };

  const objectHeaders = (object: MediaObject): Record<string, string> => ({
    'content-type': object.mimeType,
    'x-amz-meta-sha256': object.sha256,
  });

  const streamOf =
    (path: string, start?: number, end?: number) => (): BodyInit =>
      Readable.toWeb(
        createReadStream(
          path,
          start === undefined ? {} : { start, end: end as number }
        )
      ) as unknown as BodyInit;

  const putSingle = async (
    object: MediaObject,
    path: string
  ): Promise<void> => {
    const held = await budget.acquire(object.byteSize);
    try {
      const response = await send('PUT', {
        method: 'PUT',
        key: object.storageKey,
        payloadSha256: object.sha256,
        headers: {
          ...objectHeaders(object),
          'x-amz-checksum-sha256': Buffer.from(object.sha256, 'hex').toString(
            'base64'
          ),
        },
        body: streamOf(path),
        contentLength: object.byteSize,
      });
      if (!response.ok) {
        throw new Error('R2 PUT failed with status ' + response.status);
      }
    } finally {
      budget.release(held);
    }
  };

  const putMultipart = async (
    object: MediaObject,
    path: string
  ): Promise<void> => {
    const partSize = Math.max(
      basePartSize,
      Math.ceil(object.byteSize / R2_MAX_PARTS)
    );
    const created = await send('multipart create', {
      method: 'POST',
      key: object.storageKey,
      payloadSha256: sha256Text(''),
      headers: objectHeaders(object),
      query: { uploads: '' },
    });
    if (!created.ok) {
      throw new Error(
        'R2 multipart create failed with status ' + created.status
      );
    }
    const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(
      await created.text()
    )?.[1];
    if (!uploadId) throw new Error('R2 multipart create returned no upload id');
    try {
      const etags: string[] = [];
      const count = Math.ceil(object.byteSize / partSize);
      // SHA-256 of the bytes actually sent, in part order. A part attempt
      // hashes into a copy that is adopted only when the part succeeds, so a
      // retried part is never counted twice.
      let whole = createHash('sha256');
      let sentBytes = 0;
      for (let number = 1; number <= count; number += 1) {
        const start = (number - 1) * partSize;
        const end = Math.min(object.byteSize, start + partSize) - 1;
        const length = end - start + 1;
        const held = await budget.acquire(length);
        let attempt = whole;
        let attemptBytes = 0;
        try {
          const response = await send('multipart part', {
            method: 'PUT',
            key: object.storageKey,
            // The part hash is computed while streaming (below), never
            // trusted from an earlier read of a file that may have changed.
            payloadSha256: 'UNSIGNED-PAYLOAD',
            query: { partNumber: String(number), uploadId },
            body: () => {
              attempt = whole.copy();
              attemptBytes = 0;
              return Readable.toWeb(
                Readable.from(
                  tapped(path, start, end, (chunk) => {
                    attempt.update(chunk);
                    attemptBytes += chunk.length;
                  }),
                  { objectMode: false }
                )
              ) as unknown as BodyInit;
            },
            contentLength: length,
          });
          if (!response.ok) {
            throw new Error(
              'R2 multipart part failed with status ' + response.status
            );
          }
          const etag = response.headers.get('etag');
          if (!etag) throw new Error('R2 multipart part returned no ETag');
          if (attemptBytes !== length) {
            throw new Error('A media object changed during upload');
          }
          whole = attempt;
          sentBytes += attemptBytes;
          etags.push(etag);
        } finally {
          budget.release(held);
        }
      }
      // Verify what was streamed against the manifest before completing.
      if (
        sentBytes !== object.byteSize ||
        whole.digest('hex') !== object.sha256
      ) {
        throw new Error('A media object changed during upload');
      }
      const xml =
        '<CompleteMultipartUpload>' +
        etags
          .map(
            (etag, i) =>
              '<Part><PartNumber>' +
              String(i + 1) +
              '</PartNumber><ETag>' +
              etag.replace(/&/g, '&amp;').replace(/</g, '&lt;') +
              '</ETag></Part>'
          )
          .join('') +
        '</CompleteMultipartUpload>';
      const completed = await send('multipart complete', {
        method: 'POST',
        key: object.storageKey,
        payloadSha256: sha256Text(xml),
        headers: { 'content-type': 'application/xml' },
        query: { uploadId },
        body: () => xml,
        contentLength: Buffer.byteLength(xml),
      });
      if (completed.status === 404) {
        // A lost response to a first complete attempt makes the retry see
        // NoSuchUpload. Accept it only if the object exists with the expected
        // size and sha256 metadata (head throws on a diverged object).
        if ((await head(object)) !== 'match') {
          throw new Error('R2 multipart complete failed (upload not found)');
        }
      } else if (!completed.ok || /<Error>/.test(await completed.text())) {
        throw new Error('R2 multipart complete failed');
      }
    } catch (error) {
      // Best effort: free the parts of an abandoned upload.
      await send('multipart abort', {
        method: 'DELETE',
        key: object.storageKey,
        payloadSha256: sha256Text(''),
        query: { uploadId },
      }).catch(() => undefined);
      throw error;
    }
    report.multipart = (report.multipart ?? 0) + 1;
  };

  const upload = async (object: MediaObject): Promise<void> => {
    if ((await head(object)) === 'match') {
      report.alreadyPresent = (report.alreadyPresent ?? 0) + 1;
      return;
    }
    const path = join(dir, MEDIA_DIRECTORY, object.storageKey);
    const digest = await sha256OfFile(path);
    if (digest.size !== object.byteSize || digest.sha256 !== object.sha256) {
      throw new Error('A media object changed before upload');
    }
    if (object.byteSize > threshold) await putMultipart(object, path);
    else await putSingle(object, path);
    if ((await head(object)) !== 'match') {
      throw new Error('R2 object is missing after upload');
    }
    report.uploaded = (report.uploaded ?? 0) + 1;
  };

  const queue = [...objects];
  const workers = Array.from({ length: concurrency }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      await upload(next);
    }
  });
  const results = await Promise.allSettled(workers);
  report.peakBytesInFlight = budget.peak;
  const failed = results.find((r) => r.status === 'rejected');
  if (failed && failed.status === 'rejected') throw failed.reason;
  return report;
}

export async function loadTransformOutput(
  options: LoadOptions
): Promise<LoadReport> {
  const { objects } = await verifyTransformOutput(options.transformDir);
  switch (options.target) {
    case 'node-sqlite':
      return loadNodeSqlite(options, objects);
    case 'd1':
      return loadD1(options, objects);
    case 'r2':
      return loadR2(options, objects);
    default:
      throw new Error('Unknown load target');
  }
}
