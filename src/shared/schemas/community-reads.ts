/**
 * Canonical V2 Zod contracts for Slice 6 authenticated community read endpoints
 * (`GET /v2/community`, `GET /v2/community/map-config`, `GET /v2/stories`,
 * `GET /v2/stories/:id`, `GET /v2/places`, `GET /v2/places/:id`,
 * `GET /v2/speakers`, `GET /v2/speakers/:id`).
 *
 * Aligns with `docs/SPEC-V2.md` (§6.1–§6.9, §7, §8) and `docs/V2-ROUTE-REGISTRY.md`.
 */
import { z } from 'zod';
import { MAX_DATABASE_ID } from '../types/public.js';
import {
  PublicCommunityBrandingSchema,
  PublicCommunityFilterCategorySchema,
  PublicCommunityFilterOptionSchema,
  PublicCommunityMapConfigSchema,
  PublicMapPointFeatureSchema,
  type V2ErrorResponse,
} from './public-communities.js';
import {
  DEFAULT_PUBLIC_PAGE_LIMIT,
  MAX_PUBLIC_FILTER_VALUES,
  MAX_PUBLIC_PAGE_LIMIT,
  MAX_PUBLIC_TOTAL_FILTER_VALUES,
  PUBLIC_STORY_SORTS,
  PublicExternalMediaLinkSchema,
  PublicPaginationMetaSchema,
  PublicPlaceDetailResponseSchema,
  PublicPlaceDetailSchema,
  PublicPlaceSummarySchema,
  PublicPlacesListResponseSchema,
  PublicSpeakerDetailResponseSchema,
  PublicSpeakerSummarySchema,
  PublicSpeakersListResponseSchema,
  PublicStoryAttachmentSchema,
  PublicStorySortSchema,
  type PublicPaginationQuery,
  type PublicStoriesQuery,
  type PublicStorySort,
} from './public-content.js';

export {
  DEFAULT_PUBLIC_PAGE_LIMIT,
  MAX_PUBLIC_FILTER_VALUES,
  MAX_PUBLIC_PAGE_LIMIT,
  MAX_PUBLIC_TOTAL_FILTER_VALUES,
  PUBLIC_STORY_SORTS,
  PublicCommunityMapConfigSchema,
  PublicPlaceDetailResponseSchema,
  PublicPlaceDetailSchema,
  PublicPlaceSummarySchema,
  PublicPlacesListResponseSchema,
  PublicSpeakerDetailResponseSchema,
  PublicSpeakerSummarySchema,
  PublicSpeakersListResponseSchema,
  PublicStorySortSchema,
  type PublicPaginationQuery,
  type PublicStorySort,
  type V2ErrorResponse,
};

export const CommunityReadVisibilitySchema = z.enum(['public', 'private']);
export const CommunityStoryVisibilitySchema = z.enum([
  'public',
  'community',
  'editors',
]);

export const CommunityMapConfigSchema = PublicCommunityMapConfigSchema.extend({
  exposeMapboxCredentials: z.boolean(),
  protomapsApiKey: z.string().nullable(),
});

export type CommunityMapConfig = z.infer<typeof CommunityMapConfigSchema>;

export const CommunityReadDetailSchema = z.object({
  id: z.number().int().positive().max(MAX_DATABASE_ID),
  slug: z.string().min(1),
  name: z.string(),
  description: z.string().nullable(),
  locale: z.string(),
  country: z.string().nullable(),
  visibility: CommunityReadVisibilitySchema,
  status: z.literal('active'),
  branding: PublicCommunityBrandingSchema,
  mapConfig: CommunityMapConfigSchema.nullable(),
  storiesCount: z.number().int().min(0),
  points: z.array(PublicMapPointFeatureSchema),
  categories: z.array(PublicCommunityFilterCategorySchema),
  filters: z.array(PublicCommunityFilterOptionSchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type CommunityReadDetail = z.infer<typeof CommunityReadDetailSchema>;

export const CommunityReadDetailResponseSchema = z.object({
  data: CommunityReadDetailSchema,
});

export type CommunityReadDetailResponse = z.infer<
  typeof CommunityReadDetailResponseSchema
>;

export const CommunityMapConfigResponseSchema = z.object({
  data: CommunityMapConfigSchema.nullable(),
});

export type CommunityMapConfigResponse = z.infer<
  typeof CommunityMapConfigResponseSchema
>;

export const CommunityStorySummarySchema = z.object({
  id: z.number().int().positive().max(MAX_DATABASE_ID),
  title: z.string(),
  description: z.string().nullable(),
  visibility: CommunityStoryVisibilitySchema,
  topic: z.string().nullable(),
  language: z.string(),
  dateInterviewed: z.string().datetime().nullable(),
  interviewLocation: PublicPlaceSummarySchema.nullable(),
  interviewer: PublicSpeakerSummarySchema.nullable(),
  places: z.array(PublicPlaceSummarySchema),
  speakers: z.array(PublicSpeakerSummarySchema),
  attachments: z.array(PublicStoryAttachmentSchema),
  externalMediaLinks: z.array(PublicExternalMediaLinkSchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type CommunityStorySummary = z.infer<typeof CommunityStorySummarySchema>;

export const CommunityStoriesListResponseSchema = z.object({
  data: z.object({
    points: z.array(PublicMapPointFeatureSchema),
    stories: z.array(CommunityStorySummarySchema),
  }),
  meta: PublicPaginationMetaSchema,
});

export type CommunityStoriesListResponse = z.infer<
  typeof CommunityStoriesListResponseSchema
>;

export const CommunityStoryDetailSchema = CommunityStorySummarySchema.extend({
  points: z.array(PublicMapPointFeatureSchema),
});

export type CommunityStoryDetail = z.infer<typeof CommunityStoryDetailSchema>;

export const CommunityStoryDetailResponseSchema = z.object({
  data: CommunityStoryDetailSchema,
});

export type CommunityStoryDetailResponse = z.infer<
  typeof CommunityStoryDetailResponseSchema
>;

export interface CommunityStoriesQuery extends PublicStoriesQuery {
  search?: string;
}

export interface CommunityBoundingBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface CommunityNearFilter {
  latitude: number;
  longitude: number;
  radiusKm: number;
}

export interface CommunityPlacesQuery extends PublicPaginationQuery {
  bbox?: CommunityBoundingBox;
  near?: CommunityNearFilter;
}
