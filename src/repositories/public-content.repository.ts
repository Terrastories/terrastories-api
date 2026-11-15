/**
 * Read-only data access for canonical V2 Slice 5 public endpoints (#145):
 * - `/v2/public/communities/:slug/stories`
 * - `/v2/public/communities/:slug/stories/:storyId`
 * - `/v2/public/communities/:slug/places`
 * - `/v2/public/communities/:slug/places/:placeId`
 * - `/v2/public/communities/:slug/speakers`
 * - `/v2/public/communities/:slug/speakers/:speakerId`
 * - `/v2/public/communities/:slug/media/:fileId`
 *
 * Reuses `ExploreAdapterRepository` / `PublicCommunitiesRepository` community
 * and story gates (`public = true AND active = true`, `privacy_level = 'public'
 * AND is_restricted = false`, #162 option A) and enforces §6.4a `with readable
 * stories` semantics on places, speakers, and media.
 */
import {
  aliasedTable,
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  gte,
  inArray,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import type { Database } from '../db/index.js';
import {
  dialectOf,
  orderWithTiebreak,
  tablesFor,
  textOrder,
  type DialectTables,
} from '../db/dialect.js';
import {
  communityMediaPg,
  communityMediaSqlite,
} from '../db/schema/sessions.js';
import type { ReadRuleViewer } from '../policy/read-rules.js';
import { deriveTopicNormalized } from '../shared/utils/derived-columns.js';
import {
  descriptionPlainText,
  sanitizeDescriptionForMigration,
} from '../shared/utils/safe-description.js';
import {
  containsNormalizedKey,
  normalizeSearchText,
} from '../shared/utils/search-normalize.js';
import { SpatialUtils } from '../shared/utils/spatial.js';
import type {
  CommunityBoundingBox,
  CommunityPlacesQuery,
  CommunityStoriesQuery,
} from '../shared/schemas/community-reads.js';
import type {
  PublicPaginationQuery,
  PublicStoriesQuery,
  PublicStorySort,
} from '../shared/schemas/public-content.js';
import {
  MAX_POINTS,
  type ExplorePlaceRow,
} from './explore-adapter.repository.js';
import {
  PublicCommunitiesRepository,
  type PublicCommunityRow,
} from './public-communities.repository.js';
import {
  PUBLIC_ASSOCIATED_MEDIA_ALLOWED,
  PUBLIC_BRANDING_MEDIA_ALLOWED,
  PUBLIC_STORY_MEDIA_ALLOWED,
  activeUnrestrictedFileCondition,
  associatedMediaAllowedForViewer,
  isValidCoordinates,
  placeBaseConditionForViewer,
  publicStoryCondition,
  readablePlaceConditionForViewer,
  readableSpeakerConditionForViewer,
  speakerBaseConditionForViewer,
  storyConditionForViewer,
  storyMediaAllowedForViewer,
  validPointCoordinatesCondition,
} from './public-visibility.js';

const IN_CHUNK_SIZE = 80;
const ANON_PUBLIC: ReadRuleViewer = 'anonymous-public';
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PublicStoryRecord {
  id: number;
  communityId: number;
  title: string;
  description: string | null;
  descriptionPlain?: string | null;
  topic: string | null;
  language: string;
  privacyLevel: string;
  isRestricted: boolean;
  dateInterviewed: Date | null;
  interviewLocationId: number | null;
  interviewerId: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PublicPlaceRecord {
  id: number;
  communityId: number;
  name: string;
  description: string | null;
  typeOfPlace: string | null;
  region: string | null;
  latitude: number | null;
  longitude: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PublicSpeakerRecord {
  id: number;
  communityId: number;
  name: string;
  birthDate: string | null;
  birthplaceId: number | null;
  affiliation: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PublicStoryAttachmentRecord {
  id: number;
  storyId: number;
  fileId: string;
  role: 'story_media';
  ordinal: number;
  mimeType: string;
  byteSize: number;
  originalName: string;
}

export interface PublicPlaceMediaRecord {
  placeId: number;
  fileId: string;
  role: 'place_photo' | 'place_name_audio';
  ordinal: number;
}

export interface PublicSpeakerPhotoRecord {
  speakerId: number;
  fileId: string;
}

export interface PublicExternalMediaLinkRecord {
  id: number;
  storyId: number;
  url: string;
  ordinal: number;
  createdAt: Date;
}

export interface PublicMediaFileRecord {
  id: string;
  communityId: number;
  storageKey: string;
  mimeType: string;
  byteSize: number;
  originalName: string;
}

export interface PublicStoriesPageResult {
  community: PublicCommunityRow;
  total: number;
  stories: PublicStoryRecord[];
  points: ExplorePlaceRow[];
  placesByStoryId: Map<number, PublicPlaceRecord[]>;
  speakersByStoryId: Map<number, PublicSpeakerRecord[]>;
  interviewLocationsById: Map<number, PublicPlaceRecord>;
  interviewersById: Map<number, PublicSpeakerRecord>;
  birthplacesById: Map<number, PublicPlaceRecord>;
  speakerPhotosBySpeakerId: Map<number, string>;
  attachmentsByStoryId: Map<number, PublicStoryAttachmentRecord[]>;
  externalLinksByStoryId: Map<number, PublicExternalMediaLinkRecord[]>;
}

export interface PublicStoryDetailResult {
  community: PublicCommunityRow;
  story: PublicStoryRecord;
  places: PublicPlaceRecord[];
  points: ExplorePlaceRow[];
  speakers: PublicSpeakerRecord[];
  interviewLocation: PublicPlaceRecord | null;
  interviewer: PublicSpeakerRecord | null;
  birthplacesById: Map<number, PublicPlaceRecord>;
  speakerPhotosBySpeakerId: Map<number, string>;
  attachments: PublicStoryAttachmentRecord[];
  externalLinks: PublicExternalMediaLinkRecord[];
}

export interface PublicPlacesPageResult {
  community: PublicCommunityRow;
  total: number;
  places: PublicPlaceRecord[];
  photosByPlaceId: Map<number, string[]>;
  placenameAudioByPlaceId: Map<number, string>;
}

export interface PublicPlaceDetailResult {
  community: PublicCommunityRow;
  place: PublicPlaceRecord;
  photos: string[];
  placenameAudioFileId: string | null;
}

export interface PublicSpeakersPageResult {
  community: PublicCommunityRow;
  total: number;
  speakers: PublicSpeakerRecord[];
  birthplacesById: Map<number, PublicPlaceRecord>;
  photosBySpeakerId: Map<number, string>;
}

export interface PublicSpeakerDetailResult {
  community: PublicCommunityRow;
  speaker: PublicSpeakerRecord;
  birthplace: PublicPlaceRecord | null;
  photoFileId: string | null;
}

function chunkValues<T>(values: readonly T[], size = IN_CHUNK_SIZE): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < values.length; i += size) {
    chunks.push(values.slice(i, i + size));
  }
  return chunks;
}

function sanitizePlainTextForSearch(raw: string | null): string {
  if (raw === null) {
    return '';
  }
  try {
    return descriptionPlainText(sanitizeDescriptionForMigration(raw).html);
  } catch {
    return '';
  }
}

function storyMatchesNeedle(
  row: PublicStoryRecord,
  needleKey: string
): boolean {
  if (containsNormalizedKey(row.title, needleKey)) {
    return true;
  }
  const plain =
    row.descriptionPlain !== null && row.descriptionPlain !== undefined
      ? row.descriptionPlain
      : sanitizePlainTextForSearch(row.description);
  if (plain !== '' && containsNormalizedKey(plain, needleKey)) {
    return true;
  }
  if (row.topic !== null && containsNormalizedKey(row.topic, needleKey)) {
    return true;
  }
  return false;
}

function boundingBoxClauses(
  places: DialectTables['places'],
  bounds: CommunityBoundingBox
): SQL[] {
  const clauses: SQL[] = [
    validPointCoordinatesCondition(places),
    gte(places.latitude, bounds.south),
    lte(places.latitude, bounds.north),
  ];
  if (bounds.west > bounds.east) {
    clauses.push(
      or(
        gte(places.longitude, bounds.west),
        lte(places.longitude, bounds.east)
      )!
    );
  } else {
    clauses.push(
      and(
        gte(places.longitude, bounds.west),
        lte(places.longitude, bounds.east)
      )!
    );
  }
  return clauses;
}

export class PublicContentRepository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly database: any;
  private readonly tables: DialectTables;
  private readonly communityMedia: typeof communityMediaSqlite;
  private readonly communitiesRepo: PublicCommunitiesRepository;

  constructor(
    database: Database | DrizzleD1Database,
    communitiesRepo?: PublicCommunitiesRepository
  ) {
    this.database = database;
    this.tables = tablesFor(this.database);
    this.communityMedia = (
      dialectOf(this.database) === 'postgresql'
        ? communityMediaPg
        : communityMediaSqlite
    ) as typeof communityMediaSqlite;
    this.communitiesRepo =
      communitiesRepo ?? new PublicCommunitiesRepository(database);
  }

  get explore() {
    return this.communitiesRepo.explore;
  }

  /**
   * Place predicate matching §6.4a `with readable stories`:
   * delegates to shared `readablePlaceCondition` in `public-visibility.ts`.
   */
  private placeReadableConditions(
    communityId: number,
    viewer: ReadRuleViewer = ANON_PUBLIC,
    placeTable: DialectTables['places'] = this.tables.places
  ): SQL {
    return readablePlaceConditionForViewer(
      this.database,
      this.tables,
      communityId,
      viewer,
      placeTable
    );
  }

  /**
   * Speaker predicate matching §6.4a `with readable stories`:
   * delegates to shared `readableSpeakerConditionForViewer` in `public-visibility.ts`.
   */
  private speakerReadableConditions(
    communityId: number,
    viewer: ReadRuleViewer = ANON_PUBLIC,
    speakerTable: DialectTables['speakers'] = this.tables.speakers
  ): SQL {
    return readableSpeakerConditionForViewer(
      this.database,
      this.tables,
      communityId,
      viewer,
      speakerTable
    );
  }

  /**
   * Build story filter WHERE clauses.
   *
   * Uses aliased `places` / `speakers` tables inside EXISTS subqueries so outer
   * queries on `places` (e.g. map points) cannot suffer table-name shadowing, and
   * binds every filter value ONCE per clause to stay well below D1's 100-param
   * limit.
   */
  private buildStoryConditions(
    communityId: number,
    query: PublicStoriesQuery,
    viewer: ReadRuleViewer = ANON_PUBLIC
  ): SQL {
    const conditions: SQL[] = [
      storyConditionForViewer(this.tables.stories, communityId, viewer),
    ];
    const filterPlaces = aliasedTable(this.tables.places, 'story_filter_place');
    const filterSpeakers = aliasedTable(
      this.tables.speakers,
      'story_filter_speaker'
    );

    const placePred = (placeClause: SQL): SQL => {
      const viaEdge = exists(
        this.database
          .select({ one: sql`1` })
          .from(this.tables.storyPlaces)
          .where(
            and(
              eq(this.tables.storyPlaces.communityId, communityId),
              eq(this.tables.storyPlaces.storyId, this.tables.stories.id),
              eq(this.tables.storyPlaces.placeId, filterPlaces.id)
            )
          )
      );
      return exists(
        this.database
          .select({ one: sql`1` })
          .from(filterPlaces)
          .where(
            and(
              placeBaseConditionForViewer(filterPlaces, communityId, viewer),
              placeClause,
              or(
                eq(filterPlaces.id, this.tables.stories.interviewLocationId),
                viaEdge
              )
            )
          )
      );
    };

    const speakerPred = (speakerClause: SQL): SQL => {
      const viaEdge = exists(
        this.database
          .select({ one: sql`1` })
          .from(this.tables.storySpeakers)
          .where(
            and(
              eq(this.tables.storySpeakers.communityId, communityId),
              eq(this.tables.storySpeakers.storyId, this.tables.stories.id),
              eq(this.tables.storySpeakers.speakerId, filterSpeakers.id)
            )
          )
      );
      return exists(
        this.database
          .select({ one: sql`1` })
          .from(filterSpeakers)
          .where(
            and(
              speakerBaseConditionForViewer(
                filterSpeakers,
                communityId,
                viewer
              ),
              speakerClause,
              or(
                eq(filterSpeakers.id, this.tables.stories.interviewerId),
                viaEdge
              )
            )
          )
      );
    };

    if (query.place?.length) {
      conditions.push(placePred(inArray(filterPlaces.id, query.place)));
    }
    if (query.region?.length) {
      conditions.push(placePred(inArray(filterPlaces.region, query.region)));
    }
    if (query.typeOfPlace?.length) {
      conditions.push(
        placePred(inArray(filterPlaces.typeOfPlace, query.typeOfPlace))
      );
    }
    if (query.topic?.length) {
      const normalized = Array.from(
        new Set(query.topic.map((t) => deriveTopicNormalized(t)))
      ).filter((t): t is string => t !== null && t.length > 0);
      if (normalized.length === 0) {
        conditions.push(sql`1 = 0`);
      } else {
        conditions.push(
          inArray(this.tables.stories.topicNormalized, normalized)
        );
      }
    }
    if (query.language?.length) {
      conditions.push(inArray(this.tables.stories.language, query.language));
    }
    if (query.speaker?.length) {
      conditions.push(speakerPred(inArray(filterSpeakers.id, query.speaker)));
    }
    if (query.affiliation?.length) {
      conditions.push(
        speakerPred(inArray(filterSpeakers.affiliation, query.affiliation))
      );
    }

    return and(...conditions)!;
  }

  private storyOrderClauses(sort: PublicStorySort): SQL[] {
    const dialect = dialectOf(this.database);
    if (sort === 'title_asc') {
      return orderWithTiebreak(
        textOrder(dialect, this.tables.stories.title, 'asc'),
        this.tables.stories.id,
        'asc'
      );
    }
    if (sort === 'title_desc') {
      return orderWithTiebreak(
        textOrder(dialect, this.tables.stories.title, 'desc'),
        this.tables.stories.id,
        'desc'
      );
    }
    return [desc(this.tables.stories.createdAt), desc(this.tables.stories.id)];
  }

  async listStories(
    slug: string,
    query: PublicStoriesQuery
  ): Promise<PublicStoriesPageResult | null> {
    const community = await this.explore.publicCommunityBySlug(slug);
    if (!community) {
      return null;
    }
    return this.listStoriesInCommunity(community, query, ANON_PUBLIC);
  }

  async listStoriesInCommunity(
    community: PublicCommunityRow,
    query: CommunityStoriesQuery,
    viewer: ReadRuleViewer = ANON_PUBLIC
  ): Promise<PublicStoriesPageResult> {
    const whereClause = this.buildStoryConditions(community.id, query, viewer);
    const needleKey =
      query.search && query.search.trim().length > 0
        ? normalizeSearchText(query.search.trim())
        : null;

    let total: number;
    let stories: PublicStoryRecord[];
    let points: ExplorePlaceRow[];

    if (needleKey === null) {
      // Materialise the filtered readable story IDs once per query so D1 never
      // exceeds its 100 bound-parameter cap even when every filter is full.
      const filteredStories = this.database.$with('filtered_stories').as(
        this.database
          .select({
            id: this.tables.stories.id,
            interviewLocationId: this.tables.stories.interviewLocationId,
          })
          .from(this.tables.stories)
          .where(whereClause)
      );

      const [totalRow] = await this.database
        .with(filteredStories)
        .select({ total: count() })
        .from(filteredStories);
      total = Number(totalRow?.total ?? 0);

      stories = await this.database
        .with(filteredStories)
        .select({
          id: this.tables.stories.id,
          communityId: this.tables.stories.communityId,
          title: this.tables.stories.title,
          description: this.tables.stories.description,
          descriptionPlain: this.tables.stories.descriptionPlain,
          topic: this.tables.stories.topic,
          language: this.tables.stories.language,
          privacyLevel: this.tables.stories.privacyLevel,
          isRestricted: this.tables.stories.isRestricted,
          dateInterviewed: this.tables.stories.dateInterviewed,
          interviewLocationId: this.tables.stories.interviewLocationId,
          interviewerId: this.tables.stories.interviewerId,
          createdAt: this.tables.stories.createdAt,
          updatedAt: this.tables.stories.updatedAt,
        })
        .from(this.tables.stories)
        .innerJoin(
          filteredStories,
          eq(this.tables.stories.id, filteredStories.id)
        )
        .orderBy(...this.storyOrderClauses(query.sort))
        .limit(query.limit)
        .offset(query.offset);

      const pointPlace = aliasedTable(this.tables.places, 'story_list_point');
      const pointViaEdge = exists(
        this.database
          .select({ one: sql`1` })
          .from(this.tables.storyPlaces)
          .innerJoin(
            filteredStories,
            eq(this.tables.storyPlaces.storyId, filteredStories.id)
          )
          .where(
            and(
              eq(this.tables.storyPlaces.communityId, community.id),
              eq(this.tables.storyPlaces.placeId, pointPlace.id)
            )
          )
      );
      const pointViaInterview = exists(
        this.database
          .select({ one: sql`1` })
          .from(filteredStories)
          .where(eq(filteredStories.interviewLocationId, pointPlace.id))
      );

      const rawPoints: Array<{
        id: number;
        name: string;
        typeOfPlace: string | null;
        description: string | null;
        region: string | null;
        latitude: number | null;
        longitude: number | null;
      }> =
        total === 0
          ? []
          : await this.database
              .with(filteredStories)
              .select({
                id: pointPlace.id,
                name: pointPlace.name,
                typeOfPlace: pointPlace.typeOfPlace,
                description: pointPlace.description,
                region: pointPlace.region,
                latitude: pointPlace.latitude,
                longitude: pointPlace.longitude,
              })
              .from(pointPlace)
              .where(
                and(
                  placeBaseConditionForViewer(pointPlace, community.id, viewer),
                  validPointCoordinatesCondition(pointPlace),
                  or(pointViaEdge, pointViaInterview)
                )
              )
              .orderBy(asc(pointPlace.id))
              .limit(MAX_POINTS);

      points = rawPoints.filter((row): row is ExplorePlaceRow =>
        isValidCoordinates(row.latitude, row.longitude)
      );
    } else {
      const candidates: PublicStoryRecord[] = await this.database
        .select({
          id: this.tables.stories.id,
          communityId: this.tables.stories.communityId,
          title: this.tables.stories.title,
          description: this.tables.stories.description,
          descriptionPlain: this.tables.stories.descriptionPlain,
          topic: this.tables.stories.topic,
          language: this.tables.stories.language,
          privacyLevel: this.tables.stories.privacyLevel,
          isRestricted: this.tables.stories.isRestricted,
          dateInterviewed: this.tables.stories.dateInterviewed,
          interviewLocationId: this.tables.stories.interviewLocationId,
          interviewerId: this.tables.stories.interviewerId,
          createdAt: this.tables.stories.createdAt,
          updatedAt: this.tables.stories.updatedAt,
        })
        .from(this.tables.stories)
        .where(whereClause)
        .orderBy(...this.storyOrderClauses(query.sort));

      const matched = candidates.filter((row) =>
        storyMatchesNeedle(row, needleKey)
      );
      total = matched.length;
      stories = matched.slice(query.offset, query.offset + query.limit);

      if (total === 0) {
        points = [];
      } else {
        const matchedIds = matched.map((row) => row.id);
        const pointPlaceIds = new Set<number>();
        for (const row of matched) {
          if (row.interviewLocationId !== null) {
            pointPlaceIds.add(row.interviewLocationId);
          }
        }
        for (const chunk of chunkValues(matchedIds)) {
          const edgeRows: Array<{ placeId: number }> = await this.database
            .select({ placeId: this.tables.storyPlaces.placeId })
            .from(this.tables.storyPlaces)
            .where(
              and(
                eq(this.tables.storyPlaces.communityId, community.id),
                inArray(this.tables.storyPlaces.storyId, chunk)
              )
            );
          for (const edge of edgeRows) {
            pointPlaceIds.add(edge.placeId);
          }
        }
        const collectedPoints: ExplorePlaceRow[] = [];
        for (const chunk of chunkValues(Array.from(pointPlaceIds))) {
          const rows: Array<{
            id: number;
            name: string;
            typeOfPlace: string | null;
            description: string | null;
            region: string | null;
            latitude: number | null;
            longitude: number | null;
          }> = await this.database
            .select({
              id: this.tables.places.id,
              name: this.tables.places.name,
              typeOfPlace: this.tables.places.typeOfPlace,
              description: this.tables.places.description,
              region: this.tables.places.region,
              latitude: this.tables.places.latitude,
              longitude: this.tables.places.longitude,
            })
            .from(this.tables.places)
            .where(
              and(
                placeBaseConditionForViewer(
                  this.tables.places,
                  community.id,
                  viewer
                ),
                validPointCoordinatesCondition(this.tables.places),
                inArray(this.tables.places.id, chunk)
              )
            );
          for (const row of rows) {
            if (isValidCoordinates(row.latitude, row.longitude)) {
              collectedPoints.push({
                id: row.id,
                name: row.name,
                typeOfPlace: row.typeOfPlace,
                description: row.description,
                region: row.region,
                latitude: row.latitude,
                longitude: row.longitude!,
              });
            }
          }
        }
        collectedPoints.sort((a, b) => a.id - b.id);
        points = collectedPoints.slice(0, MAX_POINTS);
      }
    }

    const storyIds = stories.map((story) => story.id);
    const placesByStoryId = await this.loadStoryPlacesMap(
      community.id,
      storyIds,
      viewer
    );
    const speakersByStoryId = await this.loadStorySpeakersMap(
      community.id,
      storyIds,
      viewer
    );

    const interviewLocationIds = Array.from(
      new Set(
        stories
          .map((story) => story.interviewLocationId)
          .filter((id): id is number => id !== null)
      )
    );
    const interviewLocationsById = await this.loadVisiblePlacesById(
      community.id,
      interviewLocationIds,
      viewer
    );

    const interviewerIds = Array.from(
      new Set(
        stories
          .map((story) => story.interviewerId)
          .filter((id): id is number => id !== null)
      )
    );
    const interviewersById = await this.loadActiveSpeakersById(
      community.id,
      interviewerIds,
      viewer
    );

    const allSpeakers: PublicSpeakerRecord[] = [
      ...Array.from(speakersByStoryId.values()).flat(),
      ...Array.from(interviewersById.values()),
    ];
    const birthplacesById = await this.loadReadableBirthplacesMap(
      community.id,
      allSpeakers,
      viewer
    );
    const speakerPhotosBySpeakerId = await this.loadSpeakerPhotosMap(
      community.id,
      allSpeakers.map((s) => s.id),
      viewer
    );
    const attachmentsByStoryId = await this.loadStoryAttachmentsMap(
      community.id,
      storyIds,
      viewer
    );
    const externalLinksByStoryId = await this.loadStoryExternalLinksMap(
      community.id,
      storyIds
    );

    return {
      community,
      total,
      stories,
      points,
      placesByStoryId,
      speakersByStoryId,
      interviewLocationsById,
      interviewersById,
      birthplacesById,
      speakerPhotosBySpeakerId,
      attachmentsByStoryId,
      externalLinksByStoryId,
    };
  }

  async getStoryById(
    slug: string,
    storyId: number
  ): Promise<PublicStoryDetailResult | null> {
    const community = await this.explore.publicCommunityBySlug(slug);
    if (!community) {
      return null;
    }
    return this.getStoryByIdInCommunity(community, storyId, ANON_PUBLIC);
  }

  async getStoryByIdInCommunity(
    community: PublicCommunityRow,
    storyId: number,
    viewer: ReadRuleViewer = ANON_PUBLIC
  ): Promise<PublicStoryDetailResult | null> {
    const [story] = await this.database
      .select({
        id: this.tables.stories.id,
        communityId: this.tables.stories.communityId,
        title: this.tables.stories.title,
        description: this.tables.stories.description,
        descriptionPlain: this.tables.stories.descriptionPlain,
        topic: this.tables.stories.topic,
        language: this.tables.stories.language,
        privacyLevel: this.tables.stories.privacyLevel,
        isRestricted: this.tables.stories.isRestricted,
        dateInterviewed: this.tables.stories.dateInterviewed,
        interviewLocationId: this.tables.stories.interviewLocationId,
        interviewerId: this.tables.stories.interviewerId,
        createdAt: this.tables.stories.createdAt,
        updatedAt: this.tables.stories.updatedAt,
      })
      .from(this.tables.stories)
      .where(
        and(
          storyConditionForViewer(this.tables.stories, community.id, viewer),
          eq(this.tables.stories.id, storyId)
        )
      )
      .limit(1);

    if (!story) {
      return null;
    }

    const placesMap = await this.loadStoryPlacesMap(
      community.id,
      [story.id],
      viewer
    );
    const places = placesMap.get(story.id) ?? [];

    const speakersMap = await this.loadStorySpeakersMap(
      community.id,
      [story.id],
      viewer
    );
    const speakers = speakersMap.get(story.id) ?? [];

    const interviewLocationsById =
      story.interviewLocationId !== null
        ? await this.loadVisiblePlacesById(
            community.id,
            [story.interviewLocationId],
            viewer
          )
        : new Map<number, PublicPlaceRecord>();
    const interviewLocation =
      story.interviewLocationId !== null
        ? (interviewLocationsById.get(story.interviewLocationId) ?? null)
        : null;

    const interviewersById =
      story.interviewerId !== null
        ? await this.loadActiveSpeakersById(
            community.id,
            [story.interviewerId],
            viewer
          )
        : new Map<number, PublicSpeakerRecord>();
    const interviewer =
      story.interviewerId !== null
        ? (interviewersById.get(story.interviewerId) ?? null)
        : null;

    const allSpeakers = interviewer ? [...speakers, interviewer] : speakers;
    const birthplacesById = await this.loadReadableBirthplacesMap(
      community.id,
      allSpeakers,
      viewer
    );
    const speakerPhotosBySpeakerId = await this.loadSpeakerPhotosMap(
      community.id,
      allSpeakers.map((s) => s.id),
      viewer
    );

    const attachmentsMap = await this.loadStoryAttachmentsMap(
      community.id,
      [story.id],
      viewer
    );
    const externalLinksMap = await this.loadStoryExternalLinksMap(
      community.id,
      [story.id]
    );

    const candidatePointPlaces = new Map<number, PublicPlaceRecord>();
    for (const place of places) {
      candidatePointPlaces.set(place.id, place);
    }
    if (interviewLocation) {
      candidatePointPlaces.set(interviewLocation.id, interviewLocation);
    }
    const points: ExplorePlaceRow[] = Array.from(candidatePointPlaces.values())
      .sort((a, b) => a.id - b.id)
      .filter(
        (
          place
        ): place is PublicPlaceRecord & {
          latitude: number;
          longitude: number;
        } => isValidCoordinates(place.latitude, place.longitude)
      )
      .slice(0, MAX_POINTS);

    return {
      community,
      story,
      places,
      points,
      speakers,
      interviewLocation,
      interviewer,
      birthplacesById,
      speakerPhotosBySpeakerId,
      attachments: attachmentsMap.get(story.id) ?? [],
      externalLinks: externalLinksMap.get(story.id) ?? [],
    };
  }

  async listPlaces(
    slug: string,
    pagination: PublicPaginationQuery
  ): Promise<PublicPlacesPageResult | null> {
    const community = await this.explore.publicCommunityBySlug(slug);
    if (!community) {
      return null;
    }
    return this.listPlacesInCommunity(community, pagination, ANON_PUBLIC);
  }

  async listPlacesInCommunity(
    community: PublicCommunityRow,
    query: CommunityPlacesQuery,
    viewer: ReadRuleViewer = ANON_PUBLIC
  ): Promise<PublicPlacesPageResult> {
    const clauses: SQL[] = [this.placeReadableConditions(community.id, viewer)];
    if (query.bbox) {
      clauses.push(...boundingBoxClauses(this.tables.places, query.bbox));
    }
    if (query.near) {
      const box = SpatialUtils.calculateBoundingBox(
        query.near.latitude,
        query.near.longitude,
        query.near.radiusKm
      );
      clauses.push(validPointCoordinatesCondition(this.tables.places));
      clauses.push(gte(this.tables.places.latitude, box.south));
      clauses.push(lte(this.tables.places.latitude, box.north));
      if (!box.includesAllLongitudes) {
        clauses.push(
          box.crossesAntimeridian
            ? or(
                gte(this.tables.places.longitude, box.west),
                lte(this.tables.places.longitude, box.east)
              )!
            : and(
                gte(this.tables.places.longitude, box.west),
                lte(this.tables.places.longitude, box.east)
              )!
        );
      }
    }

    const whereClause = and(...clauses)!;
    let total: number;
    let places: PublicPlaceRecord[];

    if (query.near) {
      const { latitude, longitude, radiusKm } = query.near;
      const radiusMeters = radiusKm * 1000;
      const candidates: PublicPlaceRecord[] = await this.database
        .select({
          id: this.tables.places.id,
          communityId: this.tables.places.communityId,
          name: this.tables.places.name,
          description: this.tables.places.description,
          typeOfPlace: this.tables.places.typeOfPlace,
          region: this.tables.places.region,
          latitude: this.tables.places.latitude,
          longitude: this.tables.places.longitude,
          createdAt: this.tables.places.createdAt,
          updatedAt: this.tables.places.updatedAt,
        })
        .from(this.tables.places)
        .where(whereClause)
        .orderBy(asc(this.tables.places.id));

      const matched = candidates.filter(
        (place) =>
          isValidCoordinates(place.latitude, place.longitude) &&
          SpatialUtils.calculateDistance(
            latitude,
            longitude,
            place.latitude,
            place.longitude!
          ) <= radiusMeters
      );
      total = matched.length;
      places = matched.slice(query.offset, query.offset + query.limit);
    } else {
      const [totalRow] = await this.database
        .select({ total: count() })
        .from(this.tables.places)
        .where(whereClause);
      total = Number(totalRow?.total ?? 0);

      places = await this.database
        .select({
          id: this.tables.places.id,
          communityId: this.tables.places.communityId,
          name: this.tables.places.name,
          description: this.tables.places.description,
          typeOfPlace: this.tables.places.typeOfPlace,
          region: this.tables.places.region,
          latitude: this.tables.places.latitude,
          longitude: this.tables.places.longitude,
          createdAt: this.tables.places.createdAt,
          updatedAt: this.tables.places.updatedAt,
        })
        .from(this.tables.places)
        .where(whereClause)
        .orderBy(asc(this.tables.places.id))
        .limit(query.limit)
        .offset(query.offset);
    }

    const { photosByPlaceId, placenameAudioByPlaceId } =
      await this.loadPlaceMediaMaps(
        community.id,
        places.map((p) => p.id),
        viewer
      );

    return {
      community,
      total,
      places,
      photosByPlaceId,
      placenameAudioByPlaceId,
    };
  }

  async getPlaceById(
    slug: string,
    placeId: number
  ): Promise<PublicPlaceDetailResult | null> {
    const community = await this.explore.publicCommunityBySlug(slug);
    if (!community) {
      return null;
    }
    return this.getPlaceByIdInCommunity(community, placeId, ANON_PUBLIC);
  }

  async getPlaceByIdInCommunity(
    community: PublicCommunityRow,
    placeId: number,
    viewer: ReadRuleViewer = ANON_PUBLIC
  ): Promise<PublicPlaceDetailResult | null> {
    const [place] = await this.database
      .select({
        id: this.tables.places.id,
        communityId: this.tables.places.communityId,
        name: this.tables.places.name,
        description: this.tables.places.description,
        typeOfPlace: this.tables.places.typeOfPlace,
        region: this.tables.places.region,
        latitude: this.tables.places.latitude,
        longitude: this.tables.places.longitude,
        createdAt: this.tables.places.createdAt,
        updatedAt: this.tables.places.updatedAt,
      })
      .from(this.tables.places)
      .where(
        and(
          this.placeReadableConditions(community.id, viewer),
          eq(this.tables.places.id, placeId)
        )
      )
      .limit(1);

    if (!place) {
      return null;
    }

    const { photosByPlaceId, placenameAudioByPlaceId } =
      await this.loadPlaceMediaMaps(community.id, [place.id], viewer);

    return {
      community,
      place,
      photos: photosByPlaceId.get(place.id) ?? [],
      placenameAudioFileId: placenameAudioByPlaceId.get(place.id) ?? null,
    };
  }

  async listSpeakers(
    slug: string,
    pagination: PublicPaginationQuery
  ): Promise<PublicSpeakersPageResult | null> {
    const community = await this.explore.publicCommunityBySlug(slug);
    if (!community) {
      return null;
    }
    return this.listSpeakersInCommunity(community, pagination, ANON_PUBLIC);
  }

  async listSpeakersInCommunity(
    community: PublicCommunityRow,
    pagination: PublicPaginationQuery,
    viewer: ReadRuleViewer = ANON_PUBLIC
  ): Promise<PublicSpeakersPageResult> {
    const whereClause = this.speakerReadableConditions(community.id, viewer);
    const [totalRow] = await this.database
      .select({ total: count() })
      .from(this.tables.speakers)
      .where(whereClause);
    const total = Number(totalRow?.total ?? 0);

    const speakers: PublicSpeakerRecord[] = await this.database
      .select({
        id: this.tables.speakers.id,
        communityId: this.tables.speakers.communityId,
        name: this.tables.speakers.name,
        birthDate: this.tables.speakers.birthDate,
        birthplaceId: this.tables.speakers.birthplaceId,
        affiliation: this.tables.speakers.affiliation,
        createdAt: this.tables.speakers.createdAt,
        updatedAt: this.tables.speakers.updatedAt,
      })
      .from(this.tables.speakers)
      .where(whereClause)
      .orderBy(asc(this.tables.speakers.id))
      .limit(pagination.limit)
      .offset(pagination.offset);

    const birthplacesById = await this.loadReadableBirthplacesMap(
      community.id,
      speakers,
      viewer
    );
    const photosBySpeakerId = await this.loadSpeakerPhotosMap(
      community.id,
      speakers.map((s) => s.id),
      viewer
    );

    return {
      community,
      total,
      speakers,
      birthplacesById,
      photosBySpeakerId,
    };
  }

  async getSpeakerById(
    slug: string,
    speakerId: number
  ): Promise<PublicSpeakerDetailResult | null> {
    const community = await this.explore.publicCommunityBySlug(slug);
    if (!community) {
      return null;
    }
    return this.getSpeakerByIdInCommunity(community, speakerId, ANON_PUBLIC);
  }

  async getSpeakerByIdInCommunity(
    community: PublicCommunityRow,
    speakerId: number,
    viewer: ReadRuleViewer = ANON_PUBLIC
  ): Promise<PublicSpeakerDetailResult | null> {
    const [speaker] = await this.database
      .select({
        id: this.tables.speakers.id,
        communityId: this.tables.speakers.communityId,
        name: this.tables.speakers.name,
        birthDate: this.tables.speakers.birthDate,
        birthplaceId: this.tables.speakers.birthplaceId,
        affiliation: this.tables.speakers.affiliation,
        createdAt: this.tables.speakers.createdAt,
        updatedAt: this.tables.speakers.updatedAt,
      })
      .from(this.tables.speakers)
      .where(
        and(
          this.speakerReadableConditions(community.id, viewer),
          eq(this.tables.speakers.id, speakerId)
        )
      )
      .limit(1);

    if (!speaker) {
      return null;
    }

    const birthplacesById = await this.loadReadableBirthplacesMap(
      community.id,
      [speaker],
      viewer
    );
    const photosBySpeakerId = await this.loadSpeakerPhotosMap(
      community.id,
      [speaker.id],
      viewer
    );

    return {
      community,
      speaker,
      birthplace:
        speaker.birthplaceId !== null
          ? (birthplacesById.get(speaker.birthplaceId) ?? null)
          : null,
      photoFileId: photosBySpeakerId.get(speaker.id) ?? null,
    };
  }

  async getAuthorizedPublicMediaFile(
    slug: string,
    fileId: string
  ): Promise<PublicMediaFileRecord | null> {
    if (!UUID_PATTERN.test(fileId)) {
      return null;
    }
    const community = await this.explore.publicCommunityBySlug(slug);
    if (!community) {
      return null;
    }

    const [fileRow] = await this.database
      .select({
        id: this.tables.files.id,
        communityId: this.tables.files.communityId,
        storageKey: this.tables.files.storageKey,
        path: this.tables.files.path,
        mimeType: this.tables.files.mimeType,
        byteSize: this.tables.files.byteSize,
        size: this.tables.files.size,
        originalName: this.tables.files.originalName,
      })
      .from(this.tables.files)
      .where(
        and(
          eq(this.tables.files.id, fileId),
          activeUnrestrictedFileCondition(this.tables.files, community.id)
        )
      )
      .limit(1);

    if (!fileRow || fileRow.communityId !== community.id) {
      return null;
    }

    const resolved: PublicMediaFileRecord = {
      id: fileRow.id,
      communityId: fileRow.communityId,
      storageKey: fileRow.storageKey ?? fileRow.path,
      mimeType: fileRow.mimeType,
      byteSize: Number(fileRow.byteSize ?? fileRow.size),
      originalName: fileRow.originalName,
    };

    const [staticMapRow] = await this.database
      .select({ communityId: this.tables.communityMapConfigs.communityId })
      .from(this.tables.communityMapConfigs)
      .where(
        and(
          eq(this.tables.communityMapConfigs.communityId, community.id),
          eq(this.tables.communityMapConfigs.staticMapFileId, fileId)
        )
      )
      .limit(1);

    if (staticMapRow) {
      return resolved;
    }

    const attachmentRows = await this.database
      .select({
        ownerType: this.tables.attachments.ownerType,
        ownerId: this.tables.attachments.ownerId,
        role: this.tables.attachments.role,
      })
      .from(this.tables.attachments)
      .where(
        and(
          eq(this.tables.attachments.communityId, community.id),
          eq(this.tables.attachments.fileId, fileId)
        )
      );

    for (const att of attachmentRows) {
      if (
        PUBLIC_BRANDING_MEDIA_ALLOWED &&
        att.ownerType === 'community' &&
        att.ownerId === community.id &&
        (att.role === 'community_display_image' ||
          att.role === 'community_background_image' ||
          att.role === 'sponsor_logo')
      ) {
        return resolved;
      }

      if (
        PUBLIC_STORY_MEDIA_ALLOWED &&
        att.ownerType === 'story' &&
        att.role === 'story_media' &&
        att.ownerId !== null
      ) {
        const [storyRow] = await this.database
          .select({ id: this.tables.stories.id })
          .from(this.tables.stories)
          .where(
            and(
              publicStoryCondition(this.tables.stories, community.id),
              eq(this.tables.stories.id, att.ownerId)
            )
          )
          .limit(1);
        if (storyRow) {
          return resolved;
        }
      }

      if (
        PUBLIC_ASSOCIATED_MEDIA_ALLOWED &&
        att.ownerType === 'place' &&
        (att.role === 'place_photo' || att.role === 'place_name_audio') &&
        att.ownerId !== null
      ) {
        const [placeRow] = await this.database
          .select({ id: this.tables.places.id })
          .from(this.tables.places)
          .where(
            and(
              this.placeReadableConditions(community.id),
              eq(this.tables.places.id, att.ownerId)
            )
          )
          .limit(1);
        if (placeRow) {
          return resolved;
        }
      }

      if (
        PUBLIC_ASSOCIATED_MEDIA_ALLOWED &&
        att.ownerType === 'speaker' &&
        att.role === 'speaker_photo' &&
        att.ownerId !== null
      ) {
        const [speakerRow] = await this.database
          .select({ id: this.tables.speakers.id })
          .from(this.tables.speakers)
          .where(
            and(
              this.speakerReadableConditions(community.id),
              eq(this.tables.speakers.id, att.ownerId)
            )
          )
          .limit(1);
        if (speakerRow) {
          return resolved;
        }
      }
    }

    if (!PUBLIC_BRANDING_MEDIA_ALLOWED) {
      return null;
    }

    const [brandingFallback] = await this.database
      .select({ fileId: this.communityMedia.fileId })
      .from(this.communityMedia)
      .where(
        and(
          eq(this.communityMedia.communityId, community.id),
          eq(this.communityMedia.fileId, fileId),
          eq(this.communityMedia.kind, 'branding')
        )
      )
      .limit(1);

    return brandingFallback ? resolved : null;
  }

  private async loadStoryPlacesMap(
    communityId: number,
    storyIds: number[],
    viewer: ReadRuleViewer = ANON_PUBLIC
  ): Promise<Map<number, PublicPlaceRecord[]>> {
    const result = new Map<number, PublicPlaceRecord[]>();
    if (storyIds.length === 0) {
      return result;
    }

    for (const chunk of chunkValues(storyIds)) {
      const rows = await this.database
        .select({
          storyId: this.tables.storyPlaces.storyId,
          id: this.tables.places.id,
          communityId: this.tables.places.communityId,
          name: this.tables.places.name,
          description: this.tables.places.description,
          typeOfPlace: this.tables.places.typeOfPlace,
          region: this.tables.places.region,
          latitude: this.tables.places.latitude,
          longitude: this.tables.places.longitude,
          createdAt: this.tables.places.createdAt,
          updatedAt: this.tables.places.updatedAt,
        })
        .from(this.tables.storyPlaces)
        .innerJoin(
          this.tables.places,
          eq(this.tables.storyPlaces.placeId, this.tables.places.id)
        )
        .where(
          and(
            eq(this.tables.storyPlaces.communityId, communityId),
            placeBaseConditionForViewer(
              this.tables.places,
              communityId,
              viewer
            ),
            inArray(this.tables.storyPlaces.storyId, chunk)
          )
        )
        .orderBy(
          asc(sql`COALESCE(${this.tables.storyPlaces.sortOrder}, 0)`),
          asc(this.tables.storyPlaces.id)
        );

      // Preserve edge multiplicity and deterministic (sortOrder, id) order (SPEC-V2 §6.3).
      for (const row of rows) {
        const list = result.get(row.storyId) ?? [];
        list.push({
          id: row.id,
          communityId: row.communityId,
          name: row.name,
          description: row.description,
          typeOfPlace: row.typeOfPlace,
          region: row.region,
          latitude: row.latitude,
          longitude: row.longitude,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        });
        result.set(row.storyId, list);
      }
    }

    return result;
  }

  private async loadStorySpeakersMap(
    communityId: number,
    storyIds: number[],
    viewer: ReadRuleViewer = ANON_PUBLIC
  ): Promise<Map<number, PublicSpeakerRecord[]>> {
    const result = new Map<number, PublicSpeakerRecord[]>();
    if (storyIds.length === 0) {
      return result;
    }

    for (const chunk of chunkValues(storyIds)) {
      const rows = await this.database
        .select({
          storyId: this.tables.storySpeakers.storyId,
          id: this.tables.speakers.id,
          communityId: this.tables.speakers.communityId,
          name: this.tables.speakers.name,
          birthDate: this.tables.speakers.birthDate,
          birthplaceId: this.tables.speakers.birthplaceId,
          affiliation: this.tables.speakers.affiliation,
          createdAt: this.tables.speakers.createdAt,
          updatedAt: this.tables.speakers.updatedAt,
        })
        .from(this.tables.storySpeakers)
        .innerJoin(
          this.tables.speakers,
          eq(this.tables.storySpeakers.speakerId, this.tables.speakers.id)
        )
        .where(
          and(
            eq(this.tables.storySpeakers.communityId, communityId),
            speakerBaseConditionForViewer(
              this.tables.speakers,
              communityId,
              viewer
            ),
            inArray(this.tables.storySpeakers.storyId, chunk)
          )
        )
        .orderBy(
          asc(sql`COALESCE(${this.tables.storySpeakers.sortOrder}, 0)`),
          asc(this.tables.storySpeakers.id)
        );

      // Preserve edge multiplicity and deterministic (sortOrder, id) order (SPEC-V2 §6.3).
      for (const row of rows) {
        const list = result.get(row.storyId) ?? [];
        list.push({
          id: row.id,
          communityId: row.communityId,
          name: row.name,
          birthDate: row.birthDate,
          birthplaceId: row.birthplaceId,
          affiliation: row.affiliation,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        });
        result.set(row.storyId, list);
      }
    }

    return result;
  }

  private async loadVisiblePlacesById(
    communityId: number,
    placeIds: number[],
    viewer: ReadRuleViewer = ANON_PUBLIC
  ): Promise<Map<number, PublicPlaceRecord>> {
    const result = new Map<number, PublicPlaceRecord>();
    if (placeIds.length === 0) {
      return result;
    }

    for (const chunk of chunkValues(Array.from(new Set(placeIds)))) {
      const rows = await this.database
        .select({
          id: this.tables.places.id,
          communityId: this.tables.places.communityId,
          name: this.tables.places.name,
          description: this.tables.places.description,
          typeOfPlace: this.tables.places.typeOfPlace,
          region: this.tables.places.region,
          latitude: this.tables.places.latitude,
          longitude: this.tables.places.longitude,
          createdAt: this.tables.places.createdAt,
          updatedAt: this.tables.places.updatedAt,
        })
        .from(this.tables.places)
        .where(
          and(
            placeBaseConditionForViewer(
              this.tables.places,
              communityId,
              viewer
            ),
            inArray(this.tables.places.id, chunk)
          )
        );
      for (const row of rows) {
        result.set(row.id, row);
      }
    }

    return result;
  }

  private async loadReadableBirthplacesMap(
    communityId: number,
    speakers: PublicSpeakerRecord[],
    viewer: ReadRuleViewer = ANON_PUBLIC
  ): Promise<Map<number, PublicPlaceRecord>> {
    const birthplaceIds = Array.from(
      new Set(
        speakers
          .map((speaker) => speaker.birthplaceId)
          .filter((id): id is number => id !== null)
      )
    );
    const result = new Map<number, PublicPlaceRecord>();
    if (birthplaceIds.length === 0) {
      return result;
    }

    for (const chunk of chunkValues(birthplaceIds)) {
      const rows = await this.database
        .select({
          id: this.tables.places.id,
          communityId: this.tables.places.communityId,
          name: this.tables.places.name,
          description: this.tables.places.description,
          typeOfPlace: this.tables.places.typeOfPlace,
          region: this.tables.places.region,
          latitude: this.tables.places.latitude,
          longitude: this.tables.places.longitude,
          createdAt: this.tables.places.createdAt,
          updatedAt: this.tables.places.updatedAt,
        })
        .from(this.tables.places)
        .where(
          and(
            this.placeReadableConditions(communityId, viewer),
            inArray(this.tables.places.id, chunk)
          )
        );
      for (const row of rows) {
        result.set(row.id, row);
      }
    }

    return result;
  }

  private async loadActiveSpeakersById(
    communityId: number,
    speakerIds: number[],
    viewer: ReadRuleViewer = ANON_PUBLIC
  ): Promise<Map<number, PublicSpeakerRecord>> {
    const result = new Map<number, PublicSpeakerRecord>();
    if (speakerIds.length === 0) {
      return result;
    }

    for (const chunk of chunkValues(Array.from(new Set(speakerIds)))) {
      const rows = await this.database
        .select({
          id: this.tables.speakers.id,
          communityId: this.tables.speakers.communityId,
          name: this.tables.speakers.name,
          birthDate: this.tables.speakers.birthDate,
          birthplaceId: this.tables.speakers.birthplaceId,
          affiliation: this.tables.speakers.affiliation,
          createdAt: this.tables.speakers.createdAt,
          updatedAt: this.tables.speakers.updatedAt,
        })
        .from(this.tables.speakers)
        .where(
          and(
            speakerBaseConditionForViewer(
              this.tables.speakers,
              communityId,
              viewer
            ),
            inArray(this.tables.speakers.id, chunk)
          )
        );
      for (const row of rows) {
        result.set(row.id, row);
      }
    }

    return result;
  }

  private async loadStoryAttachmentsMap(
    communityId: number,
    storyIds: number[],
    viewer: ReadRuleViewer = ANON_PUBLIC
  ): Promise<Map<number, PublicStoryAttachmentRecord[]>> {
    const result = new Map<number, PublicStoryAttachmentRecord[]>();
    if (!storyMediaAllowedForViewer(viewer) || storyIds.length === 0) {
      return result;
    }

    for (const chunk of chunkValues(storyIds)) {
      const rows = await this.database
        .select({
          id: this.tables.attachments.id,
          storyId: this.tables.attachments.ownerId,
          fileId: this.tables.files.id,
          ordinal: this.tables.attachments.ordinal,
          mimeType: this.tables.files.mimeType,
          byteSize: this.tables.files.byteSize,
          size: this.tables.files.size,
          originalName: this.tables.files.originalName,
        })
        .from(this.tables.attachments)
        .innerJoin(
          this.tables.files,
          eq(this.tables.attachments.fileId, this.tables.files.id)
        )
        .where(
          and(
            eq(this.tables.attachments.communityId, communityId),
            eq(this.tables.attachments.ownerType, 'story'),
            eq(this.tables.attachments.role, 'story_media'),
            activeUnrestrictedFileCondition(this.tables.files, communityId),
            inArray(this.tables.attachments.ownerId, chunk)
          )
        )
        .orderBy(
          asc(this.tables.attachments.ordinal),
          asc(this.tables.attachments.id)
        );

      for (const row of rows) {
        if (row.storyId === null) continue;
        const list = result.get(row.storyId) ?? [];
        list.push({
          id: row.id,
          storyId: row.storyId,
          fileId: row.fileId,
          role: 'story_media',
          ordinal: row.ordinal ?? 0,
          mimeType: row.mimeType,
          byteSize: Number(row.byteSize ?? row.size),
          originalName: row.originalName,
        });
        result.set(row.storyId, list);
      }
    }

    return result;
  }

  private async loadStoryExternalLinksMap(
    communityId: number,
    storyIds: number[]
  ): Promise<Map<number, PublicExternalMediaLinkRecord[]>> {
    const result = new Map<number, PublicExternalMediaLinkRecord[]>();
    if (storyIds.length === 0) {
      return result;
    }

    for (const chunk of chunkValues(storyIds)) {
      const rows = await this.database
        .select({
          id: this.tables.externalMediaLinks.id,
          storyId: this.tables.externalMediaLinks.storyId,
          url: this.tables.externalMediaLinks.url,
          ordinal: this.tables.externalMediaLinks.ordinal,
          createdAt: this.tables.externalMediaLinks.createdAt,
        })
        .from(this.tables.externalMediaLinks)
        .where(
          and(
            eq(this.tables.externalMediaLinks.communityId, communityId),
            inArray(this.tables.externalMediaLinks.storyId, chunk)
          )
        )
        .orderBy(
          asc(this.tables.externalMediaLinks.ordinal),
          asc(this.tables.externalMediaLinks.id)
        );

      for (const row of rows) {
        const list = result.get(row.storyId) ?? [];
        list.push(row);
        result.set(row.storyId, list);
      }
    }

    return result;
  }

  private async loadPlaceMediaMaps(
    communityId: number,
    placeIds: number[],
    viewer: ReadRuleViewer = ANON_PUBLIC
  ): Promise<{
    photosByPlaceId: Map<number, string[]>;
    placenameAudioByPlaceId: Map<number, string>;
  }> {
    const photosByPlaceId = new Map<number, string[]>();
    const placenameAudioByPlaceId = new Map<number, string>();
    if (!associatedMediaAllowedForViewer(viewer) || placeIds.length === 0) {
      return { photosByPlaceId, placenameAudioByPlaceId };
    }

    for (const chunk of chunkValues(Array.from(new Set(placeIds)))) {
      const rows = await this.database
        .select({
          placeId: this.tables.attachments.ownerId,
          fileId: this.tables.files.id,
          role: this.tables.attachments.role,
          ordinal: this.tables.attachments.ordinal,
        })
        .from(this.tables.attachments)
        .innerJoin(
          this.tables.files,
          eq(this.tables.attachments.fileId, this.tables.files.id)
        )
        .where(
          and(
            eq(this.tables.attachments.communityId, communityId),
            eq(this.tables.attachments.ownerType, 'place'),
            inArray(this.tables.attachments.role, [
              'place_photo',
              'place_name_audio',
            ]),
            activeUnrestrictedFileCondition(this.tables.files, communityId),
            inArray(this.tables.attachments.ownerId, chunk)
          )
        )
        .orderBy(
          asc(this.tables.attachments.ordinal),
          asc(this.tables.attachments.id)
        );

      for (const row of rows) {
        if (row.placeId === null) continue;
        if (row.role === 'place_photo') {
          const list = photosByPlaceId.get(row.placeId) ?? [];
          list.push(row.fileId);
          photosByPlaceId.set(row.placeId, list);
        } else if (
          row.role === 'place_name_audio' &&
          !placenameAudioByPlaceId.has(row.placeId)
        ) {
          placenameAudioByPlaceId.set(row.placeId, row.fileId);
        }
      }
    }

    return { photosByPlaceId, placenameAudioByPlaceId };
  }

  private async loadSpeakerPhotosMap(
    communityId: number,
    speakerIds: number[],
    viewer: ReadRuleViewer = ANON_PUBLIC
  ): Promise<Map<number, string>> {
    const result = new Map<number, string>();
    if (!associatedMediaAllowedForViewer(viewer) || speakerIds.length === 0) {
      return result;
    }

    for (const chunk of chunkValues(Array.from(new Set(speakerIds)))) {
      const rows = await this.database
        .select({
          speakerId: this.tables.attachments.ownerId,
          fileId: this.tables.files.id,
        })
        .from(this.tables.attachments)
        .innerJoin(
          this.tables.files,
          eq(this.tables.attachments.fileId, this.tables.files.id)
        )
        .where(
          and(
            eq(this.tables.attachments.communityId, communityId),
            eq(this.tables.attachments.ownerType, 'speaker'),
            eq(this.tables.attachments.role, 'speaker_photo'),
            activeUnrestrictedFileCondition(this.tables.files, communityId),
            inArray(this.tables.attachments.ownerId, chunk)
          )
        )
        .orderBy(
          asc(this.tables.attachments.ordinal),
          asc(this.tables.attachments.id)
        );

      for (const row of rows) {
        if (row.speakerId !== null && !result.has(row.speakerId)) {
          result.set(row.speakerId, row.fileId);
        }
      }
    }

    return result;
  }
}
