// Example: Complete test suite for a route
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app';
import { users } from '../../src/db/schema';
import { NewUser } from '../../src/db/schema/users';

describe('User Routes', () => {
  let app: FastifyInstance;

  // Helper function to reduce duplication
  const createUser = async (userData: NewUser) => {
    return app.inject({
      method: 'POST',
      url: '/users',
      payload: userData,
    });
  };

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    // It's good practice to ensure the table is clean before each test
    // This uses the instance of the db attached to the app server
    await app.db.delete(users);
  });

  describe('POST /users', () => {
    it('should create a new user successfully', async () => {
      const newUser = {
        email: 'test@example.com',
        name: 'Test User',
      };

      const response = await createUser(newUser);
      const body = JSON.parse(response.body);

      expect(response.statusCode).toBe(201);
      expect(body).toHaveProperty('id');
      expect(body.email).toBe(newUser.email);
    });

    it('should return 400 for invalid email format', async () => {
      const response = await createUser({
        email: 'not-an-email',
        name: 'Test User',
      });
      expect(response.statusCode).toBe(400);
    });

    it('should return 409 when user email already exists', async () => {
      const userData = {
        email: 'duplicate@example.com',
        name: 'Test User',
      };
      await createUser(userData); // First user
      const response = await createUser(userData); // Second user with same email
      expect(response.statusCode).toBe(409);
    });
  });

  describe('GET /users/:id', () => {
    it('should return a user by their ID', async () => {
      const createResponse = await createUser({
        email: 'getme@example.com',
        name: 'Get User',
      });
      const { id } = JSON.parse(createResponse.body);

      const response = await app.inject({
        method: 'GET',
        url: `/users/${id}`,
      });
      const body = JSON.parse(response.body);

      expect(response.statusCode).toBe(200);
      expect(body.id).toBe(id);
      expect(body.email).toBe('getme@example.com');
    });

    it('should return 404 for a user that does not exist', async () => {
      const nonExistentId = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'; // A valid UUID
      const response = await app.inject({
        method: 'GET',
        url: `/users/${nonExistentId}`,
      });
      expect(response.statusCode).toBe(404);
    });

    it('should return 400 for an invalid UUID format', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/users/not-a-uuid',
      });
      expect(response.statusCode).toBe(400);
    });
  });
});
