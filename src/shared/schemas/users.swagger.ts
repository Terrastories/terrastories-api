/**
 * Swagger/OpenAPI schema definitions for Users
 *
 * This file defines the OpenAPI schemas for user-related operations,
 * ensuring consistent API documentation and validation.
 */

export const userSchemas = {
  // User object schema
  User: {
    type: 'object' as const,
    properties: {
      id: {
        type: 'integer',
        minimum: 1,
        description: 'Unique user identifier',
      },
      email: {
        type: 'string' as const,
        format: 'email',
        description: 'User email address (unique)',
      },
      firstName: {
        type: 'string' as const,
        minLength: 1,
        description: 'User first name',
      },
      lastName: {
        type: 'string' as const,
        minLength: 1,
        description: 'User last name',
      },
      role: {
        type: 'string' as const,
        enum: ['super_admin', 'admin', 'editor', 'viewer'],
        default: 'viewer',
        description: 'User role determining access permissions',
      },
      communityId: {
        type: 'integer' as const,
        minimum: 1,
        description: 'ID of the community the user belongs to',
      },
      isActive: {
        type: 'boolean' as const,
        default: true,
        description: 'Whether the user account is active',
      },
      createdAt: {
        type: 'string' as const,
        format: 'date-time',
        description: 'When the user was created',
      },
      updatedAt: {
        type: 'string' as const,
        format: 'date-time',
        description: 'When the user was last updated',
      },
    },
    required: [
      'id',
      'email',
      'firstName',
      'lastName',
      'role',
      'communityId',
      'isActive',
      'createdAt',
      'updatedAt',
    ],
    additionalProperties: false,
  },

  // New user creation schema (without read-only fields)
  CreateUser: {
    type: 'object' as const,
    properties: {
      email: {
        type: 'string' as const,
        format: 'email',
        description: 'User email address (must be unique)',
      },
      passwordHash: {
        type: 'string' as const,
        minLength: 1,
        description: 'Hashed password (never returned in responses)',
      },
      firstName: {
        type: 'string' as const,
        minLength: 1,
        description: 'User first name',
      },
      lastName: {
        type: 'string' as const,
        minLength: 1,
        description: 'User last name',
      },
      role: {
        type: 'string' as const,
        enum: ['super_admin', 'admin', 'editor', 'viewer'],
        default: 'viewer',
        description: 'User role determining access permissions',
      },
      communityId: {
        type: 'integer' as const,
        minimum: 1,
        description: 'ID of the community the user belongs to',
      },
      isActive: {
        type: 'boolean' as const,
        default: true,
        description: 'Whether the user account is active',
      },
    },
    required: ['email', 'passwordHash', 'firstName', 'lastName', 'communityId'],
    additionalProperties: false,
  },

  // User update schema (all fields optional except restrictions)
  UpdateUser: {
    type: 'object' as const,
    properties: {
      email: {
        type: 'string' as const,
        format: 'email',
        description: 'User email address (must be unique)',
      },
      firstName: {
        type: 'string' as const,
        minLength: 1,
        description: 'User first name',
      },
      lastName: {
        type: 'string' as const,
        minLength: 1,
        description: 'User last name',
      },
      role: {
        type: 'string' as const,
        enum: ['super_admin', 'admin', 'editor', 'viewer'],
        description: 'User role determining access permissions',
      },
      isActive: {
        type: 'boolean' as const,
        description: 'Whether the user account is active',
      },
    },
    additionalProperties: false,
  },

  // User list response schema
  UserListResponse: {
    type: 'object' as const,
    properties: {
      data: {
        type: 'array' as const,
        items: { $ref: '#/components/schemas/User' },
        description: 'Array of users',
      },
      meta: {
        type: 'object' as const,
        properties: {
          total: {
            type: 'integer',
            minimum: 0,
            description: 'Total number of users',
          },
          page: {
            type: 'integer',
            minimum: 1,
            description: 'Current page number',
          },
          limit: { type: 'integer', minimum: 1, description: 'Items per page' },
          totalPages: {
            type: 'integer',
            minimum: 1,
            description: 'Total number of pages',
          },
        },
        required: ['total', 'page', 'limit', 'totalPages'],
      },
    },
    required: ['data', 'meta'],
    additionalProperties: false,
  },

  // Single user response schema
  UserResponse: {
    type: 'object' as const,
    properties: {
      data: { $ref: '#/components/schemas/User' },
    },
    required: ['data'],
    additionalProperties: false,
  },

  // Error response schemas
  ValidationError: {
    type: 'object' as const,
    properties: {
      error: { type: 'string', description: 'Error message' },
      statusCode: {
        type: 'integer',
        enum: [400],
        description: 'HTTP status code',
      },
      details: {
        type: 'array' as const,
        items: {
          type: 'object' as const,
          properties: {
            field: {
              type: 'string',
              description: 'Field that failed validation',
            },
            message: {
              type: 'string',
              description: 'Validation error message',
            },
          },
          required: ['field', 'message'],
        },
        description: 'Detailed validation errors',
      },
    },
    required: ['error', 'statusCode'],
    additionalProperties: false,
  },

  NotFoundError: {
    type: 'object' as const,
    properties: {
      error: {
        type: 'string',
        enum: ['User not found'],
        description: 'Error message',
      },
      statusCode: {
        type: 'integer',
        enum: [404],
        description: 'HTTP status code',
      },
    },
    required: ['error', 'statusCode'],
    additionalProperties: false,
  },

  ConflictError: {
    type: 'object' as const,
    properties: {
      error: {
        type: 'string',
        enum: ['Email already exists'],
        description: 'Error message',
      },
      statusCode: {
        type: 'integer',
        enum: [409],
        description: 'HTTP status code',
      },
    },
    required: ['error', 'statusCode'],
    additionalProperties: false,
  },

  UnauthorizedError: {
    type: 'object' as const,
    properties: {
      error: {
        type: 'string',
        enum: ['Unauthorized'],
        description: 'Error message',
      },
      statusCode: {
        type: 'integer',
        enum: [401],
        description: 'HTTP status code',
      },
    },
    required: ['error', 'statusCode'],
    additionalProperties: false,
  },

  ForbiddenError: {
    type: 'object' as const,
    properties: {
      error: {
        type: 'string',
        enum: ['Forbidden'],
        description: 'Error message',
      },
      statusCode: {
        type: 'integer',
        enum: [403],
        description: 'HTTP status code',
      },
    },
    required: ['error', 'statusCode'],
    additionalProperties: false,
  },
};

// Parameter schemas for user operations
export const userParameters = {
  userId: {
    name: 'id',
    in: 'path',
    required: true,
    schema: {
      type: 'integer' as const,
      minimum: 1,
    },
    description: 'User ID',
  },

  communityFilter: {
    name: 'communityId',
    in: 'query',
    required: false,
    schema: {
      type: 'integer' as const,
      minimum: 1,
    },
    description: 'Filter users by community ID',
  },

  roleFilter: {
    name: 'role',
    in: 'query',
    required: false,
    schema: {
      type: 'string' as const,
      enum: ['super_admin', 'admin', 'editor', 'viewer'],
    },
    description: 'Filter users by role',
  },

  activeFilter: {
    name: 'isActive',
    in: 'query',
    required: false,
    schema: {
      type: 'boolean' as const,
    },
    description: 'Filter users by active status',
  },

  pageParam: {
    name: 'page',
    in: 'query',
    required: false,
    schema: {
      type: 'integer' as const,
      minimum: 1,
      default: 1,
    },
    description: 'Page number for pagination',
  },

  limitParam: {
    name: 'limit',
    in: 'query',
    required: false,
    schema: {
      type: 'integer' as const,
      minimum: 1,
      maximum: 100,
      default: 20,
    },
    description: 'Number of items per page',
  },
};

// Common response examples
export const userExamples = {
  user: {
    id: 1,
    email: 'john.doe@example.com',
    firstName: 'John',
    lastName: 'Doe',
    role: 'editor',
    communityId: 1,
    isActive: true,
    createdAt: '2024-01-15T10:30:00Z',
    updatedAt: '2024-01-15T10:30:00Z',
  },

  createUser: {
    email: 'jane.smith@example.com',
    passwordHash: '$2b$10$...', // Example hash
    firstName: 'Jane',
    lastName: 'Smith',
    role: 'viewer',
    communityId: 1,
    isActive: true,
  },

  updateUser: {
    firstName: 'Jane',
    lastName: 'Smith-Johnson',
    role: 'editor',
  },

  userList: {
    data: [
      {
        id: 1,
        email: 'john.doe@example.com',
        firstName: 'John',
        lastName: 'Doe',
        role: 'editor',
        communityId: 1,
        isActive: true,
        createdAt: '2024-01-15T10:30:00Z',
        updatedAt: '2024-01-15T10:30:00Z',
      },
      {
        id: 2,
        email: 'jane.smith@example.com',
        firstName: 'Jane',
        lastName: 'Smith',
        role: 'viewer',
        communityId: 1,
        isActive: true,
        createdAt: '2024-01-16T09:15:00Z',
        updatedAt: '2024-01-16T09:15:00Z',
      },
    ],
    meta: {
      total: 2,
      page: 1,
      limit: 20,
      totalPages: 1,
    },
  },
};
