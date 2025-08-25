/**
 * Member API DTOs
 *
 * Data Transfer Objects for member dashboard endpoints to prevent internal field leakage.
 * Only exposes safe, member-facing fields while filtering out sensitive data.
 * Includes validation schemas for request parameters and response formatting.
 */

import { z } from 'zod';
import type { StoryWithRelations } from '../../repositories/story.repository.js';
import type { Place } from '../../repositories/place.repository.js';
import type { Speaker } from '../../repositories/speaker.repository.js';

// Request validation schemas
export const MemberPaginationQuerySchema = z.object({
  page: z
    .union([z.string(), z.number()])
    .optional()
    .default(1)
    .transform((val) => (typeof val === 'string' ? parseInt(val, 10) : val))
    .refine((val) => Number.isInteger(val) && val >= 1, {
      message: 'Page must be a positive integer',
    }),
  limit: z
    .union([z.string(), z.number()])
    .optional()
    .default(20)
    .transform((val) => (typeof val === 'string' ? parseInt(val, 10) : val))
    .refine((val) => Number.isInteger(val) && val >= 1 && val <= 100, {
      message: 'Limit must be between 1 and 100',
    }),
});

export const MemberIdParamSchema = z.object({
  id: z.number().int().positive(),
});

// Story schemas
export const CreateStorySchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().optional(),
  slug: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9-]+$/)
    .optional(),
  mediaUrls: z.array(z.string().url()).optional(),
  language: z.string().min(2).max(10).default('en'),
  tags: z.array(z.string()).optional(),
  placeIds: z.array(z.number().int().positive()).optional(),
  speakerIds: z.array(z.number().int().positive()).optional(),
  isRestricted: z.boolean().optional().default(false),
  points: z
    .array(
      z.object({
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
        timestamp: z.number().optional(),
      })
    )
    .optional(),
});

export const UpdateStorySchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().optional(),
  slug: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9-]+$/)
    .optional(),
  mediaUrls: z.array(z.string().url()).optional(),
  language: z.string().min(2).max(10).optional(),
  tags: z.array(z.string()).optional(),
  placeIds: z.array(z.number().int().positive()).optional(),
  speakerIds: z.array(z.number().int().positive()).optional(),
  isRestricted: z.boolean().optional(),
  points: z
    .array(
      z.object({
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
        timestamp: z.number().optional(),
      })
    )
    .optional(),
});

// Place schemas
export const CreatePlaceSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().optional(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  culturalSignificance: z
    .enum(['general', 'significant', 'sacred', 'restricted'])
    .default('general'),
  photoUrl: z.string().url().optional(),
  nameAudioUrl: z.string().url().optional(),
  region: z.string().max(100).optional(),
  isRestricted: z.boolean().optional().default(false),
});

export const UpdatePlaceSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  culturalSignificance: z
    .enum(['general', 'significant', 'sacred', 'restricted'])
    .optional(),
  photoUrl: z.string().url().optional(),
  nameAudioUrl: z.string().url().optional(),
  region: z.string().max(100).optional(),
  isRestricted: z.boolean().optional(),
});

export const PlaceSearchQuerySchema = MemberPaginationQuerySchema.extend({
  search: z.string().optional(),
  lat: z
    .string()
    .optional()
    .refine(
      (val) =>
        val === undefined ||
        (!isNaN(Number(val)) && Number(val) >= -90 && Number(val) <= 90),
      { message: 'Invalid latitude' }
    ),
  lng: z
    .string()
    .optional()
    .refine(
      (val) =>
        val === undefined ||
        (!isNaN(Number(val)) && Number(val) >= -180 && Number(val) <= 180),
      { message: 'Invalid longitude' }
    ),
  radius: z
    .string()
    .optional()
    .refine(
      (val) => val === undefined || (!isNaN(Number(val)) && Number(val) > 0),
      { message: 'Radius must be a positive number' }
    ),
});

// Speaker schemas
export const CreateSpeakerSchema = z.object({
  name: z.string().min(1).max(200),
  bio: z.string().optional(),
  birthYear: z
    .number()
    .int()
    .min(1850)
    .max(new Date().getFullYear())
    .optional(),
  photoUrl: z.string().url().optional(),
  culturalRole: z
    .enum([
      'storyteller',
      'elder',
      'historian',
      'cultural_keeper',
      'ceremonial_leader',
    ])
    .default('storyteller'),
  isElder: z.boolean().optional().default(false),
  isRestricted: z.boolean().optional().default(false),
});

export const UpdateSpeakerSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  bio: z.string().optional(),
  birthYear: z
    .number()
    .int()
    .min(1850)
    .max(new Date().getFullYear())
    .optional(),
  photoUrl: z.string().url().optional(),
  culturalRole: z
    .enum([
      'storyteller',
      'elder',
      'historian',
      'cultural_keeper',
      'ceremonial_leader',
    ])
    .optional(),
  isElder: z.boolean().optional(),
  isRestricted: z.boolean().optional(),
});

export const SpeakerSearchQuerySchema = MemberPaginationQuerySchema.extend({
  search: z.string().optional(),
  culturalRole: z
    .enum([
      'storyteller',
      'elder',
      'historian',
      'cultural_keeper',
      'ceremonial_leader',
    ])
    .optional(),
  isElder: z.boolean().optional(),
});

// Response DTOs - these prevent leaking internal fields
export function toMemberStory(story: StoryWithRelations, userRole?: string) {
  // Filter cultural content based on user role
  const isElder = userRole === 'elder';

  return {
    id: story.id,
    title: story.title,
    description: story.description,
    slug: story.slug,
    language: story.language,
    mediaUrls: story.mediaUrls,
    tags: story.tags,
    communityId: story.communityId,
    createdAt: story.createdAt,
    updatedAt: story.updatedAt,
    // Filter restricted fields based on user permissions
    isRestricted: isElder ? story.isRestricted : false,
    // Include associations with proper type conversion
    places: story.places?.map((place) => ({
      id: place.id,
      name: place.name,
      description: place.description,
      lat: place.latitude,
      lng: place.longitude,
      region: place.region,
      culturalSignificance: isElder
        ? place.culturalSignificance
        : place.culturalSignificance === 'sacred' ||
            place.culturalSignificance === 'restricted'
          ? 'general'
          : place.culturalSignificance,
      culturalContext: isElder ? place.culturalContext : undefined,
      storyRelationship: place.storyRelationship,
      sortOrder: place.sortOrder,
    })),
    speakers: story.speakers?.map((speaker) => ({
      id: speaker.id,
      name: speaker.name,
      bio: speaker.bio,
      photoUrl: speaker.photoUrl,
      birthYear: speaker.birthYear,
      culturalRole: isElder
        ? speaker.culturalRole
        : speaker.culturalRole === 'elder' ||
            speaker.culturalRole === 'ceremonial_leader'
          ? 'storyteller'
          : speaker.culturalRole,
      elderStatus: isElder ? speaker.elderStatus : false,
      storyRole: speaker.storyRole,
      sortOrder: speaker.sortOrder,
    })),
    // Don't leak internal fields: authorId, syncMetadata, internalNotes, etc.
  };
}

export function toMemberPlace(place: Place, userRole?: string) {
  const isElder = userRole === 'elder';

  return {
    id: place.id,
    name: place.name,
    description: place.description,
    lat: place.latitude,
    lng: place.longitude,
    region: place.region,
    mediaUrls: place.mediaUrls,
    communityId: place.communityId,
    createdAt: place.createdAt,
    updatedAt: place.updatedAt,
    // Filter cultural significance based on user role
    culturalSignificance: isElder
      ? place.culturalSignificance
      : place.culturalSignificance === 'sacred' ||
          place.culturalSignificance === 'restricted'
        ? 'general'
        : place.culturalSignificance,
    isRestricted: isElder ? place.isRestricted : false,
    // Don't leak internal fields: createdBy, gisData, etc.
  };
}

export function toMemberSpeaker(speaker: Speaker, userRole?: string) {
  const isElder = userRole === 'elder';

  return {
    id: speaker.id,
    name: speaker.name,
    bio: speaker.bio,
    birthYear: speaker.birthYear,
    photoUrl: speaker.photoUrl,
    communityId: speaker.communityId,
    createdAt: speaker.createdAt,
    updatedAt: speaker.updatedAt,
    // Filter cultural role and elder status based on user permissions
    culturalRole: isElder
      ? speaker.culturalRole
      : speaker.culturalRole === 'elder' ||
          speaker.culturalRole === 'ceremonial_leader'
        ? 'storyteller'
        : speaker.culturalRole,
    elderStatus: isElder ? speaker.elderStatus : false,
    isActive: speaker.isActive,
    // Don't leak internal fields: createdBy, auditLog, etc.
  };
}

// Pagination metadata
export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

// Response envelopes
export interface MemberListResponse<T> {
  data: T[];
  meta: PaginationMeta;
}

export interface MemberItemResponse<T> {
  data: T;
}

export interface MemberErrorResponse {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

// Helper to create pagination metadata
export function createPaginationMeta(
  page: number,
  limit: number,
  total: number
): PaginationMeta {
  const totalPages = Math.ceil(total / limit);

  return {
    page,
    limit,
    total,
    totalPages,
    hasNextPage: page < totalPages,
    hasPrevPage: page > 1,
  };
}

// Type exports
export type MemberStoryDTO = ReturnType<typeof toMemberStory>;
export type MemberPlaceDTO = ReturnType<typeof toMemberPlace>;
export type MemberSpeakerDTO = ReturnType<typeof toMemberSpeaker>;
export type CreateStoryInput = z.infer<typeof CreateStorySchema>;
export type UpdateStoryInput = z.infer<typeof UpdateStorySchema>;
export type CreatePlaceInput = z.infer<typeof CreatePlaceSchema>;
export type UpdatePlaceInput = z.infer<typeof UpdatePlaceSchema>;
export type CreateSpeakerInput = z.infer<typeof CreateSpeakerSchema>;
export type UpdateSpeakerInput = z.infer<typeof UpdateSpeakerSchema>;
export type MemberPaginationQuery = z.infer<typeof MemberPaginationQuerySchema>;
export type PlaceSearchQuery = z.infer<typeof PlaceSearchQuerySchema>;
export type SpeakerSearchQuery = z.infer<typeof SpeakerSearchQuerySchema>;
export type MemberIdParam = z.infer<typeof MemberIdParamSchema>;
