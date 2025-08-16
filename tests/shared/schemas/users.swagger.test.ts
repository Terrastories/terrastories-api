import { describe, it, expect } from 'vitest';
import {
  userSchemas,
  userParameters,
  userExamples,
} from '../../../src/shared/schemas/users.swagger.js';

describe('Users Swagger Schemas', () => {
  describe('User Schema', () => {
    it('should have all required properties defined', () => {
      const schema = userSchemas.User;

      expect(schema.type).toBe('object');
      expect(schema.properties).toBeDefined();
      expect(schema.required).toEqual([
        'id',
        'email',
        'firstName',
        'lastName',
        'role',
        'communityId',
        'isActive',
        'createdAt',
        'updatedAt',
      ]);
    });

    it('should define correct property types', () => {
      const properties = userSchemas.User.properties;

      expect(properties.id.type).toBe('integer');
      expect(properties.email.type).toBe('string');
      expect(properties.email.format).toBe('email');
      expect(properties.firstName.type).toBe('string');
      expect(properties.lastName.type).toBe('string');
      expect(properties.role.type).toBe('string');
      expect(properties.role.enum).toEqual([
        'super_admin',
        'admin',
        'editor',
        'viewer',
      ]);
      expect(properties.communityId.type).toBe('integer');
      expect(properties.isActive.type).toBe('boolean');
      expect(properties.createdAt.type).toBe('string');
      expect(properties.createdAt.format).toBe('date-time');
      expect(properties.updatedAt.type).toBe('string');
      expect(properties.updatedAt.format).toBe('date-time');
    });
  });

  describe('CreateUser Schema', () => {
    it('should have correct required fields for creation', () => {
      const schema = userSchemas.CreateUser;

      expect(schema.required).toEqual([
        'email',
        'passwordHash',
        'firstName',
        'lastName',
        'communityId',
      ]);
    });

    it('should include passwordHash for creation', () => {
      const properties = userSchemas.CreateUser.properties;

      expect(properties.passwordHash).toBeDefined();
      expect(properties.passwordHash.type).toBe('string');
    });

    it('should not include read-only fields', () => {
      const properties = userSchemas.CreateUser.properties;

      expect(properties.id).toBeUndefined();
      expect(properties.createdAt).toBeUndefined();
      expect(properties.updatedAt).toBeUndefined();
    });
  });

  describe('UpdateUser Schema', () => {
    it('should have all fields optional', () => {
      const schema = userSchemas.UpdateUser;

      expect(schema.required).toBeUndefined();
    });

    it('should not include read-only fields', () => {
      const properties = userSchemas.UpdateUser.properties;

      expect(properties.id).toBeUndefined();
      expect(properties.passwordHash).toBeUndefined();
      expect(properties.communityId).toBeUndefined(); // Users can't change community
      expect(properties.createdAt).toBeUndefined();
      expect(properties.updatedAt).toBeUndefined();
    });
  });

  describe('Response Schemas', () => {
    it('should define UserResponse schema correctly', () => {
      const schema = userSchemas.UserResponse;

      expect(schema.type).toBe('object');
      expect(schema.properties.data).toBeDefined();
      expect(schema.properties.data.$ref).toBe('#/components/schemas/User');
      expect(schema.required).toEqual(['data']);
    });

    it('should define UserListResponse schema correctly', () => {
      const schema = userSchemas.UserListResponse;

      expect(schema.type).toBe('object');
      expect(schema.properties.data).toBeDefined();
      expect(schema.properties.data.type).toBe('array');
      expect(schema.properties.meta).toBeDefined();
      expect(schema.required).toEqual(['data', 'meta']);
    });
  });

  describe('Error Schemas', () => {
    it('should define validation error schema', () => {
      const schema = userSchemas.ValidationError;

      expect(schema.properties.error).toBeDefined();
      expect(schema.properties.statusCode.enum).toEqual([400]);
      expect(schema.properties.details).toBeDefined();
    });

    it('should define not found error schema', () => {
      const schema = userSchemas.NotFoundError;

      expect(schema.properties.error.enum).toEqual(['User not found']);
      expect(schema.properties.statusCode.enum).toEqual([404]);
    });

    it('should define conflict error schema', () => {
      const schema = userSchemas.ConflictError;

      expect(schema.properties.error.enum).toEqual(['Email already exists']);
      expect(schema.properties.statusCode.enum).toEqual([409]);
    });
  });

  describe('Parameters', () => {
    it('should define userId parameter correctly', () => {
      const param = userParameters.userId;

      expect(param.name).toBe('id');
      expect(param.in).toBe('path');
      expect(param.required).toBe(true);
      expect(param.schema.type).toBe('integer');
    });

    it('should define filter parameters correctly', () => {
      const communityFilter = userParameters.communityFilter;
      const roleFilter = userParameters.roleFilter;
      const activeFilter = userParameters.activeFilter;

      expect(communityFilter.name).toBe('communityId');
      expect(communityFilter.in).toBe('query');
      expect(communityFilter.required).toBe(false);

      expect(roleFilter.schema.enum).toEqual([
        'super_admin',
        'admin',
        'editor',
        'viewer',
      ]);
      expect(activeFilter.schema.type).toBe('boolean');
    });

    it('should define pagination parameters correctly', () => {
      const pageParam = userParameters.pageParam;
      const limitParam = userParameters.limitParam;

      expect(pageParam.schema.minimum).toBe(1);
      expect(pageParam.schema.default).toBe(1);

      expect(limitParam.schema.minimum).toBe(1);
      expect(limitParam.schema.maximum).toBe(100);
      expect(limitParam.schema.default).toBe(20);
    });
  });

  describe('Examples', () => {
    it('should provide valid user example', () => {
      const example = userExamples.user;

      expect(example.id).toBeDefined();
      expect(example.email).toMatch(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
      expect(example.firstName).toBeDefined();
      expect(example.lastName).toBeDefined();
      expect(['super_admin', 'admin', 'editor', 'viewer']).toContain(
        example.role
      );
      expect(example.communityId).toBeDefined();
      expect(typeof example.isActive).toBe('boolean');
    });

    it('should provide valid createUser example', () => {
      const example = userExamples.createUser;

      expect(example.email).toMatch(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
      expect(example.passwordHash).toBeDefined();
      expect(example.firstName).toBeDefined();
      expect(example.lastName).toBeDefined();
      expect(example.communityId).toBeDefined();
    });

    it('should provide valid userList example', () => {
      const example = userExamples.userList;

      expect(Array.isArray(example.data)).toBe(true);
      expect(example.meta).toBeDefined();
      expect(example.meta.total).toBeDefined();
      expect(example.meta.page).toBeDefined();
      expect(example.meta.limit).toBeDefined();
      expect(example.meta.totalPages).toBeDefined();
    });
  });

  describe('Schema Validation', () => {
    it('should validate role enum values', () => {
      const validRoles = ['super_admin', 'admin', 'editor', 'viewer'];
      const schemaRoles = userSchemas.User.properties.role.enum;

      expect(schemaRoles).toEqual(validRoles);
    });

    it('should have consistent email validation', () => {
      const userEmailFormat = userSchemas.User.properties.email.format;
      const createUserEmailFormat =
        userSchemas.CreateUser.properties.email.format;
      const updateUserEmailFormat =
        userSchemas.UpdateUser.properties.email.format;

      expect(userEmailFormat).toBe('email');
      expect(createUserEmailFormat).toBe('email');
      expect(updateUserEmailFormat).toBe('email');
    });

    it('should have proper integer constraints', () => {
      const userIdMin = userSchemas.User.properties.id.minimum;
      const communityIdMin = userSchemas.User.properties.communityId.minimum;

      expect(userIdMin).toBe(1);
      expect(communityIdMin).toBe(1);
    });
  });
});
