/**
 * Files table schema with multi-database support
 *
 * Enhanced file management with community scoping, cultural protocols,
 * and comprehensive metadata for the Terrastories file upload system.
 */

import {
  pgTable,
  text as pgText,
  integer as pgInteger,
  bigint as pgBigint,
  timestamp,
  uuid as pgUuid,
  jsonb as pgJsonb,
  boolean as pgBoolean,
  index as pgIndex,
} from 'drizzle-orm/pg-core';
import {
  sqliteTable,
  integer,
  text as sqliteText,
} from 'drizzle-orm/sqlite-core';
import { createInsertSchema, createSelectSchema } from 'drizzle-zod';
import { z } from 'zod';
import { communitiesPg, communitiesSqlite } from './communities.js';
import { usersPg, usersSqlite } from './users.js';

// PostgreSQL table for production
export const filesPg = pgTable(
  'files',
  {
    id: pgUuid('id').primaryKey().defaultRandom(),
    filename: pgText('filename').notNull(),
    originalName: pgText('original_name').notNull(),
    path: pgText('path').notNull(),
    url: pgText('url').notNull(),
    mimeType: pgText('mime_type').notNull(),
    size: pgBigint('size', { mode: 'number' }).notNull(),
    communityId: pgInteger('community_id')
      .notNull()
      .references(() => communitiesPg.id),
    uploadedBy: pgInteger('uploaded_by')
      .notNull()
      .references(() => usersPg.id),
    metadata: pgJsonb('metadata'), // { width, height, duration, etc. }
    culturalRestrictions: pgJsonb('cultural_restrictions'), // { elderOnly: boolean, ... }
    isActive: pgBoolean('is_active').default(true).notNull(),
    createdAt: timestamp('created_at').notNull(),
    updatedAt: timestamp('updated_at').notNull(),
  },
  (table) => ({
    // Community isolation index for data sovereignty
    communityIdx: pgIndex('files_community_idx').on(table.communityId),
    // User files index for performance
    userIdx: pgIndex('files_user_idx').on(table.uploadedBy),
    // MIME type index for filtering
    mimeTypeIdx: pgIndex('files_mime_type_idx').on(table.mimeType),
    // Active files index
    activeIdx: pgIndex('files_active_idx').on(table.isActive),
    // Created date index for ordering
    createdAtIdx: pgIndex('files_created_at_idx').on(table.createdAt),
  })
);

// SQLite table for development/testing
export const filesSqlite = sqliteTable('files', {
  id: sqliteText('id')
    .primaryKey()
    .$defaultFn(() => {
      // Generate UUID for SQLite
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(
        /[xy]/g,
        function (c) {
          const r = (Math.random() * 16) | 0;
          const v = c === 'x' ? r : (r & 0x3) | 0x8;
          return v.toString(16);
        }
      );
    }),
  filename: sqliteText('filename').notNull(),
  originalName: sqliteText('original_name').notNull(),
  path: sqliteText('path').notNull(),
  url: sqliteText('url').notNull(),
  mimeType: sqliteText('mime_type').notNull(),
  size: integer('size').notNull(),
  communityId: integer('community_id')
    .notNull()
    .references(() => communitiesSqlite.id),
  uploadedBy: integer('uploaded_by')
    .notNull()
    .references(() => usersSqlite.id),
  metadata: sqliteText('metadata'), // JSON string for SQLite
  culturalRestrictions: sqliteText('cultural_restrictions'), // JSON string
  isActive: integer('is_active', { mode: 'boolean' }).default(true).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

// Dynamic table selection based on database type
export async function getFilesTable() {
  const { getConfig } = await import('../../shared/config/index.js');
  const config = getConfig();
  const isPostgres =
    config.database.url.startsWith('postgresql://') ||
    config.database.url.startsWith('postgres://');
  return isPostgres ? filesPg : filesSqlite;
}

// File metadata schema for validation
export const FileMetadataSchema = z
  .object({
    width: z.number().optional(),
    height: z.number().optional(),
    duration: z.number().optional(),
    fps: z.number().optional(),
    bitrate: z.number().optional(),
    channels: z.number().optional(),
    sampleRate: z.number().optional(),
    codec: z.string().optional(),
    exif: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

// Cultural restrictions schema
export const CulturalRestrictionsSchema = z
  .object({
    elderOnly: z.boolean().optional(),
    ceremonialUse: z.boolean().optional(),
    seasonalAccess: z
      .object({
        startMonth: z.number().min(1).max(12),
        endMonth: z.number().min(1).max(12),
      })
      .optional(),
    accessLevel: z
      .enum(['public', 'community', 'family', 'individual'])
      .optional(),
    permission: z
      .object({
        required: z.boolean(),
        grantedBy: z.array(z.string()),
      })
      .optional(),
  })
  .strict();

// Zod schemas for validation - use SQLite schema for broader compatibility
export const insertFileSchema = createInsertSchema(filesSqlite, {
  filename: z
    .string()
    .min(1, 'Filename cannot be empty')
    .max(255, 'Filename too long'),
  originalName: z
    .string()
    .min(1, 'Original name cannot be empty')
    .max(255, 'Original name too long'),
  path: z.string().min(1, 'Path cannot be empty'),
  url: z.string().url('Invalid URL format'),
  mimeType: z
    .string()
    .regex(/^[a-z]+\/[a-z0-9\-+.]+$/i, 'Invalid MIME type format'),
  size: z.number().int().positive('File size must be positive'),
  communityId: z
    .number()
    .int()
    .positive('Community ID must be a positive integer'),
  uploadedBy: z.number().int().positive('User ID must be a positive integer'),
  metadata: FileMetadataSchema.optional(),
  culturalRestrictions: CulturalRestrictionsSchema.optional(),
  isActive: z.boolean().default(true),
});

export const selectFileSchema = createSelectSchema(filesSqlite);

// Update schema (all fields optional except ID)
export const updateFileSchema = insertFileSchema.partial().extend({
  id: z.string().uuid('Invalid file ID'),
  updatedAt: z.date().optional(),
});

// TypeScript types
export type File = typeof filesSqlite.$inferSelect;
export type NewFile = typeof filesSqlite.$inferInsert;
export type UpdateFile = z.infer<typeof updateFileSchema>;
export type FileMetadata = z.infer<typeof FileMetadataSchema>;
export type CulturalRestrictions = z.infer<typeof CulturalRestrictionsSchema>;

// Helper type for file upload results
export interface FileUploadResult {
  id: string;
  filename: string;
  originalName: string;
  path: string;
  url: string;
  size: number;
  mimeType: string;
  communityId: number;
  uploadedBy: number;
  metadata?: FileMetadata;
  culturalRestrictions?: CulturalRestrictions;
  createdAt: Date;
}

// Helper type for file upload options
export interface FileUploadOptions {
  maxSize?: number;
  allowedTypes?: string[];
  communityId: number;
  uploadedBy: number;
  generateUniqueName?: boolean;
  culturalRestrictions?: CulturalRestrictions;
}

// Use SQLite table as default export for Drizzle Kit compatibility
export const files = filesSqlite;

// Export the PostgreSQL table for production use
export { filesPg as filesPostgres };
