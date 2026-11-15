/**
 * External Media Links table schema with multi-database support
 *
 * Canonical story external media link records (SPEC-V2 §6.7).
 * Distinct from File/Attachment: holds validated http/https URLs and
 * deterministic source order (`ordinal`) without claiming local byte ownership.
 */

import {
  pgTable,
  serial,
  integer as pgInteger,
  text as pgText,
  timestamp,
  index as pgIndex,
  foreignKey as pgForeignKey,
} from 'drizzle-orm/pg-core';
import {
  sqliteTable,
  integer,
  text as sqliteText,
  index as sqliteIndex,
  foreignKey as sqliteForeignKey,
} from 'drizzle-orm/sqlite-core';
import { relations } from 'drizzle-orm';
import { storiesPg, storiesSqlite } from './stories.js';

export const externalMediaLinksPg = pgTable(
  'external_media_links',
  {
    id: serial('id').primaryKey(),
    communityId: pgInteger('community_id').notNull(),
    storyId: pgInteger('story_id').notNull(),
    url: pgText('url').notNull(),
    ordinal: pgInteger('ordinal').notNull().default(0),
    createdAt: timestamp('created_at', { precision: 3 }).defaultNow().notNull(),
  },
  (table) => ({
    storyIdx: pgIndex('external_media_links_story_idx').on(
      table.communityId,
      table.storyId,
      table.ordinal
    ),
    storyCommunityFk: pgForeignKey({
      name: 'external_media_links_story_community_fk',
      columns: [table.communityId, table.storyId],
      foreignColumns: [storiesPg.communityId, storiesPg.id],
    }).onDelete('cascade'),
  })
);

export const externalMediaLinksSqlite = sqliteTable(
  'external_media_links',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    communityId: integer('community_id').notNull(),
    storyId: integer('story_id').notNull(),
    url: sqliteText('url').notNull(),
    ordinal: integer('ordinal').notNull().default(0),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    storyIdx: sqliteIndex('external_media_links_story_idx').on(
      table.communityId,
      table.storyId,
      table.ordinal
    ),
    storyCommunityFk: sqliteForeignKey({
      name: 'external_media_links_story_community_fk',
      columns: [table.communityId, table.storyId],
      foreignColumns: [storiesSqlite.communityId, storiesSqlite.id],
    }).onDelete('cascade'),
  })
);

export async function getExternalMediaLinksTable() {
  const { getConfig } = await import('../../shared/config/index.js');
  const config = getConfig();
  const isPostgres =
    config.database.url.startsWith('postgresql://') ||
    config.database.url.startsWith('postgres://');
  return isPostgres ? externalMediaLinksPg : externalMediaLinksSqlite;
}

export const externalMediaLinksRelations = relations(
  externalMediaLinksPg,
  ({ one }) => ({
    story: one(storiesPg, {
      fields: [externalMediaLinksPg.storyId],
      references: [storiesPg.id],
    }),
  })
);

export const externalMediaLinksSqliteRelations = relations(
  externalMediaLinksSqlite,
  ({ one }) => ({
    story: one(storiesSqlite, {
      fields: [externalMediaLinksSqlite.storyId],
      references: [storiesSqlite.id],
    }),
  })
);

export type ExternalMediaLink = typeof externalMediaLinksSqlite.$inferSelect;
export type NewExternalMediaLink = typeof externalMediaLinksSqlite.$inferInsert;

export const externalMediaLinks = externalMediaLinksSqlite;
