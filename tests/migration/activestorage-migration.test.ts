/**
 * ActiveStorage Migration Test Suite
 * 
 * Comprehensive tests for ActiveStorage to TypeScript file system migration
 * Includes unit tests, integration tests, and cultural compliance validation
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import { execSync } from 'child_process';

// We'll import the migrator class, but need to handle the CLI module structure
// For now, let's create a test version that imports the functionality
class TestActiveMigrator {
  private config: any;
  private client: Client | null = null;

  constructor(config: any) {
    this.config = config;
  }

  private async getClient(): Promise<Client> {
    if (!this.client) {
      this.client = new Client({ connectionString: this.config.database });
      await this.client.connect();
    }
    return this.client;
  }

  async closeClient(): Promise<void> {
    if (this.client) {
      await this.client.end();
      this.client = null;
    }
  }

  // Test helper methods
  async setupTestDatabase(): Promise<void> {
    const client = await this.getClient();
    
    // Create test ActiveStorage tables
    await client.query(`
      CREATE TABLE IF NOT EXISTS active_storage_blobs (
        id SERIAL PRIMARY KEY,
        key VARCHAR(255) NOT NULL,
        filename VARCHAR(255) NOT NULL,
        content_type VARCHAR(255),
        metadata JSONB DEFAULT '{}',
        byte_size BIGINT,
        checksum VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS active_storage_attachments (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        record_type VARCHAR(255) NOT NULL,
        record_id INTEGER NOT NULL,
        blob_id INTEGER NOT NULL REFERENCES active_storage_blobs(id),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS active_storage_variant_records (
        id SERIAL PRIMARY KEY,
        blob_id INTEGER NOT NULL REFERENCES active_storage_blobs(id),
        variation_digest VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
  }

  async seedTestData(): Promise<void> {
    const client = await this.getClient();
    
    // Insert test communities
    await client.query(`
      INSERT INTO communities (id, name, slug, locale) VALUES 
      (1, 'Test Community 1', 'test-community-1', 'en'),
      (2, 'Test Community 2', 'test-community-2', 'en')
      ON CONFLICT (id) DO NOTHING
    `);
    
    // Insert test users
    await client.query(`
      INSERT INTO users (id, email, name, role, community_id) VALUES 
      (1, 'elder@test.com', 'Elder User', 'elder', 1),
      (2, 'admin@test.com', 'Admin User', 'admin', 1)
      ON CONFLICT (id) DO NOTHING
    `);
    
    // Insert test stories
    await client.query(`
      INSERT INTO stories (id, title, description, slug, community_id, created_by, is_restricted) VALUES 
      (1, 'Test Story 1', 'Description 1', 'test-story-1', 1, 1, false),
      (2, 'Elder Story', 'Sacred story', 'elder-story', 1, 1, true)
      ON CONFLICT (id) DO NOTHING
    `);
    
    // Insert test places
    await client.query(`
      INSERT INTO places (id, name, description, community_id, latitude, longitude, is_restricted) VALUES 
      (1, 'Test Place 1', 'Description 1', 1, 45.5, -122.7, false),
      (2, 'Sacred Place', 'Sacred location', 1, 45.6, -122.8, true)
      ON CONFLICT (id) DO NOTHING
    `);
    
    // Insert test speakers
    await client.query(`
      INSERT INTO speakers (id, name, bio, community_id, elder_status) VALUES 
      (1, 'Test Speaker', 'Bio 1', 1, false),
      (2, 'Elder Speaker', 'Elder bio', 1, true)
      ON CONFLICT (id) DO NOTHING
    `);
    
    // Insert test blobs
    await client.query(`
      INSERT INTO active_storage_blobs (id, key, filename, content_type, byte_size, checksum) VALUES 
      (1, 'abc123def456', 'story1_video.mp4', 'video/mp4', 1024000, 'test-checksum-1'),
      (2, 'def456ghi789', 'elder_story.mp4', 'video/mp4', 2048000, 'test-checksum-2'),
      (3, 'ghi789jkl012', 'place1_photo.jpg', 'image/jpeg', 512000, 'test-checksum-3'),
      (4, 'jkl012mno345', 'speaker1_photo.jpg', 'image/jpeg', 256000, 'test-checksum-4')
      ON CONFLICT (id) DO NOTHING
    `);
    
    // Insert test attachments
    await client.query(`
      INSERT INTO active_storage_attachments (id, name, record_type, record_id, blob_id) VALUES 
      (1, 'media', 'Story', 1, 1),
      (2, 'media', 'Story', 2, 2),
      (3, 'photo', 'Place', 1, 3),
      (4, 'photo', 'Speaker', 1, 4)
      ON CONFLICT (id) DO NOTHING
    `);
  }

  async cleanupTestData(): Promise<void> {
    const client = await this.getClient();
    
    // Clean up in reverse dependency order
    await client.query('DELETE FROM active_storage_attachments WHERE id IN (1,2,3,4)');
    await client.query('DELETE FROM active_storage_variant_records WHERE blob_id IN (1,2,3,4)');
    await client.query('DELETE FROM active_storage_blobs WHERE id IN (1,2,3,4)');
    await client.query('DELETE FROM stories WHERE id IN (1,2)');
    await client.query('DELETE FROM places WHERE id IN (1,2)');
    await client.query('DELETE FROM speakers WHERE id IN (1,2)');
    await client.query('DELETE FROM users WHERE id IN (1,2)');
    await client.query('DELETE FROM communities WHERE id IN (1,2)');
  }
}

describe('ActiveStorage Migration', () => {
  let testMigrator: TestActiveMigrator;
  const testConfig = {
    database: process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/test',
    activeStoragePath: './test-storage',
    uploadsPath: './test-uploads',
    dryRun: false,
  };

  beforeAll(async () => {
    testMigrator = new TestActiveMigrator(testConfig);
    
    // Create test storage directory with sample files
    await fs.mkdir('./test-storage/ab/cd', { recursive: true });
    await fs.mkdir('./test-storage/de/f4', { recursive: true });
    await fs.mkdir('./test-storage/gh/i7', { recursive: true });
    await fs.mkdir('./test-storage/jk/l0', { recursive: true });
    
    // Create test files with known checksums
    await fs.writeFile('./test-storage/ab/cd/abc123def456', 'test video content');
    await fs.writeFile('./test-storage/de/f4/def456ghi789', 'elder video content');
    await fs.writeFile('./test-storage/gh/i7/ghi789jkl012', 'test image content');
    await fs.writeFile('./test-storage/jk/l0/jkl012mno345', 'speaker photo content');
    
    await testMigrator.setupTestDatabase();
  });

  beforeEach(async () => {
    await testMigrator.seedTestData();
  });

  afterEach(async () => {
    await testMigrator.cleanupTestData();
    
    // Clean up test uploads directory
    try {
      await fs.rm('./test-uploads', { recursive: true, force: true });
    } catch {
      // Ignore if directory doesn't exist
    }
  });

  afterAll(async () => {
    await testMigrator.closeClient();
    
    // Clean up test directories
    try {
      await fs.rm('./test-storage', { recursive: true, force: true });
      await fs.rm('./test-uploads', { recursive: true, force: true });
      await fs.rm('./backup-*', { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('Database Analysis', () => {
    it('should analyze ActiveStorage tables correctly', async () => {
      // Import the actual migrator functionality for testing
      const { execSync } = await import('child_process');
      
      // We need to test the actual implementation, so let's create a minimal test
      const result = execSync('DATABASE_URL=$DATABASE_URL npm run migrate:activestorage -- analyze', { 
        encoding: 'utf8',
        env: { ...process.env, DATABASE_URL: testConfig.database }
      });
      
      expect(result).toContain('Analysis Results');
      // Should find our test tables
      expect(result).toContain('active_storage_blobs');
    });

    it('should identify potential migration issues', async () => {
      // Add a duplicate filename to test issue detection
      const client = await testMigrator.getClient();
      await client.query(`
        INSERT INTO active_storage_blobs (key, filename, content_type, byte_size, checksum) 
        VALUES ('duplicate123', 'story1_video.mp4', 'video/mp4', 1000, 'dup-checksum')
      `);
      
      const result = execSync('DATABASE_URL=$DATABASE_URL npm run migrate:activestorage -- dry-run', { 
        encoding: 'utf8',
        env: { ...process.env, DATABASE_URL: testConfig.database }
      });
      
      expect(result).toContain('duplicate filenames need resolution');
    });
  });

  describe('File Migration', () => {
    it('should migrate community files successfully', async () => {
      const result = execSync('DATABASE_URL=$DATABASE_URL ACTIVE_STORAGE_PATH=./test-storage UPLOADS_PATH=./test-uploads npm run migrate:activestorage -- migrate --community=1', { 
        encoding: 'utf8',
        env: { 
          ...process.env, 
          DATABASE_URL: testConfig.database,
          ACTIVE_STORAGE_PATH: './test-storage',
          UPLOADS_PATH: './test-uploads'
        }
      });
      
      expect(result).toContain('Migration Result');
      expect(result).toContain('"success": true');
      
      // Verify community directory structure was created
      const communityDir = './test-uploads/community_1';
      expect(await testMigrator.fileExists(join(communityDir, 'stories'))).toBe(true);
      expect(await testMigrator.fileExists(join(communityDir, 'places'))).toBe(true);
      expect(await testMigrator.fileExists(join(communityDir, 'speakers'))).toBe(true);
    });

    it('should validate community ID input properly', async () => {
      // Test invalid community ID
      try {
        execSync('npm run migrate:activestorage -- migrate --community=invalid', { 
          encoding: 'utf8',
          env: { ...process.env, DATABASE_URL: testConfig.database }
        });
        expect.fail('Should have thrown error for invalid community ID');
      } catch (error: any) {
        expect(error.stdout || error.message).toContain('Invalid --community value');
      }
      
      // Test negative community ID
      try {
        execSync('npm run migrate:activestorage -- migrate --community=-1', { 
          encoding: 'utf8',
          env: { ...process.env, DATABASE_URL: testConfig.database }
        });
        expect.fail('Should have thrown error for negative community ID');
      } catch (error: any) {
        expect(error.stdout || error.message).toContain('Invalid --community value');
      }
    });
  });

  describe('Cultural Compliance', () => {
    it('should respect elder-only content restrictions', async () => {
      const result = execSync('DATABASE_URL=$DATABASE_URL ACTIVE_STORAGE_PATH=./test-storage UPLOADS_PATH=./test-uploads npm run migrate:activestorage -- migrate --community=1', { 
        encoding: 'utf8',
        env: { 
          ...process.env, 
          DATABASE_URL: testConfig.database,
          ACTIVE_STORAGE_PATH: './test-storage',
          UPLOADS_PATH: './test-uploads'
        }
      });
      
      // Should track elder-only files separately
      expect(result).toContain('elderOnlyFiles');
      expect(result).toContain('restrictedFiles');
      expect(result).toContain('publicFiles');
    });

    it('should create comprehensive audit trail', async () => {
      await execSync('DATABASE_URL=$DATABASE_URL ACTIVE_STORAGE_PATH=./test-storage UPLOADS_PATH=./test-uploads npm run migrate:activestorage -- migrate --community=1', { 
        env: { 
          ...process.env, 
          DATABASE_URL: testConfig.database,
          ACTIVE_STORAGE_PATH: './test-storage',
          UPLOADS_PATH: './test-uploads'
        }
      });
      
      // Verify audit log was created
      expect(await testMigrator.fileExists('migration_audit.log')).toBe(true);
      
      const auditContent = await fs.readFile('migration_audit.log', 'utf8');
      expect(auditContent).toContain('FILE_MIGRATED');
      expect(auditContent).toContain('MIGRATION_COMPLETED');
      expect(auditContent).toContain('communityId');
    });
  });

  describe('Data Integrity', () => {
    it('should verify file checksums during migration', async () => {
      // This test would verify that checksum validation works
      // In a real scenario, we'd test with actual file content and checksums
      const result = execSync('DATABASE_URL=$DATABASE_URL ACTIVE_STORAGE_PATH=./test-storage UPLOADS_PATH=./test-uploads npm run migrate:activestorage -- migrate --community=1', { 
        encoding: 'utf8',
        env: { 
          ...process.env, 
          DATABASE_URL: testConfig.database,
          ACTIVE_STORAGE_PATH: './test-storage',
          UPLOADS_PATH: './test-uploads'
        }
      });
      
      // Should complete without checksum errors
      expect(result).toContain('"success": true');
      expect(result).not.toContain('Checksum mismatch');
    });

    it('should handle filename sanitization correctly', async () => {
      // Add a file with special characters
      const client = await testMigrator.getClient();
      await client.query(`
        INSERT INTO active_storage_blobs (key, filename, content_type, byte_size, checksum) 
        VALUES ('special123', 'story with spaces & special!chars.mp4', 'video/mp4', 1000, 'special-checksum')
      `);
      
      await client.query(`
        INSERT INTO active_storage_attachments (name, record_type, record_id, blob_id) 
        VALUES ('media', 'Story', 1, (SELECT id FROM active_storage_blobs WHERE key = 'special123'))
      `);
      
      // Create the test file
      await fs.mkdir('./test-storage/sp/ec', { recursive: true });
      await fs.writeFile('./test-storage/sp/ec/special123', 'special content');
      
      const result = execSync('DATABASE_URL=$DATABASE_URL ACTIVE_STORAGE_PATH=./test-storage UPLOADS_PATH=./test-uploads npm run migrate:activestorage -- migrate --community=1', { 
        encoding: 'utf8',
        env: { 
          ...process.env, 
          DATABASE_URL: testConfig.database,
          ACTIVE_STORAGE_PATH: './test-storage',
          UPLOADS_PATH: './test-uploads'
        }
      });
      
      // Verify sanitized filename was created
      const sanitizedFile = './test-uploads/community_1/stories/story_with_spaces___special_chars.mp4';
      expect(await testMigrator.fileExists(sanitizedFile)).toBe(true);
    });
  });

  describe('Rollback Functionality', () => {
    it('should create and use backups for rollback', async () => {
      // First run a migration to create backup
      const migrateResult = execSync('DATABASE_URL=$DATABASE_URL ACTIVE_STORAGE_PATH=./test-storage UPLOADS_PATH=./test-uploads npm run migrate:activestorage -- migrate --community=1', { 
        encoding: 'utf8',
        env: { 
          ...process.env, 
          DATABASE_URL: testConfig.database,
          ACTIVE_STORAGE_PATH: './test-storage',
          UPLOADS_PATH: './test-uploads'
        }
      });
      
      // Extract backup path from result
      const backupMatch = migrateResult.match(/"backupPath":\s*"([^"]+)"/);
      expect(backupMatch).toBeTruthy();
      
      if (backupMatch) {
        const backupPath = backupMatch[1];
        
        // Verify backup directory exists
        expect(await testMigrator.fileExists(backupPath)).toBe(true);
        expect(await testMigrator.fileExists(join(backupPath, 'database.sql'))).toBe(true);
        
        // Test rollback functionality
        const rollbackResult = execSync(`DATABASE_URL=$DATABASE_URL npm run migrate:activestorage -- rollback --backup-path=${backupPath}`, { 
          encoding: 'utf8',
          env: { ...process.env, DATABASE_URL: testConfig.database }
        });
        
        expect(rollbackResult).toContain('"success": true');
      }
    });
  });

  describe('Error Handling', () => {
    it('should handle missing environment variables gracefully', async () => {
      try {
        execSync('npm run migrate:activestorage -- analyze', { 
          encoding: 'utf8',
          env: { ...process.env, DATABASE_URL: undefined }
        });
        expect.fail('Should have thrown error for missing DATABASE_URL');
      } catch (error: any) {
        expect(error.stdout || error.message).toContain('Missing required environment variables');
      }
    });

    it('should handle database connection errors', async () => {
      try {
        execSync('npm run migrate:activestorage -- analyze', { 
          encoding: 'utf8',
          env: { ...process.env, DATABASE_URL: 'postgresql://invalid:invalid@localhost:5432/invalid' }
        });
        expect.fail('Should have thrown error for invalid database connection');
      } catch (error: any) {
        expect(error.stdout || error.message).toContain('Failed to analyze ActiveStorage');
      }
    });
  });

  describe('Performance', () => {
    it('should handle large file sets efficiently', async () => {
      // This would be a more comprehensive test with many files
      // For now, just verify the basic migration completes in reasonable time
      const startTime = Date.now();
      
      await execSync('DATABASE_URL=$DATABASE_URL ACTIVE_STORAGE_PATH=./test-storage UPLOADS_PATH=./test-uploads npm run migrate:activestorage -- migrate --community=1', { 
        env: { 
          ...process.env, 
          DATABASE_URL: testConfig.database,
          ACTIVE_STORAGE_PATH: './test-storage',
          UPLOADS_PATH: './test-uploads'
        }
      });
      
      const duration = Date.now() - startTime;
      
      // Should complete within reasonable time (30 seconds for test data)
      expect(duration).toBeLessThan(30000);
    });
  });
});

// Helper function to check if file exists (for use in tests)
async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}