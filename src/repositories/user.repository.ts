/**
 * User Repository
 *
 * Database operations for user management with community scoping.
 * Handles CRUD operations while enforcing multi-tenant data isolation
 * for Indigenous community data sovereignty.
 *
 * Features:
 * - Community-scoped operations for data sovereignty
 * - Email uniqueness within communities
 * - Multi-database compatibility (PostgreSQL/SQLite)
 * - Comprehensive error handling
 * - Pagination and filtering support
 */

import { eq, and, like, desc, asc, count, or, sql } from 'drizzle-orm';
import { getUsersTable, type User, type NewUser } from '../db/schema/users.js';
import { getCommunitiesTable } from '../db/schema/communities.js';

/**
 * Options for listing users with filtering and pagination
 */
export interface UserListOptions {
  page?: number;
  limit?: number;
  search?: string;
  role?: 'super_admin' | 'admin' | 'editor' | 'viewer';
  isActive?: boolean;
  orderBy?: 'createdAt' | 'updatedAt' | 'email' | 'firstName' | 'lastName';
  orderDirection?: 'asc' | 'desc';
}

/**
 * Paginated result structure
 */
export interface PaginatedResult<T> {
  data: T[];
  meta: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
}

/**
 * Repository for user database operations with community scoping
 *
 * All operations enforce community-level data isolation to ensure
 * Indigenous communities maintain sovereignty over their data.
 */
export class UserRepository {
  constructor(private database: unknown) {}

  /**
   * Create a new user within a specific community
   *
   * @param userData - User data to create
   * @returns Created user
   * @throws Error if email already exists in community or community is invalid
   */
  async create(userData: NewUser): Promise<User> {
    try {
      const usersTable = await getUsersTable();

      // Check if email already exists in this community
      const existingUser = await this.findByEmail(
        userData.email,
        userData.communityId
      );
      if (existingUser) {
        throw new Error(
          'User with this email already exists in this community'
        );
      }

      // Verify community exists
      const communitiesTable = await getCommunitiesTable();
      const [community] = await this.database
        .select()
        .from(communitiesTable)
        .where(eq(communitiesTable.id, userData.communityId))
        .limit(1);

      if (!community) {
        throw new Error('Invalid community ID');
      }

      // Create user
      const [createdUser] = await this.database
        .insert(usersTable)
        .values({
          ...userData,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning();

      return createdUser;
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      if (errorMessage.includes('User with this email already exists')) {
        throw error;
      }
      throw new Error(`Failed to create user: ${errorMessage}`);
    }
  }

  /**
   * Find user by ID within a specific community
   *
   * @param id - User ID
   * @param communityId - Community ID for scoping
   * @returns User if found and belongs to community, null otherwise
   */
  async findById(id: number, communityId: number): Promise<User | null> {
    try {
      const usersTable = await getUsersTable();

      const [user] = await this.database
        .select()
        .from(usersTable)
        .where(
          and(eq(usersTable.id, id), eq(usersTable.communityId, communityId))
        )
        .limit(1);

      return user || null;
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to find user: ${errorMessage}`);
    }
  }

  /**
   * Find user by email within a specific community
   *
   * @param email - User email
   * @param communityId - Community ID for scoping
   * @returns User if found and belongs to community, null otherwise
   */
  async findByEmail(email: string, communityId: number): Promise<User | null> {
    try {
      const usersTable = await getUsersTable();

      const [user] = await this.database
        .select()
        .from(usersTable)
        .where(
          and(
            eq(usersTable.email, email.toLowerCase().trim()),
            eq(usersTable.communityId, communityId)
          )
        )
        .limit(1);

      return user || null;
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to find user by email: ${errorMessage}`);
    }
  }

  /**
   * Update user within a specific community
   *
   * @param id - User ID
   * @param updates - Partial user data to update
   * @param communityId - Community ID for scoping
   * @returns Updated user if found and updated, null otherwise
   */
  async update(
    id: number,
    updates: Partial<NewUser>,
    communityId: number
  ): Promise<User | null> {
    try {
      const usersTable = await getUsersTable();

      // If email is being updated, check for duplicates in the community
      if (updates.email) {
        const existingUser = await this.findByEmail(updates.email, communityId);
        if (existingUser && existingUser.id !== id) {
          throw new Error(
            'User with this email already exists in this community'
          );
        }
      }

      const [updatedUser] = await this.database
        .update(usersTable)
        .set({
          ...updates,
          email: updates.email?.toLowerCase().trim(),
          updatedAt: new Date(),
        })
        .where(
          and(eq(usersTable.id, id), eq(usersTable.communityId, communityId))
        )
        .returning();

      return updatedUser || null;
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      if (errorMessage.includes('User with this email already exists')) {
        throw error;
      }
      throw new Error(`Failed to update user: ${errorMessage}`);
    }
  }

  /**
   * Delete user within a specific community
   *
   * @param id - User ID
   * @param communityId - Community ID for scoping
   * @returns True if deleted, false if not found
   */
  async delete(id: number, communityId: number): Promise<boolean> {
    try {
      const usersTable = await getUsersTable();

      const [deletedUser] = await this.database
        .delete(usersTable)
        .where(
          and(eq(usersTable.id, id), eq(usersTable.communityId, communityId))
        )
        .returning();

      return !!deletedUser;
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to delete user: ${errorMessage}`);
    }
  }

  /**
   * List users with filtering and pagination within a specific community
   *
   * @param options - Filtering and pagination options
   * @param communityId - Community ID for scoping
   * @returns Paginated list of users
   */
  async findMany(
    options: UserListOptions,
    communityId: number
  ): Promise<PaginatedResult<User>> {
    try {
      const usersTable = await getUsersTable();
      const {
        page = 1,
        limit = 20,
        search,
        role,
        isActive,
        orderBy = 'createdAt',
        orderDirection = 'desc',
      } = options;

      const offset = (page - 1) * limit;

      // Build where conditions
      const whereConditions = [eq(usersTable.communityId, communityId)];

      if (search) {
        // Use case-insensitive search that works with both PostgreSQL and SQLite
        const searchTerm = search.toLowerCase();
        whereConditions.push(
          or(
            like(sql`lower(${usersTable.firstName})`, `%${searchTerm}%`),
            like(sql`lower(${usersTable.lastName})`, `%${searchTerm}%`),
            like(sql`lower(${usersTable.email})`, `%${searchTerm}%`)
          )!
        );
      }

      if (role) {
        whereConditions.push(eq(usersTable.role, role));
      }

      if (isActive !== undefined) {
        whereConditions.push(eq(usersTable.isActive, isActive));
      }

      // Build order by
      const orderColumn = usersTable[orderBy] || usersTable.createdAt;
      const orderFn = orderDirection === 'desc' ? desc : asc;

      // Get users and count in parallel
      const [users, [countResult]] = await Promise.all([
        this.database
          .select()
          .from(usersTable)
          .where(and(...whereConditions))
          .orderBy(orderFn(orderColumn))
          .limit(limit)
          .offset(offset),
        this.database
          .select({ count: count() })
          .from(usersTable)
          .where(and(...whereConditions)),
      ]);

      const total = Number(countResult.count);
      const totalPages = Math.ceil(total / limit);

      return {
        data: users,
        meta: {
          page,
          limit,
          total,
          totalPages,
          hasNext: page < totalPages,
          hasPrev: page > 1,
        },
      };
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to list users: ${errorMessage}`);
    }
  }

  /**
   * Check if a user exists within a specific community
   *
   * @param id - User ID
   * @param communityId - Community ID for scoping
   * @returns True if user exists in community, false otherwise
   */
  async exists(id: number, communityId: number): Promise<boolean> {
    try {
      const user = await this.findById(id, communityId);
      return !!user;
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to check user existence: ${errorMessage}`);
    }
  }

  /**
   * Count users within a specific community
   *
   * @param communityId - Community ID for scoping
   * @param filters - Optional filters (role, isActive)
   * @returns Number of users matching criteria
   */
  async count(
    communityId: number,
    filters: { role?: string; isActive?: boolean } = {}
  ): Promise<number> {
    try {
      const usersTable = await getUsersTable();

      const whereConditions = [eq(usersTable.communityId, communityId)];

      if (filters.role) {
        whereConditions.push(eq(usersTable.role, filters.role));
      }

      if (filters.isActive !== undefined) {
        whereConditions.push(eq(usersTable.isActive, filters.isActive));
      }

      const [result] = await this.database
        .select({ count: count() })
        .from(usersTable)
        .where(and(...whereConditions));

      return Number(result.count);
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to count users: ${errorMessage}`);
    }
  }
}
