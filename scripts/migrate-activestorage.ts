#!/usr/bin/env node

/**
 * ActiveStorage to TypeScript File System Migration Script
 *
 * Migrates Rails ActiveStorage files to community-scoped TypeScript file structure
 * with Indigenous data sovereignty, comprehensive backup, and rollback capabilities
 *
 * Usage:
 *   npm run migrate:activestorage -- analyze
 *   npm run migrate:activestorage -- dry-run
 *   npm run migrate:activestorage -- migrate --community=1
 *   npm run migrate:activestorage -- rollback --backup-path=./backup-20250830
 */

import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { Client } from 'pg';
import { createHash } from 'crypto';

interface MigrationConfig {
  database: string;
  activeStoragePath: string;
  uploadsPath: string;
  dryRun: boolean;
}

interface ActiveStorageBlob {
  id: number;
  key: string;
  filename: string;
  content_type: string;
  metadata: any;
  byte_size: number;
  checksum: string;
  created_at: Date;
}

interface ActiveStorageAttachment {
  id: number;
  name: string;
  record_type: string;
  record_id: number;
  blob_id: number;
  created_at: Date;
}

interface MigrationResult {
  success: boolean;
  communityId?: number;
  filesProcessed: number;
  filesMigrated: number;
  filesSkipped: number;
  errors: string[];
  duration: string;
  backupPath?: string;
  culturalRestrictions?: {
    elderOnlyFiles: number;
    restrictedFiles: number;
    publicFiles: number;
    auditTrailCreated: boolean;
  };
}

interface AnalysisResult {
  tablesFound: string[];
  blobsCount: number;
  attachmentsCount: number;
  variantsCount: number;
  totalFileSize: number;
  communitiesAffected: number;
  filesByType: Record<string, number>;
  potentialIssues: string[];
}

class ActiveStorageMigrator {
  private config: MigrationConfig;
  private client: Client | null = null;

  constructor(config: MigrationConfig) {
    this.config = config;
  }

  private async getClient(): Promise<Client> {
    if (!this.client) {
      this.client = new Client({ connectionString: this.config.database });
      await this.client.connect();
    }
    return this.client;
  }

  private async closeClient(): Promise<void> {
    if (this.client) {
      await this.client.end();
      this.client = null;
    }
  }

  private sanitizeFilename(filename: string): string {
    // Remove special characters and spaces, preserve extension
    const parts = filename.split('.');
    const extension = parts.length > 1 ? parts.pop() : '';
    const baseName = parts.join('.')
      .replace(/[^a-zA-Z0-9-_]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '');
    
    return extension ? `${baseName}.${extension}` : baseName;
  }

  private async verifyFileIntegrity(filePath: string, expectedChecksum: string): Promise<boolean> {
    try {
      const fileBuffer = await fs.readFile(filePath);
      const actualChecksum = createHash('md5').update(fileBuffer).digest('base64');
      return actualChecksum === expectedChecksum;
    } catch {
      return false;
    }
  }

  private async logAuditTrail(action: string, details: any): Promise<void> {
    const timestamp = new Date().toISOString();
    const logEntry = `${timestamp} [${action}] ${JSON.stringify(details)}\n`;
    await fs.appendFile('migration_audit.log', logEntry);
  }

  async analyzeActiveStorage(): Promise<AnalysisResult> {
    const client = await this.getClient();
    
    try {
      // Check if ActiveStorage tables exist
      const tablesQuery = `
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_name IN ('active_storage_blobs', 'active_storage_attachments', 'active_storage_variant_records')
        AND table_schema = 'public'
      `;
      const tablesResult = await client.query(tablesQuery);
      const tablesFound = tablesResult.rows.map(row => row.table_name);
      
      if (tablesFound.length === 0) {
        return {
          tablesFound: [],
          blobsCount: 0,
          attachmentsCount: 0,
          variantsCount: 0,
          totalFileSize: 0,
          communitiesAffected: 0,
          filesByType: {},
          potentialIssues: ['No ActiveStorage tables found - this may be a development environment']
        };
      }

      // Analyze blobs
      const blobsQuery = `
        SELECT 
          COUNT(*) as count,
          COALESCE(SUM(byte_size), 0) as total_size,
          content_type,
          COUNT(*) as type_count
        FROM active_storage_blobs 
        GROUP BY content_type
      `;
      const blobsResult = await client.query(blobsQuery);
      
      const totalBlobsQuery = `SELECT COUNT(*) as count, COALESCE(SUM(byte_size), 0) as total_size FROM active_storage_blobs`;
      const totalBlobsResult = await client.query(totalBlobsQuery);
      
      // Analyze attachments and affected communities
      const attachmentsQuery = `
        SELECT 
          COUNT(*) as count,
          record_type,
          COUNT(DISTINCT CASE 
            WHEN record_type IN ('Story', 'Place', 'Speaker') 
            THEN (SELECT community_id FROM ${this.getTableName()} WHERE id = record_id)
            END) as communities_affected
        FROM active_storage_attachments 
        GROUP BY record_type
      `;
      const attachmentsResult = await client.query(attachmentsQuery);
      
      const totalAttachmentsQuery = `SELECT COUNT(*) as count FROM active_storage_attachments`;
      const totalAttachmentsResult = await client.query(totalAttachmentsQuery);
      
      // Analyze variants
      const variantsQuery = `SELECT COUNT(*) as count FROM active_storage_variant_records`;
      const variantsResult = await client.query(variantsQuery);
      
      // Build file types summary
      const filesByType: Record<string, number> = {};
      blobsResult.rows.forEach(row => {
        filesByType[row.content_type] = parseInt(row.type_count);
      });
      
      // Calculate communities affected
      const communitiesQuery = `
        SELECT COUNT(DISTINCT community_id) as count
        FROM (
          SELECT (SELECT community_id FROM stories WHERE id = a.record_id) as community_id
          FROM active_storage_attachments a WHERE a.record_type = 'Story'
          UNION
          SELECT (SELECT community_id FROM places WHERE id = a.record_id) as community_id  
          FROM active_storage_attachments a WHERE a.record_type = 'Place'
          UNION
          SELECT (SELECT community_id FROM speakers WHERE id = a.record_id) as community_id
          FROM active_storage_attachments a WHERE a.record_type = 'Speaker'
        ) communities WHERE community_id IS NOT NULL
      `;
      const communitiesResult = await client.query(communitiesQuery);
      
      return {
        tablesFound,
        blobsCount: parseInt(totalBlobsResult.rows[0]?.count || '0'),
        attachmentsCount: parseInt(totalAttachmentsResult.rows[0]?.count || '0'),
        variantsCount: parseInt(variantsResult.rows[0]?.count || '0'),
        totalFileSize: parseInt(totalBlobsResult.rows[0]?.total_size || '0'),
        communitiesAffected: parseInt(communitiesResult.rows[0]?.count || '0'),
        filesByType,
        potentialIssues: []
      };
      
    } catch (error) {
      throw new Error(`Failed to analyze ActiveStorage: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private getTableName(): string {
    // Helper to get correct table name based on record type
    return 'COALESCE((SELECT community_id FROM stories WHERE id = record_id), (SELECT community_id FROM places WHERE id = record_id), (SELECT community_id FROM speakers WHERE id = record_id))';
  }

  private async identifyPotentialIssues(analysis: AnalysisResult): Promise<string[]> {
    const issues: string[] = [];
    const client = await this.getClient();
    
    try {
      // Check for duplicate filenames
      const duplicatesQuery = `
        SELECT filename, COUNT(*) as count 
        FROM active_storage_blobs 
        GROUP BY filename 
        HAVING COUNT(*) > 1
      `;
      const duplicatesResult = await client.query(duplicatesQuery);
      if (duplicatesResult.rows.length > 0) {
        issues.push(`${duplicatesResult.rows.length} duplicate filenames need resolution`);
      }
      
      // Check for files with invalid characters
      const invalidCharsQuery = `
        SELECT COUNT(*) as count 
        FROM active_storage_blobs 
        WHERE filename ~ '[^a-zA-Z0-9._-]'
      `;
      const invalidCharsResult = await client.query(invalidCharsQuery);
      if (parseInt(invalidCharsResult.rows[0]?.count || '0') > 0) {
        issues.push(`${invalidCharsResult.rows[0].count} files have invalid characters`);
      }
      
      // Check for very large files (>100MB)
      const largeFilesQuery = `
        SELECT COUNT(*) as count 
        FROM active_storage_blobs 
        WHERE byte_size > 104857600
      `;
      const largeFilesResult = await client.query(largeFilesQuery);
      if (parseInt(largeFilesResult.rows[0]?.count || '0') > 0) {
        issues.push(`${largeFilesResult.rows[0].count} files larger than 100MB require special handling`);
      }
      
      return issues;
      
    } catch (error) {
      issues.push(`Failed to analyze potential issues: ${error instanceof Error ? error.message : String(error)}`);
      return issues;
    }
  }

  async performDryRun() {
    console.log('🧪 Performing dry run analysis...');
    
    const startTime = Date.now();
    const analysis = await this.analyzeActiveStorage();
    const potentialIssues = await this.identifyPotentialIssues(analysis);
    
    // Calculate estimated duration (roughly 1 file per second, plus overhead)
    const estimatedSeconds = Math.ceil(analysis.blobsCount * 1.2);
    const estimatedMinutes = Math.ceil(estimatedSeconds / 60);
    
    // Calculate backup size from file analysis
    const backupSizeGB = Math.ceil(analysis.totalFileSize / (1024 * 1024 * 1024));
    
    await this.logAuditTrail('DRY_RUN_ANALYSIS', {
      filesAnalyzed: analysis.blobsCount,
      communitiesAffected: analysis.communitiesAffected,
      duration: `${Date.now() - startTime}ms`,
      potentialIssues: potentialIssues.length
    });
    
    return {
      dryRun: true,
      filesAnalyzed: analysis.blobsCount,
      communitiesAffected: analysis.communitiesAffected,
      estimatedDuration: `${estimatedMinutes} minutes`,
      potentialIssues,
      rollbackPlan: {
        backupSize: analysis.totalFileSize,
        backupSizeGB: `${backupSizeGB}GB`,
        rollbackSteps: [
          'Restore database from backup',
          'Restore ActiveStorage file structure',
          'Remove migrated community directories',
          'Verify ActiveStorage functionality',
        ],
      },
      filesByType: analysis.filesByType,
      tablesFound: analysis.tablesFound,
    };
  }

  async createBackup() {
    console.log('📦 Creating backup...');
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0] + '-' + new Date().toISOString().replace(/[:.]/g, '-').split('T')[1].split('.')[0];
    const backupPath = join(process.cwd(), `backup-${timestamp}`);
    
    try {
      // Create backup directory
      await fs.mkdir(backupPath, { recursive: true });
      
      // Backup database
      const client = await this.getClient();
      const databaseBackupPath = join(backupPath, 'database.sql');
      
      // Export relevant tables
      const tables = ['active_storage_blobs', 'active_storage_attachments', 'active_storage_variant_records', 'stories', 'places', 'speakers'];
      let sqlDump = '';
      
      for (const table of tables) {
        try {
          const result = await client.query(`SELECT * FROM ${table}`);
          sqlDump += `-- Backup of ${table}\n`;
          if (result.rows.length > 0) {
            const columns = Object.keys(result.rows[0]);
            sqlDump += `INSERT INTO ${table} (${columns.join(', ')}) VALUES\n`;
            const values = result.rows.map(row => 
              `(${columns.map(col => {
                const val = row[col];
                if (val === null) return 'NULL';
                if (typeof val === 'string') return `'${val.replace(/'/g, "''")}'`;
                if (val instanceof Date) return `'${val.toISOString()}'`;
                return String(val);
              }).join(', ')})`
            ).join(',\n');
            sqlDump += values + ';\n\n';
          }
        } catch (error) {
          console.warn(`Warning: Could not backup table ${table}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      
      await fs.writeFile(databaseBackupPath, sqlDump);
      
      // Backup ActiveStorage files if they exist
      const storageBackupPath = join(backupPath, 'storage');
      try {
        await fs.access(this.config.activeStoragePath);
        await fs.mkdir(storageBackupPath, { recursive: true });
        
        // Copy storage directory (this is a simplified version - in production would use streaming)
        const { execSync } = await import('child_process');
        execSync(`cp -r "${this.config.activeStoragePath}"/* "${storageBackupPath}"/`);
        
        console.log(`✅ ActiveStorage files backed up to ${storageBackupPath}`);
      } catch {
        console.warn('⚠️ ActiveStorage files not found or not accessible - continuing without file backup');
      }
      
      await this.logAuditTrail('BACKUP_CREATED', {
        backupPath,
        timestamp,
        databaseBackup: databaseBackupPath,
        storageBackup: storageBackupPath
      });
      
      return {
        backupPath,
        timestamp: new Date(),
        databaseBackup: databaseBackupPath,
        storageBackup: storageBackupPath
      };
      
    } catch (error) {
      throw new Error(`Failed to create backup: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async migrateByCommunity(communityId: number): Promise<MigrationResult> {
    console.log(`🚀 Starting migration for community ${communityId}...`);
    
    const startTime = Date.now();
    const errors: string[] = [];
    let filesProcessed = 0;
    let filesMigrated = 0;
    let filesSkipped = 0;
    let elderOnlyFiles = 0;
    let restrictedFiles = 0;
    let publicFiles = 0;
    
    const client = await this.getClient();
    
    try {
      // Create backup before migration
      const backup = await this.createBackup();
      
      // Begin transaction for atomic operations
      await client.query('BEGIN');
      
      try {
        // Get all attachments for this community's records
        const attachmentsQuery = `
          SELECT 
            a.id as attachment_id,
            a.name as attachment_name,
            a.record_type,
            a.record_id,
            b.id as blob_id,
            b.key as blob_key,
            b.filename,
            b.content_type,
            b.byte_size,
            b.checksum,
            CASE 
              WHEN a.record_type = 'Story' THEN s.community_id
              WHEN a.record_type = 'Place' THEN p.community_id  
              WHEN a.record_type = 'Speaker' THEN sp.community_id
            END as community_id,
            CASE
              WHEN a.record_type = 'Story' THEN s.is_restricted
              WHEN a.record_type = 'Place' THEN p.is_restricted
              WHEN a.record_type = 'Speaker' THEN false
            END as is_restricted,
            CASE
              WHEN a.record_type = 'Speaker' THEN sp.elder_status
              ELSE false
            END as is_elder_content
          FROM active_storage_attachments a
          JOIN active_storage_blobs b ON a.blob_id = b.id
          LEFT JOIN stories s ON a.record_type = 'Story' AND a.record_id = s.id
          LEFT JOIN places p ON a.record_type = 'Place' AND a.record_id = p.id
          LEFT JOIN speakers sp ON a.record_type = 'Speaker' AND a.record_id = sp.id
          WHERE (
            (a.record_type = 'Story' AND s.community_id = $1) OR
            (a.record_type = 'Place' AND p.community_id = $1) OR  
            (a.record_type = 'Speaker' AND sp.community_id = $1)
          )
          ORDER BY a.record_type, a.record_id
        `;
        
        const attachmentsResult = await client.query(attachmentsQuery, [communityId]);
        
        // Group attachments by record for batch updates
        const recordUpdates: Record<string, { type: string; id: number; files: string[] }> = {};
        
        for (const attachment of attachmentsResult.rows) {
          filesProcessed++;
          
          try {
            // Create community-scoped directory structure
            const recordTypeDir = attachment.record_type.toLowerCase() + 's'; // Story -> stories
            const communityDir = join(this.config.uploadsPath, `community_${communityId}`, recordTypeDir);
            await fs.mkdir(communityDir, { recursive: true });
            
            // Generate safe filename
            const sanitizedFilename = this.sanitizeFilename(attachment.filename);
            let finalFilename = sanitizedFilename;
            let counter = 1;
            
            // Handle filename conflicts
            while (await this.fileExists(join(communityDir, finalFilename))) {
              const parts = sanitizedFilename.split('.');
              const extension = parts.length > 1 ? parts.pop() : '';
              const baseName = parts.join('.');
              finalFilename = extension ? `${baseName}_${counter}.${extension}` : `${baseName}_${counter}`;
              counter++;
            }
            
            const newFilePath = join(communityDir, finalFilename);
            const relativePath = `uploads/community_${communityId}/${recordTypeDir}/${finalFilename}`;
            
            // Copy file from ActiveStorage location
            const activeStorageFilePath = join(this.config.activeStoragePath, 
              attachment.blob_key.substring(0, 2), 
              attachment.blob_key.substring(2, 4), 
              attachment.blob_key);
            
            if (await this.fileExists(activeStorageFilePath)) {
              await fs.copyFile(activeStorageFilePath, newFilePath);
              
              // Verify file integrity
              if (await this.verifyFileIntegrity(newFilePath, attachment.checksum)) {
                filesMigrated++;
                
                // Track file type for cultural restrictions
                if (attachment.is_elder_content) {
                  elderOnlyFiles++;
                } else if (attachment.is_restricted) {
                  restrictedFiles++;
                } else {
                  publicFiles++;
                }
                
                // Collect files for batch database update
                const recordKey = `${attachment.record_type}:${attachment.record_id}`;
                if (!recordUpdates[recordKey]) {
                  recordUpdates[recordKey] = {
                    type: attachment.record_type,
                    id: attachment.record_id,
                    files: []
                  };
                }
                recordUpdates[recordKey].files.push(relativePath);
                
                await this.logAuditTrail('FILE_MIGRATED', {
                  communityId,
                  recordType: attachment.record_type,
                  recordId: attachment.record_id,
                  originalPath: activeStorageFilePath,
                  newPath: newFilePath,
                  filename: finalFilename,
                  isRestricted: attachment.is_restricted,
                  isElderContent: attachment.is_elder_content
                });
                
              } else {
                errors.push(`Checksum mismatch for ${attachment.filename}`);
                filesSkipped++;
              }
            } else {
              errors.push(`ActiveStorage file not found: ${activeStorageFilePath}`);
              filesSkipped++;
            }
            
          } catch (error) {
            errors.push(`Failed to migrate ${attachment.filename}: ${error instanceof Error ? error.message : String(error)}`);
            filesSkipped++;
          }
        }
        
        // Update database records with new file paths
        for (const [, update] of Object.entries(recordUpdates)) {
          try {
            if (update.type === 'Story') {
              await client.query(
                'UPDATE stories SET media_urls = $1, updated_at = NOW() WHERE id = $2',
                [JSON.stringify(update.files), update.id]
              );
            } else if (update.type === 'Place') {
              // For places, we'll put the first file as photo_url and others in media_urls
              const [photoUrl, ...mediaUrls] = update.files;
              await client.query(
                'UPDATE places SET photo_url = $1, media_urls = $2, updated_at = NOW() WHERE id = $3',
                [photoUrl, JSON.stringify(mediaUrls), update.id]
              );
            } else if (update.type === 'Speaker') {
              // For speakers, use the first file as photo_url
              await client.query(
                'UPDATE speakers SET photo_url = $1, updated_at = NOW() WHERE id = $2',
                [update.files[0], update.id]
              );
            }
          } catch (error) {
            errors.push(`Failed to update ${update.type} ${update.id}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        
        // Commit transaction if no critical errors
        if (errors.length === 0) {
          await client.query('COMMIT');
        } else {
          await client.query('ROLLBACK');
          throw new Error(`Migration failed with ${errors.length} errors`);
        }
        
        const duration = `${Math.round((Date.now() - startTime) / 1000)}s`;
        
        await this.logAuditTrail('MIGRATION_COMPLETED', {
          communityId,
          filesProcessed,
          filesMigrated,
          filesSkipped,
          errors: errors.length,
          duration,
          culturalRestrictions: { elderOnlyFiles, restrictedFiles, publicFiles }
        });
        
        return {
          success: errors.length === 0,
          communityId,
          filesProcessed,
          filesMigrated,
          filesSkipped,
          errors,
          duration,
          backupPath: backup.backupPath,
          culturalRestrictions: {
            elderOnlyFiles,
            restrictedFiles,
            publicFiles,
            auditTrailCreated: true
          }
        };
        
      } catch (innerError) {
        // Handle inner try block errors
        await client.query('ROLLBACK');
        throw innerError;
      }
      
    } catch (error) {
      // Rollback transaction on error
      try {
        await client.query('ROLLBACK');
      } catch {
        // Ignore rollback errors
      }
      
      await this.logAuditTrail('MIGRATION_FAILED', {
        communityId,
        error: error instanceof Error ? error.message : String(error),
        filesProcessed,
        duration: `${Math.round((Date.now() - startTime) / 1000)}s`
      });
      
      return {
        success: false,
        communityId,
        filesProcessed,
        filesMigrated,
        filesSkipped,
        errors: [error instanceof Error ? error.message : String(error)],
        duration: `${Math.round((Date.now() - startTime) / 1000)}s`
      };
    }
  }

  private async fileExists(path: string): Promise<boolean> {
    try {
      await fs.access(path);
      return true;
    } catch {
      return false;
    }
  }

  async performRollback(backupPath?: string) {
    console.log('🔄 Performing rollback...');
    
    if (!backupPath) {
      throw new Error('Backup path is required for rollback');
    }
    
    const startTime = Date.now();
    const client = await this.getClient();
    
    try {
      // Verify backup exists
      const databaseBackupPath = join(backupPath, 'database.sql');
      const storageBackupPath = join(backupPath, 'storage');
      
      await fs.access(databaseBackupPath);
      
      // Begin transaction
      await client.query('BEGIN');
      
      // Read and execute database backup
      const backupSql = await fs.readFile(databaseBackupPath, 'utf8');
      await client.query(backupSql);
      
      // Restore file system
      if (await this.fileExists(storageBackupPath)) {
        const { execSync } = await import('child_process');
        execSync(`rm -rf "${this.config.activeStoragePath}"`);
        execSync(`cp -r "${storageBackupPath}" "${this.config.activeStoragePath}"`);
      }
      
      // Remove migrated community directories
      const uploadsPath = this.config.uploadsPath;
      if (await this.fileExists(uploadsPath)) {
        const communityDirs = await fs.readdir(uploadsPath);
        for (const dir of communityDirs) {
          if (dir.startsWith('community_')) {
            await fs.rm(join(uploadsPath, dir), { recursive: true, force: true });
          }
        }
      }
      
      await client.query('COMMIT');
      
      await this.logAuditTrail('ROLLBACK_COMPLETED', {
        backupPath,
        duration: `${Math.round((Date.now() - startTime) / 1000)}s`
      });
      
      return { 
        success: true, 
        backupPath, 
        duration: `${Math.round((Date.now() - startTime) / 1000)}s` 
      };
      
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Ignore rollback errors
      }
      
      await this.logAuditTrail('ROLLBACK_FAILED', {
        backupPath,
        error: error instanceof Error ? error.message : String(error)
      });
      
      throw new Error(`Rollback failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

// Environment validation function
function validateEnvironment(): MigrationConfig {
  const requiredVars = ['DATABASE_URL'];
  const missing = requiredVars.filter(varName => !process.env[varName]);
  
  if (missing.length > 0) {
    console.error(`❌ Missing required environment variables: ${missing.join(', ')}`);
    console.error('Please set these variables in your .env file or environment');
    process.exit(1);
  }
  
  const config: MigrationConfig = {
    database: process.env.DATABASE_URL!,
    activeStoragePath: process.env.ACTIVE_STORAGE_PATH || './storage',
    uploadsPath: process.env.UPLOADS_PATH || './uploads',
    dryRun: false,
  };
  
  // Validate database URL format
  if (!config.database.includes('postgresql://') && !config.database.includes('postgres://')) {
    console.error(`❌ DATABASE_URL must be a PostgreSQL connection string`);
    process.exit(1);
  }
  
  return config;
}

// CLI interface
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  const config = validateEnvironment();
  const migrator = new ActiveStorageMigrator(config);

  try {
    switch (command) {
      case 'analyze':
        console.log('🔍 Analyzing ActiveStorage structure...');
        try {
          const analysis = await migrator.analyzeActiveStorage();
          console.log('Analysis Results:', JSON.stringify(analysis, null, 2));
        } finally {
          await migrator.closeClient();
        }
        break;

      case 'dry-run':
        console.log('🧪 Performing dry run...');
        try {
          const dryRunResult = await migrator.performDryRun();
          console.log('Dry Run Results:', JSON.stringify(dryRunResult, null, 2));
        } finally {
          await migrator.closeClient();
        }
        break;

      case 'migrate':
        const communityFlag = args.find(arg => arg.startsWith('--community='));
        if (communityFlag) {
          const raw = communityFlag.split('=')[1];
          const communityId = Number.parseInt(raw, 10);
          if (!Number.isFinite(communityId) || communityId <= 0) {
            console.error(`Invalid --community value: "${raw}". Expected a positive integer.`);
            process.exit(1);
          }
          console.log(`🚀 Migrating community ${communityId}...`);
          try {
            const result = await migrator.migrateByCommunity(communityId);
            console.log('Migration Result:', JSON.stringify(result, null, 2));
          } finally {
            await migrator.closeClient();
          }
        } else {
          console.error('Please specify --community=ID');
          process.exit(1);
        }
        break;

      case 'rollback':
        const backupFlag = args.find(arg => arg.startsWith('--backup-path='));
        if (backupFlag) {
          const backupPath = backupFlag.split('=')[1];
          console.log(`🔄 Performing rollback from ${backupPath}...`);
          try {
            const result = await migrator.performRollback(backupPath);
            console.log('✅ Rollback completed:', JSON.stringify(result, null, 2));
          } finally {
            await migrator.closeClient();
          }
        } else {
          console.error('Please specify --backup-path=PATH');
          process.exit(1);
        }
        break;

      default:
        console.log(`
ActiveStorage Migration Tool

Usage:
  npm run migrate:activestorage analyze                    - Analyze current ActiveStorage structure
  npm run migrate:activestorage dry-run                    - Perform dry run without changes
  npm run migrate:activestorage migrate --community=1      - Migrate specific community
  npm run migrate:activestorage rollback --backup-path=./backup-20250830 - Rollback from backup

Environment Variables:
  DATABASE_URL        - Database connection string (default: database.db)
  ACTIVE_STORAGE_PATH - Path to ActiveStorage files (default: ./storage)
  UPLOADS_PATH        - Path for new uploads directory (default: ./uploads)
        `);
        break;
    }
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

// Run CLI if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}