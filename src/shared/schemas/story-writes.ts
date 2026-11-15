import { z } from 'zod';
import {
  CommunityStoryDetailResponseSchema,
  CommunityStoryVisibilitySchema,
  type CommunityStoryDetailResponse,
} from './community-reads.js';
import {
  isSafeExternalMediaUrl,
  PublicExternalMediaLinkSchema,
  type PublicExternalMediaLink,
} from './public-content.js';
import {
  addDescriptionValidationIssues,
  makeDatabaseIdSchema,
  NullableTrimmedText,
} from './community-writes.js';

/**
 * Maximum number of story-place or story-speaker edge IDs accepted in a single
 * write request (`POST /v2/stories`, `PUT /v2/stories/:id/places`,
 * `PUT /v2/stories/:id/speakers`). Bounds D1 target lookups (`<= 90` params per
 * statement) and chunked edge inserts (`<= 34` params per statement), well
 * within Cloudflare D1's 100-bound-parameter-per-statement limit.
 */
export const MAX_STORY_EDGE_IDS = 100;

export const StoryLanguageSchema = z
  .string()
  .trim()
  .min(1, 'Language must not be empty')
  .max(35, 'Language must be at most 35 characters')
  .regex(/^[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*$/, 'Invalid language format');

export const NullableStoryDateInterviewedSchema = z.union([
  z.string().trim().datetime({
    offset: true,
    message: 'dateInterviewed must be an ISO-8601 datetime with timezone',
  }),
  z.null(),
]);

const StoryPlaceIdsSchema = z
  .array(makeDatabaseIdSchema('placeId'))
  .max(
    MAX_STORY_EDGE_IDS,
    `placeIds cannot exceed ${MAX_STORY_EDGE_IDS} items`
  );

const StorySpeakerIdsSchema = z
  .array(makeDatabaseIdSchema('speakerId'))
  .max(
    MAX_STORY_EDGE_IDS,
    `speakerIds cannot exceed ${MAX_STORY_EDGE_IDS} items`
  );

export const CreateStoryRequestSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(1, 'Title must not be empty')
      .max(255, 'Title must be at most 255 characters'),
    description: z.union([z.string(), z.null()]).optional(),
    visibility: CommunityStoryVisibilitySchema.optional().default('editors'),
    topic: NullableTrimmedText('Topic', 200).optional(),
    language: StoryLanguageSchema.optional().default('en'),
    dateInterviewed: NullableStoryDateInterviewedSchema.optional(),
    interviewLocationId: z
      .union([makeDatabaseIdSchema('interviewLocationId'), z.null()])
      .optional(),
    interviewerId: z
      .union([makeDatabaseIdSchema('interviewerId'), z.null()])
      .optional(),
    placeIds: StoryPlaceIdsSchema.optional(),
    speakerIds: StorySpeakerIdsSchema.optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    addDescriptionValidationIssues(data.description, 'description', ctx);
  });

export type CreateStoryRequest = z.infer<typeof CreateStoryRequestSchema>;

export const PatchStoryRequestSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(1, 'Title must not be empty')
      .max(255, 'Title must be at most 255 characters')
      .optional(),
    description: z.union([z.string(), z.null()]).optional(),
    visibility: CommunityStoryVisibilitySchema.optional(),
    topic: NullableTrimmedText('Topic', 200).optional(),
    language: StoryLanguageSchema.optional(),
    dateInterviewed: NullableStoryDateInterviewedSchema.optional(),
    interviewLocationId: z
      .union([makeDatabaseIdSchema('interviewLocationId'), z.null()])
      .optional(),
    interviewerId: z
      .union([makeDatabaseIdSchema('interviewerId'), z.null()])
      .optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (Object.keys(data).length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: 'At least one field must be provided',
      });
    }
    addDescriptionValidationIssues(data.description, 'description', ctx);
  });

export type PatchStoryRequest = z.infer<typeof PatchStoryRequestSchema>;

export const StoryWriteResponseSchema = CommunityStoryDetailResponseSchema;
export type StoryWriteResponse = CommunityStoryDetailResponse;

export const PutStoryPlacesRequestSchema = z
  .object({
    placeIds: StoryPlaceIdsSchema,
  })
  .strict();

export type PutStoryPlacesRequest = z.infer<typeof PutStoryPlacesRequestSchema>;

export const PutStorySpeakersRequestSchema = z
  .object({
    speakerIds: StorySpeakerIdsSchema,
  })
  .strict();

export type PutStorySpeakersRequest = z.infer<
  typeof PutStorySpeakersRequestSchema
>;

/**
 * Maximum external media links allowed per story (`POST` and `reorder`),
 * keeping D1 `IN (...)` permutation checks under the 100-bound-parameter cap.
 */
export const MAX_EXTERNAL_LINKS_PER_STORY = 75;

export const CreateExternalMediaLinkRequestSchema = z
  .object({
    url: z
      .string()
      .trim()
      .min(1, 'URL must not be empty')
      .max(2048, 'URL must be at most 2048 characters')
      .refine((v) => isSafeExternalMediaUrl(v), {
        message: 'URL must be a valid absolute http: or https: URL',
      }),
    ordinal: z
      .number()
      .int('Ordinal must be an integer')
      .min(0, 'Ordinal must be non-negative')
      .max(10_000, 'Ordinal must be at most 10000')
      .optional(),
  })
  .strict();

export type CreateExternalMediaLinkRequest = z.infer<
  typeof CreateExternalMediaLinkRequestSchema
>;

export const ReorderExternalMediaLinksRequestSchema = z
  .object({
    linkIds: z
      .array(makeDatabaseIdSchema('linkId'))
      .max(
        MAX_EXTERNAL_LINKS_PER_STORY,
        `linkIds cannot exceed ${MAX_EXTERNAL_LINKS_PER_STORY} items`
      ),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (new Set(data.linkIds).size !== data.linkIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['linkIds'],
        message: 'linkIds must not contain duplicate IDs',
      });
    }
  });

export type ReorderExternalMediaLinksRequest = z.infer<
  typeof ReorderExternalMediaLinksRequestSchema
>;

export const ExternalMediaLinkWriteResponseSchema = z.object({
  data: PublicExternalMediaLinkSchema,
});
export type ExternalMediaLinkWriteResponse = {
  data: PublicExternalMediaLink;
};

export const ExternalMediaLinksListResponseSchema = z.object({
  data: z.array(PublicExternalMediaLinkSchema),
});
export type ExternalMediaLinksListResponse = {
  data: PublicExternalMediaLink[];
};
