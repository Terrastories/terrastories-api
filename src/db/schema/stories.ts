/**
 * Stories table schema with multi-database support
 *
 * Supports both PostgreSQL (production) and SQLite (development/testing)
 * Follows the same pattern as users.ts for consistency
 *
 * Features:
 * - Multi-tenant data isolation via communityId
 * - Cultural sensitivity with restriction flags
 * - Media URL arrays for rich content
 * - Cross-database compatibility (PostgreSQL/SQLite)
 * - Author tracking and community scoping
 */

import {
  pgTable,
  serial,
  text as pgText,
  timestamp,
  boolean,
  integer as pgInteger,
  jsonb,
} from 'drizzle-orm/pg-core';
import {
  sqliteTable,
  integer,
  text as sqliteText,
} from 'drizzle-orm/sqlite-core';
import { relations } from 'drizzle-orm';
import { createInsertSchema, createSelectSchema } from 'drizzle-zod';
import { z } from 'zod';
import { communitiesPg, communitiesSqlite } from './communities.js';
import { usersPg } from './users.js';
import { placesPg, placesSqlite } from './places.js';
import { speakersPg, speakersSqlite } from './speakers.js';

// Media URL validation schema
export const MediaUrlSchema = z.string().url('Invalid media URL format');

// PostgreSQL table for production
export const storiesPg = pgTable('stories', {
  id: serial('id').primaryKey(),
  title: pgText('title').notNull(),
  description: pgText('description'),
  slug: pgText('slug').notNull(),
  communityId: pgInteger('community_id').notNull(),
  createdBy: pgInteger('created_by').notNull(),
  isRestricted: boolean('is_restricted').notNull().default(false),
  privacyLevel: pgText('privacy_level').notNull().default('public'),
  mediaUrls: jsonb('media_urls').$type<string[]>().default([]),
  language: pgText('language').notNull().default('en'),
  tags: jsonb('tags').$type<string[]>().default([]),
  // Interview metadata fields for Indigenous storytelling context
  dateInterviewed: timestamp('date_interviewed'),
  interviewLocationId: pgInteger('interview_location_id').references(
    () => placesPg.id
  ),
  interviewerId: pgInteger('interviewer_id').references(() => speakersPg.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// SQLite table for development/testing
export const storiesSqlite = sqliteTable('stories', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: sqliteText('title').notNull(),
  description: sqliteText('description'),
  slug: sqliteText('slug').notNull(),
  communityId: integer('community_id')
    .notNull()
    .references(() => communitiesSqlite.id),
  createdBy: integer('created_by').notNull(),
  isRestricted: integer('is_restricted', { mode: 'boolean' })
    .notNull()
    .default(false),
  privacyLevel: sqliteText('privacy_level').notNull().default('public'),
  mediaUrls: sqliteText('media_urls', { mode: 'json' })
    .$type<string[]>()
    .default([]),
  language: sqliteText('language').notNull().default('en'),
  tags: sqliteText('tags', { mode: 'json' }).$type<string[]>().default([]),
  // Interview metadata fields for Indigenous storytelling context
  dateInterviewed: integer('date_interviewed', { mode: 'timestamp' }),
  interviewLocationId: integer('interview_location_id').references(
    () => placesSqlite.id
  ),
  interviewerId: integer('interviewer_id').references(() => speakersSqlite.id),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Dynamic table selection based on database type (for runtime use)
// Note: This function imports getConfig at runtime to avoid circular dependencies during migration
export async function getStoriesTable() {
  // Dynamic import to avoid issues with Drizzle Kit during migration generation
  const { getConfig } = await import('../../shared/config/index.js');
  const config = getConfig();
  const isPostgres =
    config.database.url.startsWith('postgresql://') ||
    config.database.url.startsWith('postgres://');

  return isPostgres ? storiesPg : storiesSqlite;
}

// Relations - Stories belong to one community and one author, and have many-to-many with places and speakers
export const storiesRelations = relations(
  storiesPg,
  ({ one, many: _many }) => ({
    community: one(communitiesPg, {
      fields: [storiesPg.communityId],
      references: [communitiesPg.id],
    }),
    author: one(usersPg, {
      fields: [storiesPg.createdBy],
      references: [usersPg.id],
    }),
    // Interview metadata relations
    interviewLocation: one(placesPg, {
      fields: [storiesPg.interviewLocationId],
      references: [placesPg.id],
    }),
    interviewer: one(speakersPg, {
      fields: [storiesPg.interviewerId],
      references: [speakersPg.id],
    }),
    // Many-to-many relations through join tables (will be available after join tables are created)
    // storyPlaces: many(storyPlaces),
    // storySpeakers: many(storySpeakers),
  })
);

// SQLite relations (same structure)
export const storiesSqliteRelations = relations(
  storiesSqlite,
  ({ one, many: _many }) => ({
    community: one(communitiesPg, {
      fields: [storiesSqlite.communityId],
      references: [communitiesPg.id],
    }),
    author: one(usersPg, {
      fields: [storiesSqlite.createdBy],
      references: [usersPg.id],
    }),
    // Interview metadata relations
    interviewLocation: one(placesSqlite, {
      fields: [storiesSqlite.interviewLocationId],
      references: [placesSqlite.id],
    }),
    interviewer: one(speakersSqlite, {
      fields: [storiesSqlite.interviewerId],
      references: [speakersSqlite.id],
    }),
    // Many-to-many relations through join tables (will be available after join tables are created)
    // storyPlaces: many(storyPlaces),
    // storySpeakers: many(storySpeakers),
  })
);

// Zod schemas for validation - using PostgreSQL table as base for consistency
export const insertStorySchema = createInsertSchema(storiesPg, {
  title: z.string().min(1, 'Title is required').max(500, 'Title too long'),
  description: z.string().max(5000, 'Description too long').optional(),
  slug: z
    .string()
    .min(1, 'Slug is required')
    .max(100, 'Slug too long')
    .regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens'),
  mediaUrls: z.array(MediaUrlSchema).default([]),
  language: z.string().min(2).max(5).default('en'),
  tags: z.array(z.string().min(1).max(50)).default([]),
  isRestricted: z.boolean().default(false),
  // Interview metadata validation with cultural protocol considerations
  dateInterviewed: z.coerce.date().optional(),
  interviewLocationId: z
    .number()
    .int()
    .positive('Interview location ID must be positive')
    .optional(),
  interviewerId: z
    .number()
    .int()
    .positive('Interviewer ID must be positive')
    .optional(),
});

export const selectStorySchema = createSelectSchema(storiesPg);

// TypeScript types
// For development/test environments using SQLite
export type Story = typeof storiesSqlite.$inferSelect;
export type NewStory = typeof storiesSqlite.$inferInsert;

// Additional validation schemas for specific use cases
export const createStorySchema = insertStorySchema
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    slug: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9-]+$/)
      .optional(), // Optional for create, auto-generated from title
  });

export const updateStorySchema = insertStorySchema.partial().omit({
  id: true,
  createdAt: true,
  communityId: true, // Don't allow changing community
});

// Export table variants for migration generation
// The default export uses PostgreSQL table for Drizzle Kit
export const stories = storiesPg;
