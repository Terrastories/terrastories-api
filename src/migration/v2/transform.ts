/**
 * Stage-2 orchestration: verified Stage-1 bundle -> canonical V2 SQLite output
 * directory (SPEC-V2 §10.2, §10.4, §10.5).
 *
 * Output (never overwritten; written to an owner-only temp dir then renamed):
 *   v2.sqlite              V2 SQLite migrations applied, canonical rows inserted
 *   legacy-archive.sqlite  every source row/field not represented canonically
 *   manifest.json          counts, dispositions, id remaps, warnings, checksums
 *   manual-review.json     MANUAL ids and codes (only with allowManual)
 *   validation-summary.txt counts only; no contents or secrets
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  mkdir,
  readdir,
  rename,
  rmdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { openVerifiedBundle } from './bundle-reader.js';
import { fsyncPath } from '../rails/fsync.js';
import { COLUMN_DISPOSITIONS } from './dispositions.js';
import {
  CANONICAL_TABLES,
  planTransform,
  type CanonicalRow,
  type CanonicalTable,
  type TransformPlan,
} from './plan.js';

export const TRANSFORM_FORMAT_VERSION = 1;
export const V2_DATABASE_FILENAME = 'v2.sqlite';
export const LEGACY_ARCHIVE_FILENAME = 'legacy-archive.sqlite';

export interface TransformRailsOptions {
  bundleDir: string;
  outputDir: string;
  communities?: string[];
  includeSystemUsers?: boolean;
  allowManual?: boolean;
}

export interface TransformManifest {
  formatVersion: 1;
  input: {
    bundleManifestSha256: string;
    archiveSha256: string;
    contractProfile: string;
    observedSchemaVersion: string;
    schemaSha256: string;
  };
  options: {
    communities: string[];
    includeSystemUsers: boolean;
    allowManual: boolean;
  };
  selection: TransformPlan['selection'];
  sourceCounts: Record<string, number>;
  dispositions: TransformPlan['statusCounts'];
  canonicalCounts: Record<string, number>;
  idRemaps: TransformPlan['idRemaps'];
  fieldDispositions: Record<string, Record<string, string>>;
  fieldEvents: Record<string, number>;
  warnings: TransformPlan['warnings'];
  manual: TransformPlan['manual'];
  pendingMedia: TransformPlan['pendingMedia'];
  flipper: TransformPlan['flipper'];
  unknownTables: string[];
  unregisteredColumns: string[];
  curriculumUseDetected: number;
  checksums: {
    canonicalRows: Record<string, string>;
    archivedRows: string;
    archivedFields: string;
  };
}

export class ManualReviewRequiredError extends Error {
  readonly items: TransformPlan['manual'];
  constructor(items: TransformPlan['manual']) {
    const lines = items.map(
      (item) => '  ' + item.table + '#' + item.id + ' ' + item.code
    );
    super(
      'Transform found ' +
        items.length +
        ' MANUAL item(s); resolve them or pass --allow-manual to exclude them:\n' +
        lines.join('\n')
    );
    this.name = 'ManualReviewRequiredError';
    this.items = items;
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const migrationsFolder = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'db',
  'migrations'
);

function insertRows(
  database: Database.Database,
  table: string,
  rows: CanonicalRow[]
): void {
  const first = rows[0];
  if (!first) return;
  const columns = Object.keys(first);
  const statement = database.prepare(
    'INSERT INTO ' +
      table +
      ' (' +
      columns.map((c) => '"' + c + '"').join(', ') +
      ') VALUES (' +
      columns.map((c) => '@' + c).join(', ') +
      ')'
  );
  for (const row of rows) statement.run(row);
}

function writeCanonicalDatabase(path: string, plan: TransformPlan): void {
  const database = new Database(path);
  try {
    database.pragma('journal_mode = DELETE');
    database.pragma('foreign_keys = ON');
    migrate(drizzle(database), { migrationsFolder });
    database.transaction(() => {
      for (const table of CANONICAL_TABLES) {
        insertRows(database, table, plan.canonical[table]);
      }
    })();
    // Post-migration rows must never reuse a legacy id, including ids of rows
    // that were left out of the canonical set (not_selected / MANUAL).
    for (const [table, floor] of Object.entries(plan.sequenceFloors)) {
      if (floor <= 0) continue;
      const definition = database
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?"
        )
        .get(table) as { sql: string } | undefined;
      if (!definition || !/AUTOINCREMENT/i.test(definition.sql)) continue;
      const updated = database
        .prepare('UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = ?')
        .run(floor, table);
      if (updated.changes === 0) {
        database
          .prepare('INSERT INTO sqlite_sequence(name, seq) VALUES (?, ?)')
          .run(table, floor);
      }
    }
    const violations = database.pragma('foreign_key_check') as unknown[];
    if (violations.length > 0) {
      throw new Error('V2 output failed foreign-key validation');
    }
    const integrity = database.pragma('integrity_check') as Array<{
      integrity_check: string;
    }>;
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
      throw new Error('V2 output failed SQLite integrity validation');
    }
  } finally {
    database.close();
  }
}

function writeLegacyArchive(
  path: string,
  plan: TransformPlan,
  manifestInputSha: string
): void {
  const database = new Database(path);
  try {
    database.pragma('journal_mode = DELETE');
    database.exec(
      'CREATE TABLE archive_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);' +
        'CREATE TABLE archived_rows (table_name TEXT NOT NULL, source_id TEXT NOT NULL, reason TEXT NOT NULL, row_json TEXT NOT NULL, PRIMARY KEY (table_name, source_id, reason));' +
        'CREATE TABLE archived_fields (table_name TEXT NOT NULL, source_id TEXT NOT NULL, column_name TEXT NOT NULL, disposition TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (table_name, source_id, column_name));'
    );
    database
      .prepare('INSERT INTO archive_meta(key, value) VALUES (?, ?)')
      .run('source_bundle_manifest_sha256', manifestInputSha);
    database
      .prepare('INSERT INTO archive_meta(key, value) VALUES (?, ?)')
      .run(
        'classification',
        'restricted: contains credentials and personal data'
      );
    database.transaction(() => {
      const row = database.prepare(
        'INSERT INTO archived_rows(table_name, source_id, reason, row_json) VALUES (?, ?, ?, ?)'
      );
      for (const entry of plan.archivedRows) {
        row.run(entry.table, entry.id, entry.reason, JSON.stringify(entry.row));
      }
      const field = database.prepare(
        'INSERT INTO archived_fields(table_name, source_id, column_name, disposition, value) VALUES (?, ?, ?, ?, ?)'
      );
      for (const entry of plan.archivedFields) {
        field.run(
          entry.table,
          entry.id,
          entry.column,
          entry.disposition,
          entry.value
        );
      }
    })();
  } finally {
    database.close();
  }
}

export function buildTransformSummary(manifest: TransformManifest): string {
  const lines = [
    'Terrastories Rails Stage-2 Transform Validation Summary',
    '',
    'Status: CANONICAL V2 SQLITE PRODUCED - NOT A CUTOVER',
    'Contract profile: ' + manifest.input.contractProfile,
    'Observed Rails schema version: ' + manifest.input.observedSchemaVersion,
    'Community selection: ' +
      manifest.selection.mode +
      ' (' +
      manifest.selection.communities.length +
      ' communities)',
    'MANUAL items: ' + manifest.manual.length,
    'Warnings: ' + manifest.warnings.length,
    '',
    'Canonical row counts:',
    ...Object.entries(manifest.canonicalCounts).map(
      ([table, count]) => '  - ' + table + ': ' + count
    ),
    '',
    'Source dispositions (imported/not_selected/manual/excluded_dependency/archived/pending_media_slice):',
    ...Object.entries(manifest.dispositions)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(
        ([table, c]) =>
          '  - ' +
          table +
          ': ' +
          [
            c.imported,
            c.not_selected,
            c.manual,
            c.excluded_dependency,
            c.archived,
            c.pending_media_slice,
          ].join('/')
      ),
    '',
    'Media payloads are pending the media slice; no files rows were created.',
    'This summary intentionally excludes row contents, hashes, tokens and credentials.',
    '',
  ];
  return lines.join('\n');
}

export async function transformRailsBundle(
  options: TransformRailsOptions
): Promise<TransformManifest> {
  const outputDir = resolve(options.outputDir);
  if (await pathExists(outputDir)) {
    throw new Error('Refusing to overwrite existing output path');
  }
  const bundle = await openVerifiedBundle(options.bundleDir);
  let temporaryDir: string | null = null;
  let destinationClaimed = false;
  try {
    const plan = planTransform(bundle, {
      ...(options.communities ? { communities: options.communities } : {}),
      includeSystemUsers: options.includeSystemUsers === true,
    });
    if (plan.manual.length > 0 && options.allowManual !== true) {
      throw new ManualReviewRequiredError(plan.manual);
    }

    await mkdir(dirname(outputDir), { recursive: true });
    temporaryDir = outputDir + '.tmp-' + randomUUID();
    await mkdir(temporaryDir, { recursive: false, mode: 0o700 });
    // Atomically claim the destination as an empty directory so a concurrent
    // creator fails here instead of racing the final rename (as Stage 1 does).
    try {
      await mkdir(outputDir, { recursive: false, mode: 0o700 });
      destinationClaimed = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error('Refusing to overwrite existing output path');
      }
      throw error;
    }

    const canonicalCounts = Object.fromEntries(
      CANONICAL_TABLES.map((table) => [table, plan.canonical[table].length])
    );
    const manifest: TransformManifest = {
      formatVersion: TRANSFORM_FORMAT_VERSION,
      input: {
        bundleManifestSha256: bundle.manifestSha256,
        archiveSha256: bundle.manifest.archive.sha256,
        contractProfile: bundle.manifest.source.contractProfile,
        observedSchemaVersion: bundle.manifest.source.observedSchemaVersion,
        schemaSha256: bundle.manifest.source.schemaSha256,
      },
      options: {
        communities: plan.selection.selectors,
        includeSystemUsers: plan.selection.includeSystemUsers,
        allowManual: options.allowManual === true,
      },
      selection: plan.selection,
      sourceCounts: plan.sourceCounts,
      dispositions: plan.statusCounts,
      canonicalCounts,
      idRemaps: plan.idRemaps,
      fieldDispositions: Object.fromEntries(
        Object.entries(COLUMN_DISPOSITIONS)
          .filter(([table]) => bundle.tableNames.includes(table))
          .sort(([a], [b]) => (a < b ? -1 : 1))
      ),
      fieldEvents: plan.events,
      warnings: plan.warnings,
      manual: plan.manual,
      pendingMedia: plan.pendingMedia,
      flipper: plan.flipper,
      unknownTables: plan.unknownTables,
      unregisteredColumns: plan.unregisteredColumns,
      curriculumUseDetected: plan.curriculumUseDetected,
      checksums: {
        canonicalRows: Object.fromEntries(
          CANONICAL_TABLES.map((table: CanonicalTable) => [
            table,
            sha256(JSON.stringify(plan.canonical[table])),
          ])
        ),
        archivedRows: sha256(JSON.stringify(plan.archivedRows)),
        archivedFields: sha256(JSON.stringify(plan.archivedFields)),
      },
    };

    const v2Path = join(temporaryDir, V2_DATABASE_FILENAME);
    const archivePath = join(temporaryDir, LEGACY_ARCHIVE_FILENAME);
    writeCanonicalDatabase(v2Path, plan);
    writeLegacyArchive(archivePath, plan, bundle.manifestSha256);
    await chmod(v2Path, 0o600);
    await chmod(archivePath, 0o600);
    await writeFile(
      join(temporaryDir, 'manifest.json'),
      JSON.stringify(manifest, null, 2) + '\n',
      { encoding: 'utf8', mode: 0o600 }
    );
    if (plan.manual.length > 0) {
      await writeFile(
        join(temporaryDir, 'manual-review.json'),
        JSON.stringify({ manual: plan.manual }, null, 2) + '\n',
        { encoding: 'utf8', mode: 0o600 }
      );
    }
    await writeFile(
      join(temporaryDir, 'validation-summary.txt'),
      buildTransformSummary(manifest),
      { encoding: 'utf8', mode: 0o600 }
    );

    for (const name of await readdir(temporaryDir)) {
      await fsyncPath(join(temporaryDir, name));
    }
    await fsyncPath(temporaryDir);
    if ((await readdir(outputDir)).length > 0) {
      throw new Error('Output destination changed during transform');
    }
    await rename(temporaryDir, outputDir);
    destinationClaimed = false;
    temporaryDir = null;
    await fsyncPath(dirname(outputDir));
    return manifest;
  } finally {
    bundle.close();
    if (temporaryDir !== null) {
      await rm(temporaryDir, { recursive: true, force: true });
    }
    if (destinationClaimed) {
      // Remove only our own still-empty claim; never a populated directory.
      await rmdir(outputDir).catch(() => undefined);
    }
  }
}
