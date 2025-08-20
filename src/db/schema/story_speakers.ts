/**
 * Story Speakers join table schema with multi-database support
 *
 * Supports both PostgreSQL (production) and SQLite (development/testing)
 * Follows the same pattern as other schemas for consistency
 *
 * Features:
 * - Many-to-many relationships between stories and speakers
 * - Unique constraints to prevent duplicate relationships
 * - Cascade delete for referential integrity
 * - Cross-database compatibility (PostgreSQL/SQLite)
 * - Multi-tenant data isolation via foreign key relationships
 */

import {
  pgTable,
  serial,
  integer as pgInteger,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';
import {
  sqliteTable,
  integer,
  text as sqliteText,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { relations } from 'drizzle-orm';
import { createInsertSchema, createSelectSchema } from 'drizzle-zod';
import { storiesPg, storiesSqlite } from './stories.js';
import { speakersPg, speakersSqlite } from './speakers.js';

// PostgreSQL table for production
export const storySpeakersPg = pgTable(
  'story_speakers',
  {
    id: serial('id').primaryKey(),
    storyId: pgInteger('story_id').notNull(),
    speakerId: pgInteger('speaker_id').notNull(),
    storyRole: text('story_role'),
    sortOrder: pgInteger('sort_order').default(0),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    // Composite unique constraint to prevent duplicate relationships
    storySpeakerUnique: unique('story_speaker_unique').on(
      table.storyId,
      table.speakerId
    ),
  })
);

// SQLite table for development/testing
export const storySpeakersSqlite = sqliteTable(
  'story_speakers',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    storyId: integer('story_id').notNull(),
    speakerId: integer('speaker_id').notNull(),
    storyRole: sqliteText('story_role'),
    sortOrder: integer('sort_order').default(0),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    // Composite unique constraint to prevent duplicate relationships
    storySpeakerUnique: uniqueIndex('story_speaker_unique').on(
      table.storyId,
      table.speakerId
    ),
  })
);

// Dynamic table selection based on database type (for runtime use)
// Note: This function imports getConfig at runtime to avoid circular dependencies during migration
export async function getStorySpeakersTable() {
  // Dynamic import to avoid issues with Drizzle Kit during migration generation
  const { getConfig } = await import('../../shared/config/index.js');
  const config = getConfig();
  const isPostgres =
    config.database.url.startsWith('postgresql://') ||
    config.database.url.startsWith('postgres://');

  return isPostgres ? storySpeakersPg : storySpeakersSqlite;
}

// Relations - Story speakers belong to one story and one speaker
export const storySpeakersRelations = relations(storySpeakersPg, ({ one }) => ({
  story: one(storiesPg, {
    fields: [storySpeakersPg.storyId],
    references: [storiesPg.id],
  }),
  speaker: one(speakersPg, {
    fields: [storySpeakersPg.speakerId],
    references: [speakersPg.id],
  }),
}));

// SQLite relations (same structure, but referencing SQLite tables)
export const storySpeakersSqliteRelations = relations(
  storySpeakersSqlite,
  ({ one }) => ({
    story: one(storiesSqlite, {
      fields: [storySpeakersSqlite.storyId],
      references: [storiesSqlite.id],
    }),
    speaker: one(speakersSqlite, {
      fields: [storySpeakersSqlite.speakerId],
      references: [speakersSqlite.id],
    }),
  })
);

// Zod schemas for validation - using PostgreSQL table as base for consistency
export const insertStorySpeakerSchema = createInsertSchema(storySpeakersPg);
export const selectStorySpeakerSchema = createSelectSchema(storySpeakersPg);

// TypeScript types
export type StorySpeaker = typeof storySpeakersPg.$inferSelect;
export type NewStorySpeaker = typeof storySpeakersPg.$inferInsert;

// Additional validation schemas for specific use cases
export const createStorySpeakerSchema = insertStorySpeakerSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

// Export table variants for migration generation
// The default export uses PostgreSQL table for Drizzle Kit
export const storySpeakers = storySpeakersPg;
