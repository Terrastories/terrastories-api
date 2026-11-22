/**
 * Service layer for canonical V2 `/v2/public/communities*` endpoints (#145).
 *
 * Enforces anonymous §6.4a projections regardless of caller session/role,
 * derives `visibility`/`status` from `canonical-state.ts`, strips unsafe or
 * credential-bearing map styles, validates responses against the Zod contracts,
 * and returns a uniform `{ error: 'Not found' }` 404 for missing, private, or
 * disabled communities.
 */
import { communityFromPhysical } from '../policy/canonical-state.js';
import {
  hasCredentialQueryParam,
  sanitizeMapboxStyleUrl,
  sanitizePublicMapboxToken,
} from '../shared/utils/map-config.js';
import { sanitizeDescriptionForMigration } from '../shared/utils/safe-description.js';
import type {
  CommunityMapConfig,
  CommunityMapRender,
} from '../shared/schemas/community-reads.js';
import {
  PublicCommunitiesRepository,
  type PublicCommunityBrandingRow,
  type PublicCommunityRow,
  type PublicMapConfigRow,
  type PublicPlaceRow,
} from '../repositories/public-communities.repository.js';
import {
  PUBLIC_COMMUNITY_FILTER_CATEGORIES,
  PublicCommunitiesListResponseSchema,
  PublicCommunityDetailResponseSchema,
  type PublicCommunitiesListResponse,
  type PublicCommunityBranding,
  type PublicCommunityDetailResponse,
  type PublicCommunityFilterOption,
  type PublicCommunityMapConfig,
  type PublicCommunitySummary,
  type PublicMapPointFeature,
  type V2ErrorResponse,
} from '../shared/schemas/public-communities.js';

export type PublicCommunitiesResult<T> =
  | { status: 200; body: T }
  | { status: 400 | 404 | 500; body: V2ErrorResponse };

export const NOT_FOUND_BODY: V2ErrorResponse = Object.freeze({
  error: 'Not found',
});

export const FORBIDDEN_BODY: V2ErrorResponse = Object.freeze({
  error: 'Forbidden',
});

export const BAD_REQUEST_BODY: V2ErrorResponse = Object.freeze({
  error: 'Invalid request',
});

export const INTERNAL_ERROR_BODY: V2ErrorResponse = Object.freeze({
  error: 'Internal server error',
});

/**
 * Sanitise a public description string for HTML output (SPEC-V2 §6.9).
 *
 * Legacy descriptions exceeding the 20,000 code-point write limit are still
 * served sanitised here (`sanitizeDescriptionForMigration` applies only the
 * memory-guard ceiling; the 20,000 code-point cap is a write-path rule).
 * Raw or sanitised content is never logged on error.
 */
export function sanitizePublicDescription(raw: string | null): string | null {
  if (raw === null) {
    return null;
  }
  try {
    return sanitizeDescriptionForMigration(raw).html;
  } catch {
    return '';
  }
}

/**
 * Serves `styleUrl` publicly only when it is a credential-free `http:`/`https:`
 * URL (`SPEC-V2.md` §6.6). `mapbox://`, embedded userinfo, and token/key query
 * parameters are withheld as `null`.
 */
export function sanitizePublicStyleUrl(styleUrl: string | null): string | null {
  if (!styleUrl) return null;
  let parsed: URL;
  try {
    parsed = new URL(styleUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return null;
  }
  // A fragment can carry credentials (#access_token=...) and is never needed
  // to fetch a style document, so any fragment withholds the URL.
  if (parsed.hash !== '') {
    return null;
  }
  if (hasCredentialQueryParam(parsed)) {
    return null;
  }
  return styleUrl;
}

export function publicMediaUrl(
  origin: string,
  slug: string,
  fileId: string
): string {
  return `${origin}/v2/public/communities/${encodeURIComponent(slug)}/media/${encodeURIComponent(fileId)}`;
}

export function authenticatedMediaUrl(origin: string, fileId: string): string {
  return `${origin}/v2/media/${encodeURIComponent(fileId)}`;
}

export function projectBranding(
  slug: string,
  origin: string,
  row: PublicCommunityBrandingRow | undefined,
  mediaUrlFor: (fileId: string) => string = (fileId) =>
    publicMediaUrl(origin, slug, fileId)
): PublicCommunityBranding {
  return {
    displayImage: row?.displayImageFileId
      ? {
          fileId: row.displayImageFileId,
          url: mediaUrlFor(row.displayImageFileId),
        }
      : null,
    backgroundImage: row?.backgroundImageFileId
      ? {
          fileId: row.backgroundImageFileId,
          url: mediaUrlFor(row.backgroundImageFileId),
        }
      : null,
    sponsorLogos: (row?.sponsorLogos ?? []).map((logo) => ({
      fileId: logo.fileId,
      ordinal: logo.ordinal,
      url: mediaUrlFor(logo.fileId),
    })),
  };
}

export function projectMapConfig(
  slug: string,
  origin: string,
  row: PublicMapConfigRow | undefined | null,
  mediaUrlFor: (fileId: string) => string = (fileId) =>
    publicMediaUrl(origin, slug, fileId),
  options: { offlineMode?: boolean } = {}
): PublicCommunityMapConfig | null {
  if (!row) return null;
  const staticMapFileId = row.staticMapFileId;
  const canExposeMapbox =
    options.offlineMode !== true && row.exposeMapboxCredentials === true;
  const exposedToken = canExposeMapbox
    ? sanitizePublicMapboxToken(row.mapboxAccessToken)
    : null;
  const exposedStyle =
    canExposeMapbox && exposedToken !== null
      ? sanitizeMapboxStyleUrl(row.mapboxStyleUrl)
      : null;
  return {
    styleUrl: sanitizePublicStyleUrl(row.styleUrl),
    basemapStyle: row.basemapStyle,
    mapboxStyleUrl: exposedStyle,
    mapboxAccessToken: exposedStyle !== null ? exposedToken : null,
    mapbox3d: Boolean(row.mapbox3d),
    // Rails parity: the protomaps key is an origin-restricted public key that
    // Rails embeds in the public style URL (?key=). Offline never exposes it.
    protomapsApiKey:
      options.offlineMode === true ? null : (row.protomapsApiKey ?? null),
    protomapsBasemapStyle: row.protomapsBasemapStyle,
    centerLatitude: row.centerLatitude,
    centerLongitude: row.centerLongitude,
    southWestLatitude: row.southWestLatitude,
    southWestLongitude: row.southWestLongitude,
    northEastLatitude: row.northEastLatitude,
    northEastLongitude: row.northEastLongitude,
    zoom: row.zoom,
    pitch: row.pitch,
    bearing: row.bearing,
    threeDimensional: row.threeDimensional,
    projection: row.projection,
    staticMapFileId,
    staticMapUrl: staticMapFileId ? mediaUrlFor(staticMapFileId) : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface AuthenticatedMapConfigProjectionOptions {
  instanceMapboxAccessToken?: string;
  offlineMode?: boolean;
}

/**
 * Resolves what a map client should render with: the community's own
 * style/token when set, else the instance MAPBOX_ACCESS_TOKEN fallback.
 * Offline suppresses everything. The result is derived, never persisted.
 */
export function resolveMapRender(
  row: PublicMapConfigRow | undefined | null,
  options: AuthenticatedMapConfigProjectionOptions = {}
): CommunityMapRender {
  if (options.offlineMode === true) {
    return { mapboxStyleUrl: null, mapboxAccessToken: null, source: 'none' };
  }
  const communityToken = sanitizePublicMapboxToken(row?.mapboxAccessToken);
  const style = sanitizeMapboxStyleUrl(row?.mapboxStyleUrl);
  if (communityToken !== null) {
    return {
      mapboxStyleUrl: style,
      mapboxAccessToken: communityToken,
      source: 'community',
    };
  }
  const instanceToken = sanitizePublicMapboxToken(
    options.instanceMapboxAccessToken
  );
  if (instanceToken !== null) {
    return {
      mapboxStyleUrl: style,
      mapboxAccessToken: instanceToken,
      source: 'instance',
    };
  }
  return { mapboxStyleUrl: null, mapboxAccessToken: null, source: 'none' };
}

/**
 * Authenticated read: the community's stored fields exactly as persisted (so
 * an edit form can round-trip them). The instance token fallback is NEVER
 * merged in here; see resolveMapRender for the render block.
 */
export function projectAuthenticatedMapConfig(
  slug: string,
  origin: string,
  row: PublicMapConfigRow | undefined | null,
  mediaUrlFor: (fileId: string) => string = (fileId) =>
    publicMediaUrl(origin, slug, fileId)
): CommunityMapConfig | null {
  if (!row) return null;
  const staticMapFileId = row.staticMapFileId;
  return {
    styleUrl: sanitizePublicStyleUrl(row.styleUrl),
    basemapStyle: row.basemapStyle,
    mapboxStyleUrl: sanitizeMapboxStyleUrl(row.mapboxStyleUrl),
    mapboxAccessToken: sanitizePublicMapboxToken(row.mapboxAccessToken),
    exposeMapboxCredentials: Boolean(row.exposeMapboxCredentials),
    mapbox3d: Boolean(row.mapbox3d),
    protomapsApiKey: row.protomapsApiKey,
    protomapsBasemapStyle: row.protomapsBasemapStyle,
    centerLatitude: row.centerLatitude,
    centerLongitude: row.centerLongitude,
    southWestLatitude: row.southWestLatitude,
    southWestLongitude: row.southWestLongitude,
    northEastLatitude: row.northEastLatitude,
    northEastLongitude: row.northEastLongitude,
    zoom: row.zoom,
    pitch: row.pitch,
    bearing: row.bearing,
    threeDimensional: row.threeDimensional,
    projection: row.projection,
    staticMapFileId,
    staticMapUrl: staticMapFileId ? mediaUrlFor(staticMapFileId) : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function projectSummary(
  community: PublicCommunityRow,
  origin: string,
  branding: PublicCommunityBrandingRow | undefined,
  mapConfig: PublicMapConfigRow | undefined | null,
  offlineMode = false
): PublicCommunitySummary {
  const canonicalState = communityFromPhysical({
    publicStories: community.publicStories,
    isActive: community.isActive,
  });
  if (
    canonicalState.visibility !== 'public' ||
    canonicalState.status !== 'active'
  ) {
    throw new Error('Non-public or inactive community reached public summary');
  }
  return {
    id: community.id,
    slug: community.slug,
    name: community.name,
    description: sanitizePublicDescription(community.description),
    locale: community.locale,
    country: community.country,
    visibility: canonicalState.visibility,
    status: canonicalState.status,
    branding: projectBranding(community.slug, origin, branding),
    mapConfig: projectMapConfig(community.slug, origin, mapConfig, undefined, {
      offlineMode,
    }),
    createdAt: community.createdAt.toISOString(),
    updatedAt: community.updatedAt.toISOString(),
  };
}

export function projectPointFeature(
  place: PublicPlaceRow
): PublicMapPointFeature {
  return {
    type: 'Feature',
    id: place.id,
    geometry: {
      type: 'Point',
      coordinates: [place.longitude, place.latitude],
    },
    properties: {
      name: place.name,
      description: sanitizePublicDescription(place.description),
      region: place.region,
      typeOfPlace: place.typeOfPlace,
    },
  };
}

export class PublicCommunitiesService {
  constructor(
    readonly repository: PublicCommunitiesRepository,
    private readonly options: { offlineMode?: boolean } = {}
  ) {}

  async listCommunities(
    search: string | undefined,
    origin: string
  ): Promise<PublicCommunitiesResult<PublicCommunitiesListResponse>> {
    const [communities, mapConfigs, brandings] = await Promise.all([
      this.repository.publicCommunities(search),
      this.repository.publicCommunityMapConfigs(),
      this.repository.publicCommunityBrandings(),
    ]);

    const parsed = PublicCommunitiesListResponseSchema.safeParse({
      data: communities.map((community) =>
        projectSummary(
          community,
          origin,
          brandings.get(community.id),
          mapConfigs.get(community.id),
          this.options.offlineMode === true
        )
      ),
    });
    if (!parsed.success) {
      return { status: 500, body: { ...INTERNAL_ERROR_BODY } };
    }

    return { status: 200, body: parsed.data };
  }

  async getCommunityBySlug(
    slug: string,
    origin: string
  ): Promise<PublicCommunitiesResult<PublicCommunityDetailResponse>> {
    const community = await this.repository.publicCommunityBySlug(slug);
    if (!community) {
      return { status: 404, body: { ...NOT_FOUND_BODY } };
    }

    const [
      mapConfig,
      branding,
      storiesCount,
      places,
      filterPlaces,
      regions,
      typesOfPlace,
      speakers,
      topics,
      languages,
      affiliations,
    ] = await Promise.all([
      this.repository.communityMapConfig(community.id),
      this.repository.communityBranding(community.id),
      this.repository.publicStoriesCount(community.id),
      this.repository.publicPlacesOfCommunityStories(community.id),
      this.repository.filterPlaces(community.id),
      this.repository.filterRegions(community.id),
      this.repository.filterTypesOfPlace(community.id),
      this.repository.filterSpeakers(community.id),
      this.repository.filterTopics(community.id),
      this.repository.filterLanguages(community.id),
      this.repository.filterAffiliations(community.id),
    ]);

    const filters: PublicCommunityFilterOption[] = [
      ...filterPlaces.map((place) => ({
        category: 'place' as const,
        value: place.id,
        label: place.name,
      })),
      ...regions.map((region) => ({
        category: 'region' as const,
        value: region,
        label: region,
      })),
      ...typesOfPlace.map((typeOfPlace) => ({
        category: 'typeOfPlace' as const,
        value: typeOfPlace,
        label: typeOfPlace,
      })),
      ...speakers.map((speaker) => ({
        category: 'speaker' as const,
        value: speaker.id,
        label: speaker.name,
      })),
      ...topics.map((topic) => ({
        category: 'topic' as const,
        value: topic,
        label: topic,
      })),
      ...languages.map((language) => ({
        category: 'language' as const,
        value: language,
        label: language,
      })),
      ...affiliations.map((affiliation) => ({
        category: 'affiliation' as const,
        value: affiliation,
        label: affiliation,
      })),
    ];

    const parsed = PublicCommunityDetailResponseSchema.safeParse({
      data: {
        ...projectSummary(
          community,
          origin,
          branding,
          mapConfig,
          this.options.offlineMode === true
        ),
        storiesCount,
        points: places.map(projectPointFeature),
        categories: [...PUBLIC_COMMUNITY_FILTER_CATEGORIES],
        filters,
      },
    });
    if (!parsed.success) {
      return { status: 500, body: { ...INTERNAL_ERROR_BODY } };
    }

    return { status: 200, body: parsed.data };
  }
}
