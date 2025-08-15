/**
 * Places Schema - Geographic locations with PostGIS spatial support
 *
 * This schema demonstrates spatial data handling with Drizzle ORM:
 * - PostGIS geometry columns for PostgreSQL
 * - Point and polygon spatial data types
 * - Spatial indexing with GIST indexes
 * - Cross-database compatibility (PostgreSQL/SQLite)
 */

import {
  pgTable,
  serial,
  text as pgText,
  timestamp,
  geometry,
  index,
} from 'drizzle-orm/pg-core';
import {
  sqliteTable,
  integer,
  text as sqliteText,
} from 'drizzle-orm/sqlite-core';
import { z } from 'zod';

// Spatial data validation schemas
export const PointSchema = z.object({
  type: z.literal('Point'),
  coordinates: z.tuple([z.number(), z.number()]), // [lng, lat]
});

export const PolygonSchema = z.object({
  type: z.literal('Polygon'),
  coordinates: z.array(z.array(z.tuple([z.number(), z.number()]))),
});

export const GeometrySchema = z.union([PointSchema, PolygonSchema]);

// PostgreSQL table with PostGIS geometry columns
export const placesPg = pgTable(
  'places',
  {
    id: serial('id').primaryKey(),
    name: pgText('name').notNull(),
    description: pgText('description'),

    // PostGIS geometry columns with proper spatial types
    location: geometry('location', { type: 'point', srid: 4326 }), // WGS84 POINT
    boundary: geometry('boundary', { type: 'polygon', srid: 4326 }), // WGS84 POLYGON

    community_id: serial('community_id').notNull(),
    created_at: timestamp('created_at').defaultNow(),
    updated_at: timestamp('updated_at').defaultNow(),
  },
  (table) => ({
    // GIST spatial indexes for efficient spatial queries
    locationIdx: index('places_location_gist_idx').using(
      'gist',
      table.location
    ),
    boundaryIdx: index('places_boundary_gist_idx').using(
      'gist',
      table.boundary
    ),
    // Standard index for community filtering
    communityIdx: index('places_community_id_idx').on(table.community_id),
  })
);

// SQLite table for development/testing
export const placesSqlite = sqliteTable('places', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: sqliteText('name').notNull(),
  description: sqliteText('description'),

  // Spatial data stored as GeoJSON text in SQLite
  location: sqliteText('location'), // POINT as GeoJSON text
  boundary: sqliteText('boundary'), // POLYGON as GeoJSON text

  community_id: integer('community_id').notNull(),
  created_at: sqliteText('created_at').$defaultFn(() =>
    new Date().toISOString()
  ),
  updated_at: sqliteText('updated_at').$defaultFn(() =>
    new Date().toISOString()
  ),
});

// Schemas are already exported above, no need to re-export

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

// Default export for SQLite (used by Drizzle Kit for migration generation)
export const places = placesSqlite;

// TypeScript types
export type Place = typeof places.$inferSelect;
export type NewPlace = typeof places.$inferInsert;

// Spatial utility functions
export class SpatialUtils {
  /**
   * Create a Point geometry from latitude and longitude
   */
  static createPoint(lat: number, lng: number): string {
    return JSON.stringify({
      type: 'Point',
      coordinates: [lng, lat], // GeoJSON uses [lng, lat] order
    });
  }

  /**
   * Parse a Point geometry to get lat/lng coordinates
   */
  static parsePoint(
    geometry: string | null
  ): { lat: number; lng: number } | null {
    if (!geometry) return null;

    try {
      const parsed = JSON.parse(geometry);
      if (parsed.type === 'Point' && parsed.coordinates) {
        return {
          lat: parsed.coordinates[1],
          lng: parsed.coordinates[0],
        };
      }
    } catch (error) {
      console.warn('Failed to parse Point geometry:', error);
    }

    return null;
  }

  /**
   * Create a Polygon geometry from coordinate array
   */
  static createPolygon(coordinates: number[][][]): string {
    return JSON.stringify({
      type: 'Polygon',
      coordinates,
    });
  }

  /**
   * Validate geometry data
   */
  static validateGeometry(geometry: string): boolean {
    try {
      const parsed = JSON.parse(geometry);
      return GeometrySchema.safeParse(parsed).success;
    } catch {
      return false;
    }
  }
}

// Example spatial queries for PostgreSQL with PostGIS
export const spatialQueries = {
  /**
   * Find places within a distance from a point
   * Note: This would use PostGIS ST_DWithin function in production
   */
  findNearby: (centerLat: number, centerLng: number, radiusMeters: number) => `
    SELECT * FROM places 
    WHERE ST_DWithin(
      ST_GeomFromGeoJSON(location),
      ST_Point(${centerLng}, ${centerLat}),
      ${radiusMeters}
    )
  `,

  /**
   * Find places within a bounding box
   */
  findInBounds: (
    minLat: number,
    minLng: number,
    maxLat: number,
    maxLng: number
  ) => `
    SELECT * FROM places 
    WHERE ST_Within(
      ST_GeomFromGeoJSON(location),
      ST_MakeEnvelope(${minLng}, ${minLat}, ${maxLng}, ${maxLat}, 4326)
    )
  `,

  /**
   * Calculate distance between two places
   */
  calculateDistance: (placeId1: number, placeId2: number) => `
    SELECT 
      ST_Distance(
        ST_GeomFromGeoJSON(p1.location),
        ST_GeomFromGeoJSON(p2.location)
      ) as distance_meters
    FROM places p1, places p2
    WHERE p1.id = ${placeId1} AND p2.id = ${placeId2}
  `,
};
