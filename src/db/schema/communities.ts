/**
 * Communities table schema with multi-database support
 *
 * Supports both PostgreSQL (production) and SQLite (development/testing)
 * Follows the same pattern as users.ts and stories.ts for consistency
 *
 * Features:
 * - Root tenant entity for multi-tenant architecture
 * - Public/private story sharing configuration
 * - Cross-database compatibility (PostgreSQL/SQLite)
 * - Indigenous community configuration support
 */

import {
  pgTable,
  serial,
  text as pgText,
  timestamp,
  boolean,
} from 'drizzle-orm/pg-core';
import {
  sqliteTable,
  integer,
  text as sqliteText,
} from 'drizzle-orm/sqlite-core';
import { createInsertSchema, createSelectSchema } from 'drizzle-zod';
import { z } from 'zod';

// PostgreSQL table for production
export const communitiesPg = pgTable('communities', {
  id: serial('id').primaryKey(),
  name: pgText('name').notNull(),
  description: pgText('description'),
  slug: pgText('slug').notNull().unique(),
  publicStories: boolean('public_stories').notNull().default(false),
  locale: pgText('locale').notNull().default('en'),
  culturalSettings: pgText('cultural_settings'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// SQLite table for development/testing
export const communitiesSqlite = sqliteTable('communities', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: sqliteText('name').notNull(),
  description: sqliteText('description'),
  slug: sqliteText('slug').notNull().unique(),
  publicStories: integer('public_stories', { mode: 'boolean' })
    .notNull()
    .default(false),
  locale: sqliteText('locale').notNull().default('en'),
  culturalSettings: sqliteText('cultural_settings'),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Dynamic table selection based on database type (for runtime use)
// Note: This function imports getConfig at runtime to avoid circular dependencies during migration
export async function getCommunitiesTable() {
  // Dynamic import to avoid issues with Drizzle Kit during migration generation
  const { getConfig } = await import('../../shared/config/index.js');
  const config = getConfig();
  const isPostgres =
    config.database.url.startsWith('postgresql://') ||
    config.database.url.startsWith('postgres://');

  return isPostgres ? communitiesPg : communitiesSqlite;
}

// Zod schemas for validation - using PostgreSQL table as base for consistency
export const insertCommunitySchema = createInsertSchema(communitiesPg, {
  name: z.string().min(1, 'Name is required').max(100, 'Name too long'),
  description: z.string().max(1000, 'Description too long').optional(),
  slug: z.string().min(1, 'Slug is required').max(50, 'Slug too long'),
  locale: z.string().min(2).max(5).default('en'),
  culturalSettings: z
    .string()
    .max(2000, 'Cultural settings too long')
    .optional(),
  publicStories: z.boolean().default(false),
  isActive: z.boolean().default(true),
});

export const selectCommunitySchema = createSelectSchema(communitiesPg);

// TypeScript types
export type Community = typeof communitiesPg.$inferSelect;
export type NewCommunity = typeof communitiesPg.$inferInsert;

// Additional validation schemas for specific use cases
export const createCommunitySchema = insertCommunitySchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const updateCommunitySchema = insertCommunitySchema.partial().omit({
  id: true,
  createdAt: true,
  slug: true, // Don't allow changing slug
});

// Export table variants for migration generation
// The default export uses PostgreSQL table for Drizzle Kit
export const communities = communitiesPg;
