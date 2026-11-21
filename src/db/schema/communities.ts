/**
 * Communities table schema with multi-database support
 *
 * Supports both PostgreSQL and SQLite/D1-compatible deployments.
 */

import {
  pgTable,
  serial,
  text as pgText,
  timestamp,
  boolean,
  bigint,
} from 'drizzle-orm/pg-core';
import {
  sqliteTable,
  integer,
  text as sqliteText,
} from 'drizzle-orm/sqlite-core';
import { createInsertSchema, createSelectSchema } from 'drizzle-zod';
import { z } from 'zod';

// Country code validation schema (ISO 3166-1 alpha-2 format)
export const CountryCodeSchema = z
  .string()
  .length(2, 'Country code must be 2 characters')
  .regex(/^[A-Z]{2}$/, 'Country code must be uppercase letters')
  .optional();

// PostgreSQL table for production
export const communitiesPg = pgTable('communities', {
  id: serial('id').primaryKey(),
  name: pgText('name').notNull(),
  description: pgText('description'),
  descriptionPlain: pgText('description_plain'),
  slug: pgText('slug').notNull().unique(),
  publicStories: boolean('public_stories').notNull().default(false),
  locale: pgText('locale').notNull().default('en'),
  culturalSettings: pgText('cultural_settings'),
  isActive: boolean('is_active').notNull().default(true),
  country: pgText('country'),
  beta: boolean('beta').notNull().default(false),
  createdAt: timestamp('created_at', { precision: 3 }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { precision: 3 }).defaultNow().notNull(),
  deprovisionedAt: bigint('deprovisioned_at', { mode: 'number' }),
});

// SQLite table for development/testing
export const communitiesSqlite = sqliteTable('communities', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: sqliteText('name').notNull(),
  description: sqliteText('description'),
  descriptionPlain: sqliteText('description_plain'),
  slug: sqliteText('slug').notNull().unique(),
  publicStories: integer('public_stories', { mode: 'boolean' })
    .notNull()
    .default(false),
  locale: sqliteText('locale').notNull().default('en'),
  culturalSettings: sqliteText('cultural_settings'),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  country: sqliteText('country'),
  beta: integer('beta', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
  // Millisecond epoch tombstone set on logical deprovision (PR #257 / Slice 14).
  // Plain integer (not timestamp_ms) matching sessions/claim_tokens epoch columns.
  deprovisionedAt: integer('deprovisioned_at'),
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
  slug: z
    .string()
    .min(1, 'Slug is required')
    .max(50, 'Slug too long')
    .refine(
      (slug) => !slug.startsWith('deprovisioned-'),
      'Slug uses the reserved deprovisioned namespace'
    ),
  locale: z.string().min(2).max(5).default('en'),
  culturalSettings: z
    .string()
    .max(2000, 'Cultural settings too long')
    .optional(),
  publicStories: z.boolean().default(false),
  isActive: z.boolean().default(true),
  country: CountryCodeSchema,
  beta: z.boolean().default(false),
});

export const selectCommunitySchema = createSelectSchema(communitiesPg);

// TypeScript types - Use SQLite for consistency with current deployment
export type Community = typeof communitiesSqlite.$inferSelect;
export type NewCommunity = typeof communitiesSqlite.$inferInsert;

// Additional validation schemas for specific use cases
export const createCommunitySchema = insertCommunitySchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  deprovisionedAt: true,
});

export const updateCommunitySchema = insertCommunitySchema
  .extend({
    locale: insertCommunitySchema.shape.locale.removeDefault(),
    publicStories: insertCommunitySchema.shape.publicStories.removeDefault(),
    isActive: insertCommunitySchema.shape.isActive.removeDefault(),
    beta: insertCommunitySchema.shape.beta.removeDefault(),
  })
  .partial()
  .omit({
    id: true,
    createdAt: true,
    slug: true, // Don't allow changing slug
    deprovisionedAt: true,
  });

// Export table variants for migration generation
// The default export uses PostgreSQL table for Drizzle Kit
export const communities = communitiesPg;
