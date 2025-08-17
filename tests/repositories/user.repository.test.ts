/**
 * User Repository Tests
 *
 * Comprehensive test suite for user repository operations including:
 * - CRUD operations with community scoping
 * - Multi-database compatibility (PostgreSQL/SQLite)
 * - Email uniqueness validation within communities
 * - Error handling and edge cases
 * - Data isolation and community access validation
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { testDb } from '../helpers/database.js';
import { UserRepository } from '../../src/repositories/user.repository.js';
import type { NewUser } from '../../src/db/schema/users.js';

describe('User Repository', () => {
  let userRepository: UserRepository;
  let testCommunityId: number;
  let otherCommunityId: number;

  beforeEach(async () => {
    const db = await testDb.setup();
    userRepository = new UserRepository(db);

    // Clear and seed test data
    await testDb.clearData();
    const fixtures = await testDb.seedTestData();
    testCommunityId = fixtures.communities[0].id;
    otherCommunityId = fixtures.communities[1].id;
  });

  afterEach(async () => {
    await testDb.clearData();
  });

  describe('create', () => {
    test('should create a new user successfully', async () => {
      const userData: NewUser = {
        email: 'test@example.com',
        passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$test_hash',
        firstName: 'John',
        lastName: 'Doe',
        role: 'viewer',
        communityId: testCommunityId,
        isActive: true,
      };

      const user = await userRepository.create(userData);

      expect(user).toBeDefined();
      expect(user.id).toBeDefined();
      expect(user.email).toBe(userData.email);
      expect(user.firstName).toBe(userData.firstName);
      expect(user.lastName).toBe(userData.lastName);
      expect(user.role).toBe(userData.role);
      expect(user.communityId).toBe(testCommunityId);
      expect(user.isActive).toBe(true);
      expect(user.createdAt).toBeDefined();
      expect(user.updatedAt).toBeDefined();
    });

    test('should throw error for duplicate email within same community', async () => {
      const userData: NewUser = {
        email: 'duplicate@example.com',
        passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$test_hash',
        firstName: 'First',
        lastName: 'User',
        role: 'viewer',
        communityId: testCommunityId,
        isActive: true,
      };

      // Create first user
      await userRepository.create(userData);

      // Attempt to create duplicate user in same community
      await expect(userRepository.create(userData)).rejects.toThrow(
        'User with this email already exists in this community'
      );
    });

    test('should allow same email in different communities', async () => {
      const email = 'same@example.com';
      const userData1: NewUser = {
        email,
        passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$test_hash',
        firstName: 'User',
        lastName: 'One',
        role: 'viewer',
        communityId: testCommunityId,
        isActive: true,
      };

      const userData2: NewUser = {
        email,
        passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$test_hash',
        firstName: 'User',
        lastName: 'Two',
        role: 'viewer',
        communityId: otherCommunityId,
        isActive: true,
      };

      const user1 = await userRepository.create(userData1);
      const user2 = await userRepository.create(userData2);

      expect(user1.email).toBe(email);
      expect(user2.email).toBe(email);
      expect(user1.communityId).toBe(testCommunityId);
      expect(user2.communityId).toBe(otherCommunityId);
      expect(user1.id).not.toBe(user2.id);
    });

    test('should handle database errors gracefully', async () => {
      const invalidUserData = {
        email: 'test@example.com',
        passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$test_hash',
        firstName: 'John',
        lastName: 'Doe',
        role: 'viewer',
        communityId: 999999, // Non-existent community
        isActive: true,
      } as NewUser;

      await expect(userRepository.create(invalidUserData)).rejects.toThrow();
    });
  });

  describe('findById', () => {
    test('should find user by ID within community', async () => {
      const userData: NewUser = {
        email: 'findme@example.com',
        passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$test_hash',
        firstName: 'Find',
        lastName: 'Me',
        role: 'editor',
        communityId: testCommunityId,
        isActive: true,
      };

      const createdUser = await userRepository.create(userData);
      const foundUser = await userRepository.findById(createdUser.id, testCommunityId);

      expect(foundUser).toBeDefined();
      expect(foundUser!.id).toBe(createdUser.id);
      expect(foundUser!.email).toBe(userData.email);
      expect(foundUser!.communityId).toBe(testCommunityId);
    });

    test('should return null when user not found in specified community', async () => {
      const userData: NewUser = {
        email: 'othercommunity@example.com',
        passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$test_hash',
        firstName: 'Other',
        lastName: 'Community',
        role: 'viewer',
        communityId: testCommunityId,
        isActive: true,
      };

      const createdUser = await userRepository.create(userData);

      // Try to find user in different community
      const foundUser = await userRepository.findById(createdUser.id, otherCommunityId);
      expect(foundUser).toBeNull();
    });

    test('should return null for non-existent user ID', async () => {
      const foundUser = await userRepository.findById(999999, testCommunityId);
      expect(foundUser).toBeNull();
    });
  });

  describe('findByEmail', () => {
    test('should find user by email within community', async () => {
      const userData: NewUser = {
        email: 'findemail@example.com',
        passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$test_hash',
        firstName: 'Find',
        lastName: 'Email',
        role: 'admin',
        communityId: testCommunityId,
        isActive: true,
      };

      await userRepository.create(userData);
      const foundUser = await userRepository.findByEmail(userData.email, testCommunityId);

      expect(foundUser).toBeDefined();
      expect(foundUser!.email).toBe(userData.email);
      expect(foundUser!.communityId).toBe(testCommunityId);
    });

    test('should return null when email not found in specified community', async () => {
      const userData: NewUser = {
        email: 'emailtest@example.com',
        passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$test_hash',
        firstName: 'Email',
        lastName: 'Test',
        role: 'viewer',
        communityId: testCommunityId,
        isActive: true,
      };

      await userRepository.create(userData);

      // Try to find user by email in different community
      const foundUser = await userRepository.findByEmail(userData.email, otherCommunityId);
      expect(foundUser).toBeNull();
    });

    test('should return null for non-existent email', async () => {
      const foundUser = await userRepository.findByEmail('nonexistent@example.com', testCommunityId);
      expect(foundUser).toBeNull();
    });
  });

  describe('update', () => {
    test('should update user successfully', async () => {
      const userData: NewUser = {
        email: 'update@example.com',
        passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$test_hash',
        firstName: 'Update',
        lastName: 'Me',
        role: 'viewer',
        communityId: testCommunityId,
        isActive: true,
      };

      const createdUser = await userRepository.create(userData);

      const updates = {
        firstName: 'Updated',
        lastName: 'Name',
        role: 'editor' as const,
      };

      const updatedUser = await userRepository.update(createdUser.id, updates, testCommunityId);

      expect(updatedUser).toBeDefined();
      expect(updatedUser!.firstName).toBe(updates.firstName);
      expect(updatedUser!.lastName).toBe(updates.lastName);
      expect(updatedUser!.role).toBe(updates.role);
      expect(updatedUser!.email).toBe(userData.email); // Unchanged
      expect(updatedUser!.updatedAt.getTime()).toBeGreaterThan(createdUser.createdAt.getTime());
    });

    test('should return null when updating user in wrong community', async () => {
      const userData: NewUser = {
        email: 'wrongupdate@example.com',
        passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$test_hash',
        firstName: 'Wrong',
        lastName: 'Update',
        role: 'viewer',
        communityId: testCommunityId,
        isActive: true,
      };

      const createdUser = await userRepository.create(userData);

      const updates = { firstName: 'Should Not Update' };

      // Try to update user from different community
      const updatedUser = await userRepository.update(createdUser.id, updates, otherCommunityId);
      expect(updatedUser).toBeNull();
    });

    test('should return null for non-existent user', async () => {
      const updates = { firstName: 'Should Not Work' };
      const updatedUser = await userRepository.update(999999, updates, testCommunityId);
      expect(updatedUser).toBeNull();
    });
  });

  describe('delete', () => {
    test('should delete user successfully', async () => {
      const userData: NewUser = {
        email: 'delete@example.com',
        passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$test_hash',
        firstName: 'Delete',
        lastName: 'Me',
        role: 'viewer',
        communityId: testCommunityId,
        isActive: true,
      };

      const createdUser = await userRepository.create(userData);
      const deleteResult = await userRepository.delete(createdUser.id, testCommunityId);

      expect(deleteResult).toBe(true);

      // Verify user is deleted
      const foundUser = await userRepository.findById(createdUser.id, testCommunityId);
      expect(foundUser).toBeNull();
    });

    test('should return false when deleting user from wrong community', async () => {
      const userData: NewUser = {
        email: 'wrongdelete@example.com',
        passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$test_hash',
        firstName: 'Wrong',
        lastName: 'Delete',
        role: 'viewer',
        communityId: testCommunityId,
        isActive: true,
      };

      const createdUser = await userRepository.create(userData);

      // Try to delete from different community
      const deleteResult = await userRepository.delete(createdUser.id, otherCommunityId);
      expect(deleteResult).toBe(false);

      // Verify user still exists
      const foundUser = await userRepository.findById(createdUser.id, testCommunityId);
      expect(foundUser).toBeDefined();
    });

    test('should return false for non-existent user', async () => {
      const deleteResult = await userRepository.delete(999999, testCommunityId);
      expect(deleteResult).toBe(false);
    });
  });

  describe('findMany', () => {
    beforeEach(async () => {
      // Create multiple test users
      const users = [
        {
          email: 'user1@example.com',
          passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$test_hash',
          firstName: 'User',
          lastName: 'One',
          role: 'viewer' as const,
          communityId: testCommunityId,
          isActive: true,
        },
        {
          email: 'user2@example.com',
          passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$test_hash',
          firstName: 'User',
          lastName: 'Two',
          role: 'editor' as const,
          communityId: testCommunityId,
          isActive: true,
        },
        {
          email: 'admin@example.com',
          passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$test_hash',
          firstName: 'Admin',
          lastName: 'User',
          role: 'admin' as const,
          communityId: testCommunityId,
          isActive: false,
        },
      ];

      for (const userData of users) {
        await userRepository.create(userData);
      }
    });

    test('should return paginated users within community', async () => {
      const result = await userRepository.findMany({ page: 1, limit: 2 }, testCommunityId);

      expect(result.data).toHaveLength(2);
      expect(result.meta.page).toBe(1);
      expect(result.meta.limit).toBe(2);
      expect(result.meta.total).toBe(3);
      expect(result.meta.totalPages).toBe(2);
      expect(result.meta.hasNext).toBe(true);
      expect(result.meta.hasPrev).toBe(false);

      // All users should belong to the specified community
      result.data.forEach(user => {
        expect(user.communityId).toBe(testCommunityId);
      });
    });

    test('should filter users by role', async () => {
      const result = await userRepository.findMany({ role: 'admin' }, testCommunityId);

      expect(result.data).toHaveLength(1);
      expect(result.data[0].role).toBe('admin');
    });

    test('should filter users by active status', async () => {
      const result = await userRepository.findMany({ isActive: false }, testCommunityId);

      expect(result.data).toHaveLength(1);
      expect(result.data[0].isActive).toBe(false);
    });

    test('should search users by name', async () => {
      const result = await userRepository.findMany({ search: 'Admin' }, testCommunityId);

      expect(result.data).toHaveLength(1);
      expect(result.data[0].firstName).toBe('Admin');
    });

    test('should return empty result for different community', async () => {
      const result = await userRepository.findMany({}, otherCommunityId);

      expect(result.data).toHaveLength(0);
      expect(result.meta.total).toBe(0);
    });
  });

  describe('community isolation', () => {
    test('should maintain strict community data isolation', async () => {
      // Create users in different communities
      const user1Data: NewUser = {
        email: 'isolation1@example.com',
        passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$test_hash',
        firstName: 'Isolation',
        lastName: 'One',
        role: 'viewer',
        communityId: testCommunityId,
        isActive: true,
      };

      const user2Data: NewUser = {
        email: 'isolation2@example.com',
        passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$test_hash',
        firstName: 'Isolation',
        lastName: 'Two',
        role: 'viewer',
        communityId: otherCommunityId,
        isActive: true,
      };

      const user1 = await userRepository.create(user1Data);
      const user2 = await userRepository.create(user2Data);

      // Verify users can only be accessed within their communities
      expect(await userRepository.findById(user1.id, testCommunityId)).toBeDefined();
      expect(await userRepository.findById(user1.id, otherCommunityId)).toBeNull();

      expect(await userRepository.findById(user2.id, otherCommunityId)).toBeDefined();
      expect(await userRepository.findById(user2.id, testCommunityId)).toBeNull();

      // Verify email search is community-scoped
      expect(await userRepository.findByEmail('isolation1@example.com', testCommunityId)).toBeDefined();
      expect(await userRepository.findByEmail('isolation1@example.com', otherCommunityId)).toBeNull();
    });
  });
});