/**
 * Attachments table schema with multi-database support
 *
 * Manages media files with polymorphic relationships to other models.
 */

import {
  pgTable,
  serial,
  text as pgText,
  integer as pgInteger,
  timestamp,
} from 'drizzle-orm/pg-core';
import {
  sqliteTable,
  integer,
  text as sqliteText,
} from 'drizzle-orm/sqlite-core';
import { createInsertSchema, createSelectSchema } from 'drizzle-zod';
import { z } from 'zod';

// PostgreSQL table for production
export const attachmentsPg = pgTable('attachments', {
  id: serial('id').primaryKey(),
  attachableId: pgInteger('attachable_id').notNull(),
  attachableType: pgText('attachable_type').notNull(), // e.g., 'Story', 'Place'
  url: pgText('url').notNull(),
  filename: pgText('filename').notNull(),
  contentType: pgText('content_type'),
  fileSize: pgInteger('file_size'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// SQLite table for development/testing
export const attachmentsSqlite = sqliteTable('attachments', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  attachableId: integer('attachable_id').notNull(),
  attachableType: sqliteText('attachable_type').notNull(),
  url: sqliteText('url').notNull(),
  filename: sqliteText('filename').notNull(),
  contentType: sqliteText('content_type'),
  fileSize: integer('file_size'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

// Dynamic table selection
export async function getAttachmentsTable() {
  const { getConfig } = await import('../../shared/config/index.js');
  const config = getConfig();
  const isPostgres =
    config.database.url.startsWith('postgresql://') ||
    config.database.url.startsWith('postgres://');
  return isPostgres ? attachmentsPg : attachmentsSqlite;
}

// Zod schemas
export const insertAttachmentSchema = createInsertSchema(attachmentsSqlite, {
  url: z.string().url('Invalid URL format'),
  attachableId: z
    .number()
    .int()
    .positive('Attachable ID must be a positive integer'),
  attachableType: z.string().min(1, 'Attachable type cannot be empty'),
});

export const selectAttachmentSchema = createSelectSchema(attachmentsSqlite);

// TypeScript types - Use SQLite for consistency with current deployment
export type Attachment = typeof attachmentsSqlite.$inferSelect;
export type NewAttachment = typeof attachmentsSqlite.$inferInsert;

// Use SQLite table for Drizzle Kit
export const attachments = attachmentsSqlite;
