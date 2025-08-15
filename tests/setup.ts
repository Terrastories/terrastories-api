import { beforeAll, afterAll } from 'vitest';
import dotenv from 'dotenv';

// Load test environment variables
dotenv.config({ path: '.env.test' });

beforeAll(async () => {
  // Setup test database connection
  // Initialize any global test resources
});

afterAll(async () => {
  // Cleanup test resources
  // Close database connections
});
