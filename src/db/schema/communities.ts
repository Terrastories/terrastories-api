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
} from 'drizzle-orm/pg-core';
import {
  sqliteTable,
  integer,
  text as sqliteText,
} from 'drizzle-orm/sqlite-core';
import { createInsertSchema, createSelectSchema } from 'drizzle-zod';
import { z } from 'zod';

export const CountryCodeSchema = z
  .string()
  .length(2, 'Country code must be 2 characters')
  .regex(/^[A-Z]{2}$/, 'Country code must be uppercase letters')
  .optional();

export const communitiesPg = pgTable('communities', {
  id: serial('id').primaryKey(),
  name: pgText('name').notNull(),
  description: pgText('description'),
  slug: pgText('slug').notNull().unique(),
  publicStories: boolean('public_stories').notNull().default(false),
  locale: pgText('locale').notNull().default('en'),
  culturalSettings: pgText('cultural_settings'),
  isActive: boolean('is_active').notNull().default(true),
  country: pgText('country'),
  beta: boolean('beta').notNull().default(false),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

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
  country: sqliteText('country'),
  beta: integer('beta', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
});

export async function getCommunitiesTable() {
  const { getConfig } = await import('../../shared/config/index.js');
  const config = getConfig();
  const isPostgres =
    config.database.url.startsWith('postgresql://') ||
    config.database.url.startsWith('postgres://');

  return isPostgres ? communitiesPg : communitiesSqlite;
}

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
  country: CountryCodeSchema,
  beta: z.boolean().default(false),
});

export const selectCommunitySchema = createSelectSchema(communitiesPg);

export type Community = typeof communitiesSqlite.$inferSelect;
export type NewCommunity = typeof communitiesSqlite.$inferInsert;

export const createCommunitySchema = insertCommunitySchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const updateCommunitySchema = insertCommunitySchema.partial().omit({
  id: true,
  createdAt: true,
  slug: true,
});

export const communities = communitiesPg;
