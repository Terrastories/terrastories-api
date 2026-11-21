/**
 * ExportJob and ExportToken tables with equal PostgreSQL and SQLite/D1-compatible
 * semantics (SPEC-V2 §7 "Community export, withdrawal and erasure", #187).
 *
 * - `export_jobs` tracks export artifact generation, single-active-generation
 *   locking per community (`export_jobs_active_community_unique`), R2 multipart
 *   `zip_upload_id` for restart-safe abort on failure/expiry, and `cleaned_up_at`
 *   for per-object expiry deletion.
 * - `export_tokens` stores short-lived, single-artifact download tokens
 *   (SHA-256 hash at rest, bound to the requesting administrator and artifact).
 * - Millisecond timestamps on both backends (Unix ms integer on SQLite/D1,
 *   bigint on PostgreSQL), matching sessions/login_codes/claim_tokens (#192).
 */

import { sql } from 'drizzle-orm';
import {
  pgTable,
  serial,
  text as pgText,
  integer as pgInteger,
  bigint,
  index as pgIndex,
  uniqueIndex as pgUniqueIndex,
  check as pgCheck,
} from 'drizzle-orm/pg-core';
import {
  sqliteTable,
  integer,
  text,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/sqlite-core';
import { communitiesPg, communitiesSqlite } from './communities.js';
import { usersPg, usersSqlite } from './users.js';

export const EXPORT_JOB_STATUSES = [
  'generating',
  'ready',
  'failed',
  'expired',
] as const;
export type ExportJobStatus = (typeof EXPORT_JOB_STATUSES)[number];

export const EXPORT_TOKEN_ARTIFACTS = ['manifest', 'media_zip'] as const;
export type ExportTokenArtifact = (typeof EXPORT_TOKEN_ARTIFACTS)[number];

export const exportJobsPg = pgTable(
  'export_jobs',
  {
    id: pgText('id').primaryKey(),
    communityId: pgInteger('community_id')
      .notNull()
      .references(() => communitiesPg.id, { onDelete: 'cascade' }),
    requestedBy: pgInteger('requested_by').references(() => usersPg.id, {
      onDelete: 'set null',
    }),
    status: pgText('status', { enum: EXPORT_JOB_STATUSES }).notNull(),
    manifestStorageKey: pgText('manifest_storage_key'),
    manifestByteSize: bigint('manifest_byte_size', { mode: 'number' }),
    manifestChecksum: pgText('manifest_checksum'),
    zipStorageKey: pgText('zip_storage_key'),
    zipByteSize: bigint('zip_byte_size', { mode: 'number' }),
    zipChecksum: pgText('zip_checksum'),
    zipUploadId: pgText('zip_upload_id'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    completedAt: bigint('completed_at', { mode: 'number' }),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
    cleanedUpAt: bigint('cleaned_up_at', { mode: 'number' }),
  },
  (table) => [
    pgUniqueIndex('export_jobs_active_community_unique')
      .on(table.communityId)
      .where(sql`${table.status} = 'generating'`),
    pgIndex('export_jobs_community_created_idx').on(
      table.communityId,
      table.createdAt
    ),
    pgIndex('export_jobs_requested_by_created_idx').on(
      table.requestedBy,
      table.createdAt
    ),
    pgIndex('export_jobs_cleanup_idx')
      .on(table.expiresAt)
      .where(sql`${table.cleanedUpAt} IS NULL`),
    pgCheck(
      'export_jobs_status_check',
      sql`${table.status} in ('generating', 'ready', 'failed', 'expired')`
    ),
    pgCheck(
      'export_jobs_expiry_check',
      sql`${table.expiresAt} > ${table.createdAt}`
    ),
  ]
);

export const exportJobsSqlite = sqliteTable(
  'export_jobs',
  {
    id: text('id').primaryKey().notNull(),
    communityId: integer('community_id')
      .notNull()
      .references(() => communitiesSqlite.id, { onDelete: 'cascade' }),
    requestedBy: integer('requested_by').references(() => usersSqlite.id, {
      onDelete: 'set null',
    }),
    status: text('status', { enum: EXPORT_JOB_STATUSES }).notNull(),
    manifestStorageKey: text('manifest_storage_key'),
    manifestByteSize: integer('manifest_byte_size'),
    manifestChecksum: text('manifest_checksum'),
    zipStorageKey: text('zip_storage_key'),
    zipByteSize: integer('zip_byte_size'),
    zipChecksum: text('zip_checksum'),
    zipUploadId: text('zip_upload_id'),
    createdAt: integer('created_at').notNull(),
    completedAt: integer('completed_at'),
    expiresAt: integer('expires_at').notNull(),
    cleanedUpAt: integer('cleaned_up_at'),
  },
  (table) => [
    uniqueIndex('export_jobs_active_community_unique')
      .on(table.communityId)
      .where(sql`${table.status} = 'generating'`),
    index('export_jobs_community_created_idx').on(
      table.communityId,
      table.createdAt
    ),
    index('export_jobs_requested_by_created_idx').on(
      table.requestedBy,
      table.createdAt
    ),
    index('export_jobs_cleanup_idx')
      .on(table.expiresAt)
      .where(sql`${table.cleanedUpAt} IS NULL`),
    check(
      'export_jobs_status_check',
      sql`${table.status} in ('generating', 'ready', 'failed', 'expired')`
    ),
    check(
      'export_jobs_expiry_check',
      sql`${table.expiresAt} > ${table.createdAt}`
    ),
  ]
);

export const exportTokensPg = pgTable(
  'export_tokens',
  {
    id: serial('id').primaryKey(),
    jobId: pgText('job_id')
      .notNull()
      .references(() => exportJobsPg.id, { onDelete: 'cascade' }),
    communityId: pgInteger('community_id')
      .notNull()
      .references(() => communitiesPg.id, { onDelete: 'cascade' }),
    requestedBy: pgInteger('requested_by')
      .notNull()
      .references(() => usersPg.id, { onDelete: 'cascade' }),
    artifact: pgText('artifact', { enum: EXPORT_TOKEN_ARTIFACTS }).notNull(),
    tokenHash: pgText('token_hash').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
    downloadedAt: bigint('downloaded_at', { mode: 'number' }),
  },
  (table) => [
    pgUniqueIndex('export_tokens_token_hash_unique').on(table.tokenHash),
    pgUniqueIndex('export_tokens_job_artifact_unique').on(
      table.jobId,
      table.artifact
    ),
    pgIndex('export_tokens_community_idx').on(table.communityId),
    pgIndex('export_tokens_expires_idx').on(table.expiresAt),
    pgCheck(
      'export_tokens_artifact_check',
      sql`${table.artifact} in ('manifest', 'media_zip')`
    ),
    pgCheck(
      'export_tokens_expiry_check',
      sql`${table.expiresAt} > ${table.createdAt}`
    ),
  ]
);

export const exportTokensSqlite = sqliteTable(
  'export_tokens',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    jobId: text('job_id')
      .notNull()
      .references(() => exportJobsSqlite.id, { onDelete: 'cascade' }),
    communityId: integer('community_id')
      .notNull()
      .references(() => communitiesSqlite.id, { onDelete: 'cascade' }),
    requestedBy: integer('requested_by')
      .notNull()
      .references(() => usersSqlite.id, { onDelete: 'cascade' }),
    artifact: text('artifact', { enum: EXPORT_TOKEN_ARTIFACTS }).notNull(),
    tokenHash: text('token_hash').notNull(),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    downloadedAt: integer('downloaded_at'),
  },
  (table) => [
    uniqueIndex('export_tokens_token_hash_unique').on(table.tokenHash),
    uniqueIndex('export_tokens_job_artifact_unique').on(
      table.jobId,
      table.artifact
    ),
    index('export_tokens_community_idx').on(table.communityId),
    index('export_tokens_expires_idx').on(table.expiresAt),
    check(
      'export_tokens_artifact_check',
      sql`${table.artifact} in ('manifest', 'media_zip')`
    ),
    check(
      'export_tokens_expiry_check',
      sql`${table.expiresAt} > ${table.createdAt}`
    ),
  ]
);

export type ExportJob = typeof exportJobsSqlite.$inferSelect;
export type NewExportJob = typeof exportJobsSqlite.$inferInsert;
export type ExportToken = typeof exportTokensSqlite.$inferSelect;
export type NewExportToken = typeof exportTokensSqlite.$inferInsert;
