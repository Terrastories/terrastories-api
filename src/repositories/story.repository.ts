/**
 * Story Repository
 *
 * Data access layer for stories with comprehensive association management,
 * search capabilities, and cultural protocol support.
 *
 * Features:
 * - Full CRUD operations with transactions
 * - Many-to-many association management (places, speakers)
 * - Slug generation and uniqueness validation
 * - Complex search with full-text and geographic filtering
 * - Community data isolation and cultural protocol enforcement
 * - Optimized queries with proper joins and indexing
 */

import { and, eq, ilike, inArray, or, sql, count, desc } from 'drizzle-orm';
import type { Database } from '../db/index.js';
import {
  stories,
  type Story,
  type NewStory,
  getStoriesTable,
} from '../db/schema/stories.js';
import { storyPlaces } from '../db/schema/story_places.js';
import { storySpeakers } from '../db/schema/story_speakers.js';
import { places } from '../db/schema/places.js';
import { speakers } from '../db/schema/speakers.js';
import { communities } from '../db/schema/communities.js';
import { users } from '../db/schema/users.js';

/**
 * Story creation data with associations
 */
export interface StoryCreateData {
  title: string;
  description?: string;
  slug?: string;
  communityId: number;
  createdBy: number;
  mediaUrls?: string[];
  language?: string;
  tags?: string[];
  isRestricted?: boolean;
  placeIds?: number[];
  speakerIds?: number[];
  placeContexts?: string[];
  speakerRoles?: string[];
}

/**
 * Story with populated relations
 */
export interface StoryWithRelations extends Story {
  places: PlaceWithContext[];
  speakers: SpeakerWithRole[];
  community: any;
  author: any;
}

export interface PlaceWithContext {
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
}

export interface SpeakerWithRole {
  id: number;
  name: string;
  bio?: string;
  photoUrl?: string;
  birthYear?: number;
  elderStatus: boolean;
  culturalRole?: string;
  storyRole?: string;
  sortOrder?: number;
}

/**
 * Search and filtering options
 */
export interface StoryFilters {
  communityId: number;
  search?: string;
  isRestricted?: boolean;
  tags?: string[];
  createdBy?: number;
  language?: string;
  nearPoint?: GeoJSON.Point;
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

export class StoryRepository {
  constructor(private readonly db: Database) {}

  /**
   * Create a new story with associations
   */
  async create(data: StoryCreateData): Promise<StoryWithRelations> {
    return this.db.transaction(async (tx) => {
      // Generate unique slug if not provided
      const slug = data.slug || await this.generateUniqueSlug(data.title, data.communityId, tx);

      // Insert story record
      const [story] = await tx
        .insert(stories)
        .values({
          title: data.title,
          description: data.description,
          slug,
          communityId: data.communityId,
          createdBy: data.createdBy,
          mediaUrls: data.mediaUrls || [],
          language: data.language || 'en',
          tags: data.tags || [],
          isRestricted: data.isRestricted || false,
        })
        .returning();

      // Create place associations if provided
      if (data.placeIds?.length) {
        await tx.insert(storyPlaces).values(
          data.placeIds.map((placeId, index) => ({
            storyId: story.id,
            placeId,
            culturalContext: data.placeContexts?.[index],
            storyRelationship: undefined, // Can be added in future
            sortOrder: index,
          }))
        );
      }

      // Create speaker associations if provided
      if (data.speakerIds?.length) {
        await tx.insert(storySpeakers).values(
          data.speakerIds.map((speakerId, index) => ({
            storyId: story.id,
            speakerId,
            culturalRole: data.speakerRoles?.[index] || 'narrator',
            storyRole: data.speakerRoles?.[index] || 'narrator',
            sortOrder: index,
          }))
        );
      }

      // Return story with relations
      return this.findByIdWithRelations(story.id, tx) as Promise<StoryWithRelations>;
    });
  }

  /**
   * Find story by ID
   */
  async findById(id: number, tx?: any): Promise<Story | null> {
    const db = tx || this.db;
    const [story] = await db
      .select()
      .from(stories)
      .where(eq(stories.id, id))
      .limit(1);

    return story || null;
  }

  /**
   * Find story by slug within community
   */
  async findBySlug(slug: string, communityId: number, tx?: any): Promise<Story | null> {
    const db = tx || this.db;
    const [story] = await db
      .select()
      .from(stories)
      .where(
        and(
          eq(stories.slug, slug),
          eq(stories.communityId, communityId)
        )
      )
      .limit(1);

    return story || null;
  }

  /**
   * Find story by ID with all relations populated
   */
  async findByIdWithRelations(id: number, tx?: any): Promise<StoryWithRelations | null> {
    const db = tx || this.db;
    
    const rows = await db
      .select({
        // Story fields
        story: stories,
        // Place fields with context
        place: places,
        placeContext: {
          culturalContext: storyPlaces.culturalContext,
          storyRelationship: storyPlaces.storyRelationship,
          sortOrder: storyPlaces.sortOrder,
        },
        // Speaker fields with role
        speaker: speakers,
        speakerRole: {
          culturalRole: storySpeakers.culturalRole,
          storyRole: storySpeakers.storyRole,
          sortOrder: storySpeakers.sortOrder,
        },
        // Community and user
        community: communities,
        author: users,
      })
      .from(stories)
      .leftJoin(storyPlaces, eq(storyPlaces.storyId, stories.id))
      .leftJoin(places, eq(places.id, storyPlaces.placeId))
      .leftJoin(storySpeakers, eq(storySpeakers.storyId, stories.id))
      .leftJoin(speakers, eq(speakers.id, storySpeakers.speakerId))
      .leftJoin(communities, eq(communities.id, stories.communityId))
      .leftJoin(users, eq(users.id, stories.createdBy))
      .where(eq(stories.id, id));

    if (rows.length === 0) return null;

    return this.aggregateStoryData(rows);
  }

  /**
   * Find story by slug with all relations populated
   */
  async findBySlugWithRelations(slug: string, communityId: number, tx?: any): Promise<StoryWithRelations | null> {
    const db = tx || this.db;
    
    const rows = await db
      .select({
        // Story fields
        story: stories,
        // Place fields with context
        place: places,
        placeContext: {
          culturalContext: storyPlaces.culturalContext,
          storyRelationship: storyPlaces.storyRelationship,
          sortOrder: storyPlaces.sortOrder,
        },
        // Speaker fields with role
        speaker: speakers,
        speakerRole: {
          culturalRole: storySpeakers.culturalRole,
          storyRole: storySpeakers.storyRole,
          sortOrder: storySpeakers.sortOrder,
        },
        // Community and user
        community: communities,
        author: users,
      })
      .from(stories)
      .leftJoin(storyPlaces, eq(storyPlaces.storyId, stories.id))
      .leftJoin(places, eq(places.id, storyPlaces.placeId))
      .leftJoin(storySpeakers, eq(storySpeakers.storyId, stories.id))
      .leftJoin(speakers, eq(speakers.id, storySpeakers.speakerId))
      .leftJoin(communities, eq(communities.id, stories.communityId))
      .leftJoin(users, eq(users.id, stories.createdBy))
      .where(
        and(
          eq(stories.slug, slug),
          eq(stories.communityId, communityId)
        )
      );

    if (rows.length === 0) return null;

    return this.aggregateStoryData(rows);
  }

  /**
   * Update story with optional associations
   */
  async update(id: number, updates: Partial<StoryCreateData>): Promise<StoryWithRelations | null> {
    return this.db.transaction(async (tx) => {
      // First check if story exists
      const existingStory = await this.findById(id, tx);
      if (!existingStory) return null;

      // Update story fields (excluding associations)
      const { placeIds, speakerIds, placeContexts, speakerRoles, ...storyUpdates } = updates;
      
      if (Object.keys(storyUpdates).length > 0) {
        await tx
          .update(stories)
          .set({
            ...storyUpdates,
            updatedAt: new Date(),
          })
          .where(eq(stories.id, id));
      }

      // Update place associations if provided
      if (placeIds !== undefined) {
        // Delete existing associations
        await tx.delete(storyPlaces).where(eq(storyPlaces.storyId, id));
        
        // Create new associations
        if (placeIds.length > 0) {
          await tx.insert(storyPlaces).values(
            placeIds.map((placeId, index) => ({
              storyId: id,
              placeId,
              culturalContext: placeContexts?.[index],
              sortOrder: index,
            }))
          );
        }
      }

      // Update speaker associations if provided
      if (speakerIds !== undefined) {
        // Delete existing associations
        await tx.delete(storySpeakers).where(eq(storySpeakers.storyId, id));
        
        // Create new associations
        if (speakerIds.length > 0) {
          await tx.insert(storySpeakers).values(
            speakerIds.map((speakerId, index) => ({
              storyId: id,
              speakerId,
              culturalRole: speakerRoles?.[index] || 'narrator',
              storyRole: speakerRoles?.[index] || 'narrator',
              sortOrder: index,
            }))
          );
        }
      }

      return this.findByIdWithRelations(id, tx) as Promise<StoryWithRelations>;
    });
  }

  /**
   * Delete story and cascade associations
   */
  async delete(id: number): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      // Check if story exists
      const existingStory = await this.findById(id, tx);
      if (!existingStory) return false;

      // Delete associations first (foreign key constraints)
      await tx.delete(storyPlaces).where(eq(storyPlaces.storyId, id));
      await tx.delete(storySpeakers).where(eq(storySpeakers.storyId, id));

      // Delete the story
      await tx.delete(stories).where(eq(stories.id, id));

      return true;
    });
  }

  /**
   * Find many stories with filtering and pagination
   */
  async findMany(filters: StoryFilters, pagination: PaginationOptions): Promise<PaginatedResult<StoryWithRelations>> {
    const { page, limit, sortBy = 'createdAt', sortOrder = 'desc' } = pagination;
    const offset = (page - 1) * limit;

    // Build base query with filters
    let query = this.db
      .select({
        story: stories,
        place: places,
        placeContext: {
          culturalContext: storyPlaces.culturalContext,
          storyRelationship: storyPlaces.storyRelationship,
          sortOrder: storyPlaces.sortOrder,
        },
        speaker: speakers,
        speakerRole: {
          culturalRole: storySpeakers.culturalRole,
          storyRole: storySpeakers.storyRole,
          sortOrder: storySpeakers.sortOrder,
        },
        community: communities,
        author: users,
      })
      .from(stories)
      .leftJoin(storyPlaces, eq(storyPlaces.storyId, stories.id))
      .leftJoin(places, eq(places.id, storyPlaces.placeId))
      .leftJoin(storySpeakers, eq(storySpeakers.storyId, stories.id))
      .leftJoin(speakers, eq(speakers.id, storySpeakers.speakerId))
      .leftJoin(communities, eq(communities.id, stories.communityId))
      .leftJoin(users, eq(users.id, stories.createdBy));

    // Apply filters
    const conditions = [eq(stories.communityId, filters.communityId)];

    if (filters.search) {
      const searchTerm = `%${filters.search}%`;
      conditions.push(
        or(
          ilike(stories.title, searchTerm),
          ilike(stories.description, searchTerm),
          ilike(speakers.name, searchTerm)
        )!
      );
    }

    if (filters.isRestricted !== undefined) {
      conditions.push(eq(stories.isRestricted, filters.isRestricted));
    }

    if (filters.tags?.length) {
      // SQL to check if any of the filter tags exist in the story tags array
      const tagConditions = filters.tags.map(tag => 
        sql`JSON_EXTRACT(${stories.tags}, '$') LIKE '%"${sql.raw(tag)}"%'`
      );
      conditions.push(or(...tagConditions)!);
    }

    if (filters.createdBy) {
      conditions.push(eq(stories.createdBy, filters.createdBy));
    }

    if (filters.language) {
      conditions.push(eq(stories.language, filters.language));
    }

    if (filters.dateFrom) {
      conditions.push(sql`${stories.createdAt} >= ${filters.dateFrom}`);
    }

    if (filters.dateTo) {
      conditions.push(sql`${stories.createdAt} <= ${filters.dateTo}`);
    }

    // Geographic proximity filtering (if PostGIS available)
    if (filters.nearPoint && filters.radiusKm) {
      const { coordinates } = filters.nearPoint;
      const [lng, lat] = coordinates;
      
      // Simple distance calculation for SQLite/basic PostgreSQL
      // In production with PostGIS, this would use ST_DWithin
      conditions.push(
        sql`(
          6371 * acos(
            cos(radians(${lat})) 
            * cos(radians(${places.latitude})) 
            * cos(radians(${places.longitude}) - radians(${lng})) 
            + sin(radians(${lat})) 
            * sin(radians(${places.latitude}))
          )
        ) <= ${filters.radiusKm}`
      );
    }

    query = query.where(and(...conditions));

    // Add sorting
    const sortColumn = sortBy === 'title' ? stories.title : 
                      sortBy === 'updatedAt' ? stories.updatedAt : 
                      stories.createdAt;
    
    query = sortOrder === 'asc' ? 
      query.orderBy(sortColumn) : 
      query.orderBy(desc(sortColumn));

    // Execute paginated query
    const rows = await query.limit(limit).offset(offset);

    // Get total count for pagination
    const [totalResult] = await this.db
      .select({ count: count() })
      .from(stories)
      .where(and(...conditions.filter(c => !c.toString().includes('places.')))); // Exclude place-based conditions for count

    const total = totalResult.count;
    const totalPages = Math.ceil(total / limit);

    // Aggregate results
    const storyMap = new Map<number, StoryWithRelations>();
    
    for (const row of rows) {
      const storyId = row.story.id;
      
      if (!storyMap.has(storyId)) {
        storyMap.set(storyId, {
          ...row.story,
          places: [],
          speakers: [],
          community: row.community,
          author: row.author,
        });
      }

      const story = storyMap.get(storyId)!;

      // Add place if not already added
      if (row.place && !story.places.find(p => p.id === row.place!.id)) {
        story.places.push({
          ...row.place,
          culturalContext: row.placeContext.culturalContext,
          storyRelationship: row.placeContext.storyRelationship,
          sortOrder: row.placeContext.sortOrder,
        });
      }

      // Add speaker if not already added
      if (row.speaker && !story.speakers.find(s => s.id === row.speaker!.id)) {
        story.speakers.push({
          ...row.speaker,
          culturalRole: row.speakerRole.culturalRole,
          storyRole: row.speakerRole.storyRole,
          sortOrder: row.speakerRole.sortOrder,
        });
      }
    }

    // Sort associations by sortOrder
    Array.from(storyMap.values()).forEach(story => {
      story.places.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
      story.speakers.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
    });

    return {
      data: Array.from(storyMap.values()),
      total,
      page,
      limit,
      totalPages,
    };
  }

  /**
   * Generate unique slug from title
   */
  async generateUniqueSlug(title: string, communityId: number, tx?: any): Promise<string> {
    const db = tx || this.db;
    
    // Create base slug from title
    const baseSlug = title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '') // Remove special chars
      .replace(/\s+/g, '-') // Replace spaces with hyphens
      .replace(/-+/g, '-') // Replace multiple hyphens with single
      .replace(/^-|-$/g, '') // Remove leading/trailing hyphens
      .slice(0, 50); // Truncate to reasonable length

    let slug = baseSlug;
    let counter = 1;

    // Check for uniqueness within community
    while (await this.slugExists(slug, communityId, db)) {
      slug = `${baseSlug}-${counter}`;
      counter++;
    }

    return slug;
  }

  /**
   * Check if slug exists within community
   */
  private async slugExists(slug: string, communityId: number, db: any): Promise<boolean> {
    const [existing] = await db
      .select({ id: stories.id })
      .from(stories)
      .where(
        and(
          eq(stories.slug, slug),
          eq(stories.communityId, communityId)
        )
      )
      .limit(1);

    return !!existing;
  }

  /**
   * Aggregate story data from joined query results
   */
  private aggregateStoryData(rows: any[]): StoryWithRelations {
    const story = rows[0].story;
    const placesMap = new Map<number, PlaceWithContext>();
    const speakersMap = new Map<number, SpeakerWithRole>();

    for (const row of rows) {
      // Aggregate places
      if (row.place && !placesMap.has(row.place.id)) {
        placesMap.set(row.place.id, {
          ...row.place,
          culturalContext: row.placeContext.culturalContext,
          storyRelationship: row.placeContext.storyRelationship,
          sortOrder: row.placeContext.sortOrder,
        });
      }

      // Aggregate speakers
      if (row.speaker && !speakersMap.has(row.speaker.id)) {
        speakersMap.set(row.speaker.id, {
          ...row.speaker,
          culturalRole: row.speakerRole.culturalRole,
          storyRole: row.speakerRole.storyRole,
          sortOrder: row.speakerRole.sortOrder,
        });
      }
    }

    // Sort by sortOrder
    const places = Array.from(placesMap.values()).sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
    const speakers = Array.from(speakersMap.values()).sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));

    return {
      ...story,
      places,
      speakers,
      community: rows[0].community,
      author: rows[0].author,
    };
  }
}