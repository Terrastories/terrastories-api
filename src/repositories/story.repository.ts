/**
 * Story Repository
 *
 * Complete database-driven implementation for story management with
 * community isolation, search capabilities, and association handling.
 */

import type { TransitionalStoryReadAccess } from '../shared/authorization/sovereignty-policy.js';
import {
  eq,
  and,
  desc,
  lt,
  or,
  sql,
  count,
  inArray,
  asc,
  type AnyColumn,
  type SQL,
} from 'drizzle-orm';
import {
  containsInsensitive,
  dialectOf,
  tablesFor,
  type Dialect,
  type DialectTables,
} from '../db/dialect.js';
import type { Database } from '../db/index.js';

/**
 * Association order, identical on both backends: sortOrder ascending with
 * NULLs last (SQLite sorts NULL first, PostgreSQL last by default), then the
 * join row id so equal sortOrder values keep a stable order.
 */
function associationOrder(table: {
  sortOrder: AnyColumn;
  id: AnyColumn;
}): SQL[] {
  return [sql`${table.sortOrder} IS NULL`, asc(table.sortOrder), asc(table.id)];
}

/**
 * Distinct ids in first-seen order, with the index of their first
 * occurrence. Association lists are sets: a repeated id is the same link (the
 * join tables are unique on story + target), and per-id inputs
 * given in parallel arrays (placeContexts, speakerRoles) stay aligned after
 * duplicates are dropped.
 */
function distinctIdEntries(
  ids: number[]
): Array<{ id: number; sourceIndex: number }> {
  const seen = new Set<number>();
  const entries: Array<{ id: number; sourceIndex: number }> = [];
  ids.forEach((id, sourceIndex) => {
    if (seen.has(id)) return;
    seen.add(id);
    entries.push({ id, sourceIndex });
  });
  return entries;
}

/** or() of at least one condition is always defined. */
function sqlOr(...conditions: [SQL, ...SQL[]]): SQL {
  return or(...conditions) as SQL;
}

/** SPEC-V2 Section 6.3 application-defined tag comparison key. */
export function normalizeTag(tag: string): string {
  return tag.normalize('NFC').toLowerCase();
}

/**
 * Core story data structure
 */
export interface Story {
  id: number;
  title: string;
  description?: string | null;
  slug: string;
  communityId: number;
  createdBy: number;
  mediaUrls: string[] | null;
  // Direct file URL columns for dual-read capability (Issue #89)
  imageUrl?: string | null;
  audioUrl?: string | null;
  language: string;
  tags: string[] | null;
  isRestricted: boolean;
  privacyLevel: string;
  // Interview metadata fields for Indigenous storytelling context
  dateInterviewed?: Date | null;
  interviewLocationId?: number | null;
  interviewerId?: number | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Cultural protocols for story access and modifications
 */
export interface CulturalProtocols {
  permissionLevel: 'public' | 'community' | 'restricted' | 'elder_only';
  culturalSignificance?: string;
  restrictions?: string[];
  ceremonialContent?: boolean;
  elderApprovalRequired?: boolean;
  accessNotes?: string;
}

/**
 * Story with all related data populated
 */
export interface StoryWithRelations extends Story {
  culturalProtocols?: CulturalProtocols;
  places: Array<{
    id: number;
    name: string;
    description?: string;
    latitude: number;
    longitude: number;
    region?: string;
    culturalSignificance?: string;
    culturalContext?: string;
    storyRelationship?: string;
    sortOrder?: number;
    /**
     * Physical Fastify restriction flag (places.is_restricted). Carried so
     * services can apply the story-derived place projection (SPEC-V2 §6.4):
     * a readable story never widens a restricted place's audience.
     */
    isRestricted: boolean;
  }>;
  speakers: Array<{
    id: number;
    name: string;
    bio?: string;
    photoUrl?: string;
    birthYear?: number;
    elderStatus: boolean;
    culturalRole?: string;
    storyRole?: string;
    sortOrder?: number;
    /**
     * Physical Fastify withdrawal flag (speakers.is_active). Carried so
     * services can apply the story-derived speaker projection (SPEC-V2
     * §6.5): callers without the editor/admin gate never see a withdrawn
     * speaker inside a readable story. Not a DTO field.
     */
    isActive: boolean;
  }>;
  community: {
    id: number;
    name: string;
    description?: string | null;
    slug: string;
    locale: string;
  };
  author: {
    id: number;
    firstName: string;
    lastName: string;
    role: string;
  };
  // Interview metadata relationships
  interviewLocation?: {
    id: number;
    name: string;
    description?: string;
    latitude: number;
    longitude: number;
    region?: string;
    culturalSignificance?: string;
  } | null;
  interviewer?: {
    id: number;
    name: string;
    bio?: string;
    photoUrl?: string;
    birthYear?: number;
    elderStatus: boolean;
    culturalRole?: string;
    isActive: boolean;
  } | null;
}

/**
 * Story creation data
 */
export interface StoryCreateData {
  title: string;
  description?: string;
  slug?: string;
  communityId: number;
  createdBy: number;
  mediaUrls?: string[];
  // Direct file URL fields for dual-read capability (Issue #89)
  imageUrl?: string;
  audioUrl?: string;
  language?: string;
  tags?: string[];
  isRestricted?: boolean;
  culturalProtocols?: CulturalProtocols;
  placeIds?: number[];
  speakerIds?: number[];
  placeContexts?: string[];
  speakerRoles?: string[];
  // Interview metadata for Indigenous storytelling context
  dateInterviewed?: Date;
  interviewLocationId?: number;
  interviewerId?: number;
}

/**
 * Story update data
 */
export interface StoryUpdateData {
  title?: string;
  description?: string;
  mediaUrls?: string[];
  // Direct file URL fields for dual-read capability (Issue #89)
  imageUrl?: string;
  audioUrl?: string;
  language?: string;
  tags?: string[];
  isRestricted?: boolean;
  culturalProtocols?: CulturalProtocols;
  placeIds?: number[];
  speakerIds?: number[];
  placeContexts?: string[];
  speakerRoles?: string[];
  // Interview metadata for Indigenous storytelling context
  dateInterviewed?: Date;
  interviewLocationId?: number;
  interviewerId?: number;
}

/**
 * Basic GeoJSON Point interface
 */
export interface GeoJSONPoint {
  type: 'Point';
  coordinates: [number, number]; // [longitude, latitude]
}

/**
 * Story filtering options
 */
export interface StoryFilters {
  search?: string;
  communityId?: number;
  isRestricted?: boolean;
  privacyLevel?: string;
  /**
   * Runtime read accesses the caller may hold (SPEC-V2 §6.2/§6.3):
   * canonical audiences only; `unavailable` rows (restricted or unknown
   * privacyLevel) are readable by no role. Transcribed to SQL exactly as
   * documented on `fastifyStoryToAudience` in the sovereignty policy; keep
   * both in sync. An empty array matches no row (fail closed).
   */
  storyAudiences?: TransitionalStoryReadAccess[];
  tags?: string[];
  createdBy?: number;
  language?: string;
  nearPoint?: GeoJSONPoint;
  radiusKm?: number;
  dateFrom?: Date;
  dateTo?: Date;
}

/**
 * Pagination options
 */
export interface PaginationOptions {
  page: number;
  limit: number;
  sortBy?: 'createdAt' | 'title' | 'updatedAt';
  sortOrder?: 'asc' | 'desc';
}

/**
 * Paginated result wrapper
 */
export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/**
 * Database-driven Story Repository with proper join table associations
 */
export class StoryRepository {
  private readonly dialect: Dialect;
  private readonly tables: DialectTables;
  private readonly database: Database;

  constructor(database: Database) {
    this.database = database;
    this.dialect = dialectOf(database);
    this.tables = tablesFor(database);
  }

  // Both Drizzle instances expose the same query-builder surface; the union
  // type is not callable directly, so queries go through a widened handle.
  private get db() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- cross-dialect Drizzle query interfaces are behaviorally equivalent
    return this.database as any;
  }

  // Tables come from the Drizzle instance this repository was given, so the
  // same code runs against SQLite/D1 and PostgreSQL.
  private getStoriesTable() {
    return this.tables.stories;
  }

  private getCommunitiesTable() {
    return this.tables.communities;
  }

  private getUsersTable() {
    return this.tables.users;
  }

  private getPlacesTable() {
    return this.tables.places;
  }

  private getSpeakersTable() {
    return this.tables.speakers;
  }

  private getStoryPlacesTable() {
    return this.tables.storyPlaces;
  }

  private getStorySpeakersTable() {
    return this.tables.storySpeakers;
  }

  /**
   * Create a new story with associations
   */
  async create(data: StoryCreateData): Promise<StoryWithRelations> {
    // Basic validation - simulate database constraints
    if (!data.title || data.title.trim() === '') {
      throw new Error('Title is required');
    }

    // Generate slug if not provided
    const slug =
      data.slug ||
      (await this.generateUniqueSlug(data.title, data.communityId));

    // Insert story into database
    const now = new Date();
    const insertData = {
      title: data.title,
      description: data.description,
      slug,
      communityId: data.communityId,
      createdBy: data.createdBy,
      mediaUrls: data.mediaUrls || [],
      language: data.language || 'en',
      tags: data.tags || [],
      isRestricted: data.isRestricted || false,
      // Interview metadata for Indigenous storytelling context
      dateInterviewed: data.dateInterviewed,
      interviewLocationId: data.interviewLocationId,
      interviewerId: data.interviewerId,
      createdAt: now,
      updatedAt: now,
    };

    const [story] = await this.db
      .insert(this.getStoriesTable())
      .values(insertData)
      .returning();

    // Create place associations using proper join table
    if (data.placeIds?.length) {
      const associationTimestamp = new Date();
      const placeAssociations = distinctIdEntries(data.placeIds).map(
        ({ id: placeId, sourceIndex }, index) => ({
          // Composite tenant FK (#186): join rows carry the story's community.
          communityId: story.communityId,
          storyId: story.id,
          placeId,
          culturalContext: data.placeContexts?.[sourceIndex] || undefined,
          sortOrder: index,
          createdAt: associationTimestamp,
          updatedAt: associationTimestamp,
        })
      );

      await this.db
        .insert(this.getStoryPlacesTable())
        .values(placeAssociations);
    }

    // Create speaker associations using proper join table
    if (data.speakerIds?.length) {
      const speakerTimestamp = new Date();
      const speakerAssociations = distinctIdEntries(data.speakerIds).map(
        ({ id: speakerId, sourceIndex }, index) => ({
          // Composite tenant FK (#186): join rows carry the story's community.
          communityId: story.communityId,
          storyId: story.id,
          speakerId,
          storyRole: data.speakerRoles?.[sourceIndex] || undefined,
          sortOrder: index,
          createdAt: speakerTimestamp,
          updatedAt: speakerTimestamp,
        })
      );

      await this.db
        .insert(this.getStorySpeakersTable())
        .values(speakerAssociations);
    }

    // Return with populated associations
    return (await this.findByIdWithRelations(story.id)) as StoryWithRelations;
  }

  /**
   * Find story by ID
   */
  async findById(id: number, communityId?: number): Promise<Story | null> {
    const storiesTable = this.getStoriesTable();
    const condition =
      communityId === undefined
        ? eq(storiesTable.id, id)
        : and(
            eq(storiesTable.id, id),
            eq(storiesTable.communityId, communityId)
          );
    const [story] = await this.db
      .select()
      .from(storiesTable)
      .where(condition)
      .limit(1);

    return story || null;
  }

  /**
   * Find story by ID with all relations, optionally scoped to one community.
   */
  async findByIdWithRelations(
    id: number,
    communityId?: number
  ): Promise<StoryWithRelations | null> {
    // Scope the base lookup before loading any related community content.
    const story = await this.findById(id, communityId);
    if (!story) return null;

    // Get community
    const communitiesTable = this.getCommunitiesTable();
    const [community] = await this.db
      .select()
      .from(communitiesTable)
      .where(eq(communitiesTable.id, story.communityId))
      .limit(1);

    // Get author
    const usersTable = this.getUsersTable();
    const [author] = await this.db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, story.createdBy))
      .limit(1);

    // Get places through proper database joins
    const storyPlacesTable = this.getStoryPlacesTable();
    const placesTable = this.getPlacesTable();
    const placesWithAssociations = await this.db
      .select({
        id: placesTable.id,
        name: placesTable.name,
        description: placesTable.description,
        latitude: placesTable.latitude,
        longitude: placesTable.longitude,
        region: placesTable.region,
        culturalSignificance: placesTable.culturalSignificance,
        // SPEC-V2 §6.4: place restriction flag for the story-derived place
        // projection in StoryService.
        isRestricted: placesTable.isRestricted,
        culturalContext: storyPlacesTable.culturalContext,
        sortOrder: storyPlacesTable.sortOrder,
      })
      .from(storyPlacesTable)
      .innerJoin(placesTable, eq(storyPlacesTable.placeId, placesTable.id))
      // SPEC-V2 §6.4: a restricted Fastify place is unavailable to every
      // role, so it never appears in story.places — enforced here at the
      // data layer and again by the StoryService projection.
      .where(
        and(
          eq(storyPlacesTable.storyId, id),
          eq(placesTable.isRestricted, false)
        )
      )
      .orderBy(...associationOrder(storyPlacesTable));

    const places = placesWithAssociations.map(
      (p: {
        id: number;
        name: string;
        description: string | null;
        latitude: number;
        longitude: number;
        region: string | null;
        culturalSignificance: string | null;
        isRestricted: boolean;
        culturalContext: string | null;
        sortOrder: number | null;
      }) => ({
        id: p.id,
        name: p.name,
        description: p.description || undefined,
        latitude: p.latitude,
        longitude: p.longitude,
        region: p.region || undefined,
        culturalSignificance: p.culturalSignificance || undefined,
        isRestricted: p.isRestricted,
        culturalContext: p.culturalContext || undefined,
        storyRelationship: 'mentioned',
        sortOrder: p.sortOrder || 0,
      })
    );

    // Get speakers through proper database joins
    const storySpeakersTable = this.getStorySpeakersTable();
    const speakersTable = this.getSpeakersTable();
    const speakersWithAssociations = await this.db
      .select({
        id: speakersTable.id,
        name: speakersTable.name,
        bio: speakersTable.bio,
        photoUrl: speakersTable.photoUrl,
        birthYear: speakersTable.birthYear,
        elderStatus: speakersTable.elderStatus,
        culturalRole: speakersTable.culturalRole,
        // SPEC-V2 §6.5: speaker withdrawal flag for the story-derived
        // speaker projection in StoryService.
        isActive: speakersTable.isActive,
        storyRole: storySpeakersTable.storyRole,
        sortOrder: storySpeakersTable.sortOrder,
      })
      .from(storySpeakersTable)
      .innerJoin(
        speakersTable,
        eq(storySpeakersTable.speakerId, speakersTable.id)
      )
      .where(eq(storySpeakersTable.storyId, id))
      .orderBy(...associationOrder(storySpeakersTable));

    const speakers = speakersWithAssociations.map(
      (s: {
        id: number;
        name: string;
        bio: string | null;
        photoUrl: string | null;
        birthYear: number | null;
        elderStatus: boolean;
        culturalRole: string | null;
        isActive: boolean;
        storyRole: string | null;
        sortOrder: number | null;
      }) => ({
        id: s.id,
        name: s.name,
        bio: s.bio || undefined,
        photoUrl: s.photoUrl || undefined,
        birthYear: s.birthYear || undefined,
        elderStatus: s.elderStatus,
        culturalRole: s.storyRole || s.culturalRole || undefined,
        storyRole: s.storyRole || 'narrator',
        sortOrder: s.sortOrder || 0,
        isActive: s.isActive,
      })
    );

    // Get interview location if specified
    let interviewLocation = null;
    if (story.interviewLocationId) {
      const placesTable = this.getPlacesTable();
      const [location] = await this.db
        .select()
        .from(placesTable)
        .where(
          and(
            eq(placesTable.id, story.interviewLocationId),
            eq(placesTable.communityId, story.communityId),
            // SPEC-V2 §6.4: a restricted place is unavailable to every role
            // and never appears in a story-derived projection.
            eq(placesTable.isRestricted, false)
          )
        )
        .limit(1);

      if (location) {
        interviewLocation = {
          id: location.id,
          name: location.name,
          description: location.description || undefined,
          latitude: location.latitude,
          longitude: location.longitude,
          region: location.region || undefined,
          culturalSignificance: location.culturalSignificance || undefined,
        };
      }
    }

    // Get interviewer if specified
    let interviewer = null;
    if (story.interviewerId) {
      const speakersTable = this.getSpeakersTable();
      const [speaker] = await this.db
        .select()
        .from(speakersTable)
        .where(
          and(
            eq(speakersTable.id, story.interviewerId),
            eq(speakersTable.communityId, story.communityId)
          )
        )
        .limit(1);

      if (speaker) {
        interviewer = {
          id: speaker.id,
          name: speaker.name,
          bio: speaker.bio || undefined,
          photoUrl: speaker.photoUrl || undefined,
          birthYear: speaker.birthYear || undefined,
          elderStatus: speaker.elderStatus,
          culturalRole: speaker.culturalRole || undefined,
          // SPEC-V2 §6.5: the service drops withdrawn interviewers for
          // callers without the editor/admin gate.
          isActive: speaker.isActive,
        };
      }
    }

    return {
      ...story,
      places,
      speakers,
      community: community || {
        id: story.communityId,
        name: 'Unknown Community',
        description: null,
        slug: 'unknown',
        locale: 'en',
      },
      author: author || {
        id: story.createdBy,
        firstName: 'Unknown',
        lastName: 'User',
        role: 'editor',
      },
      // Interview metadata relationships
      interviewLocation,
      interviewer,
    };
  }

  /**
   * Efficiently load multiple stories with their relations to avoid N+1 queries
   */
  private async loadStoriesWithRelationsBulk(
    storyIds: number[]
  ): Promise<StoryWithRelations[]> {
    if (storyIds.length === 0) return [];

    try {
      // Bulk load stories using proper Drizzle IN clause
      const storiesTable = this.getStoriesTable();
      const stories = await this.db
        .select()
        .from(storiesTable)
        .where(inArray(storiesTable.id, storyIds))
        .execute();

      // IN (...) returns rows in no defined order. Callers pass ids already
      // sorted and paginated, so keep their order (was lost on both backends).
      const position = new Map(storyIds.map((id, index) => [id, index]));
      stories.sort(
        (a: Story, b: Story) =>
          (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0)
      );

      // Bulk load communities for all stories
      const communityIds = [
        ...new Set<number>(stories.map((s: Story) => s.communityId)),
      ];
      const communitiesTable = this.getCommunitiesTable();
      const communities = await this.db
        .select()
        .from(communitiesTable)
        .where(inArray(communitiesTable.id, communityIds))
        .execute();

      // Bulk load authors for all stories
      const authorIds = [
        ...new Set<number>(stories.map((s: Story) => s.createdBy)),
      ];
      const usersTable = this.getUsersTable();
      const authors = await this.db
        .select()
        .from(usersTable)
        .where(inArray(usersTable.id, authorIds))
        .execute();

      // Create lookup maps for efficient joins
      const communityMap = new Map(
        communities.map((c: { id: number }) => [c.id, c])
      );
      const authorMap = new Map(authors.map((a: { id: number }) => [a.id, a]));

      // Bulk load story associations through proper database joins
      const storyPlacesTable = this.getStoryPlacesTable();
      const placesTable = this.getPlacesTable();

      // Get all place associations for these stories
      let allPlaceAssociations: Array<{
        storyId: number;
        placeId: number;
        name: string;
        description: string | null;
        latitude: number;
        longitude: number;
        region: string | null;
        culturalSignificance: string | null;
        isRestricted: boolean;
        culturalContext: string | null;
        sortOrder: number | null;
      }> = [];
      // Database failures propagate: an empty relation list must mean "no
      // associations", never "the query failed" (issue #135 review).
      allPlaceAssociations = await this.db
        .select({
          storyId: storyPlacesTable.storyId,
          placeId: placesTable.id,
          name: placesTable.name,
          description: placesTable.description,
          latitude: placesTable.latitude,
          longitude: placesTable.longitude,
          region: placesTable.region,
          culturalSignificance: placesTable.culturalSignificance,
          // SPEC-V2 §6.4: place restriction flag for the story-derived
          // place projection in StoryService.
          isRestricted: placesTable.isRestricted,
          culturalContext: storyPlacesTable.culturalContext,
          sortOrder: storyPlacesTable.sortOrder,
        })
        .from(storyPlacesTable)
        .innerJoin(placesTable, eq(storyPlacesTable.placeId, placesTable.id))
        .where(
          and(
            inArray(storyPlacesTable.storyId, storyIds),
            // SPEC-V2 §6.4: restricted places never appear in story.places.
            eq(placesTable.isRestricted, false)
          )
        )
        .orderBy(
          storyPlacesTable.storyId,
          ...associationOrder(storyPlacesTable)
        );

      const storySpeakersTable = this.getStorySpeakersTable();
      const speakersTable = this.getSpeakersTable();

      // Get all speaker associations for these stories
      let allSpeakerAssociations: Array<{
        storyId: number;
        speakerId: number;
        name: string;
        bio: string | null;
        photoUrl: string | null;
        birthYear: number | null;
        elderStatus: boolean;
        culturalRole: string | null;
        isActive: boolean;
        storyRole: string | null;
        sortOrder: number | null;
      }> = [];
      allSpeakerAssociations = await this.db
        .select({
          storyId: storySpeakersTable.storyId,
          speakerId: speakersTable.id,
          name: speakersTable.name,
          bio: speakersTable.bio,
          photoUrl: speakersTable.photoUrl,
          birthYear: speakersTable.birthYear,
          elderStatus: speakersTable.elderStatus,
          culturalRole: speakersTable.culturalRole,
          // SPEC-V2 §6.5: speaker withdrawal flag for the story-derived
          // speaker projection in StoryService.
          isActive: speakersTable.isActive,
          storyRole: storySpeakersTable.storyRole,
          sortOrder: storySpeakersTable.sortOrder,
        })
        .from(storySpeakersTable)
        .innerJoin(
          speakersTable,
          eq(storySpeakersTable.speakerId, speakersTable.id)
        )
        .where(inArray(storySpeakersTable.storyId, storyIds))
        .orderBy(
          storySpeakersTable.storyId,
          ...associationOrder(storySpeakersTable)
        );

      // Create lookup maps for associations
      const placesByStory = new Map<
        number,
        Array<{
          storyId: number;
          placeId: number;
          name: string;
          description: string | null;
          latitude: number;
          longitude: number;
          region: string | null;
          culturalSignificance: string | null;
          isRestricted: boolean;
          culturalContext: string | null;
          sortOrder: number | null;
        }>
      >();
      const speakersByStory = new Map<
        number,
        Array<{
          storyId: number;
          speakerId: number;
          name: string;
          bio: string | null;
          photoUrl: string | null;
          birthYear: number | null;
          elderStatus: boolean;
          culturalRole: string | null;
          isActive: boolean;
          storyRole: string | null;
          sortOrder: number | null;
        }>
      >();

      allPlaceAssociations.forEach((place) => {
        if (!placesByStory.has(place.storyId)) {
          placesByStory.set(place.storyId, []);
        }
        placesByStory.get(place.storyId)!.push(place);
      });

      allSpeakerAssociations.forEach((speaker) => {
        if (!speakersByStory.has(speaker.storyId)) {
          speakersByStory.set(speaker.storyId, []);
        }
        speakersByStory.get(speaker.storyId)!.push(speaker);
      });

      // Build stories with relations
      return stories.map((story: Story) => {
        const community = communityMap.get(story.communityId);
        const author = authorMap.get(story.createdBy);

        // Get places for this story
        const storyPlaces = placesByStory.get(story.id) || [];
        const places = storyPlaces.map((p) => ({
          id: p.placeId,
          name: p.name,
          description: p.description || undefined,
          latitude: p.latitude,
          longitude: p.longitude,
          region: p.region || undefined,
          culturalSignificance: p.culturalSignificance || undefined,
          isRestricted: p.isRestricted,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          culturalContext: (p as any).culturalContext || undefined,
          storyRelationship: 'mentioned',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          sortOrder: (p as any).sortOrder || 0,
        }));

        // Get speakers for this story
        const storySpeakers = speakersByStory.get(story.id) || [];
        const speakers = storySpeakers.map((s) => ({
          id: s.speakerId,
          name: s.name,
          bio: s.bio || undefined,
          photoUrl: s.photoUrl || undefined,
          birthYear: s.birthYear || undefined,
          elderStatus: s.elderStatus,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          culturalRole: (s as any).storyRole || s.culturalRole || undefined,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          storyRole: (s as any).storyRole || 'narrator',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          sortOrder: (s as any).sortOrder || 0,
          // SPEC-V2 §6.5: withdrawal flag for the StoryService projection.
          isActive: s.isActive,
        }));

        return {
          ...story,
          community: community || null,
          author: author || null,
          places,
          speakers,
          culturalProtocols: {
            permissionLevel: story.isRestricted ? 'restricted' : 'public',
            culturalSignificance: 'Standard story',
            restrictions: story.isRestricted ? ['Community members only'] : [],
            ceremonialContent: false,
            elderApprovalRequired: false,
            accessNotes: story.isRestricted
              ? 'Restricted access'
              : 'Public access',
          },
        };
      }) as StoryWithRelations[];
    } catch (error) {
      throw error;
    }
  }

  /**
   * Find story by slug within community
   */
  async findBySlug(slug: string, communityId: number): Promise<Story | null> {
    const storiesTable = this.getStoriesTable();
    const [story] = await this.db
      .select()
      .from(storiesTable)
      .where(
        and(
          eq(storiesTable.slug, slug),
          eq(storiesTable.communityId, communityId)
        )
      )
      .limit(1);

    return story || null;
  }

  /**
   * Find story by slug with relations
   */
  async findBySlugWithRelations(
    slug: string,
    communityId: number
  ): Promise<StoryWithRelations | null> {
    const story = await this.findBySlug(slug, communityId);
    if (!story) return null;

    return await this.findByIdWithRelations(story.id);
  }

  /**
   * Update story
   */
  async update(
    id: number,
    data: StoryUpdateData
  ): Promise<StoryWithRelations | null> {
    // First check if the story exists
    const existingStory = await this.findById(id);
    if (!existingStory) {
      return null;
    }

    // Generate a timestamp that's guaranteed to be different
    const updatedAt = new Date(existingStory.updatedAt.getTime() + 1000); // Add 1 second

    // Update the story
    const storiesTable = this.getStoriesTable();
    await this.db
      .update(storiesTable)
      .set({
        ...data,
        updatedAt,
      })
      .where(eq(storiesTable.id, id));

    // Update place associations if provided
    if (data.placeIds !== undefined) {
      const storyPlacesTable = this.getStoryPlacesTable();

      // Delete existing place associations
      await this.db
        .delete(storyPlacesTable)
        .where(eq(storyPlacesTable.storyId, id));

      // Add new place associations
      if (data.placeIds.length > 0) {
        const updateTimestamp = new Date();
        const placeAssociations = distinctIdEntries(data.placeIds).map(
          ({ id: placeId, sourceIndex }, index) => ({
            // Composite tenant FK (#186): join rows carry the story's community.
            communityId: existingStory.communityId,
            storyId: id,
            placeId,
            culturalContext: data.placeContexts?.[sourceIndex] || undefined,
            sortOrder: index,
            createdAt: updateTimestamp,
            updatedAt: updateTimestamp,
          })
        );
        await this.db.insert(storyPlacesTable).values(placeAssociations);
      }
    }

    // Update speaker associations if provided
    if (data.speakerIds !== undefined) {
      const storySpeakersTable = this.getStorySpeakersTable();

      // Delete existing speaker associations
      await this.db
        .delete(storySpeakersTable)
        .where(eq(storySpeakersTable.storyId, id));

      // Add new speaker associations
      if (data.speakerIds.length > 0) {
        const speakerUpdateTimestamp = new Date();
        const speakerAssociations = distinctIdEntries(data.speakerIds).map(
          ({ id: speakerId, sourceIndex }, index) => ({
            // Composite tenant FK (#186): join rows carry the story's community.
            communityId: existingStory.communityId,
            storyId: id,
            speakerId,
            storyRole: data.speakerRoles?.[sourceIndex] || undefined,
            sortOrder: index,
            createdAt: speakerUpdateTimestamp,
            updatedAt: speakerUpdateTimestamp,
          })
        );
        await this.db.insert(storySpeakersTable).values(speakerAssociations);
      }
    }

    // Return updated story with relations
    return await this.findByIdWithRelations(id);
  }

  /**
   * Delete story
   */
  async delete(id: number): Promise<boolean> {
    // Database failures propagate; they are not reported as "not found"/"invalid".
    // First check if the story exists
    const existingStory = await this.findById(id);
    if (!existingStory) {
      return false;
    }

    // Delete story associations first (foreign key constraints will prevent deletion otherwise)
    const storyPlacesTable = this.getStoryPlacesTable();
    const storySpeakersTable = this.getStorySpeakersTable();

    await this.db
      .delete(storyPlacesTable)
      .where(eq(storyPlacesTable.storyId, id));

    await this.db
      .delete(storySpeakersTable)
      .where(eq(storySpeakersTable.storyId, id));

    // Now delete the story itself
    const storiesTable = this.getStoriesTable();
    await this.db.delete(storiesTable).where(eq(storiesTable.id, id));

    return true;
  }

  /**
   * Match-any tag filter with application-normalized comparison. Keeps at
   * most one scan batch and the requested page ids in memory.
   */
  private async findManyByNormalizedTags(
    tags: string[],
    conditions: SQL[],
    pagination: PaginationOptions
  ): Promise<PaginatedResult<StoryWithRelations>> {
    const storiesTable = this.getStoriesTable();
    const requested = new Set(tags.map(normalizeTag));
    const pageStart = (pagination.page - 1) * pagination.limit;
    const pageIds: number[] = [];
    let total = 0;
    const batchSize = 128;
    // Keyset scan on (createdAt, id), the same order as the page: unlike
    // OFFSET, a row inserted or deleted mid-scan cannot shift later batches.
    // The cursor carries created_at exactly as the database stores it (not a
    // JS Date): PostgreSQL timestamps keep microseconds, which a millisecond
    // Date would truncate, skipping rows that share a millisecond.
    const createdAtRaw = sql<string | number>`${storiesTable.createdAt}`;
    const cursorValue = (raw: string | number) =>
      this.dialect === 'postgresql' ? sql`${raw}::timestamp` : sql`${raw}`;
    let cursor: { createdAt: string | number; id: number } | null = null;
    for (;;) {
      const batchConditions: SQL[] = [...conditions];
      if (cursor) {
        const createdAt = cursorValue(cursor.createdAt);
        batchConditions.push(
          sqlOr(
            sql`${storiesTable.createdAt} < ${createdAt}`,
            and(
              sql`${storiesTable.createdAt} = ${createdAt}`,
              lt(storiesTable.id, cursor.id)
            ) as SQL
          )
        );
      }
      const candidates: Array<{
        id: number;
        tags: unknown;
        createdAt: string | number;
      }> = await this.db
        .select({
          id: storiesTable.id,
          tags: storiesTable.tags,
          createdAt: createdAtRaw,
        })
        .from(storiesTable)
        .where(batchConditions.length > 0 ? and(...batchConditions) : undefined)
        .orderBy(desc(storiesTable.createdAt), desc(storiesTable.id))
        .limit(batchSize)
        .execute();
      for (const story of candidates) {
        // Imported rows may hold a non-array or non-string JSON value; such a
        // row matches no tag on either backend.
        const storyTags = Array.isArray(story.tags) ? story.tags : [];
        const matches = storyTags.some(
          (tag) => typeof tag === 'string' && requested.has(normalizeTag(tag))
        );
        if (!matches) continue;
        if (total >= pageStart && pageIds.length < pagination.limit) {
          pageIds.push(story.id);
        }
        total++;
      }
      if (candidates.length < batchSize) break;
      const last = candidates[candidates.length - 1];
      cursor = { createdAt: last.createdAt, id: last.id };
    }

    const data = await this.loadStoriesWithRelationsBulk(pageIds);
    return {
      data,
      total,
      page: pagination.page,
      limit: pagination.limit,
      totalPages: Math.ceil(total / pagination.limit),
    };
  }

  /**
   * Find many stories with filtering and pagination
   */
  async findMany(
    filters: StoryFilters,
    pagination: PaginationOptions
  ): Promise<PaginatedResult<StoryWithRelations>> {
    const storiesTable = this.getStoriesTable();
    const baseQuery = this.db.select().from(storiesTable);
    const baseCountQuery = this.db
      .select({ count: count() })
      .from(storiesTable);

    // Apply filters
    const conditions: SQL[] = [];

    if (filters.communityId) {
      conditions.push(eq(storiesTable.communityId, filters.communityId));
    }

    if (filters.search) {
      conditions.push(
        sqlOr(
          containsInsensitive(this.dialect, storiesTable.title, filters.search),
          containsInsensitive(
            this.dialect,
            storiesTable.description,
            filters.search
          )
        )
      );
    }

    if (filters.isRestricted !== undefined) {
      conditions.push(eq(storiesTable.isRestricted, filters.isRestricted));
    }

    if (filters.privacyLevel) {
      conditions.push(eq(storiesTable.privacyLevel, filters.privacyLevel));
    }

    if (filters.storyAudiences !== undefined) {
      const audienceCondition = storyAudienceCondition(
        filters.storyAudiences,
        storiesTable
      );
      if (!audienceCondition) {
        // The requested accesses match no row at all (e.g. super_admin's
        // empty grant): fail closed instead of dropping the filter.
        return {
          data: [],
          total: 0,
          page: pagination.page,
          limit: pagination.limit,
          totalPages: 0,
        };
      }
      conditions.push(audienceCondition);
    }

    if (filters.createdBy) {
      conditions.push(eq(storiesTable.createdBy, filters.createdBy));
    }

    if (filters.language) {
      conditions.push(eq(storiesTable.language, filters.language));
    }

    if (filters.tags?.length) {
      // SPEC-V2 Section 6.3: tag matching is application-normalized (NFC +
      // lower-case), never database case-folding or JSON containment, so it
      // matches identically on SQLite/D1 and PostgreSQL. Other filters stay in
      // SQL; tags are matched in bounded batches of the id/tags projection,
      // in the same order as the unfiltered page. V2 replaces this with the
      // portable StoryTag(valueNormalized) relation.
      return this.findManyByNormalizedTags(
        filters.tags,
        conditions,
        pagination
      );
    }

    // Build final queries with proper typing
    if (conditions.length > 0) {
      const whereClause = and(...conditions);
      // const storiesWithFilter = await baseQuery.where(whereClause).execute();
      const countWithFilter = await baseCountQuery.where(whereClause).execute();

      // Apply pagination and sorting to filtered results
      const offset = (pagination.page - 1) * pagination.limit;
      const paginatedStories = await baseQuery
        .where(whereClause)
        .orderBy(desc(storiesTable.createdAt), desc(storiesTable.id))
        .limit(pagination.limit)
        .offset(offset)
        .execute();

      const total = Number(countWithFilter[0]?.count || 0);
      const totalPages = Math.ceil(total / pagination.limit);

      // Convert to StoryWithRelations using bulk loading (fixes N+1 queries)
      const storiesWithRelations = await this.loadStoriesWithRelationsBulk(
        paginatedStories.map((story: Story) => story.id)
      );

      return {
        data: storiesWithRelations.filter(Boolean) as StoryWithRelations[],
        total,
        page: pagination.page,
        limit: pagination.limit,
        totalPages,
      };
    } else {
      // No filters - handle separately
      const offset = (pagination.page - 1) * pagination.limit;
      const paginatedStories = await baseQuery
        .orderBy(desc(storiesTable.createdAt), desc(storiesTable.id))
        .limit(pagination.limit)
        .offset(offset)
        .execute();

      const totalResult = await baseCountQuery.execute();
      const total = Number(totalResult[0]?.count || 0);
      const totalPages = Math.ceil(total / pagination.limit);

      // Convert to StoryWithRelations using bulk loading (fixes N+1 queries)
      const storiesWithRelations = await this.loadStoriesWithRelationsBulk(
        paginatedStories.map((story: Story) => story.id)
      );

      return {
        data: storiesWithRelations.filter(Boolean) as StoryWithRelations[],
        total,
        page: pagination.page,
        limit: pagination.limit,
        totalPages,
      };
    }
  }

  /**
   * Generate unique slug from title
   */
  async generateUniqueSlug(
    title: string,
    communityId: number,
    _tx?: unknown
  ): Promise<string> {
    const baseSlug = this.createSlugFromTitle(title);
    let slug = baseSlug;
    let counter = 0;

    // Check for uniqueness within the community
    while (true) {
      const existing = await this.findBySlug(slug, communityId);
      if (!existing) {
        return slug;
      }
      counter++;
      slug = `${baseSlug}-${counter}`;
    }
  }

  /**
   * Validate that places belong to the specified community
   */
  async validatePlacesInCommunity(
    placeIds: number[],
    communityId: number
  ): Promise<boolean> {
    if (!placeIds.length) return true;

    // Database failures propagate; they are not reported as "not found"/"invalid".
    const placesTable = this.getPlacesTable();
    const places = await this.db
      .select()
      .from(placesTable)
      .where(
        and(
          inArray(placesTable.id, placeIds),
          eq(placesTable.communityId, communityId)
        )
      );

    // All places must exist and belong to the community
    return places.length === new Set(placeIds).size;
  }

  /**
   * Validate that speakers belong to the specified community
   */
  async validateSpeakersInCommunity(
    speakerIds: number[],
    communityId: number
  ): Promise<boolean> {
    if (!speakerIds.length) return true;

    // Every speaker must exist in this community (SPEC-V2 Section 6.3: both
    // relationship endpoints belong to one community). Database failures
    // propagate; they are not treated as "invalid".
    const speakersTable = this.getSpeakersTable();
    const speakers = await this.db
      .select({ id: speakersTable.id })
      .from(speakersTable)
      .where(
        and(
          inArray(speakersTable.id, speakerIds),
          eq(speakersTable.communityId, communityId)
        )
      );
    return speakers.length === new Set(speakerIds).size;
  }

  /**
   * Validate that interview location belongs to the specified community
   */
  async validateInterviewLocationInCommunity(
    interviewLocationId: number,
    communityId: number
  ): Promise<boolean> {
    // Database failures propagate; they are not reported as "not found"/"invalid".
    const placesTable = this.getPlacesTable();
    const [place] = await this.db
      .select()
      .from(placesTable)
      .where(
        and(
          eq(placesTable.id, interviewLocationId),
          eq(placesTable.communityId, communityId)
        )
      )
      .limit(1);

    return !!place;
  }

  /**
   * Validate that interviewer belongs to the specified community
   */
  async validateInterviewerInCommunity(
    interviewerId: number,
    communityId: number
  ): Promise<boolean> {
    // Database failures propagate; they are not reported as "not found"/"invalid".
    const speakersTable = this.getSpeakersTable();
    const [speaker] = await this.db
      .select()
      .from(speakersTable)
      .where(
        and(
          eq(speakersTable.id, interviewerId),
          eq(speakersTable.communityId, communityId)
        )
      )
      .limit(1);

    return !!speaker;
  }

  /**
   * Create URL-friendly slug from title
   */
  private createSlugFromTitle(title: string): string {
    return title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '') // Remove special characters
      .replace(/\s+/g, '-') // Replace spaces with hyphens
      .replace(/-+/g, '-') // Replace multiple hyphens with single
      .replace(/^-|-$/g, '') // Remove leading/trailing hyphens
      .substring(0, 50); // Truncate to reasonable length
  }
}

/**
 * SQL transcription of `fastifyStoryToAudience` (sovereignty policy):
 * - public      = unrestricted + privacyLevel 'public'
 * - community   = unrestricted + privacyLevel 'members_only'
 * - editors     = matches no Fastify row at runtime, so it contributes no
 *                 condition here (SPEC-V2 §6.3: migration may select the
 *                 editors audience explicitly, never implicitly)
 * - unavailable = restricted rows and any other privacyLevel; readable by
 *                 no role, so it contributes no condition either
 *
 * A row that maps to no requested access never matches. If no requested
 * access matches any row, this returns undefined and every caller must
 * treat that as "no rows" (fail closed), never as "no filter".
 *
 * Single source for `findMany` and route-level community story listings so
 * the mapping exists exactly once outside the policy module. Works for both
 * dialect tables because it only references shared column shape.
 */
export function storyAudienceCondition(
  accesses: readonly TransitionalStoryReadAccess[],
  storiesTable: {
    isRestricted: AnyColumn;
    privacyLevel: AnyColumn;
  }
): SQL | undefined {
  const conditions = accesses
    .map((access) => {
      if (access === 'public') {
        return and(
          eq(storiesTable.isRestricted, false),
          eq(storiesTable.privacyLevel, 'public')
        );
      }
      if (access === 'community') {
        return and(
          eq(storiesTable.isRestricted, false),
          eq(storiesTable.privacyLevel, 'members_only')
        );
      }
      // 'editors' matches no Fastify row (unknown privacy levels are
      // unavailable) and 'unavailable' is readable by no role: neither
      // contributes a condition.
      return undefined;
    })
    .filter((condition): condition is SQL => condition !== undefined);
  if (conditions.length === 0) {
    return undefined;
  }
  return conditions.length === 1 ? conditions[0] : or(...conditions);
}
