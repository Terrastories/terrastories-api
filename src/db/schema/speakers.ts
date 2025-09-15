/**
 * Speakers table schema with multi-database support
 *
 * Supports both PostgreSQL (production) and SQLite (development/testing)
 * Follows the same pattern as users.ts for consistency
 *
 * Features:
 * - Multi-tenant data isolation via communityId
 * - Cultural sensitivity with elder status and cultural roles
 * - Indigenous community considerations
 * - Cross-database compatibility (PostgreSQL/SQLite)
 * - Active/inactive status for speaker management
 */

import {
  pgTable,
  serial,
  text as pgText,
  timestamp,
  boolean,
  integer as pgInteger,
  index,
} from 'drizzle-orm/pg-core';
import {
  sqliteTable,
  integer,
  text as sqliteText,
  index as sqliteIndex,
} from 'drizzle-orm/sqlite-core';
import { relations } from 'drizzle-orm';
import { createInsertSchema, createSelectSchema } from 'drizzle-zod';
import { z } from 'zod';
import { communitiesPg, communitiesSqlite } from './communities.js';

// Cultural role validation schema
export const CulturalRoleSchema = z.string().min(1).max(100);

// PostgreSQL table for production
export const speakersPg = pgTable(
  'speakers',
  {
    id: serial('id').primaryKey(),
    name: pgText('name').notNull(),
    bio: pgText('bio'),
    communityId: pgInteger('community_id').notNull(),
    photoUrl: pgText('photo_url'),
    // Direct file URL column for dual-read capability (Issue #89)
    bioAudioUrl: pgText('bio_audio_url'),
    birthYear: pgInteger('birth_year'),
    elderStatus: boolean('elder_status').notNull().default(false),
    culturalRole: pgText('cultural_role'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    // Standard indexes for filtering
    communityIdx: index('speakers_community_id_idx').on(table.communityId),
    // Index for bio audio URL queries (for media management)
    bioAudioUrlIdx: index('speakers_bio_audio_url_idx').on(table.bioAudioUrl),
    // Cultural and organizational indexes
    elderStatusIdx: index('speakers_elder_status_idx').on(table.elderStatus),
    culturalRoleIdx: index('speakers_cultural_role_idx').on(table.culturalRole),
    activeIdx: index('speakers_is_active_idx').on(table.isActive),
  })
);

// SQLite table for development/testing
export const speakersSqlite = sqliteTable(
  'speakers',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: sqliteText('name').notNull(),
    bio: sqliteText('bio'),
    communityId: integer('community_id')
      .notNull()
      .references(() => communitiesSqlite.id),
    photoUrl: sqliteText('photo_url'),
    // Direct file URL column for dual-read capability (Issue #89)
    bioAudioUrl: sqliteText('bio_audio_url'),
    birthYear: integer('birth_year'),
    elderStatus: integer('elder_status', { mode: 'boolean' })
      .notNull()
      .default(false),
    culturalRole: sqliteText('cultural_role'),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => ({
    // Standard indexes for filtering
    communityIdx: sqliteIndex('speakers_community_id_idx').on(
      table.communityId
    ),
    // Index for bio audio URL queries (for media management)
    bioAudioUrlIdx: sqliteIndex('speakers_bio_audio_url_idx').on(
      table.bioAudioUrl
    ),
    // Cultural and organizational indexes
    elderStatusIdx: sqliteIndex('speakers_elder_status_idx').on(
      table.elderStatus
    ),
    culturalRoleIdx: sqliteIndex('speakers_cultural_role_idx').on(
      table.culturalRole
    ),
    activeIdx: sqliteIndex('speakers_is_active_idx').on(table.isActive),
  })
);

// Dynamic table selection based on database type (for runtime use)
// Note: This function imports getConfig at runtime to avoid circular dependencies during migration
export async function getSpeakersTable() {
  // Dynamic import to avoid issues with Drizzle Kit during migration generation
  const { getConfig } = await import('../../shared/config/index.js');
  const config = getConfig();
  const isPostgres =
    config.database.url.startsWith('postgresql://') ||
    config.database.url.startsWith('postgres://');

  return isPostgres ? speakersPg : speakersSqlite;
}

// Relations - Speakers belong to one community
export const speakersRelations = relations(speakersPg, ({ one }) => ({
  community: one(communitiesPg, {
    fields: [speakersPg.communityId],
    references: [communitiesPg.id],
  }),
}));

// SQLite relations (same structure)
export const speakersSqliteRelations = relations(speakersSqlite, ({ one }) => ({
  community: one(communitiesPg, {
    fields: [speakersSqlite.communityId],
    references: [communitiesPg.id],
  }),
}));

// Zod schemas for validation - using PostgreSQL table as base for consistency
export const insertSpeakerSchema = createInsertSchema(speakersPg, {
  name: z.string().min(1, 'Name is required').max(200, 'Name too long'),
  bio: z.string().max(2000, 'Bio too long').optional(),
  photoUrl: z.string().url('Invalid photo URL').optional(),
  birthYear: z
    .number()
    .int()
    .min(1900, 'Birth year too early')
    .max(new Date().getFullYear(), 'Birth year cannot be in the future')
    .optional(),
  culturalRole: CulturalRoleSchema.optional(),
  elderStatus: z.boolean().default(false),
  isActive: z.boolean().default(true),
});

export const selectSpeakerSchema = createSelectSchema(speakersPg);

// TypeScript types - Use SQLite for consistency with current deployment
export type Speaker = typeof speakersSqlite.$inferSelect;
export type NewSpeaker = typeof speakersSqlite.$inferInsert;

// Additional validation schemas for specific use cases
export const createSpeakerSchema = insertSpeakerSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const updateSpeakerSchema = insertSpeakerSchema.partial().omit({
  id: true,
  createdAt: true,
  communityId: true, // Don't allow changing community
});

// Export table variants for migration generation
// The default export uses PostgreSQL table for Drizzle Kit
export const speakers = speakersPg;
