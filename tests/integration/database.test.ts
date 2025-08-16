/**
 * Database Integration Tests
 *
 * Integration tests demonstrating database fixture usage and patterns
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { testDb, TestDataFactory, TestFixtures } from '../helpers/database.js';
import {
  PerformanceTester,
  PerformanceTestUtils,
} from '../helpers/performance.js';
import { communitiesSqlite, placesSqlite } from '../../src/db/schema/index.js';
import { eq, sql } from 'drizzle-orm';

// Use SQLite tables for integration tests
const communities = communitiesSqlite;
const places = placesSqlite;

describe('Database Integration Tests', () => {
  let fixtures: TestFixtures;
  let performanceTester: PerformanceTester;

  beforeEach(async () => {
    // Database is cleared by setup.ts, seed with test data for integration tests
    fixtures = await testDb.seedTestData();
    performanceTester = PerformanceTestUtils.createTester(testDb);
  });

  describe('Community Operations', () => {
    it('should create and retrieve communities', async () => {
      const database = await testDb.getDb();

      // Create new community using factory
      const communityData = TestDataFactory.createCommunity({
        name: 'Integration Test Community',
        slug: 'integration-test',
      });

      const [newCommunity] = await database
        .insert(communities)
        .values(communityData)
        .returning();

      expect(newCommunity).toMatchObject({
        name: 'Integration Test Community',
        slug: 'integration-test',
        publicStories: true,
      });

      // Retrieve and verify
      const retrievedCommunity = await database
        .select()
        .from(communities)
        .where(eq(communities.id, newCommunity.id))
        .limit(1);

      expect(retrievedCommunity).toHaveLength(1);
      expect(retrievedCommunity[0]).toMatchObject(newCommunity);
    });

    it('should handle community updates', async () => {
      const database = await testDb.getDb();
      const testCommunity = fixtures.communities[0];

      // Update community
      const [updatedCommunity] = await database
        .update(communities)
        .set({
          name: 'Updated Community Name',
          description: 'Updated description',
        })
        .where(eq(communities.id, testCommunity.id))
        .returning();

      expect(updatedCommunity.name).toBe('Updated Community Name');
      expect(updatedCommunity.description).toBe('Updated description');

      // Verify update persisted
      const [retrieved] = await database
        .select()
        .from(communities)
        .where(eq(communities.id, testCommunity.id));

      expect(retrieved).toMatchObject(updatedCommunity);
    });

    it('should delete communities', async () => {
      const database = await testDb.getDb();
      const testCommunity = fixtures.communities[2]; // Use isolated test community

      // Delete community
      await database
        .delete(communities)
        .where(eq(communities.id, testCommunity.id));

      // Verify deletion
      const result = await database
        .select()
        .from(communities)
        .where(eq(communities.id, testCommunity.id));

      expect(result).toHaveLength(0);
    });
  });

  describe('Place Operations with Spatial Data', () => {
    it('should create places with spatial data', async () => {
      const database = await testDb.getDb();
      const testCommunity = fixtures.communities[0];

      // Create place using factory
      const placeData = TestDataFactory.createPlace(testCommunity.id, {
        name: 'Integration Test Place',
        location: JSON.stringify({
          type: 'Point',
          coordinates: [-74.006, 40.7128], // New York
        }),
        boundary: JSON.stringify({
          type: 'Polygon',
          coordinates: [
            [
              [-74.01, 40.71],
              [-74.0, 40.71],
              [-74.0, 40.72],
              [-74.01, 40.72],
              [-74.01, 40.71],
            ],
          ],
        }),
      });

      const [newPlace] = await database
        .insert(places)
        .values(placeData)
        .returning();

      expect(newPlace).toMatchObject({
        name: 'Integration Test Place',
        communityId: testCommunity.id,
      });

      // Verify spatial data
      const locationData = JSON.parse(newPlace.location!);
      expect(locationData).toMatchObject({
        type: 'Point',
        coordinates: [-74.006, 40.7128],
      });

      const boundaryData = JSON.parse(newPlace.boundary!);
      expect(boundaryData.type).toBe('Polygon');
    });

    it('should query places by location', async () => {
      const database = await testDb.getDb();

      // Query places with location data
      const placesWithLocation = await database
        .select()
        .from(places)
        .where(sql`location IS NOT NULL`);

      expect(placesWithLocation.length).toBeGreaterThan(0);

      // Verify all returned places have valid location data
      placesWithLocation.forEach((place) => {
        expect(place.location).toBeTruthy();
        const locationData = JSON.parse(place.location!);
        expect(locationData.type).toBe('Point');
        expect(Array.isArray(locationData.coordinates)).toBe(true);
        expect(locationData.coordinates).toHaveLength(2);
      });
    });

    it('should handle spatial data validation', async () => {
      const database = await testDb.getDb();
      const testCommunity = fixtures.communities[0];

      // Test with invalid spatial data
      const invalidPlaceData = TestDataFactory.createPlace(testCommunity.id, {
        location: 'invalid-json',
      });

      // This should not throw an error at database level (validation happens at application level)
      const [newPlace] = await database
        .insert(places)
        .values(invalidPlaceData)
        .returning();

      expect(newPlace.location).toBe('invalid-json');
    });
  });

  describe('Multi-tenancy and Data Isolation', () => {
    it('should properly isolate data by community', async () => {
      const database = await testDb.getDb();
      const community1 = fixtures.communities[0];
      const community2 = fixtures.communities[1];

      // Get places for each community
      const community1Places = await database
        .select()
        .from(places)
        .where(eq(places.communityId, community1.id));

      const community2Places = await database
        .select()
        .from(places)
        .where(eq(places.communityId, community2.id));

      // Verify isolation
      community1Places.forEach((place) => {
        expect(place.communityId).toBe(community1.id);
      });

      community2Places.forEach((place) => {
        expect(place.communityId).toBe(community2.id);
      });

      // Verify no cross-contamination
      const allCommunity1Ids = community1Places.map((p) => p.communityId);
      const allCommunity2Ids = community2Places.map((p) => p.communityId);

      expect(allCommunity1Ids.every((id) => id === community1.id)).toBe(true);
      expect(allCommunity2Ids.every((id) => id === community2.id)).toBe(true);
    });

    it('should support complex queries across relationships', async () => {
      const database = await testDb.getDb();

      // Query places with their community information
      const placesWithCommunities = await database
        .select({
          placeId: places.id,
          placeName: places.name,
          communityId: communities.id,
          communityName: communities.name,
        })
        .from(places)
        .innerJoin(communities, eq(places.communityId, communities.id));

      expect(placesWithCommunities.length).toBeGreaterThan(0);

      // Verify join integrity
      placesWithCommunities.forEach((row) => {
        expect(row.placeId).toBeDefined();
        expect(row.placeName).toBeDefined();
        expect(row.communityId).toBeDefined();
        expect(row.communityName).toBeDefined();
      });
    });
  });

  describe('Performance Tests', () => {
    it('should perform basic operations within performance limits', async () => {
      // Test insert performance
      const insertResult = await PerformanceTestUtils.quickCheck(async () => {
        const database = await testDb.getDb();
        const communityData = TestDataFactory.createCommunity();
        return database.insert(communities).values(communityData).returning();
      }, PerformanceTestUtils.PERFORMANCE_LIMITS.FAST_QUERY);

      expect(insertResult).toHaveLength(1);
    });

    it('should benchmark database operations', async () => {
      // Run performance benchmark
      const benchmark = await performanceTester.benchmarkInserts(10);

      expect(benchmark.successfulRuns).toBe(10);
      expect(benchmark.failedRuns).toBe(0);
      expect(benchmark.averageDuration).toBeLessThan(
        PerformanceTestUtils.PERFORMANCE_LIMITS.BULK_INSERT
      );
    });
  });

  describe('Database Statistics and Health', () => {
    it('should provide database statistics', async () => {
      const stats = await testDb.getStats();

      expect(stats).toMatchObject({
        communities: expect.any(Number),
        places: expect.any(Number),
        memoryUsage: expect.any(String),
      });

      // Should have test fixture data
      expect(stats.communities).toBeGreaterThanOrEqual(3);
      expect(stats.places).toBeGreaterThanOrEqual(3);
    });

    it('should handle database reset properly', async () => {
      const database = await testDb.getDb();

      // Add extra data
      await database
        .insert(communities)
        .values(TestDataFactory.createCommunity({ name: 'Extra Community' }));

      // Verify data exists
      const beforeReset = await database.select().from(communities);
      expect(beforeReset.length).toBeGreaterThan(3);

      // Reset database
      await testDb.reset();

      // Verify reset worked
      const afterReset = await database.select().from(communities);
      expect(afterReset).toHaveLength(3); // Should have only fixture data
    });
  });

  describe('Error Handling and Edge Cases', () => {
    it('should handle constraint violations properly', async () => {
      const database = await testDb.getDb();

      // Test that unique constraints are enforced
      await expect(async () => {
        // Try to insert duplicate slugs which should fail
        await database.insert(communities).values([
          TestDataFactory.createCommunity({ slug: 'duplicate-test' }),
          TestDataFactory.createCommunity({ slug: 'duplicate-test' }), // Duplicate slug
        ]);
      }).rejects.toThrow();

      // Verify no extra communities were added due to the constraint violation
      const allCommunities = await database.select().from(communities);
      expect(allCommunities).toHaveLength(3); // Only fixture data
    });

    it('should handle concurrent operations', async () => {
      const database = await testDb.getDb();

      // Run multiple concurrent inserts
      const concurrentOperations = Array.from({ length: 5 }, (_, i) =>
        database
          .insert(communities)
          .values(
            TestDataFactory.createCommunity({
              name: `Concurrent Community ${i}`,
              slug: `concurrent-${i}-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
            })
          )
          .returning()
      );

      const results = await Promise.all(concurrentOperations);

      // All operations should succeed
      expect(results).toHaveLength(5);
      results.forEach((result, index) => {
        expect(result).toHaveLength(1);
        expect(result[0].name).toBe(`Concurrent Community ${index}`);
      });
    });
  });
});
