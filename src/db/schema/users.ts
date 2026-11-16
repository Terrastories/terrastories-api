/**
 * Users table schema with equal PostgreSQL and SQLite/D1-compatible semantics.
 */

import {
  pgTable,
  serial,
  text as pgText,
  timestamp,
  boolean,
  integer as pgInteger,
  unique,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import {
  sqliteTable,
  integer,
  text as sqliteText,
  unique as sqliteUnique,
  uniqueIndex as sqliteUniqueIndex,
  index as sqliteIndex,
} from 'drizzle-orm/sqlite-core';
import { relations, sql } from 'drizzle-orm';
import { createInsertSchema, createSelectSchema } from 'drizzle-zod';
import { z } from 'zod';
import { communitiesPg, communitiesSqlite } from './communities.js';

// Physical user roles enum (Zod validation & database enum).
// Retains 'elder' until frozen /api/v1 coexistence ends (Slice 15); V2 boundaries
// must use parseV2Role() from src/shared/authorization/sovereignty-policy.ts.
export const UserRoleSchema = z.enum([
  'super_admin',
  'admin',
  'editor',
  'elder',
  'member',
  'viewer',
]);
export type UserRole = z.infer<typeof UserRoleSchema>;

// PostgreSQL table for production
export const usersPg = pgTable(
  'users',
  {
    id: serial('id').primaryKey(),
    email: pgText('email').notNull(),
    username: pgText('username'),
    displayName: pgText('display_name'),
    passwordHash: pgText('password_hash').notNull(),
    passwordVerifier: pgText('password_verifier'),
    passwordAlgorithm: pgText('password_algorithm'),
    passwordSalt: pgText('password_salt'),
    passwordParams: pgText('password_params'),
    usernameNormalized: pgText('username_normalized'),
    emailNormalized: pgText('email_normalized'),
    firstName: pgText('first_name').notNull(),
    lastName: pgText('last_name').notNull(),
    role: pgText('role', {
      enum: ['super_admin', 'admin', 'editor', 'elder', 'member', 'viewer'],
    })
      .notNull()
      .default('viewer'),
    communityId: pgInteger('community_id').references(() => communitiesPg.id),
    isActive: boolean('is_active').notNull().default(true),
    lastLoginAt: timestamp('last_login_at', { precision: 3 }),
    resetPasswordToken: pgText('reset_password_token'),
    resetPasswordSentAt: timestamp('reset_password_sent_at', {
      precision: 3,
    }),
    rememberCreatedAt: timestamp('remember_created_at', { precision: 3 }),
    signInCount: pgInteger('sign_in_count').default(0).notNull(),
    lastSignInAt: timestamp('last_sign_in_at', { precision: 3 }),
    currentSignInIp: pgText('current_sign_in_ip'),
    createdAt: timestamp('created_at', { precision: 3 }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { precision: 3 }).defaultNow().notNull(),
  },
  (table) => ({
    // Email must be unique within each community, but can be shared across communities
    emailCommunityUnique: unique('users_email_community_unique').on(
      table.email,
      table.communityId
    ),
    usernameNormalizedUnique: uniqueIndex(
      'users_username_normalized_unique'
    ).on(table.usernameNormalized),
    communityEmailNormalizedUnique: uniqueIndex(
      'users_community_email_normalized_unique'
    ).on(table.communityId, table.emailNormalized),
    nullCommunityEmailNormalizedUnique: uniqueIndex(
      'users_null_community_email_normalized_unique'
    )
      .on(table.emailNormalized)
      .where(sql`${table.communityId} IS NULL`),
    resetPasswordTokenIdx: index('idx_users_reset_password_token')
      .on(table.resetPasswordToken)
      .where(sql`${table.resetPasswordToken} IS NOT NULL`),
    communityEmailIdx: index('idx_users_community_email').on(
      table.communityId,
      table.email
    ),
    // Unscoped identifier-first lookup (prelogin/login without a narrowing
    // slug): the composite and null-community email indexes cannot serve it.
    emailNormalizedIdx: index('users_email_normalized_idx').on(
      table.emailNormalized
    ),
  })
);

// SQLite table for development/testing
export const usersSqlite = sqliteTable(
  'users',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    email: sqliteText('email').notNull(),
    username: sqliteText('username'),
    displayName: sqliteText('display_name'),
    passwordHash: sqliteText('password_hash').notNull(),
    passwordVerifier: sqliteText('password_verifier'),
    passwordAlgorithm: sqliteText('password_algorithm'),
    passwordSalt: sqliteText('password_salt'),
    passwordParams: sqliteText('password_params'),
    usernameNormalized: sqliteText('username_normalized'),
    emailNormalized: sqliteText('email_normalized'),
    firstName: sqliteText('first_name').notNull(),
    lastName: sqliteText('last_name').notNull(),
    role: sqliteText('role', {
      enum: ['super_admin', 'admin', 'editor', 'elder', 'member', 'viewer'],
    })
      .notNull()
      .default('viewer'),
    communityId: integer('community_id').references(() => communitiesSqlite.id),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    lastLoginAt: integer('last_login_at', { mode: 'timestamp_ms' }),
    resetPasswordToken: sqliteText('reset_password_token'),
    resetPasswordSentAt: integer('reset_password_sent_at', {
      mode: 'timestamp_ms',
    }),
    rememberCreatedAt: integer('remember_created_at', {
      mode: 'timestamp_ms',
    }),
    signInCount: integer('sign_in_count').default(0).notNull(),
    lastSignInAt: integer('last_sign_in_at', { mode: 'timestamp_ms' }),
    currentSignInIp: sqliteText('current_sign_in_ip'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    // Email must be unique within each community, but can be shared across communities
    emailCommunityUnique: sqliteUnique('users_email_community_unique').on(
      table.email,
      table.communityId
    ),
    usernameNormalizedUnique: sqliteUniqueIndex(
      'users_username_normalized_unique'
    ).on(table.usernameNormalized),
    communityEmailNormalizedUnique: sqliteUniqueIndex(
      'users_community_email_normalized_unique'
    ).on(table.communityId, table.emailNormalized),
    nullCommunityEmailNormalizedUnique: sqliteUniqueIndex(
      'users_null_community_email_normalized_unique'
    )
      .on(table.emailNormalized)
      .where(sql`${table.communityId} IS NULL`),
    resetPasswordTokenIdx: sqliteIndex('idx_users_reset_password_token')
      .on(table.resetPasswordToken)
      .where(sql`${table.resetPasswordToken} IS NOT NULL`),
    communityEmailIdx: sqliteIndex('idx_users_community_email').on(
      table.communityId,
      table.email
    ),
    // Unscoped identifier-first lookup (prelogin/login without a narrowing
    // slug): the composite and null-community email indexes cannot serve it.
    emailNormalizedIdx: sqliteIndex('users_email_normalized_idx').on(
      table.emailNormalized
    ),
  })
);

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
  community: one(communitiesPg, {
    fields: [usersPg.communityId],
    references: [communitiesPg.id],
  }),
}));

// Communities have many users (reverse relation)
export const communitiesRelations = relations(communitiesPg, ({ many }) => ({
  users: many(usersPg),
}));

// SQLite relations (same structure)
export const usersSqliteRelations = relations(usersSqlite, ({ one }) => ({
  community: one(communitiesSqlite, {
    fields: [usersSqlite.communityId],
    references: [communitiesSqlite.id],
  }),
}));

// Zod schemas for validation - using PostgreSQL table as base for consistency
// Frozen V1 insertUserSchema preserves required non-null communityId until Slice 15.
export const insertUserSchema = createInsertSchema(usersPg, {
  email: z.string().email('Invalid email format'),
  role: UserRoleSchema.default('viewer'),
  communityId: z.number().int(),
  isActive: z.boolean().default(true),
  lastLoginAt: z.date().optional(),
  resetPasswordToken: z.string().optional(),
  resetPasswordSentAt: z.date().optional(),
  rememberCreatedAt: z.date().optional(),
  signInCount: z.number().int().min(0).default(0),
  lastSignInAt: z.date().optional(),
  currentSignInIp: z.string().optional(),
});

export const selectUserSchema = createSelectSchema(usersPg);

// TypeScript types - Use SQLite for consistency with current deployment
export type User = typeof usersSqlite.$inferSelect;
export type NewUser = typeof usersSqlite.$inferInsert;
export type CreateUserData = NewUser;
export type UpdateUserData = Partial<NewUser>;

// Additional validation schemas for specific use cases
export const createUserSchema = insertUserSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const updateUserSchema = insertUserSchema
  .extend({
    role: insertUserSchema.shape.role.removeDefault(),
    isActive: insertUserSchema.shape.isActive.removeDefault(),
    signInCount: insertUserSchema.shape.signInCount.removeDefault(),
  })
  .partial()
  .omit({
    id: true,
    createdAt: true,
  });

// Export table variants for migration generation
// Use SQLite table for Drizzle Kit (config determines which is used)
export const users = usersSqlite;
