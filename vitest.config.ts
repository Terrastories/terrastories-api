import { defineConfig } from 'vitest/config';
import * as path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['./tests/setup.ts'],

    // Test isolation and performance settings
    pool: 'forks', // Isolate database connections between tests
    testTimeout: 60000, // 60 seconds for integration tests
    hookTimeout: 60000, // 60 seconds for setup/teardown hooks
    teardownTimeout: 60000, // 60 seconds for cleanup

    // Parallel execution settings
    maxConcurrency: 5, // Limit concurrent tests for database isolation
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
      // Vitest 4 removed coverage.all and now reports only loaded files unless
      // the source scope is explicit. This explicit scope approximates the
      // Vitest 3 full-source denominator for Codecov continuity; it excludes a
      // few root/archive files the old all-mode still counted
      // (eslint.config.js, archive/migration-tools/migrate-activestorage.ts).
      include: ['src/**/*.{js,ts}', 'scripts/**/*.{js,mjs}'],
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

      // Enforced top-level floors (Vitest ignores a nested `thresholds.global`
      // shape and unknown options like `checkCoverage`; the former "Strict
      // 80%" block never failed a run). Floors sit below the CI-measured
      // full-scope values on the 20.x matrix leg (67.65% statements, 68.03%
      // lines, 70.01% functions, 60.12% branches at head a33f308);
      // lockfile-exact local runs measure the same (~67.6/60.0/70.0/68.0
      // after npm ci --legacy-peer-deps; an earlier 75% reading came from a
      // stale node_modules). See issue #167 for the accepted Vitest 4
      // denominator reset.
      thresholds: {
        statements: 67,
        branches: 59,
        functions: 69,
        lines: 67,
      },
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
