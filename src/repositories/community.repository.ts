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

import { eq, and, like, desc, or, sql, count, ne } from 'drizzle-orm';
import {
  communitiesSqlite,
  communitiesPg,
  filesPg,
  filesSqlite,
  placesPg,
  placesSqlite,
  speakersPg,
  speakersSqlite,
  storiesPg,
  storiesSqlite,
  themesPg,
  themesSqlite,
  usersPg,
  usersSqlite,
} from '../db/schema/index.js';
import type { CommunityClaimState } from '../shared/authorization/administrative-policy.js';
import type { Community } from '../db/schema/communities.js';
import type { Database } from '../db/index.js';

// Re-export Community type for other modules
export type { Community } from '../db/schema/communities.js';

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
  // Rails compatibility fields
  country?: string;
  beta?: boolean;
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
  // Rails compatibility fields
  country?: string;
  beta?: boolean;
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
  // Rails compatibility filters
  country?: string;
  beta?: boolean;
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
  constructor(private database: Database) {}

  private get communities() {
    // Determine which schema to use based on database type
    // This is a runtime check to use the correct schema
    return 'execute' in this.database ? communitiesPg : communitiesSqlite;
  }

  // Type-safe database query wrapper - cast to any to handle union type
  private get db() {
    // Cast to any to resolve union type issues
    // This is safe because both drizzle instances have compatible query interfaces
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- #135 will replace this cross-dialect Drizzle union cast with backend-specific integration typing.
    return this.database as any;
  }

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

  /**
   * Create a new community
   * @param data - Community creation data
   * @returns Promise<Community> - Created community
   */
  async create(data: CreateCommunityData): Promise<Community> {
    try {
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

      // Country validation handled by Zod schema at service layer

      // Rails country/beta persistence is intentionally deferred to #135.
      // Keep the current insert shape limited to columns present in both schemas.
      const communityData = {
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

  /**
   * Find community by slug
   * @param slug - Community slug
   * @returns Promise<Community | null> - Community or null if not found
   */
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

  /**
   * Search communities with filters
   * @param params - Search parameters
   * @returns Promise<Community[]> - Array of matching communities
   */
  async search(params: CommunitySearchParams = {}): Promise<Community[]> {
    try {
      const {
        query,
        locale,
        isActive,
        country: _country,
        beta: _beta,
        limit = 50,
        offset = 0,
      } = params;

      // Build where conditions
      const conditions = [];

      // Search query across name and description
      if (query?.trim()) {
        const searchTerm = `%${query.trim()}%`;
        conditions.push(
          or(
            like(this.communities.name, searchTerm),
            like(this.communities.description, searchTerm)
          )
        );
      }

      // Filter by locale
      if (locale) {
        conditions.push(eq(this.communities.locale, locale));
      }

      // Filter by active status
      if (isActive !== undefined) {
        conditions.push(eq(this.communities.isActive, isActive));
      }

      // Filter by country - commented out until database migration is complete
      // if (country) {
      //   conditions.push(eq(this.communities.country, country));
      // }

      // Filter by beta status - commented out until database migration is complete
      // if (beta !== undefined) {
      //   conditions.push(eq(this.communities.beta, beta));
      // }

      // Execute query with pagination
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
   * Discoverable communities for the unauthenticated public/v1 community
   * surfaces (SPEC-V2 §4/§6.1): public (`publicStories = true`) AND active
   * (`isActive = true`) only, optionally widened to one viewer's own
   * active-but-private community. `viewerCommunityId` must be null for
   * anonymous callers and for `super_admin` sessions (no widening on these
   * routes). This is the SQL transcription of `canDiscoverCommunity`
   * (sovereignty-policy); the two must stay in sync. The gate filters at the
   * database level before pagination and totals so lists and `total` always
   * agree. Works on both SQLite and PostgreSQL via the dialect-aware
   * `communities` getter.
   *
   * @param params.query - Optional name/description search term
   * @param params.locale - Optional locale filter
   * @param params.viewerCommunityId - Same-community widening, or null
   * @param params.limit - Maximum number of communities to return
   * @param params.offset - Number of communities to skip
   * @returns Promise<{ communities: Community[]; total: number }> - Gated page and full gated count
   */
  async findDiscoverable(params: {
    query?: string;
    locale?: string;
    viewerCommunityId?: number | null;
    limit?: number;
    offset?: number;
  }): Promise<{ communities: Community[]; total: number }> {
    try {
      const {
        query,
        locale,
        viewerCommunityId = null,
        limit = 50,
        offset = 0,
      } = params;

      const conditions = [
        // §6.1 status gate: disabled communities close every public path.
        eq(this.communities.isActive, true),
        // §4/§6.1 visibility gate: private communities are discoverable
        // only by their own members (same-community widening).
        viewerCommunityId !== null
          ? or(
              eq(this.communities.publicStories, true),
              eq(this.communities.id, viewerCommunityId)
            )
          : eq(this.communities.publicStories, true),
      ];

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

      const whereClause = and(...conditions);

      const [communities, totalRows] = await Promise.all([
        this.db
          .select()
          .from(this.communities)
          .where(whereClause)
          .orderBy(desc(this.communities.createdAt))
          .limit(limit)
          .offset(offset),
        this.db
          .select({ count: count() })
          .from(this.communities)
          .where(whereClause),
      ]);

      return { communities, total: Number(totalRows[0]?.count || 0) };
    } catch (error) {
      throw new Error(
        `Failed to find discoverable communities: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
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

      // Country validation handled by Zod schema at service layer

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

  /**
   * Delete community by ID
   * Note: This should be used with caution as it may affect related data
   * @param id - Community ID
   * @returns Promise<boolean> - True if deleted, false if not found
   */
  async delete(id: number): Promise<boolean> {
    try {
      // Check if community exists
      const existingCommunity = await this.findById(id);
      if (!existingCommunity) {
        return false;
      }

      // Delete community (CASCADE should handle related data)
      const result = await this.db
        .delete(this.communities)
        .where(eq(this.communities.id, id))
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

  /**
   * SPEC-V2 §7 claim state: whether the community has any community account
   * (any role except a system `super_admin` row, any status) and whether it
   * holds community content (stories, places, speakers or files). A system
   * lifecycle action may provision a first administrator only when both are
   * false.
   */
  async getClaimState(communityId: number): Promise<CommunityClaimState> {
    const { users, content } = this.claimTables();
    const [accounts] = await this.accountCountQuery(
      this.db,
      users,
      communityId
    );
    let hasContent = false;
    for (const table of content) {
      const [rows] = await this.contentCountQuery(this.db, table, communityId);
      if (Number(rows?.count ?? 0) > 0) {
        hasContent = true;
        break;
      }
    }
    return {
      hasCommunityAccounts: Number(accounts?.count ?? 0) > 0,
      hasContent,
    };
  }

  /**
   * SPEC-V2 §7 first-administrator provisioning, atomic with its claim
   * check. The claim state is re-read and the account inserted inside one
   * write transaction, so concurrent requests cannot all pass the check:
   *
   * - PostgreSQL: the community row is locked `FOR UPDATE`; a concurrent
   *   provisioning waits, then re-reads the committed account and refuses.
   * - SQLite: a synchronous `BEGIN IMMEDIATE` transaction takes the write
   *   lock before reading, so no other writer (connection or interleaved
   *   request) runs between the check and the insert.
   *
   * Returns the created account, or null when the community already has a
   * community account or holds content.
   */
  async provisionFirstAdministrator(
    values: Record<string, unknown> & { communityId: number }
  ): Promise<Record<string, unknown> | null> {
    const { users, content } = this.claimTables();
    const communityId = values.communityId;
    const isClaimed = (accounts: number, contentCounts: number[]) =>
      accounts > 0 || contentCounts.some((rows) => rows > 0);

    if ('execute' in this.database) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dialect union, see `db` above (#135).
      return this.db.transaction(async (tx: any) => {
        const locked = await tx
          .select({ id: this.communities.id })
          .from(this.communities)
          .where(eq(this.communities.id, communityId))
          .for('update');
        if (locked.length === 0) {
          return null;
        }
        const [accounts] = await this.accountCountQuery(tx, users, communityId);
        const contentCounts: number[] = [];
        for (const table of content) {
          const [rows] = await this.contentCountQuery(tx, table, communityId);
          contentCounts.push(Number(rows?.count ?? 0));
        }
        if (isClaimed(Number(accounts?.count ?? 0), contentCounts)) {
          return null;
        }
        const [created] = await tx.insert(users).values(values).returning();
        return created ?? null;
      });
    }

    return this.db.transaction(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dialect union, see `db` above (#135).
      (tx: any) => {
        const [accounts] = this.accountCountQuery(tx, users, communityId).all();
        const contentCounts = content.map((table) =>
          Number(
            this.contentCountQuery(tx, table, communityId).all()[0]?.count ?? 0
          )
        );
        if (isClaimed(Number(accounts?.count ?? 0), contentCounts)) {
          return null;
        }
        return tx.insert(users).values(values).returning().get() ?? null;
      },
      { behavior: 'immediate' }
    );
  }

  /** Tables that make up the §7 claim state, for the active dialect. */
  private claimTables() {
    const isPg = 'execute' in this.database;
    return {
      users: isPg ? usersPg : usersSqlite,
      // Every community-owned content table. Story/place/speaker joins carry
      // no community column and only exist alongside these rows.
      content: isPg
        ? [storiesPg, placesPg, speakersPg, filesPg, themesPg]
        : [
            storiesSqlite,
            placesSqlite,
            speakersSqlite,
            filesSqlite,
            themesSqlite,
          ],
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dialect union, see `db` above (#135).
  private accountCountQuery(executor: any, users: any, communityId: number) {
    return executor
      .select({ count: count() })
      .from(users)
      .where(
        and(eq(users.communityId, communityId), ne(users.role, 'super_admin'))
      );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dialect union, see `db` above (#135).
  private contentCountQuery(executor: any, table: any, communityId: number) {
    return executor
      .select({ count: count() })
      .from(table)
      .where(eq(table.communityId, communityId));
  }

  /**
   * Check if a community slug is available
   * @param slug - Slug to check
   * @param excludeId - Community ID to exclude from check
   * @returns Promise<boolean> - True if slug is available
   */
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
