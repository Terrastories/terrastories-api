/**
 * Read-only data access for the transitional Explore read adapter (#198).
 *
 * Every query here serves the anonymous public projection only, applying the
 * same sovereignty gates as the canonical API (docs/SPEC-V2.md §4, §6.1,
 * §6.3, §6.4a) on the transitional Fastify-era physical schema:
 *
 * - Community gate: `publicStories = true` AND `isActive = true` (the SQL
 *   transcription of `fastifyCommunityToGates`; a private or disabled
 *   community is invisible to every Explore request).
 * - Story gate: `privacyLevel = 'public'` AND `isRestricted = false` (the SQL
 *   transcription of `fastifyStoryToAudience` -> `public`). Restricted rows
 *   and unknown privacy levels are `unavailable` to every role and never
 *   reach a response; direct reads answer the same 404 as missing ids.
 * - Place/speaker visibility follows the §6.4a decision table: a place or
 *   speaker appears only through its association (story_places/story_speakers
 *   edge, interview location/interviewer) with a publicly readable story.
 *   Restricted places are never exposed (SPEC Appendix A.3), and speakers
 *   withdrawn via `isActive = false` stay absent from public projections.
 *   These conditions are applied in EVERY joined relation — including filter
 *   probes — so a filter value can never confirm the existence of a
 *   restricted place, an inactive speaker, or another community's row, and
 *   `meta.total` counts only stories reachable through visible associations.
 * - Places are additionally scoped to the owning community on every join;
 *   a cross-tenant story_places edge cannot project another community's
 *   place.
 * - No query builds an unbounded `IN (...)` list: D1/SQLite bound-parameter
 *   limits (~100) rule that out. Story-set queries are expressed as joins;
 *   user-supplied filter lists are bounded by the query parser.
 *
 * No writes, no interactive transactions, Workers-portable queries only.
 */
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  ne,
  sql,
} from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import type { Database } from '../db/index.js';
import { containsInsensitive, dialectOf, tablesFor } from '../db/dialect.js';
import {
  communityMediaPg,
  communityMediaSqlite,
} from '../db/schema/sessions.js';

export interface ExploreCommunityRow {
  id: number;
  name: string;
  description: string | null;
  slug: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ExploreThemeRow {
  mapboxStyleUrl: string | null;
  centerLat: number | null;
  centerLong: number | null;
  swBoundaryLat: number | null;
  swBoundaryLong: number | null;
  neBoundaryLat: number | null;
  neBoundaryLong: number | null;
}

export interface ExplorePlaceRow {
  id: number;
  name: string;
  description: string | null;
  region: string | null;
  latitude: number;
  longitude: number;
}

export interface ExploreSpeakerRow {
  id: number;
  name: string;
}

export interface ExploreStoryListRow {
  id: number;
  title: string;
  description: string | null;
  language: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ExploreStoryDetailRow {
  id: number;
  title: string;
  description: string | null;
  language: string;
  interviewerId: number | null;
  interviewLocationId: number | null;
}

/** Applied filters for the Rails-shaped stories page. */
export interface ExploreStoryQuery {
  placeIds?: number[];
  regions?: string[];
  languages?: string[];
  speakerIds?: number[];
  sortBy: 'created_at' | 'title';
  sortDir: 'asc' | 'desc';
  limit: number;
  offset: number;
}

/**
 * Cap on any unpaged points projection (docs/EXPLORE-ADAPTER.md): map
 * points are the whole relation by design, so the projection itself is
 * bounded to keep responses and query work finite on every profile.
 */
export const MAX_POINTS = 2000;

export class ExploreAdapterRepository {
  private readonly tables;
  private readonly communityMedia;
  // Both dialects expose the same surface with incompatible TS overloads.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly database: any;
  private readonly dialect: ReturnType<typeof dialectOf>;

  constructor(database: Database | DrizzleD1Database) {
    this.database = database;
    this.dialect = dialectOf(database);
    this.tables = tablesFor(database);
    this.communityMedia = (
      this.dialect === 'postgresql' ? communityMediaPg : communityMediaSqlite
    ) as typeof communityMediaSqlite;
  }

  /** Public active communities, newest update first (Rails index order). */
  async publicCommunities(search?: string): Promise<ExploreCommunityRow[]> {
    const { communities } = this.tables;
    const gate = and(
      eq(communities.publicStories, true),
      eq(communities.isActive, true)
    );
    return this.database
      .select({
        id: communities.id,
        name: communities.name,
        description: communities.description,
        slug: communities.slug,
        createdAt: communities.createdAt,
        updatedAt: communities.updatedAt,
      })
      .from(communities)
      .where(
        search && search !== ''
          ? and(
              gate,
              containsInsensitive(this.dialect, communities.name, search)
            )
          : gate
      )
      .orderBy(desc(communities.updatedAt), desc(communities.id));
  }

  /** The community named by a public Explore slug, or null (withheld = null). */
  async publicCommunityBySlug(
    slug: string
  ): Promise<ExploreCommunityRow | null> {
    const { communities } = this.tables;
    const rows: ExploreCommunityRow[] = await this.database
      .select({
        id: communities.id,
        name: communities.name,
        description: communities.description,
        slug: communities.slug,
        createdAt: communities.createdAt,
        updatedAt: communities.updatedAt,
      })
      .from(communities)
      .where(
        and(
          eq(communities.slug, slug),
          eq(communities.publicStories, true),
          eq(communities.isActive, true)
        )
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * The community's active theme. Multiple active rows (a V1 state the
   * canonical model collapses) resolve deterministically to the lowest id;
   * zero rows yield null (an all-null mapConfig).
   */
  async activeTheme(communityId: number): Promise<ExploreThemeRow | null> {
    const { themes } = this.tables;
    const rows: ExploreThemeRow[] = await this.database
      .select({
        mapboxStyleUrl: themes.mapboxStyleUrl,
        centerLat: themes.centerLat,
        centerLong: themes.centerLong,
        swBoundaryLat: themes.swBoundaryLat,
        swBoundaryLong: themes.swBoundaryLong,
        neBoundaryLat: themes.neBoundaryLat,
        neBoundaryLong: themes.neBoundaryLong,
      })
      .from(themes)
      .where(and(eq(themes.communityId, communityId), eq(themes.active, true)))
      .orderBy(asc(themes.id))
      .limit(1);
    return rows[0] ?? null;
  }

  /** Publicly readable stories of the community (Rails `anonymous` audience). */
  private publicStoryGate(communityId: number) {
    const { stories } = this.tables;
    return and(
      eq(stories.communityId, communityId),
      eq(stories.privacyLevel, 'public'),
      eq(stories.isRestricted, false)
    );
  }

  /**
   * Joined place/speaker rows must themselves be visible to an anonymous
   * caller (§6.4a) and belong to the same community: unrestricted same-
   * community places and active same-community speakers. Applied to every
   * joined relation so filter probes cannot confirm hidden rows.
   */
  private visibleJoinConditions(communityId: number) {
    const { places, speakers } = this.tables;
    return and(
      eq(places.communityId, communityId),
      eq(places.isRestricted, false),
      eq(speakers.communityId, communityId),
      eq(speakers.isActive, true)
    );
  }

  /**
   * Where-clause of the Rails-shaped story relation: publicly readable
   * stories with at least one visible place edge and one visible speaker
   * edge, plus the caller's bounded filters.
   */
  private storyRelationConditions(
    communityId: number,
    query?: ExploreStoryQuery
  ) {
    const { places, speakers, stories } = this.tables;
    const conditions = [
      this.publicStoryGate(communityId),
      this.visibleJoinConditions(communityId),
    ];
    if (query?.placeIds?.length)
      conditions.push(inArray(places.id, query.placeIds));
    if (query?.regions?.length)
      conditions.push(inArray(places.region, query.regions));
    if (query?.speakerIds?.length)
      conditions.push(inArray(speakers.id, query.speakerIds));
    if (query?.languages?.length)
      conditions.push(inArray(stories.language, query.languages));
    return and(...conditions);
  }

  /** Count of publicly readable stories, without join requirements. */
  async publicStoriesCount(communityId: number): Promise<number> {
    const { stories } = this.tables;
    const rows = await this.database
      .select({ count: sql<number>`count(*)` })
      .from(stories)
      .where(this.publicStoryGate(communityId));
    return Number(rows[0]?.count ?? 0);
  }

  /**
   * One page of the Rails-shaped story relation (Rails `joins(:places,
   * :speakers)` with §6.4a-hardened joins), sorted with a stable id
   * tie-breaker. `total` counts the same relation, so filter probes report
   * only visibly reachable stories.
   *
   * PostgreSQL requires every DISTINCT ORDER BY expression to appear in the
   * select list, so the sort key (byte-order title via COLLATE "C" on
   * PostgreSQL, matching `textOrder` in db/dialect.ts) is selected under the
   * `sort_key` alias and stripped before returning; the tie-break column
   * `stories.id` is already in the select list. Results are identical on
   * SQLite/D1 and PostgreSQL.
   */
  async publicStoryPage(
    communityId: number,
    query: ExploreStoryQuery
  ): Promise<{ rows: ExploreStoryListRow[]; total: number }> {
    const { stories, places, speakers, storyPlaces, storySpeakers } =
      this.tables;
    const where = this.storyRelationConditions(communityId, query);
    const sortExpression =
      query.sortBy === 'title'
        ? this.dialect === 'postgresql'
          ? sql`(${stories.title} COLLATE "C")`
          : sql`(${stories.title})`
        : sql`(${stories.createdAt})`;
    const rows = await this.database
      .selectDistinct({
        id: stories.id,
        title: stories.title,
        description: stories.description,
        language: stories.language,
        createdAt: stories.createdAt,
        updatedAt: stories.updatedAt,
        sortKey: sql<string>`${sortExpression}`.as('sort_key'),
      })
      .from(stories)
      .innerJoin(storyPlaces, eq(storyPlaces.storyId, stories.id))
      .innerJoin(places, eq(places.id, storyPlaces.placeId))
      .innerJoin(storySpeakers, eq(storySpeakers.storyId, stories.id))
      .innerJoin(speakers, eq(speakers.id, storySpeakers.speakerId))
      .where(where)
      .orderBy(
        query.sortDir === 'desc' ? sql`sort_key desc` : sql`sort_key asc`,
        query.sortDir === 'desc' ? desc(stories.id) : asc(stories.id)
      )
      .limit(query.limit)
      .offset(query.offset);
    const page: ExploreStoryListRow[] = rows.map(
      (row: ExploreStoryListRow & { sortKey: unknown }) => ({
        id: row.id,
        title: row.title,
        description: row.description,
        language: row.language,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })
    );
    const totals = await this.database
      .select({ count: sql<number>`count(distinct ${stories.id})` })
      .from(stories)
      .innerJoin(storyPlaces, eq(storyPlaces.storyId, stories.id))
      .innerJoin(places, eq(places.id, storyPlaces.placeId))
      .innerJoin(storySpeakers, eq(storySpeakers.storyId, stories.id))
      .innerJoin(speakers, eq(speakers.id, storySpeakers.speakerId))
      .where(where);
    return { rows: page, total: Number(totals[0]?.count ?? 0) };
  }

  /**
   * Publishable places of the community's public stories, expressed as a
   * join (never an id list, which would hit D1 bound-parameter limits).
   * Places are community-scoped and unrestricted with a valid coordinate
   * pair; the community gate is the caller's `publicCommunityBySlug` result.
   */
  private visiblePlaceColumns() {
    const { places } = this.tables;
    return {
      id: places.id,
      name: places.name,
      description: places.description,
      region: places.region,
      latitude: places.latitude,
      longitude: places.longitude,
    };
  }

  private visiblePlaceConditions(communityId: number) {
    const { places } = this.tables;
    return and(
      eq(places.communityId, communityId),
      eq(places.isRestricted, false),
      gte(places.latitude, -90),
      lte(places.latitude, 90),
      gte(places.longitude, -180),
      lte(places.longitude, 180)
    );
  }

  /**
   * Places of every publicly readable story of the community (edges only),
   * capped at MAX_POINTS entries (deterministic lowest place ids) so the
   * unpaged points projection stays bounded on every profile.
   */
  async publicPlacesOfCommunityStories(
    communityId: number
  ): Promise<ExplorePlaceRow[]> {
    const { places, stories, storyPlaces } = this.tables;
    return this.database
      .selectDistinct(this.visiblePlaceColumns())
      .from(storyPlaces)
      .innerJoin(stories, eq(stories.id, storyPlaces.storyId))
      .innerJoin(places, eq(places.id, storyPlaces.placeId))
      .where(
        and(
          this.visiblePlaceConditions(communityId),
          this.publicStoryGate(communityId)
        )
      )
      .orderBy(asc(places.id))
      .limit(MAX_POINTS);
  }

  /**
   * Places of the filtered story relation — the whole relation, unpaged but
   * capped at MAX_POINTS entries (deterministic lowest place ids).
   */
  async publicPlacesOfFilteredStories(
    communityId: number,
    query: ExploreStoryQuery
  ): Promise<ExplorePlaceRow[]> {
    const { places, speakers, stories, storyPlaces, storySpeakers } =
      this.tables;
    return this.database
      .selectDistinct(this.visiblePlaceColumns())
      .from(stories)
      .innerJoin(storyPlaces, eq(storyPlaces.storyId, stories.id))
      .innerJoin(places, eq(places.id, storyPlaces.placeId))
      .innerJoin(storySpeakers, eq(storySpeakers.storyId, stories.id))
      .innerJoin(speakers, eq(speakers.id, storySpeakers.speakerId))
      .where(
        and(
          this.visiblePlaceConditions(communityId),
          this.storyRelationConditions(communityId, query)
        )
      )
      .orderBy(asc(places.id))
      .limit(MAX_POINTS);
  }

  /** A publicly readable story of the community, or null (withheld = null). */
  async publicStoryById(
    communityId: number,
    storyId: number
  ): Promise<ExploreStoryDetailRow | null> {
    const { stories } = this.tables;
    const rows: ExploreStoryDetailRow[] = await this.database
      .select({
        id: stories.id,
        title: stories.title,
        description: stories.description,
        language: stories.language,
        interviewerId: stories.interviewerId,
        interviewLocationId: stories.interviewLocationId,
      })
      .from(stories)
      .where(and(eq(stories.id, storyId), this.publicStoryGate(communityId)))
      .limit(1);
    return rows[0] ?? null;
  }

  /** Publishable same-community places of one story, ordered by place id. */
  async storyPlaces(
    communityId: number,
    storyId: number
  ): Promise<ExplorePlaceRow[]> {
    const { places, storyPlaces } = this.tables;
    return this.database
      .selectDistinct(this.visiblePlaceColumns())
      .from(storyPlaces)
      .innerJoin(places, eq(places.id, storyPlaces.placeId))
      .where(
        and(
          eq(storyPlaces.storyId, storyId),
          this.visiblePlaceConditions(communityId)
        )
      )
      .orderBy(asc(places.id));
  }

  /** Active same-community speakers of one story, ordered by speaker id. */
  async storySpeakers(
    communityId: number,
    storyId: number
  ): Promise<ExploreSpeakerRow[]> {
    const { speakers, storySpeakers } = this.tables;
    return this.database
      .selectDistinct({ id: speakers.id, name: speakers.name })
      .from(storySpeakers)
      .innerJoin(speakers, eq(speakers.id, storySpeakers.speakerId))
      .where(
        and(
          eq(storySpeakers.storyId, storyId),
          eq(speakers.communityId, communityId),
          eq(speakers.isActive, true)
        )
      )
      .orderBy(asc(speakers.id));
  }

  /** An active same-community interviewer, or null (withdrawn = absent). */
  async interviewer(
    communityId: number,
    speakerId: number
  ): Promise<ExploreSpeakerRow | null> {
    const { speakers } = this.tables;
    const rows: ExploreSpeakerRow[] = await this.database
      .select({ id: speakers.id, name: speakers.name })
      .from(speakers)
      .where(
        and(
          eq(speakers.id, speakerId),
          eq(speakers.communityId, communityId),
          eq(speakers.isActive, true)
        )
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** An unrestricted same-community interview location, or null. */
  async interviewLocation(
    communityId: number,
    placeId: number
  ): Promise<ExplorePlaceRow | null> {
    const { places } = this.tables;
    const rows: ExplorePlaceRow[] = await this.database
      .select(this.visiblePlaceColumns())
      .from(places)
      .where(
        and(eq(places.id, placeId), this.visiblePlaceConditions(communityId))
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * A place readable by an anonymous caller per SPEC §6.4a: unrestricted,
   * valid coordinates, in a public community, and associated with at least
   * one publicly readable story through a story_places edge or as that
   * story's interview location. Null otherwise (withheld = missing).
   */
  async publicPlaceById(
    communityId: number,
    placeId: number
  ): Promise<ExplorePlaceRow | null> {
    const { places, stories, storyPlaces } = this.tables;
    const rows: ExplorePlaceRow[] = await this.database
      .selectDistinct(this.visiblePlaceColumns())
      .from(places)
      .innerJoin(storyPlaces, eq(storyPlaces.placeId, places.id))
      .innerJoin(stories, eq(stories.id, storyPlaces.storyId))
      .where(
        and(
          eq(places.id, placeId),
          this.visiblePlaceConditions(communityId),
          this.publicStoryGate(communityId)
        )
      )
      .limit(1);
    const row = rows[0];
    if (row) return row;
    // Interview-location-only association (no story_places edge).
    const interview = await this.database
      .select({ value: sql<number>`1` })
      .from(stories)
      .where(
        and(
          eq(stories.interviewLocationId, placeId),
          this.publicStoryGate(communityId)
        )
      )
      .limit(1);
    if (!interview.length) return null;
    return this.interviewLocation(communityId, placeId);
  }

  /**
   * Place options for the filter panel. Same visibility as the story
   * relation itself: places reachable from visibly qualifying stories
   * (public, unrestricted, visible place and active same-community speaker
   * edges) and publishable as points (valid coordinate pair).
   */
  async filterPlaces(
    communityId: number
  ): Promise<Array<{ id: number; name: string }>> {
    const { places, speakers, stories, storyPlaces, storySpeakers } =
      this.tables;
    return this.database
      .selectDistinct({ id: places.id, name: places.name })
      .from(places)
      .innerJoin(storyPlaces, eq(storyPlaces.placeId, places.id))
      .innerJoin(stories, eq(stories.id, storyPlaces.storyId))
      .innerJoin(storySpeakers, eq(storySpeakers.storyId, stories.id))
      .innerJoin(speakers, eq(speakers.id, storySpeakers.speakerId))
      .where(
        and(
          this.visiblePlaceConditions(communityId),
          this.storyRelationConditions(communityId)
        )
      )
      .orderBy(asc(places.id));
  }

  /**
   * Non-blank distinct regions of places reachable from visibly qualifying
   * stories (same visibility as the story relation).
   */
  async filterRegions(communityId: number): Promise<string[]> {
    const { places, speakers, stories, storyPlaces, storySpeakers } =
      this.tables;
    const rows: { region: string | null }[] = await this.database
      .selectDistinct({ region: places.region })
      .from(places)
      .innerJoin(storyPlaces, eq(storyPlaces.placeId, places.id))
      .innerJoin(stories, eq(stories.id, storyPlaces.storyId))
      .innerJoin(storySpeakers, eq(storySpeakers.storyId, stories.id))
      .innerJoin(speakers, eq(speakers.id, storySpeakers.speakerId))
      .where(
        and(
          this.visiblePlaceConditions(communityId),
          this.storyRelationConditions(communityId),
          ne(places.region, '')
        )
      )
      .orderBy(asc(places.region));
    return rows
      .map((row) => row.region)
      .filter((region): region is string => region !== null);
  }

  /**
   * Active speakers edge-associated with visibly qualifying stories (same
   * visibility as the story relation).
   */
  async filterSpeakers(communityId: number): Promise<ExploreSpeakerRow[]> {
    const { places, speakers, stories, storyPlaces, storySpeakers } =
      this.tables;
    return this.database
      .selectDistinct({ id: speakers.id, name: speakers.name })
      .from(speakers)
      .innerJoin(storySpeakers, eq(storySpeakers.speakerId, speakers.id))
      .innerJoin(stories, eq(stories.id, storySpeakers.storyId))
      .innerJoin(storyPlaces, eq(storyPlaces.storyId, stories.id))
      .innerJoin(places, eq(places.id, storyPlaces.placeId))
      .where(this.storyRelationConditions(communityId))
      .orderBy(asc(speakers.id));
  }

  /**
   * Distinct non-blank languages of visibly qualifying stories — the same
   * relation the list serves, so a language option always implies at least
   * one listable story.
   */
  async filterLanguages(communityId: number): Promise<string[]> {
    const { places, speakers, stories, storyPlaces, storySpeakers } =
      this.tables;
    const rows: { language: string }[] = await this.database
      .selectDistinct({ language: stories.language })
      .from(stories)
      .innerJoin(storyPlaces, eq(storyPlaces.storyId, stories.id))
      .innerJoin(places, eq(places.id, storyPlaces.placeId))
      .innerJoin(storySpeakers, eq(storySpeakers.storyId, stories.id))
      .innerJoin(speakers, eq(speakers.id, storySpeakers.speakerId))
      .where(
        and(ne(stories.language, ''), this.storyRelationConditions(communityId))
      )
      .orderBy(asc(stories.language));
    return rows.map((row) => row.language);
  }

  /**
   * The community's canonical branding file (community_media kind
   * 'branding'): active, unrestricted, community-scoped, in a public AND
   * active community. Deterministic lowest file id.
   */
  async brandingFileForCommunity(
    communityId: number
  ): Promise<{ fileId: string } | null> {
    const { communities, files } = this.tables;
    const media = this.communityMedia;
    const rows: { fileId: string }[] = await this.database
      .select({ fileId: files.id })
      .from(media)
      .innerJoin(files, eq(files.id, media.fileId))
      .innerJoin(communities, eq(communities.id, media.communityId))
      .where(
        and(
          eq(media.communityId, communityId),
          eq(media.kind, 'branding'),
          eq(files.communityId, communityId),
          eq(files.isActive, true),
          isNull(files.culturalRestrictions),
          eq(communities.isActive, true),
          eq(communities.publicStories, true)
        )
      )
      .orderBy(asc(files.id))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * A branding file readable anonymously: same tenant checks as
   * brandingFileForCommunity plus the community publication gate and a
   * well-formed community-scoped storage key, resolved by file id for
   * GET /explore/media/:fileId.
   */
  async publicBrandingFile(fileId: string): Promise<{
    communityId: number;
    storageKey: string;
    mimeType: string;
  } | null> {
    const { communities, files } = this.tables;
    const media = this.communityMedia;
    const rows: {
      communityId: number;
      storageKey: string;
      mimeType: string;
    }[] = await this.database
      .select({
        communityId: media.communityId,
        storageKey: files.path,
        mimeType: files.mimeType,
      })
      .from(media)
      .innerJoin(files, eq(files.id, media.fileId))
      .innerJoin(communities, eq(communities.id, media.communityId))
      .where(
        and(
          eq(files.id, fileId),
          eq(media.kind, 'branding'),
          eq(files.communityId, media.communityId),
          eq(files.isActive, true),
          isNull(files.culturalRestrictions),
          eq(communities.isActive, true),
          eq(communities.publicStories, true)
        )
      )
      .limit(1);
    return rows[0] ?? null;
  }
}
