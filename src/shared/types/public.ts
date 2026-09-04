/**
 * Public API DTOs
 *
 * Data Transfer Objects for public API endpoints to prevent internal field leakage.
 * Only exposes safe, public-facing fields while filtering out sensitive data.
 */

import { z } from 'zod';
import {
  projectVisibleFields,
  type FieldVisibilityRule,
} from '../authorization/sovereignty-policy.js';

// Input validation schemas for public API
export const CommunityIdParamSchema = z.object({
  community_id: z.string().refine(
    (val) => {
      const parsed = parseInt(val, 10);
      return !isNaN(parsed) && parsed >= 1;
    },
    { message: 'Invalid community ID' }
  ),
});

export const StoryIdParamSchema = CommunityIdParamSchema.extend({
  id: z.string().refine(
    (val) => {
      const parsed = parseInt(val, 10);
      return !isNaN(parsed) && parsed >= 1;
    },
    { message: 'Invalid story ID' }
  ),
});

export const PlaceIdParamSchema = CommunityIdParamSchema.extend({
  id: z.string().refine(
    (val) => {
      const parsed = parseInt(val, 10);
      return !isNaN(parsed) && parsed >= 1;
    },
    { message: 'Invalid place ID' }
  ),
});

export const PaginationQuerySchema = z.object({
  page: z
    .string()
    .optional()
    .default('1')
    .refine(
      (val) => {
        const parsed = parseInt(val, 10);
        return !isNaN(parsed) && parsed >= 1;
      },
      { message: 'Page must be a positive number' }
    ),
  limit: z
    .string()
    .optional()
    .default('20')
    .refine(
      (val) => {
        const parsed = parseInt(val, 10);
        return !isNaN(parsed) && parsed >= 1 && parsed <= 100;
      },
      { message: 'Limit must be between 1 and 100' }
    ),
});

/**
 * Public Story DTO - Safe fields only for public consumption
 * Excludes: createdBy, communityId, isRestricted, and other internal fields
 */
export const PublicStorySchema = z.object({
  id: z.number(),
  title: z.string(),
  description: z.string().optional(),
  slug: z.string(),
  mediaUrls: z.array(z.string()).default([]),
  language: z.string().default('en'),
  tags: z.array(z.string()).default([]),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type PublicStory = z.infer<typeof PublicStorySchema>;

export interface PublicStoryProjectionContext {
  resourceCommunityId: number;
  explicitlyPublic: boolean;
}

const PUBLIC_STORY_FIELD_RULES = {
  id: { category: 'public' },
  title: { category: 'public' },
  description: { category: 'public' },
  slug: { category: 'public' },
  mediaUrls: { category: 'public' },
  language: { category: 'public' },
  tags: { category: 'public' },
  createdAt: { category: 'public' },
  updatedAt: { category: 'public' },
  communityId: { category: 'community-only' },
  createdBy: { category: 'never-exposed' },
  privacyLevel: { category: 'never-exposed' },
  isRestricted: { category: 'never-exposed' },
  culturalProtocols: { category: 'never-exposed' },
} as const satisfies Record<string, FieldVisibilityRule>;

/**
 * Public Place DTO - Safe fields only for public consumption
 * Excludes: createdBy, communityId, and other internal fields
 * Includes minimal geographic data needed for public mapping
 */
export const PublicPlaceSchema = z.object({
  id: z.number(),
  name: z.string(),
  description: z.string().optional(),
  latitude: z.number(),
  longitude: z.number(),
  region: z.string().optional(),
  type: z.string().optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type PublicPlace = z.infer<typeof PublicPlaceSchema>;

interface PublicStorySource {
  id: unknown;
  title?: unknown;
  description?: unknown;
  slug?: unknown;
  mediaUrls?: unknown;
  language?: unknown;
  tags?: unknown;
  createdAt: unknown;
  updatedAt: unknown;
  communityId: unknown;
  createdBy?: unknown;
  privacyLevel?: unknown;
  isRestricted?: unknown;
  culturalProtocols?: unknown;
}

function coercePublicDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    return new Date(value);
  }
  return new Date(Number.NaN);
}

/**
 * Transform internal story model to public DTO
 * Filters out sensitive fields and ensures only safe data is exposed
 */
export function toPublicStory(
  story: PublicStorySource,
  context: PublicStoryProjectionContext
): PublicStory | null {
  if (Number(story.communityId) !== context.resourceCommunityId) {
    return null;
  }

  const candidate = {
    id: Number(story.id),
    title: String(story.title || ''),
    description: story.description ? String(story.description) : undefined,
    slug: String(story.slug || ''),
    mediaUrls: Array.isArray(story.mediaUrls) ? story.mediaUrls : [],
    language: String(story.language || 'en'),
    tags: Array.isArray(story.tags) ? story.tags : [],
    createdAt: coercePublicDate(story.createdAt),
    updatedAt: coercePublicDate(story.updatedAt),
    communityId: Number(story.communityId),
    createdBy: story.createdBy,
    privacyLevel: story.privacyLevel,
    isRestricted: story.isRestricted,
    culturalProtocols: story.culturalProtocols,
  };

  const projected = projectVisibleFields(candidate, PUBLIC_STORY_FIELD_RULES, {
    actor: null,
    actorCommunityId: null,
    resourceCommunityId: context.resourceCommunityId,
    explicitlyPublic: context.explicitlyPublic,
  });
  const parsed = PublicStorySchema.safeParse(projected);
  return parsed.success ? parsed.data : null;
}

/**
 * Transform internal place model to public DTO
 * Filters out sensitive fields and ensures only safe geographic data is exposed
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toPublicPlace(place: any): PublicPlace {
  return {
    id: Number(place.id),
    name: String(place.name || ''),
    description: place.description ? String(place.description) : undefined,
    latitude: Number(place.latitude || 0),
    longitude: Number(place.longitude || 0),
    region: place.region ? String(place.region) : undefined,
    type: place.type ? String(place.type) : undefined,
    createdAt:
      place.createdAt instanceof Date
        ? place.createdAt
        : new Date(place.createdAt),
    updatedAt:
      place.updatedAt instanceof Date
        ? place.updatedAt
        : new Date(place.updatedAt),
  };
}

/**
 * API Response wrapper for public endpoints
 * Provides consistent response structure across all public APIs
 */
export interface PublicApiResponse<T> {
  data: T;
  meta?: {
    pagination?: {
      page: number;
      limit: number;
      total: number;
      totalPages: number;
      hasNextPage: boolean;
      hasPrevPage: boolean;
    };
  };
}

/**
 * API Error response structure
 */
export interface PublicApiError {
  error: string;
  code?: string;
  details?: Record<string, unknown>;
}
