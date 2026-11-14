/**
 * Audit entries table schema with equal PostgreSQL and SQLite/D1-compatible semantics.
 *
 * Per SPEC-V2 §6.8 and §7:
 * - Append-only content-free security and lifecycle audit log.
 * - No update is permitted except the 90-day scrub nullifying ip_address and user_agent.
 * - Deletion happens only through community erasure; FKs use ON DELETE NO ACTION
 *   so deleting a community or user fails while audit entries exist, and the
 *   erasure slice must delete a community's audit entries explicitly before
 *   removing parent rows.
 */

import {
  pgTable,
  serial,
  text as pgText,
  integer as pgInteger,
  jsonb,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import {
  sqliteTable,
  integer,
  text as sqliteText,
  index as sqliteIndex,
} from 'drizzle-orm/sqlite-core';
import { relations, sql } from 'drizzle-orm';
import { communitiesPg, communitiesSqlite } from './communities.js';
import { usersPg, usersSqlite } from './users.js';

export type AuditResourceId = number | string;

// PostgreSQL table
export const auditEntriesPg = pgTable(
  'audit_entries',
  {
    id: serial('id').primaryKey(),
    communityId: pgInteger('community_id').references(() => communitiesPg.id, {
      onDelete: 'no action',
    }),
    actorId: pgInteger('actor_id').references(() => usersPg.id, {
      onDelete: 'no action',
    }),
    action: pgText('action').notNull(),
    resourceType: pgText('resource_type'),
    resourceIds: jsonb('resource_ids')
      .$type<AuditResourceId[]>()
      .notNull()
      .default([]),
    outcome: pgText('outcome').notNull(),
    ipAddress: pgText('ip_address'),
    userAgent: pgText('user_agent'),
    createdAt: timestamp('created_at', { precision: 3 }).defaultNow().notNull(),
  },
  (table) => ({
    communityCreatedAtIdx: index('idx_audit_entries_community_created_at').on(
      table.communityId,
      table.createdAt
    ),
    actorIdx: index('idx_audit_entries_actor').on(table.actorId),
    networkScrubIdx: index('idx_audit_entries_network_scrub')
      .on(table.createdAt)
      .where(
        sql`${table.ipAddress} IS NOT NULL OR ${table.userAgent} IS NOT NULL`
      ),
  })
);

// SQLite / D1 table
export const auditEntriesSqlite = sqliteTable(
  'audit_entries',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    communityId: integer('community_id').references(
      () => communitiesSqlite.id,
      {
        onDelete: 'no action',
      }
    ),
    actorId: integer('actor_id').references(() => usersSqlite.id, {
      onDelete: 'no action',
    }),
    action: sqliteText('action').notNull(),
    resourceType: sqliteText('resource_type'),
    resourceIds: sqliteText('resource_ids', { mode: 'json' })
      .$type<AuditResourceId[]>()
      .notNull()
      .default([]),
    outcome: sqliteText('outcome').notNull(),
    ipAddress: sqliteText('ip_address'),
    userAgent: sqliteText('user_agent'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    communityCreatedAtIdx: sqliteIndex(
      'idx_audit_entries_community_created_at'
    ).on(table.communityId, table.createdAt),
    actorIdx: sqliteIndex('idx_audit_entries_actor').on(table.actorId),
    networkScrubIdx: sqliteIndex('idx_audit_entries_network_scrub')
      .on(table.createdAt)
      .where(
        sql`${table.ipAddress} IS NOT NULL OR ${table.userAgent} IS NOT NULL`
      ),
  })
);

export const auditEntriesRelations = relations(auditEntriesPg, ({ one }) => ({
  community: one(communitiesPg, {
    fields: [auditEntriesPg.communityId],
    references: [communitiesPg.id],
  }),
  actor: one(usersPg, {
    fields: [auditEntriesPg.actorId],
    references: [usersPg.id],
  }),
}));

export const auditEntriesSqliteRelations = relations(
  auditEntriesSqlite,
  ({ one }) => ({
    community: one(communitiesSqlite, {
      fields: [auditEntriesSqlite.communityId],
      references: [communitiesSqlite.id],
    }),
    actor: one(usersSqlite, {
      fields: [auditEntriesSqlite.actorId],
      references: [usersSqlite.id],
    }),
  })
);

export type AuditEntry = typeof auditEntriesSqlite.$inferSelect;
export type NewAuditEntry = typeof auditEntriesSqlite.$inferInsert;

// Export SQLite variant for Drizzle Kit (config selects PG vs SQLite)
export const auditEntries = auditEntriesSqlite;
