/**
 * LoginCode and ClaimToken tables (SPEC-V2 §6.8, Slice 11).
 *
 * LoginCode: single-use, >=100-bit recovery enrollment material. Only the
 * SHA-256 digest of the code is stored; comparison is constant time; the raw
 * code is returned exactly once at issuance. `admin_issued` codes expire in
 * at most 72 hours; `recovery` codes never expire and are superseded when
 * regenerated. Community tenancy is the target account's community (null for
 * a null-community account).
 *
 * ClaimToken: single-use bearer claim material for a provisioned, empty,
 * never-administered hosted community. Only the SHA-256 digest is stored;
 * the raw token is shown exactly once at issuance. Tenancy is required and
 * names the one community the token may claim.
 *
 * Millisecond timestamps on both backends (Unix ms integers on SQLite/D1,
 * bigint on PostgreSQL), matching sessions/auth_throttle (#192).
 */
import { sql } from 'drizzle-orm';
import {
  pgTable,
  serial,
  text as pgText,
  integer as pgInteger,
  bigint,
  index as pgIndex,
  uniqueIndex as pgUniqueIndex,
  check as pgCheck,
} from 'drizzle-orm/pg-core';
import {
  sqliteTable,
  integer,
  text,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/sqlite-core';
import { communitiesPg, communitiesSqlite } from './communities.js';
import { usersPg, usersSqlite } from './users.js';

export const loginCodesPg = pgTable(
  'login_codes',
  {
    id: serial('id').primaryKey(),
    communityId: pgInteger('community_id').references(() => communitiesPg.id, {
      onDelete: 'cascade',
    }),
    userId: pgInteger('user_id')
      .notNull()
      .references(() => usersPg.id, { onDelete: 'cascade' }),
    purpose: pgText('purpose', {
      enum: ['admin_issued', 'recovery'],
    }).notNull(),
    codeHash: pgText('code_hash').notNull(),
    createdBy: pgInteger('created_by').references(() => usersPg.id, {
      onDelete: 'set null',
    }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    expiresAt: bigint('expires_at', { mode: 'number' }),
    usedAt: bigint('used_at', { mode: 'number' }),
    supersededAt: bigint('superseded_at', { mode: 'number' }),
  },
  (table) => [
    pgUniqueIndex('login_codes_code_hash_unique').on(table.codeHash),
    pgIndex('login_codes_user_idx').on(table.userId),
    pgIndex('login_codes_community_idx').on(table.communityId),
    pgCheck(
      'login_codes_purpose_check',
      sql`${table.purpose} in ('admin_issued', 'recovery')`
    ),
    // §6.8: recovery codes never expire; admin_issued codes always do.
    pgCheck(
      'login_codes_purpose_expiry_check',
      sql`(${table.purpose} = 'admin_issued' AND ${table.expiresAt} IS NOT NULL) OR (${table.purpose} = 'recovery' AND ${table.expiresAt} IS NULL)`
    ),
    pgCheck(
      'login_codes_expiry_check',
      sql`${table.expiresAt} IS NULL OR ${table.expiresAt} > ${table.createdAt}`
    ),
  ]
);

export const loginCodesSqlite = sqliteTable(
  'login_codes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    communityId: integer('community_id').references(
      () => communitiesSqlite.id,
      { onDelete: 'cascade' }
    ),
    userId: integer('user_id')
      .notNull()
      .references(() => usersSqlite.id, { onDelete: 'cascade' }),
    purpose: text('purpose', { enum: ['admin_issued', 'recovery'] }).notNull(),
    codeHash: text('code_hash').notNull(),
    createdBy: integer('created_by').references(() => usersSqlite.id, {
      onDelete: 'set null',
    }),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at'),
    usedAt: integer('used_at'),
    supersededAt: integer('superseded_at'),
  },
  (table) => [
    uniqueIndex('login_codes_code_hash_unique').on(table.codeHash),
    index('login_codes_user_idx').on(table.userId),
    index('login_codes_community_idx').on(table.communityId),
    check(
      'login_codes_purpose_check',
      sql`${table.purpose} in ('admin_issued', 'recovery')`
    ),
    check(
      'login_codes_purpose_expiry_check',
      sql`(${table.purpose} = 'admin_issued' AND ${table.expiresAt} IS NOT NULL) OR (${table.purpose} = 'recovery' AND ${table.expiresAt} IS NULL)`
    ),
    check(
      'login_codes_expiry_check',
      sql`${table.expiresAt} IS NULL OR ${table.expiresAt} > ${table.createdAt}`
    ),
  ]
);

export const claimTokensPg = pgTable(
  'claim_tokens',
  {
    id: serial('id').primaryKey(),
    communityId: pgInteger('community_id')
      .notNull()
      .references(() => communitiesPg.id, { onDelete: 'cascade' }),
    tokenHash: pgText('token_hash').notNull(),
    issuedBy: pgInteger('issued_by')
      .notNull()
      .references(() => usersPg.id, { onDelete: 'no action' }),
    // `created_at` carries the created/issued instant (§6.8 lists `createdAt`;
    // the work order calls the same column `issued_at`).
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
    consumedAt: bigint('consumed_at', { mode: 'number' }),
    consumedBy: pgInteger('consumed_by').references(() => usersPg.id, {
      onDelete: 'set null',
    }),
    supersededAt: bigint('superseded_at', { mode: 'number' }),
  },
  (table) => [
    pgUniqueIndex('claim_tokens_token_hash_unique').on(table.tokenHash),
    pgIndex('claim_tokens_community_idx').on(table.communityId),
    pgCheck(
      'claim_tokens_expiry_check',
      sql`${table.expiresAt} > ${table.createdAt}`
    ),
    pgCheck(
      'claim_tokens_consumed_check',
      sql`(${table.consumedAt} IS NULL) = (${table.consumedBy} IS NULL)`
    ),
  ]
);

export const claimTokensSqlite = sqliteTable(
  'claim_tokens',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    communityId: integer('community_id')
      .notNull()
      .references(() => communitiesSqlite.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    issuedBy: integer('issued_by')
      .notNull()
      .references(() => usersSqlite.id, { onDelete: 'no action' }),
    // `created_at` carries the created/issued instant (§6.8 lists `createdAt`;
    // the work order calls the same column `issued_at`).
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    consumedAt: integer('consumed_at'),
    consumedBy: integer('consumed_by').references(() => usersSqlite.id, {
      onDelete: 'set null',
    }),
    supersededAt: integer('superseded_at'),
  },
  (table) => [
    uniqueIndex('claim_tokens_token_hash_unique').on(table.tokenHash),
    index('claim_tokens_community_idx').on(table.communityId),
    check(
      'claim_tokens_expiry_check',
      sql`${table.expiresAt} > ${table.createdAt}`
    ),
    check(
      'claim_tokens_consumed_check',
      sql`(${table.consumedAt} IS NULL) = (${table.consumedBy} IS NULL)`
    ),
  ]
);
