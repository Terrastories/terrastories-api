/**
 * ImportManifest table schema (SPEC-V2 §4, §6.9; Slice 12, #123, #197).
 *
 * Stores immutable normalized CSV import previews, explicit header/audience
 * mappings, row-level validation errors, staged media file references,
 * committed result summaries, and millisecond timestamps across both
 * PostgreSQL and SQLite/D1.
 *
 * Tenancy & integrity:
 * - `community_id` references `communities(id) ON DELETE CASCADE`.
 * - Composite `(community_id, source_file_id)` FK references
 *   `files(community_id, id) ON DELETE NO ACTION` so cross-community or
 *   null-community source CSV references are rejected structurally.
 * - `created_by` references `users(id) ON DELETE SET NULL` so erasing an
 *   editor/admin account never fails on historical manifests.
 */
import { sql } from 'drizzle-orm';
import {
  pgTable,
  serial,
  text as pgText,
  integer as pgInteger,
  bigint,
  uuid as pgUuid,
  jsonb as pgJsonb,
  index as pgIndex,
  foreignKey as pgForeignKey,
  check as pgCheck,
} from 'drizzle-orm/pg-core';
import {
  sqliteTable,
  integer,
  text as sqliteText,
  index as sqliteIndex,
  foreignKey as sqliteForeignKey,
  check,
} from 'drizzle-orm/sqlite-core';
import { communitiesPg, communitiesSqlite } from './communities.js';
import { filesPg, filesSqlite } from './files.js';
import { usersPg, usersSqlite } from './users.js';

export const IMPORT_MANIFEST_KINDS = ['places', 'speakers', 'stories'] as const;
export type ImportManifestKind = (typeof IMPORT_MANIFEST_KINDS)[number];

export const IMPORT_MANIFEST_STATUSES = [
  'previewed',
  'committed',
  'failed',
  'discarded',
] as const;
export type ImportManifestStatus = (typeof IMPORT_MANIFEST_STATUSES)[number];

export const importManifestsPg = pgTable(
  'import_manifests',
  {
    id: serial('id').primaryKey(),
    communityId: pgInteger('community_id')
      .notNull()
      .references(() => communitiesPg.id, { onDelete: 'cascade' }),
    kind: pgText('kind', { enum: IMPORT_MANIFEST_KINDS }).notNull(),
    status: pgText('status', { enum: IMPORT_MANIFEST_STATUSES })
      .notNull()
      .default('previewed'),
    createdBy: pgInteger('created_by').references(() => usersPg.id, {
      onDelete: 'set null',
    }),
    sourceFileName: pgText('source_file_name'),
    sourceFileId: pgUuid('source_file_id').notNull(),
    mappings: pgJsonb('mappings').$type<Record<string, unknown>>().notNull(),
    normalizedRows: pgJsonb('normalized_rows')
      .$type<Record<string, unknown>>()
      .notNull(),
    rowCount: pgInteger('row_count').notNull(),
    rowErrors: pgJsonb('row_errors')
      .$type<Array<Record<string, unknown>>>()
      .notNull(),
    stagedFileIds: pgJsonb('staged_file_ids').$type<string[]>().notNull(),
    resultSummary: pgJsonb('result_summary').$type<Record<
      string,
      unknown
    > | null>(),
    committedAt: bigint('committed_at', { mode: 'number' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (table) => [
    pgIndex('import_manifests_community_created_idx').on(
      table.communityId,
      table.createdAt,
      table.id
    ),
    pgIndex('import_manifests_community_status_idx').on(
      table.communityId,
      table.status,
      table.createdAt
    ),
    pgIndex('import_manifests_status_committed_at_idx').on(
      table.status,
      table.committedAt
    ),
    pgIndex('import_manifests_source_file_idx').on(table.sourceFileId),
    pgIndex('import_manifests_created_by_idx').on(table.createdBy),
    pgForeignKey({
      name: 'import_manifests_source_file_community_fk',
      columns: [table.communityId, table.sourceFileId],
      foreignColumns: [filesPg.communityId, filesPg.id],
    }),
    pgCheck(
      'import_manifests_kind_check',
      sql`${table.kind} in ('places', 'speakers', 'stories')`
    ),
    pgCheck(
      'import_manifests_status_check',
      sql`${table.status} in ('previewed', 'committed', 'failed', 'discarded')`
    ),
    pgCheck('import_manifests_row_count_check', sql`${table.rowCount} >= 0`),
    pgCheck(
      'import_manifests_committed_at_check',
      sql`(${table.status} = 'committed' AND ${table.committedAt} IS NOT NULL) OR (${table.status} <> 'committed' AND ${table.committedAt} IS NULL)`
    ),
  ]
);

export const importManifestsSqlite = sqliteTable(
  'import_manifests',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    communityId: integer('community_id')
      .notNull()
      .references(() => communitiesSqlite.id, { onDelete: 'cascade' }),
    kind: sqliteText('kind', { enum: IMPORT_MANIFEST_KINDS }).notNull(),
    status: sqliteText('status', { enum: IMPORT_MANIFEST_STATUSES })
      .notNull()
      .default('previewed'),
    createdBy: integer('created_by').references(() => usersSqlite.id, {
      onDelete: 'set null',
    }),
    sourceFileName: sqliteText('source_file_name'),
    sourceFileId: sqliteText('source_file_id').notNull(),
    mappings: sqliteText('mappings', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull(),
    normalizedRows: sqliteText('normalized_rows', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull(),
    rowCount: integer('row_count').notNull(),
    rowErrors: sqliteText('row_errors', { mode: 'json' })
      .$type<Array<Record<string, unknown>>>()
      .notNull(),
    stagedFileIds: sqliteText('staged_file_ids', { mode: 'json' })
      .$type<string[]>()
      .notNull(),
    resultSummary: sqliteText('result_summary', { mode: 'json' }).$type<Record<
      string,
      unknown
    > | null>(),
    committedAt: integer('committed_at'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    sqliteIndex('import_manifests_community_created_idx').on(
      table.communityId,
      table.createdAt,
      table.id
    ),
    sqliteIndex('import_manifests_community_status_idx').on(
      table.communityId,
      table.status,
      table.createdAt
    ),
    sqliteIndex('import_manifests_status_committed_at_idx').on(
      table.status,
      table.committedAt
    ),
    sqliteIndex('import_manifests_source_file_idx').on(table.sourceFileId),
    sqliteIndex('import_manifests_created_by_idx').on(table.createdBy),
    sqliteForeignKey({
      name: 'import_manifests_source_file_community_fk',
      columns: [table.communityId, table.sourceFileId],
      foreignColumns: [filesSqlite.communityId, filesSqlite.id],
    }),
    check(
      'import_manifests_kind_check',
      sql`${table.kind} in ('places', 'speakers', 'stories')`
    ),
    check(
      'import_manifests_status_check',
      sql`${table.status} in ('previewed', 'committed', 'failed', 'discarded')`
    ),
    check('import_manifests_row_count_check', sql`${table.rowCount} >= 0`),
    check(
      'import_manifests_committed_at_check',
      sql`(${table.status} = 'committed' AND ${table.committedAt} IS NOT NULL) OR (${table.status} <> 'committed' AND ${table.committedAt} IS NULL)`
    ),
  ]
);

export type ImportManifest = typeof importManifestsSqlite.$inferSelect;
export type NewImportManifest = typeof importManifestsSqlite.$inferInsert;

export const importManifests = importManifestsSqlite;
