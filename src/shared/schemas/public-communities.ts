/**
 * Canonical V2 Zod contracts for unauthenticated public community endpoints
 * (`GET /v2/public/communities`, `GET /v2/public/communities/:slug`).
 *
 * Aligns with `docs/SPEC-V2.md` (§4, §6.1, §6.3, §6.4a, §6.6, §9) and
 * `docs/V2-ROUTE-REGISTRY.md`.
 */
import { z } from 'zod';
import { MAX_DATABASE_ID } from '../types/public.js';

export const PUBLIC_COMMUNITY_FILTER_CATEGORIES = [
  'place',
  'region',
  'typeOfPlace',
  'speaker',
  'topic',
  'language',
  'affiliation',
] as const;

export type PublicCommunityFilterCategory =
  (typeof PUBLIC_COMMUNITY_FILTER_CATEGORIES)[number];

export const PublicCommunitiesSearchQuerySchema = z.object({
  search: z.string().max(500).optional(),
});

export const PublicMediaRefSchema = z.object({
  fileId: z.string().min(1),
  url: z.string().url(),
});

export type PublicMediaRef = z.infer<typeof PublicMediaRefSchema>;

export const PublicSponsorLogoRefSchema = z.object({
  fileId: z.string().min(1),
  url: z.string().url(),
  ordinal: z.number().int().min(0),
});

export type PublicSponsorLogoRef = z.infer<typeof PublicSponsorLogoRefSchema>;

export const PublicCommunityBrandingSchema = z.object({
  displayImage: PublicMediaRefSchema.nullable(),
  backgroundImage: PublicMediaRefSchema.nullable(),
  sponsorLogos: z.array(PublicSponsorLogoRefSchema),
});

export type PublicCommunityBranding = z.infer<
  typeof PublicCommunityBrandingSchema
>;

export const PublicCommunityMapConfigSchema = z.object({
  styleUrl: z.string().nullable(),
  basemapStyle: z.string().nullable(),
  mapboxStyleUrl: z.string().nullable(),
  mapboxAccessToken: z.string().nullable(),
  mapbox3d: z.boolean(),
  protomapsBasemapStyle: z.string().nullable(),
  centerLatitude: z.number().nullable(),
  centerLongitude: z.number().nullable(),
  southWestLatitude: z.number().nullable(),
  southWestLongitude: z.number().nullable(),
  northEastLatitude: z.number().nullable(),
  northEastLongitude: z.number().nullable(),
  zoom: z.number().nullable(),
  pitch: z.number().nullable(),
  bearing: z.number().nullable(),
  threeDimensional: z.boolean().nullable(),
  projection: z.string().nullable(),
  staticMapFileId: z.string().nullable(),
  staticMapUrl: z.string().url().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type PublicCommunityMapConfig = z.infer<
  typeof PublicCommunityMapConfigSchema
>;

export const PublicCommunitySummarySchema = z.object({
  id: z.number().int().positive().max(MAX_DATABASE_ID),
  slug: z.string().min(1),
  name: z.string(),
  description: z.string().nullable(),
  locale: z.string(),
  country: z.string().nullable(),
  visibility: z.literal('public'),
  status: z.literal('active'),
  branding: PublicCommunityBrandingSchema,
  mapConfig: PublicCommunityMapConfigSchema.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type PublicCommunitySummary = z.infer<
  typeof PublicCommunitySummarySchema
>;

export const PublicCommunitiesListResponseSchema = z.object({
  data: z.array(PublicCommunitySummarySchema),
});

export type PublicCommunitiesListResponse = z.infer<
  typeof PublicCommunitiesListResponseSchema
>;

export const PublicMapPointFeatureSchema = z.object({
  type: z.literal('Feature'),
  id: z.number().int().positive().max(MAX_DATABASE_ID),
  geometry: z.object({
    type: z.literal('Point'),
    coordinates: z.tuple([z.number(), z.number()]),
  }),
  properties: z.object({
    name: z.string(),
    description: z.string().nullable(),
    region: z.string().nullable(),
    typeOfPlace: z.string().nullable(),
  }),
});

export type PublicMapPointFeature = z.infer<typeof PublicMapPointFeatureSchema>;

export const PublicCommunityFilterCategorySchema = z.enum(
  PUBLIC_COMMUNITY_FILTER_CATEGORIES
);

export const PublicCommunityFilterOptionSchema = z.object({
  category: PublicCommunityFilterCategorySchema,
  value: z.union([z.number().int().positive(), z.string()]),
  label: z.string(),
});

export type PublicCommunityFilterOption = z.infer<
  typeof PublicCommunityFilterOptionSchema
>;

export const PublicCommunityDetailSchema = PublicCommunitySummarySchema.extend({
  storiesCount: z.number().int().min(0),
  points: z.array(PublicMapPointFeatureSchema),
  categories: z.array(PublicCommunityFilterCategorySchema),
  filters: z.array(PublicCommunityFilterOptionSchema),
});

export type PublicCommunityDetail = z.infer<typeof PublicCommunityDetailSchema>;

export const PublicCommunityDetailResponseSchema = z.object({
  data: PublicCommunityDetailSchema,
});

export type PublicCommunityDetailResponse = z.infer<
  typeof PublicCommunityDetailResponseSchema
>;

export const V2ErrorResponseSchema = z.object({
  error: z.string(),
  code: z.string().optional(),
});

export type V2ErrorResponse = z.infer<typeof V2ErrorResponseSchema>;
