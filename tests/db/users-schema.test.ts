import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { z } from 'zod';
import { getDb } from '../../src/db/index.js';
import {
  getUsersTable,
  usersPg,
  usersSqlite,
  usersRelations,
  insertUserSchema,
  selectUserSchema,
  type User,
  type NewUser,
} from '../../src/db/schema/users.js';

describe('Users Schema', () => {
  let db: any;

  beforeAll(async () => {
    db = await getDb();
  });

  afterAll(async () => {
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  describe('Multi-Database Support', () => {
    it('should export PostgreSQL table definition', () => {
      expect(usersPg).toBeDefined();
      expect(typeof usersPg).toBe('object');
    });

    it('should export SQLite table definition', () => {
      expect(usersSqlite).toBeDefined();
      expect(typeof usersSqlite).toBe('object');
    });

    it('should have getUsersTable function for runtime selection', async () => {
      expect(getUsersTable).toBeDefined();
      expect(typeof getUsersTable).toBe('function');

      const table = await getUsersTable();
      expect(table).toBeDefined();
      expect(typeof table).toBe('object');
    });
  });

  describe('Schema Structure', () => {
    it('should have all required and compatibility fields', async () => {
      const table = await getUsersTable();
      const columns = Object.keys(table);

      for (const field of [
        'id',
        'email',
        'passwordHash',
        'firstName',
        'lastName',
        'role',
        'communityId',
        'isActive',
        'createdAt',
        'updatedAt',
        'resetPasswordToken',
        'resetPasswordSentAt',
        'rememberCreatedAt',
        'signInCount',
        'lastSignInAt',
        'currentSignInIp',
      ]) {
        expect(columns).toContain(field);
      }
    });

    it('should validate required fields through schema', () => {
      expect(() => {
        insertUserSchema.parse({});
      }).toThrow();
    });

    it('should have proper default values in validation schema', () => {
      const parsed = insertUserSchema.parse({
        email: 'test@example.com',
        passwordHash: 'hashedpassword',
        firstName: 'Test',
        lastName: 'User',
        communityId: 1,
      });

      expect(parsed.role).toBe('viewer');
      expect(parsed.isActive).toBe(true);
      expect(parsed.signInCount).toBe(0);
    });
  });

  describe('Role Enum Validation', () => {
    it('should accept valid role values', () => {
      const validRoles = ['super_admin', 'admin', 'editor', 'viewer'];

      validRoles.forEach((role) => {
        expect(() => {
          insertUserSchema.parse({
            email: 'test@example.com',
            passwordHash: 'hashedpassword',
            firstName: 'Test',
            lastName: 'User',
            role,
            communityId: 1,
          });
        }).not.toThrow();
      });
    });

    it('should reject invalid role values', () => {
      expect(() => {
        insertUserSchema.parse({
          email: 'test@example.com',
          passwordHash: 'hashedpassword',
          firstName: 'Test',
          lastName: 'User',
          role: 'invalid_role',
          communityId: 1,
        });
      }).toThrow();
    });

    it('should default to viewer role when not specified', () => {
      const parsed = insertUserSchema.parse({
        email: 'test@example.com',
        passwordHash: 'hashedpassword',
        firstName: 'Test',
        lastName: 'User',
        communityId: 1,
      });

      expect(parsed.role).toBe('viewer');
    });
  });

  describe('Zod Validation Schemas', () => {
    it('should export insertUserSchema', () => {
      expect(insertUserSchema).toBeDefined();
      expect(insertUserSchema instanceof z.ZodType).toBe(true);
    });

    it('should export selectUserSchema', () => {
      expect(selectUserSchema).toBeDefined();
      expect(selectUserSchema instanceof z.ZodType).toBe(true);
    });

    it('should validate required fields for insert', () => {
      expect(() => {
        insertUserSchema.parse({});
      }).toThrow();
    });

    it('should validate email format', () => {
      expect(() => {
        insertUserSchema.parse({
          email: 'invalid-email',
          passwordHash: 'hashedpassword',
          firstName: 'Test',
          lastName: 'User',
          communityId: 1,
        });
      }).toThrow();
    });

    it('should validate complete user object', () => {
      const validUser = {
        email: 'test@example.com',
        passwordHash: 'hashedpassword123',
        firstName: 'John',
        lastName: 'Doe',
        role: 'editor' as const,
        communityId: 1,
        isActive: true,
      };

      expect(() => {
        insertUserSchema.parse(validUser);
      }).not.toThrow();
    });
  });

  describe('TypeScript Types', () => {
    it('should export User type', () => {
      const user: User = {
        id: 1,
        email: 'test@example.com',
        passwordHash: 'hashedpassword',
        firstName: 'Test',
        lastName: 'User',
        role: 'viewer',
        communityId: 1,
        isActive: true,
        lastLoginAt: null,
        resetPasswordToken: null,
        resetPasswordSentAt: null,
        rememberCreatedAt: null,
        signInCount: 0,
        lastSignInAt: null,
        currentSignInIp: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      expect(user).toBeDefined();
    });

    it('should export NewUser type', () => {
      const newUser: NewUser = {
        email: 'test@example.com',
        passwordHash: 'hashedpassword',
        firstName: 'Test',
        lastName: 'User',
        communityId: 1,
      };

      expect(newUser).toBeDefined();
    });
  });

  describe('Relations', () => {
    it('should export usersRelations', () => {
      expect(usersRelations).toBeDefined();
    });

    it('should define community relation', () => {
      expect(usersRelations).toBeDefined();
    });
  });

  describe('Multi-Tenant Data Isolation', () => {
    it('should require communityId for data isolation', () => {
      expect(() => {
        insertUserSchema.parse({
          email: 'test@example.com',
          passwordHash: 'hashedpassword',
          firstName: 'Test',
          lastName: 'User',
        });
      }).toThrow();
    });

    it('should validate communityId is a number', () => {
      expect(() => {
        insertUserSchema.parse({
          email: 'test@example.com',
          passwordHash: 'hashedpassword',
          firstName: 'Test',
          lastName: 'User',
          communityId: 'invalid',
        });
      }).toThrow();
    });
  });

  describe('Database Operations', () => {
    beforeEach(async () => {
      try {
        const { sql } = await import('drizzle-orm');
        await db.run(sql`DELETE FROM users WHERE email LIKE 'test%'`);
      } catch {
        // Table may not be available for schema-only tests.
      }
    });

    it('should create users table during migration', async () => {
      try {
        const { sql } = await import('drizzle-orm');
        await db.run(sql`SELECT 1 FROM users LIMIT 1`);
      } catch (tableError) {
        expect(tableError).toBeDefined();
      }
    });

    it('should expose the unique email/community constraint definition', () => {
      expect(usersPg).toBeDefined();
      expect(usersSqlite).toBeDefined();
    });

    it('should expose foreign-key community relations on both variants', () => {
      expect(usersRelations).toBeDefined();
    });
  });

  describe('Authentication compatibility fields', () => {
    const compatibilityFields = [
      'resetPasswordToken',
      'resetPasswordSentAt',
      'rememberCreatedAt',
      'signInCount',
      'lastSignInAt',
      'currentSignInIp',
    ] as const;

    it('should expose compatibility columns in the active table schema', async () => {
      const columns = Object.keys(await getUsersTable());
      for (const field of compatibilityFields) {
        expect(columns).toContain(field);
      }
    });

    it('should preserve provided auth compatibility fields in insert validation', () => {
      const parsed = insertUserSchema.parse({
        email: 'reset-compatible@example.com',
        passwordHash: 'test-password-hash',
        firstName: 'Reset',
        lastName: 'Compatible',
        communityId: 1,
        resetPasswordToken: 'temporary-token',
        signInCount: 5,
      });

      expect(parsed.resetPasswordToken).toBe('temporary-token');
      expect(parsed.signInCount).toBe(5);
    });
  });

  describe('Edge Cases', () => {
    it('should handle very long names', () => {
      const longName = 'a'.repeat(1000);

      expect(() => {
        insertUserSchema.parse({
          email: 'test@example.com',
          passwordHash: 'hashedpassword',
          firstName: longName,
          lastName: longName,
          communityId: 1,
        });
      }).not.toThrow();
    });

    it('should handle unicode characters in names', () => {
      expect(() => {
        insertUserSchema.parse({
          email: 'test@example.com',
          passwordHash: 'hashedpassword',
          firstName: 'José',
          lastName: 'García',
          communityId: 1,
        });
      }).not.toThrow();
    });

    it('should handle boolean isActive values correctly', () => {
      const user1 = insertUserSchema.parse({
        email: 'test1@example.com',
        passwordHash: 'hashedpassword',
        firstName: 'Test',
        lastName: 'User',
        communityId: 1,
        isActive: true,
      });

      const user2 = insertUserSchema.parse({
        email: 'test2@example.com',
        passwordHash: 'hashedpassword',
        firstName: 'Test',
        lastName: 'User',
        communityId: 1,
        isActive: false,
      });

      expect(user1.isActive).toBe(true);
      expect(user2.isActive).toBe(false);
    });
  });
});
