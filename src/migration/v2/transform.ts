/**
 * Stage-2 orchestration: verified Stage-1 bundle -> canonical V2 SQLite output
 * directory (SPEC-V2 §10.2, §10.4, §10.5).
 *
 * Output (never overwritten; written to an owner-only temp dir then renamed):
 *   v2.sqlite              V2 SQLite migrations applied, canonical rows inserted
 *   v2-media/              verified media files at their tenant-scoped storage keys
 *   archive-media/         protected archive objects (orphan/variant/preview blobs)
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
import { fsyncDirectoryTree, fsyncPath } from '../rails/fsync.js';
import {
  ARCHIVE_MEDIA_DIRECTORY,
  MEDIA_DIRECTORY,
  MEDIA_TABLES,
  planMedia,
  writeMediaObjects,
  type BlobLedgerEntry,
  type MediaPlan,
  type WriteMediaOptions,
} from './media.js';
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
  /** Test seam: replaces the post-rename parent-directory fsync. */
  syncParentDirectory?: (directory: string) => Promise<void>;
  /** Test seam: runs after each media object is written, before read-back. */
  afterMediaWrite?: WriteMediaOptions['afterWrite'];
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
  media: {
    mediaDirectory: string;
    archiveDirectory: string;
    counts: MediaPlan['counts'];
    /** Exactly one entry per source blob (SPEC-V2 10.4). */
    blobs: BlobLedgerEntry[];
  };
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

function writeCanonicalDatabase(
  path: string,
  plan: TransformPlan,
  media: MediaPlan
): void {
  const database = new Database(path);
  try {
    database.pragma('journal_mode = DELETE');
    database.pragma('foreign_keys = ON');
    migrate(drizzle(database), { migrationsFolder });
    database.transaction(() => {
      // Files precede community_map_configs (composite static-map FK);
      // attachments follow files and every owner table.
      for (const table of CANONICAL_TABLES) {
        if (table === 'community_map_configs') {
          insertRows(database, 'files', media.files);
        }
        insertRows(database, table, plan.canonical[table]);
      }
      insertRows(database, 'attachments', media.attachments);
    })();
    // Post-migration rows must never reuse a legacy id, including ids of rows
    // that were left out of the canonical set (not_selected / MANUAL).
    const floors: Record<string, number> = {
      ...plan.sequenceFloors,
      attachments: media.attachmentSequenceFloor,
    };
    for (const [table, floor] of Object.entries(floors)) {
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
    for (const [table, expected] of [
      ['files', media.files.length],
      ['attachments', media.attachments.length],
    ] as const) {
      const row = database
        .prepare('SELECT COUNT(*) AS n FROM ' + table)
        .get() as { n: number };
      if (row.n !== expected) {
        throw new Error(
          'V2 output ' + table + ' count does not match the plan'
        );
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
  archivedRows: TransformPlan['archivedRows'],
  archivedFields: TransformPlan['archivedFields'],
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
      for (const entry of archivedRows) {
        row.run(entry.table, entry.id, entry.reason, JSON.stringify(entry.row));
      }
      const field = database.prepare(
        'INSERT INTO archived_fields(table_name, source_id, column_name, disposition, value) VALUES (?, ?, ?, ?, ?)'
      );
      for (const entry of archivedFields) {
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
    'Media payloads: ' +
      manifest.media.counts.files +
      ' files and ' +
      manifest.media.counts.attachments +
      ' attachments written; ' +
      manifest.media.counts.blobs.canonical +
      ' canonical / ' +
      manifest.media.counts.blobs.archive +
      ' archived / ' +
      manifest.media.counts.blobs.not_selected +
      ' not_selected source blobs; every written object was SHA-256 verified.',
    'This summary intentionally excludes row contents, hashes, tokens and credentials.',
    '',
  ];
  return lines.join('\n');
}

async function quarantinePublishedOutput(
  publishedDir: string,
  cause: unknown
): Promise<never> {
  const reason = cause instanceof Error ? cause.message : String(cause);
  const failedDir = publishedDir + '.failed-' + Date.now();
  try {
    await rename(publishedDir, failedDir);
  } catch {
    // Could not move it: make the final directory unmistakably incomplete.
    await rm(join(publishedDir, 'manifest.json'), { force: true });
    await writeFile(
      join(publishedDir, 'TRANSFORM_FAILED'),
      'Transform failed after publish: ' + reason + '\n',
      { encoding: 'utf8', mode: 0o600 }
    );
    throw new Error(
      'Transform failed syncing the parent directory after publish (' +
        reason +
        '); marked ' +
        publishedDir +
        ' with TRANSFORM_FAILED and removed its manifest. Do not use it.'
    );
  }
  throw new Error(
    'Transform failed syncing the parent directory after publish (' +
      reason +
      '); quarantined the output as ' +
      failedDir +
      '. Do not use it.'
  );
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

    const media = planMedia(bundle, plan);
    for (const row of plan.canonical.community_map_configs) {
      row.static_map_file_id =
        media.staticMaps.get(row.community_id as number) ?? null;
    }
    const dispositions = Object.fromEntries(
      Object.entries(plan.statusCounts).map(([table, counts]) => [
        table,
        { ...counts },
      ])
    ) as TransformPlan['statusCounts'];
    for (const table of MEDIA_TABLES) {
      const counts = dispositions[table];
      if (!counts) continue;
      for (const status of media.finalStatus[table].values()) {
        counts.pending_media_slice -= 1;
        counts[status] += 1;
      }
      if (counts.pending_media_slice !== 0) {
        throw new Error(
          'Internal error: media rows left without a final disposition (' +
            table +
            ')'
        );
      }
    }
    const byKey = (
      a: { table: string; id: string | null; code: string },
      b: { table: string; id: string | null; code: string }
    ): number => {
      const left = a.table + '\x00' + (a.id ?? '') + '\x00' + a.code;
      const right = b.table + '\x00' + (b.id ?? '') + '\x00' + b.code;
      return left < right ? -1 : left > right ? 1 : 0;
    };
    const warnings = [...plan.warnings, ...media.warnings].sort(byKey);
    const events = { ...plan.events };
    for (const [key, count] of Object.entries(media.events)) {
      events[key] = (events[key] ?? 0) + count;
    }
    const archivedRows = [...plan.archivedRows, ...media.archivedRows];
    const archivedFields = [...plan.archivedFields, ...media.archivedFields];

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

    const canonicalCounts: Record<string, number> = {
      ...Object.fromEntries(
        CANONICAL_TABLES.map((table) => [table, plan.canonical[table].length])
      ),
      files: media.files.length,
      attachments: media.attachments.length,
    };
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
      dispositions,
      canonicalCounts,
      idRemaps: plan.idRemaps,
      fieldDispositions: Object.fromEntries(
        Object.entries(COLUMN_DISPOSITIONS)
          .filter(([table]) => bundle.tableNames.includes(table))
          .sort(([a], [b]) => (a < b ? -1 : 1))
      ),
      fieldEvents: Object.fromEntries(
        Object.entries(events).sort(([a], [b]) => (a < b ? -1 : 1))
      ),
      warnings,
      manual: plan.manual,
      pendingMedia: plan.pendingMedia,
      media: {
        mediaDirectory: MEDIA_DIRECTORY,
        archiveDirectory: ARCHIVE_MEDIA_DIRECTORY,
        counts: media.counts,
        blobs: media.ledger,
      },
      flipper: plan.flipper,
      unknownTables: plan.unknownTables,
      unregisteredColumns: plan.unregisteredColumns,
      curriculumUseDetected: plan.curriculumUseDetected,
      checksums: {
        canonicalRows: {
          ...Object.fromEntries(
            CANONICAL_TABLES.map((table: CanonicalTable) => [
              table,
              sha256(JSON.stringify(plan.canonical[table])),
            ])
          ),
          files: sha256(JSON.stringify(media.files)),
          attachments: sha256(JSON.stringify(media.attachments)),
        },
        archivedRows: sha256(JSON.stringify(archivedRows)),
        archivedFields: sha256(JSON.stringify(archivedFields)),
      },
    };

    const v2Path = join(temporaryDir, V2_DATABASE_FILENAME);
    const archivePath = join(temporaryDir, LEGACY_ARCHIVE_FILENAME);
    // Bytes first: any copy or checksum mismatch aborts before anything is
    // published, and the temporary directory is discarded whole.
    await writeMediaObjects(bundle.dir, temporaryDir, media, {
      ...(options.afterMediaWrite
        ? { afterWrite: options.afterMediaWrite }
        : {}),
    });
    writeCanonicalDatabase(v2Path, plan, media);
    writeLegacyArchive(
      archivePath,
      archivedRows,
      archivedFields,
      bundle.manifestSha256
    );
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

    await fsyncDirectoryTree(join(temporaryDir, MEDIA_DIRECTORY));
    await fsyncDirectoryTree(join(temporaryDir, ARCHIVE_MEDIA_DIRECTORY));
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
    try {
      await (options.syncParentDirectory ?? fsyncPath)(dirname(outputDir));
    } catch (syncError) {
      // Published but not known durable: never leave a complete-looking output.
      await quarantinePublishedOutput(outputDir, syncError);
    }
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
