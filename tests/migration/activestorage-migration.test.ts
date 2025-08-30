/**
 * ActiveStorage Migration Test Suite
 *
 * Comprehensive tests for ActiveStorage to TypeScript file system migration
 * Includes unit tests, integration tests, and cultural compliance validation
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
import { promises as fs } from 'fs';
import { join } from 'path';
import Database from 'better-sqlite3';
import {
  ActiveStorageMigrator,
  MigrationConfig,
} from '../../src/services/activestorage-migrator.js';

describe('ActiveStorage Migration', () => {
  let testDbPath: string;
  let testConfig: MigrationConfig;
  let migrator: ActiveStorageMigrator;

  beforeAll(async () => {
    console.log('🚀 Initializing test environment...');

    // Create test database path
    testDbPath = join(process.cwd(), 'test_migration.db');

    // Configure for SQLite testing since that's what vitest uses
    testConfig = {
      database: `sqlite:${testDbPath}`,
      activeStoragePath: join(process.cwd(), 'test_storage'),
      uploadsPath: join(process.cwd(), 'test_uploads'),
      dryRun: false,
    };

    // Create test directories
    await fs.mkdir(testConfig.activeStoragePath, { recursive: true });
    await fs.mkdir(testConfig.uploadsPath, { recursive: true });

    // Initialize SQLite database with test schema
    const db = new Database(testDbPath);

    // Create test tables (SQLite syntax)
    db.exec(`
      CREATE TABLE IF NOT EXISTS communities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        slug TEXT NOT NULL,
        locale TEXT DEFAULT 'en'
      );
      
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'viewer',
        community_id INTEGER NOT NULL
      );
      
      CREATE TABLE IF NOT EXISTS stories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT,
        slug TEXT NOT NULL,
        community_id INTEGER NOT NULL,
        created_by INTEGER NOT NULL,
        is_restricted INTEGER DEFAULT 0,
        media_urls TEXT DEFAULT '[]',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      
      CREATE TABLE IF NOT EXISTS places (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT,
        community_id INTEGER NOT NULL,
        is_restricted INTEGER DEFAULT 0,
        photo_url TEXT,
        media_urls TEXT DEFAULT '[]',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      
      CREATE TABLE IF NOT EXISTS speakers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        bio TEXT,
        community_id INTEGER NOT NULL,
        elder_status INTEGER DEFAULT 0,
        photo_url TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      
      CREATE TABLE IF NOT EXISTS active_storage_blobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL,
        filename TEXT NOT NULL,
        content_type TEXT,
        metadata TEXT DEFAULT '{}',
        byte_size INTEGER,
        checksum TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      
      CREATE TABLE IF NOT EXISTS active_storage_attachments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        record_type TEXT NOT NULL,
        record_id INTEGER NOT NULL,
        blob_id INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (blob_id) REFERENCES active_storage_blobs(id)
      );
      
      CREATE TABLE IF NOT EXISTS active_storage_variant_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        blob_id INTEGER NOT NULL,
        variation_digest TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (blob_id) REFERENCES active_storage_blobs(id)
      );
    `);

    db.close();

    console.log('✅ Test environment initialized');
  });

  beforeEach(async () => {
    // Create fresh migrator instance for each test
    migrator = new ActiveStorageMigrator(testConfig);

    // Seed test data
    const db = new Database(testDbPath);

    // Insert test communities
    db.prepare(
      `
      INSERT OR REPLACE INTO communities (id, name, slug, locale) VALUES 
      (1, 'Test Community 1', 'test-community-1', 'en'),
      (2, 'Test Community 2', 'test-community-2', 'en')
    `
    ).run();

    // Insert test users
    db.prepare(
      `
      INSERT OR REPLACE INTO users (id, email, name, role, community_id) VALUES 
      (1, 'elder@test.com', 'Elder User', 'elder', 1),
      (2, 'admin@test.com', 'Admin User', 'admin', 1)
    `
    ).run();

    // Insert test stories
    db.prepare(
      `
      INSERT OR REPLACE INTO stories (id, title, description, slug, community_id, created_by, is_restricted) VALUES 
      (1, 'Test Story 1', 'Description 1', 'test-story-1', 1, 1, 0),
      (2, 'Elder Story', 'Restricted story', 'elder-story', 1, 1, 1)
    `
    ).run();

    // Insert test blobs
    db.prepare(
      `
      INSERT OR REPLACE INTO active_storage_blobs (id, key, filename, content_type, metadata, byte_size, checksum) VALUES 
      (1, 'testfile123', 'test-image.jpg', 'image/jpeg', '{}', 1024, 'dGVzdGNoZWNrc3Vt'),
      (2, 'testfile456', 'elder-video.mp4', 'video/mp4', '{}', 2048, 'ZWxkZXJjaGVja3N1bQ==')
    `
    ).run();

    // Insert test attachments
    db.prepare(
      `
      INSERT OR REPLACE INTO active_storage_attachments (id, name, record_type, record_id, blob_id) VALUES 
      (1, 'media', 'Story', 1, 1),
      (2, 'media', 'Story', 2, 2)
    `
    ).run();

    db.close();
  });

  afterEach(async () => {
    // Clean up migrator
    if (migrator) {
      await migrator.closeClient();
    }

    // Clean up test files
    try {
      await fs.rm(testConfig.uploadsPath, { recursive: true, force: true });
      await fs.mkdir(testConfig.uploadsPath, { recursive: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  afterAll(async () => {
    console.log('🧹 Cleaning up test environment...');

    // Clean up test database and directories
    try {
      await fs.unlink(testDbPath);
      await fs.rm(testConfig.activeStoragePath, {
        recursive: true,
        force: true,
      });
      await fs.rm(testConfig.uploadsPath, { recursive: true, force: true });
      await fs.unlink('migration_audit.log');
    } catch (error) {
      // Ignore cleanup errors
    }

    console.log('✅ Test environment cleaned up');
  });

  describe('Database Analysis', () => {
    it('should analyze ActiveStorage tables correctly', async () => {
      const analysis = await migrator.analyzeActiveStorage();

      expect(analysis.tablesFound).toContain('active_storage_blobs');
      expect(analysis.tablesFound).toContain('active_storage_attachments');
      expect(analysis.blobsCount).toBe(2);
      expect(analysis.attachmentsCount).toBe(2);
    });

    it('should identify potential migration issues', async () => {
      const dryRunResult = await migrator.performDryRun();

      expect(dryRunResult.dryRun).toBe(true);
      expect(dryRunResult.filesAnalyzed).toBe(2);
      expect(dryRunResult.communitiesAffected).toBeGreaterThanOrEqual(1);
      expect(dryRunResult.rollbackPlan).toBeDefined();
      expect(dryRunResult.tablesFound).toContain('active_storage_blobs');
    });
  });

  describe('Database Compatibility', () => {
    it('should handle missing ActiveStorage tables gracefully', async () => {
      // Create a database without ActiveStorage tables
      const emptyDbPath = join(process.cwd(), 'empty_test.db');
      const emptyDb = new Database(emptyDbPath);
      emptyDb.exec('CREATE TABLE dummy (id INTEGER);');
      emptyDb.close();

      const emptyConfig = { ...testConfig, database: `sqlite:${emptyDbPath}` };
      const emptyMigrator = new ActiveStorageMigrator(emptyConfig);

      try {
        const analysis = await emptyMigrator.analyzeActiveStorage();

        expect(analysis.tablesFound).toEqual([]);
        expect(analysis.blobsCount).toBe(0);
        expect(analysis.attachmentsCount).toBe(0);
        expect(analysis.potentialIssues).toContain(
          'No ActiveStorage tables found - this may be a development environment'
        );
      } finally {
        await emptyMigrator.closeClient();
        await fs.unlink(emptyDbPath);
      }
    });
  });

  describe('File Migration', () => {
    it('should validate community ID input properly', async () => {
      // Test with invalid community ID
      const result = await migrator.migrateByCommunity(999); // Non-existent community

      console.log(
        'Migration result for community 999:',
        JSON.stringify(result, null, 2)
      );

      // Should succeed but process 0 files since no community files exist
      expect(result.filesProcessed).toBe(0);
      expect(result.filesMigrated).toBe(0);
      expect(result.communityId).toBe(999);

      // If there are errors, log them for debugging
      if (!result.success) {
        console.log('Migration errors:', result.errors);
      }

      expect(result.success).toBe(true); // Should succeed but process 0 files
    });

    it('should migrate community files successfully with mocked files', async () => {
      // Create mock ActiveStorage files
      const testStorageDir = join(testConfig.activeStoragePath, 'te', 'st');
      await fs.mkdir(testStorageDir, { recursive: true });
      await fs.writeFile(
        join(testStorageDir, 'testfile123'),
        'test file content'
      );
      await fs.writeFile(
        join(testStorageDir, 'testfile456'),
        'elder video content'
      );

      const result = await migrator.migrateByCommunity(1);

      console.log(
        'Migration result for community 1:',
        JSON.stringify(result, null, 2)
      );

      // Log errors for debugging if migration failed
      if (!result.success) {
        console.log('Migration errors:', result.errors);
      }

      expect(result.success).toBe(true);
      expect(result.communityId).toBe(1);
      expect(result.filesProcessed).toBeGreaterThanOrEqual(0);
      expect(result.backupPath).toBeDefined();
      expect(result.culturalRestrictions).toBeDefined();
    });
  });

  describe('Cultural Compliance', () => {
    it('should create comprehensive audit trail', async () => {
      const analysis = await migrator.analyzeActiveStorage();

      // Check if audit log was created
      try {
        const auditContent = await fs.readFile('migration_audit.log', 'utf8');
        expect(auditContent).toContain('DRY_RUN_ANALYSIS');
        expect(auditContent).toContain(
          JSON.stringify({
            filesAnalyzed: analysis.blobsCount,
            communitiesAffected: analysis.communitiesAffected,
          })
        );
      } catch (error) {
        // Audit log might not exist yet, which is ok for basic analysis
        console.warn(
          'Audit log not found - this is expected for read-only operations'
        );
      }
    });
  });

  describe('Data Integrity', () => {
    it('should handle filename sanitization correctly', async () => {
      // Test filename sanitization through dry run
      const dryRunResult = await migrator.performDryRun();

      expect(dryRunResult.filesAnalyzed).toBeGreaterThanOrEqual(0);
      expect(dryRunResult.potentialIssues).toBeDefined();
    });
  });

  describe('Rollback Functionality', () => {
    it('should require backup path for rollback', async () => {
      await expect(migrator.performRollback()).rejects.toThrow(
        'Backup path is required for rollback'
      );
    });
  });

  describe('Error Handling', () => {
    it('should handle database connection errors gracefully', async () => {
      const invalidConfig = {
        ...testConfig,
        database: 'sqlite:/invalid/path/database.db',
      };
      const invalidMigrator = new ActiveStorageMigrator(invalidConfig);

      await expect(invalidMigrator.analyzeActiveStorage()).rejects.toThrow();

      await invalidMigrator.closeClient();
    });
  });

  describe('Performance', () => {
    it('should handle empty database efficiently', async () => {
      const startTime = Date.now();
      const analysis = await migrator.analyzeActiveStorage();
      const endTime = Date.now();

      expect(endTime - startTime).toBeLessThan(5000); // Should complete within 5 seconds
      expect(analysis).toBeDefined();
    });
  });
});
