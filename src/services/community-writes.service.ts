import { CommunityWritesRepository } from '../repositories/community-writes.repository.js';
import type { FoundationUser } from '../repositories/hono-foundation.repository.js';
import { CommunityReadsService } from './community-reads.service.js';
import { parseV2Role } from '../shared/authorization/sovereignty-policy.js';
import {
  authenticatedMediaUrl,
  BAD_REQUEST_BODY,
  FORBIDDEN_BODY,
  INTERNAL_ERROR_BODY,
  NOT_FOUND_BODY,
  projectMapConfig,
  sanitizePublicStyleUrl,
} from './public-communities.service.js';
import {
  CreatePlaceRequestSchema,
  CreateSpeakerRequestSchema,
  makeValidationErrorBody,
  PatchCommunityRequestSchema,
  PatchCommunityResponseSchema,
  PatchPlaceRequestSchema,
  PatchSpeakerRequestSchema,
  PlaceWriteResponseSchema,
  PutCommunityMapConfigRequestSchema,
  PutCommunityMapConfigResponseSchema,
  SpeakerWriteResponseSchema,
  type PatchCommunityResponse,
  type PlaceWriteResponse,
  type PutCommunityMapConfigResponse,
  type SpeakerWriteResponse,
  type V2ValidationErrorResponse,
  type V2ValidationFieldError,
  zodErrorToValidationFields,
} from '../shared/schemas/community-writes.js';
import type { V2ErrorResponse } from '../shared/schemas/public-communities.js';
import { isDatabaseIdString } from '../shared/types/public.js';
import { deriveDescriptionForWrite } from '../shared/utils/derived-columns.js';
import { InvalidDescriptionError } from '../shared/utils/safe-description.js';
import {
  type FileByteCleanup,
  type MediaCleanupCoordinator,
} from './media-cleanup.service.js';

export type CommunityWriteResult<T> =
  | { status: 200 | 201; body: T }
  | { status: 204 }
  | {
      status: 400 | 403 | 404 | 409 | 500;
      body: V2ErrorResponse | V2ValidationErrorResponse;
    };

export const CONFLICT_BODY: V2ErrorResponse = Object.freeze({
  error: 'Conflict',
});

export interface AuthorizedWriteCaller {
  actorId: number;
  communityId: number;
  role: 'editor' | 'admin';
}

export async function authorizeCommunityWriteCaller(
  repository: Pick<CommunityWritesRepository, 'activeCommunityExists'>,
  actor: FoundationUser,
  allowedRoles: ReadonlyArray<'editor' | 'admin'>
): Promise<AuthorizedWriteCaller | null> {
  if (actor.role === 'super_admin' || actor.communityId === null) {
    return null;
  }
  const resolvedRole = parseV2Role(actor.role);
  if (
    !resolvedRole ||
    (resolvedRole !== 'editor' && resolvedRole !== 'admin') ||
    !allowedRoles.includes(resolvedRole)
  ) {
    return null;
  }
  const active = await repository.activeCommunityExists(actor.communityId);
  if (!active) {
    return null;
  }
  return {
    actorId: actor.id,
    communityId: actor.communityId,
    role: resolvedRole,
  };
}

export class CommunityWritesService {
  constructor(
    private readonly repository: CommunityWritesRepository,
    private readonly readsService: CommunityReadsService,
    private readonly cleanup?: MediaCleanupCoordinator
  ) {}

  private async scheduleOwnerAttachmentCleanup(
    removedFiles?: FileByteCleanup[]
  ): Promise<void> {
    if (!this.cleanup) return;
    // The repository removes now-unreferenced files rows inside the owner
    // delete transaction and reports them here; delete their bytes
    // best-effort. Any leftover is removed by the restart-safe orphan sweeper.
    if (removedFiles && removedFiles.length > 0) {
      await this.cleanup.deleteFilesBestEffort(removedFiles);
    }
  }

  private authorizeCaller(
    actor: FoundationUser,
    allowedRoles: ReadonlyArray<'editor' | 'admin'>
  ): Promise<AuthorizedWriteCaller | null> {
    return authorizeCommunityWriteCaller(this.repository, actor, allowedRoles);
  }

  async updateCommunity(
    actor: FoundationUser,
    rawBody: unknown,
    origin: string
  ): Promise<CommunityWriteResult<PatchCommunityResponse>> {
    const caller = await this.authorizeCaller(actor, ['admin']);
    if (!caller) {
      return { status: 403, body: FORBIDDEN_BODY };
    }

    const parsed = PatchCommunityRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return {
        status: 400,
        body: makeValidationErrorBody(zodErrorToValidationFields(parsed.error)),
      };
    }

    try {
      let description: string | null | undefined;
      let descriptionPlain: string | null | undefined;
      if (parsed.data.description !== undefined) {
        const derived = deriveDescriptionForWrite(parsed.data.description);
        description = derived.description;
        descriptionPlain = derived.descriptionPlain;
      }

      const { updated } = await this.repository.updateCommunitySettings(
        caller.communityId,
        caller.actorId,
        {
          name: parsed.data.name,
          description,
          descriptionPlain,
          locale: parsed.data.locale,
          country: parsed.data.country,
          visibility: parsed.data.visibility,
        }
      );

      if (!updated) {
        return { status: 403, body: FORBIDDEN_BODY };
      }

      const readBack = await this.readsService.getCommunity(actor, origin);
      if (readBack.status !== 200) {
        return readBack;
      }
      const checked = PatchCommunityResponseSchema.safeParse(readBack.body);
      if (!checked.success) {
        return { status: 500, body: INTERNAL_ERROR_BODY };
      }
      return { status: 200, body: checked.data };
    } catch (err) {
      if (err instanceof InvalidDescriptionError) {
        return {
          status: 400,
          body: makeValidationErrorBody([
            { path: 'description', message: err.message },
          ]),
        };
      }
      return { status: 500, body: INTERNAL_ERROR_BODY };
    }
  }

  async upsertMapConfig(
    actor: FoundationUser,
    rawBody: unknown,
    origin: string
  ): Promise<CommunityWriteResult<PutCommunityMapConfigResponse>> {
    const caller = await this.authorizeCaller(actor, ['admin']);
    if (!caller) {
      return { status: 403, body: FORBIDDEN_BODY };
    }

    const parsed = PutCommunityMapConfigRequestSchema.safeParse(rawBody);
    const fields: V2ValidationFieldError[] = parsed.success
      ? []
      : zodErrorToValidationFields(parsed.error);

    if (
      rawBody &&
      typeof rawBody === 'object' &&
      !Array.isArray(rawBody) &&
      'styleUrl' in rawBody
    ) {
      const candidateStyleUrl = (rawBody as { styleUrl?: unknown }).styleUrl;
      if (
        typeof candidateStyleUrl === 'string' &&
        !fields.some((f) => f.path === 'styleUrl') &&
        sanitizePublicStyleUrl(candidateStyleUrl.trim()) === null
      ) {
        fields.push({
          path: 'styleUrl',
          message:
            'Style URL must use https or http without embedded credentials or URL fragments',
        });
      }
    }

    if (!parsed.success || fields.length > 0) {
      return {
        status: 400,
        body: makeValidationErrorBody(fields),
      };
    }

    try {
      const cleanStyleUrl =
        parsed.data.styleUrl === null
          ? null
          : sanitizePublicStyleUrl(parsed.data.styleUrl);
      if (parsed.data.styleUrl !== null && cleanStyleUrl === null) {
        return {
          status: 400,
          body: makeValidationErrorBody([
            {
              path: 'styleUrl',
              message:
                'Style URL must use https or http without embedded credentials or URL fragments',
            },
          ]),
        };
      }

      if (parsed.data.staticMapFileId !== null) {
        const ownedFile = await this.repository.findCommunityFile(
          caller.communityId,
          parsed.data.staticMapFileId
        );
        if (!ownedFile) {
          return {
            status: 400,
            body: makeValidationErrorBody([
              {
                path: 'staticMapFileId',
                message:
                  'Referenced static map file was not found in this community',
              },
            ]),
          };
        }
      }

      const saved = await this.repository.upsertCommunityMapConfig(
        caller.communityId,
        {
          styleUrl: cleanStyleUrl,
          basemapStyle: parsed.data.basemapStyle,
          centerLatitude: parsed.data.centerLatitude,
          centerLongitude: parsed.data.centerLongitude,
          southWestLatitude: parsed.data.southWestLatitude,
          southWestLongitude: parsed.data.southWestLongitude,
          northEastLatitude: parsed.data.northEastLatitude,
          northEastLongitude: parsed.data.northEastLongitude,
          zoom: parsed.data.zoom,
          pitch: parsed.data.pitch,
          bearing: parsed.data.bearing,
          threeDimensional: parsed.data.threeDimensional,
          projection: parsed.data.projection,
          staticMapFileId: parsed.data.staticMapFileId,
        }
      );

      if (!saved) {
        return { status: 500, body: INTERNAL_ERROR_BODY };
      }

      const projected = projectMapConfig('community', origin, saved, (fileId) =>
        authenticatedMediaUrl(origin, fileId)
      );
      const checked = PutCommunityMapConfigResponseSchema.safeParse({
        data: projected,
      });
      if (!checked.success) {
        return { status: 500, body: INTERNAL_ERROR_BODY };
      }
      return { status: 200, body: checked.data };
    } catch {
      return { status: 500, body: INTERNAL_ERROR_BODY };
    }
  }

  async createPlace(
    actor: FoundationUser,
    rawBody: unknown,
    origin: string
  ): Promise<CommunityWriteResult<PlaceWriteResponse>> {
    const caller = await this.authorizeCaller(actor, ['editor', 'admin']);
    if (!caller) {
      return { status: 403, body: FORBIDDEN_BODY };
    }

    const parsed = CreatePlaceRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return {
        status: 400,
        body: makeValidationErrorBody(zodErrorToValidationFields(parsed.error)),
      };
    }

    try {
      const derived = deriveDescriptionForWrite(parsed.data.description);
      const created = await this.repository.createPlace(caller.communityId, {
        name: parsed.data.name,
        description: derived.description,
        descriptionPlain: derived.descriptionPlain,
        typeOfPlace: parsed.data.typeOfPlace ?? null,
        region: parsed.data.region ?? null,
        latitude: parsed.data.latitude ?? null,
        longitude: parsed.data.longitude ?? null,
      });

      if (!created) {
        return { status: 500, body: INTERNAL_ERROR_BODY };
      }

      const readBack = await this.readsService.getPlaceById(
        actor,
        String(created.id),
        origin
      );
      if (readBack.status !== 200) {
        return readBack;
      }

      const checked = PlaceWriteResponseSchema.safeParse(readBack.body);
      if (!checked.success) {
        return { status: 500, body: INTERNAL_ERROR_BODY };
      }
      return { status: 201, body: checked.data };
    } catch (err) {
      if (err instanceof InvalidDescriptionError) {
        return {
          status: 400,
          body: makeValidationErrorBody([
            { path: 'description', message: err.message },
          ]),
        };
      }
      return { status: 500, body: INTERNAL_ERROR_BODY };
    }
  }

  async updatePlace(
    actor: FoundationUser,
    rawPlaceId: string,
    rawBody: unknown,
    origin: string
  ): Promise<CommunityWriteResult<PlaceWriteResponse>> {
    const caller = await this.authorizeCaller(actor, ['editor', 'admin']);
    if (!caller) {
      return { status: 403, body: FORBIDDEN_BODY };
    }

    if (!isDatabaseIdString(rawPlaceId)) {
      return { status: 400, body: BAD_REQUEST_BODY };
    }
    const placeId = Number(rawPlaceId);

    const parsed = PatchPlaceRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return {
        status: 400,
        body: makeValidationErrorBody(zodErrorToValidationFields(parsed.error)),
      };
    }

    try {
      let description: string | null | undefined;
      let descriptionPlain: string | null | undefined;
      if (parsed.data.description !== undefined) {
        const derived = deriveDescriptionForWrite(parsed.data.description);
        description = derived.description;
        descriptionPlain = derived.descriptionPlain;
      }

      const updated = await this.repository.updatePlace(
        caller.communityId,
        placeId,
        {
          name: parsed.data.name,
          description,
          descriptionPlain,
          typeOfPlace: parsed.data.typeOfPlace,
          region: parsed.data.region,
          latitude: parsed.data.latitude,
          longitude: parsed.data.longitude,
        }
      );

      if (!updated) {
        return { status: 404, body: NOT_FOUND_BODY };
      }

      const readBack = await this.readsService.getPlaceById(
        actor,
        String(placeId),
        origin
      );
      if (readBack.status !== 200) {
        return readBack;
      }

      const checked = PlaceWriteResponseSchema.safeParse(readBack.body);
      if (!checked.success) {
        return { status: 500, body: INTERNAL_ERROR_BODY };
      }
      return { status: 200, body: checked.data };
    } catch (err) {
      if (err instanceof InvalidDescriptionError) {
        return {
          status: 400,
          body: makeValidationErrorBody([
            { path: 'description', message: err.message },
          ]),
        };
      }
      return { status: 500, body: INTERNAL_ERROR_BODY };
    }
  }

  async deletePlace(
    actor: FoundationUser,
    rawPlaceId: string
  ): Promise<CommunityWriteResult<never>> {
    const caller = await this.authorizeCaller(actor, ['editor', 'admin']);
    if (!caller) {
      return { status: 403, body: FORBIDDEN_BODY };
    }

    if (!isDatabaseIdString(rawPlaceId)) {
      return { status: 400, body: BAD_REQUEST_BODY };
    }
    const placeId = Number(rawPlaceId);

    const removedFiles: FileByteCleanup[] = [];

    try {
      const outcome = await this.repository.deletePlace(
        caller.communityId,
        placeId,
        removedFiles
      );
      if (outcome === 'not_found') {
        return { status: 404, body: NOT_FOUND_BODY };
      }
      if (outcome === 'conflict') {
        return {
          status: 409,
          body: {
            error: 'Place is referenced by stories or speakers',
            code: 'conflict',
          },
        };
      }
      await this.scheduleOwnerAttachmentCleanup(removedFiles);
      return { status: 204 };
    } catch {
      return { status: 500, body: INTERNAL_ERROR_BODY };
    }
  }

  async createSpeaker(
    actor: FoundationUser,
    rawBody: unknown,
    origin: string
  ): Promise<CommunityWriteResult<SpeakerWriteResponse>> {
    const caller = await this.authorizeCaller(actor, ['editor', 'admin']);
    if (!caller) {
      return { status: 403, body: FORBIDDEN_BODY };
    }

    const parsed = CreateSpeakerRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return {
        status: 400,
        body: makeValidationErrorBody(zodErrorToValidationFields(parsed.error)),
      };
    }

    try {
      const birthplaceId = parsed.data.birthplaceId ?? null;
      if (birthplaceId !== null) {
        const place = await this.repository.findCommunityUnrestrictedPlace(
          caller.communityId,
          birthplaceId
        );
        if (!place) {
          return {
            status: 400,
            body: makeValidationErrorBody([
              {
                path: 'birthplaceId',
                message:
                  'Referenced birthplace was not found in this community',
              },
            ]),
          };
        }
      }

      const created = await this.repository.createSpeaker(caller.communityId, {
        name: parsed.data.name,
        birthDate: parsed.data.birthDate ?? null,
        birthplaceId,
        affiliation: parsed.data.affiliation ?? null,
      });

      if (!created) {
        return { status: 500, body: INTERNAL_ERROR_BODY };
      }

      const readBack = await this.readsService.getSpeakerById(
        actor,
        String(created.id),
        origin
      );
      if (readBack.status !== 200) {
        return readBack;
      }

      const checked = SpeakerWriteResponseSchema.safeParse(readBack.body);
      if (!checked.success) {
        return { status: 500, body: INTERNAL_ERROR_BODY };
      }
      return { status: 201, body: checked.data };
    } catch {
      return { status: 500, body: INTERNAL_ERROR_BODY };
    }
  }

  async updateSpeaker(
    actor: FoundationUser,
    rawSpeakerId: string,
    rawBody: unknown,
    origin: string
  ): Promise<CommunityWriteResult<SpeakerWriteResponse>> {
    const caller = await this.authorizeCaller(actor, ['editor', 'admin']);
    if (!caller) {
      return { status: 403, body: FORBIDDEN_BODY };
    }

    if (!isDatabaseIdString(rawSpeakerId)) {
      return { status: 400, body: BAD_REQUEST_BODY };
    }
    const speakerId = Number(rawSpeakerId);

    const parsed = PatchSpeakerRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return {
        status: 400,
        body: makeValidationErrorBody(zodErrorToValidationFields(parsed.error)),
      };
    }

    try {
      if (
        parsed.data.birthplaceId !== undefined &&
        parsed.data.birthplaceId !== null
      ) {
        const place = await this.repository.findCommunityUnrestrictedPlace(
          caller.communityId,
          parsed.data.birthplaceId
        );
        if (!place) {
          return {
            status: 400,
            body: makeValidationErrorBody([
              {
                path: 'birthplaceId',
                message:
                  'Referenced birthplace was not found in this community',
              },
            ]),
          };
        }
      }

      const updated = await this.repository.updateSpeaker(
        caller.communityId,
        speakerId,
        {
          name: parsed.data.name,
          birthDate: parsed.data.birthDate,
          birthplaceId: parsed.data.birthplaceId,
          affiliation: parsed.data.affiliation,
        }
      );

      if (!updated) {
        return { status: 404, body: NOT_FOUND_BODY };
      }

      const readBack = await this.readsService.getSpeakerById(
        actor,
        String(speakerId),
        origin
      );
      if (readBack.status !== 200) {
        return readBack;
      }

      const checked = SpeakerWriteResponseSchema.safeParse(readBack.body);
      if (!checked.success) {
        return { status: 500, body: INTERNAL_ERROR_BODY };
      }
      return { status: 200, body: checked.data };
    } catch {
      return { status: 500, body: INTERNAL_ERROR_BODY };
    }
  }

  async deleteSpeaker(
    actor: FoundationUser,
    rawSpeakerId: string
  ): Promise<CommunityWriteResult<never>> {
    const caller = await this.authorizeCaller(actor, ['editor', 'admin']);
    if (!caller) {
      return { status: 403, body: FORBIDDEN_BODY };
    }

    if (!isDatabaseIdString(rawSpeakerId)) {
      return { status: 400, body: BAD_REQUEST_BODY };
    }
    const speakerId = Number(rawSpeakerId);

    const removedFiles: FileByteCleanup[] = [];

    try {
      const outcome = await this.repository.deleteSpeaker(
        caller.communityId,
        speakerId,
        removedFiles
      );
      if (outcome === 'not_found') {
        return { status: 404, body: NOT_FOUND_BODY };
      }
      if (outcome === 'conflict') {
        return {
          status: 409,
          body: {
            error: 'Speaker is referenced by stories',
            code: 'conflict',
          },
        };
      }
      await this.scheduleOwnerAttachmentCleanup(removedFiles);
      return { status: 204 };
    } catch {
      return { status: 500, body: INTERNAL_ERROR_BODY };
    }
  }
}
