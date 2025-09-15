/**
 * Places table schema with multi-database support and PostGIS integration
 *
 * Supports both PostgreSQL (production) and SQLite (development/testing)
 * Follows the same pattern as users.ts and stories.ts for consistency
 *
 * Features:
 * - Multi-tenant data isolation via communityId
 * - PostGIS geometry fields for spatial queries (PostgreSQL)
 * - Fallback lat/lng coordinates for SQLite compatibility
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

// Coordinate validation schemas
export const CoordinateSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});

export const GeometryPointSchema = z.object({
  type: z.literal('Point'),
  coordinates: z.tuple([z.number(), z.number()]), // [lng, lat] GeoJSON format
});

// PostgreSQL table for production with PostGIS support
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
    // Direct file URL column for dual-read capability (Issue #89)
    photoUrl: pgText('photo_url'),
    culturalSignificance: pgText('cultural_significance'),
    isRestricted: boolean('is_restricted').notNull().default(false),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    // Standard indexes for filtering
    communityIdx: index('places_community_id_idx').on(table.communityId),
    // Index for photo URL queries (for media management)
    photoUrlIdx: index('places_photo_url_idx').on(table.photoUrl),
    // Note: PostGIS geometry index will be added in migration
  })
);

// SQLite table for development/testing
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
    // Direct file URL column for dual-read capability (Issue #89)
    photoUrl: sqliteText('photo_url'),
    culturalSignificance: sqliteText('cultural_significance'),
    isRestricted: integer('is_restricted', { mode: 'boolean' })
      .notNull()
      .default(false),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => ({
    // Standard indexes for filtering
    communityIdx: sqliteIndex('places_community_id_idx').on(table.communityId),
    // Index for photo URL queries (for media management)
    photoUrlIdx: sqliteIndex('places_photo_url_idx').on(table.photoUrl),
  })
);

// Dynamic table selection based on database type (for runtime use)
// Note: This function imports getConfig at runtime to avoid circular dependencies during migration
export async function getPlacesTable() {
  // Dynamic import to avoid issues with Drizzle Kit during migration generation
  const { getConfig } = await import('../../shared/config/index.js');
  const config = getConfig();
  const isPostgres =
    config.database.url.startsWith('postgresql://') ||
    config.database.url.startsWith('postgres://');

  return isPostgres ? placesPg : placesSqlite;
}

// Relations - Places belong to one community
export const placesRelations = relations(placesPg, ({ one }) => ({
  community: one(communitiesPg, {
    fields: [placesPg.communityId],
    references: [communitiesPg.id],
  }),
}));

// SQLite relations (same structure)
export const placesSqliteRelations = relations(placesSqlite, ({ one }) => ({
  community: one(communitiesPg, {
    fields: [placesSqlite.communityId],
    references: [communitiesPg.id],
  }),
}));

// Zod schemas for validation - using PostgreSQL table as base for consistency
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

// TypeScript types - Use SQLite for consistency with current deployment
export type Place = typeof placesSqlite.$inferSelect;
export type NewPlace = typeof placesSqlite.$inferInsert;

// Additional validation schemas for specific use cases
export const createPlaceSchema = insertPlaceSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const updatePlaceSchema = insertPlaceSchema.partial().omit({
  id: true,
  createdAt: true,
  communityId: true, // Don't allow changing community
});

// PostGIS spatial utility functions (PostgreSQL only)
export const spatialHelpers = {
  // Create PostGIS POINT from latitude and longitude
  createPoint: (lat: number, lng: number) =>
    `ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)`,

  // Find places within radius (in meters) using latitude/longitude columns
  findWithinRadius: (lat: number, lng: number, radiusMeters: number) =>
    `ST_DWithin(ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography, ${radiusMeters})`,

  // Find places within bounding box using latitude/longitude columns
  findInBoundingBox: (bounds: {
    north: number;
    south: number;
    east: number;
    west: number;
  }) =>
    `latitude BETWEEN ${bounds.south} AND ${bounds.north} AND longitude BETWEEN ${bounds.west} AND ${bounds.east}`,

  // Calculate distance between two points (in meters) using latitude/longitude columns
  calculateDistance: (fromLat: number, fromLng: number) =>
    `ST_Distance(ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography, ST_SetSRID(ST_MakePoint(${fromLng}, ${fromLat}), 4326)::geography)`,
};

// Export table variants for migration generation
// The default export uses PostgreSQL table for Drizzle Kit
export const places = placesPg;

// Re-export SpatialUtils for backward compatibility with tests
export { SpatialUtils };

// Add validateCoordinates function for backward compatibility
export const validateCoordinates = (lat: number, lng: number): boolean => {
  return SpatialUtils.validateCoordinates(lat, lng);
};
