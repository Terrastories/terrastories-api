/**
 * Community Repository
 *
 * Database operations for community management with multi-tenant isolation,
 * cultural protocol support, and comprehensive CRUD operations.
 *
 * Features:
 * - Complete community lifecycle management
 * - Multi-database compatibility (PostgreSQL/SQLite)
 * - Cultural settings and protocol support
 * - Slug generation and uniqueness validation
 * - Community isolation and data sovereignty
 * - Performance-optimized queries with proper indexing
 */

import { eq, and, like, desc, or, sql, count } from 'drizzle-orm';
import { communitiesSqlite } from '../db/schema/index.js';
import type { Community, NewCommunity } from '../db/schema/communities.js';

// Re-export Community type for other modules
export type { Community } from '../db/schema/communities.js';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

/**
 * Community data for creation requests
 */
export interface CreateCommunityData {
  name: string;
  description?: string;
  slug?: string;
  publicStories?: boolean;
  locale?: string;
  culturalSettings?: string;
  isActive?: boolean;
}

/**
 * Community data for update requests
 */
export interface UpdateCommunityData {
  name?: string;
  description?: string;
  publicStories?: boolean;
  locale?: string;
  culturalSettings?: string;
  isActive?: boolean;
  updatedAt?: Date;
}

/**
 * Search parameters for community queries
 */
export interface CommunitySearchParams {
  query?: string;
  locale?: string;
  isActive?: boolean;
  limit?: number;
  offset?: number;
}

/**
 * Cultural protocol configuration for Indigenous communities
 */
export interface CulturalProtocols {
  languagePreferences: string[];
  elderContentRestrictions: boolean;
  ceremonialContent: boolean;
  traditionalKnowledge: boolean;
  communityApprovalRequired: boolean;
  dataRetentionPolicy: string;
  accessRestrictions: string[];
  culturalNotes?: string;
}

/**
 * Community statistics and metrics
 */
export interface CommunityStats {
  id: number;
  name: string;
  userCount: number;
  storyCount: number;
  placeCount: number;
  speakerCount: number;
  createdAt: Date;
  lastActive: Date | null;
}

/**
 * Custom error classes for community operations
 */
export class CommunityNotFoundError extends Error {
  constructor(message = 'Community not found') {
    super(message);
    this.name = 'CommunityNotFoundError';
  }
}

export class DuplicateSlugError extends Error {
  constructor(message = 'Community slug already exists') {
    super(message);
    this.name = 'DuplicateSlugError';
  }
}

export class InvalidCommunityDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCommunityDataError';
  }
}

/**
 * Community Repository class providing database operations
 */
export class CommunityRepository {
  constructor(private db: BetterSQLite3Database<Record<string, never>>) {}

  /**
   * Generate a unique slug from community name
   * @param name - Community name
   * @param excludeId - Community ID to exclude from uniqueness check
   * @returns Promise<string> - Unique slug
   */
  private async generateUniqueSlug(
    name: string,
    excludeId?: number
  ): Promise<string> {
    // Create base slug from name
    let baseSlug = name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\s-]/g, '') // Remove special characters
      .replace(/[\s]+/g, '-') // Replace spaces with hyphens
      .replace(/-+/g, '-') // Remove multiple consecutive hyphens
      .replace(/^-|-$/g, ''); // Remove leading/trailing hyphens

    // Ensure minimum length
    if (baseSlug.length < 3) {
      baseSlug = `community-${baseSlug}`;
    }

    // Check for existing slugs and find unique variant
    const communities = communitiesSqlite;
    let slug = baseSlug;
    let counter = 1;

    while (true) {
      const conditions = [eq(communities.slug, slug)];
      if (excludeId) {
        conditions.push(sql`${communities.id} != ${excludeId}`);
      }

      const existing = await this.db
        .select({ id: communities.id })
        .from(communities)
        .where(and(...conditions))
        .limit(1);

      if (existing.length === 0) {
        break;
      }

      slug = `${baseSlug}-${counter}`;
      counter++;
    }

    return slug;
  }

  /**
   * Create a new community
   * @param data - Community creation data
   * @returns Promise<Community> - Created community
   */
  async create(data: CreateCommunityData): Promise<Community> {
    try {
      const communities = communitiesSqlite;

      // Validate required fields
      if (!data.name?.trim()) {
        throw new InvalidCommunityDataError('Community name is required');
      }

      if (data.name.length > 100) {
        throw new InvalidCommunityDataError(
          'Community name too long (max 100 characters)'
        );
      }

      if (data.description && data.description.length > 1000) {
        throw new InvalidCommunityDataError(
          'Description too long (max 1000 characters)'
        );
      }

      // Generate unique slug
      const slug = data.slug || (await this.generateUniqueSlug(data.name));

      // Validate cultural settings if provided
      if (data.culturalSettings) {
        try {
          JSON.parse(data.culturalSettings);
        } catch {
          throw new InvalidCommunityDataError(
            'Invalid cultural settings JSON format'
          );
        }
      }

      // Prepare community data
      const communityData: NewCommunity = {
        name: data.name.trim(),
        description: data.description?.trim() || null,
        slug,
        publicStories: data.publicStories ?? false,
        locale: data.locale || 'en',
        culturalSettings: data.culturalSettings || null,
        isActive: data.isActive ?? true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // Create community
      const result = await this.db
        .insert(communities)
        .values(communityData)
        .returning();

      if (result.length === 0) {
        throw new Error('Failed to create community');
      }

      return result[0];
    } catch (error) {
      if (error instanceof InvalidCommunityDataError) {
        throw error;
      }

      // Handle database constraint violations
      if (error instanceof Error) {
        if (
          error.message.includes('UNIQUE constraint') ||
          error.message.includes('unique constraint')
        ) {
          throw new DuplicateSlugError(`Community slug already exists`);
        }
      }

      throw new Error(
        `Failed to create community: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Find community by ID
   * @param id - Community ID
   * @returns Promise<Community | null> - Community or null if not found
   */
  async findById(id: number): Promise<Community | null> {
    try {
      const communities = communitiesSqlite;

      const result = await this.db
        .select()
        .from(communities)
        .where(eq(communities.id, id))
        .limit(1);

      return result.length > 0 ? result[0] : null;
    } catch (error) {
      throw new Error(
        `Failed to find community by ID: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Find community by slug
   * @param slug - Community slug
   * @returns Promise<Community | null> - Community or null if not found
   */
  async findBySlug(slug: string): Promise<Community | null> {
    try {
      const communities = communitiesSqlite;

      const result = await this.db
        .select()
        .from(communities)
        .where(eq(communities.slug, slug))
        .limit(1);

      return result.length > 0 ? result[0] : null;
    } catch (error) {
      throw new Error(
        `Failed to find community by slug: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Search communities with filters
   * @param params - Search parameters
   * @returns Promise<Community[]> - Array of matching communities
   */
  async search(params: CommunitySearchParams = {}): Promise<Community[]> {
    try {
      const communities = communitiesSqlite;
      const { query, locale, isActive, limit = 50, offset = 0 } = params;

      // Build where conditions
      const conditions = [];

      // Search query across name and description
      if (query?.trim()) {
        const searchTerm = `%${query.trim()}%`;
        conditions.push(
          or(
            like(communities.name, searchTerm),
            like(communities.description, searchTerm)
          )
        );
      }

      // Filter by locale
      if (locale) {
        conditions.push(eq(communities.locale, locale));
      }

      // Filter by active status
      if (isActive !== undefined) {
        conditions.push(eq(communities.isActive, isActive));
      }

      // Execute query with pagination
      const whereClause =
        conditions.length > 0 ? and(...conditions) : undefined;

      const result = await this.db
        .select()
        .from(communities)
        .where(whereClause)
        .orderBy(desc(communities.createdAt))
        .limit(limit)
        .offset(offset);

      return result;
    } catch (error) {
      throw new Error(
        `Failed to search communities: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Get all active communities
   * @param limit - Maximum number of communities to return
   * @param offset - Number of communities to skip
   * @returns Promise<Community[]> - Array of active communities
   */
  async findAllActive(limit = 50, offset = 0): Promise<Community[]> {
    return this.search({ isActive: true, limit, offset });
  }

  /**
   * Update community by ID
   * @param id - Community ID
   * @param updates - Partial community data to update
   * @returns Promise<Community | null> - Updated community or null if not found
   */
  async update(
    id: number,
    updates: UpdateCommunityData
  ): Promise<Community | null> {
    try {
      const communities = communitiesSqlite;

      // Check if community exists
      const existingCommunity = await this.findById(id);
      if (!existingCommunity) {
        throw new CommunityNotFoundError();
      }

      // Validate updates
      if (updates.name !== undefined) {
        if (!updates.name?.trim()) {
          throw new InvalidCommunityDataError('Community name cannot be empty');
        }
        if (updates.name.length > 100) {
          throw new InvalidCommunityDataError(
            'Community name too long (max 100 characters)'
          );
        }
      }

      if (
        updates.description !== undefined &&
        updates.description &&
        updates.description.length > 1000
      ) {
        throw new InvalidCommunityDataError(
          'Description too long (max 1000 characters)'
        );
      }

      if (updates.culturalSettings) {
        try {
          JSON.parse(updates.culturalSettings);
        } catch {
          throw new InvalidCommunityDataError(
            'Invalid cultural settings JSON format'
          );
        }
      }

      // Prepare update data
      const updateData = {
        ...updates,
        updatedAt: new Date(),
      };

      // If name is being updated, regenerate slug
      if (updates.name && updates.name.trim() !== existingCommunity.name) {
        updateData.name = updates.name.trim();
      }

      // Remove undefined values
      const cleanUpdateData = Object.fromEntries(
        Object.entries(updateData).filter(([_, value]) => value !== undefined)
      );

      // Update community
      const result = await this.db
        .update(communities)
        .set(cleanUpdateData)
        .where(eq(communities.id, id))
        .returning();

      return result.length > 0 ? result[0] : null;
    } catch (error) {
      if (
        error instanceof CommunityNotFoundError ||
        error instanceof InvalidCommunityDataError
      ) {
        throw error;
      }

      throw new Error(
        `Failed to update community: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Delete community by ID
   * Note: This should be used with caution as it may affect related data
   * @param id - Community ID
   * @returns Promise<boolean> - True if deleted, false if not found
   */
  async delete(id: number): Promise<boolean> {
    try {
      const communities = communitiesSqlite;

      // Check if community exists
      const existingCommunity = await this.findById(id);
      if (!existingCommunity) {
        return false;
      }

      // Delete community (CASCADE should handle related data)
      const result = await this.db
        .delete(communities)
        .where(eq(communities.id, id))
        .returning();

      return result.length > 0;
    } catch (error) {
      // Handle foreign key constraint errors
      if (error instanceof Error && error.message.includes('FOREIGN KEY')) {
        throw new InvalidCommunityDataError(
          'Cannot delete community with existing users, stories, or other associated data'
        );
      }

      throw new Error(
        `Failed to delete community: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Get community count with optional filters
   * @param isActive - Filter by active status
   * @returns Promise<number> - Number of communities
   */
  async count(isActive?: boolean): Promise<number> {
    try {
      const communities = communitiesSqlite;

      const conditions = [];
      if (isActive !== undefined) {
        conditions.push(eq(communities.isActive, isActive));
      }

      const whereClause =
        conditions.length > 0 ? and(...conditions) : undefined;

      const result = await this.db
        .select({ count: count() })
        .from(communities)
        .where(whereClause);

      return result[0]?.count || 0;
    } catch (error) {
      throw new Error(
        `Failed to count communities: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Check if a community slug is available
   * @param slug - Slug to check
   * @param excludeId - Community ID to exclude from check
   * @returns Promise<boolean> - True if slug is available
   */
  async isSlugAvailable(slug: string, excludeId?: number): Promise<boolean> {
    try {
      const communities = communitiesSqlite;

      const conditions = [eq(communities.slug, slug)];
      if (excludeId) {
        conditions.push(sql`${communities.id} != ${excludeId}`);
      }

      const result = await this.db
        .select({ id: communities.id })
        .from(communities)
        .where(and(...conditions))
        .limit(1);

      return result.length === 0;
    } catch (error) {
      throw new Error(
        `Failed to check slug availability: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Soft delete community (mark as inactive)
   * @param id - Community ID
   * @returns Promise<boolean> - True if deactivated, false if not found
   */
  async deactivate(id: number): Promise<boolean> {
    try {
      const updated = await this.update(id, { isActive: false });
      return updated !== null;
    } catch (error) {
      if (error instanceof CommunityNotFoundError) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Reactivate community
   * @param id - Community ID
   * @returns Promise<boolean> - True if reactivated, false if not found
   */
  async reactivate(id: number): Promise<boolean> {
    try {
      const updated = await this.update(id, { isActive: true });
      return updated !== null;
    } catch (error) {
      if (error instanceof CommunityNotFoundError) {
        return false;
      }
      throw error;
    }
  }
}
