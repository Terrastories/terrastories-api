/**
 * Story Validation Schemas
 *
 * Comprehensive Zod validation schemas for story operations including:
 * - Story creation and updates with cultural protocols
 * - Search and filtering parameters
 * - Association management validation
 * - Cultural protocol enforcement schemas
 */

import { z } from 'zod';
import {
  createStorySchema,
  updateStorySchema,
} from '../../db/schema/stories.js';

// Re-export the story schemas for use in routes
export { createStorySchema, updateStorySchema };

// Cultural protocols validation schema
export const CulturalProtocolsSchema = z
  .object({
    permissionLevel: z.enum([
      'public',
      'community',
      'restricted',
      'elder_only',
    ]),
    culturalSignificance: z.string().max(1000).optional(),
    restrictions: z.array(z.string().max(200)).optional(),
    ceremonialContent: z.boolean().optional(),
    elderApprovalRequired: z.boolean().optional(),
    accessNotes: z.string().max(500).optional(),
  })
  .strict();

// GeoJSON Point validation schema for geographic filtering
export const GeoJSONPointSchema = z
  .object({
    type: z.literal('Point'),
    coordinates: z.tuple([
      z.number().min(-180).max(180), // longitude
      z.number().min(-90).max(90), // latitude
    ]),
  })
  .strict();

// Base story creation schema extending database schema
export const StoryCreateInputSchema = createStorySchema
  .extend({
    placeIds: z.array(z.number().int().positive()).optional(),
    speakerIds: z.array(z.number().int().positive()).optional(),
    culturalProtocols: CulturalProtocolsSchema.optional(),
    dateInterviewed: z.coerce.date().optional(),
    interviewer: z.string().max(200).optional(),
  })
  .strict();

// Story update schema
export const StoryUpdateInputSchema = StoryCreateInputSchema.partial()
  .omit({
    communityId: true, // Cannot change community
    createdBy: true, // Cannot change creator
  })
  .strict();

// Story filters schema for search and listing
export const StoryFiltersSchema = z
  .object({
    search: z.string().max(200).optional(),
    isRestricted: z.boolean().optional(),
    tags: z.array(z.string().min(1).max(50)).max(10).optional(),
    createdBy: z.number().int().positive().optional(),
    language: z.string().length(2).optional(),
    nearPoint: GeoJSONPointSchema.optional(),
    radiusKm: z.number().positive().max(1000).optional(), // Max 1000km radius
    dateFrom: z.coerce.date().optional(),
    dateTo: z.coerce.date().optional(),
  })
  .strict()
  .refine(
    (data) => {
      // If nearPoint is provided, radiusKm must also be provided
      if (data.nearPoint && !data.radiusKm) {
        return false;
      }
      // If radiusKm is provided, nearPoint must also be provided
      if (data.radiusKm && !data.nearPoint) {
        return false;
      }
      return true;
    },
    {
      message:
        'nearPoint and radiusKm must be provided together for geographic filtering',
    }
  )
  .refine(
    (data) => {
      // dateFrom must be before dateTo if both are provided
      if (data.dateFrom && data.dateTo && data.dateFrom > data.dateTo) {
        return false;
      }
      return true;
    },
    {
      message: 'dateFrom must be before dateTo',
    }
  );

// Pagination schema
export const PaginationSchema = z
  .object({
    page: z.number().int().positive().default(1),
    limit: z.number().int().positive().min(1).max(100).default(20),
    sortBy: z.enum(['createdAt', 'title', 'updatedAt']).default('createdAt'),
    sortOrder: z.enum(['asc', 'desc']).default('desc'),
  })
  .strict();

// Story ID parameter schema
export const StoryIdParamSchema = z
  .object({
    id: z.coerce.number().int().positive(),
  })
  .strict();

// Story slug parameter schema
export const StorySlugParamSchema = z
  .object({
    slug: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9-]+$/),
  })
  .strict();

// Community ID parameter schema
export const CommunityIdParamSchema = z
  .object({
    communityId: z.coerce.number().int().positive(),
  })
  .strict();

// Search query schema
export const SearchQuerySchema = z
  .object({
    q: z.string().min(1).max(200),
  })
  .merge(StoryFiltersSchema.omit({ search: true }))
  .strict();

// Bulk operation schemas
export const BulkUpdateSchema = z
  .object({
    storyIds: z.array(z.number().int().positive()).min(1).max(50),
    updates: StoryUpdateInputSchema,
  })
  .strict();

export const BulkDeleteSchema = z
  .object({
    storyIds: z.array(z.number().int().positive()).min(1).max(50),
  })
  .strict();

// Association management schemas
export const StoryPlaceAssociationSchema = z
  .object({
    placeId: z.number().int().positive(),
    culturalContext: z.string().max(500).optional(),
    storyRelationship: z.string().max(300).optional(),
    sortOrder: z.number().int().nonnegative().optional(),
  })
  .strict();

export const StoryPlaceAssociationsSchema = z
  .object({
    associations: z.array(StoryPlaceAssociationSchema).max(20),
  })
  .strict();

export const StorySpeakerAssociationSchema = z
  .object({
    speakerId: z.number().int().positive(),
    culturalRole: z.string().max(200).optional(),
    storyRole: z
      .enum(['narrator', 'subject', 'witness', 'elder_keeper'])
      .default('narrator'),
    sortOrder: z.number().int().nonnegative().optional(),
  })
  .strict();

export const StorySpeakerAssociationsSchema = z
  .object({
    associations: z.array(StorySpeakerAssociationSchema).max(10),
  })
  .strict();

// Response schemas
export const StoryResponseSchema = z
  .object({
    id: z.number().int().positive(),
    title: z.string(),
    description: z.string().nullable(),
    slug: z.string(),
    communityId: z.number().int().positive(),
    createdBy: z.number().int().positive(),
    mediaUrls: z.array(z.string().url()),
    language: z.string(),
    tags: z.array(z.string()),
    isRestricted: z.boolean(),
    createdAt: z.date(),
    updatedAt: z.date(),
    culturalProtocols: CulturalProtocolsSchema.optional(),
  })
  .strict();

export const StoryWithRelationsResponseSchema = StoryResponseSchema.extend({
  places: z.array(
    z.object({
      id: z.number().int().positive(),
      name: z.string(),
      description: z.string().optional(),
      latitude: z.number(),
      longitude: z.number(),
      region: z.string().optional(),
      culturalSignificance: z.string().optional(),
      culturalContext: z.string().optional(),
      storyRelationship: z.string().optional(),
      sortOrder: z.number().optional(),
    })
  ),
  speakers: z.array(
    z.object({
      id: z.number().int().positive(),
      name: z.string(),
      bio: z.string().optional(),
      photoUrl: z
        .string()
        .transform((val) => (val === '' ? undefined : val))
        .pipe(z.string().url().optional()),
      birthYear: z.number().int().optional(),
      elderStatus: z.boolean(),
      culturalRole: z.string().optional(),
      storyRole: z.string().optional(),
      sortOrder: z.number().optional(),
    })
  ),
  community: z.object({
    id: z.number().int().positive(),
    name: z.string(),
    description: z.string().optional(),
    slug: z.string(),
    locale: z.string(),
  }),
  author: z.object({
    id: z.number().int().positive(),
    firstName: z.string(),
    lastName: z.string(),
    role: z.string(),
  }),
}).strict();

export const PaginatedStoriesResponseSchema = z
  .object({
    data: z.array(StoryWithRelationsResponseSchema),
    total: z.number().int().nonnegative(),
    page: z.number().int().positive(),
    limit: z.number().int().positive(),
    totalPages: z.number().int().nonnegative(),
  })
  .strict();

// Error response schemas
export const ValidationErrorSchema = z
  .object({
    error: z.literal('validation_error'),
    message: z.string(),
    details: z.array(
      z.object({
        path: z.array(z.union([z.string(), z.number()])),
        message: z.string(),
      })
    ),
  })
  .strict();

export const NotFoundErrorSchema = z
  .object({
    error: z.literal('not_found'),
    message: z.string(),
  })
  .strict();

export const CulturalProtocolErrorSchema = z
  .object({
    error: z.literal('cultural_protocol_violation'),
    message: z.string(),
    culturalGuidance: z.string().optional(),
  })
  .strict();

export const DataSovereigntyErrorSchema = z
  .object({
    error: z.literal('data_sovereignty_violation'),
    message: z.string(),
  })
  .strict();

export const InsufficientPermissionsErrorSchema = z
  .object({
    error: z.literal('insufficient_permissions'),
    message: z.string(),
    requiredRole: z.string().optional(),
  })
  .strict();

// Success response schemas
export const CreateStorySuccessSchema = z
  .object({
    success: z.literal(true),
    data: StoryWithRelationsResponseSchema,
    message: z.string(),
  })
  .strict();

export const UpdateStorySuccessSchema = z
  .object({
    success: z.literal(true),
    data: StoryWithRelationsResponseSchema,
    message: z.string(),
  })
  .strict();

export const DeleteStorySuccessSchema = z
  .object({
    success: z.literal(true),
    message: z.string(),
  })
  .strict();

export const ListStoriesSuccessSchema = z
  .object({
    success: z.literal(true),
    data: PaginatedStoriesResponseSchema,
  })
  .strict();

// Query validation helpers
export const validateStoryFilters = (filters: unknown) => {
  return StoryFiltersSchema.parse(filters);
};

export const validatePagination = (pagination: unknown) => {
  return PaginationSchema.parse(pagination);
};

export const validateStoryCreate = (input: unknown) => {
  return StoryCreateInputSchema.parse(input);
};

export const validateStoryUpdate = (input: unknown) => {
  return StoryUpdateInputSchema.parse(input);
};

export const validateSearchQuery = (query: unknown) => {
  return SearchQuerySchema.parse(query);
};

// Cultural protocol validation helpers
export const validateCulturalProtocols = (protocols: unknown) => {
  return CulturalProtocolsSchema.parse(protocols);
};

export const validateGeographicFilter = (filter: {
  nearPoint?: unknown;
  radiusKm?: unknown;
}) => {
  if (filter.nearPoint || filter.radiusKm) {
    return z
      .object({
        nearPoint: GeoJSONPointSchema,
        radiusKm: z.number().positive().max(1000),
      })
      .parse(filter);
  }
  return null;
};

// Type exports for TypeScript
export type StoryCreateInput = z.infer<typeof StoryCreateInputSchema>;
export type StoryUpdateInput = z.infer<typeof StoryUpdateInputSchema>;
export type StoryFilters = z.infer<typeof StoryFiltersSchema>;
export type Pagination = z.infer<typeof PaginationSchema>;
export type CulturalProtocols = z.infer<typeof CulturalProtocolsSchema>;
export type GeoJSONPoint = z.infer<typeof GeoJSONPointSchema>;
export type StoryResponse = z.infer<typeof StoryResponseSchema>;
export type StoryWithRelationsResponse = z.infer<
  typeof StoryWithRelationsResponseSchema
>;
export type PaginatedStoriesResponse = z.infer<
  typeof PaginatedStoriesResponseSchema
>;

// Route parameter types
export type StoryIdParam = z.infer<typeof StoryIdParamSchema>;
export type StorySlugParam = z.infer<typeof StorySlugParamSchema>;
export type CommunityIdParam = z.infer<typeof CommunityIdParamSchema>;
export type SearchQuery = z.infer<typeof SearchQuerySchema>;

// Association types
export type StoryPlaceAssociation = z.infer<typeof StoryPlaceAssociationSchema>;
export type StorySpeakerAssociation = z.infer<
  typeof StorySpeakerAssociationSchema
>;

// Bulk operation types
export type BulkUpdate = z.infer<typeof BulkUpdateSchema>;
export type BulkDelete = z.infer<typeof BulkDeleteSchema>;
