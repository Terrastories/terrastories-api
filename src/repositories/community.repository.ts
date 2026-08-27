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
import { communitiesSqlite, communitiesPg } from '../db/schema/index.js';
import type { Community } from '../db/schema/communities.js';
import type { Database } from '../db/index.js';

export type { Community } from '../db/schema/communities.js';

export interface CreateCommunityData {
  name: string;
  description?: string;
  slug?: string;
  publicStories?: boolean;
  locale?: string;
  culturalSettings?: string;
  isActive?: boolean;
  country?: string;
  beta?: boolean;
}

export interface UpdateCommunityData {
  name?: string;
  description?: string;
  publicStories?: boolean;
  locale?: string;
  culturalSettings?: string;
  isActive?: boolean;
  updatedAt?: Date;
  country?: string;
  beta?: boolean;
}

export interface CommunitySearchParams {
  query?: string;
  locale?: string;
  isActive?: boolean;
  limit?: number;
  offset?: number;
  country?: string;
  beta?: boolean;
}

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

export class CommunityRepository {
  constructor(private database: Database) {}

  private get communities() {
    return 'execute' in this.database ? communitiesPg : communitiesSqlite;
  }

  private get db() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- cross-dialect Drizzle query interfaces are behaviorally equivalent here.
    return this.database as any;
  }

  private async generateUniqueSlug(
    name: string,
    excludeId?: number
  ): Promise<string> {
    let baseSlug = name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/[\s]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

    if (baseSlug.length < 3) {
      baseSlug = `community-${baseSlug}`;
    }

    let slug = baseSlug;
    let counter = 1;

    while (true) {
      const conditions = [eq(this.communities.slug, slug)];
      if (excludeId) {
        conditions.push(sql`${this.communities.id} != ${excludeId}`);
      }

      const existing = await this.db
        .select({ id: this.communities.id })
        .from(this.communities)
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

  async create(data: CreateCommunityData): Promise<Community> {
    try {
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

      const slug = data.slug || (await this.generateUniqueSlug(data.name));

      if (data.culturalSettings) {
        try {
          JSON.parse(data.culturalSettings);
        } catch {
          throw new InvalidCommunityDataError(
            'Invalid cultural settings JSON format'
          );
        }
      }

      const communityData = {
        name: data.name.trim(),
        description: data.description?.trim() || null,
        slug,
        publicStories: data.publicStories ?? false,
        locale: data.locale || 'en',
        culturalSettings: data.culturalSettings || null,
        isActive: data.isActive ?? true,
        country: data.country ?? null,
        beta: data.beta ?? false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const result = await this.db
        .insert(this.communities)
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

  async findById(id: number): Promise<Community | null> {
    try {
      const result = await this.db
        .select()
        .from(this.communities)
        .where(eq(this.communities.id, id))
        .limit(1);

      return result.length > 0 ? result[0] : null;
    } catch (error) {
      throw new Error(
        `Failed to find community by ID: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  async findBySlug(slug: string): Promise<Community | null> {
    try {
      const result = await this.db
        .select()
        .from(this.communities)
        .where(eq(this.communities.slug, slug))
        .limit(1);

      return result.length > 0 ? result[0] : null;
    } catch (error) {
      throw new Error(
        `Failed to find community by slug: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  async search(params: CommunitySearchParams = {}): Promise<Community[]> {
    try {
      const {
        query,
        locale,
        isActive,
        country,
        beta,
        limit = 50,
        offset = 0,
      } = params;

      const conditions = [];

      if (query?.trim()) {
        const searchTerm = `%${query.trim()}%`;
        conditions.push(
          or(
            like(this.communities.name, searchTerm),
            like(this.communities.description, searchTerm)
          )
        );
      }

      if (locale) {
        conditions.push(eq(this.communities.locale, locale));
      }

      if (isActive !== undefined) {
        conditions.push(eq(this.communities.isActive, isActive));
      }

      if (country) {
        conditions.push(eq(this.communities.country, country));
      }

      if (beta !== undefined) {
        conditions.push(eq(this.communities.beta, beta));
      }

      const whereClause =
        conditions.length > 0 ? and(...conditions) : undefined;

      const result = await this.db
        .select()
        .from(this.communities)
        .where(whereClause)
        .orderBy(desc(this.communities.createdAt))
        .limit(limit)
        .offset(offset);

      return result;
    } catch (error) {
      throw new Error(
        `Failed to search communities: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  async findAllActive(limit = 50, offset = 0): Promise<Community[]> {
    return this.search({ isActive: true, limit, offset });
  }

  async update(
    id: number,
    updates: UpdateCommunityData
  ): Promise<Community | null> {
    try {
      const existingCommunity = await this.findById(id);
      if (!existingCommunity) {
        throw new CommunityNotFoundError();
      }

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

      const updateData = {
        ...updates,
        updatedAt: new Date(),
      };

      if (updates.name && updates.name.trim() !== existingCommunity.name) {
        updateData.name = updates.name.trim();
      }

      const cleanUpdateData = Object.fromEntries(
        Object.entries(updateData).filter(([_, value]) => value !== undefined)
      );

      const result = await this.db
        .update(this.communities)
        .set(cleanUpdateData)
        .where(eq(this.communities.id, id))
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

  async delete(id: number): Promise<boolean> {
    try {
      const existingCommunity = await this.findById(id);
      if (!existingCommunity) {
        return false;
      }

      const result = await this.db
        .delete(this.communities)
        .where(eq(this.communities.id, id))
        .returning();

      return result.length > 0;
    } catch (error) {
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

  async count(isActive?: boolean): Promise<number> {
    try {
      const conditions = [];
      if (isActive !== undefined) {
        conditions.push(eq(this.communities.isActive, isActive));
      }

      const whereClause =
        conditions.length > 0 ? and(...conditions) : undefined;

      const result = await this.db
        .select({ count: count() })
        .from(this.communities)
        .where(whereClause);

      return result[0]?.count || 0;
    } catch (error) {
      throw new Error(
        `Failed to count communities: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  async isSlugAvailable(slug: string, excludeId?: number): Promise<boolean> {
    try {
      const conditions = [eq(this.communities.slug, slug)];
      if (excludeId) {
        conditions.push(sql`${this.communities.id} != ${excludeId}`);
      }

      const result = await this.db
        .select({ id: this.communities.id })
        .from(this.communities)
        .where(and(...conditions))
        .limit(1);

      return result.length === 0;
    } catch (error) {
      throw new Error(
        `Failed to check slug availability: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

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
