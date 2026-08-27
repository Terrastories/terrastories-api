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
} from 'drizzle-orm/pg-core';
import {
  sqliteTable,
  integer,
  text as sqliteText,
  unique as sqliteUnique,
} from 'drizzle-orm/sqlite-core';
import { relations } from 'drizzle-orm';
import { createInsertSchema, createSelectSchema } from 'drizzle-zod';
import { z } from 'zod';
import { communitiesPg, communitiesSqlite } from './communities.js';

export const UserRoleSchema = z.enum([
  'super_admin',
  'admin',
  'editor',
  'elder',
  'viewer',
]);
export type UserRole = z.infer<typeof UserRoleSchema>;

export const usersPg = pgTable(
  'users',
  {
    id: serial('id').primaryKey(),
    email: pgText('email').notNull(),
    passwordHash: pgText('password_hash').notNull(),
    firstName: pgText('first_name').notNull(),
    lastName: pgText('last_name').notNull(),
    role: pgText('role', {
      enum: ['super_admin', 'admin', 'editor', 'elder', 'viewer'],
    })
      .notNull()
      .default('viewer'),
    communityId: pgInteger('community_id')
      .notNull()
      .references(() => communitiesPg.id),
    isActive: boolean('is_active').notNull().default(true),
    lastLoginAt: timestamp('last_login_at'),
    resetPasswordToken: pgText('reset_password_token'),
    resetPasswordSentAt: timestamp('reset_password_sent_at'),
    rememberCreatedAt: timestamp('remember_created_at'),
    signInCount: pgInteger('sign_in_count').default(0).notNull(),
    lastSignInAt: timestamp('last_sign_in_at'),
    currentSignInIp: pgText('current_sign_in_ip'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    emailCommunityUnique: unique('users_email_community_unique').on(
      table.email,
      table.communityId
    ),
  })
);

export const usersSqlite = sqliteTable(
  'users',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    email: sqliteText('email').notNull(),
    passwordHash: sqliteText('password_hash').notNull(),
    firstName: sqliteText('first_name').notNull(),
    lastName: sqliteText('last_name').notNull(),
    role: sqliteText('role', {
      enum: ['super_admin', 'admin', 'editor', 'elder', 'viewer'],
    })
      .notNull()
      .default('viewer'),
    communityId: integer('community_id')
      .notNull()
      .references(() => communitiesSqlite.id),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    lastLoginAt: integer('last_login_at', { mode: 'timestamp' }),
    resetPasswordToken: sqliteText('reset_password_token'),
    resetPasswordSentAt: integer('reset_password_sent_at', {
      mode: 'timestamp',
    }),
    rememberCreatedAt: integer('remember_created_at', { mode: 'timestamp' }),
    signInCount: integer('sign_in_count').default(0).notNull(),
    lastSignInAt: integer('last_sign_in_at', { mode: 'timestamp' }),
    currentSignInIp: sqliteText('current_sign_in_ip'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    emailCommunityUnique: sqliteUnique('users_email_community_unique').on(
      table.email,
      table.communityId
    ),
  })
);

export async function getUsersTable() {
  const { getConfig } = await import('../../shared/config/index.js');
  const config = getConfig();
  const isPostgres =
    config.database.url.startsWith('postgresql://') ||
    config.database.url.startsWith('postgres://');

  return isPostgres ? usersPg : usersSqlite;
}

export const usersRelations = relations(usersPg, ({ one }) => ({
  community: one(communitiesPg, {
    fields: [usersPg.communityId],
    references: [communitiesPg.id],
  }),
}));

export const communitiesRelations = relations(communitiesPg, ({ many }) => ({
  users: many(usersPg),
}));

export const usersSqliteRelations = relations(usersSqlite, ({ one }) => ({
  community: one(communitiesSqlite, {
    fields: [usersSqlite.communityId],
    references: [communitiesSqlite.id],
  }),
}));

export const insertUserSchema = createInsertSchema(usersPg, {
  email: z.string().email('Invalid email format'),
  role: UserRoleSchema.default('viewer'),
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

export type User = typeof usersSqlite.$inferSelect;
export type NewUser = typeof usersSqlite.$inferInsert;
export type CreateUserData = NewUser;
export type UpdateUserData = Partial<NewUser>;

export const createUserSchema = insertUserSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const updateUserSchema = insertUserSchema.partial().omit({
  id: true,
  createdAt: true,
});

export const users = usersSqlite;
