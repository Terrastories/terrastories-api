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
  communitiesSqlite,
  placesSqlite,
  usersSqlite,
  filesSqlite,
  storiesSqlite,
  speakersSqlite,
  themesSqlite,
  Community,
  Place,
  User,
  Speaker,
} from '../../src/db/schema/index.js';

// Use SQLite tables for tests
const communities = communitiesSqlite;
const places = placesSqlite;
const users = usersSqlite;
const files = filesSqlite;
const stories = storiesSqlite;
const speakers = speakersSqlite;
const themes = themesSqlite;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export type TestDatabase = ReturnType<
  typeof drizzle<{
    communities: typeof communities;
    places: typeof places;
    users: typeof users;
    files: typeof files;
    stories: typeof stories;
    speakers: typeof speakers;
    themes: typeof themes;
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
      schema: { communities, places, users, files, stories, speakers, themes },
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
      console.error('❌ Migration failed:', error.message);
      console.error('Migration error stack:', error.stack);
      throw new Error(`Database migration failed: ${error.message}`);
    }

    // Add missing columns and tables that are not in migrations yet
    try {
      // Check if locale column exists in communities, if not add missing columns
      const communitiesTableInfo = this.sqlite
        .prepare('PRAGMA table_info(communities)')
        .all() as any[];
      const hasLocale = communitiesTableInfo.some(
        (col: any) => col.name === 'locale'
      );
      const hasCountry = communitiesTableInfo.some(
        (col: any) => col.name === 'country'
      );
      const hasBeta = communitiesTableInfo.some(
        (col: any) => col.name === 'beta'
      );

      if (!hasLocale) {
        this.sqlite.exec(`
          ALTER TABLE communities ADD COLUMN locale TEXT DEFAULT 'en' NOT NULL;
          ALTER TABLE communities ADD COLUMN cultural_settings TEXT;
          ALTER TABLE communities ADD COLUMN is_active INTEGER DEFAULT 1 NOT NULL;
        `);
        console.log('✅ Added missing communities columns');
      }

      // Add Rails compatibility fields if missing
      if (!hasCountry) {
        this.sqlite.exec(`
          ALTER TABLE communities ADD COLUMN country TEXT;
        `);
        console.log('✅ Added country column to communities');
      }

      if (!hasBeta) {
        this.sqlite.exec(`
          ALTER TABLE communities ADD COLUMN beta INTEGER DEFAULT 0 NOT NULL;
        `);
        console.log('✅ Added beta column to communities');
      }

      // Add CHECK constraint for country validation (if not already exists)
      try {
        this.sqlite.exec(`
          ALTER TABLE communities ADD CONSTRAINT country_uppercase_iso 
            CHECK (country IS NULL OR (length(country) = 2 AND country = upper(country)));
        `);
        console.log('✅ Added country validation constraint');
      } catch (error) {
        // Constraint may already exist, ignore error
        if (
          !error.message.includes('already exists') &&
          !error.message.includes('duplicate')
        ) {
          console.log('⚠️ Country constraint may already exist');
        }
      }

      // Create themes table if it doesn't exist (new feature not in migrations yet)
      const tables = this.sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='themes'"
        )
        .all();

      if (tables.length === 0) {
        this.sqlite.exec(`
          CREATE TABLE IF NOT EXISTS themes (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              name TEXT NOT NULL,
              description TEXT,
              mapbox_style_url TEXT,
              mapbox_access_token TEXT,
              center_lat REAL,
              center_long REAL,
              sw_boundary_lat REAL,
              sw_boundary_long REAL,
              ne_boundary_lat REAL,
              ne_boundary_long REAL,
              active INTEGER NOT NULL DEFAULT 0,
              community_id INTEGER NOT NULL,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL,
              FOREIGN KEY (community_id) REFERENCES communities(id)
          );

          -- Add indexes for performance (matching Rails schema)
          CREATE INDEX IF NOT EXISTS idx_themes_community_id ON themes(community_id);
          CREATE INDEX IF NOT EXISTS idx_themes_active ON themes(active);
          CREATE INDEX IF NOT EXISTS idx_themes_name ON themes(name);
          CREATE INDEX IF NOT EXISTS idx_themes_community_active ON themes(community_id, active);
        `);
        console.log('✅ Added themes table with indexes');
      }

      // Check if columns exist in stories, if not add missing columns
      const storiesTableInfo = this.sqlite
        .prepare('PRAGMA table_info(stories)')
        .all() as any[];
      const hasSlug = storiesTableInfo.some((col: any) => col.name === 'slug');
      const hasPrivacyLevel = storiesTableInfo.some(
        (col: any) => col.name === 'privacy_level'
      );
      const hasDateInterviewed = storiesTableInfo.some(
        (col: any) => col.name === 'date_interviewed'
      );
      const hasInterviewLocationId = storiesTableInfo.some(
        (col: any) => col.name === 'interview_location_id'
      );
      const hasInterviewerId = storiesTableInfo.some(
        (col: any) => col.name === 'interviewer_id'
      );

      const needsColumns =
        !hasSlug ||
        !hasPrivacyLevel ||
        !hasDateInterviewed ||
        !hasInterviewLocationId ||
        !hasInterviewerId;

      if (needsColumns) {
        const alterCommands = [];
        if (!hasSlug) {
          alterCommands.push('ALTER TABLE stories ADD COLUMN slug TEXT;');
        }
        if (!hasPrivacyLevel) {
          alterCommands.push(
            "ALTER TABLE stories ADD COLUMN privacy_level TEXT DEFAULT 'public' NOT NULL;"
          );
        }
        // Add interview metadata columns from migration 0008
        if (!hasDateInterviewed) {
          alterCommands.push(
            'ALTER TABLE stories ADD COLUMN date_interviewed INTEGER;'
          );
        }
        if (!hasInterviewLocationId) {
          alterCommands.push(
            'ALTER TABLE stories ADD COLUMN interview_location_id INTEGER REFERENCES places(id);'
          );
        }
        if (!hasInterviewerId) {
          alterCommands.push(
            'ALTER TABLE stories ADD COLUMN interviewer_id INTEGER REFERENCES speakers(id);'
          );
        }

        try {
          this.sqlite.exec(alterCommands.join('\n'));
          console.log(
            '✅ Added missing stories columns (slug, privacy_level, interview metadata)'
          );
        } catch (error: any) {
          // Ignore duplicate column errors - this means the columns already exist
          if (error.message.includes('duplicate column name')) {
            console.log('ℹ️ Stories columns already exist, skipping add');
          } else {
            console.error('⚠️ Failed to add stories columns:', error.message);
          }
        }
      }

      // Check if authentication fields exist in users table (Issue #80)
      const usersTableInfo = this.sqlite
        .prepare('PRAGMA table_info(users)')
        .all() as any[];
      const hasResetToken = usersTableInfo.some(
        (col: any) => col.name === 'reset_password_token'
      );

      if (!hasResetToken) {
        this.sqlite.exec(`
          ALTER TABLE users ADD COLUMN reset_password_token TEXT;
          ALTER TABLE users ADD COLUMN reset_password_sent_at INTEGER;
          ALTER TABLE users ADD COLUMN remember_created_at INTEGER;
          ALTER TABLE users ADD COLUMN sign_in_count INTEGER DEFAULT 0 NOT NULL;
          ALTER TABLE users ADD COLUMN last_sign_in_at INTEGER;
          ALTER TABLE users ADD COLUMN current_sign_in_ip TEXT;
        `);
        console.log('✅ Added missing users authentication fields');
      }

      // Add indexes for performance optimization
      try {
        this.sqlite.exec(`
          CREATE INDEX IF NOT EXISTS idx_users_reset_password_token ON users(reset_password_token) WHERE reset_password_token IS NOT NULL;
          CREATE INDEX IF NOT EXISTS idx_users_community_email ON users(community_id, email);
        `);
        console.log('✅ Added authentication performance indexes');
      } catch (error: any) {
        // Indexes might already exist
        if (!error.message.includes('already exists')) {
          console.error(
            '⚠️ Failed to add authentication indexes:',
            error.message
          );
        }
      }

      // Add direct file URL columns for dual-read capability (Issue #89)
      // Check places table for photo_url column
      const placesTableInfo = this.sqlite
        .prepare('PRAGMA table_info(places)')
        .all() as any[];
      const hasPhotoUrl = placesTableInfo.some(
        (col: any) => col.name === 'photo_url'
      );

      if (!hasPhotoUrl) {
        this.sqlite.exec(`
          ALTER TABLE places ADD COLUMN photo_url TEXT;
        `);
        console.log('✅ Added photo_url column to places');
      }

      // Check stories table for image_url and audio_url columns
      const hasImageUrl = storiesTableInfo.some(
        (col: any) => col.name === 'image_url'
      );
      const hasAudioUrl = storiesTableInfo.some(
        (col: any) => col.name === 'audio_url'
      );

      if (!hasImageUrl || !hasAudioUrl) {
        const urlCommands = [];
        if (!hasImageUrl) {
          urlCommands.push('ALTER TABLE stories ADD COLUMN image_url TEXT;');
        }
        if (!hasAudioUrl) {
          urlCommands.push('ALTER TABLE stories ADD COLUMN audio_url TEXT;');
        }
        this.sqlite.exec(urlCommands.join('\n'));
        console.log('✅ Added direct URL columns to stories');
      }

      // Check speakers table for bio_audio_url column
      const speakersTableInfo = this.sqlite
        .prepare('PRAGMA table_info(speakers)')
        .all() as any[];
      const hasBioAudioUrl = speakersTableInfo.some(
        (col: any) => col.name === 'bio_audio_url'
      );

      if (!hasBioAudioUrl) {
        this.sqlite.exec(`
          ALTER TABLE speakers ADD COLUMN bio_audio_url TEXT;
        `);
        console.log('✅ Added bio_audio_url column to speakers');
      }

      // Add missing columns to join tables for story associations
      try {
        const storyPlacesInfo = this.sqlite
          .prepare('PRAGMA table_info(story_places)')
          .all() as any[];
        const hasPlacesContext = storyPlacesInfo.some(
          (col: any) => col.name === 'cultural_context'
        );

        if (!hasPlacesContext && storyPlacesInfo.length > 0) {
          this.sqlite.exec(`
            ALTER TABLE story_places ADD COLUMN cultural_context TEXT;
            ALTER TABLE story_places ADD COLUMN sort_order INTEGER DEFAULT 0;
          `);
          console.log('✅ Added missing story_places columns');
        }

        const storySpeakersInfo = this.sqlite
          .prepare('PRAGMA table_info(story_speakers)')
          .all() as any[];
        const hasSpeakersRole = storySpeakersInfo.some(
          (col: any) => col.name === 'story_role'
        );

        if (!hasSpeakersRole && storySpeakersInfo.length > 0) {
          this.sqlite.exec(`
            ALTER TABLE story_speakers ADD COLUMN story_role TEXT;
            ALTER TABLE story_speakers ADD COLUMN sort_order INTEGER DEFAULT 0;
          `);
          console.log('✅ Added missing story_speakers columns');
        }
      } catch (error: any) {
        console.warn(
          '⚠️ Error adding association columns (may not exist yet):',
          error.message
        );
      }
    } catch (error: any) {
      console.warn('⚠️ Error adding missing columns:', error.message);
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
   * Now with proper foreign key constraint handling
   */
  async clearData(): Promise<void> {
    if (!this.db) return;

    try {
      // Disable foreign key constraints temporarily for cleanup
      if (this.sqlite) {
        this.sqlite.pragma('foreign_keys = OFF');
      }

      // Clear in dependency order (children first to handle foreign keys)
      // First clear join tables if they exist
      try {
        // Execute raw SQL for join tables since they may not be in schema yet
        if (this.sqlite) {
          this.sqlite.exec('DELETE FROM story_speakers WHERE 1=1');
          this.sqlite.exec('DELETE FROM story_places WHERE 1=1');
        }
      } catch (error: any) {
        // Join tables might not exist yet
        console.warn(
          '⚠️ Join tables not found (expected for some tests):',
          error.message
        );
      }

      // Clear main entity tables in dependency order
      await this.db.delete(stories);
      await this.db.delete(files);
      await this.db.delete(speakers);
      await this.db.delete(places);
      await this.db.delete(themes);
      await this.db.delete(users);
      await this.db.delete(communities);

      // Re-enable foreign key constraints
      if (this.sqlite) {
        this.sqlite.pragma('foreign_keys = ON');
      }

      console.log('🧹 All test data cleared with proper foreign key handling');
    } catch (error: any) {
      console.warn('⚠️ Could not clear test data:', error.message);

      // Make sure foreign keys are re-enabled even if cleanup fails
      if (this.sqlite) {
        this.sqlite.pragma('foreign_keys = ON');
      }
    }
  }

  /**
   * Clear only places data from the database, preserving users and communities
   */
  async clearPlaces(): Promise<void> {
    if (!this.db) return;

    try {
      // Clear stories that reference places first
      await this.db.delete(stories);
      await this.db.delete(files);
      // Clear places
      await this.db.delete(places);
      console.log('🧹 Places test data cleared');
    } catch (error: any) {
      console.warn('⚠️ Could not clear places data:', error.message);
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
   * Ensure all schema modifications are applied (extracted from setup for reuse)
   */
  private async ensureSchemaUpdated(): Promise<void> {
    if (!this.sqlite) {
      throw new Error('Database not initialized');
    }

    // Add missing columns and tables that are not in migrations yet
    try {
      // Add direct file URL columns for dual-read capability (Issue #89)
      // Check places table for photo_url column
      const placesTableInfo = this.sqlite
        .prepare('PRAGMA table_info(places)')
        .all() as any[];
      const hasPhotoUrl = placesTableInfo.some(
        (col: any) => col.name === 'photo_url'
      );

      if (!hasPhotoUrl) {
        this.sqlite.exec(`
          ALTER TABLE places ADD COLUMN photo_url TEXT;
        `);
        console.log('✅ Added photo_url column to places');
      }
    } catch (error: any) {
      console.warn('⚠️ Error ensuring schema updates:', error.message);
    }
  }

  /**
   * Seed database with test fixture data
   */
  async seedTestData(): Promise<TestFixtures> {
    const db = await this.getDb();

    // Ensure all schema modifications are applied before seeding
    await this.ensureSchemaUpdated();

    // Insert test communities with unique slugs per test run
    const timestamp = Date.now();
    // Insert system-level community for super admin tests (ID will be 1, but we'll use it as system-level)
    const systemCommunity = await db
      .insert(communities)
      .values([
        {
          name: 'System Level',
          description: 'System-level community for super admin operations',
          slug: `system-${timestamp}`,
          publicStories: false,
          locale: 'en',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ])
      .returning();

    const testCommunities = await db
      .insert(communities)
      .values([
        {
          name: 'Test Community',
          description: 'A test community for unit tests',
          slug: `test-community-${timestamp}`,
          publicStories: true,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        {
          name: 'Demo Community',
          description: 'A demo community for integration tests',
          slug: `demo-community-${timestamp}`,
          publicStories: false,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        {
          name: 'Isolated Test Community',
          description: 'Community for isolated test scenarios',
          slug: `isolated-test-${timestamp}`,
          publicStories: true,
          createdAt: Date.now(),
          updatedAt: Date.now(),
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
          latitude: 49.2827, // Vancouver, BC
          longitude: -123.1234,
          region: 'Vancouver',
          mediaUrls: [],
          photoUrl: null, // Add the new column
          culturalSignificance: null,
          isRestricted: false,
          communityId: testCommunities[0].id,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        {
          name: 'Test Place 2',
          description: 'Second test place with coordinates',
          latitude: 43.6532, // Toronto, ON
          longitude: -79.3832,
          region: 'Toronto',
          mediaUrls: [],
          photoUrl: null, // Add the new column
          culturalSignificance: null,
          communityId: testCommunities[0].id,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        {
          name: 'Isolated Test Place',
          description: 'Place for isolated test scenarios',
          latitude: 40.7128, // New York, NY
          longitude: -74.006,
          region: 'New York',
          mediaUrls: [],
          photoUrl: null, // Add the new column
          culturalSignificance: null,
          isRestricted: false,
          communityId: testCommunities[2].id,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ])
      .returning();

    console.log('🌱 Test data seeded');

    return {
      systemCommunity: systemCommunity[0],
      communities: testCommunities,
      places: testPlaces,
    };
  }

  /**
   * Execute raw SQL for advanced testing scenarios
   */
  /**
   * Execute raw SQL for advanced testing scenarios
   */
  async executeRaw(sql: string): Promise<any> {
    if (!this.sqlite) {
      throw new Error('Database not initialized');
    }

    // Handle queries that return results (like EXPLAIN QUERY PLAN)
    const trimmedSql = sql.trim().toUpperCase();
    if (
      trimmedSql.startsWith('EXPLAIN') ||
      trimmedSql.startsWith('SELECT') ||
      trimmedSql.startsWith('PRAGMA')
    ) {
      // Use prepare().all() for queries that return results
      try {
        const stmt = this.sqlite.prepare(sql);
        return stmt.all();
      } catch (error: any) {
        console.error('Error executing query:', error.message);
        throw error;
      }
    }

    // Use exec() for statements that don't return results
    return this.sqlite.exec(sql);
  }

  /**
   * Get database statistics for performance testing
   */
  async getStats(): Promise<{
    communities: number;
    places: number;
    speakers: number;
    users: number;
    memoryUsage: string;
  }> {
    const db = await this.getDb();

    const communitiesCount = await db
      .select({ count: sql`count(*)` })
      .from(communities);
    const placesCount = await db.select({ count: sql`count(*)` }).from(places);
    const speakersCount = await db
      .select({ count: sql`count(*)` })
      .from(speakers);
    const usersCount = await db.select({ count: sql`count(*)` }).from(users);

    return {
      communities: Number(communitiesCount[0]?.count || 0),
      places: Number(placesCount[0]?.count || 0),
      speakers: Number(speakersCount[0]?.count || 0),
      users: Number(usersCount[0]?.count || 0),
      memoryUsage: this.sqlite ? `${this.sqlite.memory.used} bytes` : '0 bytes',
    };
  }

  /**
   * Cleanup method for test lifecycle (combines clear + teardown)
   */
  async cleanup(): Promise<void> {
    await this.clearData();
    await this.teardown();
  }
}

/**
 * Test fixtures data structure
 */
export interface TestFixtures {
  systemCommunity: Community;
  communities: Community[];
  places: Place[];
  speakers?: Speaker[];
  users?: User[];
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
      locale: 'en',
      culturalSettings: null,
      isActive: true,
      ...overrides,
    };
  }

  static createPlace(
    communityId: number,
    overrides: Partial<Place> = {}
  ): Omit<Place, 'id' | 'createdAt' | 'updatedAt'> {
    return {
      name: 'Factory Place',
      description: 'A place created by the test factory',
      latitude: 49.2827,
      longitude: -123.1234,
      region: 'Vancouver',
      mediaUrls: [],
      culturalSignificance: null,
      isRestricted: false,
      communityId: communityId,
      ...overrides,
    };
  }

  static createUser(
    communityId: number,
    overrides: Partial<User> = {}
  ): Omit<User, 'id' | 'createdAt' | 'updatedAt'> {
    const uniqueId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    return {
      email: `user-${uniqueId}@factory.test`,
      passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$hash',
      firstName: 'Factory',
      lastName: 'User',
      role: 'viewer' as const,
      communityId: communityId,
      isActive: true,
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
        latitude: 49.2827,
        longitude: -123.1207,
        region: 'Vancouver',
        mediaUrls: [],
        culturalSignificance: null,
        isRestricted: false,
        communityId: communityId,
      },
      {
        name: 'Toronto Point',
        latitude: 43.6532,
        longitude: -79.3832,
        region: 'Toronto',
        mediaUrls: [],
        culturalSignificance: null,
        isRestricted: false,
        communityId: communityId,
      },
      {
        name: 'Montreal Point',
        latitude: 45.5017,
        longitude: -73.5673,
        region: 'Montreal',
        mediaUrls: [],
        culturalSignificance: null,
        isRestricted: false,
        communityId: communityId,
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

/**
 * Cleanup method for tests (combines clear + teardown)
 */
export async function cleanup() {
  await testDb.clearData();
  await testDb.teardown();
}

/**
 * Setup test database - alias for setupTestDatabase
 */
export async function setupTestDb() {
  return await testDb.setup();
}

/**
 * Cleanup test database - alias for cleanup
 */
export async function cleanupTestDb() {
  return await testDb.cleanup();
}

/**
 * Create comprehensive test data for story service tests
 */
export async function createTestData() {
  const fixtures = await testDb.seedTestData();

  // Create users for all roles needed in story tests
  const db = await testDb.getDb();

  const testUsers = await db
    .insert(users)
    .values([
      {
        email: 'admin@test.com',
        passwordHash:
          '$argon2id$v=19$m=65536,t=3,p=4$tCxyO6RAN/yxOKo7TkGnXg$3kM2t3GUmirQtHwtkPp/Pwu7fvbNwYoqWNvr/HLaGCE',
        firstName: 'Admin',
        lastName: 'User',
        role: 'admin',
        communityId: fixtures.communities[0].id,
        isActive: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      {
        email: 'editor@test.com',
        passwordHash:
          '$argon2id$v=19$m=65536,t=3,p=4$tCxyO6RAN/yxOKo7TkGnXg$3kM2t3GUmirQtHwtkPp/Pwu7fvbNwYoqWNvr/HLaGCE',
        firstName: 'Editor',
        lastName: 'User',
        role: 'editor',
        communityId: fixtures.communities[0].id,
        isActive: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      {
        email: 'elder@test.com',
        passwordHash:
          '$argon2id$v=19$m=65536,t=3,p=4$tCxyO6RAN/yxOKo7TkGnXg$3kM2t3GUmirQtHwtkPp/Pwu7fvbNwYoqWNvr/HLaGCE',
        firstName: 'Elder',
        lastName: 'User',
        role: 'elder',
        communityId: fixtures.communities[0].id,
        isActive: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      {
        email: 'viewer@test.com',
        passwordHash:
          '$argon2id$v=19$m=65536,t=3,p=4$tCxyO6RAN/yxOKo7TkGnXg$3kM2t3GUmirQtHwtkPp/Pwu7fvbNwYoqWNvr/HLaGCE',
        firstName: 'Viewer',
        lastName: 'User',
        role: 'viewer',
        communityId: fixtures.communities[0].id,
        isActive: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      {
        email: 'superadmin@test.com',
        passwordHash:
          '$argon2id$v=19$m=65536,t=3,p=4$tCxyO6RAN/yxOKo7TkGnXg$3kM2t3GUmirQtHwtkPp/Pwu7fvbNwYoqWNvr/HLaGCE',
        firstName: 'Super',
        lastName: 'Admin',
        role: 'super_admin',
        communityId: fixtures.systemCommunity.id,
        isActive: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      {
        email: 'other@test.com',
        passwordHash:
          '$argon2id$v=19$m=65536,t=3,p=4$tCxyO6RAN/yxOKo7TkGnXg$3kM2t3GUmirQtHwtkPp/Pwu7fvbNwYoqWNvr/HLaGCE',
        firstName: 'Other',
        lastName: 'Community',
        role: 'editor',
        communityId: fixtures.communities[1].id,
        isActive: true,
      },
    ])
    .returning();

  // Create and insert test speakers into the database
  const testSpeakers = await db
    .insert(speakers)
    .values([
      {
        name: 'Elder Maria Stonebear',
        bio: 'Traditional knowledge keeper',
        bioAudioUrl: null, // Add the new column
        elderStatus: true,
        communityId: fixtures.communities[0].id,
        culturalRole: 'Knowledge Keeper',
        isActive: true,
      },
      {
        name: 'John Rivercrossing',
        bio: 'Community storyteller',
        bioAudioUrl: null, // Add the new column
        elderStatus: false,
        communityId: fixtures.communities[0].id,
        culturalRole: 'Storyteller',
        isActive: true,
      },
    ])
    .returning();

  // Create test files
  const testFiles = [
    {
      id: 'file1',
      path: '/uploads/story-image.jpg',
      communityId: fixtures.communities[0].id,
    },
    {
      id: 'file2',
      path: '/uploads/story-audio.mp3',
      communityId: fixtures.communities[0].id,
    },
  ];

  return {
    community: fixtures.communities[0],
    users: {
      admin: testUsers[0],
      editor: testUsers[1],
      elder: testUsers[2],
      viewer: testUsers[3],
      superAdmin: testUsers[4],
      otherCommunityUser: testUsers[5],
    },
    places: fixtures.places.filter(
      (p) => p.communityId === fixtures.communities[0].id
    ),
    speakers: testSpeakers,
    files: testFiles,
  };
}
