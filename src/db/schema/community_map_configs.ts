/**
 * Community Map Configs table schema with multi-database support
 *
 * Canonical 1-to-1 provider-neutral map configuration per community (SPEC-V2 §6.6).
 * Uses doublePrecision on PostgreSQL and real on SQLite/D1 for coordinates,
 * matching `places` (§5/§8), and millisecond timestamps across both dialects.
 */

import {
  pgTable,
  integer as pgInteger,
  text as pgText,
  doublePrecision,
  boolean as pgBoolean,
  uuid as pgUuid,
  timestamp,
  index as pgIndex,
  foreignKey as pgForeignKey,
} from 'drizzle-orm/pg-core';
import {
  sqliteTable,
  integer,
  text as sqliteText,
  real,
  index as sqliteIndex,
  foreignKey as sqliteForeignKey,
} from 'drizzle-orm/sqlite-core';
import { relations } from 'drizzle-orm';
import { communitiesPg, communitiesSqlite } from './communities.js';
import { filesPg, filesSqlite } from './files.js';

export const communityMapConfigsPg = pgTable(
  'community_map_configs',
  {
    communityId: pgInteger('community_id')
      .primaryKey()
      .references(() => communitiesPg.id, { onDelete: 'cascade' }),
    styleUrl: pgText('style_url'),
    basemapStyle: pgText('basemap_style'),
    centerLatitude: doublePrecision('center_latitude'),
    centerLongitude: doublePrecision('center_longitude'),
    southWestLatitude: doublePrecision('south_west_latitude'),
    southWestLongitude: doublePrecision('south_west_longitude'),
    northEastLatitude: doublePrecision('north_east_latitude'),
    northEastLongitude: doublePrecision('north_east_longitude'),
    zoom: doublePrecision('zoom'),
    pitch: doublePrecision('pitch'),
    bearing: doublePrecision('bearing'),
    threeDimensional: pgBoolean('three_dimensional'),
    projection: pgText('projection'),
    staticMapFileId: pgUuid('static_map_file_id'),
    createdAt: timestamp('created_at', { precision: 3 }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { precision: 3 }).defaultNow().notNull(),
    mapboxStyleUrl: pgText('mapbox_style_url'),
    mapboxAccessToken: pgText('mapbox_access_token'),
    exposeMapboxCredentials: pgBoolean('expose_mapbox_credentials')
      .default(false)
      .notNull(),
    mapbox3d: pgBoolean('mapbox_3d').default(false).notNull(),
    protomapsApiKey: pgText('protomaps_api_key'),
    protomapsBasemapStyle: pgText('protomaps_basemap_style'),
  },
  (table) => ({
    staticMapFileIdx: pgIndex('community_map_configs_static_map_file_idx').on(
      table.staticMapFileId
    ),
    staticMapFileCommunityFk: pgForeignKey({
      name: 'community_map_configs_static_map_file_community_fk',
      columns: [table.communityId, table.staticMapFileId],
      foreignColumns: [filesPg.communityId, filesPg.id],
    }),
  })
);

export const communityMapConfigsSqlite = sqliteTable(
  'community_map_configs',
  {
    communityId: integer('community_id')
      .primaryKey()
      .references(() => communitiesSqlite.id, { onDelete: 'cascade' }),
    styleUrl: sqliteText('style_url'),
    basemapStyle: sqliteText('basemap_style'),
    centerLatitude: real('center_latitude'),
    centerLongitude: real('center_longitude'),
    southWestLatitude: real('south_west_latitude'),
    southWestLongitude: real('south_west_longitude'),
    northEastLatitude: real('north_east_latitude'),
    northEastLongitude: real('north_east_longitude'),
    zoom: real('zoom'),
    pitch: real('pitch'),
    bearing: real('bearing'),
    threeDimensional: integer('three_dimensional', { mode: 'boolean' }),
    projection: sqliteText('projection'),
    staticMapFileId: sqliteText('static_map_file_id'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    mapboxStyleUrl: sqliteText('mapbox_style_url'),
    mapboxAccessToken: sqliteText('mapbox_access_token'),
    exposeMapboxCredentials: integer('expose_mapbox_credentials', {
      mode: 'boolean',
    })
      .default(false)
      .notNull(),
    mapbox3d: integer('mapbox_3d', { mode: 'boolean' })
      .default(false)
      .notNull(),
    protomapsApiKey: sqliteText('protomaps_api_key'),
    protomapsBasemapStyle: sqliteText('protomaps_basemap_style'),
  },
  (table) => ({
    staticMapFileIdx: sqliteIndex(
      'community_map_configs_static_map_file_idx'
    ).on(table.staticMapFileId),
    staticMapFileCommunityFk: sqliteForeignKey({
      name: 'community_map_configs_static_map_file_community_fk',
      columns: [table.communityId, table.staticMapFileId],
      foreignColumns: [filesSqlite.communityId, filesSqlite.id],
    }),
  })
);

export async function getCommunityMapConfigsTable() {
  const { getConfig } = await import('../../shared/config/index.js');
  const config = getConfig();
  const isPostgres =
    config.database.url.startsWith('postgresql://') ||
    config.database.url.startsWith('postgres://');
  return isPostgres ? communityMapConfigsPg : communityMapConfigsSqlite;
}

export const communityMapConfigsRelations = relations(
  communityMapConfigsPg,
  ({ one }) => ({
    community: one(communitiesPg, {
      fields: [communityMapConfigsPg.communityId],
      references: [communitiesPg.id],
    }),
    staticMapFile: one(filesPg, {
      fields: [communityMapConfigsPg.staticMapFileId],
      references: [filesPg.id],
    }),
  })
);

export const communityMapConfigsSqliteRelations = relations(
  communityMapConfigsSqlite,
  ({ one }) => ({
    community: one(communitiesSqlite, {
      fields: [communityMapConfigsSqlite.communityId],
      references: [communitiesSqlite.id],
    }),
    staticMapFile: one(filesSqlite, {
      fields: [communityMapConfigsSqlite.staticMapFileId],
      references: [filesSqlite.id],
    }),
  })
);

export type CommunityMapConfig = typeof communityMapConfigsSqlite.$inferSelect;
export type NewCommunityMapConfig =
  typeof communityMapConfigsSqlite.$inferInsert;

export const communityMapConfigs = communityMapConfigsSqlite;
