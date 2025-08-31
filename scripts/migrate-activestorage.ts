#!/usr/bin/env node

/**
 * ActiveStorage to TypeScript File System Migration CLI
 *
 * Command-line interface for migrating Rails ActiveStorage files to community-scoped
 * TypeScript file structure with Indigenous data sovereignty and rollback capabilities
 *
 * Usage:
 *   npm run migrate:activestorage -- analyze
 *   npm run migrate:activestorage -- dry-run
 *   npm run migrate:activestorage -- migrate --community=1
 *   npm run migrate:activestorage -- rollback --backup-path=./backup-20250830
 */

import {
  ActiveStorageMigrator,
  MigrationConfig,
} from '../src/services/activestorage-migrator';

// Environment validation function
function validateEnvironment(): MigrationConfig {
  const requiredVars = ['DATABASE_URL'];
  const missing = requiredVars.filter((varName) => !process.env[varName]);

  if (missing.length > 0) {
    console.error(
      `❌ Missing required environment variables: ${missing.join(', ')}`
    );
    console.error(
      'Please set these variables in your .env file or environment'
    );
    process.exit(1);
  }

  const config: MigrationConfig = {
    database: process.env.DATABASE_URL!,
    activeStoragePath: process.env.ACTIVE_STORAGE_PATH || './storage',
    uploadsPath: process.env.UPLOADS_PATH || './uploads',
    dryRun: false,
  };

  // Accept both PostgreSQL and SQLite for flexibility
  if (
    !config.database.includes('postgresql://') &&
    !config.database.includes('postgres://') &&
    !config.database.includes('sqlite:')
  ) {
    console.error(
      `❌ DATABASE_URL must be a PostgreSQL or SQLite connection string`
    );
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
          console.log(
            'Dry Run Results:',
            JSON.stringify(dryRunResult, null, 2)
          );
        } finally {
          await migrator.closeClient();
        }
        break;

      case 'migrate':
        const communityFlag = args.find((arg) =>
          arg.startsWith('--community=')
        );
        if (communityFlag) {
          const raw = communityFlag.split('=')[1];
          const communityId = Number.parseInt(raw, 10);
          if (!Number.isFinite(communityId) || communityId <= 0) {
            console.error(
              `Invalid --community value: "${raw}". Expected a positive integer.`
            );
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
        const backupFlag = args.find((arg) => arg.startsWith('--backup-path='));
        if (backupFlag) {
          const backupPath = backupFlag.split('=')[1];
          console.log(`🔄 Performing rollback from ${backupPath}...`);
          try {
            const result = await migrator.performRollback(backupPath);
            console.log(
              '✅ Rollback completed:',
              JSON.stringify(result, null, 2)
            );
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
