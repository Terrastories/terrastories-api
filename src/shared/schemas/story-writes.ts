import { z } from 'zod';
import {
  CommunityStoryDetailResponseSchema,
  CommunityStoryVisibilitySchema,
  type CommunityStoryDetailResponse,
} from './community-reads.js';
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
