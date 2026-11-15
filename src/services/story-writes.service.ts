import type { FoundationUser } from '../repositories/hono-foundation.repository.js';
import {
  isForeignKeyConstraintError,
  isNotNullConstraintError,
} from '../repositories/community-writes.repository.js';
import {
  StoryWritesRepository,
  type ExternalMediaLinkRow,
} from '../repositories/story-writes.repository.js';
import { CommunityReadsService } from './community-reads.service.js';
import {
  authorizeCommunityWriteCaller,
  CONFLICT_BODY,
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
  CreateExternalMediaLinkRequestSchema,
  CreateStoryRequestSchema,
  ExternalMediaLinksListResponseSchema,
  ExternalMediaLinkWriteResponseSchema,
  MAX_EXTERNAL_LINKS_PER_STORY,
  PatchStoryRequestSchema,
  PutStoryPlacesRequestSchema,
  PutStorySpeakersRequestSchema,
  ReorderExternalMediaLinksRequestSchema,
  StoryWriteResponseSchema,
  type ExternalMediaLinksListResponse,
  type ExternalMediaLinkWriteResponse,
  type StoryWriteResponse,
} from '../shared/schemas/story-writes.js';
import { isDatabaseIdString } from '../shared/types/public.js';
import {
  deriveDescriptionForWrite,
  deriveTopicColumns,
} from '../shared/utils/derived-columns.js';
import { InvalidDescriptionError } from '../shared/utils/safe-description.js';
import {
  findOwnerAttachmentFileIds,
  findUnreferencedFiles,
  type MediaCleanupCoordinator,
} from './media-cleanup.service.js';

export class StoryWritesService {
  constructor(
    private readonly repository: StoryWritesRepository,
    private readonly readsService: CommunityReadsService,
    private readonly cleanup?: MediaCleanupCoordinator
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

    // Capture attachment file ids before the delete so any bytes that become
    // unreferenced can be scheduled for restart-safe cleanup.
    const attachmentFileIds = await findOwnerAttachmentFileIds(
      this.repository.connection,
      caller.communityId,
      'story',
      storyId
    );

    try {
      const deleted = await this.repository.deleteStory(
        caller.communityId,
        storyId
      );
      if (!deleted) {
        return { status: 404, body: NOT_FOUND_BODY };
      }
      if (this.cleanup && attachmentFileIds.length > 0) {
        try {
          const unreferenced = await findUnreferencedFiles(
            this.repository.connection,
            this.repository.connection,
            attachmentFileIds,
            'owner_deleted'
          );
          if (unreferenced.length > 0) {
            await this.cleanup.schedule(unreferenced);
          }
        } catch {
          // The restart-safe sweeper remains the backstop.
        }
      }
      return { status: 204 };
    } catch {
      return { status: 500, body: INTERNAL_ERROR_BODY };
    }
  }

  private async replaceStoryEdges(
    edgeKind: 'places' | 'speakers',
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

    const parsed =
      edgeKind === 'places'
        ? PutStoryPlacesRequestSchema.safeParse(rawBody)
        : PutStorySpeakersRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return {
        status: 400,
        body: makeValidationErrorBody(zodErrorToValidationFields(parsed.error)),
      };
    }

    const targetIds =
      edgeKind === 'places'
        ? (parsed.data as { placeIds: number[] }).placeIds
        : (parsed.data as { speakerIds: number[] }).speakerIds;
    const fieldName = edgeKind === 'places' ? 'placeIds' : 'speakerIds';
    const notFoundTargetMessage =
      edgeKind === 'places'
        ? 'One or more referenced places were not found in this community'
        : 'One or more referenced speakers were not found in this community';

    try {
      // Verify story readability before probing target IDs so missing,
      // foreign, or #162-restricted stories never leak target existence.
      const existingStory = await this.repository.findReadableStory(
        caller.communityId,
        storyId
      );
      if (!existingStory) {
        return { status: 404, body: NOT_FOUND_BODY };
      }

      if (targetIds.length > 0) {
        const foundTargets =
          edgeKind === 'places'
            ? await this.repository.findExistingUnrestrictedPlaceIds(
                caller.communityId,
                targetIds
              )
            : await this.repository.findExistingSpeakerIds(
                caller.communityId,
                targetIds
              );
        if (targetIds.some((id) => !foundTargets.has(id))) {
          return {
            status: 400,
            body: makeValidationErrorBody([
              { path: fieldName, message: notFoundTargetMessage },
            ]),
          };
        }
      }

      const outcome =
        edgeKind === 'places'
          ? await this.repository.replaceStoryPlaces(
              caller.communityId,
              storyId,
              targetIds
            )
          : await this.repository.replaceStorySpeakers(
              caller.communityId,
              storyId,
              targetIds
            );

      if (outcome === 'not_found') {
        return { status: 404, body: NOT_FOUND_BODY };
      }
      if (outcome === 'invalid_reference') {
        return {
          status: 400,
          body: makeValidationErrorBody([
            { path: fieldName, message: notFoundTargetMessage },
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
      if (isForeignKeyConstraintError(err) || isNotNullConstraintError(err)) {
        return {
          status: 400,
          body: makeValidationErrorBody([
            { path: fieldName, message: notFoundTargetMessage },
          ]),
        };
      }
      return { status: 500, body: INTERNAL_ERROR_BODY };
    }
  }

  replaceStoryPlaces(
    actor: FoundationUser,
    rawStoryId: string,
    rawBody: unknown,
    origin: string
  ): Promise<CommunityWriteResult<StoryWriteResponse>> {
    return this.replaceStoryEdges('places', actor, rawStoryId, rawBody, origin);
  }

  replaceStorySpeakers(
    actor: FoundationUser,
    rawStoryId: string,
    rawBody: unknown,
    origin: string
  ): Promise<CommunityWriteResult<StoryWriteResponse>> {
    return this.replaceStoryEdges(
      'speakers',
      actor,
      rawStoryId,
      rawBody,
      origin
    );
  }

  private serializeExternalMediaLink(row: ExternalMediaLinkRow) {
    const createdAt =
      row.createdAt instanceof Date
        ? row.createdAt
        : new Date(row.createdAt as unknown as number);
    return {
      id: row.id,
      url: row.url,
      ordinal: row.ordinal,
      createdAt: createdAt.toISOString(),
    };
  }

  async addExternalLink(
    actor: FoundationUser,
    rawStoryId: string,
    rawBody: unknown
  ): Promise<CommunityWriteResult<ExternalMediaLinkWriteResponse>> {
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

    const parsed = CreateExternalMediaLinkRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return {
        status: 400,
        body: makeValidationErrorBody(zodErrorToValidationFields(parsed.error)),
      };
    }

    try {
      const outcome = await this.repository.addExternalLink(
        caller.communityId,
        storyId,
        {
          url: parsed.data.url,
          ordinal: parsed.data.ordinal,
        },
        MAX_EXTERNAL_LINKS_PER_STORY
      );
      if (outcome.status === 'not_found') {
        return { status: 404, body: NOT_FOUND_BODY };
      }
      if (outcome.status === 'limit_exceeded') {
        return {
          status: 400,
          body: makeValidationErrorBody([
            {
              path: 'url',
              message: `Story cannot exceed ${MAX_EXTERNAL_LINKS_PER_STORY} external media links`,
            },
          ]),
        };
      }

      const checked = ExternalMediaLinkWriteResponseSchema.safeParse({
        data: this.serializeExternalMediaLink(outcome.link),
      });
      if (!checked.success) {
        return { status: 500, body: INTERNAL_ERROR_BODY };
      }
      return { status: 201, body: checked.data };
    } catch {
      return { status: 500, body: INTERNAL_ERROR_BODY };
    }
  }

  async reorderExternalLinks(
    actor: FoundationUser,
    rawStoryId: string,
    rawBody: unknown
  ): Promise<CommunityWriteResult<ExternalMediaLinksListResponse>> {
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

    const parsed = ReorderExternalMediaLinksRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return {
        status: 400,
        body: makeValidationErrorBody(zodErrorToValidationFields(parsed.error)),
      };
    }

    try {
      const existingStory = await this.repository.findReadableStory(
        caller.communityId,
        storyId
      );
      if (!existingStory) {
        return { status: 404, body: NOT_FOUND_BODY };
      }

      const existingIds = await this.repository.findStoryExternalLinkIds(
        caller.communityId,
        storyId
      );
      const providedSet = new Set(parsed.data.linkIds);
      if (
        parsed.data.linkIds.length !== existingIds.length ||
        existingIds.some((id) => !providedSet.has(id))
      ) {
        return {
          status: 400,
          body: makeValidationErrorBody([
            {
              path: 'linkIds',
              message:
                'linkIds must be an exact permutation of all external media links on this story',
            },
          ]),
        };
      }

      const outcome = await this.repository.reorderExternalLinks(
        caller.communityId,
        storyId,
        parsed.data.linkIds
      );
      if (outcome.status === 'not_found') {
        return { status: 404, body: NOT_FOUND_BODY };
      }
      if (outcome.status === 'conflict') {
        return { status: 409, body: CONFLICT_BODY };
      }

      const checked = ExternalMediaLinksListResponseSchema.safeParse({
        data: outcome.links.map((link) =>
          this.serializeExternalMediaLink(link)
        ),
      });
      if (!checked.success) {
        return { status: 500, body: INTERNAL_ERROR_BODY };
      }
      return { status: 200, body: checked.data };
    } catch {
      return { status: 500, body: INTERNAL_ERROR_BODY };
    }
  }

  async deleteExternalLink(
    actor: FoundationUser,
    rawStoryId: string,
    rawLinkId: string
  ): Promise<CommunityWriteResult<never>> {
    const caller = await authorizeCommunityWriteCaller(this.repository, actor, [
      'editor',
      'admin',
    ]);
    if (!caller) {
      return { status: 403, body: FORBIDDEN_BODY };
    }

    if (!isDatabaseIdString(rawStoryId) || !isDatabaseIdString(rawLinkId)) {
      return { status: 400, body: BAD_REQUEST_BODY };
    }
    const storyId = Number(rawStoryId);
    const linkId = Number(rawLinkId);

    try {
      const deleted = await this.repository.deleteExternalLink(
        caller.communityId,
        storyId,
        linkId
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
