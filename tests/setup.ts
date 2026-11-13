import { beforeAll, afterAll, beforeEach, expect } from 'vitest';
import * as dotenv from 'dotenv';
import { testDb } from './helpers/database.js';

// Load test environment variables
dotenv.config({ path: '.env.test' });

// Global test setup
beforeAll(async () => {
  console.log('🚀 Initializing test environment...');

  // Ensure test environment
  process.env.NODE_ENV = 'test';
  // The PostgreSQL persona QA run selects its backend through DATABASE_URL
  // plus the ALLOW_POSTGRES_TEST_RESET guard (scripts/qa/qa-database.ts);
  // keep such a URL instead of forcing the in-process SQLite default.
  if (!/^(?:postgres|postgresql):\/\//.test(process.env.DATABASE_URL ?? '')) {
    process.env.DATABASE_URL = 'sqlite::memory:';
  }
  process.env.LOG_LEVEL = 'warn';

  // Initialize global test database
  await testDb.setup();
  console.log('✅ Test environment initialized');
}, 30000);

// Global test cleanup
afterAll(async () => {
  console.log('🧹 Cleaning up test environment...');
  await testDb.teardown();
  console.log('✅ Test environment cleaned up');
}, 30000);

// Reset database state between tests for isolation.
// Comparison tests own their lifecycle and seed once per file so cross-request
// state (sessions, created records) can be asserted across related tests.
beforeEach(async () => {
  const testPath = expect.getState().testPath || '';
  if (testPath.includes('/tests/comparison/')) {
    return;
  }

  // For unit tests, don't auto-seed to avoid conflicts
  await testDb.clearData();
}, 10000);
