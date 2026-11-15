/**
 * Attachments table schema with multi-database support
 *
 * Canonical §6.7 typed attachment relation via expand-contract coexistence:
 * adds canonical columns (`community_id`, `file_id`, `owner_type`, `owner_id`,
 * `role`, `ordinal`) and both single-column + composite file FKs (for MATCH
 * SIMPLE null-community protection on super_admin profile photos), while
 * making legacy V1 columns nullable until Slice 15 cleanup.
 */

import {
  pgTable,
  serial,
  text as pgText,
  integer as pgInteger,
  uuid as pgUuid,
  timestamp,
  index as pgIndex,
  foreignKey as pgForeignKey,
} from 'drizzle-orm/pg-core';
import {
  sqliteTable,
  integer,
  text as sqliteText,
  index as sqliteIndex,
  foreignKey as sqliteForeignKey,
} from 'drizzle-orm/sqlite-core';
import { createInsertSchema, createSelectSchema } from 'drizzle-zod';
import { z } from 'zod';
import { filesPg, filesSqlite } from './files.js';

export const ATTACHMENT_OWNER_TYPES = [
  'story',
  'place',
  'speaker',
  'user',
  'community',
  'map_config',
] as const;

export type AttachmentOwnerType = (typeof ATTACHMENT_OWNER_TYPES)[number];

export const ATTACHMENT_ROLES = [
  'story_media',
  'place_photo',
  'place_name_audio',
  'speaker_photo',
  'user_photo',
  'community_display_image',
  'community_background_image',
  'sponsor_logo',
  'static_map',
] as const;

export type AttachmentRole = (typeof ATTACHMENT_ROLES)[number];

// PostgreSQL table for production
export const attachmentsPg = pgTable(
  'attachments',
  {
    id: serial('id').primaryKey(),
    communityId: pgInteger('community_id'),
    fileId: pgUuid('file_id').references(() => filesPg.id, {
      onDelete: 'cascade',
    }),
    ownerType: pgText('owner_type', { enum: ATTACHMENT_OWNER_TYPES }),
    ownerId: pgInteger('owner_id'),
    role: pgText('role', { enum: ATTACHMENT_ROLES }),
    ordinal: pgInteger('ordinal').default(0),
    // Legacy V1 columns retained as nullable during coexistence until Slice 15.
    attachableId: pgInteger('attachable_id'),
    attachableType: pgText('attachable_type'),
    url: pgText('url'),
    filename: pgText('filename'),
    contentType: pgText('content_type'),
    fileSize: pgInteger('file_size'),
    createdAt: timestamp('created_at', { precision: 3 }).defaultNow().notNull(),
  },
  (table) => ({
    ownerIdx: pgIndex('attachments_owner_idx').on(
      table.communityId,
      table.ownerType,
      table.ownerId,
      table.role,
      table.ordinal
    ),
    fileIdx: pgIndex('attachments_file_idx').on(table.fileId),
    fileCommunityFk: pgForeignKey({
      name: 'attachments_file_community_fk',
      columns: [table.communityId, table.fileId],
      foreignColumns: [filesPg.communityId, filesPg.id],
    }).onDelete('cascade'),
  })
);

// SQLite table for development/testing
export const attachmentsSqlite = sqliteTable(
  'attachments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    communityId: integer('community_id'),
    fileId: sqliteText('file_id').references(() => filesSqlite.id, {
      onDelete: 'cascade',
    }),
    ownerType: sqliteText('owner_type', { enum: ATTACHMENT_OWNER_TYPES }),
    ownerId: integer('owner_id'),
    role: sqliteText('role', { enum: ATTACHMENT_ROLES }),
    ordinal: integer('ordinal').default(0),
    // Legacy V1 columns retained as nullable during coexistence until Slice 15.
    attachableId: integer('attachable_id'),
    attachableType: sqliteText('attachable_type'),
    url: sqliteText('url'),
    filename: sqliteText('filename'),
    contentType: sqliteText('content_type'),
    fileSize: integer('file_size'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    ownerIdx: sqliteIndex('attachments_owner_idx').on(
      table.communityId,
      table.ownerType,
      table.ownerId,
      table.role,
      table.ordinal
    ),
    fileIdx: sqliteIndex('attachments_file_idx').on(table.fileId),
    fileCommunityFk: sqliteForeignKey({
      name: 'attachments_file_community_fk',
      columns: [table.communityId, table.fileId],
      foreignColumns: [filesSqlite.communityId, filesSqlite.id],
    }).onDelete('cascade'),
  })
);

// Dynamic table selection
export async function getAttachmentsTable() {
  const { getConfig } = await import('../../shared/config/index.js');
  const config = getConfig();
  const isPostgres =
    config.database.url.startsWith('postgresql://') ||
    config.database.url.startsWith('postgres://');
  return isPostgres ? attachmentsPg : attachmentsSqlite;
}

// Frozen V1 Zod schemas: preserve required legacy fields during coexistence.
export const insertAttachmentSchema = createInsertSchema(attachmentsSqlite, {
  url: z.string().url('Invalid URL format'),
  attachableId: z
    .number()
    .int()
    .positive('Attachable ID must be a positive integer'),
  attachableType: z.string().min(1, 'Attachable type cannot be empty'),
  filename: z.string().min(1, 'Filename cannot be empty'),
});

export const selectAttachmentSchema = createSelectSchema(attachmentsSqlite);

// TypeScript types - Use SQLite for consistency with current deployment
export type Attachment = typeof attachmentsSqlite.$inferSelect;
export type NewAttachment = typeof attachmentsSqlite.$inferInsert;

// Use SQLite table for Drizzle Kit
export const attachments = attachmentsSqlite;
