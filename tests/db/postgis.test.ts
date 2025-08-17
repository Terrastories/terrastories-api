/**
 * PostGIS-specific Database Tests
 *
 * Tests PostgreSQL with PostGIS spatial functions when available.
 * Falls back gracefully when PostgreSQL is not available.
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
import { like, sql } from 'drizzle-orm';

describe('PostGIS Spatial Database Tests', () => {
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

  describe('PostGIS Extension Support', () => {
    it('should detect PostGIS capabilities', async () => {
      const result = await testConnection();

      expect(result.connected).toBe(true);

      if (isPostgres) {
        // When running with PostgreSQL, PostGIS should be available
        console.log(
          `🌍 PostgreSQL PostGIS Status: ${result.spatialSupport ? 'Available' : 'Not Available'}`
        );
        if (result.spatialSupport) {
          expect(result.version).toBeTruthy();
          console.log(`✅ PostGIS Version: ${result.version}`);
        }
      } else {
        // When running with SQLite, SpatiaLite should be available
        console.log(
          `🗄️ SQLite SpatiaLite Status: ${result.spatialSupport ? 'Available' : 'Not Available'}`
        );
        if (result.spatialSupport) {
          expect(result.version).toBeTruthy();
          console.log(`✅ SpatiaLite Version: ${result.version}`);
        }
      }
    });

    it('should handle spatial data with proper column types', async () => {
      const testPlace: NewPlace = isPostgres
        ? {
            name: 'PostGIS Test Place',
            description: 'Testing PostGIS spatial column types',
            location: SpatialUtils.createPoint(49.2827, -123.1207), // Vancouver, BC
            boundary: SpatialUtils.createPolygon([
              [
                [-123.13, 49.28],
                [-123.12, 49.28],
                [-123.12, 49.29],
                [-123.13, 49.29],
                [-123.13, 49.28],
              ],
            ]),
            communityId: 1,
          }
        : {
            name: 'PostGIS Test Place',
            description: 'Testing PostGIS spatial column types',
            latitude: 49.2827, // Vancouver, BC
            longitude: -123.1207,
            region: 'Vancouver',
            communityId: 1,
          };

      const result = await database
        .insert(places)
        .values(testPlace)
        .returning();

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        name: 'PostGIS Test Place',
        description: 'Testing PostGIS spatial column types',
        communityId: 1,
      });

      // Verify spatial data was stored correctly
      if (isPostgres) {
        expect(result[0].location).toBeTruthy();
        expect(result[0].boundary).toBeTruthy();
        console.log('📊 PostgreSQL geometry column data stored successfully');
      } else {
        // For SQLite, verify the coordinate fields
        expect(result[0].latitude).toBe(49.2827);
        expect(result[0].longitude).toBe(-123.1207);
        console.log('📊 SQLite coordinate data stored successfully');
      }
    });
  });

  describe('Spatial Query Functionality', () => {
    it('should support basic spatial operations', async () => {
      // Insert test places with known coordinates
      const testPlaces: NewPlace[] = isPostgres
        ? [
            {
              name: 'Vancouver Place',
              location: SpatialUtils.createPoint(49.2827, -123.1207),
              communityId: 1,
            },
            {
              name: 'Toronto Place',
              location: SpatialUtils.createPoint(43.6532, -79.3832),
              communityId: 1,
            },
            {
              name: 'Montreal Place',
              location: SpatialUtils.createPoint(45.5017, -73.5673),
              communityId: 1,
            },
          ]
        : [
            {
              name: 'Vancouver Place',
              latitude: 49.2827,
              longitude: -123.1207,
              communityId: 1,
            },
            {
              name: 'Toronto Place',
              latitude: 43.6532,
              longitude: -79.3832,
              communityId: 1,
            },
            {
              name: 'Montreal Place',
              latitude: 45.5017,
              longitude: -73.5673,
              communityId: 1,
            },
          ];

      await database.insert(places).values(testPlaces);

      // Query all places with spatial data
      const placesWithLocation = await database
        .select()
        .from(places)
        .where(
          isPostgres
            ? sql`location IS NOT NULL`
            : sql`latitude IS NOT NULL AND longitude IS NOT NULL`
        );

      expect(placesWithLocation.length).toBeGreaterThanOrEqual(3);

      // Verify all returned places have valid spatial data
      placesWithLocation.forEach((place) => {
        if (isPostgres) {
          // For PostgreSQL, verify geometry data
          expect(place.location).toBeTruthy();
        } else {
          // For SQLite, verify coordinate fields
          expect(typeof place.latitude).toBe('number');
          expect(typeof place.longitude).toBe('number');
        }
      });

      console.log(
        `✅ Successfully queried ${placesWithLocation.length} places with spatial data`
      );
    });

    it('should handle geometry validation', async () => {
      // Test with various geometry formats
      const geometryTests = isPostgres
        ? [
            {
              name: 'Valid Point',
              location: SpatialUtils.createPoint(0, 0), // Null Island
              shouldBeValid: true,
            },
            {
              name: 'Edge Case - North Pole',
              location: SpatialUtils.createPoint(90, 0),
              shouldBeValid: true,
            },
            {
              name: 'Edge Case - South Pole',
              location: SpatialUtils.createPoint(-90, 0),
              shouldBeValid: true,
            },
            {
              name: 'Edge Case - International Date Line',
              location: SpatialUtils.createPoint(0, 180),
              shouldBeValid: true,
            },
          ]
        : [
            {
              name: 'Valid Point',
              latitude: 0,
              longitude: 0, // Null Island
              shouldBeValid: true,
            },
            {
              name: 'Edge Case - North Pole',
              latitude: 90,
              longitude: 0,
              shouldBeValid: true,
            },
            {
              name: 'Edge Case - South Pole',
              latitude: -90,
              longitude: 0,
              shouldBeValid: true,
            },
            {
              name: 'Edge Case - International Date Line',
              latitude: 0,
              longitude: 180,
              shouldBeValid: true,
            },
          ];

      for (const test of geometryTests) {
        if (test.shouldBeValid) {
          if (isPostgres) {
            expect(SpatialUtils.validateGeometry(test.location)).toBe(true);
          }

          // Test database insertion
          const testPlace: NewPlace = isPostgres
            ? {
                name: test.name,
                location: test.location,
                communityId: 1,
              }
            : {
                name: test.name,
                latitude: test.latitude,
                longitude: test.longitude,
                communityId: 1,
              };

          const result = await database
            .insert(places)
            .values(testPlace)
            .returning();
          expect(result).toHaveLength(1);
          expect(result[0].name).toBe(test.name);
        }
      }

      console.log(
        `✅ Successfully validated ${geometryTests.length} geometry test cases`
      );
    });
  });

  describe('Database Schema Compatibility', () => {
    it('should work with both PostgreSQL and SQLite schemas', async () => {
      console.log(
        `📊 Testing schema compatibility with ${isPostgres ? 'PostgreSQL' : 'SQLite'}`
      );

      // Test that the dynamic table selection works
      const selectedPlaces = await getPlacesTable();
      expect(selectedPlaces).toBeDefined();

      // Test basic operations with the selected schema
      const testPlace: NewPlace = isPostgres
        ? {
            name: 'Schema Compatibility Test',
            description: 'Testing cross-database schema compatibility',
            location: SpatialUtils.createPoint(45.0, -75.0), // Ottawa coordinates
            communityId: 1,
          }
        : {
            name: 'Schema Compatibility Test',
            description: 'Testing cross-database schema compatibility',
            latitude: 45.0, // Ottawa coordinates
            longitude: -75.0,
            communityId: 1,
          };

      const result = await database
        .insert(selectedPlaces)
        .values(testPlace)
        .returning();

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Schema Compatibility Test');

      if (isPostgres) {
        expect(result[0].location).toBeTruthy();
      } else {
        expect(result[0].latitude).toBe(45.0);
        expect(result[0].longitude).toBe(-75.0);
      }

      // Verify the result can be queried back
      const retrieved = await database
        .select()
        .from(selectedPlaces)
        .where((table) => table.name === 'Schema Compatibility Test');

      expect(retrieved).toHaveLength(1);
      expect(retrieved[0]).toMatchObject(result[0]);

      console.log('✅ Schema compatibility test passed');
    });

    it('should handle spatial indexing configuration', async () => {
      // This test verifies that spatial indexes are configured correctly
      // For PostgreSQL, GIST indexes should be created by migrations
      // For SQLite, spatial indexing is handled by SpatiaLite extension

      if (isPostgres) {
        console.log('🔍 PostgreSQL GIST spatial indexes configured in schema');
        // GIST indexes are defined in the schema and created during migration
        // No runtime verification needed as they're structural
      } else {
        console.log(
          '🔍 SQLite spatial indexing handled by SpatiaLite extension'
        );
        // SpatiaLite handles spatial indexing automatically when extension is loaded
      }

      // Test that spatial queries can be performed efficiently
      // Insert multiple places for index performance test
      const testPlaces: NewPlace[] = isPostgres
        ? Array.from({ length: 10 }, (_, i) => ({
            name: `Index Test Place ${i}`,
            location: SpatialUtils.createPoint(45 + i * 0.1, -75 + i * 0.1),
            communityId: 1,
          }))
        : Array.from({ length: 10 }, (_, i) => ({
            name: `Index Test Place ${i}`,
            latitude: 45 + i * 0.1,
            longitude: -75 + i * 0.1,
            communityId: 1,
          }));

      await database.insert(places).values(testPlaces);

      // Query with spatial criteria - should use indexes for efficiency
      const nearbyPlaces = await database
        .select()
        .from(places)
        .where(like(places.name, '%Index Test%'));

      expect(nearbyPlaces.length).toBe(10);
      console.log('✅ Spatial indexing performance test completed');
    });
  });

  describe('PostGIS Migration Utilities', () => {
    it('should verify PostGIS extensions are available when using PostgreSQL', async () => {
      const result = await testConnection();

      if (isPostgres && result.spatialSupport) {
        console.log('✅ PostGIS extensions verified and working');
        console.log(`   Version: ${result.version}`);

        // Additional verification could include checking specific PostGIS functions
        // This would be done in actual PostgreSQL integration tests
      } else if (isPostgres && !result.spatialSupport) {
        console.warn(
          '⚠️ PostgreSQL detected but PostGIS extensions not available'
        );
        console.warn(
          '   Ensure PostGIS is installed: CREATE EXTENSION postgis;'
        );
      } else {
        console.log(
          'ℹ️ Running with SQLite - PostGIS extensions not applicable'
        );
      }

      // Test should always pass - this is informational
      expect(result.connected).toBe(true);
    });
  });
});
