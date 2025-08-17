/**
 * Authentication Routes Tests
 *
 * Comprehensive test suite for authentication endpoints including:
 * - User registration endpoint with validation
 * - Request/response schema validation
 * - Error handling and status codes
 * - Integration with user service
 * - Swagger/OpenAPI documentation validation
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { FastifyInstance } from 'fastify';
import { testDb } from '../helpers/database.js';
import { createTestApp } from '../helpers/api-client.js';

describe('Authentication Routes', () => {
  let app: FastifyInstance;
  let testCommunityId: number;

  beforeEach(async () => {
    // Setup test database
    const db = await testDb.setup();
    await testDb.clearData();
    const fixtures = await testDb.seedTestData();
    testCommunityId = fixtures.communities[0].id;

    // Create test app with test database
    app = await createTestApp(db);
  });

  afterEach(async () => {
    await app.close();
    await testDb.clearData();
  });

  describe('POST /register', () => {
    test('should register a new user successfully', async () => {
      const registrationData = {
        email: 'test@example.com',
        password: 'StrongPassword123@',
        firstName: 'John',
        lastName: 'Doe',
        role: 'viewer',
        communityId: testCommunityId,
      };

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: registrationData,
      });

      expect(response.statusCode).toBe(201);

      const responseBody = JSON.parse(response.body);
      expect(responseBody).toHaveProperty('user');
      expect(responseBody.user).toHaveProperty('id');
      expect(responseBody.user.email).toBe(registrationData.email);
      expect(responseBody.user.firstName).toBe(registrationData.firstName);
      expect(responseBody.user.lastName).toBe(registrationData.lastName);
      expect(responseBody.user.role).toBe(registrationData.role);
      expect(responseBody.user.communityId).toBe(testCommunityId);
      expect(responseBody.user.isActive).toBe(true);
      expect(responseBody.user).toHaveProperty('createdAt');
      expect(responseBody.user).toHaveProperty('updatedAt');

      // Should not return password hash
      expect(responseBody.user).not.toHaveProperty('password');
      expect(responseBody.user).not.toHaveProperty('passwordHash');
    });

    test('should return 400 for invalid email format', async () => {
      const registrationData = {
        email: 'invalid-email',
        password: 'StrongPassword123@',
        firstName: 'John',
        lastName: 'Doe',
        role: 'viewer',
        communityId: testCommunityId,
      };

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: registrationData,
      });

      expect(response.statusCode).toBe(400);
      const responseBody = JSON.parse(response.body);
      expect(responseBody.error).toContain('Invalid email format');
    });

    test('should return 400 for missing required fields', async () => {
      const incompleteData = {
        email: 'test@example.com',
        password: 'StrongPassword123@',
        // Missing firstName, lastName
        role: 'viewer',
        communityId: testCommunityId,
      };

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: incompleteData,
      });

      expect(response.statusCode).toBe(400);
      const responseBody = JSON.parse(response.body);
      expect(responseBody.error).toBeDefined();
    });

    test('should return 400 for weak password', async () => {
      const registrationData = {
        email: 'test@example.com',
        password: 'weak',
        firstName: 'John',
        lastName: 'Doe',
        role: 'viewer',
        communityId: testCommunityId,
      };

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: registrationData,
      });

      expect(response.statusCode).toBe(400);
      const responseBody = JSON.parse(response.body);
      expect(responseBody.error).toContain('Password requirements not met');
    });

    test('should return 409 for duplicate email within same community', async () => {
      const registrationData = {
        email: 'duplicate@example.com',
        password: 'StrongPassword123@',
        firstName: 'First',
        lastName: 'User',
        role: 'viewer',
        communityId: testCommunityId,
      };

      // Register first user
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: registrationData,
      });

      // Attempt to register duplicate user
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: registrationData,
      });

      expect(response.statusCode).toBe(409);
      const responseBody = JSON.parse(response.body);
      expect(responseBody.error).toContain('User with this email already exists');
    });

    test('should return 400 for invalid community ID', async () => {
      const registrationData = {
        email: 'test@example.com',
        password: 'StrongPassword123@',
        firstName: 'John',
        lastName: 'Doe',
        role: 'viewer',
        communityId: 999999, // Non-existent community
      };

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: registrationData,
      });

      expect(response.statusCode).toBe(400);
      const responseBody = JSON.parse(response.body);
      expect(responseBody.error).toContain('Invalid community ID');
    });

    test('should return 400 for invalid role', async () => {
      const registrationData = {
        email: 'test@example.com',
        password: 'StrongPassword123@',
        firstName: 'John',
        lastName: 'Doe',
        role: 'invalid_role',
        communityId: testCommunityId,
      };

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: registrationData,
      });

      expect(response.statusCode).toBe(400);
      const responseBody = JSON.parse(response.body);
      expect(responseBody.error).toBeDefined();
    });

    test('should default role to viewer if not provided', async () => {
      const registrationData = {
        email: 'defaultrole@example.com',
        password: 'StrongPassword123@',
        firstName: 'Default',
        lastName: 'Role',
        communityId: testCommunityId,
        // role not specified
      };

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: registrationData,
      });

      expect(response.statusCode).toBe(201);
      const responseBody = JSON.parse(response.body);
      expect(responseBody.user.role).toBe('viewer');
    });

    test('should handle server errors gracefully', async () => {
      // Mock database failure
      vi.doMock('../../src/repositories/user.repository.js', () => ({
        UserRepository: class {
          async create() {
            throw new Error('Database unavailable');
          }
          async findByEmail() {
            throw new Error('Database unavailable');
          }
        },
      }));

      const registrationData = {
        email: 'test@example.com',
        password: 'StrongPassword123@',
        firstName: 'John',
        lastName: 'Doe',
        role: 'viewer',
        communityId: testCommunityId,
      };

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: registrationData,
      });

      expect(response.statusCode).toBe(500);
      const responseBody = JSON.parse(response.body);
      expect(responseBody.error).toBe('An unexpected error occurred');
    });

    test('should validate request payload structure', async () => {
      const invalidPayload = {
        email: 'test@example.com',
        password: 'StrongPassword123@',
        firstName: 'John',
        lastName: 'Doe',
        role: 'viewer',
        communityId: 'not-a-number', // Should be number
      };

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: invalidPayload,
      });

      expect(response.statusCode).toBe(400);
      const responseBody = JSON.parse(response.body);
      expect(responseBody.error).toBeDefined();
    });

    test('should trim whitespace from string fields', async () => {
      const registrationData = {
        email: '  test@example.com  ',
        password: 'StrongPassword123@',
        firstName: '  John  ',
        lastName: '  Doe  ',
        role: 'viewer',
        communityId: testCommunityId,
      };

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: registrationData,
      });

      expect(response.statusCode).toBe(201);
      const responseBody = JSON.parse(response.body);
      expect(responseBody.user.email).toBe('test@example.com');
      expect(responseBody.user.firstName).toBe('John');
      expect(responseBody.user.lastName).toBe('Doe');
    });

    test('should reject requests with extra unknown fields', async () => {
      const registrationData = {
        email: 'test@example.com',
        password: 'StrongPassword123@',
        firstName: 'John',
        lastName: 'Doe',
        role: 'viewer',
        communityId: testCommunityId,
        unknownField: 'should be rejected',
      };

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: registrationData,
      });

      expect(response.statusCode).toBe(400);
      const responseBody = JSON.parse(response.body);
      expect(responseBody.error).toContain('Unknown property');
    });

    test('should enforce password length limits', async () => {
      const registrationData = {
        email: 'test@example.com',
        password: 'a'.repeat(200), // Too long
        firstName: 'John',
        lastName: 'Doe',
        role: 'viewer',
        communityId: testCommunityId,
      };

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: registrationData,
      });

      expect(response.statusCode).toBe(400);
      const responseBody = JSON.parse(response.body);
      expect(responseBody.error).toContain('Password too long');
    });

    test('should enforce name length limits', async () => {
      const registrationData = {
        email: 'test@example.com',
        password: 'StrongPassword123@',
        firstName: 'a'.repeat(101), // Too long
        lastName: 'Doe',
        role: 'viewer',
        communityId: testCommunityId,
      };

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: registrationData,
      });

      expect(response.statusCode).toBe(400);
      const responseBody = JSON.parse(response.body);
      expect(responseBody.error).toContain('too long');
    });
  });

  describe('Content-Type validation', () => {
    test('should require application/json content type', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        headers: {
          'content-type': 'text/plain',
        },
        payload: 'invalid payload',
      });

      expect(response.statusCode).toBe(400);
    });

    test('should accept application/json content type', async () => {
      const registrationData = {
        email: 'test@example.com',
        password: 'StrongPassword123@',
        firstName: 'John',
        lastName: 'Doe',
        role: 'viewer',
        communityId: testCommunityId,
      };

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        headers: {
          'content-type': 'application/json',
        },
        payload: JSON.stringify(registrationData),
      });

      expect(response.statusCode).toBe(201);
    });
  });

  describe('Response format validation', () => {
    test('should return consistent response format for success', async () => {
      const registrationData = {
        email: 'format@example.com',
        password: 'StrongPassword123@',
        firstName: 'Format',
        lastName: 'Test',
        role: 'viewer',
        communityId: testCommunityId,
      };

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: registrationData,
      });

      expect(response.statusCode).toBe(201);
      expect(response.headers['content-type']).toContain('application/json');

      const responseBody = JSON.parse(response.body);
      
      // Verify response structure
      expect(responseBody).toHaveProperty('id');
      expect(responseBody).toHaveProperty('email');
      expect(responseBody).toHaveProperty('firstName');
      expect(responseBody).toHaveProperty('lastName');
      expect(responseBody).toHaveProperty('role');
      expect(responseBody).toHaveProperty('communityId');
      expect(responseBody).toHaveProperty('isActive');
      expect(responseBody).toHaveProperty('createdAt');
      expect(responseBody).toHaveProperty('updatedAt');

      // Verify excluded fields
      expect(responseBody).not.toHaveProperty('password');
      expect(responseBody).not.toHaveProperty('passwordHash');
    });

    test('should return consistent error response format', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          email: 'invalid-email',
          password: 'StrongPassword123@',
          firstName: 'John',
          lastName: 'Doe',
          role: 'viewer',
          communityId: testCommunityId,
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.headers['content-type']).toContain('application/json');

      const responseBody = JSON.parse(response.body);
      expect(responseBody).toHaveProperty('error');
      expect(typeof responseBody.error).toBe('string');
    });
  });

  describe('Integration with existing communities', () => {
    test('should register users in multiple communities successfully', async () => {
      const fixtures = await testDb.seedTestData();
      const community1Id = fixtures.communities[0].id;
      const community2Id = fixtures.communities[1].id;

      const user1Data = {
        email: 'user1@example.com',
        password: 'StrongPassword123@',
        firstName: 'User',
        lastName: 'One',
        role: 'viewer',
        communityId: community1Id,
      };

      const user2Data = {
        email: 'user2@example.com',
        password: 'StrongPassword123@',
        firstName: 'User',
        lastName: 'Two',
        role: 'editor',
        communityId: community2Id,
      };

      const response1 = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: user1Data,
      });

      const response2 = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: user2Data,
      });

      expect(response1.statusCode).toBe(201);
      expect(response2.statusCode).toBe(201);

      const user1 = JSON.parse(response1.body);
      const user2 = JSON.parse(response2.body);

      expect(user1.communityId).toBe(community1Id);
      expect(user2.communityId).toBe(community2Id);
      expect(user1.id).not.toBe(user2.id);
    });

    test('should allow same email in different communities', async () => {
      const fixtures = await testDb.seedTestData();
      const community1Id = fixtures.communities[0].id;
      const community2Id = fixtures.communities[1].id;

      const userData = {
        email: 'same@example.com',
        password: 'StrongPassword123@',
        firstName: 'Same',
        lastName: 'Email',
        role: 'viewer',
      };

      const response1 = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { ...userData, communityId: community1Id },
      });

      const response2 = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { ...userData, communityId: community2Id },
      });

      expect(response1.statusCode).toBe(201);
      expect(response2.statusCode).toBe(201);

      const user1 = JSON.parse(response1.body);
      const user2 = JSON.parse(response2.body);

      expect(user1.email).toBe(userData.email);
      expect(user2.email).toBe(userData.email);
      expect(user1.communityId).toBe(community1Id);
      expect(user2.communityId).toBe(community2Id);
    });
  });
});