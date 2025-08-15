// Example: Complete test suite for a route
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app';

describe('User Routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    // Clean test database before each test
    await app.db.delete(users);
  });

  describe('POST /users', () => {
    it('should create a new user', async () => {
      const userData = {
        email: 'test@example.com',
        name: 'Test User',
      };

      const response = await app.inject({
        method: 'POST',
        url: '/users',
        payload: userData,
      });

      expect(response.statusCode).toBe(201);

      const body = JSON.parse(response.body);
      expect(body).toHaveProperty('id');
      expect(body.email).toBe(userData.email);
      expect(body.name).toBe(userData.name);
    });

    it('should return 400 for invalid email', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/users',
        payload: {
          email: 'invalid-email',
          name: 'Test User',
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should return 409 for duplicate email', async () => {
      const userData = {
        email: 'test@example.com',
        name: 'Test User',
      };

      // Create first user
      await app.inject({
        method: 'POST',
        url: '/users',
        payload: userData,
      });

      // Try to create duplicate
      const response = await app.inject({
        method: 'POST',
        url: '/users',
        payload: userData,
      });

      expect(response.statusCode).toBe(409);
    });
  });

  describe('GET /users/:id', () => {
    it('should return user by ID', async () => {
      // Create test user
      const createResponse = await app.inject({
        method: 'POST',
        url: '/users',
        payload: {
          email: 'test@example.com',
          name: 'Test User',
        },
      });

      const { id } = JSON.parse(createResponse.body);

      // Get user
      const response = await app.inject({
        method: 'GET',
        url: `/users/${id}`,
      });

      expect(response.statusCode).toBe(200);

      const body = JSON.parse(response.body);
      expect(body.id).toBe(id);
      expect(body.email).toBe('test@example.com');
    });

    it('should return 404 for non-existent user', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/users/550e8400-e29b-41d4-a716-446655440000',
      });

      expect(response.statusCode).toBe(404);
    });

    it('should return 400 for invalid UUID', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/users/invalid-id',
      });

      expect(response.statusCode).toBe(400);
    });
  });
});
