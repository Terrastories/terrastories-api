/**
 * TERRASTORIES API - PRODUCTION DATABASE CLEANUP TESTS
 *
 * Tests for Issue #64: Performance Test Cleanup and Foreign Key Issues
 *
 * Focuses on proper foreign key constraint handling during test cleanup
 * and ensuring test data isolation between performance test runs.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from 'vitest';
import Database from 'better-sqlite3';
import { join } from 'path';
import { eq } from 'drizzle-orm';
import { testDb, TestDatabaseManager } from '../helpers/database.js';
import {
  communitiesSqlite,
  usersSqlite,
  storiesSqlite,
  placesSqlite,
  speakersSqlite,
} from '../../src/db/schema/index.js';

describe('Production Database Cleanup', () => {
  let productionTestDb: TestDatabaseManager;
  let testDbPath: string;

  beforeAll(async () => {
    productionTestDb = new TestDatabaseManager();
    await productionTestDb.setup();
  });

  afterAll(async () => {
    await productionTestDb.teardown();
  });

  beforeEach(async () => {
    await productionTestDb.clearData();
  });

  describe('Foreign Key Constraint Handling', () => {
    it('should fail: clear data in correct dependency order', async () => {
      // This test should fail initially - clearData doesn't handle foreign keys properly
      const db = await productionTestDb.getDb();

      // Insert test data with complex foreign key relationships
      const community = await db
        .insert(communitiesSqlite)
        .values({
          name: 'FK Test Community',
          slug: 'fk-test',
          description: 'Community for foreign key testing',
          publicStories: true,
        })
        .returning();

      const user = await db
        .insert(usersSqlite)
        .values({
          email: 'fktest@example.com',
          passwordHash: 'hash',
          firstName: 'FK',
          lastName: 'Test',
          role: 'admin',
          communityId: community[0].id,
          isActive: true,
        })
        .returning();

      const speaker = await db
        .insert(speakersSqlite)
        .values({
          name: 'Test Speaker',
          bio: 'Test speaker bio',
          communityId: community[0].id,
          elderStatus: false,
          isActive: true,
        })
        .returning();

      const place = await db
        .insert(placesSqlite)
        .values({
          name: 'Test Place',
          description: 'Test place description',
          latitude: 40.7128,
          longitude: -74.006,
          communityId: community[0].id,
        })
        .returning();

      const story = await db
        .insert(storiesSqlite)
        .values({
          title: 'Test Story',
          description: 'Test story description',
          slug: 'test-story',
          communityId: community[0].id,
          createdBy: user[0].id,
          mediaUrls: [],
          tags: [],
        })
        .returning();

      // This should fail initially - foreign key constraints will prevent deletion
      await expect(productionTestDb.clearData()).resolves.not.toThrow();

      // Verify all data was actually cleared
      const remainingCommunities = await db.select().from(communitiesSqlite);
      const remainingUsers = await db.select().from(usersSqlite);
      const remainingStories = await db.select().from(storiesSqlite);
      const remainingPlaces = await db.select().from(placesSqlite);
      const remainingSpeakers = await db.select().from(speakersSqlite);

      // These should fail initially due to foreign key constraint violations
      expect(remainingCommunities).toHaveLength(0);
      expect(remainingUsers).toHaveLength(0);
      expect(remainingStories).toHaveLength(0);
      expect(remainingPlaces).toHaveLength(0);
      expect(remainingSpeakers).toHaveLength(0);
    });

    it('should fail: handle cascading deletes with many-to-many relationships', async () => {
      // This test should fail initially - many-to-many relationships not handled
      const db = await productionTestDb.getDb();

      // Create test data with many-to-many relationships
      const fixtures = await productionTestDb.seedTestData();

      // Add story-place and story-speaker relationships
      // Note: This will fail initially because the join tables don't exist yet
      try {
        // Get raw SQLite connection for direct execution
        const testDbManager = productionTestDb as any;
        const sqlite = testDbManager.sqlite;

        if (sqlite) {
          sqlite.exec(`
            INSERT INTO story_places (story_id, place_id, cultural_context, sort_order) 
            VALUES (1, 1, 'Cultural context', 1)
          `);

          sqlite.exec(`
            INSERT INTO story_speakers (story_id, speaker_id, story_role, sort_order)
            VALUES (1, 1, 'Narrator', 1)  
          `);
        }
      } catch (error) {
        // Expected to fail - join tables don't exist yet
      }

      // This should fail initially - cascading deletes for join tables not implemented
      await expect(productionTestDb.clearData()).resolves.not.toThrow();

      // Verify join table data was cleared
      try {
        const testDbManager = productionTestDb as any;
        const sqlite = testDbManager.sqlite;

        if (sqlite) {
          const remainingStoryPlaces = sqlite
            .prepare('SELECT * FROM story_places')
            .all();
          const remainingStorySpeakers = sqlite
            .prepare('SELECT * FROM story_speakers')
            .all();

          expect(remainingStoryPlaces).toHaveLength(0);
          expect(remainingStorySpeakers).toHaveLength(0);
        }
      } catch (error) {
        // Expected to fail - tables don't exist yet
        expect(error.message).toContain('no such table');
      }
    });

    it('should fail: prevent foreign key constraint violations during cleanup', async () => {
      // This test should fail initially - no foreign key violation prevention
      const db = await productionTestDb.getDb();

      const fixtures = await productionTestDb.seedTestData();

      // Attempt to delete parent record before children (should fail with proper FK constraints)
      await expect(async () => {
        await db
          .delete(communitiesSqlite)
          .where(eq(communitiesSqlite.id, fixtures.communities[0].id));
      }).rejects.toThrow(); // Should throw foreign key constraint error

      // The clearData method should handle this gracefully
      await expect(productionTestDb.clearData()).resolves.not.toThrow();
    });
  });

  describe('Test Data Isolation', () => {
    it('should fail: isolate test data between concurrent test runs', async () => {
      // This test should fail initially - no proper test isolation

      // Simulate concurrent test runs
      const testRun1 = async () => {
        const db1 = new TestDatabaseManager();
        await db1.setup();
        const fixtures1 = await db1.seedTestData();

        // Modify some data
        const db = await db1.getDb();
        await db.insert(usersSqlite).values({
          email: 'concurrent1@test.com',
          passwordHash: 'hash',
          firstName: 'Concurrent',
          lastName: 'Test1',
          role: 'editor',
          communityId: fixtures1.communities[0].id,
          isActive: true,
        });

        return db1;
      };

      const testRun2 = async () => {
        const db2 = new TestDatabaseManager();
        await db2.setup();
        const fixtures2 = await db2.seedTestData();

        // Modify some data
        const db = await db2.getDb();
        await db.insert(usersSqlite).values({
          email: 'concurrent2@test.com',
          passwordHash: 'hash',
          firstName: 'Concurrent',
          lastName: 'Test2',
          role: 'viewer',
          communityId: fixtures2.communities[0].id,
          isActive: true,
        });

        return db2;
      };

      // Run concurrently
      const [manager1, manager2] = await Promise.all([testRun1(), testRun2()]);

      // Each should have isolated data
      const db1 = await manager1.getDb();
      const db2 = await manager2.getDb();

      const users1 = await db1.select().from(usersSqlite);
      const users2 = await db2.select().from(usersSqlite);

      // This should fail initially - data may be shared between instances
      expect(
        users1.find((u) => u.email === 'concurrent2@test.com')
      ).toBeUndefined();
      expect(
        users2.find((u) => u.email === 'concurrent1@test.com')
      ).toBeUndefined();

      // Cleanup
      await manager1.teardown();
      await manager2.teardown();
    });

    it('should fail: reset database state between performance tests', async () => {
      // This test should fail initially - database state not properly reset

      // First test - create some data
      await productionTestDb.seedTestData();
      const db = await productionTestDb.getDb();

      await db.insert(usersSqlite).values({
        email: 'performance1@test.com',
        passwordHash: 'hash',
        firstName: 'Performance',
        lastName: 'Test1',
        role: 'admin',
        communityId: 1,
        isActive: true,
      });

      // Reset database
      await productionTestDb.reset();

      // Second test - should have clean state
      const usersAfterReset = await db.select().from(usersSqlite);

      // This should fail initially - reset may not clear all data properly
      expect(
        usersAfterReset.find((u) => u.email === 'performance1@test.com')
      ).toBeUndefined();

      // Should have fresh test data
      const communitiesAfterReset = await db.select().from(communitiesSqlite);
      expect(communitiesAfterReset.length).toBeGreaterThan(0);
    });
  });

  describe('Performance Constraints', () => {
    it('should fail: cleanup large datasets within time limits', async () => {
      // This test should fail initially - cleanup not optimized for large datasets
      const db = await productionTestDb.getDb();

      // Create large dataset
      const fixtures = await productionTestDb.seedTestData();
      const largeUserSet = Array.from({ length: 1000 }, (_, i) => ({
        email: `user${i}@performance.test`,
        passwordHash: 'hash',
        firstName: `User`,
        lastName: `${i}`,
        role: 'viewer' as const,
        communityId: fixtures.communities[0].id,
        isActive: true,
      }));

      // Insert large dataset
      await db.insert(usersSqlite).values(largeUserSet);

      // Measure cleanup time
      const startTime = Date.now();
      await productionTestDb.clearData();
      const cleanupTime = Date.now() - startTime;

      // This should fail initially - cleanup may be too slow for large datasets
      expect(cleanupTime).toBeLessThan(5000); // Should complete in under 5 seconds
    });

    it('should fail: maintain memory efficiency during cleanup', async () => {
      // This test should fail initially - memory usage not optimized
      const db = await productionTestDb.getDb();

      const initialMemory = process.memoryUsage().heapUsed;

      // Create and cleanup large dataset multiple times
      for (let i = 0; i < 10; i++) {
        await productionTestDb.seedTestData();
        await productionTestDb.clearData();
      }

      const finalMemory = process.memoryUsage().heapUsed;
      const memoryIncrease = finalMemory - initialMemory;

      // This should fail initially - memory may leak during repeated cleanup operations
      expect(memoryIncrease).toBeLessThan(50 * 1024 * 1024); // Less than 50MB increase
    });
  });
});
