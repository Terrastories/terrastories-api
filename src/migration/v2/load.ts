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
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { fsyncPath } from '../rails/fsync.js';
import { sha256OfFile, MEDIA_DIRECTORY } from './media.js';
import { V2_DATABASE_FILENAME, type TransformManifest } from './transform.js';

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

async function copyExclusive(
  source: string,
  destination: string,
  expected: { sha256: string; size: number }
): Promise<void> {
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await copyFile(source, destination, 1 /* COPYFILE_EXCL */);
  await fsyncPath(destination);
  const written = await sha256OfFile(destination);
  if (written.sha256 !== expected.sha256 || written.size !== expected.size) {
    throw new Error('A copied file failed SHA-256 verification');
  }
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
  for (const object of objects) {
    if (present.has(object.storageKey)) continue;
    await copyExclusive(
      join(dir, MEDIA_DIRECTORY, object.storageKey),
      join(storageRoot, object.storageKey),
      { sha256: object.sha256, size: object.byteSize }
    );
  }
  // Database last: it never references a missing object.
  const source = join(dir, V2_DATABASE_FILENAME);
  const digest = await sha256OfFile(source);
  const temporary = target + '.loading';
  await copyExclusive(source, temporary, digest);
  await rename(temporary, target);
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

async function loadD1(
  options: LoadOptions,
  objects: MediaObject[]
): Promise<LoadReport> {
  if (!options.sqlOut) throw new Error('--sql-out is required for d1');
  const dir = resolve(options.transformDir);
  const out = resolve(options.sqlOut);
  const fileLimit = options.maxFileBytes ?? D1_DEFAULT_FILE_BYTES;
  const database = new Database(join(dir, V2_DATABASE_FILENAME), {
    readonly: true,
    fileMustExist: true,
  });
  const files: Array<{ name: string; text: string }> = [];
  let tables = 0;
  let rows = 0;
  try {
    const header = 'PRAGMA defer_foreign_keys = true;\n';
    let sequence = 0;
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
      let text = header;
      const flush = (): void => {
        if (text === header) return;
        sequence += 1;
        files.push({
          name: String(sequence).padStart(4, '0') + '-' + table + '.sql',
          text,
        });
        text = header;
      };
      for (const sql of statements) {
        if (
          text !== header &&
          Buffer.byteLength(text) + Buffer.byteLength(sql) > fileLimit
        ) {
          flush();
        }
        text += sql;
      }
      flush();
    }
    const sequences = database
      .prepare('SELECT name, seq FROM sqlite_sequence ORDER BY name')
      .all() as Array<{ name: string; seq: number }>;
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
      sequence += 1;
      files.push({
        name: String(sequence).padStart(4, '0') + '-sqlite-sequence.sql',
        text,
      });
    }
  } finally {
    database.close();
  }

  const report: LoadReport = {
    target: 'd1',
    dryRun: options.dryRun === true,
    objects: objects.length,
    bytes: objects.reduce((sum, o) => sum + o.byteSize, 0),
    tables,
    rows,
    sqlFiles: files.length,
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
  for (const file of files) {
    await writeFile(join(out, file.name), file.text, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
  }
  await writeFile(
    join(out, 'r2-upload-manifest.json'),
    JSON.stringify(buildR2Manifest(objects), null, 2) + '\n',
    { encoding: 'utf8', mode: 0o600, flag: 'wx' }
  );
  await writeFile(
    join(out, 'd1-import.json'),
    JSON.stringify(
      {
        formatVersion: 1,
        note: 'Apply the V2 migrations first, then run each file in order: wrangler d1 execute <database> --remote --file <file>. The sequences file is optional if the target rejects sqlite_sequence writes.',
        files: files.map((f) => f.name),
      },
      null,
      2
    ) + '\n',
    { encoding: 'utf8', mode: 0o600, flag: 'wx' }
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

/** AWS Signature Version 4 for an R2/S3 object request. */
export function signR2Request(input: {
  method: 'PUT' | 'HEAD';
  endpoint: string;
  bucket: string;
  key: string;
  accessKeyId: string;
  secretAccessKey: string;
  payloadSha256: string;
  extraHeaders?: Record<string, string>;
  now?: Date;
}): SignedRequest {
  const url = new URL(input.endpoint);
  const path = encodeKeyPath(input.bucket, input.key);
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
    .map((n) => n + ':' + headers[n]!.trim() + '\n')
    .join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [
    input.method,
    path,
    '',
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
    url: url.origin + path,
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
  };
  const credentials = r2Credentials(options.env ?? process.env);
  if (options.dryRun) return report;
  const bucket = options.bucket;
  const endpoint =
    options.endpoint ??
    'https://' + credentials.accountId + '.r2.cloudflarestorage.com';
  const doFetch = options.fetchImpl ?? fetch;
  const dir = resolve(options.transformDir);

  const head = async (object: MediaObject): Promise<'match' | 'absent'> => {
    const signed = signR2Request({
      method: 'HEAD',
      endpoint,
      bucket,
      key: object.storageKey,
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      payloadSha256: sha256Text(''),
    });
    const response = await doFetch(signed.url, {
      method: 'HEAD',
      headers: signed.headers,
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

  const upload = async (object: MediaObject): Promise<void> => {
    if ((await head(object)) === 'match') {
      report.alreadyPresent = (report.alreadyPresent ?? 0) + 1;
      return;
    }
    const body = await readFile(join(dir, MEDIA_DIRECTORY, object.storageKey));
    if (
      body.length !== object.byteSize ||
      createHash('sha256').update(body).digest('hex') !== object.sha256
    ) {
      throw new Error('A media object changed before upload');
    }
    const signed = signR2Request({
      method: 'PUT',
      endpoint,
      bucket,
      key: object.storageKey,
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      payloadSha256: object.sha256,
      extraHeaders: {
        'content-type': object.mimeType,
        'x-amz-meta-sha256': object.sha256,
        'x-amz-checksum-sha256': Buffer.from(object.sha256, 'hex').toString(
          'base64'
        ),
      },
    });
    const response = await doFetch(signed.url, {
      method: 'PUT',
      headers: signed.headers,
      body,
    });
    if (!response.ok) {
      throw new Error('R2 PUT failed with status ' + response.status);
    }
    if ((await head(object)) !== 'match') {
      throw new Error('R2 object is missing after upload');
    }
    report.uploaded = (report.uploaded ?? 0) + 1;
  };

  const queue = [...objects];
  const workers = Array.from(
    { length: Math.max(1, Math.min(options.concurrency ?? 4, 16)) },
    async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        await upload(next);
      }
    }
  );
  const results = await Promise.allSettled(workers);
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
