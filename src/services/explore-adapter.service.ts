/**
 * Rails-shaped response construction for the transitional Explore read
 * adapter (#198). The Explore client (explore-terrastories) consumes the
 * legacy Rails JSON envelopes (jbuilder views under rails/app/views/api/);
 * this service reproduces those shapes from V2 data and applies the same
 * sovereignty rules as the canonical API (docs/SPEC-V2.md §9):
 *
 * - public projections only — a session cookie never widens access;
 * - restricted rows (`isRestricted`) and unknown privacy levels are never
 *   exposed; withheld ids answer the same 404 as missing ids;
 * - place/speaker visibility per the §6.4a decision table;
 * - provider credentials (`mapboxAccessToken`) are never exposed (SPEC §6.6
 *   and NEVER_EXPOSED_FIELDS_BY_FAMILY.themes).
 *
 * Fields the V2 schema deliberately does not carry (topic, typeOfPlace,
 * speakerCommunity, birthdate, sponsor logos, story media URLs, place
 * photo/name-audio) are emitted as Rails-shaped nulls/omitted and documented
 * in docs/EXPLORE-ADAPTER.md — never fabricated from unclassified V1 media
 * columns (SPEC Appendix A.8).
 */
import {
  ExploreAdapterRepository,
  type ExplorePlaceRow,
  type ExploreThemeRow,
} from '../repositories/explore-adapter.repository.js';
import { MAX_DATABASE_ID } from '../shared/types/public.js';

/** Rails `Community::FILTERABLE_ATTRIBUTES`, served verbatim. */
export const EXPLORE_FILTERABLE_ATTRIBUTES = [
  'places',
  'region',
  'type_of_place',
  'speakers',
  'topic',
  'language',
  'speaker_community',
] as const;

export interface ExploreFilterOption {
  label: string;
  value: string | number;
  category: string;
}

export type ExploreResult =
  | { status: 200; body: unknown }
  | { status: 400; body: { error: string } }
  | { status: 404; body: { error: string; message?: string } };

const notFoundBody = Object.freeze({
  error: 'Not Found',
  message: 'The requested resource could not be found.',
}) as { error: string; message: string };
const communityNotFound = Object.freeze({
  error: 'Community Not Found',
}) as { error: string };

const notFound = (): ExploreResult => ({ status: 404, body: notFoundBody });
const iso = (value: Date) => value.toISOString();

/**
 * Rails `Theme#map_style_url`/`use_maplibre?`: a style is served publicly
 * only when it is usable without provider credentials — an http(s) URL. A
 * `mapbox://` style needs the token V2 never exposes, so it is withheld and
 * the client falls back to its configured default style.
 */
const publicStyleUrl = (theme: ExploreThemeRow | null): string | null => {
  const url = theme?.mapboxStyleUrl;
  return url && /^https?:\/\//i.test(url) ? url : null;
};

const mediaUrl = (origin: string, fileId: string) =>
  `${origin}/explore/media/${fileId}`;

/** MapConfig shared by the community card and detail (Rails jbuilder shape). */
function baseMapConfig(theme: ExploreThemeRow | null) {
  return {
    mapboxAccessToken: null,
    mapboxStyle: publicStyleUrl(theme),
    mapbox3dEnabled: false,
    mapProjection: null,
    center: [theme?.centerLong ?? null, theme?.centerLat ?? null],
    zoom: null,
    pitch: null,
    bearing: null,
  };
}

/** Extended MapConfig fields only the community detail (show) carries. */
function detailMapConfig(theme: ExploreThemeRow | null) {
  const sw =
    theme?.swBoundaryLong != null && theme?.swBoundaryLat != null
      ? [theme.swBoundaryLong, theme.swBoundaryLat]
      : null;
  const ne =
    theme?.neBoundaryLong != null && theme?.neBoundaryLat != null
      ? [theme.neBoundaryLong, theme.neBoundaryLat]
      : null;
  return {
    ...baseMapConfig(theme),
    centerLat: theme?.centerLat ?? null,
    centerLong: theme?.centerLong ?? null,
    swBoundaryLat: theme?.swBoundaryLat ?? null,
    swBoundaryLong: theme?.swBoundaryLong ?? null,
    neBoundaryLat: theme?.neBoundaryLat ?? null,
    neBoundaryLong: theme?.neBoundaryLong ?? null,
    maxBounds: sw && ne ? [sw, ne] : null,
  };
}

/**
 * Rails `Place#public_point_feature`: a GeoJSON feature keyed by place id
 * whose properties carry the Explore popup fields. Media properties stay
 * null — V2 serves no place photo/name-audio on the public surface yet.
 */
function pointFeature(place: ExplorePlaceRow) {
  return {
    type: 'Feature',
    id: place.id,
    geometry: {
      type: 'Point',
      coordinates: [place.longitude, place.latitude],
    },
    properties: {
      name: place.name,
      description: place.description,
      placenameAudio: null,
      photo: null,
      thumbnail: null,
      region: place.region,
      typeOfPlace: null,
    },
  };
}

/** Rails story-show `center` feature: geometry + id, no properties. */
function centerFeature(place: {
  id: number;
  latitude: number;
  longitude: number;
}) {
  return {
    type: 'Feature',
    id: place.id,
    geometry: {
      type: 'Point',
      coordinates: [place.longitude, place.latitude],
    },
    properties: null,
  };
}

export interface ParsedStoriesQuery {
  ok: true;
  placeIds?: number[];
  regions?: string[];
  languages?: string[];
  speakerIds?: number[];
  /** A filter category with no V2 representation: any value matches nothing. */
  unsatisfiable: boolean;
  /** Raw filter echo carried into `meta.nextPageMeta` (Rails `Page#meta`). */
  echo: Record<string, string[] | number[]>;
  sortBy: 'created_at' | 'title';
  sortDir: 'asc' | 'desc';
  limit: number;
  offset: number;
}

/** Upper bound on values per filter category (bounded SQL parameter lists). */
const MAX_FILTER_VALUES = 50;
/**
 * Upper bound on filter values across ALL categories: the story query binds
 * every filter value plus its gate/pagination parameters, and D1 caps a
 * query at ~100 bound parameters, so the combined filter payload stays well
 * under that (docs/EXPLORE-ADAPTER.md).
 */
const MAX_TOTAL_FILTER_VALUES = 60;

/**
 * Parse the recorded Explore client query shape (Rails `story_params`).
 * Invalid values answer 400 — an intentional IMPROVE over Rails, which
 * coerced or crashed. Id filters are bounded to 1..MAX_DATABASE_ID, every
 * filter list to MAX_FILTER_VALUES, and the combined filter payload to
 * MAX_TOTAL_FILTER_VALUES across all categories, so query filters can never
 * produce an `IN (...)` list that pushes a query past D1/SQLite's ~100
 * bound-parameter limit. `places[]`/`places` spellings are both accepted
 * because axios serializes arrays with brackets.
 */
export function parseStoriesQuery(
  params: URLSearchParams
): ParsedStoriesQuery | { ok: false } {
  // null marks invalid input (bad id, or a list over the size cap).
  const stringFilter = (key: string): string[] | null => {
    const raw = [...params.getAll(key), ...params.getAll(`${key}[]`)];
    return raw.length > MAX_FILTER_VALUES ? null : raw;
  };
  const intFilter = (key: string): number[] | null => {
    const raw = stringFilter(key);
    if (raw === null) return null;
    const parsed: number[] = [];
    for (const value of raw) {
      // Same bounds as isDatabaseIdString: an out-of-range id cannot exist
      // on either backend, so it is invalid input, not a filter value.
      if (
        !/^\d+$/.test(value) ||
        Number(value) < 1 ||
        Number(value) > MAX_DATABASE_ID
      )
        return null;
      parsed.push(Number(value));
    }
    return parsed;
  };
  const places = intFilter('places');
  const speakers = intFilter('speakers');
  const regions = stringFilter('region');
  const languages = stringFilter('language');
  const topic = stringFilter('topic');
  const typeOfPlace = stringFilter('type_of_place');
  const speakerCommunity = stringFilter('speaker_community');
  if (
    places === null ||
    speakers === null ||
    regions === null ||
    languages === null ||
    topic === null ||
    typeOfPlace === null ||
    speakerCommunity === null
  )
    return { ok: false as const };
  // Combined cap: every filter value becomes a bound parameter of the same
  // story query, so the total payload must stay inside the D1 envelope
  // regardless of how the categories are combined.
  if (
    places.length +
      regions.length +
      languages.length +
      speakers.length +
      topic.length +
      typeOfPlace.length +
      speakerCommunity.length >
    MAX_TOTAL_FILTER_VALUES
  )
    return { ok: false as const };
  const limitRaw = params.get('limit');
  const offsetRaw = params.get('offset');
  const limit = limitRaw === null ? 10 : Number(limitRaw);
  const offset = offsetRaw === null ? 0 : Number(offsetRaw);
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isInteger(offset) ||
    offset < 0
  )
    return { ok: false as const };
  const sortByRaw = params.get('sort_by');
  const sortDirRaw = params.get('sort_dir');
  const sortBy =
    sortByRaw === null ? 'created_at' : (sortByRaw as 'created_at' | 'title');
  const sortDir = sortDirRaw === null ? 'desc' : (sortDirRaw as 'asc' | 'desc');
  if (sortBy !== 'created_at' && sortBy !== 'title') return { ok: false };
  if (sortDir !== 'asc' && sortDir !== 'desc') return { ok: false };
  const echo: Record<string, string[] | number[]> = {};
  if (places.length) echo.places = places;
  if (regions.length) echo.region = regions;
  if (languages.length) echo.language = languages;
  if (speakers.length) echo.speakers = speakers;
  const unsatisfiable =
    topic.length > 0 || typeOfPlace.length > 0 || speakerCommunity.length > 0;
  if (unsatisfiable) {
    if (topic.length) echo.topic = topic;
    if (typeOfPlace.length) echo.type_of_place = typeOfPlace;
    if (speakerCommunity.length) echo.speaker_community = speakerCommunity;
  }
  return {
    ok: true,
    placeIds: places.length ? places : undefined,
    regions: regions.length ? regions : undefined,
    languages: languages.length ? languages : undefined,
    speakerIds: speakers.length ? speakers : undefined,
    unsatisfiable,
    echo,
    sortBy,
    sortDir,
    limit,
    offset,
  };
}

export class ExploreAdapterService {
  constructor(readonly repository: ExploreAdapterRepository) {}

  /** GET /explore/communities — Rails api/communities#index envelope. */
  async communitiesIndex(
    search: string | undefined,
    origin: string
  ): Promise<ExploreResult> {
    const communities = await this.repository.publicCommunities(search);
    const cards = [];
    for (const community of communities) {
      const [branding, theme] = await Promise.all([
        this.repository.brandingFileForCommunity(community.id),
        this.repository.activeTheme(community.id),
      ]);
      cards.push({
        name: community.name,
        description: community.description,
        slug: community.slug,
        createdAt: iso(community.createdAt),
        updatedAt: iso(community.updatedAt),
        ...(branding
          ? { displayImage: mediaUrl(origin, branding.fileId) }
          : {}),
        mapConfig: baseMapConfig(theme),
      });
    }
    return { status: 200, body: { data: cards } };
  }

  /** GET /explore/communities/:slug — Rails api/communities#show envelope. */
  async communityShow(slug: string, origin: string): Promise<ExploreResult> {
    const community = await this.repository.publicCommunityBySlug(slug);
    if (!community) return { status: 404, body: communityNotFound };
    const [
      branding,
      theme,
      storiesCount,
      places,
      filterPlaces,
      regions,
      languages,
      speakers,
    ] = await Promise.all([
      this.repository.brandingFileForCommunity(community.id),
      this.repository.activeTheme(community.id),
      this.repository.publicStoriesCount(community.id),
      this.repository.publicPlacesOfCommunityStories(community.id),
      this.repository.filterPlaces(community.id),
      this.repository.filterRegions(community.id),
      this.repository.filterLanguages(community.id),
      this.repository.filterSpeakers(community.id),
    ]);
    const filters: ExploreFilterOption[] = [
      ...filterPlaces.map((place) => ({
        label: place.name,
        value: place.id,
        category: 'places',
      })),
      ...regions.map((region) => ({
        label: region,
        value: region,
        category: 'region',
      })),
      ...languages.map((language) => ({
        label: language,
        value: language,
        category: 'language',
      })),
      ...speakers.map((speaker) => ({
        value: speaker.id,
        label: speaker.name,
        category: 'speakers',
      })),
    ];
    return {
      status: 200,
      body: {
        data: {
          name: community.name,
          slug: community.slug,
          description: community.description,
          details: {
            name: community.name,
            description: community.description,
            sponsorLogos: [],
            ...(branding
              ? { displayImage: mediaUrl(origin, branding.fileId) }
              : {}),
          },
          storiesCount,
          points: places.map(pointFeature),
          categories: [...EXPLORE_FILTERABLE_ATTRIBUTES],
          filters,
          mapConfig: detailMapConfig(theme),
        },
      },
    };
  }

  /** GET /explore/communities/:slug/stories — Rails api/stories#index. */
  async storiesIndex(
    slug: string,
    query: ParsedStoriesQuery
  ): Promise<ExploreResult> {
    const community = await this.repository.publicCommunityBySlug(slug);
    if (!community) return notFound();
    const hasNext = (total: number) => query.offset + query.limit < total;
    if (query.unsatisfiable) {
      // topic/type_of_place/speaker_community have no V2 representation;
      // Rails semantics for a value absent from the data: nothing matches.
      return {
        status: 200,
        body: {
          data: { points: [], stories: [] },
          meta: {
            total: 0,
            hasNextPage: false,
            nextPageMeta: {
              ...query.echo,
              sort_by: query.sortBy,
              sort_dir: query.sortDir,
              limit: query.limit,
              offset: null,
            },
          },
        },
      };
    }
    const [{ rows, total }, places] = await Promise.all([
      this.repository.publicStoryPage(community.id, query),
      this.repository.publicPlacesOfFilteredStories(community.id, query),
    ]);
    return {
      status: 200,
      body: {
        data: {
          points: places.map(pointFeature),
          stories: rows.map((story) => ({
            id: story.id,
            title: story.title,
            topic: null,
            desc: story.description,
            language: story.language,
            createdAt: iso(story.createdAt),
            updatedAt: iso(story.updatedAt),
          })),
        },
        meta: {
          total,
          hasNextPage: hasNext(total),
          nextPageMeta: {
            ...query.echo,
            sort_by: query.sortBy,
            sort_dir: query.sortDir,
            limit: query.limit,
            offset: hasNext(total) ? query.offset + query.limit : null,
          },
        },
      },
    };
  }

  /** GET /explore/communities/:slug/stories/:storyId — api/stories#show. */
  async storyShow(slug: string, storyId: number): Promise<ExploreResult> {
    const community = await this.repository.publicCommunityBySlug(slug);
    if (!community) return notFound();
    // A withheld story answers the same 404 as a missing one.
    const story = await this.repository.publicStoryById(community.id, storyId);
    if (!story) return notFound();
    const [places, speakers] = await Promise.all([
      this.repository.storyPlaces(community.id, story.id),
      this.repository.storySpeakers(community.id, story.id),
    ]);
    const interviewer = story.interviewerId
      ? await this.repository.interviewer(community.id, story.interviewerId)
      : null;
    const interviewLocation = story.interviewLocationId
      ? await this.repository.interviewLocation(
          community.id,
          story.interviewLocationId
        )
      : null;
    return {
      status: 200,
      body: {
        data: {
          id: story.id,
          title: story.title,
          desc: story.description,
          topic: null,
          language: story.language,
          media: [],
          ...(interviewer ? { interviewer: { name: interviewer.name } } : {}),
          ...(interviewLocation
            ? { interviewLocation: { name: interviewLocation.name } }
            : {}),
          speakers: speakers.map((speaker) => ({
            id: speaker.id,
            name: speaker.name,
            speakerCommunity: null,
            birthdate: null,
          })),
          places: places.map((place) => ({
            id: place.id,
            name: place.name,
            description: place.description,
            region: place.region,
            placenameAudio: null,
            photoUrl: null,
            typeOfPlace: null,
            center: centerFeature(place),
          })),
          points: places.map(pointFeature),
        },
      },
    };
  }

  /** GET /explore/communities/:slug/places/:placeId — api/places#show. */
  async placeShow(slug: string, placeId: number): Promise<ExploreResult> {
    const community = await this.repository.publicCommunityBySlug(slug);
    if (!community) return notFound();
    // Hidden per §6.4a (no readable story association) or restricted: the
    // same 404 as a missing place.
    const place = await this.repository.publicPlaceById(community.id, placeId);
    if (!place) return notFound();
    return {
      status: 200,
      body: {
        data: {
          id: place.id,
          name: place.name,
          description: place.description,
          region: place.region,
          placenameAudio: null,
          typeOfPlace: null,
          points: [pointFeature(place)],
        },
      },
    };
  }
}
