/**
 * Super Admin Validation Schemas
 *
 * Comprehensive Zod validation schemas for super admin operations
 * with proper role-based access control and data sovereignty protection.
 */

import { z } from 'zod';

/**
 * Pagination query schema
 */
export const paginationQuerySchema = z.object({
  page: z
    .string()
    .default('1')
    .refine((val) => /^\d+$/.test(val), 'Page must be a positive integer')
    .transform((val) => parseInt(val, 10))
    .refine((val) => val >= 1, 'Page must be at least 1'),
  
  limit: z
    .string()
    .default('20')
    .refine((val) => /^\d+$/.test(val), 'Limit must be a positive integer')
    .transform((val) => parseInt(val, 10))
    .refine((val) => val >= 1 && val <= 100, 'Limit must be between 1 and 100'),
});

/**
 * Community Management Schemas
 */

// Query schema for listing communities
export const listCommunitiesQuerySchema = paginationQuerySchema.extend({
  search: z
    .string()
    .trim()
    .max(100, 'Search term too long')
    .optional()
    .describe('Search term for community name and description'),
  
  locale: z
    .string()
    .regex(/^[a-z]{2,3}(-[A-Z]{2})?$/, 'Invalid locale format')
    .optional()
    .describe('Filter by community locale'),
  
  active: z
    .string()
    .regex(/^(true|false)$/, 'Active must be true or false')
    .transform((val) => val === 'true')
    .optional()
    .describe('Filter by active status'),
});

// Schema for creating communities (super admin version)
export const createCommunitySchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, 'Community name must be at least 2 characters long')
    .max(100, 'Community name cannot exceed 100 characters')
    .regex(/^[^<>;"'&]*$/, 'Community name contains invalid characters'),
  
  description: z
    .string()
    .trim()
    .max(1000, 'Description cannot exceed 1000 characters')
    .optional()
    .or(z.literal('')),
  
  slug: z
    .string()
    .trim()
    .min(3, 'Slug must be at least 3 characters long')
    .max(50, 'Slug cannot exceed 50 characters')
    .regex(
      /^[a-z0-9-]+$/,
      'Slug can only contain lowercase letters, numbers, and hyphens'
    )
    .refine(
      (slug) => !slug.startsWith('-') && !slug.endsWith('-'),
      'Slug cannot start or end with hyphens'
    )
    .refine(
      (slug) => !slug.includes('--'),
      'Slug cannot contain consecutive hyphens'
    )
    .optional(),
  
  locale: z
    .string()
    .regex(
      /^[a-z]{2,3}(-[A-Z]{2})?$/,
      'Invalid locale format (use en, es, mic, en-US, etc.)'
    )
    .default('en'),
  
  publicStories: z
    .boolean()
    .default(false)
    .describe('Whether community stories are publicly accessible'),
  
  isActive: z
    .boolean()
    .default(true)
    .describe('Whether the community is active'),
}).strict();

// Schema for updating communities
export const updateCommunitySchema = createCommunitySchema
  .partial()
  .extend({
    // Prevent slug updates for data consistency
    slug: z.never().optional(),
  })
  .strict();

// Community ID parameter schema
export const communityIdParamSchema = z.object({
  id: z
    .string()
    .regex(/^\d+$/, 'Community ID must be a positive integer')
    .transform((val) => parseInt(val, 10))
    .refine((val) => val > 0, 'Community ID must be positive'),
});

/**
 * User Management Schemas
 */

// Query schema for listing users
export const listUsersQuerySchema = paginationQuerySchema.extend({
  community: z
    .string()
    .regex(/^\d+$/, 'Community ID must be a positive integer')
    .transform((val) => parseInt(val, 10))
    .refine((val) => val > 0, 'Community ID must be positive')
    .optional()
    .describe('Filter by community ID'),
  
  role: z
    .enum(['super_admin', 'admin', 'editor', 'viewer'])
    .optional()
    .describe('Filter by user role'),
  
  search: z
    .string()
    .trim()
    .max(100, 'Search term too long')
    .optional()
    .describe('Search term for user name and email'),
  
  active: z
    .string()
    .regex(/^(true|false)$/, 'Active must be true or false')
    .transform((val) => val === 'true')
    .optional()
    .describe('Filter by active status'),
});

// Schema for creating users (super admin version)
export const createUserSchema = z.object({
  email: z
    .string()
    .email('Invalid email format')
    .max(255, 'Email too long')
    .transform((email) => email.toLowerCase()),
  
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters long')
    .max(128, 'Password too long')
    .regex(
      /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]/,
      'Password must contain at least one uppercase letter, one lowercase letter, one number, and one special character'
    ),
  
  firstName: z
    .string()
    .trim()
    .min(1, 'First name is required')
    .max(50, 'First name too long')
    .regex(/^[^<>;"'&]*$/, 'First name contains invalid characters'),
  
  lastName: z
    .string()
    .trim()
    .min(1, 'Last name is required')
    .max(50, 'Last name too long')
    .regex(/^[^<>;"'&]*$/, 'Last name contains invalid characters'),
  
  role: z
    .enum(['super_admin', 'admin', 'editor', 'viewer'])
    .describe('User role in the community'),
  
  communityId: z
    .number()
    .int()
    .positive('Community ID must be positive')
    .describe('ID of the community the user belongs to'),
  
  isActive: z
    .boolean()
    .default(true)
    .describe('Whether the user account is active'),
}).strict();

// Schema for updating users
export const updateUserSchema = z.object({
  firstName: z
    .string()
    .trim()
    .min(1, 'First name is required')
    .max(50, 'First name too long')
    .regex(/^[^<>;"'&]*$/, 'First name contains invalid characters')
    .optional(),
  
  lastName: z
    .string()
    .trim()
    .min(1, 'Last name is required')
    .max(50, 'Last name too long')
    .regex(/^[^<>;"'&]*$/, 'Last name contains invalid characters')
    .optional(),
  
  role: z
    .enum(['super_admin', 'admin', 'editor', 'viewer'])
    .optional(),
  
  communityId: z
    .number()
    .int()
    .positive('Community ID must be positive')
    .optional(),
  
  isActive: z
    .boolean()
    .optional(),
  
  // Password updates handled separately for security
}).strict();

// User ID parameter schema
export const userIdParamSchema = z.object({
  id: z
    .string()
    .regex(/^\d+$/, 'User ID must be a positive integer')
    .transform((val) => parseInt(val, 10))
    .refine((val) => val > 0, 'User ID must be positive'),
});

/**
 * Response Schemas
 */

// Community response schema
export const communityResponseSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  description: z.string().nullable(),
  slug: z.string(),
  locale: z.string(),
  publicStories: z.boolean(),
  isActive: z.boolean(),
  userCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

// User response schema
export const userResponseSchema = z.object({
  id: z.number().int().positive(),
  email: z.string().email(),
  firstName: z.string(),
  lastName: z.string(),
  role: z.enum(['super_admin', 'admin', 'editor', 'viewer']),
  communityId: z.number().int().positive(),
  communityName: z.string(),
  isActive: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  lastLoginAt: z.string().datetime().nullable().optional(),
});

// Paginated response schemas
export const paginatedCommunitiesResponseSchema = z.object({
  data: z.array(communityResponseSchema),
  meta: z.object({
    page: z.number().int().positive(),
    limit: z.number().int().positive(),
    total: z.number().int().nonnegative(),
    totalPages: z.number().int().nonnegative(),
  }),
});

export const paginatedUsersResponseSchema = z.object({
  data: z.array(userResponseSchema),
  meta: z.object({
    page: z.number().int().positive(),
    limit: z.number().int().positive(),
    total: z.number().int().nonnegative(),
    totalPages: z.number().int().nonnegative(),
  }),
});

// Success response schemas
export const communityCreatedResponseSchema = z.object({
  data: communityResponseSchema,
  message: z.string().default('Community created successfully'),
});

export const communityUpdatedResponseSchema = z.object({
  data: communityResponseSchema,
  message: z.string().default('Community updated successfully'),
});

export const communityDeletedResponseSchema = z.object({
  data: z.object({
    message: z.string().default('Community archived successfully'),
    id: z.number().int().positive(),
  }),
});

export const userCreatedResponseSchema = z.object({
  data: userResponseSchema, // User response never includes password anyway
  message: z.string().default('User created successfully'),
});

export const userUpdatedResponseSchema = z.object({
  data: userResponseSchema,
  message: z.string().default('User updated successfully'),
});

export const userDeletedResponseSchema = z.object({
  data: z.object({
    message: z.string().default('User deactivated successfully'),
    id: z.number().int().positive(),
  }),
});

/**
 * Error Response Schemas
 */

export const errorResponseSchema = z.object({
  error: z.string(),
  statusCode: z.number().int(),
  details: z.array(z.string()).optional(),
});

export const validationErrorSchema = z.object({
  error: z.string().default('Validation failed'),
  statusCode: z.literal(400),
  issues: z.array(z.object({
    field: z.string(),
    message: z.string(),
  })).optional(),
});

export const notFoundErrorSchema = z.object({
  error: z.string(),
  statusCode: z.literal(404),
});

export const forbiddenErrorSchema = z.object({
  error: z.string().default('Insufficient permissions'),
  statusCode: z.literal(403),
});

export const unauthorizedErrorSchema = z.object({
  error: z.string().default('Authentication required'),
  statusCode: z.literal(401),
});

export const conflictErrorSchema = z.object({
  error: z.string(),
  statusCode: z.literal(409),
});

/**
 * TypeScript types derived from schemas
 */
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;
export type ListCommunitiesQuery = z.infer<typeof listCommunitiesQuerySchema>;
export type CreateCommunityRequest = z.infer<typeof createCommunitySchema>;
export type UpdateCommunityRequest = z.infer<typeof updateCommunitySchema>;
export type CommunityIdParam = z.infer<typeof communityIdParamSchema>;

export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;
export type CreateUserRequest = z.infer<typeof createUserSchema>;
export type UpdateUserRequest = z.infer<typeof updateUserSchema>;
export type UserIdParam = z.infer<typeof userIdParamSchema>;

export type CommunityResponse = z.infer<typeof communityResponseSchema>;
export type UserResponse = z.infer<typeof userResponseSchema>;
export type PaginatedCommunitiesResponse = z.infer<typeof paginatedCommunitiesResponseSchema>;
export type PaginatedUsersResponse = z.infer<typeof paginatedUsersResponseSchema>;

/**
 * Validation helper functions
 */
export const validateCommunityId = (id: unknown): number => {
  const result = communityIdParamSchema.shape.id.safeParse(id);
  if (!result.success) {
    throw new Error('Invalid community ID');
  }
  return result.data;
};

export const validateUserId = (id: unknown): number => {
  const result = userIdParamSchema.shape.id.safeParse(id);
  if (!result.success) {
    throw new Error('Invalid user ID');
  }
  return result.data;
};