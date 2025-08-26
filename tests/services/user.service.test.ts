/**
 * User Service Tests
 *
 * Comprehensive test suite for user service business logic including:
 * - User registration with password hashing
 * - Email uniqueness validation within communities
 * - Password strength validation
 * - Community association validation
 * - Error handling and edge cases
 * - Integration with password service
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { testDb } from '../helpers/database.js';
import {
  UserService,
  DuplicateEmailError,
  WeakPasswordError,
  InvalidCommunityError,
  type CreateUserRequest,
} from '../../src/services/user.service.js';
import { UserRepository } from '../../src/repositories/user.repository.js';
import * as passwordService from '../../src/services/password.service.js';

// Mock the password service
vi.mock('../../src/services/password.service.js', () => ({
  hashPassword: vi.fn(),
  validatePasswordStrength: vi.fn(),
  comparePassword: vi.fn(),
}));

describe('User Service', () => {
  let userService: UserService;
  let userRepository: UserRepository;
  let testCommunityId: number;
  let otherCommunityId: number;

  const mockHashPassword = vi.mocked(passwordService.hashPassword);
  const mockValidatePasswordStrength = vi.mocked(
    passwordService.validatePasswordStrength
  );
  const mockComparePassword = vi.mocked(passwordService.comparePassword);

  beforeEach(async () => {
    const db = await testDb.setup();
    userRepository = new UserRepository(db);
    userService = new UserService(userRepository);

    // Clear and seed test data
    await testDb.clearData();
    const fixtures = await testDb.seedTestData();
    testCommunityId = fixtures.communities[0].id;
    otherCommunityId = fixtures.communities[1].id;

    // Reset mocks
    vi.clearAllMocks();

    // Setup default mock behaviors
    mockHashPassword.mockImplementation(
      async (password: string) =>
        `$argon2id$v=19$m=65536,t=3,p=4$hashed_${password}`
    );

    mockValidatePasswordStrength.mockReturnValue({
      isValid: true,
      errors: [],
      score: 5,
    });

    mockComparePassword.mockResolvedValue(true);
  });

  afterEach(async () => {
    await testDb.clearData();
    vi.clearAllMocks();
  });

  describe('registerUser', () => {
    test('should register a new user successfully', async () => {
      const registrationData: CreateUserRequest = {
        email: 'test@example.com',
        password: 'StrongPassword123@',
        firstName: 'John',
        lastName: 'Doe',
        role: 'viewer',
        communityId: testCommunityId,
      };

      const registeredUser = await userService.registerUser(registrationData);

      expect(registeredUser).toBeDefined();
      expect(registeredUser.id).toBeDefined();
      expect(registeredUser.email).toBe(registrationData.email);
      expect(registeredUser.firstName).toBe(registrationData.firstName);
      expect(registeredUser.lastName).toBe(registrationData.lastName);
      expect(registeredUser.role).toBe(registrationData.role);
      expect(registeredUser.communityId).toBe(testCommunityId);
      expect(registeredUser.isActive).toBe(true);
      expect(registeredUser.passwordHash).toBe(
        `$argon2id$v=19$m=65536,t=3,p=4$hashed_${registrationData.password}`
      );

      // Verify password strength was validated
      expect(mockValidatePasswordStrength).toHaveBeenCalledWith(
        registrationData.password
      );

      // Verify password was hashed
      expect(mockHashPassword).toHaveBeenCalledWith(registrationData.password);
    });

    test('should throw DuplicateEmailError for existing email in same community', async () => {
      const registrationData: CreateUserRequest = {
        email: 'duplicate@example.com',
        password: 'StrongPassword123@',
        firstName: 'First',
        lastName: 'User',
        role: 'viewer',
        communityId: testCommunityId,
      };

      // Register first user
      await userService.registerUser(registrationData);

      // Attempt to register duplicate user
      await expect(userService.registerUser(registrationData)).rejects.toThrow(
        DuplicateEmailError
      );
      await expect(userService.registerUser(registrationData)).rejects.toThrow(
        'User with this email already exists in this community'
      );
    });

    test('should allow same email in different communities', async () => {
      const email = 'same@example.com';
      const registrationData1: CreateUserRequest = {
        email,
        password: 'StrongPassword123@',
        firstName: 'User',
        lastName: 'One',
        role: 'viewer',
        communityId: testCommunityId,
      };

      const registrationData2: CreateUserRequest = {
        email,
        password: 'AnotherPassword123@',
        firstName: 'User',
        lastName: 'Two',
        role: 'editor',
        communityId: otherCommunityId,
      };

      const user1 = await userService.registerUser(registrationData1);
      const user2 = await userService.registerUser(registrationData2);

      expect(user1.email).toBe(email);
      expect(user2.email).toBe(email);
      expect(user1.communityId).toBe(testCommunityId);
      expect(user2.communityId).toBe(otherCommunityId);
      expect(user1.id).not.toBe(user2.id);
    });

    test('should throw WeakPasswordError for weak password', async () => {
      // Mock weak password validation
      mockValidatePasswordStrength.mockReturnValue({
        isValid: false,
        errors: [
          'Password must be at least 8 characters long',
          'Password must contain uppercase letters',
        ],
        score: 1,
      });

      const registrationData: CreateUserRequest = {
        email: 'test@example.com',
        password: 'weak',
        firstName: 'John',
        lastName: 'Doe',
        role: 'viewer',
        communityId: testCommunityId,
      };

      await expect(userService.registerUser(registrationData)).rejects.toThrow(
        WeakPasswordError
      );
      await expect(userService.registerUser(registrationData)).rejects.toThrow(
        'Password requirements not met: Password must be at least 8 characters long, Password must contain uppercase letters'
      );

      // Verify password was not hashed since validation failed
      expect(mockHashPassword).not.toHaveBeenCalled();
    });

    test('should throw InvalidCommunityError for non-existent community', async () => {
      const registrationData: CreateUserRequest = {
        email: 'test@example.com',
        password: 'StrongPassword123@',
        firstName: 'John',
        lastName: 'Doe',
        role: 'viewer',
        communityId: 999999, // Non-existent community
      };

      await expect(userService.registerUser(registrationData)).rejects.toThrow(
        InvalidCommunityError
      );
      await expect(userService.registerUser(registrationData)).rejects.toThrow(
        'Invalid community ID'
      );
    });

    test('should default role to viewer if not specified', async () => {
      const registrationData = {
        email: 'defaultrole@example.com',
        password: 'StrongPassword123@',
        firstName: 'Default',
        lastName: 'Role',
        communityId: testCommunityId,
        // role not specified
      } as CreateUserRequest;

      const registeredUser = await userService.registerUser(registrationData);

      expect(registeredUser.role).toBe('viewer');
    });

    test('should handle password hashing service errors', async () => {
      mockHashPassword.mockRejectedValue(
        new Error('Hashing service unavailable')
      );

      const registrationData: CreateUserRequest = {
        email: 'test@example.com',
        password: 'StrongPassword123@',
        firstName: 'John',
        lastName: 'Doe',
        role: 'viewer',
        communityId: testCommunityId,
      };

      await expect(userService.registerUser(registrationData)).rejects.toThrow(
        'Failed to register user: Hashing service unavailable'
      );
    });

    test('should validate email format', async () => {
      const registrationData: CreateUserRequest = {
        email: 'invalid-email',
        password: 'StrongPassword123@',
        firstName: 'John',
        lastName: 'Doe',
        role: 'viewer',
        communityId: testCommunityId,
      };

      await expect(userService.registerUser(registrationData)).rejects.toThrow(
        'Invalid email format'
      );
    });

    test('should validate required fields', async () => {
      const incompleteData = {
        email: 'test@example.com',
        password: 'StrongPassword123@',
        // Missing firstName, lastName
        role: 'viewer',
        communityId: testCommunityId,
      } as CreateUserRequest;

      await expect(userService.registerUser(incompleteData)).rejects.toThrow();
    });

    test('should validate role values', async () => {
      const invalidRoleData = {
        email: 'test@example.com',
        password: 'StrongPassword123@',
        firstName: 'John',
        lastName: 'Doe',
        role: 'invalid_role',
        communityId: testCommunityId,
      } as CreateUserRequest;

      await expect(userService.registerUser(invalidRoleData)).rejects.toThrow();
    });
  });

  describe('getUserById', () => {
    test('should retrieve user by ID within community', async () => {
      const registrationData: CreateUserRequest = {
        email: 'findme@example.com',
        password: 'StrongPassword123@',
        firstName: 'Find',
        lastName: 'Me',
        role: 'editor',
        communityId: testCommunityId,
      };

      const registeredUser = await userService.registerUser(registrationData);
      const foundUser = await userService.getUserById(
        registeredUser.id,
        testCommunityId
      );

      expect(foundUser).toBeDefined();
      expect(foundUser.id).toBe(registeredUser.id);
      expect(foundUser.email).toBe(registrationData.email);
      expect(foundUser.communityId).toBe(testCommunityId);
    });

    test('should throw error when user not found in specified community', async () => {
      const registrationData: CreateUserRequest = {
        email: 'othercommunity@example.com',
        password: 'StrongPassword123@',
        firstName: 'Other',
        lastName: 'Community',
        role: 'viewer',
        communityId: testCommunityId,
      };

      const registeredUser = await userService.registerUser(registrationData);

      // Try to find user in different community
      await expect(
        userService.getUserById(registeredUser.id, otherCommunityId)
      ).rejects.toThrow('User not found');
    });

    test('should throw error for non-existent user ID', async () => {
      await expect(
        userService.getUserById(999999, testCommunityId)
      ).rejects.toThrow('User not found');
    });
  });

  describe('updateUser', () => {
    test('should update user successfully', async () => {
      const registrationData: CreateUserRequest = {
        email: 'update@example.com',
        password: 'StrongPassword123@',
        firstName: 'Update',
        lastName: 'Me',
        role: 'viewer',
        communityId: testCommunityId,
      };

      const registeredUser = await userService.registerUser(registrationData);

      const updates = {
        firstName: 'Updated',
        lastName: 'Name',
        role: 'editor' as const,
      };

      const updatedUser = await userService.updateUser(
        registeredUser.id,
        updates,
        testCommunityId
      );

      expect(updatedUser.firstName).toBe(updates.firstName);
      expect(updatedUser.lastName).toBe(updates.lastName);
      expect(updatedUser.role).toBe(updates.role);
      expect(updatedUser.email).toBe(registrationData.email); // Unchanged
    });

    test('should throw error when updating user in wrong community', async () => {
      const registrationData: CreateUserRequest = {
        email: 'wrongupdate@example.com',
        password: 'StrongPassword123@',
        firstName: 'Wrong',
        lastName: 'Update',
        role: 'viewer',
        communityId: testCommunityId,
      };

      const registeredUser = await userService.registerUser(registrationData);

      const updates = { firstName: 'Should Not Update' };

      // Try to update user from different community
      await expect(
        userService.updateUser(registeredUser.id, updates, otherCommunityId)
      ).rejects.toThrow('User not found');
    });

    test('should throw DuplicateEmailError when updating to existing email', async () => {
      // Create two users
      const user1Data: CreateUserRequest = {
        email: 'user1@example.com',
        password: 'StrongPassword123@',
        firstName: 'User',
        lastName: 'One',
        role: 'viewer',
        communityId: testCommunityId,
      };

      const user2Data: CreateUserRequest = {
        email: 'user2@example.com',
        password: 'StrongPassword123@',
        firstName: 'User',
        lastName: 'Two',
        role: 'viewer',
        communityId: testCommunityId,
      };

      const user1 = await userService.registerUser(user1Data);
      await userService.registerUser(user2Data);

      // Try to update user1's email to user2's email
      await expect(
        userService.updateUser(
          user1.id,
          { email: 'user2@example.com' },
          testCommunityId
        )
      ).rejects.toThrow(DuplicateEmailError);
    });
  });

  describe('deleteUser', () => {
    test('should delete user successfully', async () => {
      const registrationData: CreateUserRequest = {
        email: 'delete@example.com',
        password: 'StrongPassword123@',
        firstName: 'Delete',
        lastName: 'Me',
        role: 'viewer',
        communityId: testCommunityId,
      };

      const registeredUser = await userService.registerUser(registrationData);
      await userService.deleteUser(registeredUser.id, testCommunityId);

      // Verify user is deleted
      await expect(
        userService.getUserById(registeredUser.id, testCommunityId)
      ).rejects.toThrow('User not found');
    });

    test('should throw error when deleting user from wrong community', async () => {
      const registrationData: CreateUserRequest = {
        email: 'wrongdelete@example.com',
        password: 'StrongPassword123@',
        firstName: 'Wrong',
        lastName: 'Delete',
        role: 'viewer',
        communityId: testCommunityId,
      };

      const registeredUser = await userService.registerUser(registrationData);

      // Try to delete from different community
      await expect(
        userService.deleteUser(registeredUser.id, otherCommunityId)
      ).rejects.toThrow('User not found');

      // Verify user still exists
      const foundUser = await userService.getUserById(
        registeredUser.id,
        testCommunityId
      );
      expect(foundUser).toBeDefined();
    });
  });

  describe('authentication methods', () => {
    test('should authenticate user with valid credentials', async () => {
      const registrationData: CreateUserRequest = {
        email: 'auth@example.com',
        password: 'StrongPassword123@',
        firstName: 'Auth',
        lastName: 'User',
        role: 'viewer',
        communityId: testCommunityId,
      };

      await userService.registerUser(registrationData);

      // Configure mock to return true for correct password comparison
      mockComparePassword.mockResolvedValue(true);

      const authenticatedUser = await userService.authenticateUser(
        registrationData.email,
        registrationData.password,
        testCommunityId
      );

      expect(authenticatedUser).toBeDefined();
      expect(authenticatedUser.email).toBe(registrationData.email);
    });

    test('should throw error for invalid credentials', async () => {
      const registrationData: CreateUserRequest = {
        email: 'authfail@example.com',
        password: 'StrongPassword123@',
        firstName: 'Auth',
        lastName: 'Fail',
        role: 'viewer',
        communityId: testCommunityId,
      };

      await userService.registerUser(registrationData);

      // Configure mock to return false for wrong password
      mockComparePassword.mockResolvedValue(false);

      await expect(
        userService.authenticateUser(
          registrationData.email,
          'wrongpassword',
          testCommunityId
        )
      ).rejects.toThrow('Invalid email or password');
    });
  });

  describe('community isolation validation', () => {
    test('should maintain strict community data isolation in all operations', async () => {
      // Create users in different communities
      const user1Data: CreateUserRequest = {
        email: 'isolation1@example.com',
        password: 'StrongPassword123@',
        firstName: 'Isolation',
        lastName: 'One',
        role: 'viewer',
        communityId: testCommunityId,
      };

      const user2Data: CreateUserRequest = {
        email: 'isolation2@example.com',
        password: 'StrongPassword123@',
        firstName: 'Isolation',
        lastName: 'Two',
        role: 'viewer',
        communityId: otherCommunityId,
      };

      const user1 = await userService.registerUser(user1Data);
      const user2 = await userService.registerUser(user2Data);

      // Verify getUserById respects community isolation
      expect(
        await userService.getUserById(user1.id, testCommunityId)
      ).toBeDefined();
      await expect(
        userService.getUserById(user1.id, otherCommunityId)
      ).rejects.toThrow();

      expect(
        await userService.getUserById(user2.id, otherCommunityId)
      ).toBeDefined();
      await expect(
        userService.getUserById(user2.id, testCommunityId)
      ).rejects.toThrow();

      // Verify update respects community isolation
      await expect(
        userService.updateUser(
          user1.id,
          { firstName: 'Updated' },
          otherCommunityId
        )
      ).rejects.toThrow();
      await expect(
        userService.updateUser(
          user2.id,
          { firstName: 'Updated' },
          testCommunityId
        )
      ).rejects.toThrow();

      // Verify delete respects community isolation
      await expect(
        userService.deleteUser(user1.id, otherCommunityId)
      ).rejects.toThrow();
      await expect(
        userService.deleteUser(user2.id, testCommunityId)
      ).rejects.toThrow();
    });
  });
});
