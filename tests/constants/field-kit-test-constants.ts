/**
 * Field Kit Deployment Test Constants
 *
 * Shared constants for Field Kit deployment validation tests
 * to improve maintainability and avoid hardcoded values throughout tests.
 */

// Authentication & Users
export const TEST_PASSWORD_HASH =
  '$2b$10$K7L1OJ45/4Y2nIvhRVpCe.FSmhDlwjA4J9DL.hDVnl7ZqLMYxmYUi';
export const TEST_PASSWORD = 'password123';
export const JWT_SECRET_FALLBACK = 'test-field-kit-secret';

// Memory & Performance
export const DEFAULT_MEMORY_THRESHOLD_MB = 100;
export const MEMORY_THRESHOLD_ENV_VAR = 'FIELD_KIT_MEMORY_THRESHOLD_MB';

// Database & Cleanup
export const DATABASE_CLEANUP_DELAY_MS = 100;
export const JWT_TOKEN_EXPIRY = '1h';

// Test User Templates
export const TEST_USER_ADMIN = {
  firstName: 'Test',
  lastName: 'Admin',
  role: 'admin' as const,
  isActive: true,
};

export const TEST_USER_EDITOR = {
  firstName: 'Test',
  lastName: 'Editor',
  role: 'editor' as const,
  isActive: true,
};

export const TEST_USER_VIEWER = {
  firstName: 'Test',
  lastName: 'Viewer',
  role: 'viewer' as const,
  isActive: true,
};

// File Upload Test Data
export const SMALL_FILE_CONTENT = 'test file content';
export const LARGE_FILE_SIZE_MB = 15;
export const LARGE_FILE_CONTENT = 'x'.repeat(LARGE_FILE_SIZE_MB * 1024 * 1024);

// Test file configurations
export const TEST_FILES = {
  SMALL: {
    filename: 'test.txt',
    contentType: 'text/plain',
    content: SMALL_FILE_CONTENT,
  },
  LARGE: {
    filename: 'large.txt',
    contentType: 'text/plain',
    content: LARGE_FILE_CONTENT,
  },
} as const;

// Performance test constants
export const PERFORMANCE_TEST = {
  CONCURRENT_REQUESTS: 100,
  HEALTH_CHECK_ENDPOINT: '/health',
} as const;
