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
} from '../../src/db/schema/places.js';
import { getConfig } from '../../src/shared/config/index.js';
import {
  setupTestDatabase,
  teardownTestDatabase,
  clearTestData,
} from '../helpers/database.js';

describe('Spatial Database Operations', () => {
  let database: Awaited<ReturnType<typeof getDb>>;
  let places: Awaited<ReturnType<typeof getPlacesTable>>;

  beforeAll(async () => {
    database = await setupTestDatabase();
    places = await getPlacesTable();
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
          console.warn('⚠️ Spatial support not available in test environment');
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
        lat: 40.7128,
        lng: -74.006,
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
      const newPlace: NewPlace = {
        name: 'Test Location',
        description: 'A test place for spatial operations',
        location: SpatialUtils.createPoint(40.7128, -74.006), // NYC
        community_id: 1,
      };

      const result = await database.insert(places).values(newPlace).returning();

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        name: 'Test Location',
        description: 'A test place for spatial operations',
        community_id: 1,
      });
      expect(result[0].location).toBeTruthy();

      // Verify the spatial data
      const locationData = SpatialUtils.parsePoint(result[0].location!);
      expect(locationData).toEqual({
        lat: 40.7128,
        lng: -74.006,
      });
    });

    it('should query places by spatial criteria', async () => {
      // Insert test places
      const testPlaces: NewPlace[] = [
        {
          name: 'Place A',
          location: SpatialUtils.createPoint(40.7128, -74.006), // NYC
          community_id: 1,
        },
        {
          name: 'Place B',
          location: SpatialUtils.createPoint(34.0522, -118.2437), // LA
          community_id: 1,
        },
      ];

      await database.insert(places).values(testPlaces);

      // Query all places
      const allPlaces = await database.select().from(places);
      expect(allPlaces.length).toBeGreaterThanOrEqual(2);

      // Verify spatial data integrity
      const placesWithCoords = allPlaces
        .map((place) => ({
          ...place,
          coords: SpatialUtils.parsePoint(place.location!),
        }))
        .filter((place) => place.coords !== null);

      expect(placesWithCoords.length).toBeGreaterThan(0);
      expect(placesWithCoords[0].coords).toHaveProperty('lat');
      expect(placesWithCoords[0].coords).toHaveProperty('lng');
    });

    it('should handle places without spatial data', async () => {
      const placeWithoutLocation: NewPlace = {
        name: 'No Location Place',
        description: 'Place without spatial data',
        community_id: 1,
      };

      const result = await database
        .insert(places)
        .values(placeWithoutLocation)
        .returning();

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('No Location Place');
      expect(result[0].location).toBeNull();
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
      const config = getConfig();
      const isPostgres =
        config.database.url.startsWith('postgresql://') ||
        config.database.url.startsWith('postgres://');

      console.log(
        `📊 Testing with ${isPostgres ? 'PostgreSQL' : 'SQLite'} database`
      );

      // Test basic database operations
      const testPlace: NewPlace = {
        name: 'Compatibility Test Place',
        location: SpatialUtils.createPoint(0, 0),
        community_id: 999,
      };

      const result = await database
        .insert(places)
        .values(testPlace)
        .returning();
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Compatibility Test Place');

      // Cleanup
      const { eq } = await import('drizzle-orm');
      await database.delete(places).where(eq(places.community_id, 999));
    });
  });
});
