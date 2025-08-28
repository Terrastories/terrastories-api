/**
 * Super Admin Swagger/OpenAPI Schema Definitions
 *
 * Comprehensive OpenAPI schemas for Super Admin operations including:
 * - Complete schema definitions for all community and user management operations
 * - Request/response schemas with proper validation examples
 * - Error schemas for all possible error states
 * - Parameters for filtering and pagination
 * - Examples for all operations with cultural sensitivity
 */

// Community Management Schemas
export const superAdminSchemas = {
  // Community Schemas
  Community: {
    type: 'object',
    required: [
      'id',
      'name',
      'slug',
      'locale',
      'publicStories',
      'isActive',
      'userCount',
      'createdAt',
      'updatedAt',
    ],
    properties: {
      id: {
        type: 'integer',
        description: 'Unique identifier for the community',
        example: 1,
      },
      name: {
        type: 'string',
        description: 'The display name of the Indigenous community',
        example: 'Secwépemc Nation',
        minLength: 2,
        maxLength: 100,
      },
      description: {
        type: 'string',
        nullable: true,
        description:
          'Optional community description highlighting cultural and geographical context',
        example:
          'Traditional territory of the Secwépemc people in the Interior of British Columbia, Canada.',
        maxLength: 1000,
      },
      slug: {
        type: 'string',
        description: 'URL-friendly identifier for the community',
        example: 'secwepemc-nation',
        pattern: '^[a-z0-9-]+$',
        minLength: 3,
        maxLength: 50,
      },
      locale: {
        type: 'string',
        description:
          "Primary language/locale code for the community (e.g., shs for Shuswap, mic for Mi'kmaq, en for English)",
        example: 'shs',
        pattern: '^[a-z]{2,3}(-[A-Z]{2})?$',
      },
      publicStories: {
        type: 'boolean',
        description:
          'Controls story visibility - false protects cultural content, true allows public access',
        example: false,
      },
      isActive: {
        type: 'boolean',
        description:
          'Whether the community is currently active and accepting new stories',
        example: true,
      },
      userCount: {
        type: 'integer',
        description: 'Number of users in this community',
        example: 23,
        minimum: 0,
      },
      createdAt: {
        type: 'string',
        format: 'date-time',
        description: 'ISO 8601 timestamp when community was created',
        example: '2024-01-15T08:30:00.000Z',
      },
      updatedAt: {
        type: 'string',
        format: 'date-time',
        description: 'ISO 8601 timestamp when community was last updated',
        example: '2024-01-15T08:30:00.000Z',
      },
    },
  },

  CreateCommunityRequest: {
    type: 'object',
    required: ['name'],
    properties: {
      name: {
        type: 'string',
        description: 'The display name of the Indigenous community',
        example: 'Secwépemc Nation',
        minLength: 2,
        maxLength: 100,
      },
      description: {
        type: 'string',
        description:
          'Optional community description highlighting cultural and geographical context',
        example:
          'Traditional territory of the Secwépemc people in the Interior of British Columbia, Canada.',
        maxLength: 1000,
      },
      slug: {
        type: 'string',
        description:
          'URL-friendly identifier for the community. If not provided, will be auto-generated from name',
        example: 'secwepemc-nation',
        pattern: '^[a-z0-9-]+$',
        minLength: 3,
        maxLength: 50,
      },
      locale: {
        type: 'string',
        description:
          "Primary language/locale code for the community (e.g., shs for Shuswap, mic for Mi'kmaq, en for English)",
        example: 'shs',
        pattern: '^[a-z]{2,3}(-[A-Z]{2})?$',
        default: 'en',
      },
      publicStories: {
        type: 'boolean',
        description:
          'Controls story visibility - false protects cultural content, true allows public access',
        example: false,
        default: false,
      },
      isActive: {
        type: 'boolean',
        description:
          'Whether the community is currently active and accepting new stories',
        example: true,
        default: true,
      },
    },
  },

  UpdateCommunityRequest: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'The display name of the Indigenous community',
        example: 'Secwépemc Nation',
        minLength: 2,
        maxLength: 100,
      },
      description: {
        type: 'string',
        description:
          'Optional community description highlighting cultural and geographical context',
        example:
          'Traditional territory of the Secwépemc people in the Interior of British Columbia, Canada. Updated description with more cultural context.',
        maxLength: 1000,
      },
      locale: {
        type: 'string',
        description: 'Primary language/locale code for the community',
        example: 'shs',
        pattern: '^[a-z]{2,3}(-[A-Z]{2})?$',
      },
      publicStories: {
        type: 'boolean',
        description:
          'Controls story visibility - false protects cultural content, true allows public access',
        example: true,
      },
      isActive: {
        type: 'boolean',
        description:
          'Whether the community is currently active and accepting new stories',
        example: true,
      },
    },
  },

  // User Schemas
  User: {
    type: 'object',
    required: [
      'id',
      'email',
      'firstName',
      'lastName',
      'role',
      'communityId',
      'communityName',
      'isActive',
      'createdAt',
      'updatedAt',
    ],
    properties: {
      id: {
        type: 'integer',
        description: 'Unique identifier for the user',
        example: 1,
      },
      email: {
        type: 'string',
        format: 'email',
        description: "User's email address",
        example: 'marie.paul@secwepemc.ca',
      },
      firstName: {
        type: 'string',
        description: "User's first name",
        example: 'Marie',
        maxLength: 50,
      },
      lastName: {
        type: 'string',
        description: "User's last name",
        example: 'Paul',
        maxLength: 50,
      },
      role: {
        type: 'string',
        enum: ['super_admin', 'admin', 'editor', 'viewer'],
        description:
          'User role: super_admin (system-wide), admin (community admin), editor (can create/edit), viewer (read-only)',
        example: 'admin',
      },
      communityId: {
        type: 'integer',
        description: 'ID of the community this user manages or participates in',
        example: 1,
      },
      communityName: {
        type: 'string',
        description: 'Name of the community this user belongs to',
        example: 'Secwépemc Nation',
      },
      isActive: {
        type: 'boolean',
        description: 'Whether the user account is active',
        example: true,
      },
      createdAt: {
        type: 'string',
        format: 'date-time',
        description: 'ISO 8601 timestamp when user was created',
        example: '2024-01-15T09:15:00.000Z',
      },
      updatedAt: {
        type: 'string',
        format: 'date-time',
        description: 'ISO 8601 timestamp when user was last updated',
        example: '2024-01-20T14:22:00.000Z',
      },
      lastLoginAt: {
        type: 'string',
        format: 'date-time',
        nullable: true,
        description: "ISO 8601 timestamp of user's last login",
        example: '2024-01-25T16:45:00.000Z',
      },
    },
  },

  CreateUserRequest: {
    type: 'object',
    required: [
      'email',
      'password',
      'firstName',
      'lastName',
      'role',
      'communityId',
    ],
    properties: {
      email: {
        type: 'string',
        format: 'email',
        description: "User's email address (will be converted to lowercase)",
        example: 'marie.paul@secwepemc.ca',
        maxLength: 255,
      },
      password: {
        type: 'string',
        description: 'Strong password meeting complexity requirements',
        example: 'SecurePass123!',
        minLength: 8,
        maxLength: 128,
        pattern:
          '^(?=.*[a-z])(?=.*[A-Z])(?=.*\\d)(?=.*[@$!%*?&])[A-Za-z\\d@$!%*?&]',
      },
      firstName: {
        type: 'string',
        description: "User's first name",
        example: 'Marie',
        maxLength: 50,
      },
      lastName: {
        type: 'string',
        description: "User's last name",
        example: 'Paul',
        maxLength: 50,
      },
      role: {
        type: 'string',
        enum: ['super_admin', 'admin', 'editor', 'viewer'],
        description:
          'User role: super_admin (system-wide), admin (community admin), editor (can create/edit), viewer (read-only)',
        example: 'admin',
      },
      communityId: {
        type: 'integer',
        description:
          'ID of the community this user will manage or participate in',
        example: 1,
        minimum: 1,
      },
      isActive: {
        type: 'boolean',
        description: 'Account status - false to create disabled accounts',
        example: true,
        default: true,
      },
    },
  },

  UpdateUserRequest: {
    type: 'object',
    properties: {
      firstName: {
        type: 'string',
        description: "User's first name",
        example: 'Marie',
        maxLength: 50,
      },
      lastName: {
        type: 'string',
        description: "User's last name",
        example: 'Paul',
        maxLength: 50,
      },
      role: {
        type: 'string',
        enum: ['super_admin', 'admin', 'editor', 'viewer'],
        description: 'User role level',
        example: 'admin',
      },
      communityId: {
        type: 'integer',
        description: 'ID of the community this user belongs to',
        example: 1,
        minimum: 1,
      },
      isActive: {
        type: 'boolean',
        description: 'Account status',
        example: true,
      },
    },
  },

  // Paginated Response Schemas
  PaginatedCommunitiesResponse: {
    type: 'object',
    required: ['data', 'meta'],
    properties: {
      data: {
        type: 'array',
        items: { $ref: '#/components/schemas/Community' },
      },
      meta: {
        type: 'object',
        required: ['page', 'limit', 'total', 'totalPages'],
        properties: {
          page: {
            type: 'integer',
            description: 'Current page number',
            example: 1,
            minimum: 1,
          },
          limit: {
            type: 'integer',
            description: 'Number of items per page',
            example: 20,
            minimum: 1,
            maximum: 100,
          },
          total: {
            type: 'integer',
            description: 'Total number of items',
            example: 2,
            minimum: 0,
          },
          totalPages: {
            type: 'integer',
            description: 'Total number of pages',
            example: 1,
            minimum: 0,
          },
        },
      },
    },
  },

  PaginatedUsersResponse: {
    type: 'object',
    required: ['data', 'meta'],
    properties: {
      data: {
        type: 'array',
        items: { $ref: '#/components/schemas/User' },
      },
      meta: {
        type: 'object',
        required: ['page', 'limit', 'total', 'totalPages'],
        properties: {
          page: {
            type: 'integer',
            description: 'Current page number',
            example: 1,
            minimum: 1,
          },
          limit: {
            type: 'integer',
            description: 'Number of items per page',
            example: 20,
            minimum: 1,
            maximum: 100,
          },
          total: {
            type: 'integer',
            description: 'Total number of items',
            example: 23,
            minimum: 0,
          },
          totalPages: {
            type: 'integer',
            description: 'Total number of pages',
            example: 2,
            minimum: 0,
          },
        },
      },
    },
  },

  // Success Response Schemas
  CommunityCreatedResponse: {
    type: 'object',
    required: ['data', 'message'],
    properties: {
      data: { $ref: '#/components/schemas/Community' },
      message: {
        type: 'string',
        example: 'Community created successfully',
      },
    },
  },

  CommunityUpdatedResponse: {
    type: 'object',
    required: ['data', 'message'],
    properties: {
      data: { $ref: '#/components/schemas/Community' },
      message: {
        type: 'string',
        example: 'Community updated successfully',
      },
    },
  },

  CommunityDeletedResponse: {
    type: 'object',
    required: ['data'],
    properties: {
      data: {
        type: 'object',
        required: ['message', 'id'],
        properties: {
          message: {
            type: 'string',
            example: 'Community archived successfully',
          },
          id: {
            type: 'integer',
            example: 2,
          },
        },
      },
    },
  },

  UserCreatedResponse: {
    type: 'object',
    required: ['data', 'message'],
    properties: {
      data: { $ref: '#/components/schemas/User' },
      message: {
        type: 'string',
        example: 'User created successfully',
      },
    },
  },

  UserUpdatedResponse: {
    type: 'object',
    required: ['data', 'message'],
    properties: {
      data: { $ref: '#/components/schemas/User' },
      message: {
        type: 'string',
        example: 'User updated successfully',
      },
    },
  },

  UserDeletedResponse: {
    type: 'object',
    required: ['data'],
    properties: {
      data: {
        type: 'object',
        required: ['message', 'id'],
        properties: {
          message: {
            type: 'string',
            example: 'User deactivated successfully',
          },
          id: {
            type: 'integer',
            example: 3,
          },
        },
      },
    },
  },

  // Error Response Schemas
  ValidationError: {
    type: 'object',
    required: ['error', 'statusCode'],
    properties: {
      error: {
        type: 'string',
        example: 'Validation failed',
      },
      statusCode: {
        type: 'integer',
        example: 400,
      },
      issues: {
        type: 'array',
        items: {
          type: 'object',
          required: ['field', 'message'],
          properties: {
            field: {
              type: 'string',
              example: 'name',
            },
            message: {
              type: 'string',
              example: 'Community name must be at least 2 characters long',
            },
          },
        },
        example: [
          {
            field: 'name',
            message: 'Community name must be at least 2 characters long',
          },
          {
            field: 'email',
            message: 'Invalid email format',
          },
        ],
      },
    },
  },

  NotFoundError: {
    type: 'object',
    required: ['error', 'statusCode'],
    properties: {
      error: {
        type: 'string',
        example: 'Community with ID 999 not found',
      },
      statusCode: {
        type: 'integer',
        example: 404,
      },
    },
  },

  UnauthorizedError: {
    type: 'object',
    required: ['error', 'statusCode'],
    properties: {
      error: {
        type: 'string',
        example: 'Authentication token required',
      },
      statusCode: {
        type: 'integer',
        example: 401,
      },
    },
  },

  ForbiddenError: {
    type: 'object',
    required: ['error', 'statusCode'],
    properties: {
      error: {
        type: 'string',
        example: 'Super admins cannot access community cultural data',
      },
      statusCode: {
        type: 'integer',
        example: 403,
      },
    },
  },

  ConflictError: {
    type: 'object',
    required: ['error', 'statusCode'],
    properties: {
      error: {
        type: 'string',
        example: 'Community slug "secwepemc-nation" already exists',
      },
      statusCode: {
        type: 'integer',
        example: 409,
      },
    },
  },

  InternalServerError: {
    type: 'object',
    required: ['error', 'statusCode'],
    properties: {
      error: {
        type: 'string',
        example: 'Internal server error occurred while processing request',
      },
      statusCode: {
        type: 'integer',
        example: 500,
      },
      details: {
        type: 'array',
        items: {
          type: 'string',
        },
        example: ['Database connection failed', 'Please try again later'],
      },
    },
  },
};

// Query Parameters
export const superAdminParameters = {
  // Pagination
  page: {
    name: 'page',
    in: 'query',
    required: false,
    schema: {
      type: 'string',
      pattern: '^\\d+$',
      default: '1',
    },
    description: 'Page number for pagination (starts at 1)',
    example: '1',
  },

  limit: {
    name: 'limit',
    in: 'query',
    required: false,
    schema: {
      type: 'string',
      pattern: '^\\d+$',
      default: '20',
    },
    description: 'Number of items per page (1-100)',
    example: '20',
  },

  // Community filters
  communitySearch: {
    name: 'search',
    in: 'query',
    required: false,
    schema: {
      type: 'string',
      maxLength: 100,
    },
    description: 'Search within community names and descriptions',
    example: 'Secwepemc',
  },

  communityLocale: {
    name: 'locale',
    in: 'query',
    required: false,
    schema: {
      type: 'string',
      pattern: '^[a-z]{2,3}(-[A-Z]{2})?$',
    },
    description:
      'Filter communities by their primary language (e.g., shs, mic, en)',
    example: 'shs',
  },

  communityActive: {
    name: 'active',
    in: 'query',
    required: false,
    schema: {
      type: 'string',
      enum: ['true', 'false'],
    },
    description:
      'Filter by active status - "true" for active, "false" for inactive communities',
    example: 'true',
  },

  // User filters
  userCommunity: {
    name: 'community',
    in: 'query',
    required: false,
    schema: {
      type: 'string',
      pattern: '^\\d+$',
    },
    description:
      'Filter users by community ID (passed as string, converted to number)',
    example: '1',
  },

  userRole: {
    name: 'role',
    in: 'query',
    required: false,
    schema: {
      type: 'string',
      enum: ['super_admin', 'admin', 'editor', 'viewer'],
    },
    description: 'Filter by user role level',
    example: 'admin',
  },

  userSearch: {
    name: 'search',
    in: 'query',
    required: false,
    schema: {
      type: 'string',
      maxLength: 100,
    },
    description: 'Search within user names and email addresses',
    example: 'marie',
  },

  userActive: {
    name: 'active',
    in: 'query',
    required: false,
    schema: {
      type: 'string',
      enum: ['true', 'false'],
    },
    description:
      'Filter by active status - "true" for active, "false" for inactive users',
    example: 'true',
  },

  // Path parameters
  communityId: {
    name: 'id',
    in: 'path',
    required: true,
    schema: {
      type: 'string',
      pattern: '^\\d+$',
    },
    description: 'Community ID (positive integer)',
    example: '1',
  },

  userId: {
    name: 'id',
    in: 'path',
    required: true,
    schema: {
      type: 'string',
      pattern: '^\\d+$',
    },
    description: 'User ID (positive integer)',
    example: '1',
  },
};

// OpenAPI Examples with cultural sensitivity
export const superAdminExamples = {
  communities: {
    secwepemc: {
      summary: 'Secwépemc Nation Community',
      description: 'Traditional territory of the Secwépemc people',
      value: {
        id: 1,
        name: 'Secwépemc Nation',
        description:
          'Traditional territory of the Secwépemc people in the Interior of British Columbia, Canada.',
        slug: 'secwepemc-nation',
        locale: 'shs',
        publicStories: false,
        isActive: true,
        userCount: 23,
        createdAt: '2024-01-15T08:30:00.000Z',
        updatedAt: '2024-01-15T08:30:00.000Z',
      },
    },
    mikmaq: {
      summary: "Mi'kmaq First Nation Community",
      description: "Traditional territory of the Mi'kmaq people",
      value: {
        id: 2,
        name: "Mi'kmaq First Nation",
        description:
          "Traditional territory of the Mi'kmaq people in the Maritime provinces.",
        slug: 'mikmaq-first-nation',
        locale: 'mic',
        publicStories: true,
        isActive: true,
        userCount: 15,
        createdAt: '2024-01-20T10:15:00.000Z',
        updatedAt: '2024-01-20T10:15:00.000Z',
      },
    },
  },

  users: {
    admin: {
      summary: 'Community Administrator',
      description: 'Administrator for Secwépemc Nation',
      value: {
        id: 1,
        email: 'marie.paul@secwepemc.ca',
        firstName: 'Marie',
        lastName: 'Paul',
        role: 'admin',
        communityId: 1,
        communityName: 'Secwépemc Nation',
        isActive: true,
        createdAt: '2024-01-15T09:15:00.000Z',
        updatedAt: '2024-01-20T14:22:00.000Z',
        lastLoginAt: '2024-01-25T16:45:00.000Z',
      },
    },
    editor: {
      summary: 'Story Editor',
      description: 'Editor for community stories and content',
      value: {
        id: 2,
        email: 'james.crow@secwepemc.ca',
        firstName: 'James',
        lastName: 'Crow',
        role: 'editor',
        communityId: 1,
        communityName: 'Secwépemc Nation',
        isActive: true,
        createdAt: '2024-01-16T11:30:00.000Z',
        updatedAt: '2024-01-18T09:12:00.000Z',
        lastLoginAt: '2024-01-24T13:20:00.000Z',
      },
    },
  },
};
