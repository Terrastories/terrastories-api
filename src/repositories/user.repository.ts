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
import {
  getUsersTable,
  type User,
  type NewUser,
  type UserRole,
} from '../db/schema/users.js';
import {
  getCommunitiesTable,
  type Community,
} from '../db/schema/communities.js';

// Database type - using any temporarily to resolve union type incompatibility
// TODO: Implement proper database abstraction layer for SQLite/PostgreSQL compatibility
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DatabaseType = any;

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
  constructor(private database: DatabaseType) {}

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
      const communities = await this.database
        .select()
        .from(communitiesTable)
        .where(eq(communitiesTable.id, userData.communityId))
        .limit(1);
      const community = communities[0] as Community | undefined;

      if (!community) {
        throw new Error('Invalid community ID');
      }

      // Create user
      const createdUsers = await this.database
        .insert(usersTable)
        .values({
          ...userData,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning();
      const createdUser = createdUsers[0] as User;

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

      const users = await this.database
        .select()
        .from(usersTable)
        .where(
          and(eq(usersTable.id, id), eq(usersTable.communityId, communityId))
        )
        .limit(1);
      const user = users[0] as User | undefined;

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

      const users = await this.database
        .select()
        .from(usersTable)
        .where(
          and(
            eq(usersTable.email, email.toLowerCase().trim()),
            eq(usersTable.communityId, communityId)
          )
        )
        .limit(1);
      const user = users[0] as User | undefined;

      return user || null;
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to find user by email: ${errorMessage}`);
    }
  }

  /**
   * Find user by email globally (across all communities)
   * Used for simplified login where community scope is not required
   *
   * @param email - User email
   * @returns User if found, null otherwise
   */
  async findByEmailGlobal(email: string): Promise<User | null> {
    try {
      const usersTable = await getUsersTable();

      const users = await this.database
        .select()
        .from(usersTable)
        .where(eq(usersTable.email, email.toLowerCase().trim()))
        .limit(1);
      const user = users[0] as User | undefined;

      return user || null;
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to find user by email globally: ${errorMessage}`);
    }
  }

  /**
   * Find user by reset password token within a specific community
   * TEMPORARILY COMMENTED OUT - waiting for database migration completion
   * @param resetToken - Password reset token
   * @param communityId - Community ID to scope the search
   * @returns User with matching reset token within community, or null if not found
   */
  // async findByResetToken(
  //   resetToken: string,
  //   communityId: number
  // ): Promise<User | null> {
  //   const usersTable = await getUsersTable();

  //   try {
  //     const [result] = await this.database
  //       .select()
  //       .from(usersTable)
  //       .where(
  //         and(
  //           eq(usersTable.resetPasswordToken, resetToken),
  //           eq(usersTable.communityId, communityId)
  //         )
  //       )
  //       .limit(1);

  //     return result ? result : null;
  //   } catch (error) {
  //     throw new Error(`Failed to find user by reset token: ${error}`);
  //   }
  // }

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

      const updatedUsers = await this.database
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
      const updatedUser = updatedUsers[0] as User | undefined;

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

      const deletedUsers = await this.database
        .delete(usersTable)
        .where(
          and(eq(usersTable.id, id), eq(usersTable.communityId, communityId))
        )
        .returning();
      const deletedUser = deletedUsers[0] as User | undefined;

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
      const [users, countResults] = await Promise.all([
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
      const countResult = countResults[0] as { count: number };

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
        whereConditions.push(eq(usersTable.role, filters.role as User['role']));
      }

      if (filters.isActive !== undefined) {
        whereConditions.push(eq(usersTable.isActive, filters.isActive));
      }

      const results = await this.database
        .select({ count: count() })
        .from(usersTable)
        .where(and(...whereConditions));
      const result = results[0] as { count: number };

      return Number(result.count);
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to count users: ${errorMessage}`);
    }
  }

  /**
   * Super Admin Methods - Cross-community operations
   */

  /**
   * Search users across all communities (super admin only)
   * @param options - Search and filter options
   * @returns Promise<User[]> - Array of users across communities
   */
  async searchUsers(options: {
    limit?: number;
    offset?: number;
    communityId?: number;
    role?: UserRole;
    search?: string;
    isActive?: boolean;
  }): Promise<(User & { communityName?: string })[]> {
    try {
      const usersTable = await getUsersTable();
      const communitiesTable = await getCommunitiesTable();
      const {
        limit = 20,
        offset = 0,
        communityId,
        role,
        search,
        isActive,
      } = options;

      // Build where conditions (no community restriction for super admin)
      const whereConditions = [];

      if (communityId) {
        whereConditions.push(eq(usersTable.communityId, communityId));
      }

      if (search) {
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

      // Execute query with LEFT JOIN to get community names in one query
      let query = this.database
        .select({
          id: usersTable.id,
          firstName: usersTable.firstName,
          lastName: usersTable.lastName,
          email: usersTable.email,
          role: usersTable.role,
          communityId: usersTable.communityId,
          isActive: usersTable.isActive,
          createdAt: usersTable.createdAt,
          updatedAt: usersTable.updatedAt,
          communityName: communitiesTable.name,
        })
        .from(usersTable)
        .leftJoin(
          communitiesTable,
          eq(usersTable.communityId, communitiesTable.id)
        )
        .orderBy(desc(usersTable.createdAt))
        .limit(limit)
        .offset(offset);

      if (whereConditions.length > 0) {
        query = query.where(and(...whereConditions));
      }

      const users = await query;
      return users;
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to search users: ${errorMessage}`);
    }
  }

  /**
   * Count users across all communities (super admin only)
   * @param options - Filter options
   * @returns Promise<number> - Total count of users
   */
  async countUsers(options: {
    communityId?: number;
    role?: UserRole;
    search?: string;
    isActive?: boolean;
  }): Promise<number> {
    try {
      const usersTable = await getUsersTable();
      const { communityId, role, search, isActive } = options;

      // Build where conditions (no community restriction for super admin)
      const whereConditions = [];

      if (communityId) {
        whereConditions.push(eq(usersTable.communityId, communityId));
      }

      if (search) {
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

      // Execute count query
      let query = this.database.select({ count: count() }).from(usersTable);

      if (whereConditions.length > 0) {
        query = query.where(and(...whereConditions));
      }

      const countResults = await query;
      const countResult = countResults[0] as { count: number };
      return Number(countResult.count);
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to count users: ${errorMessage}`);
    }
  }

  /**
   * Count users by community ID for super admin operations
   */
  async countUsersByCommunity(communityId: number): Promise<number> {
    try {
      const usersTable = await getUsersTable();

      // Execute count query
      const query = this.database
        .select({ count: count() })
        .from(usersTable)
        .where(eq(usersTable.communityId, communityId));

      const countResults = await query;
      const countResult = countResults[0] as { count: number };
      return Number(countResult.count);
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to count users by community: ${errorMessage}`);
    }
  }

  /**
   * Find user by ID across all communities (super admin only)
   * @param id - User ID
   * @returns Promise<User | null> - User if found, null otherwise
   */
  async findByIdAsSuperAdmin(id: number): Promise<User | null> {
    try {
      const usersTable = await getUsersTable();
      const users = await this.database
        .select()
        .from(usersTable)
        .where(eq(usersTable.id, id))
        .limit(1);

      return users[0] || null;
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      throw new Error(
        `Failed to find user by ID as super admin: ${errorMessage}`
      );
    }
  }

  /**
   * Find user by ID with community name in single query (super admin only)
   * @param id - User ID
   * @returns Promise<(User & { communityName?: string }) | null> - User with community name if found, null otherwise
   */
  async findByIdWithCommunityName(
    id: number
  ): Promise<(User & { communityName?: string }) | null> {
    try {
      const usersTable = await getUsersTable();
      const communitiesTable = await getCommunitiesTable();

      const users = await this.database
        .select({
          id: usersTable.id,
          firstName: usersTable.firstName,
          lastName: usersTable.lastName,
          email: usersTable.email,
          role: usersTable.role,
          communityId: usersTable.communityId,
          isActive: usersTable.isActive,
          createdAt: usersTable.createdAt,
          updatedAt: usersTable.updatedAt,
          lastLoginAt: usersTable.lastLoginAt,
          communityName: communitiesTable.name,
        })
        .from(usersTable)
        .leftJoin(
          communitiesTable,
          eq(usersTable.communityId, communitiesTable.id)
        )
        .where(eq(usersTable.id, id))
        .limit(1);

      return users[0] || null;
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      throw new Error(
        `Failed to find user by ID with community name: ${errorMessage}`
      );
    }
  }

  /**
   * Update user by ID across all communities (super admin only)
   * @param id - User ID
   * @param data - Update data
   * @returns Promise<User> - Updated user
   */
  async updateByIdAsSuperAdmin(
    id: number,
    data: Partial<NewUser>
  ): Promise<User> {
    try {
      const usersTable = await getUsersTable();

      // Update the user
      const updateData = {
        ...data,
        updatedAt: new Date(),
      };

      const updatedUsers = await this.database
        .update(usersTable)
        .set(updateData)
        .where(eq(usersTable.id, id))
        .returning();

      if (!updatedUsers || updatedUsers.length === 0) {
        throw new Error('User not found');
      }

      return updatedUsers[0];
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      throw new Error(
        `Failed to update user by ID as super admin: ${errorMessage}`
      );
    }
  }
}
