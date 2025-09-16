/**
 * Speaker Repository
 *
 * Database operations for speaker management with Indigenous cultural protocols,
 * multi-database compatibility, and comprehensive CRUD operations.
 *
 * Features:
 * - Complete CRUD operations with community data isolation
 * - Elder status recognition and cultural role filtering
 * - Community statistics generation
 * - Multi-database compatibility (PostgreSQL/SQLite)
 * - Cultural protocol support for Indigenous communities
 * - Comprehensive error handling and validation
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
// NOTE: Many 'any' types in this file are unavoidable due to Drizzle ORM's
// complex typing with multi-database compatibility.

import { eq, and, desc, count, like, ilike } from 'drizzle-orm';
import {
  type Speaker,
  type NewSpeaker,
  getSpeakersTable,
} from '../db/schema/speakers.js';
import { getConfig } from '../shared/config/index.js';
import type { Database } from '../db/index.js';
import {
  AppError,
  CommunityNotFoundError,
  DatabaseError,
  RequiredFieldError,
  InvalidFieldLengthError,
} from '../shared/errors/index.js';
import {
  createErrorContext,
  DatabaseOperations,
  ErrorMessages,
  ResourceTypes,
} from '../shared/utils/error-context.js';
import { validateCommunityExists } from '../shared/utils/community-validation.js';

// Re-export Speaker type for other modules
export type { Speaker } from '../db/schema/speakers.js';

// Database type union for compatibility
type DatabaseType = Database;

/**
 * Request parameters for speaker creation
 */
export interface CreateSpeakerData {
  name: string;
  bio?: string;
  photoUrl?: string;
  birthYear?: number;
  elderStatus?: boolean;
  culturalRole?: string;
  isActive?: boolean;
}

/**
 * Request parameters for speaker updates
 */
export interface UpdateSpeakerData {
  name?: string;
  bio?: string;
  photoUrl?: string;
  birthYear?: number;
  elderStatus?: boolean;
  culturalRole?: string;
  isActive?: boolean;
  updatedAt?: Date;
}

/**
 * Parameters for community speaker listing
 */
export interface CommunitySpeakerParams {
  page: number;
  limit: number;
  elderOnly?: boolean;
  culturalRole?: string;
  activeOnly?: boolean;
  sortBy?: 'name' | 'created_at' | 'updated_at';
  sortOrder?: 'asc' | 'desc';
}

/**
 * Parameters for speaker search
 */
export interface SpeakerSearchParams {
  page: number;
  limit: number;
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
 * Community speaker statistics
 */
export interface SpeakerStats {
  total: number;
  active: number;
  inactive: number;
  elders: number;
  nonElders: number;
}

/**
 * Speaker Repository Class
 *
 * Provides complete database operations for speakers with cultural protocol support
 */
export class SpeakerRepository {
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
   * Create a new speaker with validation
   */
  async create(
    data: CreateSpeakerData & { communityId: number }
  ): Promise<Speaker> {
    // Validate required fields
    if (!data.name || data.name.trim().length === 0) {
      throw new RequiredFieldError('name');
    }

    if (data.name.length > 200) {
      throw new InvalidFieldLengthError('name', 200, data.name.length);
    }

    if (data.bio && data.bio.length > 2000) {
      throw new InvalidFieldLengthError('bio', 2000, data.bio.length);
    }

    if (data.culturalRole && data.culturalRole.length > 100) {
      throw new InvalidFieldLengthError(
        'culturalRole',
        100,
        data.culturalRole.length
      );
    }

    // Validate photo URL format if provided
    if (data.photoUrl !== undefined && data.photoUrl !== null) {
      const urlOk =
        typeof data.photoUrl === 'string' &&
        /^https?:\/\/\S+/i.test(data.photoUrl);
      if (!urlOk) {
        throw new Error('Invalid photo URL format');
      }
    }

    // Validate birth year range if provided
    if (data.birthYear !== undefined && data.birthYear !== null) {
      const year = data.birthYear;
      const currentYear = new Date().getFullYear();
      if (year < 1850) {
        throw new Error('Birth year too early (minimum 1850)');
      }
      if (year > currentYear) {
        throw new Error('Birth year cannot be in the future');
      }
    }

    const speakersTable = await getSpeakersTable();

    const now = new Date();
    const speakerData: NewSpeaker = {
      name: data.name.trim(),
      bio: data.bio || null,
      communityId: data.communityId,
      photoUrl: data.photoUrl || null,
      birthYear: data.birthYear || null,
      elderStatus: data.elderStatus || false,
      culturalRole: data.culturalRole || null,
      isActive: data.isActive !== undefined ? data.isActive : true,
      createdAt: now,
      updatedAt: now,
    };

    try {
      // Validate community exists using shared utility
      await validateCommunityExists(this.db, data.communityId);

      const [speaker] = await (this.db as any)
        .insert(speakersTable)
        .values(speakerData)
        .returning();

      return speaker;
    } catch (error) {
      // Handle specific database errors first
      if (error instanceof AppError) {
        throw error; // Re-throw AppErrors as-is
      }

      if (error instanceof Error) {
        // Handle foreign key constraint violations
        if (
          error.message.includes('foreign key') ||
          error.message.includes('Invalid community ID')
        ) {
          throw new CommunityNotFoundError();
        }

        // Handle SQLite function errors (like "no such function: now")
        if (error.message.includes('no such function')) {
          throw new DatabaseError(
            ErrorMessages.DATABASE_COMPATIBILITY(error.message),
            createErrorContext({
              operation: DatabaseOperations.CREATE_SPEAKER,
              resourceType: ResourceTypes.SPEAKER,
              communityId: data.communityId,
              originalError: error,
            })
          );
        }

        // Handle constraint violations
        if (
          error.message.includes('constraint') ||
          error.message.includes('UNIQUE constraint failed')
        ) {
          throw new DatabaseError(
            'Speaker data conflicts with existing records: ' + error.message,
            { originalError: error.message, operation: 'insert_speaker' }
          );
        }

        // Handle any other database errors
        throw new DatabaseError(
          'Failed to create speaker due to database error',
          { originalError: error.message, operation: 'insert_speaker' }
        );
      }

      // Handle unknown errors
      throw new DatabaseError(
        ErrorMessages.UNKNOWN_ERROR(
          DatabaseOperations.CREATE_SPEAKER,
          ResourceTypes.SPEAKER
        ),
        createErrorContext({
          operation: DatabaseOperations.CREATE_SPEAKER,
          resourceType: ResourceTypes.SPEAKER,
          communityId: data.communityId,
          originalError: error,
        })
      );
    }
  }

  /**
   * Get speaker by ID without community check (internal use)
   */
  async getById(id: number): Promise<Speaker | null> {
    const speakersTable = await getSpeakersTable();

    const [speaker] = await (this.db as any)
      .select()
      .from(speakersTable)
      .where(eq(speakersTable.id, id))
      .limit(1);

    return speaker || null;
  }

  /**
   * Get speaker by ID with community isolation
   */
  async getByIdWithCommunityCheck(
    id: number,
    communityId: number
  ): Promise<Speaker | null> {
    try {
      const speakersTable = await getSpeakersTable();

      const [speaker] = await (this.db as any)
        .select()
        .from(speakersTable)
        .where(
          and(
            eq(speakersTable.id, id),
            eq(speakersTable.communityId, communityId)
          )
        )
        .limit(1);

      return speaker || null;
    } catch (error) {
      // Handle database errors gracefully
      if (error instanceof Error) {
        // Handle SQLite function errors (like "no such function: now")
        if (error.message.includes('no such function')) {
          throw new DatabaseError(
            ErrorMessages.DATABASE_COMPATIBILITY('during speaker lookup'),
            createErrorContext({
              operation: DatabaseOperations.GET_BY_ID_WITH_COMMUNITY,
              resourceType: ResourceTypes.SPEAKER,
              resourceId: id,
              communityId,
              originalError: error,
            })
          );
        }

        // Handle other database errors
        throw new DatabaseError(
          'Failed to retrieve speaker due to database error',
          {
            originalError: error.message,
            operation: 'get_speaker_by_id',
            speakerId: id,
            communityId,
          }
        );
      }

      // Handle unknown errors
      throw new DatabaseError(
        'Unknown error occurred while retrieving speaker',
        {
          originalError: String(error),
          operation: 'get_speaker_by_id',
          speakerId: id,
          communityId,
        }
      );
    }
  }

  /**
   * Get paginated speakers for a community
   */
  async getByCommunity(
    communityId: number,
    params: CommunitySpeakerParams
  ): Promise<PaginatedResponse<Speaker>> {
    const speakersTable = await getSpeakersTable();
    const {
      page,
      limit,
      elderOnly = false,
      culturalRole,
      activeOnly = true,
      sortBy = 'name',
      sortOrder = 'asc',
    } = params;
    const offset = (page - 1) * limit;

    // Build where conditions
    const whereConditions = [eq(speakersTable.communityId, communityId)];

    if (elderOnly) {
      whereConditions.push(eq(speakersTable.elderStatus, true));
    }

    if (culturalRole) {
      whereConditions.push(eq(speakersTable.culturalRole, culturalRole));
    }

    if (activeOnly) {
      whereConditions.push(eq(speakersTable.isActive, true));
    }

    const whereCondition = and(...whereConditions);

    // Build order by
    const sortColumn =
      sortBy === 'name'
        ? speakersTable.name
        : sortBy === 'created_at'
          ? speakersTable.createdAt
          : speakersTable.updatedAt;
    const orderBy = sortOrder === 'desc' ? desc(sortColumn) : sortColumn;

    // Get total count
    const [{ count: total }] = await (this.db as any)
      .select({ count: count() })
      .from(speakersTable)
      .where(whereCondition);

    // Get paginated data
    const speakers = await (this.db as any)
      .select()
      .from(speakersTable)
      .where(whereCondition)
      .orderBy(orderBy)
      .limit(limit)
      .offset(offset);

    return {
      data: speakers,
      total: Number(total),
      page,
      limit,
      pages: Math.ceil(Number(total) / limit),
    };
  }

  /**
   * Update speaker by ID
   */
  async update(id: number, data: UpdateSpeakerData): Promise<Speaker | null> {
    // Validate fields if provided
    if (data.name !== undefined) {
      if (!data.name || data.name.trim().length === 0) {
        throw new RequiredFieldError('name');
      }
      if (data.name.length > 200) {
        throw new InvalidFieldLengthError('name', 200, data.name.length);
      }
    }

    if (data.bio !== undefined && data.bio && data.bio.length > 2000) {
      throw new InvalidFieldLengthError('bio', 2000, data.bio.length);
    }

    if (
      data.culturalRole !== undefined &&
      data.culturalRole &&
      data.culturalRole.length > 100
    ) {
      throw new InvalidFieldLengthError(
        'culturalRole',
        100,
        data.culturalRole.length
      );
    }

    // Validate photo URL format if provided
    if (data.photoUrl !== undefined && data.photoUrl !== null) {
      const urlOk =
        typeof data.photoUrl === 'string' &&
        /^https?:\/\/\S+/i.test(data.photoUrl);
      if (!urlOk) {
        throw new Error('Invalid photo URL format');
      }
    }

    // Validate birth year range if provided
    if (data.birthYear !== undefined && data.birthYear !== null) {
      const year = data.birthYear;
      const currentYear = new Date().getFullYear();
      if (year < 1850) {
        throw new Error('Birth year too early (minimum 1850)');
      }
      if (year > currentYear) {
        throw new Error('Birth year cannot be in the future');
      }
    }

    const speakersTable = await getSpeakersTable();

    const updateData: Partial<UpdateSpeakerData> = {
      ...(data.name !== undefined && { name: data.name.trim() }),
      ...(data.bio !== undefined && { bio: data.bio }),
      ...(data.photoUrl !== undefined && { photoUrl: data.photoUrl }),
      ...(data.birthYear !== undefined && { birthYear: data.birthYear }),
      ...(data.elderStatus !== undefined && { elderStatus: data.elderStatus }),
      ...(data.culturalRole !== undefined && {
        culturalRole: data.culturalRole,
      }),
      ...(data.isActive !== undefined && { isActive: data.isActive }),
      updatedAt: new Date(),
    };

    const [updated] = await (this.db as any)
      .update(speakersTable)
      .set(updateData)
      .where(eq(speakersTable.id, id))
      .returning();

    return updated || null;
  }

  /**
   * Delete speaker by ID
   */
  async delete(id: number): Promise<boolean> {
    const speakersTable = await getSpeakersTable();

    try {
      const [deleted] = await (this.db as any)
        .delete(speakersTable)
        .where(eq(speakersTable.id, id))
        .returning({ id: speakersTable.id });

      return !!deleted;
    } catch {
      return false;
    }
  }

  /**
   * Search speakers by name
   */
  async searchByName(
    communityId: number,
    query: string,
    params: SpeakerSearchParams
  ): Promise<PaginatedResponse<Speaker>> {
    const speakersTable = await getSpeakersTable();
    const { page, limit } = params;
    const offset = (page - 1) * limit;

    // Use case-insensitive search for Postgres, case-sensitive for SQLite
    const searchCondition = this.isPostgres
      ? ilike(speakersTable.name, `%${query}%`)
      : like(speakersTable.name, `%${query.toLowerCase()}%`);

    const whereCondition = and(
      eq(speakersTable.communityId, communityId),
      searchCondition
    );

    // Get total count
    const [{ count: total }] = await (this.db as any)
      .select({ count: count() })
      .from(speakersTable)
      .where(whereCondition);

    // Get paginated data
    const speakers = await (this.db as any)
      .select()
      .from(speakersTable)
      .where(whereCondition)
      .orderBy(speakersTable.name)
      .limit(limit)
      .offset(offset);

    return {
      data: speakers,
      total: Number(total),
      page,
      limit,
      pages: Math.ceil(Number(total) / limit),
    };
  }

  /**
   * Get speaker statistics for a community
   */
  async getCommunityStats(communityId: number): Promise<SpeakerStats> {
    const speakersTable = await getSpeakersTable();

    const [totalResult] = await (this.db as any)
      .select({ count: count() })
      .from(speakersTable)
      .where(eq(speakersTable.communityId, communityId));

    const [activeResult] = await (this.db as any)
      .select({ count: count() })
      .from(speakersTable)
      .where(
        and(
          eq(speakersTable.communityId, communityId),
          eq(speakersTable.isActive, true)
        )
      );

    const [eldersResult] = await (this.db as any)
      .select({ count: count() })
      .from(speakersTable)
      .where(
        and(
          eq(speakersTable.communityId, communityId),
          eq(speakersTable.elderStatus, true)
        )
      );

    const total = Number(totalResult.count);
    const active = Number(activeResult.count);
    const elders = Number(eldersResult.count);

    return {
      total,
      active,
      inactive: total - active,
      elders,
      nonElders: total - elders,
    };
  }
}
