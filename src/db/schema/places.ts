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
  index,
} from 'drizzle-orm/pg-core';
import {
  sqliteTable,
  integer,
  text as sqliteText,
} from 'drizzle-orm/sqlite-core';
import { relations } from 'drizzle-orm';
import { createInsertSchema, createSelectSchema } from 'drizzle-zod';
import { z } from 'zod';
import { communitiesPg } from './communities.js';
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

// PostgreSQL table for production with PostGIS support planned
export const placesPg = pgTable(
  'places',
  {
    id: serial('id').primaryKey(),
    name: pgText('name').notNull(),
    description: pgText('description'),
    location: pgText('location'), // GeoJSON Point storage
    boundary: pgText('boundary'), // GeoJSON Polygon storage
    communityId: pgInteger('community_id').notNull(),
    createdAt: pgText('created_at'),
    updatedAt: pgText('updated_at'),
  },
  (table) => ({
    // Standard indexes for filtering
    communityIdx: index('places_community_id_idx').on(table.communityId),
    // Note: PostGIS geometry index will be added in migration
  })
);

// SQLite table for development/testing
export const placesSqlite = sqliteTable('places', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: sqliteText('name').notNull(),
  description: sqliteText('description'),
  location: sqliteText('location'), // GeoJSON Point storage
  boundary: sqliteText('boundary'), // GeoJSON Polygon storage
  communityId: integer('community_id').notNull(),
  createdAt: sqliteText('created_at'),
  updatedAt: sqliteText('updated_at'),
});

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
  location: z.string().optional(), // GeoJSON string
  boundary: z.string().optional(), // GeoJSON string
  communityId: z.number().int().positive('Community ID must be positive'),
});

export const selectPlaceSchema = createSelectSchema(placesPg);

// TypeScript types
export type Place = typeof placesPg.$inferSelect;
export type NewPlace = typeof placesPg.$inferInsert;

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
  // Create PostGIS POINT from latitude and longitude (backward compatibility)
  createPoint: (lat: number, lng: number) =>
    `ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)`,

  // Create PostGIS POINT from GeoJSON location string
  createPostGISPoint: (geoJsonLocation: string) =>
    `ST_GeomFromGeoJSON('${geoJsonLocation}')`,

  // Find places within radius (in meters) using location column
  findWithinRadius: (lat: number, lng: number, radiusMeters: number) =>
    `ST_DWithin(ST_GeomFromGeoJSON(location)::geography, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography, ${radiusMeters})`,

  // Find places within bounding box using location column
  findInBoundingBox: (bounds: {
    north: number;
    south: number;
    east: number;
    west: number;
  }) =>
    `ST_Within(ST_GeomFromGeoJSON(location), ST_MakeEnvelope(${bounds.west}, ${bounds.south}, ${bounds.east}, ${bounds.north}, 4326))`,

  // Calculate distance between two points (in meters) using location column
  calculateDistance: (fromLat: number, fromLng: number) =>
    `ST_Distance(ST_GeomFromGeoJSON(location)::geography, ST_SetSRID(ST_MakePoint(${fromLng}, ${fromLat}), 4326)::geography)`,
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
