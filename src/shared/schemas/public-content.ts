/**
 * Canonical V2 Zod contracts for unauthenticated public story, place, speaker,
 * and media endpoints under `/v2/public/communities/:slug/*`.
 *
 * Aligns with `docs/SPEC-V2.md` (§4, §6.3, §6.4, §6.4a, §6.5, §6.7, §6.9, §9)
 * and `docs/V2-ROUTE-REGISTRY.md`.
 *
 * Pagination follows the Explore adapter `limit`/`offset` contract
 * (`limit` 1..100 defaulting to 10, `offset` >= 0 defaulting to 0).
 */
import { z } from 'zod';
import { MAX_DATABASE_ID } from '../types/public.js';
import {
  PublicMapPointFeatureSchema,
  PublicMediaRefSchema,
} from './public-communities.js';

export const DEFAULT_PUBLIC_PAGE_LIMIT = 10;
export const MAX_PUBLIC_PAGE_LIMIT = 100;
export const MAX_PUBLIC_FILTER_VALUES = 50;
export const MAX_PUBLIC_TOTAL_FILTER_VALUES = 60;

export const PUBLIC_STORY_SORTS = [
  'newest',
  'title_asc',
  'title_desc',
] as const;
export type PublicStorySort = (typeof PUBLIC_STORY_SORTS)[number];

export const PublicStorySortSchema = z.enum(PUBLIC_STORY_SORTS);

export interface PublicStoriesQuery {
  place?: number[];
  region?: string[];
  typeOfPlace?: string[];
  topic?: string[];
  language?: string[];
  speaker?: number[];
  affiliation?: string[];
  sort: PublicStorySort;
  limit: number;
  offset: number;
}

export interface PublicPaginationQuery {
  limit: number;
  offset: number;
}

export const PublicPaginationMetaSchema = z.object({
  total: z.number().int().min(0),
  limit: z.number().int().min(1).max(MAX_PUBLIC_PAGE_LIMIT),
  offset: z.number().int().min(0),
  hasNextPage: z.boolean(),
});

export type PublicPaginationMeta = z.infer<typeof PublicPaginationMetaSchema>;

export const PublicPlaceSummarySchema = z.object({
  id: z.number().int().positive().max(MAX_DATABASE_ID),
  name: z.string(),
  description: z.string().nullable(),
  typeOfPlace: z.string().nullable(),
  region: z.string().nullable(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type PublicPlaceSummary = z.infer<typeof PublicPlaceSummarySchema>;

export const PublicPlaceDetailSchema = PublicPlaceSummarySchema.extend({
  photos: z.array(PublicMediaRefSchema),
  placenameAudio: PublicMediaRefSchema.nullable(),
});

export type PublicPlaceDetail = z.infer<typeof PublicPlaceDetailSchema>;

export const PublicPlacesListResponseSchema = z.object({
  data: z.array(PublicPlaceDetailSchema),
  meta: PublicPaginationMetaSchema,
});

export type PublicPlacesListResponse = z.infer<
  typeof PublicPlacesListResponseSchema
>;

export const PublicPlaceDetailResponseSchema = z.object({
  data: PublicPlaceDetailSchema,
});

export type PublicPlaceDetailResponse = z.infer<
  typeof PublicPlaceDetailResponseSchema
>;

export const PublicSpeakerSummarySchema = z.object({
  id: z.number().int().positive().max(MAX_DATABASE_ID),
  name: z.string(),
  birthDate: z.string().nullable(),
  birthplace: PublicPlaceSummarySchema.nullable(),
  affiliation: z.string().nullable(),
  photo: PublicMediaRefSchema.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type PublicSpeakerSummary = z.infer<typeof PublicSpeakerSummarySchema>;

export const PublicSpeakersListResponseSchema = z.object({
  data: z.array(PublicSpeakerSummarySchema),
  meta: PublicPaginationMetaSchema,
});

export type PublicSpeakersListResponse = z.infer<
  typeof PublicSpeakersListResponseSchema
>;

export const PublicSpeakerDetailResponseSchema = z.object({
  data: PublicSpeakerSummarySchema,
});

export type PublicSpeakerDetailResponse = z.infer<
  typeof PublicSpeakerDetailResponseSchema
>;

export const PublicStoryAttachmentSchema = z.object({
  id: z.number().int().positive().max(MAX_DATABASE_ID),
  fileId: z.string().min(1),
  role: z.literal('story_media'),
  ordinal: z.number().int().min(0),
  mimeType: z.string().min(1),
  byteSize: z.number().int().min(0),
  originalName: z.string(),
  url: z.string().url(),
});

export type PublicStoryAttachment = z.infer<typeof PublicStoryAttachmentSchema>;

export const PublicExternalMediaLinkSchema = z.object({
  id: z.number().int().positive().max(MAX_DATABASE_ID),
  url: z.string().url(),
  ordinal: z.number().int().min(0),
  createdAt: z.string().datetime(),
});

export type PublicExternalMediaLink = z.infer<
  typeof PublicExternalMediaLinkSchema
>;

export const PublicStorySummarySchema = z.object({
  id: z.number().int().positive().max(MAX_DATABASE_ID),
  title: z.string(),
  description: z.string().nullable(),
  visibility: z.literal('public'),
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

export type PublicStorySummary = z.infer<typeof PublicStorySummarySchema>;

export const PublicStoriesListResponseSchema = z.object({
  data: z.object({
    points: z.array(PublicMapPointFeatureSchema),
    stories: z.array(PublicStorySummarySchema),
  }),
  meta: PublicPaginationMetaSchema,
});

export type PublicStoriesListResponse = z.infer<
  typeof PublicStoriesListResponseSchema
>;

export const PublicStoryDetailSchema = PublicStorySummarySchema.extend({
  points: z.array(PublicMapPointFeatureSchema),
});

export type PublicStoryDetail = z.infer<typeof PublicStoryDetailSchema>;

export const PublicStoryDetailResponseSchema = z.object({
  data: PublicStoryDetailSchema,
});

export type PublicStoryDetailResponse = z.infer<
  typeof PublicStoryDetailResponseSchema
>;
