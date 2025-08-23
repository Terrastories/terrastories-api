/**
 * Spatial Database Tests
 *
 * Tests PostGIS/SpatiaLite functionality and spatial data operations
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { getDb, testConnection } from '../../src/db/index.js';
import {
  getPlacesTable,
  SpatialUtils,
  type NewPlace,
} from '../../src/db/schema/places.ts';
import { getConfig } from '../../src/shared/config/index.js';
import {
  setupTestDatabase,
  teardownTestDatabase,
  clearTestData,
} from '../helpers/database.js';

describe('Spatial Database Operations', () => {
  let database: Awaited<ReturnType<typeof getDb>>;
  let places: Awaited<ReturnType<typeof getPlacesTable>>;
  let isPostgres: boolean;

  beforeAll(async () => {
    database = await setupTestDatabase();
    places = await getPlacesTable();

    const config = getConfig();
    isPostgres =
      config.database.url.startsWith('postgresql://') ||
      config.database.url.startsWith('postgres://');
  });

  afterAll(async () => {
    await teardownTestDatabase();
  });

  afterEach(async () => {
    await clearTestData();
  });

  describe('Database Connection and Spatial Support', () => {
    it('should connect to database successfully', async () => {
      const result = await testConnection();

      expect(result.connected).toBe(true);
      expect(result).toHaveProperty('spatialSupport');
      expect(result).toHaveProperty('version');
    });

    it('should report spatial capabilities', async () => {
      const config = getConfig();
      const result = await testConnection();

      if (config.database.spatialSupport) {
        // Spatial support should be available in test environment
        expect(typeof result.spatialSupport).toBe('boolean');

        if (result.spatialSupport) {
          expect(result.version).toBeTruthy();
          console.log(`✅ Spatial extension version: ${result.version}`);
        } else {
          console.log(
            'ℹ️ Spatial support not detected (test environment uses in-memory SQLite)'
          );
        }
      }
    });
  });

  describe('Spatial Utility Functions', () => {
    it('should create valid Point geometries', () => {
      const point = SpatialUtils.createPoint(40.7128, -74.006); // NYC coordinates
      const parsed = JSON.parse(point);

      expect(parsed.type).toBe('Point');
      expect(parsed.coordinates).toEqual([-74.006, 40.7128]); // [lng, lat] order
    });

    it('should parse Point geometries correctly', () => {
      const pointGeometry = SpatialUtils.createPoint(40.7128, -74.006);
      const parsed = SpatialUtils.parsePoint(pointGeometry);

      expect(parsed).toEqual({
        latitude: 40.7128,
        longitude: -74.006,
      });
    });

    it('should handle invalid geometries gracefully', () => {
      expect(SpatialUtils.parsePoint(null)).toBeNull();
      expect(SpatialUtils.parsePoint('invalid json')).toBeNull();
      expect(SpatialUtils.parsePoint('{"type":"InvalidType"}')).toBeNull();
    });

    it('should validate geometry data', () => {
      const validPoint = SpatialUtils.createPoint(40.7128, -74.006);
      const validPolygon = SpatialUtils.createPolygon([
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
          [0, 0],
        ],
      ]);
      const invalidGeometry = '{"type":"Invalid","coordinates":[]}';

      expect(SpatialUtils.validateGeometry(validPoint)).toBe(true);
      expect(SpatialUtils.validateGeometry(validPolygon)).toBe(true);
      expect(SpatialUtils.validateGeometry(invalidGeometry)).toBe(false);
    });
  });

  describe('Place CRUD Operations with Spatial Data', () => {
    it('should insert a place with point location', async () => {
      const newPlace: NewPlace = isPostgres
        ? {
            name: 'Test Location',
            description: 'A test place for spatial operations',
            location: SpatialUtils.createPoint(40.7128, -74.006), // NYC
            communityId: 1,
          }
        : {
            name: 'Test Location',
            description: 'A test place for spatial operations',
            latitude: 40.7128, // NYC
            longitude: -74.006,
            communityId: 1,
          };

      const result = await database.insert(places).values(newPlace).returning();

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        name: 'Test Location',
        description: 'A test place for spatial operations',
        communityId: 1,
      });

      if (isPostgres) {
        expect(result[0].location).toBeTruthy();
        // Verify the spatial data
        const locationData = SpatialUtils.parsePoint(result[0].location!);
        expect(locationData).toEqual({
          latitude: 40.7128,
          longitude: -74.006,
        });
      } else {
        // For SQLite, verify coordinate fields
        expect(result[0].latitude).toBe(40.7128);
        expect(result[0].longitude).toBe(-74.006);
      }
    });

    it('should query places by spatial criteria', async () => {
      // Insert test places
      const testPlaces: NewPlace[] = isPostgres
        ? [
            {
              name: 'Place A',
              location: SpatialUtils.createPoint(40.7128, -74.006), // NYC
              communityId: 1,
            },
            {
              name: 'Place B',
              location: SpatialUtils.createPoint(34.0522, -118.2437), // LA
              communityId: 1,
            },
          ]
        : [
            {
              name: 'Place A',
              latitude: 40.7128, // NYC
              longitude: -74.006,
              communityId: 1,
            },
            {
              name: 'Place B',
              latitude: 34.0522, // LA
              longitude: -118.2437,
              communityId: 1,
            },
          ];

      await database.insert(places).values(testPlaces);

      // Query all places
      const allPlaces = await database.select().from(places);
      expect(allPlaces.length).toBeGreaterThanOrEqual(2);

      if (isPostgres) {
        // Verify spatial data integrity for PostgreSQL
        const placesWithCoords = allPlaces
          .map((place) => ({
            ...place,
            coords: SpatialUtils.parsePoint(place.location!),
          }))
          .filter((place) => place.coords !== null);

        expect(placesWithCoords.length).toBeGreaterThan(0);
      } else {
        // Verify coordinate data for SQLite
        const placesWithCoords = allPlaces.filter(
          (place) => place.latitude != null && place.longitude != null
        );
        expect(placesWithCoords.length).toBeGreaterThan(0);

        // Verify coordinate values
        placesWithCoords.forEach((place) => {
          expect(typeof place.latitude).toBe('number');
          expect(typeof place.longitude).toBe('number');
        });
      }
    });

    it('should handle places without spatial data', async () => {
      if (isPostgres) {
        // PostgreSQL can handle optional location field
        const placeWithoutLocation: NewPlace = {
          name: 'No Location Place',
          description: 'Place without spatial data',
          communityId: 1,
        };

        const result = await database
          .insert(places)
          .values(placeWithoutLocation)
          .returning();

        expect(result).toHaveLength(1);
        expect(result[0].name).toBe('No Location Place');
        expect(result[0].location).toBeNull();
      } else {
        // SQLite requires latitude/longitude, use default coordinates
        const placeWithMinimalLocation: NewPlace = {
          name: 'No Location Place',
          description: 'Place without specific spatial data',
          latitude: 0, // Default to null island
          longitude: 0,
          communityId: 1,
        };

        const result = await database
          .insert(places)
          .values(placeWithMinimalLocation)
          .returning();

        expect(result).toHaveLength(1);
        expect(result[0].name).toBe('No Location Place');
        expect(result[0].latitude).toBe(0);
        expect(result[0].longitude).toBe(0);
      }
    });
  });

  describe('Spatial Data Validation', () => {
    it('should handle various coordinate formats', () => {
      // Test edge cases
      const northPole = SpatialUtils.createPoint(90, 0);
      const southPole = SpatialUtils.createPoint(-90, 0);
      const dateLine = SpatialUtils.createPoint(0, 180);
      const primeMeridian = SpatialUtils.createPoint(0, 0);

      expect(SpatialUtils.validateGeometry(northPole)).toBe(true);
      expect(SpatialUtils.validateGeometry(southPole)).toBe(true);
      expect(SpatialUtils.validateGeometry(dateLine)).toBe(true);
      expect(SpatialUtils.validateGeometry(primeMeridian)).toBe(true);
    });

    it('should validate polygon geometries', () => {
      // Simple square polygon
      const square = SpatialUtils.createPolygon([
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
          [0, 0],
        ], // Closed ring
      ]);

      expect(SpatialUtils.validateGeometry(square)).toBe(true);

      // Complex polygon with hole
      const polygonWithHole = SpatialUtils.createPolygon([
        [
          [0, 0],
          [4, 0],
          [4, 4],
          [0, 4],
          [0, 0],
        ], // Outer ring
        [
          [1, 1],
          [3, 1],
          [3, 3],
          [1, 3],
          [1, 1],
        ], // Inner ring (hole)
      ]);

      expect(SpatialUtils.validateGeometry(polygonWithHole)).toBe(true);
    });
  });

  describe('Database Environment Compatibility', () => {
    it('should work with current database configuration', async () => {
      console.log(
        `📊 Testing with ${isPostgres ? 'PostgreSQL' : 'SQLite'} database`
      );

      // Test basic database operations
      const testPlace: NewPlace = isPostgres
        ? {
            name: 'Compatibility Test Place',
            location: SpatialUtils.createPoint(0, 0),
            communityId: 999,
          }
        : {
            name: 'Compatibility Test Place',
            latitude: 0,
            longitude: 0,
            communityId: 999,
          };

      const result = await database
        .insert(places)
        .values(testPlace)
        .returning();
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Compatibility Test Place');

      // Cleanup
      const { eq } = await import('drizzle-orm');
      await database.delete(places).where(eq(places.communityId, 999));
    });
  });
});
