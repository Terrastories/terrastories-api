/**
 * Community sovereignty tables (`community_stewards`,
 * `community_sovereignty_requests`, `community_archive_custody`) with equal
 * PostgreSQL and SQLite/D1-compatible semantics (SPEC-V2 §7 #187).
 *
 * - `community_stewards`: at most one designated custodian account per
 *   community (either a same-community account or a null-community
 *   `super_admin`). Removing or deleting the community cascades; deleting the
 *   user row cascades so a vanished account never blocks cleanup.
 * - `community_sovereignty_requests`: tracks admin immediate and steward
 *   notice-period withdrawal/erasure requests (`requested`, `notice`,
 *   `cancelled`, `executing`, `completed`). Partial unique indexes ensure at
 *   most one pending `'notice'` request per `(community_id, kind)` and at most
 *   one live/completed erasure request per community.
 * - `community_archive_custody`: metadata for any legacy Stage-2 archive held
 *   by the community or a named steward, including retention deadline and
 *   content-free destruction attestation reference.
 *
 * Note: the out-of-band erasure record itself lives OUTSIDE restorable
 * databases (in `ErasureRecordStore`), never in these tables, so D1 Time Travel
 * or file backup restores cannot roll it back.
 */

import { sql } from 'drizzle-orm';
import {
  pgTable,
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
import {
  ARCHIVE_CUSTODY_STATUSES,
  ARCHIVE_CUSTODY_TYPES,
  SOVEREIGNTY_INITIATOR_ROLES,
  SOVEREIGNTY_REQUEST_KINDS,
  SOVEREIGNTY_REQUEST_STATES,
} from '../../shared/sovereignty-policy.js';

export const communityStewardsPg = pgTable(
  'community_stewards',
  {
    communityId: pgInteger('community_id')
      .primaryKey()
      .references(() => communitiesPg.id, { onDelete: 'cascade' }),
    userId: pgInteger('user_id')
      .notNull()
      .references(() => usersPg.id, { onDelete: 'cascade' }),
    designatedBy: pgInteger('designated_by').references(() => usersPg.id, {
      onDelete: 'set null',
    }),
    designatedAt: bigint('designated_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (table) => [pgIndex('community_stewards_user_idx').on(table.userId)]
);

export const communityStewardsSqlite = sqliteTable(
  'community_stewards',
  {
    communityId: integer('community_id')
      .primaryKey()
      .notNull()
      .references(() => communitiesSqlite.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => usersSqlite.id, { onDelete: 'cascade' }),
    designatedBy: integer('designated_by').references(() => usersSqlite.id, {
      onDelete: 'set null',
    }),
    designatedAt: integer('designated_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [index('community_stewards_user_idx').on(table.userId)]
);

export const communitySovereigntyRequestsPg = pgTable(
  'community_sovereignty_requests',
  {
    id: pgText('id').primaryKey(),
    communityId: pgInteger('community_id')
      .notNull()
      .references(() => communitiesPg.id, { onDelete: 'cascade' }),
    kind: pgText('kind', { enum: SOVEREIGNTY_REQUEST_KINDS }).notNull(),
    state: pgText('state', { enum: SOVEREIGNTY_REQUEST_STATES }).notNull(),
    initiatedBy: pgInteger('initiated_by').references(() => usersPg.id, {
      onDelete: 'set null',
    }),
    initiatedByRole: pgText('initiated_by_role', {
      enum: SOVEREIGNTY_INITIATOR_ROLES,
    }).notNull(),
    requestedAt: bigint('requested_at', { mode: 'number' }).notNull(),
    noticeEndsAt: bigint('notice_ends_at', { mode: 'number' }),
    effectiveAt: bigint('effective_at', { mode: 'number' }),
    cancelledAt: bigint('cancelled_at', { mode: 'number' }),
    cancelledBy: pgInteger('cancelled_by').references(() => usersPg.id, {
      onDelete: 'set null',
    }),
    completedAt: bigint('completed_at', { mode: 'number' }),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (table) => [
    pgUniqueIndex('community_sovereignty_requests_active_erasure_unique')
      .on(table.communityId)
      .where(
        sql`${table.kind} = 'erasure' AND ${table.state} in ('requested', 'executing', 'completed')`
      ),
    pgUniqueIndex('community_sovereignty_requests_pending_notice_unique')
      .on(table.communityId, table.kind)
      .where(sql`${table.state} = 'notice'`),
    pgIndex('community_sovereignty_requests_community_created_idx').on(
      table.communityId,
      table.requestedAt,
      table.id
    ),
    pgIndex('community_sovereignty_requests_due_notice_idx')
      .on(table.noticeEndsAt)
      .where(sql`${table.state} = 'notice'`),
    pgIndex('community_sovereignty_requests_executing_idx')
      .on(table.state, table.updatedAt)
      .where(sql`${table.state} in ('requested', 'executing')`),
    pgCheck(
      'community_sovereignty_requests_kind_check',
      sql`${table.kind} in ('withdrawal', 'erasure')`
    ),
    pgCheck(
      'community_sovereignty_requests_state_check',
      sql`${table.state} in ('requested', 'notice', 'cancelled', 'executing', 'completed')`
    ),
    pgCheck(
      'community_sovereignty_requests_role_check',
      sql`${table.initiatedByRole} in ('admin', 'steward')`
    ),
    pgCheck(
      'community_sovereignty_requests_notice_check',
      sql`${table.noticeEndsAt} IS NULL OR ${table.noticeEndsAt} > ${table.requestedAt}`
    ),
    pgCheck(
      'community_sovereignty_requests_cancelled_check',
      sql`(${table.state} = 'cancelled' AND ${table.cancelledAt} IS NOT NULL) OR (${table.state} <> 'cancelled' AND ${table.cancelledAt} IS NULL)`
    ),
    pgCheck(
      'community_sovereignty_requests_completed_check',
      sql`(${table.state} = 'completed' AND ${table.completedAt} IS NOT NULL) OR (${table.state} <> 'completed' AND ${table.completedAt} IS NULL)`
    ),
  ]
);

export const communitySovereigntyRequestsSqlite = sqliteTable(
  'community_sovereignty_requests',
  {
    id: text('id').primaryKey().notNull(),
    communityId: integer('community_id')
      .notNull()
      .references(() => communitiesSqlite.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: SOVEREIGNTY_REQUEST_KINDS }).notNull(),
    state: text('state', { enum: SOVEREIGNTY_REQUEST_STATES }).notNull(),
    initiatedBy: integer('initiated_by').references(() => usersSqlite.id, {
      onDelete: 'set null',
    }),
    initiatedByRole: text('initiated_by_role', {
      enum: SOVEREIGNTY_INITIATOR_ROLES,
    }).notNull(),
    requestedAt: integer('requested_at').notNull(),
    noticeEndsAt: integer('notice_ends_at'),
    effectiveAt: integer('effective_at'),
    cancelledAt: integer('cancelled_at'),
    cancelledBy: integer('cancelled_by').references(() => usersSqlite.id, {
      onDelete: 'set null',
    }),
    completedAt: integer('completed_at'),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('community_sovereignty_requests_active_erasure_unique')
      .on(table.communityId)
      .where(
        sql`${table.kind} = 'erasure' AND ${table.state} in ('requested', 'executing', 'completed')`
      ),
    uniqueIndex('community_sovereignty_requests_pending_notice_unique')
      .on(table.communityId, table.kind)
      .where(sql`${table.state} = 'notice'`),
    index('community_sovereignty_requests_community_created_idx').on(
      table.communityId,
      table.requestedAt,
      table.id
    ),
    index('community_sovereignty_requests_due_notice_idx')
      .on(table.noticeEndsAt)
      .where(sql`${table.state} = 'notice'`),
    index('community_sovereignty_requests_executing_idx')
      .on(table.state, table.updatedAt)
      .where(sql`${table.state} in ('requested', 'executing')`),
    check(
      'community_sovereignty_requests_kind_check',
      sql`${table.kind} in ('withdrawal', 'erasure')`
    ),
    check(
      'community_sovereignty_requests_state_check',
      sql`${table.state} in ('requested', 'notice', 'cancelled', 'executing', 'completed')`
    ),
    check(
      'community_sovereignty_requests_role_check',
      sql`${table.initiatedByRole} in ('admin', 'steward')`
    ),
    check(
      'community_sovereignty_requests_notice_check',
      sql`${table.noticeEndsAt} IS NULL OR ${table.noticeEndsAt} > ${table.requestedAt}`
    ),
    check(
      'community_sovereignty_requests_cancelled_check',
      sql`(${table.state} = 'cancelled' AND ${table.cancelledAt} IS NOT NULL) OR (${table.state} <> 'cancelled' AND ${table.cancelledAt} IS NULL)`
    ),
    check(
      'community_sovereignty_requests_completed_check',
      sql`(${table.state} = 'completed' AND ${table.completedAt} IS NOT NULL) OR (${table.state} <> 'completed' AND ${table.completedAt} IS NULL)`
    ),
  ]
);

export const communityArchiveCustodyPg = pgTable(
  'community_archive_custody',
  {
    communityId: pgInteger('community_id')
      .primaryKey()
      .references(() => communitiesPg.id, { onDelete: 'cascade' }),
    custodianType: pgText('custodian_type', {
      enum: ARCHIVE_CUSTODY_TYPES,
    }).notNull(),
    custodianUserId: pgInteger('custodian_user_id').references(
      () => usersPg.id,
      {
        onDelete: 'set null',
      }
    ),
    status: pgText('status', { enum: ARCHIVE_CUSTODY_STATUSES }).notNull(),
    retentionUntil: bigint('retention_until', { mode: 'number' }).notNull(),
    destroyedAt: bigint('destroyed_at', { mode: 'number' }),
    destructionAttestationRef: pgText('destruction_attestation_ref'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (table) => [
    pgIndex('community_archive_custody_custodian_idx').on(
      table.custodianUserId
    ),
    pgCheck(
      'community_archive_custody_type_check',
      sql`${table.custodianType} in ('community', 'steward')`
    ),
    pgCheck(
      'community_archive_custody_status_check',
      sql`${table.status} in ('held', 'destroyed')`
    ),
    pgCheck(
      'community_archive_custody_destroyed_check',
      sql`(${table.status} = 'destroyed' AND ${table.destroyedAt} IS NOT NULL) OR (${table.status} = 'held' AND ${table.destroyedAt} IS NULL)`
    ),
  ]
);

export const communityArchiveCustodySqlite = sqliteTable(
  'community_archive_custody',
  {
    communityId: integer('community_id')
      .primaryKey()
      .notNull()
      .references(() => communitiesSqlite.id, { onDelete: 'cascade' }),
    custodianType: text('custodian_type', {
      enum: ARCHIVE_CUSTODY_TYPES,
    }).notNull(),
    custodianUserId: integer('custodian_user_id').references(
      () => usersSqlite.id,
      { onDelete: 'set null' }
    ),
    status: text('status', { enum: ARCHIVE_CUSTODY_STATUSES }).notNull(),
    retentionUntil: integer('retention_until').notNull(),
    destroyedAt: integer('destroyed_at'),
    destructionAttestationRef: text('destruction_attestation_ref'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    index('community_archive_custody_custodian_idx').on(table.custodianUserId),
    check(
      'community_archive_custody_type_check',
      sql`${table.custodianType} in ('community', 'steward')`
    ),
    check(
      'community_archive_custody_status_check',
      sql`${table.status} in ('held', 'destroyed')`
    ),
    check(
      'community_archive_custody_destroyed_check',
      sql`(${table.status} = 'destroyed' AND ${table.destroyedAt} IS NOT NULL) OR (${table.status} = 'held' AND ${table.destroyedAt} IS NULL)`
    ),
  ]
);

export type CommunityStewardRow = typeof communityStewardsSqlite.$inferSelect;
export type NewCommunityStewardRow =
  typeof communityStewardsSqlite.$inferInsert;
export type CommunitySovereigntyRequestRow =
  typeof communitySovereigntyRequestsSqlite.$inferSelect;
export type NewCommunitySovereigntyRequestRow =
  typeof communitySovereigntyRequestsSqlite.$inferInsert;
export type CommunityArchiveCustodyRow =
  typeof communityArchiveCustodySqlite.$inferSelect;
export type NewCommunityArchiveCustodyRow =
  typeof communityArchiveCustodySqlite.$inferInsert;
