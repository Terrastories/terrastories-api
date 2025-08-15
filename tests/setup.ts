import { beforeAll, afterAll, beforeEach } from 'vitest';
import * as dotenv from 'dotenv';
import { testDb } from './helpers/database.js';

// Load test environment variables
dotenv.config({ path: '.env.test' });

// Global test setup
beforeAll(async () => {
  console.log('🚀 Initializing test environment...');

  // Ensure test environment
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = 'sqlite::memory:';
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

// Reset database state between tests for isolation
beforeEach(async () => {
  // For unit tests, don't auto-seed to avoid conflicts
  await testDb.clearData();
}, 10000);
