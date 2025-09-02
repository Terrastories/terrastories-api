// @ts-check
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

export default [
  // Configuration for src/ files with full TypeScript project support
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parser: tsParser,
      parserOptions: {
        project: './tsconfig.json',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      // Basic JavaScript rules
      'prefer-const': 'error',
      'no-var': 'error',
      'no-console': 'warn',
      'no-debugger': 'error',
      'no-duplicate-imports': 'error',
      'no-unused-vars': 'off', // Turn off base rule

      // TypeScript rules
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  // Configuration for test files without TypeScript project (standalone parsing)
  {
    files: ['tests/**/*.ts', '**/*.test.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parser: tsParser,
      // No project config for test files
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      // Basic JavaScript rules
      'prefer-const': 'error',
      'no-var': 'error',
      'no-console': 'off', // Allow console in tests
      'no-debugger': 'error',
      'no-duplicate-imports': 'error',
      'no-unused-vars': 'off',

      // Relaxed TypeScript rules for tests
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
    },
  },
  // Configuration for docs and config files without TypeScript project
  {
    files: [
      'docs/**/*.ts',
      '*.config.ts',
      'vitest.config.ts',
      'drizzle.config.ts',
      'src/db/migrate.ts',
      'src/db/seed.ts',
      'src/db/index.ts',
    ],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parser: tsParser,
      // No project config for docs/config files
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      // Basic JavaScript rules
      'prefer-const': 'error',
      'no-var': 'error',
      'no-console': 'off', // Allow console in db setup files  
      'no-debugger': 'error',
      'no-duplicate-imports': 'error',
      'no-unused-vars': 'off',

      // Relaxed TypeScript rules for docs/config
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
    },
  },
  {
    ignores: [
      'dist/',
      'node_modules/',
      'coverage/',
      '*.js',
      'eslint.config.js',
      'rails-source/',
    ],
  },
];
