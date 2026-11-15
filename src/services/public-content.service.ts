/**
 * Canonical V2 service layer for Slice 5 unauthenticated public read routes (#145).
 *
 * Enforces:
 * - Registry error envelopes (`404 { error: 'Not found' }`, `400 { error: 'Invalid request' }`)
 * - Identical anonymous §6.4a projections for every caller (no privilege widening)
 * - Bounded Explore-compatible `limit`/`offset` pagination & multi-value filters
 * - §6.9 runtime-safe sanitised HTML descriptions on output
 * - §6.7 storage-key scoping, safe download headers, and HTTP `Range` serving
 */
import {
  validStorageKey,
  type FoundationStorage,
} from './hono-foundation.service.js';
import {
  DEFAULT_PUBLIC_PAGE_LIMIT,
  MAX_PUBLIC_FILTER_VALUES,
  MAX_PUBLIC_PAGE_LIMIT,
  MAX_PUBLIC_TOTAL_FILTER_VALUES,
  PUBLIC_STORY_SORTS,
  type PublicExternalMediaLink,
  type PublicPaginationQuery,
  type PublicPlaceDetail,
  type PublicPlaceDetailResponse,
  type PublicPlacesListResponse,
  type PublicPlaceSummary,
  type PublicSpeakerDetailResponse,
  type PublicSpeakersListResponse,
  type PublicSpeakerSummary,
  type PublicStoriesListResponse,
  type PublicStoriesQuery,
  type PublicStoryAttachment,
  type PublicStoryDetailResponse,
  type PublicStorySort,
  type PublicStorySummary,
} from '../shared/schemas/public-content.js';
import { isDatabaseIdString, MAX_DATABASE_ID } from '../shared/types/public.js';
import { sanitizeDescriptionForMigration } from '../shared/utils/safe-description.js';
import {
  NOT_FOUND_BODY,
  projectPointFeature,
  publicMediaUrl,
} from './public-communities.service.js';
import {
  PublicContentRepository,
  type PublicExternalMediaLinkRecord,
  type PublicPlaceRecord,
  type PublicSpeakerRecord,
  type PublicStoryAttachmentRecord,
  type PublicStoryRecord,
} from '../repositories/public-content.repository.js';

export type PublicContentJsonResult<T = unknown> =
  | { status: 200; body: T }
  | { status: 400; body: { error: string } }
  | { status: 404; body: { error: string } };

export const INVALID_REQUEST_BODY = Object.freeze({
  error: 'Invalid request',
}) as { error: string };

const notFoundJson = (): PublicContentJsonResult<never> => ({
  status: 404,
  body: NOT_FOUND_BODY,
});

const badRequestJson = (): PublicContentJsonResult<never> => ({
  status: 400,
  body: INVALID_REQUEST_BODY,
});

function iso(value: Date): string {
  return value.toISOString();
}

function sanitizePublicDescription(raw: string | null): string | null {
  if (raw === null) {
    return null;
  }
  try {
    return sanitizeDescriptionForMigration(raw).html;
  } catch {
    return '';
  }
}

function projectPlaceSummary(row: PublicPlaceRecord): PublicPlaceSummary {
  return {
    id: row.id,
    name: row.name,
    description: sanitizePublicDescription(row.description),
    typeOfPlace: row.typeOfPlace,
    region: row.region,
    latitude: row.latitude,
    longitude: row.longitude,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function projectSpeakerSummary(
  row: PublicSpeakerRecord,
  slug: string,
  origin: string,
  birthplacesById: Map<number, PublicPlaceRecord>,
  photosBySpeakerId: Map<number, string>
): PublicSpeakerSummary {
  const birthplaceRow =
    row.birthplaceId !== null
      ? (birthplacesById.get(row.birthplaceId) ?? null)
      : null;
  const photoFileId = photosBySpeakerId.get(row.id) ?? null;

  return {
    id: row.id,
    name: row.name,
    birthDate: row.birthDate,
    birthplace: birthplaceRow ? projectPlaceSummary(birthplaceRow) : null,
    affiliation: row.affiliation,
    photo: photoFileId
      ? {
          fileId: photoFileId,
          url: publicMediaUrl(origin, slug, photoFileId),
        }
      : null,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function projectStoryAttachment(
  row: PublicStoryAttachmentRecord,
  slug: string,
  origin: string
): PublicStoryAttachment {
  return {
    id: row.id,
    fileId: row.fileId,
    role: row.role,
    ordinal: row.ordinal,
    mimeType: row.mimeType,
    byteSize: row.byteSize,
    originalName: row.originalName,
    url: publicMediaUrl(origin, slug, row.fileId),
  };
}

function projectExternalMediaLink(
  row: PublicExternalMediaLinkRecord
): PublicExternalMediaLink {
  return {
    id: row.id,
    url: row.url,
    ordinal: row.ordinal,
    createdAt: iso(row.createdAt),
  };
}

export function parsePublicPaginationQuery(
  params: URLSearchParams
): PublicPaginationQuery | null {
  const limitRaw = params.get('limit');
  const offsetRaw = params.get('offset');

  let limit = DEFAULT_PUBLIC_PAGE_LIMIT;
  if (limitRaw !== null) {
    if (!/^\d+$/.test(limitRaw)) {
      return null;
    }
    limit = Number(limitRaw);
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MAX_PUBLIC_PAGE_LIMIT
    ) {
      return null;
    }
  }

  let offset = 0;
  if (offsetRaw !== null) {
    if (!/^\d+$/.test(offsetRaw)) {
      return null;
    }
    offset = Number(offsetRaw);
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > MAX_DATABASE_ID
    ) {
      return null;
    }
  }

  return { limit, offset };
}

export function parsePublicStoriesQuery(
  params: URLSearchParams
): PublicStoriesQuery | null {
  const pagination = parsePublicPaginationQuery(params);
  if (!pagination) {
    return null;
  }

  const readStrings = (keys: string[]): string[] | null => {
    const raw: string[] = [];
    for (const key of keys) {
      raw.push(...params.getAll(key), ...params.getAll(`${key}[]`));
    }
    if (raw.length > MAX_PUBLIC_FILTER_VALUES) {
      return null;
    }
    for (const value of raw) {
      if (value.trim().length === 0 || value.length > 500) {
        return null;
      }
    }
    return raw;
  };

  const readIds = (key: string): number[] | null => {
    const raw = readStrings([key]);
    if (raw === null) {
      return null;
    }
    const parsed: number[] = [];
    for (const value of raw) {
      if (!isDatabaseIdString(value)) {
        return null;
      }
      parsed.push(Number(value));
    }
    return parsed;
  };

  const place = readIds('place');
  const speaker = readIds('speaker');
  const region = readStrings(['region']);
  const typeOfPlace = readStrings(['typeOfPlace']);
  const topic = readStrings(['topic', 'topicNormalized']);
  const language = readStrings(['language']);
  const affiliation = readStrings(['affiliation']);

  if (
    place === null ||
    speaker === null ||
    region === null ||
    typeOfPlace === null ||
    topic === null ||
    language === null ||
    affiliation === null
  ) {
    return null;
  }

  const totalFilters =
    place.length +
    speaker.length +
    region.length +
    typeOfPlace.length +
    topic.length +
    language.length +
    affiliation.length;
  if (totalFilters > MAX_PUBLIC_TOTAL_FILTER_VALUES) {
    return null;
  }

  const sortRaw = params.get('sort');
  let sort: PublicStorySort = 'newest';
  if (sortRaw !== null) {
    if (!PUBLIC_STORY_SORTS.includes(sortRaw as PublicStorySort)) {
      return null;
    }
    sort = sortRaw as PublicStorySort;
  }

  return {
    ...(place.length > 0 ? { place } : {}),
    ...(region.length > 0 ? { region } : {}),
    ...(typeOfPlace.length > 0 ? { typeOfPlace } : {}),
    ...(topic.length > 0 ? { topic } : {}),
    ...(language.length > 0 ? { language } : {}),
    ...(speaker.length > 0 ? { speaker } : {}),
    ...(affiliation.length > 0 ? { affiliation } : {}),
    sort,
    limit: pagination.limit,
    offset: pagination.offset,
  };
}

async function readAllBytes(
  data: Uint8Array | ReadableStream<Uint8Array>
): Promise<Uint8Array> {
  if (data instanceof Uint8Array) {
    return data;
  }
  const reader = data.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

type ParsedByteRange =
  | { kind: 'none' }
  | { kind: 'unsatisfiable' }
  | { kind: 'slice'; start: number; end: number };

function parseSingleByteRange(
  rangeHeader: string | undefined,
  totalLength: number
): ParsedByteRange {
  if (!rangeHeader) {
    return { kind: 'none' };
  }
  const trimmed = rangeHeader.trim();
  if (!trimmed) {
    return { kind: 'none' };
  }
  if (!trimmed.toLowerCase().startsWith('bytes=')) {
    return { kind: 'none' };
  }
  const spec = trimmed.slice('bytes='.length).trim();
  const match = /^(\d*)-(\d*)$/.exec(spec);
  if (!match) {
    return { kind: 'unsatisfiable' };
  }
  const [, startStr, endStr] = match;
  if (startStr === '' && endStr === '') {
    return { kind: 'unsatisfiable' };
  }
  if (totalLength <= 0) {
    return { kind: 'unsatisfiable' };
  }

  if (startStr === '') {
    const suffixLength = Number(endStr);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return { kind: 'unsatisfiable' };
    }
    const start = Math.max(0, totalLength - suffixLength);
    return { kind: 'slice', start, end: totalLength - 1 };
  }

  const start = Number(startStr);
  if (!Number.isSafeInteger(start) || start < 0 || start >= totalLength) {
    return { kind: 'unsatisfiable' };
  }

  if (endStr === '') {
    return { kind: 'slice', start, end: totalLength - 1 };
  }

  const requestedEnd = Number(endStr);
  if (!Number.isSafeInteger(requestedEnd) || requestedEnd < start) {
    return { kind: 'unsatisfiable' };
  }

  return {
    kind: 'slice',
    start,
    end: Math.min(requestedEnd, totalLength - 1),
  };
}

export class PublicContentService {
  constructor(
    private readonly repository: PublicContentRepository,
    private readonly storage: FoundationStorage
  ) {}

  private projectStorySummary(
    story: PublicStoryRecord,
    slug: string,
    origin: string,
    deps: {
      places: PublicPlaceRecord[];
      speakers: PublicSpeakerRecord[];
      interviewLocation: PublicPlaceRecord | null;
      interviewer: PublicSpeakerRecord | null;
      birthplacesById: Map<number, PublicPlaceRecord>;
      speakerPhotosBySpeakerId: Map<number, string>;
      attachments: PublicStoryAttachmentRecord[];
      externalLinks: PublicExternalMediaLinkRecord[];
    }
  ): PublicStorySummary {
    return {
      id: story.id,
      title: story.title,
      description: sanitizePublicDescription(story.description),
      visibility: 'public',
      topic: story.topic,
      language: story.language,
      dateInterviewed: story.dateInterviewed
        ? iso(story.dateInterviewed)
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
            deps.speakerPhotosBySpeakerId
          )
        : null,
      places: deps.places.map(projectPlaceSummary),
      speakers: deps.speakers.map((speaker) =>
        projectSpeakerSummary(
          speaker,
          slug,
          origin,
          deps.birthplacesById,
          deps.speakerPhotosBySpeakerId
        )
      ),
      attachments: deps.attachments.map((att) =>
        projectStoryAttachment(att, slug, origin)
      ),
      externalMediaLinks: deps.externalLinks.map(projectExternalMediaLink),
      createdAt: iso(story.createdAt),
      updatedAt: iso(story.updatedAt),
    };
  }

  async listStories(
    slug: string,
    searchParams: URLSearchParams,
    origin: string
  ): Promise<PublicContentJsonResult<PublicStoriesListResponse>> {
    const query = parsePublicStoriesQuery(searchParams);
    if (!query) {
      return badRequestJson();
    }

    const page = await this.repository.listStories(slug, query);
    if (!page) {
      return notFoundJson();
    }

    const stories = page.stories.map((story) =>
      this.projectStorySummary(story, page.community.slug, origin, {
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

    const points = page.points.map((point) =>
      projectPointFeature({
        ...point,
        description: sanitizePublicDescription(point.description),
      })
    );

    return {
      status: 200,
      body: {
        data: {
          points,
          stories,
        },
        meta: {
          total: page.total,
          limit: query.limit,
          offset: query.offset,
          hasNextPage: query.offset + stories.length < page.total,
        },
      },
    };
  }

  async getStoryById(
    slug: string,
    rawStoryId: string,
    origin: string
  ): Promise<PublicContentJsonResult<PublicStoryDetailResponse>> {
    if (!isDatabaseIdString(rawStoryId)) {
      return notFoundJson();
    }

    const detail = await this.repository.getStoryById(slug, Number(rawStoryId));
    if (!detail) {
      return notFoundJson();
    }

    const summary = this.projectStorySummary(
      detail.story,
      detail.community.slug,
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

    const points = detail.points.map((point) =>
      projectPointFeature({
        ...point,
        description: sanitizePublicDescription(point.description),
      })
    );

    return {
      status: 200,
      body: {
        data: {
          ...summary,
          points,
        },
      },
    };
  }

  async listPlaces(
    slug: string,
    searchParams: URLSearchParams,
    origin: string
  ): Promise<PublicContentJsonResult<PublicPlacesListResponse>> {
    const pagination = parsePublicPaginationQuery(searchParams);
    if (!pagination) {
      return badRequestJson();
    }

    const page = await this.repository.listPlaces(slug, pagination);
    if (!page) {
      return notFoundJson();
    }

    const data: PublicPlaceDetail[] = page.places.map((place) => {
      const photoIds = page.photosByPlaceId.get(place.id) ?? [];
      const audioFileId = page.placenameAudioByPlaceId.get(place.id) ?? null;
      return {
        ...projectPlaceSummary(place),
        photos: photoIds.map((fileId) => ({
          fileId,
          url: publicMediaUrl(origin, page.community.slug, fileId),
        })),
        placenameAudio: audioFileId
          ? {
              fileId: audioFileId,
              url: publicMediaUrl(origin, page.community.slug, audioFileId),
            }
          : null,
      };
    });

    return {
      status: 200,
      body: {
        data,
        meta: {
          total: page.total,
          limit: pagination.limit,
          offset: pagination.offset,
          hasNextPage: pagination.offset + data.length < page.total,
        },
      },
    };
  }

  async getPlaceById(
    slug: string,
    rawPlaceId: string,
    origin: string
  ): Promise<PublicContentJsonResult<PublicPlaceDetailResponse>> {
    if (!isDatabaseIdString(rawPlaceId)) {
      return notFoundJson();
    }

    const detail = await this.repository.getPlaceById(slug, Number(rawPlaceId));
    if (!detail) {
      return notFoundJson();
    }

    return {
      status: 200,
      body: {
        data: {
          ...projectPlaceSummary(detail.place),
          photos: detail.photos.map((fileId) => ({
            fileId,
            url: publicMediaUrl(origin, detail.community.slug, fileId),
          })),
          placenameAudio: detail.placenameAudioFileId
            ? {
                fileId: detail.placenameAudioFileId,
                url: publicMediaUrl(
                  origin,
                  detail.community.slug,
                  detail.placenameAudioFileId
                ),
              }
            : null,
        },
      },
    };
  }

  async listSpeakers(
    slug: string,
    searchParams: URLSearchParams,
    origin: string
  ): Promise<PublicContentJsonResult<PublicSpeakersListResponse>> {
    const pagination = parsePublicPaginationQuery(searchParams);
    if (!pagination) {
      return badRequestJson();
    }

    const page = await this.repository.listSpeakers(slug, pagination);
    if (!page) {
      return notFoundJson();
    }

    const data: PublicSpeakerSummary[] = page.speakers.map((speaker) =>
      projectSpeakerSummary(
        speaker,
        page.community.slug,
        origin,
        page.birthplacesById,
        page.photosBySpeakerId
      )
    );

    return {
      status: 200,
      body: {
        data,
        meta: {
          total: page.total,
          limit: pagination.limit,
          offset: pagination.offset,
          hasNextPage: pagination.offset + data.length < page.total,
        },
      },
    };
  }

  async getSpeakerById(
    slug: string,
    rawSpeakerId: string,
    origin: string
  ): Promise<PublicContentJsonResult<PublicSpeakerDetailResponse>> {
    if (!isDatabaseIdString(rawSpeakerId)) {
      return notFoundJson();
    }

    const detail = await this.repository.getSpeakerById(
      slug,
      Number(rawSpeakerId)
    );
    if (!detail) {
      return notFoundJson();
    }

    return {
      status: 200,
      body: {
        data: {
          id: detail.speaker.id,
          name: detail.speaker.name,
          birthDate: detail.speaker.birthDate,
          birthplace: detail.birthplace
            ? projectPlaceSummary(detail.birthplace)
            : null,
          affiliation: detail.speaker.affiliation,
          photo: detail.photoFileId
            ? {
                fileId: detail.photoFileId,
                url: publicMediaUrl(
                  origin,
                  detail.community.slug,
                  detail.photoFileId
                ),
              }
            : null,
          createdAt: iso(detail.speaker.createdAt),
          updatedAt: iso(detail.speaker.updatedAt),
        },
      },
    };
  }

  async serveMedia(
    slug: string,
    fileId: string,
    rangeHeader: string | undefined
  ): Promise<Response | null> {
    const file = await this.repository.getAuthorizedPublicMediaFile(
      slug,
      fileId
    );
    if (!file) {
      return null;
    }

    if (
      !validStorageKey(file.storageKey) ||
      !file.storageKey.startsWith(`communities/${file.communityId}/`)
    ) {
      return null;
    }

    const stored = await this.storage.read(file.storageKey);
    if (!stored) {
      return null;
    }

    const fullBytes = await readAllBytes(stored);
    const totalLength = fullBytes.byteLength;
    const range = parseSingleByteRange(rangeHeader, totalLength);

    const baseHeaders = {
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    };

    if (range.kind === 'unsatisfiable') {
      return new Response(null, {
        status: 416,
        headers: {
          ...baseHeaders,
          'Content-Range': `bytes */${totalLength}`,
        },
      });
    }

    if (range.kind === 'slice') {
      const slice = fullBytes.slice(range.start, range.end + 1);
      return new Response(slice, {
        status: 206,
        headers: {
          ...baseHeaders,
          'Content-Type': file.mimeType,
          'Content-Disposition': 'attachment',
          'Content-Range': `bytes ${range.start}-${range.end}/${totalLength}`,
          'Content-Length': String(slice.byteLength),
        },
      });
    }

    return new Response(new Uint8Array(fullBytes), {
      status: 200,
      headers: {
        ...baseHeaders,
        'Content-Type': file.mimeType,
        'Content-Disposition': 'attachment',
        'Content-Length': String(totalLength),
      },
    });
  }
}
