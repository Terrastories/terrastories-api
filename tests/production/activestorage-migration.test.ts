/**
 * TERRASTORIES API - ACTIVESTORAGE MIGRATION PRODUCTION VALIDATION
 *
 * This test suite validates production migration performance and cleanup issues
 * reported in Issue #64: Resolve Performance Test Cleanup and Foreign Key Issues
 *
 * Key Focus Areas:
 * - Database cleanup handling relationship dependencies properly
 * - Performance test data isolation between test runs
 * - Large file handling optimization for resource-constrained deployments
 * - Resource usage validation for Indigenous community hardware specs
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import Database from 'better-sqlite3';
import {
  ActiveStorageMigrator,
  MigrationConfig,
} from '../../src/services/activestorage-migrator.js';

describe('Production ActiveStorage Migration Performance', () => {
  let testDbPath: string;
  let testConfig: MigrationConfig;
  let migrator: ActiveStorageMigrator;

  beforeAll(async () => {
    testDbPath = join(process.cwd(), 'production_performance_test.db');

    testConfig = {
      database: `sqlite:${testDbPath}`,
      activeStoragePath: join(process.cwd(), 'test_production_storage'),
      uploadsPath: join(process.cwd(), 'test_production_uploads'),
      dryRun: false,
    };

    // Create test directories
    await fs.mkdir(testConfig.activeStoragePath, { recursive: true });
    await fs.mkdir(testConfig.uploadsPath, { recursive: true });
  });

  afterAll(async () => {
    // Clean up test directories and database
    try {
      await fs.unlink(testDbPath);
      await fs.rm(testConfig.activeStoragePath, {
        recursive: true,
        force: true,
      });
      await fs.rm(testConfig.uploadsPath, { recursive: true, force: true });

      // Clean up any backup directories created during testing
      const backupDirs = await fs.readdir(process.cwd());
      for (const dir of backupDirs) {
        if (dir.startsWith('backup-')) {
          await fs.rm(dir, { recursive: true, force: true });
        }
      }
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  beforeEach(async () => {
    // Initialize fresh database for each test
    const db = new Database(testDbPath);

    // Create schema with proper foreign key constraints
    db.exec(`
      PRAGMA foreign_keys = ON;
      
      CREATE TABLE IF NOT EXISTS communities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        locale TEXT DEFAULT 'en'
      );
      
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'viewer',
        community_id INTEGER NOT NULL,
        FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE CASCADE
      );
      
      CREATE TABLE IF NOT EXISTS stories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        slug TEXT NOT NULL,
        community_id INTEGER NOT NULL,
        created_by INTEGER NOT NULL,
        media_urls TEXT DEFAULT '[]',
        FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE CASCADE,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
      );
      
      CREATE TABLE IF NOT EXISTS places (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        community_id INTEGER NOT NULL,
        photo_url TEXT,
        FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE CASCADE
      );
      
      CREATE TABLE IF NOT EXISTS speakers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        community_id INTEGER NOT NULL,
        photo_url TEXT,
        FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE CASCADE
      );
      
      CREATE TABLE IF NOT EXISTS active_storage_blobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL UNIQUE,
        filename TEXT NOT NULL,
        content_type TEXT,
        byte_size INTEGER,
        checksum TEXT
      );
      
      CREATE TABLE IF NOT EXISTS active_storage_attachments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        record_type TEXT NOT NULL,
        record_id INTEGER NOT NULL,
        blob_id INTEGER NOT NULL,
        FOREIGN KEY (blob_id) REFERENCES active_storage_blobs(id) ON DELETE CASCADE
      );
    `);

    db.close();
    migrator = new ActiveStorageMigrator(testConfig);
  });

  afterEach(async () => {
    if (migrator) {
      await migrator.closeClient();
    }
  });

  describe('Foreign Key Constraint Handling', () => {
    it('should fail: handle foreign key constraints during test cleanup', async () => {
      // This test should fail initially - we need to implement proper foreign key handling

      // Insert test data with foreign key relationships
      const db = new Database(testDbPath);

      // Insert community
      const communityResult = db
        .prepare(
          `
        INSERT INTO communities (name, slug, locale) VALUES (?, ?, ?)
      `
        )
        .run('Test Community', 'test-community', 'en');
      const communityId = communityResult.lastInsertRowid;

      // Insert user
      const userResult = db
        .prepare(
          `
        INSERT INTO users (email, name, role, community_id) VALUES (?, ?, ?, ?)
      `
        )
        .run('test@example.com', 'Test User', 'admin', communityId);
      const userId = userResult.lastInsertRowid;

      // Insert story with foreign key references
      db.prepare(
        `
        INSERT INTO stories (title, slug, community_id, created_by) 
        VALUES (?, ?, ?, ?)
      `
      ).run('Test Story', 'test-story', communityId, userId);

      // Insert blob
      const blobResult = db
        .prepare(
          `
        INSERT INTO active_storage_blobs (key, filename, content_type, byte_size, checksum)
        VALUES (?, ?, ?, ?, ?)
      `
        )
        .run('testkey123', 'test.jpg', 'image/jpeg', 1024, 'abcd1234');
      const blobId = blobResult.lastInsertRowid;

      // Insert attachment with foreign key reference
      db.prepare(
        `
        INSERT INTO active_storage_attachments (name, record_type, record_id, blob_id)
        VALUES (?, ?, ?, ?)
      `
      ).run('media', 'Story', 1, blobId);

      db.close();

      // This should fail currently - we need proper foreign key constraint handling
      // Attempting to delete in wrong order (parent before child) should fail
      const cleanupResult = await migrator.cleanupTestData();

      // The test should fail because cleanup doesn't handle foreign keys properly
      expect(cleanupResult.success).toBe(true); // This will fail initially
      expect(cleanupResult.errors).toHaveLength(0);
    });

    it('should fail: handle cascading deletes properly', async () => {
      // This test should fail initially - cascading deletes not properly implemented
      const db = new Database(testDbPath);

      // Insert test data
      const communityId = db
        .prepare(
          `
        INSERT INTO communities (name, slug) VALUES (?, ?)
      `
        )
        .run('Delete Test Community', 'delete-test').lastInsertRowid;

      const userId = db
        .prepare(
          `
        INSERT INTO users (email, name, community_id) VALUES (?, ?, ?)
      `
        )
        .run('delete@test.com', 'Delete User', communityId).lastInsertRowid;

      db.prepare(
        `
        INSERT INTO stories (title, slug, community_id, created_by) VALUES (?, ?, ?, ?)
      `
      ).run('Delete Story', 'delete-story', communityId, userId);

      db.close();

      // This should fail initially - proper cascading delete not implemented
      const deleteResult = await migrator.performCascadingDelete(
        'communities',
        Number(communityId)
      );

      expect(deleteResult.success).toBe(true); // This will fail initially
      expect(deleteResult.orphanedRecords).toHaveLength(0);
    });
  });

  describe('Performance Test Data Isolation', () => {
    it('should fail: isolate performance test data between runs', async () => {
      // This test should fail initially - test data not properly isolated

      // First test run
      const firstRunResult = await migrator.performBulkMigration(10);
      expect(firstRunResult.filesProcessed).toBe(10);

      // Second test run - should not interfere with first
      const secondRunResult = await migrator.performBulkMigration(5);

      // This should fail initially - second run may interfere with first
      expect(secondRunResult.filesProcessed).toBe(5); // This will fail if isolation is broken
      expect(secondRunResult.conflicts).toHaveLength(0);
    });

    it('should fail: clean up backup directories after test runs', async () => {
      // This test should fail initially - backup directories not cleaned up

      // Perform migration that creates backup directories
      await migrator.migrateByCommunity(1);

      // Check for backup directories
      const files = await fs.readdir(process.cwd());
      const backupDirs = files.filter((file) => file.startsWith('backup-'));

      // This should fail initially - backup directories not cleaned up
      expect(backupDirs).toHaveLength(0); // This will fail initially
    });
  });

  describe('Large File Handling Optimization', () => {
    it('should fail: optimize large file handling for resource constraints', async () => {
      // This test should fail initially - large file handling not optimized

      // Create mock large files
      const largeFileSize = 100 * 1024 * 1024; // 100MB
      const largeFileContent = Buffer.alloc(largeFileSize, 'a');

      const largeFilePath = join(
        testConfig.activeStoragePath,
        'large-file.mp4'
      );
      await fs.writeFile(largeFilePath, largeFileContent);

      const startTime = Date.now();
      const result = await migrator.migrateFile('large-file.mp4', 1);
      const duration = Date.now() - startTime;

      // This should fail initially - large file handling not optimized
      expect(duration).toBeLessThan(5000); // Should complete in under 5 seconds
      expect(result.memoryUsage).toBeLessThan(50 * 1024 * 1024); // Should use less than 50MB memory
    });

    it('should fail: validate resource usage for Field Kit deployment', async () => {
      // This test should fail initially - resource validation not implemented

      // Simulate Field Kit hardware constraints
      const fieldKitLimits = {
        maxMemoryUsage: 128 * 1024 * 1024, // 128MB
        maxDiskSpace: 1024 * 1024 * 1024, // 1GB
        maxProcessingTime: 30000, // 30 seconds
      };

      const resourceUsage =
        await migrator.validateResourceUsage(fieldKitLimits);

      // This should fail initially - resource validation not implemented
      expect(resourceUsage.memoryCompliant).toBe(true);
      expect(resourceUsage.diskSpaceCompliant).toBe(true);
      expect(resourceUsage.processingTimeCompliant).toBe(true);
    });
  });

  describe('Performance Benchmarking', () => {
    it('should fail: meet performance benchmarks for Indigenous community hardware', async () => {
      // This test should fail initially - performance benchmarks not met

      const performanceTest = await migrator.runPerformanceBenchmark({
        fileCount: 50,
        totalSizeLimit: 100 * 1024 * 1024, // 100MB
        timeLimit: 60000, // 1 minute
        memoryLimit: 64 * 1024 * 1024, // 64MB
      });

      // This should fail initially - performance not optimized
      expect(performanceTest.completedInTime).toBe(true);
      expect(performanceTest.memoryEfficient).toBe(true);
      expect(performanceTest.errorCount).toBe(0);
    });

    it('should fail: handle concurrent migration operations', async () => {
      // This test should fail initially - concurrent operations not properly handled

      // Start multiple migration operations concurrently
      const promises = Array(5)
        .fill(null)
        .map((_, index) => migrator.migrateByCommunity(index + 1));

      const results = await Promise.allSettled(promises);

      // This should fail initially - concurrent operations may interfere
      const successful = results.filter((r) => r.status === 'fulfilled').length;
      expect(successful).toBe(5); // All should succeed

      const failed = results.filter((r) => r.status === 'rejected').length;
      expect(failed).toBe(0); // None should fail
    });
  });
});
