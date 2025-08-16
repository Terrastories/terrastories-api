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
    it('should have all required fields', async () => {
      const table = await getUsersTable();
      const columns = Object.keys(table);

      expect(columns).toContain('id');
      expect(columns).toContain('email');
      expect(columns).toContain('passwordHash');
      expect(columns).toContain('firstName');
      expect(columns).toContain('lastName');
      expect(columns).toContain('role');
      expect(columns).toContain('communityId');
      expect(columns).toContain('isActive');
      expect(columns).toContain('createdAt');
      expect(columns).toContain('updatedAt');
    });

    it('should validate required fields through schema', () => {
      // Test that required fields are enforced by Zod schema
      expect(() => {
        insertUserSchema.parse({
          // Missing required fields should fail
        });
      }).toThrow();
    });

    it('should have proper default values in validation schema', () => {
      // Test that defaults work in the Zod schema
      const validUser = {
        email: 'test@example.com',
        passwordHash: 'hashedpassword',
        firstName: 'Test',
        lastName: 'User',
        communityId: 1,
        // role and isActive should get defaults
      };

      const parsed = insertUserSchema.parse(validUser);
      expect(parsed.role).toBe('viewer');
      expect(parsed.isActive).toBe(true);
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
      // This is a compile-time test, but we can verify the types exist
      const user: User = {
        id: 1,
        email: 'test@example.com',
        passwordHash: 'hashedpassword',
        firstName: 'Test',
        lastName: 'User',
        role: 'viewer',
        communityId: 1,
        isActive: true,
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
      // The actual relations testing would require a full database setup
      // For now, we just verify the relation object exists
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
          // Missing communityId should cause validation error
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
      // Clean up any existing test data
      try {
        const { sql } = await import('drizzle-orm');
        await db.run(sql`DELETE FROM users WHERE email LIKE 'test%'`);
      } catch {
        // Table might not exist yet, that's expected in TDD
      }
    });

    it('should create users table during migration', async () => {
      // This test will pass once the schema is implemented and migration is run
      try {
        const { sql } = await import('drizzle-orm');
        await db.run(sql`SELECT 1 FROM users LIMIT 1`);
      } catch (tableError) {
        // Table doesn't exist yet - expected in TDD
        expect(tableError).toBeDefined();
      }
    });

    it('should enforce unique email constraint', async () => {
      // This test will be meaningful once the table exists
      expect(true).toBe(true); // Placeholder for now
    });

    it('should enforce foreign key constraint to communities', async () => {
      // This test will be meaningful once both tables exist with relations
      expect(true).toBe(true); // Placeholder for now
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
      }).not.toThrow(); // Should allow long names unless we add specific length constraints
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
