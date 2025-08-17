/**
 * Password Hashing Service
 *
 * Secure password hashing and verification using argon2id algorithm.
 * Provides industry-standard security with timing attack protection
 * and configurable security parameters.
 *
 * Features:
 * - Argon2id hashing (current OWASP recommendation)
 * - Timing-safe password comparison
 * - Configurable security parameters
 * - Password strength validation
 * - Salt uniqueness guarantee
 * - Comprehensive input validation
 */

import * as argon2 from 'argon2';
import { z } from 'zod';
import { getConfig } from '../shared/config/index.js';

// Input validation schemas
const passwordSchema = z
  .string()
  .min(1, 'Password cannot be empty')
  .max(128, 'Password too long');

const hashSchema = z.string().min(1, 'Hash cannot be empty');

/**
 * Hash a password using argon2id with secure parameters
 *
 * Uses configurable security parameters optimized for balance between
 * security and performance. Generates unique salt for each hash.
 *
 * @param password - Plain text password to hash
 * @returns Promise<string> - Secure argon2id password hash
 * @throws Error if password invalid or hashing fails
 *
 * @example
 * ```typescript
 * const hash = await hashPassword('UserPassword123!');
 * console.log(hash); // $argon2id$v=19$m=65536,t=3,p=4$...
 * ```
 */
export async function hashPassword(password: string): Promise<string> {
  // Validate input - will throw on invalid input
  const validatedPassword = passwordSchema.parse(password);

  const config = getConfig();

  try {
    // Use argon2id with secure parameters from config
    const hash = await argon2.hash(validatedPassword, {
      type: argon2.argon2id,
      memoryCost: config.security.password.argon2.memory,
      timeCost: config.security.password.argon2.iterations,
      parallelism: config.security.password.argon2.parallelism,
    });

    return hash;
  } catch {
    throw new Error('Password hashing failed');
  }
}

/**
 * Compare a password with its hash using timing-safe comparison
 *
 * Uses argon2.verify which provides timing attack protection by
 * maintaining consistent execution time regardless of comparison result.
 *
 * @param password - Plain text password to verify
 * @param hash - Stored password hash to compare against
 * @returns Promise<boolean> - True if password matches hash
 *
 * @example
 * ```typescript
 * const isValid = await comparePassword('UserPassword123!', storedHash);
 * if (isValid) {
 *   // Password is correct
 * }
 * ```
 */
export async function comparePassword(
  password: string,
  hash: string
): Promise<boolean> {
  // Validate inputs - return false for any validation errors
  try {
    const validatedPassword = passwordSchema.parse(password);
    const validatedHash = hashSchema.parse(hash);

    // Use argon2 verify which includes timing protection
    const isValid = await argon2.verify(validatedHash, validatedPassword);
    return isValid;
  } catch {
    // Return false for any verification errors (invalid hash format, validation, etc.)
    // This provides consistent behavior and prevents information leakage
    return false;
  }
}

/**
 * Validate password strength according to security requirements
 *
 * Evaluates password against common security criteria and provides
 * detailed feedback for password improvement.
 *
 * @param password - Password to validate
 * @returns object with validation results and security score
 *
 * @example
 * ```typescript
 * const result = validatePasswordStrength('weak');
 * console.log(result.isValid); // false
 * console.log(result.errors); // ['Password must be at least 8 characters long', ...]
 * console.log(result.score); // 1
 * ```
 */
export function validatePasswordStrength(password: string): {
  isValid: boolean;
  errors: string[];
  score: number;
} {
  const errors: string[] = [];
  let score = 0;

  // Length requirements
  if (password.length < 8) {
    errors.push('Password must be at least 8 characters long');
  } else if (password.length >= 12) {
    score += 2;
  } else {
    score += 1;
  }

  // Character variety requirements
  if (!/[a-z]/.test(password)) {
    errors.push('Password must contain lowercase letters');
  } else {
    score += 1;
  }

  if (!/[A-Z]/.test(password)) {
    errors.push('Password must contain uppercase letters');
  } else {
    score += 1;
  }

  if (!/[0-9]/.test(password)) {
    errors.push('Password must contain numbers');
  } else {
    score += 1;
  }

  if (!/[^a-zA-Z0-9]/.test(password)) {
    errors.push('Password must contain special characters');
  } else {
    score += 1;
  }

  return {
    isValid: errors.length === 0,
    errors,
    score: Math.min(score, 5), // Cap score at 5
  };
}

/**
 * Check if a hash was created with current security parameters
 *
 * Helps identify hashes that may need to be upgraded to current
 * security standards during user authentication.
 *
 * @param hash - Password hash to check
 * @returns boolean - True if hash uses current parameters (argon2id)
 *
 * @example
 * ```typescript
 * if (!isHashCurrent(user.passwordHash)) {
 *   // Rehash password with current parameters on next login
 * }
 * ```
 */
export function isHashCurrent(hash: string): boolean {
  try {
    // Check if hash uses argon2id (current standard)
    return hash.startsWith('$argon2id$');
  } catch {
    return false;
  }
}
