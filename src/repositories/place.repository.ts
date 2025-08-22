/**
 * Place Repository
 *
 * Database operations for place management with PostGIS spatial support,
 * multi-database compatibility, and comprehensive CRUD operations.
 *
 * Features:
 * - PostGIS spatial queries with SQLite fallback
 * - Geographic search operations (distance, bounding box)
 * - Community data isolation and multi-tenancy
 * - Story-place association management
 * - Cultural protocol support for restricted places
 * - Performance-optimized queries with spatial indexing
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
// NOTE: Many 'any' types in this file are unavoidable due to Drizzle ORM's
// complex typing with spatial queries and multi-database compatibility.

import { eq, and, desc, sql, count } from 'drizzle-orm';
import type { Place, NewPlace } from '../db/schema/places.js';
import {
  getPlacesTable,
  spatialHelpers,
  validateCoordinates,
} from '../db/schema/places.js';
import { storyPlaces } from '../db/schema/story_places.js';
import { stories } from '../db/schema/stories.js';
import { getCommunitiesTable } from '../db/schema/communities.js';
import { getConfig } from '../shared/config/index.js';
import type { Database } from '../db/index.js';

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

/**
 * Custom error classes
 */
export class PlaceNotFoundError extends Error {
  constructor(message = 'Place not found') {
    super(message);
    this.name = 'PlaceNotFoundError';
  }
}

export class InvalidCoordinatesError extends Error {
  constructor(message = 'Invalid geographic coordinates') {
    super(message);
    this.name = 'InvalidCoordinatesError';
  }
}

export class InvalidBoundsError extends Error {
  constructor(message = 'Invalid bounding box coordinates') {
    super(message);
    this.name = 'InvalidBoundsError';
  }
}

/**
 * Place Repository Class
 *
 * Provides complete database operations for places with PostGIS spatial support
 */
export class PlaceRepository {
  private db: DatabaseType;
  private isPostgres: boolean;

  constructor(database: DatabaseType) {
    this.db = database;
    // Detect database type from connection string
    const config = getConfig();
    this.isPostgres =
      config.database.url.startsWith('postgresql://') ||
      config.database.url.startsWith('postgres://');
  }

  /**
   * Create a new place with coordinate validation
   */
  async create(
    data: CreatePlaceData & { communityId: number }
  ): Promise<Place> {
    // Validate coordinates
    if (!validateCoordinates(data.latitude, data.longitude)) {
      throw new InvalidCoordinatesError('Invalid latitude or longitude values');
    }

    const placesTable = await getPlacesTable();

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
    };

    try {
      // Check if community exists first (SQLite doesn't enforce foreign keys in tests)
      const communityTable = await getCommunitiesTable();

      const [existingCommunity] = await (this.db as any)
        .select({ id: communityTable.id })
        .from(communityTable)
        .where(eq(communityTable.id, data.communityId))
        .limit(1);

      if (!existingCommunity) {
        throw new Error('Invalid community ID');
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
        throw new Error('Invalid community ID');
      }
      throw error;
    }
  }

  /**
   * Get place by ID without community check (internal use)
   */
  async getById(id: number): Promise<Place | null> {
    const placesTable = await getPlacesTable();

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
    const placesTable = await getPlacesTable();

    const [place] = await (this.db as any)
      .select()
      .from(placesTable)
      .where(
        and(eq(placesTable.id, id), eq(placesTable.communityId, communityId))
      )
      .limit(1);

    return place || null;
  }

  /**
   * Get paginated places for a community
   */
  async getByCommunity(
    communityId: number,
    params: CommunityPlaceParams
  ): Promise<PaginatedResponse<Place>> {
    const placesTable = await getPlacesTable();
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

    // Build order by
    const sortColumn =
      sortBy === 'name'
        ? placesTable.name
        : sortBy === 'created_at'
          ? placesTable.createdAt
          : placesTable.updatedAt;
    const orderBy = sortOrder === 'desc' ? desc(sortColumn) : sortColumn;

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
      .orderBy(orderBy)
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
        throw new InvalidCoordinatesError(
          'Invalid latitude or longitude values'
        );
      }
    }

    const placesTable = await getPlacesTable();

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

  /**
   * Soft delete place by ID
   */
  async delete(id: number): Promise<boolean> {
    const placesTable = await getPlacesTable();

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
   * Search places within radius using PostGIS or fallback calculation
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
      throw new InvalidCoordinatesError('Invalid search coordinates');
    }

    const placesTable = await getPlacesTable();
    const offset = (page - 1) * limit;
    const radiusMeters = radiusKm * 1000;

    if (this.isPostgres) {
      // Use PostGIS for PostgreSQL
      const distanceCondition = sql`${spatialHelpers.findWithinRadius(latitude, longitude, radiusMeters)}`;

      let whereCondition = and(
        eq(placesTable.communityId, communityId),
        distanceCondition
      );

      if (!includeRestricted) {
        whereCondition = and(
          whereCondition,
          eq(placesTable.isRestricted, false)
        );
      }

      // Get total count
      const [{ count: total }] = await (this.db as any)
        .select({ count: count() })
        .from(placesTable)
        .where(whereCondition);

      // Get data with distance calculation
      const places = await (this.db as any)
        .select({
          ...(Object.fromEntries(
            Object.entries(placesTable).filter(
              ([key]) =>
                typeof placesTable[key as keyof typeof placesTable] !==
                'function'
            )
          ) as { [K in keyof Place]: any }),
          distance:
            sql<number>`${spatialHelpers.calculateDistance(latitude, longitude)}`.as(
              'distance'
            ),
        })
        .from(placesTable)
        .where(whereCondition)
        .orderBy(sql`distance ASC`)
        .limit(limit)
        .offset(offset);

      return {
        data: places.map(
          ({ distance: _distance, ...place }: any) => place as Place
        ),
        total: Number(total),
        page,
        limit,
        pages: Math.ceil(Number(total) / limit),
      };
    } else {
      // SQLite fallback: use Haversine formula approximation
      const whereConditions = [eq(placesTable.communityId, communityId)];
      if (!includeRestricted) {
        whereConditions.push(eq(placesTable.isRestricted, false));
      }

      const places = await (this.db as any)
        .select()
        .from(placesTable)
        .where(and(...whereConditions));

      // Compute distance once per place and cache it
      const placesWithDistance = places.map((place: any) => ({
        ...place,
        distance: this.calculateHaversineDistance(
          latitude,
          longitude,
          place.latitude,
          place.longitude
        ),
      }));

      // Filter by distance and sort by distance
      const nearbyPlaces = placesWithDistance
        .filter((place: any) => place.distance <= radiusKm)
        .sort((a: any, b: any) => a.distance - b.distance);

      // Apply pagination
      const total = nearbyPlaces.length;
      const paginatedPlaces = nearbyPlaces.slice(offset, offset + limit);

      return {
        data: paginatedPlaces,
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
      };
    }
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
      throw new InvalidCoordinatesError('Invalid bounding box coordinates');
    }

    const placesTable = await getPlacesTable();
    const offset = (page - 1) * limit;

    // Use coordinate range check (works for both PostGIS and SQLite)
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
      .orderBy(placesTable.name)
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
    const placesTable = await getPlacesTable();

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
      .innerJoin(storyPlaces, eq(placesTable.id, storyPlaces.placeId))
      .where(eq(storyPlaces.storyId, storyId));

    return places as Place[];
  }

  /**
   * Get stories associated with a place
   */
  async getStoriesByPlace(
    placeId: number,
    communityId: number
  ): Promise<any[]> {
    const storiesTable = stories;

    const placeStories = await (this.db as any)
      .select()
      .from(storiesTable)
      .innerJoin(storyPlaces, eq(storiesTable.id, storyPlaces.storyId))
      .where(
        and(
          eq(storyPlaces.placeId, placeId),
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
      .insert(storyPlaces)
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
      .delete(storyPlaces)
      .where(
        and(eq(storyPlaces.storyId, storyId), eq(storyPlaces.placeId, placeId))
      );
  }

  /**
   * Calculate Haversine distance in kilometers (SQLite fallback)
   */
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
    const placesTable = await getPlacesTable();

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
      .innerJoin(storyPlaces, eq(placesTable.id, storyPlaces.placeId))
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
