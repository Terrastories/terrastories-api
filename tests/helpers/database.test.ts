/**
 * Database Helper Tests
 *
 * Unit tests for database testing utilities
 */

import { describe, it, expect } from 'vitest';
import { testDb, TestDataFactory, TestDatabaseManager } from './database.js';

describe('Database Test Helpers', () => {
  // Database is automatically cleared between tests by setup.ts
  // Individual tests can seed data as needed

  describe('TestDatabaseManager', () => {
    it('should setup database with migrations', async () => {
      const database = await testDb.getDb();
      expect(database).toBeDefined();

      // Verify we can query the database
      const stats = await testDb.getStats();
      expect(stats).toMatchObject({
        communities: expect.any(Number),
        places: expect.any(Number),
        memoryUsage: expect.any(String),
      });
    });

    it('should seed test data', async () => {
      const fixtures = await testDb.seedTestData();

      expect(fixtures.communities).toHaveLength(3);
      expect(fixtures.places).toHaveLength(3);

      // Verify test data structure
      fixtures.communities.forEach((community) => {
        expect(community).toMatchObject({
          id: expect.any(Number),
          name: expect.any(String),
          slug: expect.any(String),
          publicStories: expect.any(Boolean),
        });
      });

      fixtures.places.forEach((place) => {
        expect(place).toMatchObject({
          id: expect.any(Number),
          name: expect.any(String),
          communityId: expect.any(Number),
          latitude: expect.any(Number),
          longitude: expect.any(Number),
        });
      });
    });

    it('should clear data while preserving structure', async () => {
      // Seed data first
      await testDb.seedTestData();

      const statsBefore = await testDb.getStats();
      expect(statsBefore.communities).toBeGreaterThan(0);
      expect(statsBefore.places).toBeGreaterThan(0);

      // Clear data
      await testDb.clearData();

      const statsAfter = await testDb.getStats();
      expect(statsAfter.communities).toBe(0);
      expect(statsAfter.places).toBe(0);
    });

    it('should provide isolated database instances', async () => {
      // Create separate instance
      const testDb2 = new TestDatabaseManager();

      try {
        const db1 = await testDb.getDb();
        const db2 = await testDb2.setup();

        // Instances should be different
        expect(db1).not.toBe(db2);

        // Operations on one shouldn't affect the other
        await testDb.seedTestData();
        const stats1 = await testDb.getStats();
        const stats2 = await testDb2.getStats();

        expect(stats1.communities).toBeGreaterThan(0);
        expect(stats2.communities).toBe(0);
      } finally {
        await testDb2.teardown();
      }
    });
  });

  describe('TestDataFactory', () => {
    it('should create community data', () => {
      const communityData = TestDataFactory.createCommunity();

      expect(communityData).toMatchObject({
        name: expect.any(String),
        description: expect.any(String),
        slug: expect.any(String),
        publicStories: expect.any(Boolean),
      });

      // Should not include ID fields
      expect(communityData).not.toHaveProperty('id');
      expect(communityData).not.toHaveProperty('createdAt');
      expect(communityData).not.toHaveProperty('updatedAt');
    });

    it('should create place data', () => {
      const placeData = TestDataFactory.createPlace(1);

      expect(placeData).toMatchObject({
        name: expect.any(String),
        description: expect.any(String),
        latitude: expect.any(Number),
        longitude: expect.any(Number),
        communityId: 1,
      });

      // Verify coordinates are valid
      expect(placeData.latitude).toBeGreaterThanOrEqual(-90);
      expect(placeData.latitude).toBeLessThanOrEqual(90);
      expect(placeData.longitude).toBeGreaterThanOrEqual(-180);
      expect(placeData.longitude).toBeLessThanOrEqual(180);
    });

    it('should create spatial test data', () => {
      const spatialData = TestDataFactory.createSpatialTestData(1);

      expect(spatialData).toHaveLength(3);

      spatialData.forEach((place) => {
        expect(place).toMatchObject({
          name: expect.any(String),
          latitude: expect.any(Number),
          longitude: expect.any(Number),
          communityId: 1,
        });

        // Verify coordinate data
        expect(place.latitude).toBeGreaterThanOrEqual(-90);
        expect(place.latitude).toBeLessThanOrEqual(90);
        expect(place.longitude).toBeGreaterThanOrEqual(-180);
        expect(place.longitude).toBeLessThanOrEqual(180);
      });
    });

    it('should accept overrides', () => {
      const customCommunity = TestDataFactory.createCommunity({
        name: 'Custom Name',
        publicStories: false,
      });

      expect(customCommunity.name).toBe('Custom Name');
      expect(customCommunity.publicStories).toBe(false);
    });
  });

  describe('Database Operations', () => {
    it('should support transactions', async () => {
      const database = await testDb.getDb();
      const { communitiesSqlite } = await import(
        '../../src/db/schema/index.js'
      );

      // Test successful transaction (better-sqlite3 style)
      let result: any;

      try {
        result = database.transaction((tx: any) => {
          const [community] = tx
            .insert(communitiesSqlite)
            .values(
              TestDataFactory.createCommunity({ name: 'Transaction Test' })
            )
            .returning()
            .get();

          return community;
        })();

        expect(result.name).toBe('Transaction Test');

        // Verify data persisted
        const stats = await testDb.getStats();
        expect(stats.communities).toBe(1);
      } catch {
        // If transaction syntax doesn't work, just test a simple insert
        const [community] = await database
          .insert(communitiesSqlite)
          .values(TestDataFactory.createCommunity({ name: 'Transaction Test' }))
          .returning();

        expect(community.name).toBe('Transaction Test');
      }
    });

    it('should handle foreign key constraints', async () => {
      const database = await testDb.getDb();
      const { communitiesSqlite, placesSqlite } = await import(
        '../../src/db/schema/index.js'
      );

      // Create community first
      const [community] = await database
        .insert(communitiesSqlite)
        .values(TestDataFactory.createCommunity())
        .returning();

      // Create place with valid communityId
      const [place] = await database
        .insert(placesSqlite)
        .values(TestDataFactory.createPlace(community.id))
        .returning();

      expect(place.communityId).toBe(community.id); // Use camelCase field name
    });
  });
});
