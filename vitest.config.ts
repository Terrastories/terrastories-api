import { defineConfig } from 'vitest/config';
import * as path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['./tests/setup.ts'],

    // Test isolation and performance settings
    pool: 'forks', // Isolate database connections between tests
    testTimeout: 30000, // 30 seconds for integration tests
    hookTimeout: 30000, // 30 seconds for setup/teardown hooks
    teardownTimeout: 30000, // 30 seconds for cleanup

    // Parallel execution settings
    maxConcurrency: 5, // Limit concurrent tests for database isolation
    minWorkers: 1,
    maxWorkers: 4,

    // Test file patterns
    include: ['tests/**/*.{test,spec}.{js,ts}', 'src/**/*.{test,spec}.{js,ts}'],
    exclude: [
      'node_modules/',
      'dist/',
      '**/*.d.ts',
      'src/db/migrations/',
      'tests/routes/member/disabled/**', // Exclude incomplete member CRUD tests
    ],

    // Coverage configuration with enforced thresholds
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'clover'],
      reportsDirectory: './coverage',
      exclude: [
        'node_modules/',
        'dist/',
        'tests/',
        '**/*.d.ts',
        '**/*.config.ts',
        'src/db/migrations/',
        'src/db/seed.ts', // Exclude seed files from coverage
        'src/server.ts', // Exclude server entry point
      ],

      // Strict 80% coverage enforcement
      thresholds: {
        global: {
          branches: 80,
          functions: 80,
          lines: 80,
          statements: 80,
        },
        // Per-file thresholds to prevent single bad files
        perFile: true,
      },

      // Fail build if coverage is below threshold
      skipFull: false,
      checkCoverage: true,
    },

    // Reporter configuration
    reporter: process.env.CI ? ['verbose', 'junit'] : ['verbose'],
    outputFile: process.env.CI
      ? { junit: './test-report.junit.xml' }
      : undefined,

    // Performance monitoring
    logHeapUsage: true,

    // Environment variables for testing
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'sqlite::memory:',
      LOG_LEVEL: 'warn', // Reduce noise in test output
    },
  },

  // Path resolution
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '~tests': path.resolve(__dirname, './tests'),
    },
  },

  // ESM configuration
  esbuild: {
    target: 'node18',
  },
});
