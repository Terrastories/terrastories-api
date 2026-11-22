/**
 * Canonical V2 service layer for Slice 6 authenticated community read routes (#145).
 *
 * Enforces:
 * - Tenant binding strictly from session-resolved `actor.communityId`
 * - `super_admin` (and null-community callers) denied with `403 { error: 'Forbidden' }`
 * - Active community lifecycle gate (`403` for disabled communities incl. own admins)
 * - SPEC-V2 §6.4a role differentiation + `#162` option-A hiding across all roles
 * - Portable lat/lng `bbox`/`near` spatial filtering and Unicode plain-text search
 * - Schema-validated JSON responses failing closed (`500`) without content leaks
 */
import { z } from 'zod';
import {
  communityFromPhysical,
  storyVisibilityFromPhysical,
} from '../policy/canonical-state.js';
import type { FoundationUser } from '../repositories/hono-foundation.repository.js';
import {
  ownCommunityViewerForRole,
  type OwnCommunityReadViewer,
} from '../repositories/public-visibility.js';
import type { PublicCommunityRow } from '../repositories/public-communities.repository.js';
import type { PublicStoryRecord } from '../repositories/public-content.repository.js';
import { CommunityReadsRepository } from '../repositories/community-reads.repository.js';
import {
  PUBLIC_COMMUNITY_FILTER_CATEGORIES,
  type PublicCommunityFilterOption,
} from '../shared/schemas/public-communities.js';
import type {
  PublicExternalMediaLink,
  PublicPlaceDetail,
  PublicPlaceDetailResponse,
  PublicPlacesListResponse,
  PublicSpeakerDetailResponse,
  PublicSpeakerSummary,
  PublicSpeakersListResponse,
} from '../shared/schemas/public-content.js';
import {
  CommunityMapConfigResponseSchema,
  CommunityReadDetailResponseSchema,
  CommunityStoriesListResponseSchema,
  CommunityStoryDetailResponseSchema,
  PublicPlaceDetailResponseSchema,
  PublicPlacesListResponseSchema,
  PublicSpeakerDetailResponseSchema,
  PublicSpeakersListResponseSchema,
  type CommunityBoundingBox,
  type CommunityMapConfigResponse,
  type CommunityNearFilter,
  type CommunityPlacesQuery,
  type CommunityReadDetailResponse,
  type CommunityStoriesListResponse,
  type CommunityStoriesQuery,
  type CommunityStoryDetailResponse,
  type CommunityStorySummary,
} from '../shared/schemas/community-reads.js';
import { isDatabaseIdString } from '../shared/types/public.js';
import {
  FORBIDDEN_BODY,
  INTERNAL_ERROR_BODY,
  NOT_FOUND_BODY,
  authenticatedMediaUrl,
  projectAuthenticatedMapConfig,
  resolveMapRender,
  projectBranding,
  projectPointFeature,
  sanitizePublicDescription,
} from './public-communities.service.js';
import {
  INVALID_REQUEST_BODY,
  parsePublicPaginationQuery,
  parsePublicStoriesQuery,
  projectExternalMediaLink,
  projectPlaceSummary,
  projectSpeakerSummary,
  projectStoryAttachment,
} from './public-content.service.js';

const MAX_SEARCH_LENGTH = 500;
const MAX_NEAR_RADIUS_KM = 20_050;

export type CommunityReadResult<T> =
  | { status: 200; body: T }
  | { status: 400 | 403 | 404 | 500; body: { error: string } };

const forbiddenJson = (): CommunityReadResult<never> => ({
  status: 403,
  body: { ...FORBIDDEN_BODY },
});

const badRequestJson = (): CommunityReadResult<never> => ({
  status: 400,
  body: INVALID_REQUEST_BODY,
});

const notFoundJson = (): CommunityReadResult<never> => ({
  status: 404,
  body: NOT_FOUND_BODY,
});

function validateResponse<T>(
  schema: z.ZodType<T>,
  payload: unknown
): CommunityReadResult<T> {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    // Fail closed without logging candidate payloads or cultural content (§6.9).
    return { status: 500, body: { ...INTERNAL_ERROR_BODY } };
  }
  return { status: 200, body: parsed.data };
}

function parseFiniteNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

export function parseBboxParam(
  params: URLSearchParams
): CommunityBoundingBox | undefined | null {
  const values = params.getAll('bbox');
  if (values.length === 0) {
    return undefined;
  }
  if (values.length > 1) {
    return null;
  }
  const parts = values[0]!.split(',');
  if (parts.length !== 4) {
    return null;
  }
  const nums = parts.map(parseFiniteNumber);
  if (nums.some((value) => value === null)) {
    return null;
  }
  const [west, south, east, north] = nums as [number, number, number, number];
  if (
    west < -180 ||
    west > 180 ||
    east < -180 ||
    east > 180 ||
    south < -90 ||
    south > 90 ||
    north < -90 ||
    north > 90 ||
    south > north
  ) {
    return null;
  }
  return { west, south, east, north };
}

export function parseNearParam(
  params: URLSearchParams
): CommunityNearFilter | undefined | null {
  const values = params.getAll('near');
  if (values.length === 0) {
    return undefined;
  }
  if (values.length > 1) {
    return null;
  }
  const parts = values[0]!.split(',');
  if (parts.length !== 3) {
    return null;
  }
  const nums = parts.map(parseFiniteNumber);
  if (nums.some((value) => value === null)) {
    return null;
  }
  const [latitude, longitude, radiusKm] = nums as [number, number, number];
  if (
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180 ||
    radiusKm <= 0 ||
    radiusKm > MAX_NEAR_RADIUS_KM
  ) {
    return null;
  }
  return { latitude, longitude, radiusKm };
}

export function parseCommunityStoriesQuery(
  params: URLSearchParams
): CommunityStoriesQuery | null {
  const base = parsePublicStoriesQuery(params);
  if (!base) {
    return null;
  }
  const searchValues = params.getAll('search');
  if (searchValues.length > 1) {
    return null;
  }
  const search = searchValues[0];
  if (search !== undefined && search.length > MAX_SEARCH_LENGTH) {
    return null;
  }
  return search !== undefined ? { ...base, search } : base;
}

export function parseCommunityPlacesQuery(
  params: URLSearchParams
): CommunityPlacesQuery | null {
  const pagination = parsePublicPaginationQuery(params);
  if (!pagination) {
    return null;
  }
  const bbox = parseBboxParam(params);
  if (bbox === null) {
    return null;
  }
  const near = parseNearParam(params);
  if (near === null) {
    return null;
  }
  return {
    ...pagination,
    ...(bbox !== undefined ? { bbox } : {}),
    ...(near !== undefined ? { near } : {}),
  };
}

export interface CommunityReadsServiceOptions {
  mapboxAccessToken?: string;
  offlineMode?: boolean;
}

export class CommunityReadsService {
  constructor(
    private readonly repository: CommunityReadsRepository,
    private readonly options: CommunityReadsServiceOptions = {}
  ) {}

  private async authorizeCommunityCaller(actor: FoundationUser): Promise<
    | {
        ok: true;
        community: PublicCommunityRow;
        viewer: OwnCommunityReadViewer;
      }
    | { ok: false; denial: CommunityReadResult<never> }
  > {
    if (actor.role === 'super_admin' || actor.communityId === null) {
      return { ok: false, denial: forbiddenJson() };
    }
    const viewer = ownCommunityViewerForRole(actor.role);
    if (!viewer) {
      return { ok: false, denial: forbiddenJson() };
    }
    const community = await this.repository.activeCommunity(actor.communityId);
    if (!community) {
      return { ok: false, denial: forbiddenJson() };
    }
    return { ok: true, community, viewer };
  }

  private projectStorySummary(
    story: PublicStoryRecord,
    slug: string,
    origin: string,
    deps: Parameters<
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (s: any, slug: string, origin: string, deps: any) => unknown
    >[3]
  ): CommunityStorySummary {
    const visibility = storyVisibilityFromPhysical(
      story.privacyLevel,
      story.isRestricted
    );
    if (visibility === 'hidden') {
      throw new Error('Restricted story reached community read summary');
    }
    const mediaUrlFor = (fileId: string) =>
      authenticatedMediaUrl(origin, fileId);

    return {
      id: story.id,
      title: story.title,
      description: sanitizePublicDescription(story.description),
      visibility,
      topic: story.topic,
      language: story.language,
      dateInterviewed: story.dateInterviewed
        ? story.dateInterviewed.toISOString()
        : null,
      interviewLocation: deps.interviewLocation
        ? projectPlaceSummary(deps.interviewLocation)
        : null,
      interviewer: deps.interviewer
        ? projectSpeakerSummary(
            deps.interviewer,
            slug,
            origin,
            deps.birthplacesById,
            deps.speakerPhotosBySpeakerId,
            mediaUrlFor
          )
        : null,
      places: deps.places.map(projectPlaceSummary),
      speakers: deps.speakers.map(
        (speaker: Parameters<typeof projectSpeakerSummary>[0]) =>
          projectSpeakerSummary(
            speaker,
            slug,
            origin,
            deps.birthplacesById,
            deps.speakerPhotosBySpeakerId,
            mediaUrlFor
          )
      ),
      attachments: deps.attachments.map(
        (att: Parameters<typeof projectStoryAttachment>[0]) =>
          projectStoryAttachment(att, slug, origin, mediaUrlFor)
      ),
      externalMediaLinks: deps.externalLinks
        .map(projectExternalMediaLink)
        .filter(
          (
            link: PublicExternalMediaLink | null
          ): link is PublicExternalMediaLink => link !== null
        ),
      createdAt: story.createdAt.toISOString(),
      updatedAt: story.updatedAt.toISOString(),
    };
  }

  async getCommunity(
    actor: FoundationUser,
    origin: string
  ): Promise<CommunityReadResult<CommunityReadDetailResponse>> {
    const auth = await this.authorizeCommunityCaller(actor);
    if (!auth.ok) {
      return auth.denial;
    }

    const detail = await this.repository.getCommunityDetail(
      auth.community,
      auth.viewer
    );
    const canonicalState = communityFromPhysical({
      publicStories: detail.community.publicStories,
      isActive: detail.community.isActive,
    });
    if (canonicalState.status !== 'active') {
      return forbiddenJson();
    }

    const mediaUrlFor = (fileId: string) =>
      authenticatedMediaUrl(origin, fileId);
    const filters: PublicCommunityFilterOption[] = [
      ...detail.filterPlaces.map((place) => ({
        category: 'place' as const,
        value: place.id,
        label: place.name,
      })),
      ...detail.regions.map((region) => ({
        category: 'region' as const,
        value: region,
        label: region,
      })),
      ...detail.typesOfPlace.map((typeOfPlace) => ({
        category: 'typeOfPlace' as const,
        value: typeOfPlace,
        label: typeOfPlace,
      })),
      ...detail.speakers.map((speaker) => ({
        category: 'speaker' as const,
        value: speaker.id,
        label: speaker.name,
      })),
      ...detail.topics.map((topic) => ({
        category: 'topic' as const,
        value: topic,
        label: topic,
      })),
      ...detail.languages.map((language) => ({
        category: 'language' as const,
        value: language,
        label: language,
      })),
      ...detail.affiliations.map((affiliation) => ({
        category: 'affiliation' as const,
        value: affiliation,
        label: affiliation,
      })),
    ];

    return validateResponse(CommunityReadDetailResponseSchema, {
      data: {
        id: detail.community.id,
        slug: detail.community.slug,
        name: detail.community.name,
        description: sanitizePublicDescription(detail.community.description),
        locale: detail.community.locale,
        country: detail.community.country,
        visibility: canonicalState.visibility,
        status: canonicalState.status,
        branding: projectBranding(
          detail.community.slug,
          origin,
          detail.branding,
          mediaUrlFor
        ),
        mapConfig: projectAuthenticatedMapConfig(
          detail.community.slug,
          origin,
          detail.mapConfig,
          mediaUrlFor
        ),
        mapRender: resolveMapRender(detail.mapConfig, {
          instanceMapboxAccessToken: this.options.mapboxAccessToken,
          offlineMode: this.options.offlineMode,
        }),
        storiesCount: detail.storiesCount,
        points: detail.points.map(projectPointFeature),
        categories: [...PUBLIC_COMMUNITY_FILTER_CATEGORIES],
        filters,
        createdAt: detail.community.createdAt.toISOString(),
        updatedAt: detail.community.updatedAt.toISOString(),
      },
    });
  }

  async getMapConfig(
    actor: FoundationUser,
    origin: string
  ): Promise<CommunityReadResult<CommunityMapConfigResponse>> {
    const auth = await this.authorizeCommunityCaller(actor);
    if (!auth.ok) {
      return auth.denial;
    }

    const row = await this.repository.getMapConfig(auth.community.id);
    const mediaUrlFor = (fileId: string) =>
      authenticatedMediaUrl(origin, fileId);
    return validateResponse(CommunityMapConfigResponseSchema, {
      data: projectAuthenticatedMapConfig(
        auth.community.slug,
        origin,
        row,
        mediaUrlFor
      ),
      render: resolveMapRender(row, {
        instanceMapboxAccessToken: this.options.mapboxAccessToken,
        offlineMode: this.options.offlineMode,
      }),
    });
  }

  async listStories(
    actor: FoundationUser,
    searchParams: URLSearchParams,
    origin: string
  ): Promise<CommunityReadResult<CommunityStoriesListResponse>> {
    const auth = await this.authorizeCommunityCaller(actor);
    if (!auth.ok) {
      return auth.denial;
    }

    const query = parseCommunityStoriesQuery(searchParams);
    if (!query) {
      return badRequestJson();
    }

    const page = await this.repository.listStories(
      auth.community,
      query,
      auth.viewer
    );

    const stories = page.stories.map((story) =>
      this.projectStorySummary(story, auth.community.slug, origin, {
        places: page.placesByStoryId.get(story.id) ?? [],
        speakers: page.speakersByStoryId.get(story.id) ?? [],
        interviewLocation:
          story.interviewLocationId !== null
            ? (page.interviewLocationsById.get(story.interviewLocationId) ??
              null)
            : null,
        interviewer:
          story.interviewerId !== null
            ? (page.interviewersById.get(story.interviewerId) ?? null)
            : null,
        birthplacesById: page.birthplacesById,
        speakerPhotosBySpeakerId: page.speakerPhotosBySpeakerId,
        attachments: page.attachmentsByStoryId.get(story.id) ?? [],
        externalLinks: page.externalLinksByStoryId.get(story.id) ?? [],
      })
    );

    return validateResponse(CommunityStoriesListResponseSchema, {
      data: {
        points: page.points.map(projectPointFeature),
        stories,
      },
      meta: {
        total: page.total,
        limit: query.limit,
        offset: query.offset,
        hasNextPage: query.offset + stories.length < page.total,
      },
    });
  }

  async getStoryById(
    actor: FoundationUser,
    rawStoryId: string,
    origin: string
  ): Promise<CommunityReadResult<CommunityStoryDetailResponse>> {
    const auth = await this.authorizeCommunityCaller(actor);
    if (!auth.ok) {
      return auth.denial;
    }
    if (!isDatabaseIdString(rawStoryId)) {
      return notFoundJson();
    }

    const detail = await this.repository.getStoryById(
      auth.community,
      Number(rawStoryId),
      auth.viewer
    );
    if (!detail) {
      return notFoundJson();
    }

    const summary = this.projectStorySummary(
      detail.story,
      auth.community.slug,
      origin,
      {
        places: detail.places,
        speakers: detail.speakers,
        interviewLocation: detail.interviewLocation,
        interviewer: detail.interviewer,
        birthplacesById: detail.birthplacesById,
        speakerPhotosBySpeakerId: detail.speakerPhotosBySpeakerId,
        attachments: detail.attachments,
        externalLinks: detail.externalLinks,
      }
    );

    return validateResponse(CommunityStoryDetailResponseSchema, {
      data: {
        ...summary,
        points: detail.points.map(projectPointFeature),
      },
    });
  }

  async listPlaces(
    actor: FoundationUser,
    searchParams: URLSearchParams,
    origin: string
  ): Promise<CommunityReadResult<PublicPlacesListResponse>> {
    const auth = await this.authorizeCommunityCaller(actor);
    if (!auth.ok) {
      return auth.denial;
    }

    const query = parseCommunityPlacesQuery(searchParams);
    if (!query) {
      return badRequestJson();
    }

    const page = await this.repository.listPlaces(
      auth.community,
      query,
      auth.viewer
    );

    const data: PublicPlaceDetail[] = page.places.map((place) => {
      const photoIds = page.photosByPlaceId.get(place.id) ?? [];
      const audioFileId = page.placenameAudioByPlaceId.get(place.id) ?? null;
      return {
        ...projectPlaceSummary(place),
        photos: photoIds.map((fileId) => ({
          fileId,
          url: authenticatedMediaUrl(origin, fileId),
        })),
        placenameAudio: audioFileId
          ? {
              fileId: audioFileId,
              url: authenticatedMediaUrl(origin, audioFileId),
            }
          : null,
      };
    });

    return validateResponse(PublicPlacesListResponseSchema, {
      data,
      meta: {
        total: page.total,
        limit: query.limit,
        offset: query.offset,
        hasNextPage: query.offset + data.length < page.total,
      },
    });
  }

  async getPlaceById(
    actor: FoundationUser,
    rawPlaceId: string,
    origin: string
  ): Promise<CommunityReadResult<PublicPlaceDetailResponse>> {
    const auth = await this.authorizeCommunityCaller(actor);
    if (!auth.ok) {
      return auth.denial;
    }
    if (!isDatabaseIdString(rawPlaceId)) {
      return notFoundJson();
    }

    const detail = await this.repository.getPlaceById(
      auth.community,
      Number(rawPlaceId),
      auth.viewer
    );
    if (!detail) {
      return notFoundJson();
    }

    return validateResponse(PublicPlaceDetailResponseSchema, {
      data: {
        ...projectPlaceSummary(detail.place),
        photos: detail.photos.map((fileId) => ({
          fileId,
          url: authenticatedMediaUrl(origin, fileId),
        })),
        placenameAudio: detail.placenameAudioFileId
          ? {
              fileId: detail.placenameAudioFileId,
              url: authenticatedMediaUrl(origin, detail.placenameAudioFileId),
            }
          : null,
      },
    });
  }

  async listSpeakers(
    actor: FoundationUser,
    searchParams: URLSearchParams,
    origin: string
  ): Promise<CommunityReadResult<PublicSpeakersListResponse>> {
    const auth = await this.authorizeCommunityCaller(actor);
    if (!auth.ok) {
      return auth.denial;
    }

    const pagination = parsePublicPaginationQuery(searchParams);
    if (!pagination) {
      return badRequestJson();
    }

    const page = await this.repository.listSpeakers(
      auth.community,
      pagination,
      auth.viewer
    );
    const mediaUrlFor = (fileId: string) =>
      authenticatedMediaUrl(origin, fileId);
    const data: PublicSpeakerSummary[] = page.speakers.map((speaker) =>
      projectSpeakerSummary(
        speaker,
        auth.community.slug,
        origin,
        page.birthplacesById,
        page.photosBySpeakerId,
        mediaUrlFor
      )
    );

    return validateResponse(PublicSpeakersListResponseSchema, {
      data,
      meta: {
        total: page.total,
        limit: pagination.limit,
        offset: pagination.offset,
        hasNextPage: pagination.offset + data.length < page.total,
      },
    });
  }

  async getSpeakerById(
    actor: FoundationUser,
    rawSpeakerId: string,
    origin: string
  ): Promise<CommunityReadResult<PublicSpeakerDetailResponse>> {
    const auth = await this.authorizeCommunityCaller(actor);
    if (!auth.ok) {
      return auth.denial;
    }
    if (!isDatabaseIdString(rawSpeakerId)) {
      return notFoundJson();
    }

    const detail = await this.repository.getSpeakerById(
      auth.community,
      Number(rawSpeakerId),
      auth.viewer
    );
    if (!detail) {
      return notFoundJson();
    }

    const birthplacesById = detail.birthplace
      ? new Map([[detail.birthplace.id, detail.birthplace]])
      : new Map();
    const photosBySpeakerId = detail.photoFileId
      ? new Map([[detail.speaker.id, detail.photoFileId]])
      : new Map<number, string>();
    const mediaUrlFor = (fileId: string) =>
      authenticatedMediaUrl(origin, fileId);

    return validateResponse(PublicSpeakerDetailResponseSchema, {
      data: projectSpeakerSummary(
        detail.speaker,
        auth.community.slug,
        origin,
        birthplacesById,
        photosBySpeakerId,
        mediaUrlFor
      ),
    });
  }
}
