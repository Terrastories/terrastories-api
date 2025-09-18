/**
 * Community Validation Schemas
 *
 * Comprehensive Zod validation schemas for community operations with
 * Indigenous cultural protocol support and data sovereignty validation.
 */

import { z } from 'zod';

/**
 * Cultural protocols schema for Indigenous communities
 */
export const culturalProtocolsSchema = z.object({
  languagePreferences: z
    .array(
      z
        .string()
        .regex(/^[a-z]{2,3}(-[A-Z]{2})?$/, 'Invalid language code format')
    )
    .min(1, 'At least one language preference is required')
    .max(10, 'Too many language preferences'),

  elderContentRestrictions: z
    .boolean({
      message: 'Elder content restrictions setting is required',
    })
    .describe('Whether content requires elder approval for access'),

  ceremonialContent: z
    .boolean({
      message: 'Ceremonial content setting is required',
    })
    .describe('Whether community handles ceremonial or sacred content'),

  traditionalKnowledge: z
    .boolean({
      message: 'Traditional knowledge setting is required',
    })
    .describe('Whether community manages traditional Indigenous knowledge'),

  communityApprovalRequired: z
    .boolean({
      message: 'Community approval setting is required',
    })
    .describe('Whether community approval is required for content changes'),

  dataRetentionPolicy: z
    .enum(
      [
        'indefinite',
        'community-controlled',
        'time-limited-5years',
        'time-limited-10years',
        'delete-on-request',
      ],
      {
        message: 'Data retention policy is required',
      }
    )
    .describe('Data retention and deletion policy'),

  accessRestrictions: z
    .array(
      z.enum([
        'public',
        'community-members-only',
        'elder-approval-required',
        'ceremonial-restricted',
        'family-lineage-only',
        'gender-specific',
        'seasonal-restrictions',
        'location-restricted',
      ])
    )
    .max(8, 'Too many access restrictions')
    .describe('Array of access restriction types'),

  culturalNotes: z
    .string()
    .max(2000, 'Cultural notes too long')
    .optional()
    .describe('Additional cultural context and guidance'),
});

/**
 * Base community validation schema
 */
export const baseCommunitySchema = z.object({
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

  publicStories: z
    .boolean()
    .default(false)
    .describe('Whether community stories are publicly accessible'),

  locale: z
    .string()
    .regex(
      /^[a-z]{2,3}(-[A-Z]{2})?$/,
      'Invalid locale format (use en, es, mic, en-US, etc.)'
    )
    .default('en')
    .describe('Primary language/locale for the community'),

  culturalSettings: z
    .union([
      culturalProtocolsSchema,
      z.string().refine((str) => {
        try {
          const parsed = JSON.parse(str);
          culturalProtocolsSchema.parse(parsed);
          return true;
        } catch {
          return false;
        }
      }, 'Invalid cultural settings JSON format'),
    ])
    .optional()
    .describe('Cultural protocols and settings as object or JSON string'),

  isActive: z
    .boolean()
    .default(true)
    .describe('Whether the community is active'),

  // Rails compatibility fields
  country: z
    .string()
    .length(2, 'Country code must be 2 characters')
    .regex(
      /^[A-Z]{2}$/,
      'Country code must be uppercase letters (ISO 3166-1 alpha-2)'
    )
    .optional()
    .describe('ISO 3166-1 alpha-2 country code (e.g., US, CA, MX)'),

  beta: z
    .boolean()
    .default(false)
    .describe('Whether the community is in beta/testing mode'),
});

/**
 * Community creation schema
 */
export const createCommunitySchema = baseCommunitySchema
  .extend({
    name: baseCommunitySchema.shape.name,
    description: baseCommunitySchema.shape.description,
    slug: baseCommunitySchema.shape.slug,
    publicStories: baseCommunitySchema.shape.publicStories,
    locale: baseCommunitySchema.shape.locale,
    culturalSettings: baseCommunitySchema.shape.culturalSettings,
    isActive: baseCommunitySchema.shape.isActive,
    // Rails compatibility fields
    country: baseCommunitySchema.shape.country,
    beta: baseCommunitySchema.shape.beta,
  })
  .strict();

/**
 * Community update schema (all fields optional)
 */
export const updateCommunitySchema = baseCommunitySchema
  .partial()
  .extend({
    // Prevent slug updates for data consistency
    slug: z.never().optional(),
  })
  .strict();

/**
 * Community ID parameter schema
 */
export const communityIdParamSchema = z.object({
  id: z
    .string()
    .regex(/^\d+$/, 'Community ID must be a positive integer')
    .transform((val) => parseInt(val, 10))
    .refine((val) => val > 0, 'Community ID must be positive'),
});

/**
 * Community slug parameter schema
 */
export const communitySlugParamSchema = z.object({
  slug: z
    .string()
    .trim()
    .min(3, 'Slug must be at least 3 characters long')
    .max(50, 'Slug cannot exceed 50 characters')
    .regex(/^[a-z0-9-]+$/, 'Invalid slug format')
    .refine(
      (slug) => !slug.startsWith('-') && !slug.endsWith('-'),
      'Slug cannot start or end with hyphens'
    ),
});

/**
 * Community search query schema
 */
export const communitySearchSchema = z
  .object({
    query: z
      .string()
      .trim()
      .max(100, 'Search query too long')
      .optional()
      .describe('Search term for community name and description'),

    locale: z
      .string()
      .regex(/^[a-z]{2,3}(-[A-Z]{2})?$/, 'Invalid locale format')
      .optional()
      .describe('Filter by community locale'),

    isActive: z
      .string()
      .regex(/^(true|false)$/, 'isActive must be true or false')
      .transform((val) => val === 'true')
      .optional()
      .describe('Filter by active status'),

    limit: z
      .string()
      .regex(/^\d+$/, 'Limit must be a positive integer')
      .transform((val) => parseInt(val, 10))
      .refine(
        (val) => val >= 1 && val <= 100,
        'Limit must be between 1 and 100'
      )
      .default(20)
      .describe('Maximum number of results'),

    offset: z
      .string()
      .regex(/^\d+$/, 'Offset must be a non-negative integer')
      .transform((val) => parseInt(val, 10))
      .refine((val) => val >= 0, 'Offset must be non-negative')
      .default(0)
      .describe('Number of results to skip'),

    // Rails compatibility filters
    country: z
      .string()
      .length(2, 'Country code must be 2 characters')
      .regex(/^[A-Z]{2}$/, 'Country code must be uppercase letters')
      .optional()
      .describe('Filter by country code'),

    beta: z
      .string()
      .regex(/^(true|false)$/, 'beta must be true or false')
      .transform((val) => val === 'true')
      .optional()
      .describe('Filter by beta status'),
  })
  .strict();

/**
 * Slug availability check schema
 */
export const slugAvailabilitySchema = z
  .object({
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
      ),

    excludeId: z
      .string()
      .regex(/^\d+$/, 'Exclude ID must be a positive integer')
      .transform((val) => parseInt(val, 10))
      .refine((val) => val > 0, 'Exclude ID must be positive')
      .optional(),
  })
  .strict();

/**
 * Cultural protocols update schema
 */
export const updateCulturalProtocolsSchema = z
  .object({
    culturalSettings: culturalProtocolsSchema,
  })
  .strict();

/**
 * Community response schema for API documentation
 */
export const communityResponseSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  description: z.string().nullable(),
  slug: z.string(),
  publicStories: z.boolean(),
  locale: z.string(),
  culturalSettings: z.string().nullable(),
  isActive: z.boolean(),
  // Rails compatibility fields - commented out until database migration is complete
  // country: z.string().nullable(),
  // beta: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),

  // Optional enhanced fields
  memberCount: z.number().int().nonnegative().optional(),
  storyCount: z.number().int().nonnegative().optional(),
  lastActivityDate: z.string().datetime().optional(),
  culturalProtocols: culturalProtocolsSchema.optional(),
});

/**
 * Community search response schema
 */
export const communitySearchResponseSchema = z.object({
  communities: z.array(communityResponseSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  hasMore: z.boolean(),
});

/**
 * Success response schemas
 */
export const communityCreatedResponseSchema = z.object({
  data: communityResponseSchema,
  message: z.string().default('Community created successfully'),
});

export const communityUpdatedResponseSchema = z.object({
  data: communityResponseSchema,
  message: z.string().default('Community updated successfully'),
});

export const communityDeletedResponseSchema = z.object({
  message: z.string().default('Community deleted successfully'),
});

export const slugAvailabilityResponseSchema = z.object({
  available: z.boolean(),
  slug: z.string(),
});

/**
 * Error response schemas
 */
export const communityErrorResponseSchema = z.object({
  error: z.string(),
  statusCode: z.number().int(),
  details: z.array(z.string()).optional(),
});

export const communityValidationErrorSchema = z.object({
  error: z.string(),
  statusCode: z.literal(400),
  field: z.string().optional(),
  details: z.array(z.string()).optional(),
});

export const communityNotFoundErrorSchema = z.object({
  error: z.string().default('Community not found'),
  statusCode: z.literal(404),
});

export const communityAccessErrorSchema = z.object({
  error: z.string().default('Access denied to community'),
  statusCode: z.literal(403),
});

/**
 * TypeScript types derived from schemas
 */
export type CulturalProtocols = z.infer<typeof culturalProtocolsSchema>;
export type CreateCommunityRequest = z.infer<typeof createCommunitySchema>;
export type UpdateCommunityRequest = z.infer<typeof updateCommunitySchema>;
export type CommunityIdParam = z.infer<typeof communityIdParamSchema>;
export type CommunitySlugParam = z.infer<typeof communitySlugParamSchema>;
export type CommunitySearchQuery = z.infer<typeof communitySearchSchema>;
export type SlugAvailabilityQuery = z.infer<typeof slugAvailabilitySchema>;
export type CommunityResponse = z.infer<typeof communityResponseSchema>;
export type CommunitySearchResponse = z.infer<
  typeof communitySearchResponseSchema
>;

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

export const validateCommunitySlug = (slug: unknown): string => {
  const result = communitySlugParamSchema.shape.slug.safeParse(slug);
  if (!result.success) {
    throw new Error('Invalid community slug');
  }
  return result.data;
};

export const validateCulturalProtocols = (
  protocols: unknown
): CulturalProtocols => {
  const result = culturalProtocolsSchema.safeParse(protocols);
  if (!result.success) {
    throw new Error(`Invalid cultural protocols: ${result.error.message}`);
  }
  return result.data;
};
