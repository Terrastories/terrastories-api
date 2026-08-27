/**
 * Places table schema with multi-database support
 *
 * Supports PostgreSQL and SQLite/D1-compatible deployments with the same
 * latitude/longitude storage contract. Spatial calculations are application-level
 * so neither backend requires a database spatial extension.
 *
 * Features:
 * - Multi-tenant data isolation via communityId
 * - Plain latitude/longitude columns on every backend
 * - Cultural significance tracking for Indigenous communities
 * - Cross-database compatibility (PostgreSQL/SQLite)
 */

import {
  pgTable,
  serial,
  text as pgText,
  integer as pgInteger,
  real as pgReal,
  boolean,
  timestamp,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';
import {
  sqliteTable,
  integer,
  text as sqliteText,
  real,
  index as sqliteIndex,
} from 'drizzle-orm/sqlite-core';
import { relations } from 'drizzle-orm';
import { createInsertSchema, createSelectSchema } from 'drizzle-zod';
import { z } from 'zod';
import { communitiesPg, communitiesSqlite } from './communities.js';
import { SpatialUtils } from '../../shared/utils/spatial.js';

export const CoordinateSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});

export const GeometryPointSchema = z.object({
  type: z.literal('Point'),
  coordinates: z.tuple([z.number(), z.number()]),
});

export const placesPg = pgTable(
  'places',
  {
    id: serial('id').primaryKey(),
    name: pgText('name').notNull(),
    description: pgText('description'),
    communityId: pgInteger('community_id').notNull(),
    latitude: pgReal('latitude').notNull(),
    longitude: pgReal('longitude').notNull(),
    region: pgText('region'),
    mediaUrls: jsonb('media_urls').$type<string[]>().default([]),
    photoUrl: pgText('photo_url'),
    culturalSignificance: pgText('cultural_significance'),
    isRestricted: boolean('is_restricted').notNull().default(false),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    communityIdx: index('places_community_id_idx').on(table.communityId),
    photoUrlIdx: index('places_photo_url_idx').on(table.photoUrl),
  })
);

export const placesSqlite = sqliteTable(
  'places',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: sqliteText('name').notNull(),
    description: sqliteText('description'),
    communityId: integer('community_id')
      .notNull()
      .references(() => communitiesSqlite.id),
    latitude: real('latitude').notNull(),
    longitude: real('longitude').notNull(),
    region: sqliteText('region'),
    mediaUrls: sqliteText('media_urls', { mode: 'json' })
      .$type<string[]>()
      .default([]),
    photoUrl: sqliteText('photo_url'),
    culturalSignificance: sqliteText('cultural_significance'),
    isRestricted: integer('is_restricted', { mode: 'boolean' })
      .notNull()
      .default(false),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    communityIdx: sqliteIndex('places_community_id_idx').on(table.communityId),
    photoUrlIdx: sqliteIndex('places_photo_url_idx').on(table.photoUrl),
  })
);

export async function getPlacesTable() {
  const { getConfig } = await import('../../shared/config/index.js');
  const config = getConfig();
  const isPostgres =
    config.database.url.startsWith('postgresql://') ||
    config.database.url.startsWith('postgres://');

  return isPostgres ? placesPg : placesSqlite;
}

export const placesRelations = relations(placesPg, ({ one }) => ({
  community: one(communitiesPg, {
    fields: [placesPg.communityId],
    references: [communitiesPg.id],
  }),
}));

export const placesSqliteRelations = relations(placesSqlite, ({ one }) => ({
  community: one(communitiesSqlite, {
    fields: [placesSqlite.communityId],
    references: [communitiesSqlite.id],
  }),
}));

export const insertPlaceSchema = createInsertSchema(placesPg, {
  name: z.string().min(1, 'Name is required').max(200, 'Name too long'),
  description: z.string().max(2000, 'Description too long').optional(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  region: z.string().max(100).optional(),
  mediaUrls: z.array(z.string().url()).default([]),
  culturalSignificance: z.string().max(1000).optional(),
  isRestricted: z.boolean().default(false),
  communityId: z.number().int().positive('Community ID must be positive'),
});

export const selectPlaceSchema = createSelectSchema(placesPg);

export type Place = typeof placesSqlite.$inferSelect;
export type NewPlace = typeof placesSqlite.$inferInsert;

export const createPlaceSchema = insertPlaceSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const updatePlaceSchema = insertPlaceSchema.partial().omit({
  id: true,
  createdAt: true,
  communityId: true,
});

export const places = placesPg;

export { SpatialUtils };

export const validateCoordinates = (lat: number, lng: number): boolean => {
  return SpatialUtils.validateCoordinates(lat, lng);
};
