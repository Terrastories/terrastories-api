import { sql } from 'drizzle-orm';
import {
  pgTable,
  text as pgText,
  integer as pgInteger,
  bigint,
  index as pgIndex,
  uuid,
  check as pgCheck,
  foreignKey,
} from 'drizzle-orm/pg-core';
import {
  sqliteTable,
  text,
  integer,
  index,
  check,
  foreignKey as sqliteForeignKey,
} from 'drizzle-orm/sqlite-core';
import { usersPg, usersSqlite } from './users.js';
import { filesPg, filesSqlite } from './files.js';
import { communitiesPg, communitiesSqlite } from './communities.js';

export const sessionsPg = pgTable(
  'sessions',
  {
    id: pgText('id').primaryKey(),
    tokenHash: pgText('token_hash').notNull().unique(),
    userId: pgInteger('user_id')
      .notNull()
      .references(() => usersPg.id, { onDelete: 'cascade' }),
    // Slice 10: the built single expiry is split into idle + absolute
    // windows and a `standard`/`device` kind (SPEC-V2 §6.8). `expires_at`
    // stays as the legacy absolute column until Slice 15 drops it.
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
    kind: pgText('kind', { enum: ['standard', 'device'] })
      .notNull()
      .default('standard'),
    createdAt: bigint('created_at', { mode: 'number' }),
    lastSeenAt: bigint('last_seen_at', { mode: 'number' }),
    idleExpiresAt: bigint('idle_expires_at', { mode: 'number' }),
    absoluteExpiresAt: bigint('absolute_expires_at', { mode: 'number' }),
    revokedAt: bigint('revoked_at', { mode: 'number' }),
    revokedBy: pgInteger('revoked_by'),
  },
  (table) => [
    pgIndex('sessions_user_idx').on(table.userId),
    pgCheck(
      'sessions_kind_check',
      sql`${table.kind} in ('standard', 'device')`
    ),
    pgCheck(
      'sessions_revoked_by_check',
      sql`(${table.revokedAt} IS NULL) = (${table.revokedBy} IS NULL)`
    ),
  ]
);

export const sessionsSqlite = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey().notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    userId: integer('user_id')
      .notNull()
      .references(() => usersSqlite.id, { onDelete: 'cascade' }),
    expiresAt: integer('expires_at').notNull(),
    kind: text('kind', { enum: ['standard', 'device'] })
      .notNull()
      .default('standard'),
    createdAt: integer('created_at'),
    lastSeenAt: integer('last_seen_at'),
    idleExpiresAt: integer('idle_expires_at'),
    absoluteExpiresAt: integer('absolute_expires_at'),
    revokedAt: integer('revoked_at'),
    revokedBy: integer('revoked_by'),
  },
  (table) => [
    index('sessions_user_idx').on(table.userId),
    check('sessions_kind_check', sql`${table.kind} in ('standard', 'device')`),
    check(
      'sessions_revoked_by_check',
      sql`(${table.revokedAt} IS NULL) = (${table.revokedBy} IS NULL)`
    ),
  ]
);

/**
 * AuthThrottle (SPEC-V2 §6.8): operational state, never community content and
 * never carrying a raw identifier. `key` is a keyed hash of a kind-prefixed
 * input (`account:`/ `ip:` + the resolved account id or client IP), so no raw
 * IP or account id is ever stored. Only the authentication service reads or
 * writes these rows.
 */
export const authThrottlePg = pgTable(
  'auth_throttle',
  {
    key: pgText('key').primaryKey(),
    kind: pgText('kind', { enum: ['account', 'ip'] }).notNull(),
    communityId: pgInteger('community_id').references(() => communitiesPg.id, {
      onDelete: 'cascade',
    }),
    failures: pgInteger('failures').notNull().default(0),
    windowStartedAt: bigint('window_started_at', { mode: 'number' })
      .notNull()
      .default(0),
    blockedUntil: bigint('blocked_until', { mode: 'number' }),
  },
  (table) => [
    pgIndex('auth_throttle_community_idx').on(table.communityId),
    pgCheck(
      'auth_throttle_kind_check',
      sql`${table.kind} in ('account', 'ip')`
    ),
    // Per-IP rows are null-community by construction (§6.8); account rows may
    // be either (a null-community `super_admin` account has no community).
    pgCheck(
      'auth_throttle_ip_community_check',
      sql`${table.kind} = 'account' OR ${table.communityId} IS NULL`
    ),
  ]
);

export const authThrottleSqlite = sqliteTable(
  'auth_throttle',
  {
    key: text('key').primaryKey().notNull(),
    kind: text('kind', { enum: ['account', 'ip'] }).notNull(),
    communityId: integer('community_id').references(
      () => communitiesSqlite.id,
      {
        onDelete: 'cascade',
      }
    ),
    failures: integer('failures').notNull().default(0),
    windowStartedAt: integer('window_started_at').notNull().default(0),
    blockedUntil: integer('blocked_until'),
  },
  (table) => [
    index('auth_throttle_community_idx').on(table.communityId),
    check('auth_throttle_kind_check', sql`${table.kind} in ('account', 'ip')`),
    check(
      'auth_throttle_ip_community_check',
      sql`${table.kind} = 'account' OR ${table.communityId} IS NULL`
    ),
  ]
);

export const communityMediaPg = pgTable(
  'community_media',
  {
    fileId: uuid('file_id').primaryKey(),
    communityId: pgInteger('community_id')
      .notNull()
      .references(() => communitiesPg.id, { onDelete: 'cascade' }),
    kind: pgText('kind').notNull(),
  },
  (table) => [
    pgCheck('community_media_kind_check', sql`${table.kind} = 'branding'`),
    // Composite tenant FK (#186): branding media must reference a file of the
    // same community, never another community's file.
    foreignKey({
      name: 'community_media_file_community_fk',
      columns: [table.communityId, table.fileId],
      foreignColumns: [filesPg.communityId, filesPg.id],
    }).onDelete('cascade'),
  ]
);

export const communityMediaSqlite = sqliteTable(
  'community_media',
  {
    fileId: text('file_id').primaryKey().notNull(),
    communityId: integer('community_id')
      .notNull()
      .references(() => communitiesSqlite.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
  },
  (table) => [
    check('community_media_kind_check', sql`${table.kind} = 'branding'`),
    // Composite tenant FK (#186): branding media must reference a file of the
    // same community, never another community's file.
    sqliteForeignKey({
      name: 'community_media_file_community_fk',
      columns: [table.communityId, table.fileId],
      foreignColumns: [filesSqlite.communityId, filesSqlite.id],
    }).onDelete('cascade'),
  ]
);
