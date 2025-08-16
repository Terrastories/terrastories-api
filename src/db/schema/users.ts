/**
 * Users table schema with multi-database support
 *
 * Supports both PostgreSQL (production) and SQLite (development/testing)
 * Follows the same pattern as places.ts for consistency
 *
 * Features:
 * - Multi-tenant data isolation via communityId
 * - Role-based access control with enum validation
 * - Cross-database compatibility (PostgreSQL/SQLite)
 */

import {
  pgTable,
  serial,
  text as pgText,
  timestamp,
  boolean,
  integer as pgInteger,
} from 'drizzle-orm/pg-core';
import {
  sqliteTable,
  integer,
  text as sqliteText,
} from 'drizzle-orm/sqlite-core';
import { relations } from 'drizzle-orm';
import { createInsertSchema, createSelectSchema } from 'drizzle-zod';
import { z } from 'zod';
import { communities } from './communities.js';

// Role enum validation
export const UserRoleSchema = z.enum([
  'super_admin',
  'admin',
  'editor',
  'viewer',
]);
export type UserRole = z.infer<typeof UserRoleSchema>;

// PostgreSQL table for production
export const usersPg = pgTable('users', {
  id: serial('id').primaryKey(),
  email: pgText('email').notNull().unique(),
  passwordHash: pgText('password_hash').notNull(),
  firstName: pgText('first_name').notNull(),
  lastName: pgText('last_name').notNull(),
  role: pgText('role', {
    enum: ['super_admin', 'admin', 'editor', 'viewer'],
  })
    .notNull()
    .default('viewer'),
  communityId: pgInteger('community_id').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// SQLite table for development/testing
export const usersSqlite = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  email: sqliteText('email').notNull().unique(),
  passwordHash: sqliteText('password_hash').notNull(),
  firstName: sqliteText('first_name').notNull(),
  lastName: sqliteText('last_name').notNull(),
  role: sqliteText('role', {
    enum: ['super_admin', 'admin', 'editor', 'viewer'],
  })
    .notNull()
    .default('viewer'),
  communityId: integer('community_id').notNull(),
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
export async function getUsersTable() {
  // Dynamic import to avoid issues with Drizzle Kit during migration generation
  const { getConfig } = await import('../../shared/config/index.js');
  const config = getConfig();
  const isPostgres =
    config.database.url.startsWith('postgresql://') ||
    config.database.url.startsWith('postgres://');

  return isPostgres ? usersPg : usersSqlite;
}

// Relations - Users belong to one community
export const usersRelations = relations(usersPg, ({ one }) => ({
  community: one(communities, {
    fields: [usersPg.communityId],
    references: [communities.id],
  }),
}));

// Communities have many users (reverse relation)
export const communitiesRelations = relations(communities, ({ many }) => ({
  users: many(usersPg),
}));

// SQLite relations (same structure)
export const usersSqliteRelations = relations(usersSqlite, ({ one }) => ({
  community: one(communities, {
    fields: [usersSqlite.communityId],
    references: [communities.id],
  }),
}));

// Zod schemas for validation - using PostgreSQL table as base for consistency
export const insertUserSchema = createInsertSchema(usersPg, {
  email: z.string().email('Invalid email format'),
  role: UserRoleSchema.default('viewer'),
  isActive: z.boolean().default(true),
});

export const selectUserSchema = createSelectSchema(usersPg);

// TypeScript types
export type User = typeof usersPg.$inferSelect;
export type NewUser = typeof usersPg.$inferInsert;

// Additional validation schemas for specific use cases
export const createUserSchema = insertUserSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const updateUserSchema = insertUserSchema.partial().omit({
  id: true,
  createdAt: true,
});

// Export table variants for migration generation
// The default export uses PostgreSQL table for Drizzle Kit
export const users = usersPg;
