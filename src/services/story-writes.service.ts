import type { FoundationUser } from '../repositories/hono-foundation.repository.js';
import {
  isForeignKeyConstraintError,
  isNotNullConstraintError,
} from '../repositories/community-writes.repository.js';
import { StoryWritesRepository } from '../repositories/story-writes.repository.js';
import { CommunityReadsService } from './community-reads.service.js';
import {
  authorizeCommunityWriteCaller,
  type CommunityWriteResult,
} from './community-writes.service.js';
import {
  BAD_REQUEST_BODY,
  FORBIDDEN_BODY,
  INTERNAL_ERROR_BODY,
  NOT_FOUND_BODY,
} from './public-communities.service.js';
import {
  makeValidationErrorBody,
  zodErrorToValidationFields,
  type V2ValidationFieldError,
} from '../shared/schemas/community-writes.js';
import {
  CreateStoryRequestSchema,
  PatchStoryRequestSchema,
  StoryWriteResponseSchema,
  type StoryWriteResponse,
} from '../shared/schemas/story-writes.js';
import { isDatabaseIdString } from '../shared/types/public.js';
import {
  deriveDescriptionForWrite,
  deriveTopicColumns,
} from '../shared/utils/derived-columns.js';
import { InvalidDescriptionError } from '../shared/utils/safe-description.js';

export class StoryWritesService {
  constructor(
    private readonly repository: StoryWritesRepository,
    private readonly readsService: CommunityReadsService
  ) {}

  async createStory(
    actor: FoundationUser,
    rawBody: unknown,
    origin: string
  ): Promise<CommunityWriteResult<StoryWriteResponse>> {
    const caller = await authorizeCommunityWriteCaller(this.repository, actor, [
      'editor',
      'admin',
    ]);
    if (!caller) {
      return { status: 403, body: FORBIDDEN_BODY };
    }

    const parsed = CreateStoryRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return {
        status: 400,
        body: makeValidationErrorBody(zodErrorToValidationFields(parsed.error)),
      };
    }

    let derivedDesc: {
      description: string | null;
      descriptionPlain: string | null;
    };
    try {
      derivedDesc = deriveDescriptionForWrite(parsed.data.description);
    } catch (err) {
      if (err instanceof InvalidDescriptionError) {
        return {
          status: 400,
          body: makeValidationErrorBody([
            { path: 'description', message: err.message },
          ]),
        };
      }
      throw err;
    }

    const derivedTopic = deriveTopicColumns(parsed.data.topic);
    const placeIds = parsed.data.placeIds ?? [];
    const speakerIds = parsed.data.speakerIds ?? [];

    try {
      const fieldErrors: V2ValidationFieldError[] = [];

      if (
        parsed.data.interviewLocationId !== undefined &&
        parsed.data.interviewLocationId !== null
      ) {
        const place = await this.repository.findCommunityUnrestrictedPlace(
          caller.communityId,
          parsed.data.interviewLocationId
        );
        if (!place) {
          fieldErrors.push({
            path: 'interviewLocationId',
            message:
              'Referenced interview location was not found in this community',
          });
        }
      }

      if (
        parsed.data.interviewerId !== undefined &&
        parsed.data.interviewerId !== null
      ) {
        const speaker = await this.repository.findCommunitySpeaker(
          caller.communityId,
          parsed.data.interviewerId
        );
        if (!speaker) {
          fieldErrors.push({
            path: 'interviewerId',
            message: 'Referenced interviewer was not found in this community',
          });
        }
      }

      if (placeIds.length > 0) {
        const foundPlaces =
          await this.repository.findExistingUnrestrictedPlaceIds(
            caller.communityId,
            placeIds
          );
        if (placeIds.some((id) => !foundPlaces.has(id))) {
          fieldErrors.push({
            path: 'placeIds',
            message:
              'One or more referenced places were not found in this community',
          });
        }
      }

      if (speakerIds.length > 0) {
        const foundSpeakers = await this.repository.findExistingSpeakerIds(
          caller.communityId,
          speakerIds
        );
        if (speakerIds.some((id) => !foundSpeakers.has(id))) {
          fieldErrors.push({
            path: 'speakerIds',
            message:
              'One or more referenced speakers were not found in this community',
          });
        }
      }

      if (fieldErrors.length > 0) {
        return {
          status: 400,
          body: makeValidationErrorBody(fieldErrors),
        };
      }

      const outcome = await this.repository.createStory(
        caller.communityId,
        caller.actorId,
        {
          title: parsed.data.title,
          description: derivedDesc.description,
          descriptionPlain: derivedDesc.descriptionPlain,
          visibility: parsed.data.visibility,
          topic: derivedTopic.topic,
          topicNormalized: derivedTopic.topicNormalized,
          language: parsed.data.language,
          dateInterviewed:
            parsed.data.dateInterviewed !== undefined &&
            parsed.data.dateInterviewed !== null
              ? new Date(parsed.data.dateInterviewed)
              : null,
          interviewLocationId: parsed.data.interviewLocationId ?? null,
          interviewerId: parsed.data.interviewerId ?? null,
          placeIds,
          speakerIds,
        }
      );

      if (outcome.status !== 'created') {
        return {
          status: 400,
          body: makeValidationErrorBody([
            {
              path: 'body',
              message: 'Referenced record was not found in this community',
            },
          ]),
        };
      }

      const readBack = await this.readsService.getStoryById(
        actor,
        String(outcome.id),
        origin
      );
      if (readBack.status !== 200) {
        return readBack;
      }

      const checked = StoryWriteResponseSchema.safeParse(readBack.body);
      if (!checked.success) {
        return { status: 500, body: INTERNAL_ERROR_BODY };
      }
      return { status: 201, body: checked.data };
    } catch (err) {
      if (isForeignKeyConstraintError(err) || isNotNullConstraintError(err)) {
        return {
          status: 400,
          body: makeValidationErrorBody([
            {
              path: 'body',
              message: 'Referenced record was not found in this community',
            },
          ]),
        };
      }
      return { status: 500, body: INTERNAL_ERROR_BODY };
    }
  }

  async updateStory(
    actor: FoundationUser,
    rawStoryId: string,
    rawBody: unknown,
    origin: string
  ): Promise<CommunityWriteResult<StoryWriteResponse>> {
    const caller = await authorizeCommunityWriteCaller(this.repository, actor, [
      'editor',
      'admin',
    ]);
    if (!caller) {
      return { status: 403, body: FORBIDDEN_BODY };
    }

    if (!isDatabaseIdString(rawStoryId)) {
      return { status: 400, body: BAD_REQUEST_BODY };
    }
    const storyId = Number(rawStoryId);

    const parsed = PatchStoryRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return {
        status: 400,
        body: makeValidationErrorBody(zodErrorToValidationFields(parsed.error)),
      };
    }

    let derivedDesc:
      | { description: string | null; descriptionPlain: string | null }
      | undefined;
    if (parsed.data.description !== undefined) {
      try {
        derivedDesc = deriveDescriptionForWrite(parsed.data.description);
      } catch (err) {
        if (err instanceof InvalidDescriptionError) {
          return {
            status: 400,
            body: makeValidationErrorBody([
              { path: 'description', message: err.message },
            ]),
          };
        }
        throw err;
      }
    }

    const derivedTopic =
      parsed.data.topic !== undefined
        ? deriveTopicColumns(parsed.data.topic)
        : undefined;

    try {
      // Check story readability before checking target IDs to avoid leaking
      // target existence when the story itself is missing/foreign/restricted.
      const existingStory = await this.repository.findReadableStory(
        caller.communityId,
        storyId
      );
      if (!existingStory) {
        return { status: 404, body: NOT_FOUND_BODY };
      }

      const fieldErrors: V2ValidationFieldError[] = [];
      if (
        parsed.data.interviewLocationId !== undefined &&
        parsed.data.interviewLocationId !== null
      ) {
        const place = await this.repository.findCommunityUnrestrictedPlace(
          caller.communityId,
          parsed.data.interviewLocationId
        );
        if (!place) {
          fieldErrors.push({
            path: 'interviewLocationId',
            message:
              'Referenced interview location was not found in this community',
          });
        }
      }

      if (
        parsed.data.interviewerId !== undefined &&
        parsed.data.interviewerId !== null
      ) {
        const speaker = await this.repository.findCommunitySpeaker(
          caller.communityId,
          parsed.data.interviewerId
        );
        if (!speaker) {
          fieldErrors.push({
            path: 'interviewerId',
            message: 'Referenced interviewer was not found in this community',
          });
        }
      }

      if (fieldErrors.length > 0) {
        return {
          status: 400,
          body: makeValidationErrorBody(fieldErrors),
        };
      }

      const outcome = await this.repository.updateStory(
        caller.communityId,
        caller.actorId,
        storyId,
        {
          title: parsed.data.title,
          description: derivedDesc?.description,
          descriptionPlain: derivedDesc?.descriptionPlain,
          visibility: parsed.data.visibility,
          topic: derivedTopic?.topic,
          topicNormalized: derivedTopic?.topicNormalized,
          language: parsed.data.language,
          dateInterviewed:
            parsed.data.dateInterviewed === undefined
              ? undefined
              : parsed.data.dateInterviewed === null
                ? null
                : new Date(parsed.data.dateInterviewed),
          interviewLocationId: parsed.data.interviewLocationId,
          interviewerId: parsed.data.interviewerId,
        }
      );

      if (outcome === 'not_found') {
        return { status: 404, body: NOT_FOUND_BODY };
      }
      if (outcome === 'invalid_reference') {
        return {
          status: 400,
          body: makeValidationErrorBody([
            {
              path: 'body',
              message: 'Referenced record was not found in this community',
            },
          ]),
        };
      }

      const readBack = await this.readsService.getStoryById(
        actor,
        String(storyId),
        origin
      );
      if (readBack.status !== 200) {
        return readBack;
      }

      const checked = StoryWriteResponseSchema.safeParse(readBack.body);
      if (!checked.success) {
        return { status: 500, body: INTERNAL_ERROR_BODY };
      }
      return { status: 200, body: checked.data };
    } catch (err) {
      if (isForeignKeyConstraintError(err)) {
        return {
          status: 400,
          body: makeValidationErrorBody([
            {
              path: 'body',
              message: 'Referenced record was not found in this community',
            },
          ]),
        };
      }
      return { status: 500, body: INTERNAL_ERROR_BODY };
    }
  }

  async deleteStory(
    actor: FoundationUser,
    rawStoryId: string
  ): Promise<CommunityWriteResult<never>> {
    const caller = await authorizeCommunityWriteCaller(this.repository, actor, [
      'editor',
      'admin',
    ]);
    if (!caller) {
      return { status: 403, body: FORBIDDEN_BODY };
    }

    if (!isDatabaseIdString(rawStoryId)) {
      return { status: 400, body: BAD_REQUEST_BODY };
    }
    const storyId = Number(rawStoryId);

    try {
      const deleted = await this.repository.deleteStory(
        caller.communityId,
        storyId
      );
      if (!deleted) {
        return { status: 404, body: NOT_FOUND_BODY };
      }
      return { status: 204 };
    } catch {
      return { status: 500, body: INTERNAL_ERROR_BODY };
    }
  }
}
