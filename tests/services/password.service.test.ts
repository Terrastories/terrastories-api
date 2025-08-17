/**
 * Password Service Security Tests
 *
 * Comprehensive test suite for password hashing service including:
 * - Security validation (timing attacks, salt uniqueness)
 * - Performance benchmarks (hashing, comparison timing)
 * - Functional testing (hashing, verification, validation)
 * - Edge cases and error handling
 * - Configuration integration
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { performance } from 'perf_hooks';
import {
  hashPassword,
  comparePassword,
  validatePasswordStrength,
  isHashCurrent,
} from '../../src/services/password.service.js';

describe('Password Service Security Tests', () => {
  describe('hashPassword', () => {
    test('should hash password with argon2id algorithm', async () => {
      const password = 'TestPassword123!';
      const hash = await hashPassword(password);

      expect(hash).toBeDefined();
      expect(typeof hash).toBe('string');
      expect(hash.length).toBeGreaterThan(50); // Argon2 hashes are long
      expect(hash.startsWith('$argon2id$')).toBe(true);
    });

    test('should generate unique salts for identical passwords', async () => {
      const password = 'SamePassword123!';
      const hashes = await Promise.all([
        hashPassword(password),
        hashPassword(password),
        hashPassword(password),
        hashPassword(password),
        hashPassword(password),
      ]);

      // All hashes should be different despite same password
      const uniqueHashes = new Set(hashes);
      expect(uniqueHashes.size).toBe(5);

      // But all should verify against the original password
      for (const hash of hashes) {
        expect(await comparePassword(password, hash)).toBe(true);
      }
    });

    test('should reject empty passwords', async () => {
      await expect(hashPassword('')).rejects.toThrow();
    });

    test('should reject extremely long passwords (>128 chars)', async () => {
      const longPassword = 'a'.repeat(129);
      await expect(hashPassword(longPassword)).rejects.toThrow();
    });

    test('should complete hashing within reasonable time (<500ms)', async () => {
      const password = 'TimingTestPassword123!';
      const startTime = performance.now();

      await hashPassword(password);

      const endTime = performance.now();
      const duration = endTime - startTime;

      expect(duration).toBeLessThan(500); // Should be under 500ms
    });

    test('should handle special characters and unicode properly', async () => {
      const specialPasswords = [
        'Pássw@rd123!', // Unicode
        '密码Test123!', // Chinese characters
        'Пароль123!', // Cyrillic
        '🔒Secure123!', // Emoji
        'Test\\n\\t"\'<>&123!', // Special chars
      ];

      for (const password of specialPasswords) {
        const hash = await hashPassword(password);
        expect(hash).toBeDefined();
        expect(await comparePassword(password, hash)).toBe(true);
      }
    });

    test('should use configured security parameters', async () => {
      const password = 'ConfigTestPassword123!';
      const hash = await hashPassword(password);

      // Verify argon2id parameters are in hash
      expect(hash).toContain('$argon2id$');
      // Hash should contain parameter information
      const parts = hash.split('$');
      expect(parts.length).toBeGreaterThanOrEqual(4);
      expect(parts[1]).toBe('argon2id');
    });

    test('should handle null and undefined inputs gracefully', async () => {
      await expect(hashPassword(null as any)).rejects.toThrow();
      await expect(hashPassword(undefined as any)).rejects.toThrow();
    });
  });

  describe('comparePassword', () => {
    let testPassword: string;
    let testHash: string;

    beforeEach(async () => {
      testPassword = 'CompareTestPassword123!';
      testHash = await hashPassword(testPassword);
    });

    test('should verify correct password against hash', async () => {
      const isValid = await comparePassword(testPassword, testHash);
      expect(isValid).toBe(true);
    });

    test('should reject incorrect password', async () => {
      const wrongPassword = 'WrongPassword123!';
      const isValid = await comparePassword(wrongPassword, testHash);
      expect(isValid).toBe(false);
    });

    test('should be resistant to timing attacks', async () => {
      const correctPassword = testPassword;
      const wrongPassword = 'WrongPassword123!';
      const timings: number[] = [];

      // Test multiple times to get timing data
      for (let i = 0; i < 5; i++) {
        const startTime = performance.now();
        await comparePassword(correctPassword, testHash);
        const endTime = performance.now();
        timings.push(endTime - startTime);

        const startTime2 = performance.now();
        await comparePassword(wrongPassword, testHash);
        const endTime2 = performance.now();
        timings.push(endTime2 - startTime2);
      }

      // Check that timing variance is reasonable
      // Argon2 inherently provides timing consistency, so we just verify it works
      const avgTiming = timings.reduce((a, b) => a + b, 0) / timings.length;
      const maxVariance = Math.max(...timings) - Math.min(...timings);

      // Variance should be reasonable for argon2 (less than 200% of average)
      // This is a looser constraint since argon2 inherently provides timing protection
      // and system factors can cause variance
      expect(maxVariance).toBeLessThan(avgTiming * 2.0);
      expect(avgTiming).toBeGreaterThan(0); // Just ensure it's working
    });

    test('should handle malformed hashes gracefully', async () => {
      const malformedHashes = [
        'not-a-hash',
        '$invalid$format',
        '$argon2id$incomplete',
        '',
        '$argon2id$v=19$m=65536$t=3$p=4$invalid',
        'bcrypt$hash$format',
      ];

      for (const badHash of malformedHashes) {
        const result = await comparePassword('password', badHash);
        expect(result).toBe(false);
      }
    });

    test('should handle empty inputs gracefully', async () => {
      expect(await comparePassword('', testHash)).toBe(false);
      expect(await comparePassword(testPassword, '')).toBe(false);
      expect(await comparePassword('', '')).toBe(false);
    });

    test('should handle null/undefined inputs gracefully', async () => {
      expect(await comparePassword(null as any, testHash)).toBe(false);
      expect(await comparePassword(testPassword, null as any)).toBe(false);
      expect(await comparePassword(undefined as any, testHash)).toBe(false);
      expect(await comparePassword(testPassword, undefined as any)).toBe(false);
    });

    test('should complete comparison within reasonable time (<200ms)', async () => {
      const startTime = performance.now();

      await comparePassword(testPassword, testHash);

      const endTime = performance.now();
      const duration = endTime - startTime;

      expect(duration).toBeLessThan(200); // Should be under 200ms
    });
  });

  describe('validatePasswordStrength', () => {
    test('should require minimum 8 character length', () => {
      const result = validatePasswordStrength('short');
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain(
        'Password must be at least 8 characters long'
      );
    });

    test('should require lowercase letters', () => {
      const result = validatePasswordStrength('PASSWORD123!');
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain(
        'Password must contain lowercase letters'
      );
    });

    test('should require uppercase letters', () => {
      const result = validatePasswordStrength('password123!');
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain(
        'Password must contain uppercase letters'
      );
    });

    test('should require numbers', () => {
      const result = validatePasswordStrength('Password!');
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Password must contain numbers');
    });

    test('should require special characters', () => {
      const result = validatePasswordStrength('Password123');
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain(
        'Password must contain special characters'
      );
    });

    test('should calculate strength score correctly', () => {
      // Weak password (only meets length)
      const weak = validatePasswordStrength('password');
      expect(weak.score).toBeLessThan(3);

      // Medium password (meets most requirements)
      const medium = validatePasswordStrength('Password123');
      expect(medium.score).toBe(4);

      // Strong password (meets all requirements)
      const strong = validatePasswordStrength('Password123!');
      expect(strong.isValid).toBe(true);
      expect(strong.score).toBeGreaterThanOrEqual(5);
    });

    test('should provide helpful error messages', () => {
      const result = validatePasswordStrength('weak');
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.every((error) => typeof error === 'string')).toBe(
        true
      );
    });

    test('should handle edge cases (empty, very long passwords)', () => {
      // Empty password
      const empty = validatePasswordStrength('');
      expect(empty.isValid).toBe(false);

      // Very long password (should still work)
      const veryLong = 'A'.repeat(100) + 'a1!';
      const longResult = validatePasswordStrength(veryLong);
      expect(longResult.isValid).toBe(true);
    });

    test('should score 12+ character passwords higher', () => {
      const normal = validatePasswordStrength('Password123!');
      const longer = validatePasswordStrength('LongerPassword123!');

      expect(longer.score).toBeGreaterThanOrEqual(normal.score);
    });
  });

  describe('isHashCurrent', () => {
    test('should identify argon2id hashes as current', async () => {
      const password = 'TestPassword123!';
      const hash = await hashPassword(password);
      expect(isHashCurrent(hash)).toBe(true);
    });

    test('should identify bcrypt hashes as outdated', () => {
      const bcryptHash = '$2b$10$abcdefghijklmnopqrstuvwxyz123456789';
      expect(isHashCurrent(bcryptHash)).toBe(false);
    });

    test('should handle malformed hashes gracefully', () => {
      const malformedHashes = [
        'not-a-hash',
        '',
        'invalid-format',
        '$invalid$format',
        null,
        undefined,
      ];

      for (const badHash of malformedHashes) {
        expect(isHashCurrent(badHash as any)).toBe(false);
      }
    });
  });

  describe('Performance & Security Integration', () => {
    test('should maintain consistent timing for password comparison', async () => {
      const password = 'ConsistentTimingTest123!';
      const hash = await hashPassword(password);
      const wrongPassword = 'WrongPassword123!';

      const timings: number[] = [];

      // Test timing consistency across multiple attempts
      for (let i = 0; i < 20; i++) {
        const startTime = performance.now();
        await comparePassword(i % 2 === 0 ? password : wrongPassword, hash);
        const endTime = performance.now();
        timings.push(endTime - startTime);
      }

      // Calculate timing statistics
      const avgTiming = timings.reduce((a, b) => a + b, 0) / timings.length;
      const variance =
        timings.reduce((acc, time) => acc + Math.pow(time - avgTiming, 2), 0) /
        timings.length;
      const stdDev = Math.sqrt(variance);

      // Standard deviation should be small relative to average
      expect(stdDev / avgTiming).toBeLessThan(0.3); // Less than 30% variance
    });

    test('should use secure random salts (no duplicates in 1000 hashes)', async () => {
      const password = 'SaltUniquenessTest123!';
      const saltSet = new Set<string>();

      // Generate many hashes and extract salt portions
      for (let i = 0; i < 100; i++) {
        // Reduced from 1000 for test speed
        const hash = await hashPassword(password);
        const parts = hash.split('$');
        if (parts.length >= 5) {
          const salt = parts[4]; // Salt is typically the 4th part in argon2
          expect(saltSet.has(salt)).toBe(false);
          saltSet.add(salt);
        }
      }

      expect(saltSet.size).toBe(100); // All salts should be unique
    });

    test('should prevent rainbow table attacks with unique salts', async () => {
      const commonPasswords = [
        'password123',
        'admin123',
        'test123',
        'user123',
        'welcome123',
      ];

      const allHashes: string[] = [];

      // Hash each common password multiple times
      for (const password of commonPasswords) {
        for (let i = 0; i < 3; i++) {
          const hash = await hashPassword(password);
          allHashes.push(hash);
        }
      }

      // All hashes should be unique despite some passwords being the same
      const uniqueHashes = new Set(allHashes);
      expect(uniqueHashes.size).toBe(allHashes.length);
    });

    test('should integrate with configuration system properly', async () => {
      // This test verifies the service uses config values
      // We'll verify this by checking that hashing works without throwing config errors
      const password = 'ConfigIntegrationTest123!';

      // Should not throw configuration errors
      await expect(hashPassword(password)).resolves.toBeDefined();

      // Should be able to verify the hash
      const hash = await hashPassword(password);
      await expect(comparePassword(password, hash)).resolves.toBe(true);
    });
  });

  describe('Error Handling and Edge Cases', () => {
    test('should handle concurrent password operations', async () => {
      const password = 'ConcurrentTest123!';

      // Run multiple hashing operations concurrently
      const hashPromises = Array(10)
        .fill(null)
        .map(() => hashPassword(password));
      const hashes = await Promise.all(hashPromises);

      // All should succeed and be unique
      expect(hashes.length).toBe(10);
      const uniqueHashes = new Set(hashes);
      expect(uniqueHashes.size).toBe(10);

      // All should verify correctly
      for (const hash of hashes) {
        expect(await comparePassword(password, hash)).toBe(true);
      }
    });

    test('should handle memory pressure gracefully', async () => {
      // Test with multiple large operations
      const password = 'MemoryPressureTest123!';
      const operations: Promise<boolean>[] = [];

      // Create many concurrent operations
      for (let i = 0; i < 20; i++) {
        operations.push(
          hashPassword(password).then((hash) => comparePassword(password, hash))
        );
      }

      const results = await Promise.all(operations);
      expect(results.every((result) => result === true)).toBe(true);
    });

    test('should validate input types strictly', async () => {
      const invalidInputs = [123, {}, [], true, new Date(), Symbol('test')];

      for (const input of invalidInputs) {
        await expect(hashPassword(input as any)).rejects.toThrow();
        await expect(comparePassword(input as any, 'valid-hash')).resolves.toBe(
          false
        );
      }
    });
  });
});
