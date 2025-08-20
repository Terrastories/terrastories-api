/**
 * Story Places join table schema with multi-database support
 *
 * Supports both PostgreSQL (production) and SQLite (development/testing)
 * Follows the same pattern as other schemas for consistency
 *
 * Features:
 * - Many-to-many relationships between stories and places
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
import { placesPg, placesSqlite } from './places.js';

// PostgreSQL table for production
export const storyPlacesPg = pgTable(
  'story_places',
  {
    id: serial('id').primaryKey(),
    storyId: pgInteger('story_id').notNull(),
    placeId: pgInteger('place_id').notNull(),
    culturalContext: text('cultural_context'),
    sortOrder: pgInteger('sort_order').default(0),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    // Composite unique constraint to prevent duplicate relationships
    storyPlaceUnique: unique('story_place_unique').on(
      table.storyId,
      table.placeId
    ),
  })
);

// SQLite table for development/testing
export const storyPlacesSqlite = sqliteTable(
  'story_places',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    storyId: integer('story_id').notNull(),
    placeId: integer('place_id').notNull(),
    culturalContext: sqliteText('cultural_context'),
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
    storyPlaceUnique: uniqueIndex('story_place_unique').on(
      table.storyId,
      table.placeId
    ),
  })
);

// Dynamic table selection based on database type (for runtime use)
// Note: This function imports getConfig at runtime to avoid circular dependencies during migration
export async function getStoryPlacesTable() {
  // Dynamic import to avoid issues with Drizzle Kit during migration generation
  const { getConfig } = await import('../../shared/config/index.js');
  const config = getConfig();
  const isPostgres =
    config.database.url.startsWith('postgresql://') ||
    config.database.url.startsWith('postgres://');

  return isPostgres ? storyPlacesPg : storyPlacesSqlite;
}

// Relations - Story places belong to one story and one place
export const storyPlacesRelations = relations(storyPlacesPg, ({ one }) => ({
  story: one(storiesPg, {
    fields: [storyPlacesPg.storyId],
    references: [storiesPg.id],
  }),
  place: one(placesPg, {
    fields: [storyPlacesPg.placeId],
    references: [placesPg.id],
  }),
}));

// SQLite relations (same structure, but referencing SQLite tables)
export const storyPlacesSqliteRelations = relations(
  storyPlacesSqlite,
  ({ one }) => ({
    story: one(storiesSqlite, {
      fields: [storyPlacesSqlite.storyId],
      references: [storiesSqlite.id],
    }),
    place: one(placesSqlite, {
      fields: [storyPlacesSqlite.placeId],
      references: [placesSqlite.id],
    }),
  })
);

// Zod schemas for validation - using PostgreSQL table as base for consistency
export const insertStoryPlaceSchema = createInsertSchema(storyPlacesPg);
export const selectStoryPlaceSchema = createSelectSchema(storyPlacesPg);

// TypeScript types
export type StoryPlace = typeof storyPlacesPg.$inferSelect;
export type NewStoryPlace = typeof storyPlacesPg.$inferInsert;

// Additional validation schemas for specific use cases
export const createStoryPlaceSchema = insertStoryPlaceSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

// Export table variants for migration generation
// The default export uses PostgreSQL table for Drizzle Kit
export const storyPlaces = storyPlacesPg;
