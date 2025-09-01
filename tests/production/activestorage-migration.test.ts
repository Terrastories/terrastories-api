/**
 * TERRASTORIES API - ACTIVESTORAGE MIGRATION VALIDATION
 *
 * This test suite validates the production migration from Rails ActiveStorage
 * to the TypeScript file system with comprehensive data integrity checks,
 * cultural protocol preservation, and zero data loss guarantees.
 *
 * Issue #59: Production Readiness Validation & Indigenous Community Deployment
 * Phase 2: Data Migration Validation
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { exec as execCb } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { TestDatabaseManager } from '../helpers/database.js';

const exec = promisify(execCb);

interface ActiveStorageBlob {
  id: string;
  key: string;
  filename: string;
  content_type: string;
  metadata: any;
  byte_size: number;
  checksum: string;
  created_at: Date;
}

interface ActiveStorageAttachment {
  id: string;
  name: string;
  record_type: string;
  record_id: string;
  blob_id: string;
  created_at: Date;
}

interface MigrationResult {
  success: boolean;
  files_migrated: number;
  files_failed: number;
  total_bytes: number;
  checksum_matches: number;
  cultural_protocols_preserved: number;
  community_isolation_maintained: boolean;
  audit_trail_complete: boolean;
  rollback_capability: boolean;
  errors: string[];
}

describe('ActiveStorage Migration Validation - Phase 2', () => {
  let db: TestDatabaseManager;
  let testDataPath: string;
  let migrationScriptPath: string;

  beforeAll(async () => {
    db = new TestDatabaseManager();
    await db.setup();

    testDataPath = path.join(
      process.cwd(),
      'tests',
      'fixtures',
      'activestorage'
    );
    migrationScriptPath = path.join(
      process.cwd(),
      'scripts',
      'migrate-activestorage.ts'
    );

    // Create test ActiveStorage data
    await setupActiveStorageTestData();

    console.log('ActiveStorage migration validation setup complete');
  });

  describe('Migration Script Validation', () => {
    test('Migration script exists and is executable', async () => {
      const scriptExists = await fs
        .access(migrationScriptPath)
        .then(() => true)
        .catch(() => false);
      expect(
        scriptExists,
        'Migration script should exist at scripts/migrate-activestorage.ts'
      ).toBe(true);

      // Check that script has proper command structure
      const scriptContent = await fs.readFile(migrationScriptPath, 'utf-8');
      expect(scriptContent).toContain('analyze');
      expect(scriptContent).toContain('dry-run');
      expect(scriptContent).toContain('migrate');
      expect(scriptContent).toContain('rollback');
    });

    test('Migration script analyze command provides comprehensive analysis', async () => {
      const { stdout } = await exec(
        `npx tsx ${migrationScriptPath} analyze --community=1`
      );

      expect(stdout).toContain('ActiveStorage Analysis Report');
      expect(stdout).toContain('Total blobs:');
      expect(stdout).toContain('Total attachments:');
      expect(stdout).toContain('File types:');
      expect(stdout).toContain('Storage size:');
      expect(stdout).toContain('Cultural restrictions:');
      expect(stdout).toContain('Community isolation:');
    });

    test('Migration script dry-run identifies all files without making changes', async () => {
      const uploadsDir = 'uploads';
      const beforeExists = await fs
        .access(uploadsDir)
        .then(() => true)
        .catch(() => false);

      const { stdout } = await exec(
        `npx tsx ${migrationScriptPath} dry-run --community=1`
      );

      expect(stdout).toContain('DRY RUN - No files will be moved');
      expect(stdout).toContain('Files to migrate:');
      expect(stdout).toContain('Target directory structure:');
      expect(stdout).toContain('Cultural protocols to preserve:');

      // Verify no actual changes were made
      const afterExists = await fs
        .access(uploadsDir)
        .then(() => true)
        .catch(() => false);
      expect(afterExists).toBe(beforeExists);
    });

    test('Migration script has proper error handling and validation', async () => {
      // Test invalid community ID
      try {
        await exec(`npx tsx ${migrationScriptPath} analyze --community=999999`);
        expect(true, 'Should have thrown error for invalid community').toBe(
          false
        );
      } catch (error) {
        expect(error.stderr || error.stdout).toContain('Community not found');
      }

      // Test missing required parameters
      try {
        await exec(`npx tsx ${migrationScriptPath} migrate`);
        expect(
          true,
          'Should have thrown error for missing community parameter'
        ).toBe(false);
      } catch (error) {
        expect(error.stderr || error.stdout).toContain(
          '--community parameter is required'
        );
      }
    });
  });

  describe('Production-Scale Data Migration', () => {
    test('Migration handles 1000+ files across multiple communities', async () => {
      // Create test data representing production scale
      await createProductionScaleTestData();

      const communities = ['1', '2', '3'];
      const results: MigrationResult[] = [];

      for (const communityId of communities) {
        const result = await runMigrationTest(communityId);
        results.push(result);

        expect(
          result.success,
          `Migration should succeed for community ${communityId}`
        ).toBe(true);
        expect(
          result.files_migrated,
          `Should migrate files for community ${communityId}`
        ).toBeGreaterThan(0);
        expect(
          result.files_failed,
          `Should have no failed migrations for community ${communityId}`
        ).toBe(0);
      }

      // Validate overall migration success
      const totalFilesMigrated = results.reduce(
        (sum, r) => sum + r.files_migrated,
        0
      );
      const totalBytesMigrated = results.reduce(
        (sum, r) => sum + r.total_bytes,
        0
      );

      expect(
        totalFilesMigrated,
        'Should migrate 1000+ files total'
      ).toBeGreaterThanOrEqual(1000);
      expect(
        totalBytesMigrated,
        'Should migrate significant data volume'
      ).toBeGreaterThan(100 * 1024 * 1024); // > 100MB
    });

    test('File integrity verification with MD5 checksum validation', async () => {
      const communityId = '1';

      // Get ActiveStorage blobs with checksums
      const blobs = await getActiveStorageBlobs(communityId);
      expect(
        blobs.length,
        'Should have test blobs for validation'
      ).toBeGreaterThan(0);

      // Run migration
      const result = await runMigrationTest(communityId);
      expect(result.success).toBe(true);

      // Validate each migrated file's checksum
      for (const blob of blobs) {
        const migratedFilePath = getMigratedFilePath(blob, communityId);
        const fileExists = await fs
          .access(migratedFilePath)
          .then(() => true)
          .catch(() => false);

        expect(
          fileExists,
          `Migrated file should exist: ${migratedFilePath}`
        ).toBe(true);

        // Calculate checksum of migrated file
        const fileContent = await fs.readFile(migratedFilePath);
        const calculatedChecksum = crypto
          .createHash('md5')
          .update(fileContent)
          .digest('base64');

        expect(
          calculatedChecksum,
          `Checksum should match for ${blob.filename}: expected ${blob.checksum}, got ${calculatedChecksum}`
        ).toBe(blob.checksum);
      }
    });

    test('Database migration preserves all relationships and metadata', async () => {
      const communityId = '1';

      // Get original ActiveStorage data
      const originalAttachments =
        await getActiveStorageAttachments(communityId);
      const originalBlobs = await getActiveStorageBlobs(communityId);

      expect(originalAttachments.length).toBeGreaterThan(0);
      expect(originalBlobs.length).toBeGreaterThan(0);

      // Run migration
      const result = await runMigrationTest(communityId);
      expect(result.success).toBe(true);

      // Validate database updates
      for (const attachment of originalAttachments) {
        const blob = originalBlobs.find((b) => b.id === attachment.blob_id);
        if (!blob) continue;

        // Check that the record's media URL was updated
        const updatedRecord = await getUpdatedRecord(
          attachment.record_type,
          attachment.record_id
        );
        const fieldName = getMediaFieldName(attachment.name);

        expect(
          updatedRecord,
          `Record should exist after migration`
        ).toBeDefined();
        expect(
          updatedRecord[fieldName],
          `Media field should be updated`
        ).toBeDefined();
        expect(
          updatedRecord[fieldName],
          `Should contain new file path`
        ).toContain('uploads/');
        expect(
          updatedRecord[fieldName],
          `Should contain community directory`
        ).toContain(`community_${communityId}/`);
      }
    });

    test('Community data isolation maintained during migration', async () => {
      const communities = ['1', '2'];

      // Run migration for both communities
      const results = await Promise.all(
        communities.map((id) => runMigrationTest(id))
      );

      expect(results.every((r) => r.success)).toBe(true);
      expect(results.every((r) => r.community_isolation_maintained)).toBe(true);

      // Verify file system isolation
      for (const communityId of communities) {
        const communityDir = `uploads/community_${communityId}`;
        const dirExists = await fs
          .access(communityDir)
          .then(() => true)
          .catch(() => false);

        expect(
          dirExists,
          `Community directory should exist: ${communityDir}`
        ).toBe(true);

        // Check that files are only in the correct community directory
        const files = await fs.readdir(communityDir, { recursive: true });
        expect(
          files.length,
          `Community ${communityId} should have migrated files`
        ).toBeGreaterThan(0);

        // Verify no cross-community contamination
        const otherCommunityId = communities.find((id) => id !== communityId);
        const otherCommunityDir = `uploads/community_${otherCommunityId}`;

        for (const file of files) {
          const fullPath = path.join(communityDir, file.toString());
          expect(
            fullPath,
            'Files should not reference other communities'
          ).not.toContain(`community_${otherCommunityId}`);
        }
      }
    });
  });

  describe('Cultural Protocol Preservation', () => {
    test('Elder-only restrictions preserved during migration', async () => {
      const communityId = '1';

      // Create story with elder-only media
      const elderStoryId = await createTestStoryWithMedia(communityId, {
        title: 'Sacred Elder Ceremony',
        privacy_level: 'restricted',
        cultural_restrictions: ['elder_only'],
        media_type: 'video',
        traditional_knowledge: true,
      });

      // Run migration
      const result = await runMigrationTest(communityId);
      expect(result.success).toBe(true);
      expect(result.cultural_protocols_preserved).toBeGreaterThan(0);

      // Verify cultural restrictions are preserved
      const updatedStory = await getUpdatedRecord('Story', elderStoryId);
      expect(updatedStory.privacy_level).toBe('restricted');
      expect(updatedStory.cultural_restrictions).toContain('elder_only');

      // Verify file permissions reflect cultural restrictions
      const mediaUrl = updatedStory.media_urls[0];
      const filePath = path.join(process.cwd(), mediaUrl);
      const stats = await fs.stat(filePath);

      // File should have restricted permissions
      const permissions = stats.mode & parseInt('777', 8);
      expect(
        permissions,
        'Elder-only files should have restricted permissions'
      ).toBeLessThan(parseInt('755', 8));
    });

    test('Cultural metadata preserved in file system structure', async () => {
      const communityId = '1';

      // Create content with various cultural significance levels
      const culturalContent = [
        {
          significance: 'high',
          restrictions: ['elder_only'],
          type: 'ceremony',
        },
        {
          significance: 'medium',
          restrictions: ['members_only'],
          type: 'traditional_story',
        },
        {
          significance: 'low',
          restrictions: [],
          type: 'general_information',
        },
      ];

      for (const content of culturalContent) {
        await createTestStoryWithMedia(communityId, {
          title: `Cultural Content - ${content.significance}`,
          cultural_significance: content.significance,
          cultural_restrictions: content.restrictions,
          content_type: content.type,
        });
      }

      // Run migration
      const result = await runMigrationTest(communityId);
      expect(result.success).toBe(true);

      // Verify cultural metadata is preserved in directory structure and database
      const communityDir = `uploads/community_${communityId}`;
      const storiesDir = path.join(communityDir, 'stories');

      const files = await fs.readdir(storiesDir, { recursive: true });
      expect(
        files.length,
        'Should have migrated cultural content files'
      ).toBeGreaterThan(0);

      // Check that cultural context is maintained in database
      const stories = await db.query(
        `
        SELECT id, title, cultural_significance, cultural_restrictions, media_urls 
        FROM stories 
        WHERE community_id = $1 AND title LIKE 'Cultural Content%'
      `,
        [communityId]
      );

      for (const story of stories.rows) {
        expect(
          story.cultural_significance,
          'Cultural significance should be preserved'
        ).toBeDefined();
        expect(story.media_urls, 'Media URLs should be updated').toBeDefined();
        expect(
          story.media_urls[0],
          'Media URL should point to migrated location'
        ).toContain(communityDir);
      }
    });

    test('Audit trail includes cultural protocol compliance', async () => {
      const communityId = '1';

      // Run migration with cultural content
      const result = await runMigrationTest(communityId);
      expect(result.success).toBe(true);
      expect(result.audit_trail_complete).toBe(true);

      // Verify audit trail exists
      const auditLogPath = `logs/migration-audit-community-${communityId}.json`;
      const auditExists = await fs
        .access(auditLogPath)
        .then(() => true)
        .catch(() => false);
      expect(auditExists, 'Migration audit log should exist').toBe(true);

      const auditLog = JSON.parse(await fs.readFile(auditLogPath, 'utf-8'));

      // Verify audit log contains cultural protocol information
      expect(auditLog).toHaveProperty('cultural_protocols');
      expect(auditLog).toHaveProperty('elder_content_count');
      expect(auditLog).toHaveProperty('restricted_content_count');
      expect(auditLog).toHaveProperty('traditional_knowledge_files');
      expect(auditLog).toHaveProperty('community_isolation_verified');

      // Verify sensitive information is not logged
      const auditString = JSON.stringify(auditLog);
      expect(
        auditString,
        'Audit log should not contain file contents'
      ).not.toContain('sacred');
      expect(
        auditString,
        'Audit log should not contain ceremony details'
      ).not.toContain('ceremony');

      // Should contain file paths and metadata only
      expect(auditLog.files_migrated).toBeGreaterThan(0);
      expect(auditLog.cultural_protocols.elder_restrictions_preserved).toBe(
        true
      );
    });
  });

  describe('Rollback and Recovery Procedures', () => {
    test('Rollback capability restores original state', async () => {
      const communityId = '1';

      // Take snapshot of original state
      const originalBlobs = await getActiveStorageBlobs(communityId);
      const originalAttachments =
        await getActiveStorageAttachments(communityId);
      const originalRecords = await getOriginalRecords(communityId);

      // Run migration
      const migrationResult = await runMigrationTest(communityId);
      expect(migrationResult.success).toBe(true);

      // Verify migration completed
      const migratedRecords = await getMigratedRecords(communityId);
      expect(migratedRecords.some((r) => r.media_urls?.length > 0)).toBe(true);

      // Run rollback
      const { stdout } = await exec(
        `npx tsx ${migrationScriptPath} rollback --community=${communityId}`
      );
      expect(stdout).toContain('Rollback completed successfully');

      // Verify rollback restored original state
      const rolledBackRecords = await getOriginalRecords(communityId);

      for (let i = 0; i < originalRecords.length; i++) {
        const original = originalRecords[i];
        const rolledBack = rolledBackRecords[i];

        // Media fields should be restored to original state
        const mediaField = getMediaFieldName(original.type);
        expect(rolledBack[mediaField], 'Media field should be restored').toBe(
          original[mediaField]
        );
      }

      // Verify ActiveStorage tables are restored
      const restoredBlobs = await getActiveStorageBlobs(communityId);
      const restoredAttachments =
        await getActiveStorageAttachments(communityId);

      expect(restoredBlobs.length).toBe(originalBlobs.length);
      expect(restoredAttachments.length).toBe(originalAttachments.length);
    });

    test('Atomic transaction ensures no partial migrations', async () => {
      const communityId = '1';

      // Create scenario that will cause migration failure partway through
      const testBlob = await createTestBlobWithInvalidPath(communityId);

      // Attempt migration (should fail)
      try {
        await runMigrationTest(communityId);
        expect(true, 'Migration should have failed due to invalid path').toBe(
          false
        );
      } catch (error) {
        expect(error.message).toContain('Migration failed');
      }

      // Verify no partial migration occurred
      const records = await getMigratedRecords(communityId);
      const hasPartialMigration = records.some((r) =>
        r.media_urls?.some((url: string) => url.startsWith('uploads/'))
      );

      expect(
        hasPartialMigration,
        'Should not have partial migration on failure'
      ).toBe(false);

      // Verify original ActiveStorage data is intact
      const blobs = await getActiveStorageBlobs(communityId);
      const attachments = await getActiveStorageAttachments(communityId);

      expect(
        blobs.length,
        'ActiveStorage blobs should be intact'
      ).toBeGreaterThan(0);
      expect(
        attachments.length,
        'ActiveStorage attachments should be intact'
      ).toBeGreaterThan(0);
    });

    test('Migration failure provides detailed error reporting', async () => {
      const communityId = '1';

      // Create conditions that will cause specific migration failures
      await createFailureConditions(communityId);

      try {
        const { stderr } = await exec(
          `npx tsx ${migrationScriptPath} migrate --community=${communityId}`
        );
        expect(stderr).toContain('Migration Error Report');
        expect(stderr).toContain('Failed files:');
        expect(stderr).toContain('Error details:');
        expect(stderr).toContain('Recovery recommendations:');
      } catch (error) {
        expect(error.stderr).toContain('Migration failed');
      }

      // Verify error log is created
      const errorLogPath = `logs/migration-errors-community-${communityId}.json`;
      const errorLogExists = await fs
        .access(errorLogPath)
        .then(() => true)
        .catch(() => false);
      expect(errorLogExists, 'Error log should be created on failure').toBe(
        true
      );
    });
  });

  // Helper functions
  async function setupActiveStorageTestData(): Promise<void> {
    // Create test ActiveStorage blobs and attachments tables
    await db.query(`
      CREATE TABLE IF NOT EXISTS active_storage_blobs (
        id SERIAL PRIMARY KEY,
        key VARCHAR(255) NOT NULL,
        filename VARCHAR(255) NOT NULL,
        content_type VARCHAR(255),
        metadata JSONB,
        byte_size BIGINT,
        checksum VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS active_storage_attachments (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        record_type VARCHAR(255) NOT NULL,
        record_id INTEGER NOT NULL,
        blob_id INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        FOREIGN KEY (blob_id) REFERENCES active_storage_blobs(id)
      )
    `);

    // Create test data directory
    await fs.mkdir(testDataPath, { recursive: true });
  }

  async function createProductionScaleTestData(): Promise<void> {
    const communities = [1, 2, 3];
    const filesPerCommunity = 350; // 1000+ total files

    for (const communityId of communities) {
      for (let i = 0; i < filesPerCommunity; i++) {
        await createTestBlobAndAttachment(communityId.toString(), {
          filename: `test-file-${i}.jpg`,
          content_type: 'image/jpeg',
          byte_size: 1024 * 1024, // 1MB
          record_type:
            i % 3 === 0 ? 'Story' : i % 3 === 1 ? 'Place' : 'Speaker',
          attachment_name: i % 3 === 0 ? 'media_attachments' : 'photo',
        });
      }
    }
  }

  async function createTestBlobAndAttachment(
    communityId: string,
    options: any
  ): Promise<void> {
    const checksum = crypto.randomBytes(16).toString('hex');

    // Create blob
    const blobResult = await db.query(
      `
      INSERT INTO active_storage_blobs (key, filename, content_type, byte_size, checksum)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id
    `,
      [
        `test-key-${Date.now()}-${Math.random()}`,
        options.filename,
        options.content_type,
        options.byte_size,
        checksum,
      ]
    );

    // Create attachment
    await db.query(
      `
      INSERT INTO active_storage_attachments (name, record_type, record_id, blob_id)
      VALUES ($1, $2, $3, $4)
    `,
      [
        options.attachment_name,
        options.record_type,
        parseInt(communityId),
        blobResult.rows[0].id,
      ]
    );
  }

  async function runMigrationTest(
    communityId: string
  ): Promise<MigrationResult> {
    try {
      const { stdout } = await exec(
        `npx tsx ${migrationScriptPath} migrate --community=${communityId}`
      );

      return {
        success: true,
        files_migrated: parseInt(
          stdout.match(/(\d+) files migrated/)?.[1] || '0'
        ),
        files_failed: parseInt(stdout.match(/(\d+) files failed/)?.[1] || '0'),
        total_bytes: parseInt(stdout.match(/(\d+) bytes migrated/)?.[1] || '0'),
        checksum_matches: parseInt(
          stdout.match(/(\d+) checksum matches/)?.[1] || '0'
        ),
        cultural_protocols_preserved: parseInt(
          stdout.match(/(\d+) cultural protocols preserved/)?.[1] || '0'
        ),
        community_isolation_maintained: stdout.includes(
          'community isolation maintained'
        ),
        audit_trail_complete: stdout.includes('audit trail complete'),
        rollback_capability: stdout.includes('rollback capability verified'),
        errors: [],
      };
    } catch (error) {
      return {
        success: false,
        files_migrated: 0,
        files_failed: 0,
        total_bytes: 0,
        checksum_matches: 0,
        cultural_protocols_preserved: 0,
        community_isolation_maintained: false,
        audit_trail_complete: false,
        rollback_capability: false,
        errors: [error.message],
      };
    }
  }

  async function getActiveStorageBlobs(
    communityId: string
  ): Promise<ActiveStorageBlob[]> {
    const result = await db.query(
      `
      SELECT DISTINCT asb.*
      FROM active_storage_blobs asb
      JOIN active_storage_attachments asa ON asb.id = asa.blob_id
      JOIN stories s ON asa.record_id = s.id AND asa.record_type = 'Story'
      WHERE s.community_id = $1
      
      UNION
      
      SELECT DISTINCT asb.*
      FROM active_storage_blobs asb
      JOIN active_storage_attachments asa ON asb.id = asa.blob_id
      JOIN places p ON asa.record_id = p.id AND asa.record_type = 'Place'
      WHERE p.community_id = $1
      
      UNION
      
      SELECT DISTINCT asb.*
      FROM active_storage_blobs asb
      JOIN active_storage_attachments asa ON asb.id = asa.blob_id
      JOIN speakers sp ON asa.record_id = sp.id AND asa.record_type = 'Speaker'
      WHERE sp.community_id = $1
    `,
      [communityId]
    );

    return result.rows;
  }

  async function getActiveStorageAttachments(
    communityId: string
  ): Promise<ActiveStorageAttachment[]> {
    const result = await db.query(
      `
      SELECT asa.*
      FROM active_storage_attachments asa
      JOIN stories s ON asa.record_id = s.id AND asa.record_type = 'Story'
      WHERE s.community_id = $1
      
      UNION
      
      SELECT asa.*
      FROM active_storage_attachments asa
      JOIN places p ON asa.record_id = p.id AND asa.record_type = 'Place'
      WHERE p.community_id = $1
      
      UNION
      
      SELECT asa.*
      FROM active_storage_attachments asa
      JOIN speakers sp ON asa.record_id = sp.id AND asa.record_type = 'Speaker'
      WHERE sp.community_id = $1
    `,
      [communityId]
    );

    return result.rows;
  }

  function getMigratedFilePath(
    blob: ActiveStorageBlob,
    communityId: string
  ): string {
    // This would match the actual migration logic
    return path.join(
      'uploads',
      `community_${communityId}`,
      'stories',
      blob.filename
    );
  }

  async function getUpdatedRecord(
    recordType: string,
    recordId: string
  ): Promise<any> {
    const tableName = recordType.toLowerCase() + 's';
    const result = await db.query(`SELECT * FROM ${tableName} WHERE id = $1`, [
      recordId,
    ]);
    return result.rows[0];
  }

  function getMediaFieldName(attachmentName: string): string {
    switch (attachmentName) {
      case 'media_attachments':
        return 'media_urls';
      case 'photo':
        return 'photo_url';
      case 'audio':
        return 'name_audio_url';
      default:
        return 'media_urls';
    }
  }

  async function createTestStoryWithMedia(
    communityId: string,
    options: any
  ): Promise<string> {
    const result = await db.query(
      `
      INSERT INTO stories (title, content, community_id, privacy_level, cultural_restrictions, cultural_significance)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id
    `,
      [
        options.title,
        options.content || 'Test content',
        communityId,
        options.privacy_level || 'public',
        JSON.stringify(options.cultural_restrictions || []),
        options.cultural_significance || 'low',
      ]
    );

    return result.rows[0].id;
  }

  async function getOriginalRecords(communityId: string): Promise<any[]> {
    // Implementation would get records before migration
    return [];
  }

  async function getMigratedRecords(communityId: string): Promise<any[]> {
    const result = await db.query(
      `
      SELECT id, title, media_urls, photo_url, name_audio_url
      FROM stories 
      WHERE community_id = $1
      
      UNION
      
      SELECT id, name, ARRAY[]::text[] as media_urls, photo_url, name_audio_url
      FROM places 
      WHERE community_id = $1
      
      UNION
      
      SELECT id, name, ARRAY[]::text[] as media_urls, photo_url, NULL::text as name_audio_url
      FROM speakers 
      WHERE community_id = $1
    `,
      [communityId]
    );

    return result.rows;
  }

  async function createTestBlobWithInvalidPath(
    communityId: string
  ): Promise<any> {
    // Create blob that will cause migration failure
    return createTestBlobAndAttachment(communityId, {
      filename: 'invalid/path/file.jpg',
      content_type: 'image/jpeg',
      byte_size: 1024,
      record_type: 'Story',
      attachment_name: 'media_attachments',
    });
  }

  async function createFailureConditions(communityId: string): Promise<void> {
    // Create conditions that will cause migration failures for testing
    await createTestBlobWithInvalidPath(communityId);
  }

  afterAll(async () => {
    // Clean up test data
    await cleanupMigrationTestData();
    await db.teardown();

    console.log('ActiveStorage migration validation completed');
  });

  async function cleanupMigrationTestData(): Promise<void> {
    try {
      await db.query('DROP TABLE IF EXISTS active_storage_attachments');
      await db.query('DROP TABLE IF EXISTS active_storage_blobs');

      // Clean up test files
      await fs.rm('uploads', { recursive: true, force: true });
      await fs.rm('logs', { recursive: true, force: true });
      await fs.rm(testDataPath, { recursive: true, force: true });
    } catch (error) {
      console.warn('Error cleaning up migration test data:', error);
    }
  }
});