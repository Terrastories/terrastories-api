/**
 * Place Repository
 *
 * Database operations for place management with portable application-level
 * spatial behavior across PostgreSQL and SQLite/D1-compatible deployments.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
// NOTE: Many 'any' types in this file are unavoidable due to Drizzle ORM's
// complex typing with multi-database compatibility.

import { eq, and, asc, desc, sql, count, type SQL } from 'drizzle-orm';
import {
  type Place,
  type NewPlace,
  validateCoordinates,
} from '../db/schema/places.js';
import {
  dialectOf,
  tablesFor,
  textOrder,
  type Dialect,
  type DialectTables,
} from '../db/dialect.js';
import type { Database } from '../db/index.js';
import { SpatialUtils } from '../shared/utils/spatial.js';
import {
  DatabaseError,
  InvalidCoordinatesError,
  InvalidBoundsError,
  CommunityNotFoundError,
} from '../shared/errors/index.js';

// Re-export Place type for other modules
export type { Place } from '../db/schema/places.js';

// Database type union for compatibility - use the same type as db/index.ts
type DatabaseType = Database;

/**
 * Request parameters for place creation
 */
export interface CreatePlaceData {
  name: string;
  description?: string;
  latitude: number;
  longitude: number;
  region?: string;
  mediaUrls?: string[];
  culturalSignificance?: string;
  isRestricted?: boolean;
}

/**
 * Request parameters for place updates
 */
export interface UpdatePlaceData {
  name?: string;
  description?: string;
  latitude?: number;
  longitude?: number;
  region?: string;
  mediaUrls?: string[];
  culturalSignificance?: string;
  isRestricted?: boolean;
  updatedAt?: Date;
}

/**
 * Parameters for geographic proximity search
 */
export interface NearbySearchParams {
  communityId: number;
  latitude: number;
  longitude: number;
  radiusKm: number;
  page: number;
  limit: number;
  includeRestricted?: boolean;
}

/**
 * Parameters for bounding box search
 */
export interface BoundsSearchParams {
  communityId: number;
  north: number;
  south: number;
  east: number;
  west: number;
  page: number;
  limit: number;
  includeRestricted?: boolean;
}

/**
 * Parameters for community place listing
 */
export interface CommunityPlaceParams {
  page: number;
  limit: number;
  includeRestricted?: boolean;
  sortBy?: 'name' | 'created_at' | 'updated_at';
  sortOrder?: 'asc' | 'desc';
}

/**
 * Paginated response structure
 */
export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  pages: number;
}

export class PlaceRepository {
  private db: DatabaseType;
  private readonly dialect: Dialect;
  private readonly tables: DialectTables;

  constructor(database: DatabaseType) {
    this.db = database;
    // Tables come from this Drizzle instance, so story/place joins use the
    // matching dialect (previously PostgreSQL join tables on every backend).
    this.dialect = dialectOf(database);
    this.tables = tablesFor(database);
  }

  /** Requested sort column, then id, so pages are deterministic. */
  private sortOrder(sortBy: string, sortOrder: 'asc' | 'desc'): SQL[] {
    const places = this.tables.places;
    if (sortBy === 'name') {
      return [
        textOrder(this.dialect, places.name, sortOrder),
        sortOrder === 'desc' ? desc(places.id) : asc(places.id),
      ];
    }
    const column =
      sortBy === 'created_at' ? places.createdAt : places.updatedAt;
    return sortOrder === 'desc'
      ? [desc(column), desc(places.id)]
      : [asc(column), asc(places.id)];
  }

  /**
   * Create a new place with coordinate validation
   */
  async create(
    data: CreatePlaceData & { communityId: number }
  ): Promise<Place> {
    // Validate coordinates
    if (!validateCoordinates(data.latitude, data.longitude)) {
      throw new InvalidCoordinatesError(data.latitude, data.longitude);
    }

    const placesTable = this.tables.places;
    const now = new Date();
    const placeData: NewPlace = {
      name: data.name,
      description: data.description || null,
      communityId: data.communityId,
      latitude: data.latitude,
      longitude: data.longitude,
      region: data.region || null,
      mediaUrls: data.mediaUrls || [],
      culturalSignificance: data.culturalSignificance || null,
      isRestricted: data.isRestricted || false,
      createdAt: now,
      updatedAt: now,
    };

    try {
      // Check if community exists first (SQLite doesn't enforce foreign keys in tests)
      const communityTable = this.tables.communities;
      const [existingCommunity] = await (this.db as any)
        .select({ id: communityTable.id })
        .from(communityTable)
        .where(eq(communityTable.id, data.communityId))
        .limit(1);

      if (!existingCommunity) {
        throw new CommunityNotFoundError(data.communityId);
      }

      const [place] = await (this.db as any)
        .insert(placesTable)
        .values(placeData)
        .returning();

      return place;
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.includes('foreign key') ||
          error.message.includes('Invalid community ID'))
      ) {
        throw new CommunityNotFoundError();
      }
      throw error;
    }
  }

  /**
   * Get place by ID without community check (internal use)
   */
  async getById(id: number): Promise<Place | null> {
    const placesTable = this.tables.places;
    const [place] = await (this.db as any)
      .select()
      .from(placesTable)
      .where(eq(placesTable.id, id))
      .limit(1);

    return place || null;
  }

  /**
   * Get place by ID with community isolation
   */
  async getByIdWithCommunityCheck(
    id: number,
    communityId: number
  ): Promise<Place | null> {
    try {
      const placesTable = this.tables.places;
      const [place] = await (this.db as any)
        .select()
        .from(placesTable)
        .where(
          and(eq(placesTable.id, id), eq(placesTable.communityId, communityId))
        )
        .limit(1);

      return place || null;
    } catch (error) {
      // Handle database errors gracefully
      if (error instanceof Error) {
        // Handle SQLite function errors (like "no such function: now")
        if (error.message.includes('no such function')) {
          throw new DatabaseError(
            'Database compatibility error during place lookup',
            {
              originalError: error.message,
              operation: 'get_place_by_id',
              placeId: id,
              communityId,
            }
          );
        }

        // Handle other database errors
        throw new DatabaseError(
          'Failed to retrieve place due to database error',
          {
            originalError: error.message,
            operation: 'get_place_by_id',
            placeId: id,
            communityId,
          }
        );
      }

      throw new DatabaseError('Unknown error occurred while retrieving place', {
        originalError: String(error),
        operation: 'get_place_by_id',
        placeId: id,
        communityId,
      });
    }
  }

  /**
   * Get paginated places for a community
   */
  async getByCommunity(
    communityId: number,
    params: CommunityPlaceParams
  ): Promise<PaginatedResponse<Place>> {
    const placesTable = this.tables.places;
    const {
      page,
      limit,
      includeRestricted = false,
      sortBy = 'name',
      sortOrder = 'asc',
    } = params;
    const offset = (page - 1) * limit;

    // Build where condition
    const whereConditions = [eq(placesTable.communityId, communityId)];
    if (!includeRestricted) {
      whereConditions.push(eq(placesTable.isRestricted, false));
    }
    const whereCondition = and(...whereConditions);

    const orderBy = this.sortOrder(sortBy, sortOrder);

    // Get total count
    const [{ count: total }] = await (this.db as any)
      .select({ count: count() })
      .from(placesTable)
      .where(whereCondition);

    // Get paginated data
    const places = await (this.db as any)
      .select()
      .from(placesTable)
      .where(whereCondition)
      .orderBy(...orderBy)
      .limit(limit)
      .offset(offset);

    return {
      data: places,
      total: Number(total),
      page,
      limit,
      pages: Math.ceil(Number(total) / limit),
    };
  }

  /**
   * Update place by ID
   */
  async update(id: number, data: UpdatePlaceData): Promise<Place | null> {
    // Validate coordinates if provided
    if (data.latitude !== undefined && data.longitude !== undefined) {
      if (!validateCoordinates(data.latitude, data.longitude)) {
        throw new InvalidCoordinatesError(data.latitude, data.longitude);
      }
    }

    const placesTable = this.tables.places;
    const updateData: Partial<UpdatePlaceData> = {
      ...(data.name !== undefined && { name: data.name }),
      ...(data.description !== undefined && { description: data.description }),
      ...(data.latitude !== undefined && { latitude: data.latitude }),
      ...(data.longitude !== undefined && { longitude: data.longitude }),
      ...(data.region !== undefined && { region: data.region }),
      ...(data.mediaUrls !== undefined && { mediaUrls: data.mediaUrls }),
      ...(data.culturalSignificance !== undefined && {
        culturalSignificance: data.culturalSignificance,
      }),
      ...(data.isRestricted !== undefined && {
        isRestricted: data.isRestricted,
      }),
      updatedAt: new Date(),
    };

    const [updated] = await (this.db as any)
      .update(placesTable)
      .set(updateData)
      .where(eq(placesTable.id, id))
      .returning();

    return updated || null;
  }

  async delete(id: number): Promise<boolean> {
    const placesTable = this.tables.places;

    try {
      // For now, we'll do hard delete since soft delete isn't in schema
      // In production, this would be a soft delete with a deletedAt timestamp
      const [deleted] = await (this.db as any)
        .delete(placesTable)
        .where(eq(placesTable.id, id))
        .returning({ id: placesTable.id });

      return !!deleted;
    } catch {
      return false;
    }
  }

  /**
   * Search places within a radius using the same application-level Haversine
   * calculation on every supported database backend.
   */
  async searchNear(
    params: NearbySearchParams
  ): Promise<PaginatedResponse<Place>> {
    const {
      communityId,
      latitude,
      longitude,
      radiusKm,
      page,
      limit,
      includeRestricted = false,
    } = params;

    // Validate search coordinates
    if (!validateCoordinates(latitude, longitude)) {
      throw new InvalidCoordinatesError(latitude, longitude);
    }
    if (!Number.isFinite(radiusKm) || radiusKm < 0) {
      throw new InvalidBoundsError(
        'Search radius must be a non-negative finite number'
      );
    }

    const placesTable = this.tables.places;
    const offset = (page - 1) * limit;
    const bounds = SpatialUtils.calculateBoundingBox(
      latitude,
      longitude,
      radiusKm
    );
    const whereConditions = [
      eq(placesTable.communityId, communityId),
      sql`${placesTable.latitude} BETWEEN ${bounds.south} AND ${bounds.north}`,
    ];

    if (!bounds.includesAllLongitudes) {
      whereConditions.push(
        bounds.crossesAntimeridian
          ? sql`(${placesTable.longitude} >= ${bounds.west} OR ${placesTable.longitude} <= ${bounds.east})`
          : sql`${placesTable.longitude} BETWEEN ${bounds.west} AND ${bounds.east}`
      );
    }

    if (!includeRestricted) {
      whereConditions.push(eq(placesTable.isRestricted, false));
    }

    const candidates = await (this.db as any)
      .select()
      .from(placesTable)
      .where(and(...whereConditions));

    const nearbyPlaces = candidates
      .map((place: Place) => ({
        place,
        distance: this.calculateHaversineDistance(
          latitude,
          longitude,
          place.latitude,
          place.longitude
        ),
      }))
      .filter(({ distance }: { distance: number }) => distance <= radiusKm)
      // Distance, then id, so equal distances page deterministically.
      .sort(
        (
          a: { distance: number; place: Place },
          b: { distance: number; place: Place }
        ) => a.distance - b.distance || a.place.id - b.place.id
      );

    const total = nearbyPlaces.length;
    const paginatedPlaces = nearbyPlaces
      .slice(offset, offset + limit)
      .map(({ place }: { place: Place }) => place);

    return {
      data: paginatedPlaces,
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
    };
  }

  /**
   * Search places within bounding box
   */
  async searchInBounds(
    params: BoundsSearchParams
  ): Promise<PaginatedResponse<Place>> {
    const {
      communityId,
      north,
      south,
      east,
      west,
      page,
      limit,
      includeRestricted = false,
    } = params;

    // Validate bounds
    if (north <= south || east <= west) {
      throw new InvalidBoundsError(
        'Invalid bounding box: north must be > south, east must be > west'
      );
    }

    if (
      !validateCoordinates(north, west) ||
      !validateCoordinates(south, east)
    ) {
      throw new InvalidCoordinatesError();
    }

    const placesTable = this.tables.places;
    const offset = (page - 1) * limit;
    const boundsCondition = and(
      sql`${placesTable.latitude} BETWEEN ${south} AND ${north}`,
      sql`${placesTable.longitude} BETWEEN ${west} AND ${east}`
    );

    let whereCondition = and(
      eq(placesTable.communityId, communityId),
      boundsCondition
    );

    if (!includeRestricted) {
      whereCondition = and(whereCondition, eq(placesTable.isRestricted, false));
    }

    // Get total count
    const [{ count: total }] = await (this.db as any)
      .select({ count: count() })
      .from(placesTable)
      .where(whereCondition);

    // Get paginated data
    const places = await (this.db as any)
      .select()
      .from(placesTable)
      .where(whereCondition)
      .orderBy(...this.sortOrder('name', 'asc'))
      .limit(limit)
      .offset(offset);

    return {
      data: places,
      total: Number(total),
      page,
      limit,
      pages: Math.ceil(Number(total) / limit),
    };
  }

  /**
   * Get places associated with a story
   */
  async getPlacesByStory(storyId: number): Promise<Place[]> {
    const placesTable = this.tables.places;
    const places = await (this.db as any)
      .select({
        ...(Object.fromEntries(
          Object.entries(placesTable).filter(
            ([key]) =>
              typeof placesTable[key as keyof typeof placesTable] !== 'function'
          )
        ) as { [K in keyof Place]: any }),
      })
      .from(placesTable)
      .innerJoin(
        this.tables.storyPlaces,
        eq(placesTable.id, this.tables.storyPlaces.placeId)
      )
      .where(eq(this.tables.storyPlaces.storyId, storyId));

    return places as Place[];
  }

  /**
   * Get stories associated with a place
   */
  async getStoriesByPlace(
    placeId: number,
    communityId: number
  ): Promise<any[]> {
    const storiesTable = this.tables.stories;
    const placeStories = await (this.db as any)
      .select()
      .from(storiesTable)
      .innerJoin(
        this.tables.storyPlaces,
        eq(storiesTable.id, this.tables.storyPlaces.storyId)
      )
      .where(
        and(
          eq(this.tables.storyPlaces.placeId, placeId),
          eq(storiesTable.communityId, communityId)
        )
      );

    return placeStories;
  }

  /**
   * Associate place with story
   */
  async addStoryPlaceAssociation(
    storyId: number,
    placeId: number
  ): Promise<void> {
    await (this.db as any)
      .insert(this.tables.storyPlaces)
      .values({ storyId, placeId })
      .onConflictDoNothing(); // Prevent duplicate associations
  }

  /**
   * Remove story-place association
   */
  async removeStoryPlaceAssociation(
    storyId: number,
    placeId: number
  ): Promise<void> {
    await (this.db as any)
      .delete(this.tables.storyPlaces)
      .where(
        and(
          eq(this.tables.storyPlaces.storyId, storyId),
          eq(this.tables.storyPlaces.placeId, placeId)
        )
      );
  }

  private calculateHaversineDistance(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number
  ): number {
    const R = 6371; // Earth's radius in kilometers
    const dLat = this.toRadians(lat2 - lat1);
    const dLon = this.toRadians(lon2 - lon1);

    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.toRadians(lat1)) *
        Math.cos(this.toRadians(lat2)) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  /**
   * Convert degrees to radians
   */
  private toRadians(degrees: number): number {
    return degrees * (Math.PI / 180);
  }

  /**
   * Get place statistics for a community
   */
  async getCommunityPlaceStats(communityId: number): Promise<{
    total: number;
    restricted: number;
    public: number;
    withStories: number;
  }> {
    const placesTable = this.tables.places;

    const [totalResult] = await (this.db as any)
      .select({ count: count() })
      .from(placesTable)
      .where(eq(placesTable.communityId, communityId));

    const [restrictedResult] = await (this.db as any)
      .select({ count: count() })
      .from(placesTable)
      .where(
        and(
          eq(placesTable.communityId, communityId),
          eq(placesTable.isRestricted, true)
        )
      );

    const [withStoriesResult] = await (this.db as any)
      .select({ count: count(sql`DISTINCT ${placesTable.id}`) })
      .from(placesTable)
      .innerJoin(
        this.tables.storyPlaces,
        eq(placesTable.id, this.tables.storyPlaces.placeId)
      )
      .where(eq(placesTable.communityId, communityId));

    const total = Number(totalResult.count);
    const restricted = Number(restrictedResult.count);

    return {
      total,
      restricted,
      public: total - restricted,
      withStories: Number(withStoriesResult.count),
    };
  }
}
