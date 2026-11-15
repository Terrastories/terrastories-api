/**
 * Read-only data access for canonical V2 `/v2/public/communities*` endpoints
 * (Slice 4, #145).
 *
 * Reuses `ExploreAdapterRepository` sovereignty gates, normalized Unicode
 * community search, and `#162` option A story/place/speaker visibility
 * predicates so public projections cannot drift across `/v2/public/*` and
 * `/explore/*`.
 */
import { and, asc, eq, inArray, isNotNull, isNull, ne } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import type { Database } from '../db/index.js';
import { dialectOf, tablesFor } from '../db/dialect.js';
import {
  communityMediaPg,
  communityMediaSqlite,
} from '../db/schema/sessions.js';
import {
  ExploreAdapterRepository,
  type ExploreCommunityRow,
  type ExplorePlaceRow,
  type ExploreSpeakerRow,
} from './explore-adapter.repository.js';

export type PublicCommunityRow = ExploreCommunityRow;
export type PublicPlaceRow = ExplorePlaceRow;
export type PublicSpeakerRow = ExploreSpeakerRow;

export interface PublicMapConfigRow {
  communityId: number;
  styleUrl: string | null;
  basemapStyle: string | null;
  centerLatitude: number | null;
  centerLongitude: number | null;
  southWestLatitude: number | null;
  southWestLongitude: number | null;
  northEastLatitude: number | null;
  northEastLongitude: number | null;
  zoom: number | null;
  pitch: number | null;
  bearing: number | null;
  threeDimensional: boolean | null;
  projection: string | null;
  staticMapFileId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PublicCommunityBrandingRow {
  displayImageFileId: string | null;
  backgroundImageFileId: string | null;
  sponsorLogos: Array<{ fileId: string; ordinal: number }>;
}

interface RawMapConfigJoinRow {
  communityId: number;
  styleUrl: string | null;
  basemapStyle: string | null;
  centerLatitude: number | null;
  centerLongitude: number | null;
  southWestLatitude: number | null;
  southWestLongitude: number | null;
  northEastLatitude: number | null;
  northEastLongitude: number | null;
  zoom: number | null;
  pitch: number | null;
  bearing: number | null;
  threeDimensional: boolean | null;
  projection: string | null;
  staticMapFileId: string | null;
  createdAt: Date;
  updatedAt: Date;
  fileId: string | null;
  fileCommunityId: number | null;
  fileIsActive: boolean | null;
  fileCulturalRestrictions: unknown;
}

const COMMUNITY_BRANDING_ROLES = [
  'community_display_image',
  'community_background_image',
  'sponsor_logo',
] as const;

export function compareCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function distinctSortedNonEmpty(values: Array<string | null>): string[] {
  const unique = new Set<string>();
  for (const value of values) {
    if (value !== null && value.trim() !== '') {
      unique.add(value);
    }
  }
  return Array.from(unique).sort(compareCodePoint);
}

function toSafeMapConfig(row: RawMapConfigJoinRow): PublicMapConfigRow {
  const safeStaticMapFileId =
    row.staticMapFileId !== null &&
    row.fileId === row.staticMapFileId &&
    row.fileCommunityId === row.communityId &&
    row.fileIsActive === true &&
    row.fileCulturalRestrictions === null
      ? row.fileId
      : null;

  return {
    communityId: row.communityId,
    styleUrl: row.styleUrl,
    basemapStyle: row.basemapStyle,
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
    staticMapFileId: safeStaticMapFileId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function emptyBranding(): PublicCommunityBrandingRow {
  return {
    displayImageFileId: null,
    backgroundImageFileId: null,
    sponsorLogos: [],
  };
}

export class PublicCommunitiesRepository {
  readonly explore: ExploreAdapterRepository;
  private readonly tables: ReturnType<typeof tablesFor>;
  private readonly communityMedia: typeof communityMediaSqlite;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly database: any;

  constructor(database: Database | DrizzleD1Database) {
    this.database = database;
    this.explore = new ExploreAdapterRepository(database);
    const dialect = dialectOf(database);
    this.tables = tablesFor(database);
    this.communityMedia = (
      dialect === 'postgresql' ? communityMediaPg : communityMediaSqlite
    ) as typeof communityMediaSqlite;
  }

  publicCommunities(search?: string): Promise<PublicCommunityRow[]> {
    return this.explore.publicCommunities(search);
  }

  publicCommunityBySlug(slug: string): Promise<PublicCommunityRow | null> {
    return this.explore.publicCommunityBySlug(slug);
  }

  publicStoriesCount(communityId: number): Promise<number> {
    return this.explore.publicStoriesCount(communityId);
  }

  publicPlacesOfCommunityStories(
    communityId: number
  ): Promise<PublicPlaceRow[]> {
    return this.explore.publicPlacesOfCommunityStories(communityId);
  }

  filterPlaces(
    communityId: number
  ): Promise<Array<{ id: number; name: string }>> {
    return this.explore.filterPlaces(communityId);
  }

  async filterRegions(communityId: number): Promise<string[]> {
    return distinctSortedNonEmpty(
      await this.explore.filterRegions(communityId)
    );
  }

  async filterTypesOfPlace(communityId: number): Promise<string[]> {
    const { places, speakers, stories, storyPlaces, storySpeakers } =
      this.tables;
    const rows: Array<{ typeOfPlace: string | null }> = await this.database
      .selectDistinct({ typeOfPlace: places.typeOfPlace })
      .from(places)
      .innerJoin(storyPlaces, eq(storyPlaces.placeId, places.id))
      .innerJoin(stories, eq(stories.id, storyPlaces.storyId))
      .innerJoin(storySpeakers, eq(storySpeakers.storyId, stories.id))
      .innerJoin(speakers, eq(speakers.id, storySpeakers.speakerId))
      .where(
        and(
          this.explore.visiblePlaceConditions(communityId),
          this.explore.storyRelationConditions(communityId),
          isNotNull(places.typeOfPlace),
          ne(places.typeOfPlace, '')
        )
      );
    return distinctSortedNonEmpty(rows.map((row) => row.typeOfPlace));
  }

  filterSpeakers(communityId: number): Promise<PublicSpeakerRow[]> {
    return this.explore.filterSpeakers(communityId);
  }

  async filterTopics(communityId: number): Promise<string[]> {
    const { places, speakers, stories, storyPlaces, storySpeakers } =
      this.tables;
    const rows: Array<{ topic: string | null }> = await this.database
      .selectDistinct({ topic: stories.topic })
      .from(stories)
      .innerJoin(storyPlaces, eq(storyPlaces.storyId, stories.id))
      .innerJoin(places, eq(places.id, storyPlaces.placeId))
      .innerJoin(storySpeakers, eq(storySpeakers.storyId, stories.id))
      .innerJoin(speakers, eq(speakers.id, storySpeakers.speakerId))
      .where(
        and(
          this.explore.storyRelationConditions(communityId),
          isNotNull(stories.topic),
          ne(stories.topic, '')
        )
      );
    return distinctSortedNonEmpty(rows.map((row) => row.topic));
  }

  async filterLanguages(communityId: number): Promise<string[]> {
    return distinctSortedNonEmpty(
      await this.explore.filterLanguages(communityId)
    );
  }

  async filterAffiliations(communityId: number): Promise<string[]> {
    const { places, speakers, stories, storyPlaces, storySpeakers } =
      this.tables;
    const rows: Array<{ affiliation: string | null }> = await this.database
      .selectDistinct({ affiliation: speakers.affiliation })
      .from(speakers)
      .innerJoin(storySpeakers, eq(storySpeakers.speakerId, speakers.id))
      .innerJoin(stories, eq(stories.id, storySpeakers.storyId))
      .innerJoin(storyPlaces, eq(storyPlaces.storyId, stories.id))
      .innerJoin(places, eq(places.id, storyPlaces.placeId))
      .where(
        and(
          this.explore.storyRelationConditions(communityId),
          isNotNull(speakers.affiliation),
          ne(speakers.affiliation, '')
        )
      );
    return distinctSortedNonEmpty(rows.map((row) => row.affiliation));
  }

  async communityMapConfig(
    communityId: number
  ): Promise<PublicMapConfigRow | null> {
    const map = await this.queryMapConfigs(communityId);
    return map.get(communityId) ?? null;
  }

  async publicCommunityMapConfigs(): Promise<Map<number, PublicMapConfigRow>> {
    return this.queryMapConfigs();
  }

  private async queryMapConfigs(
    communityId?: number
  ): Promise<Map<number, PublicMapConfigRow>> {
    const { communities, communityMapConfigs, files } = this.tables;
    const whereClause =
      communityId !== undefined
        ? and(
            eq(communityMapConfigs.communityId, communityId),
            this.explore.publicCommunityGate()
          )
        : this.explore.publicCommunityGate();

    const rows: RawMapConfigJoinRow[] = await this.database
      .select({
        communityId: communityMapConfigs.communityId,
        styleUrl: communityMapConfigs.styleUrl,
        basemapStyle: communityMapConfigs.basemapStyle,
        centerLatitude: communityMapConfigs.centerLatitude,
        centerLongitude: communityMapConfigs.centerLongitude,
        southWestLatitude: communityMapConfigs.southWestLatitude,
        southWestLongitude: communityMapConfigs.southWestLongitude,
        northEastLatitude: communityMapConfigs.northEastLatitude,
        northEastLongitude: communityMapConfigs.northEastLongitude,
        zoom: communityMapConfigs.zoom,
        pitch: communityMapConfigs.pitch,
        bearing: communityMapConfigs.bearing,
        threeDimensional: communityMapConfigs.threeDimensional,
        projection: communityMapConfigs.projection,
        staticMapFileId: communityMapConfigs.staticMapFileId,
        createdAt: communityMapConfigs.createdAt,
        updatedAt: communityMapConfigs.updatedAt,
        fileId: files.id,
        fileCommunityId: files.communityId,
        fileIsActive: files.isActive,
        fileCulturalRestrictions: files.culturalRestrictions,
      })
      .from(communityMapConfigs)
      .innerJoin(
        communities,
        eq(communities.id, communityMapConfigs.communityId)
      )
      .leftJoin(files, eq(files.id, communityMapConfigs.staticMapFileId))
      .where(whereClause);

    const byCommunity = new Map<number, PublicMapConfigRow>();
    for (const row of rows) {
      byCommunity.set(row.communityId, toSafeMapConfig(row));
    }
    return byCommunity;
  }

  async communityBranding(
    communityId: number
  ): Promise<PublicCommunityBrandingRow> {
    const map = await this.queryBrandings(communityId);
    return map.get(communityId) ?? emptyBranding();
  }

  async publicCommunityBrandings(): Promise<
    Map<number, PublicCommunityBrandingRow>
  > {
    return this.queryBrandings();
  }

  private async queryBrandings(
    communityId?: number
  ): Promise<Map<number, PublicCommunityBrandingRow>> {
    const { attachments, communities, files } = this.tables;
    const media = this.communityMedia;

    const attachmentWhere = and(
      eq(attachments.ownerType, 'community'),
      inArray(attachments.role, [...COMMUNITY_BRANDING_ROLES]),
      eq(files.isActive, true),
      isNull(files.culturalRestrictions),
      this.explore.publicCommunityGate(),
      ...(communityId !== undefined ? [eq(communities.id, communityId)] : [])
    );

    const fallbackWhere = and(
      eq(media.kind, 'branding'),
      eq(files.communityId, media.communityId),
      eq(files.isActive, true),
      isNull(files.culturalRestrictions),
      this.explore.publicCommunityGate(),
      ...(communityId !== undefined ? [eq(communities.id, communityId)] : [])
    );

    const [attachmentRows, fallbackRows]: [
      Array<{
        communityId: number;
        role: string | null;
        ordinal: number | null;
        fileId: string;
      }>,
      Array<{
        communityId: number;
        fileId: string;
      }>,
    ] = await Promise.all([
      this.database
        .select({
          communityId: communities.id,
          role: attachments.role,
          ordinal: attachments.ordinal,
          fileId: files.id,
        })
        .from(attachments)
        .innerJoin(communities, eq(communities.id, attachments.ownerId))
        .innerJoin(
          files,
          and(
            eq(files.id, attachments.fileId),
            eq(files.communityId, communities.id)
          )
        )
        .where(attachmentWhere)
        .orderBy(asc(attachments.ordinal), asc(attachments.id)),
      this.database
        .select({
          communityId: communities.id,
          fileId: files.id,
        })
        .from(media)
        .innerJoin(communities, eq(communities.id, media.communityId))
        .innerJoin(files, eq(files.id, media.fileId))
        .where(fallbackWhere)
        .orderBy(asc(files.id)),
    ]);

    const byCommunity = new Map<number, PublicCommunityBrandingRow>();
    const ensure = (id: number) => {
      let entry = byCommunity.get(id);
      if (!entry) {
        entry = emptyBranding();
        byCommunity.set(id, entry);
      }
      return entry;
    };

    for (const row of attachmentRows) {
      if (row.role === null) continue;
      const entry = ensure(row.communityId);
      if (
        row.role === 'community_display_image' &&
        entry.displayImageFileId === null
      ) {
        entry.displayImageFileId = row.fileId;
      } else if (
        row.role === 'community_background_image' &&
        entry.backgroundImageFileId === null
      ) {
        entry.backgroundImageFileId = row.fileId;
      } else if (row.role === 'sponsor_logo') {
        entry.sponsorLogos.push({
          fileId: row.fileId,
          // The response schema requires ordinal >= 0 and the column has no CHECK;
          // clamp so one bad row cannot turn the public list into a 500.
          ordinal: Math.max(0, row.ordinal ?? 0),
        });
      }
    }

    for (const row of fallbackRows) {
      const entry = ensure(row.communityId);
      if (entry.displayImageFileId === null) {
        entry.displayImageFileId = row.fileId;
      }
    }

    return byCommunity;
  }
}
