/**
 * Database Test Fixtures
 *
 * Comprehensive database fixture system for test isolation and data management
 */

import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import Database from 'better-sqlite3';
import { sql } from 'drizzle-orm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  communities,
  places,
  Community,
  Place,
} from '../../src/db/schema/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export type TestDatabase = ReturnType<
  typeof drizzle<{
    communities: typeof communities;
    places: typeof places;
  }>
>;

/**
 * Test Database Manager
 * Manages isolated in-memory SQLite databases for testing
 */
export class TestDatabaseManager {
  private db: TestDatabase | null = null;
  private sqlite: Database.Database | null = null;
  private isSetup = false;

  /**
   * Setup test database with migrations and isolation
   */
  async setup(): Promise<TestDatabase> {
    if (this.isSetup && this.db) {
      return this.db;
    }

    // Create in-memory SQLite database for complete isolation
    this.sqlite = new Database(':memory:');

    // Enable foreign key constraints
    this.sqlite.pragma('foreign_keys = ON');

    // Create Drizzle instance
    this.db = drizzle(this.sqlite, {
      schema: { communities, places },
    });

    // Run migrations
    const migrationsFolder = path.join(
      __dirname,
      '..',
      '..',
      'src',
      'db',
      'migrations'
    );

    try {
      await migrate(this.db, { migrationsFolder });
      console.log('✅ Test database migrations applied');
    } catch (error: any) {
      console.warn(
        '⚠️ Migration error (may be already applied):',
        error.message
      );
    }

    this.isSetup = true;
    return this.db;
  }

  /**
   * Get the database instance (setup if not already done)
   */
  async getDb(): Promise<TestDatabase> {
    if (!this.isSetup || !this.db) {
      return await this.setup();
    }
    return this.db;
  }

  /**
   * Clear all data from the database while preserving structure
   */
  async clearData(): Promise<void> {
    if (!this.db) return;

    try {
      // Clear in dependency order (children first)
      await this.db.delete(places);
      await this.db.delete(communities);
      console.log('🧹 All test data cleared');
    } catch (error: any) {
      console.warn('⚠️ Could not clear test data:', error.message);
    }
  }

  /**
   * Completely teardown the database
   */
  async teardown(): Promise<void> {
    if (this.sqlite) {
      this.sqlite.close();
      this.sqlite = null;
    }
    this.db = null;
    this.isSetup = false;
    console.log('🧹 Test database closed');
  }

  /**
   * Reset database to clean state
   */
  async reset(): Promise<void> {
    await this.clearData();
    await this.seedTestData();
  }

  /**
   * Seed database with test fixture data
   */
  async seedTestData(): Promise<TestFixtures> {
    const db = await this.getDb();

    // Insert test communities (without explicit IDs to avoid conflicts)
    const testCommunities = await db
      .insert(communities)
      .values([
        {
          name: 'Test Community',
          description: 'A test community for unit tests',
          slug: 'test-community',
          publicStories: true,
        },
        {
          name: 'Demo Community',
          description: 'A demo community for integration tests',
          slug: 'demo-community',
          publicStories: false,
        },
        {
          name: 'Isolated Test Community',
          description: 'Community for isolated test scenarios',
          slug: 'isolated-test',
          publicStories: true,
        },
      ])
      .returning();

    // Insert test places with spatial data
    const testPlaces = await db
      .insert(places)
      .values([
        {
          name: 'Test Place 1',
          description: 'First test place with point location',
          location: JSON.stringify({
            type: 'Point',
            coordinates: [-123.1234, 49.2827], // Vancouver, BC
          }),
          community_id: testCommunities[0].id,
        },
        {
          name: 'Test Place 2',
          description: 'Second test place with polygon boundary',
          location: JSON.stringify({
            type: 'Point',
            coordinates: [-79.3832, 43.6532], // Toronto, ON
          }),
          boundary: JSON.stringify({
            type: 'Polygon',
            coordinates: [
              [
                [-79.39, 43.65],
                [-79.38, 43.65],
                [-79.38, 43.66],
                [-79.39, 43.66],
                [-79.39, 43.65],
              ],
            ],
          }),
          community_id: testCommunities[0].id,
        },
        {
          name: 'Isolated Test Place',
          description: 'Place for isolated test scenarios',
          location: JSON.stringify({
            type: 'Point',
            coordinates: [-74.006, 40.7128], // New York, NY
          }),
          community_id: testCommunities[2].id,
        },
      ])
      .returning();

    console.log('🌱 Test data seeded');

    return {
      communities: testCommunities,
      places: testPlaces,
    };
  }

  /**
   * Execute raw SQL for advanced testing scenarios
   */
  async executeRaw(sql: string): Promise<any> {
    if (!this.sqlite) {
      throw new Error('Database not initialized');
    }
    return this.sqlite.exec(sql);
  }

  /**
   * Get database statistics for performance testing
   */
  async getStats(): Promise<{
    communities: number;
    places: number;
    memoryUsage: string;
  }> {
    const db = await this.getDb();

    const communitiesCount = await db
      .select({ count: sql`count(*)` })
      .from(communities);
    const placesCount = await db.select({ count: sql`count(*)` }).from(places);

    return {
      communities: Number(communitiesCount[0]?.count || 0),
      places: Number(placesCount[0]?.count || 0),
      memoryUsage: this.sqlite ? `${this.sqlite.memory.used} bytes` : '0 bytes',
    };
  }
}

/**
 * Test fixtures data structure
 */
export interface TestFixtures {
  communities: Community[];
  places: Place[];
}

/**
 * Factory for creating test data
 */
export class TestDataFactory {
  static createCommunity(
    overrides: Partial<Community> = {}
  ): Omit<Community, 'id' | 'createdAt' | 'updatedAt'> {
    const uniqueId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    return {
      name: 'Factory Community',
      description: 'A community created by the test factory',
      slug: `factory-community-${uniqueId}`,
      publicStories: true,
      ...overrides,
    };
  }

  static createPlace(
    communityId: number,
    overrides: Partial<Place> = {}
  ): Omit<Place, 'id' | 'created_at' | 'updated_at'> {
    return {
      name: 'Factory Place',
      description: 'A place created by the test factory',
      location: JSON.stringify({
        type: 'Point',
        coordinates: [-123.1234, 49.2827],
      }),
      boundary: null,
      community_id: communityId,
      ...overrides,
    };
  }

  /**
   * Create test data with spatial variety
   */
  static createSpatialTestData(communityId: number) {
    return [
      {
        name: 'Vancouver Point',
        location: JSON.stringify({
          type: 'Point',
          coordinates: [-123.1207, 49.2827],
        }),
        community_id: communityId,
      },
      {
        name: 'Toronto Point',
        location: JSON.stringify({
          type: 'Point',
          coordinates: [-79.3832, 43.6532],
        }),
        community_id: communityId,
      },
      {
        name: 'Montreal Point',
        location: JSON.stringify({
          type: 'Point',
          coordinates: [-73.5673, 45.5017],
        }),
        community_id: communityId,
      },
    ];
  }
}

/**
 * Global test database instance for sharing across tests
 */
export const testDb = new TestDatabaseManager();

/**
 * Legacy functions for backward compatibility
 */
export async function setupTestDatabase() {
  return await testDb.setup();
}

export async function teardownTestDatabase() {
  return await testDb.teardown();
}

export async function clearTestData() {
  return await testDb.clearData();
}
