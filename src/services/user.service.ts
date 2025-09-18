/**
 * User Service
 *
 * Business logic for user management including registration, authentication,
 * and CRUD operations with community-scoped data isolation.
 *
 * Features:
 * - User registration with password hashing
 * - Email uniqueness validation within communities
 * - Community association validation
 * - Authentication with timing-safe password comparison
 * - Role-based access control
 * - Comprehensive error handling
 */

import { UserRepository } from '../repositories/user.repository.js';
import * as passwordService from './password.service.js';
import { CommunityService } from './community.service.js';
import { CommunityRepository } from '../repositories/community.repository.js';
import {
  toISOString,
  toISOStringOrNull,
} from '../shared/utils/date-transforms.js';
import type {
  User,
  CreateUserData,
  UpdateUserData,
  UserRole,
} from '../db/schema/index.js';

/**
 * Request data for user registration
 */
export interface CreateUserRequest {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  role?: 'super_admin' | 'admin' | 'editor' | 'elder' | 'viewer';
  communityId: number;
  isActive?: boolean;
}

/**
 * Request data for user updates
 */
export interface UpdateUserRequest {
  email?: string;
  firstName?: string;
  lastName?: string;
  role?: 'super_admin' | 'admin' | 'editor' | 'elder' | 'viewer';
  isActive?: boolean;
  communityId?: number;
}

/**
 * Custom error for duplicate email addresses within communities
 */
export class DuplicateEmailError extends Error {
  constructor(
    message = 'User with this email already exists in this community'
  ) {
    super(message);
    this.name = 'DuplicateEmailError';
  }
}

/**
 * Custom error for weak password validation
 */
export class WeakPasswordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WeakPasswordError';
  }
}

/**
 * Custom error for invalid community references
 */
export class InvalidCommunityError extends Error {
  constructor(message = 'Invalid community ID') {
    super(message);
    this.name = 'InvalidCommunityError';
  }
}

/**
 * Custom error for authentication failures
 */
export class AuthenticationError extends Error {
  constructor(message = 'Invalid email or password') {
    super(message);
    this.name = 'AuthenticationError';
  }
}

/**
 * Custom error for user not found
 */
export class UserNotFoundError extends Error {
  constructor(message = 'User not found') {
    super(message);
    this.name = 'UserNotFoundError';
  }
}

/**
 * Custom error for super admin role violations
 */
export class SuperAdminRoleError extends Error {
  constructor(
    message = 'Super admin role operations not allowed through community endpoints'
  ) {
    super(message);
    this.name = 'SuperAdminRoleError';
  }
}

/**
 * Custom error for self-deletion attempts
 */
export class SelfDeletionError extends Error {
  constructor(message = 'Users cannot delete themselves') {
    super(message);
    this.name = 'SelfDeletionError';
  }
}

/**
 * User Service class providing business logic for user operations
 */
export class UserService {
  private communityService: CommunityService;

  constructor(
    private userRepository: UserRepository,
    communityRepository: CommunityRepository
  ) {
    // Always require community repository for proper validation
    this.communityService = new CommunityService(communityRepository);
  }

  /**
   * Register a new user with password hashing and validation
   *
   * @param data - User registration data
   * @returns Promise<User> - Created user (without password hash)
   * @throws DuplicateEmailError - If email exists in community
   * @throws WeakPasswordError - If password doesn't meet requirements
   * @throws InvalidCommunityError - If community doesn't exist
   * @throws Error - For validation or system errors
   */
  async registerUser(data: CreateUserRequest): Promise<User> {
    try {
      // Validate email format
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(data.email)) {
        throw new Error('Invalid email format');
      }

      // Validate required fields
      if (!data.firstName?.trim() || !data.lastName?.trim()) {
        throw new Error('First name and last name are required');
      }

      // Validate role
      const validRoles = ['super_admin', 'admin', 'editor', 'elder', 'viewer'];
      const role = data.role || 'viewer';
      if (!validRoles.includes(role)) {
        throw new Error('Invalid role specified');
      }

      // Validate community exists
      const community = await this.communityService.getCommunityById(
        data.communityId
      );
      if (!community) {
        throw new InvalidCommunityError('Community not found');
      }
      if (!community.isActive) {
        throw new InvalidCommunityError('Community is not active');
      }

      // Validate password strength
      const passwordValidation = passwordService.validatePasswordStrength(
        data.password
      );
      if (!passwordValidation.isValid) {
        throw new WeakPasswordError(
          `Password requirements not met: ${passwordValidation.errors.join(', ')}`
        );
      }

      // Community validation will be handled by the database foreign key constraints
      // This allows the repository layer to throw appropriate errors

      // Check for duplicate email within community
      const existingUser = await this.userRepository.findByEmail(
        data.email,
        data.communityId
      );
      if (existingUser) {
        throw new DuplicateEmailError();
      }

      // Hash password
      const passwordHash = await passwordService.hashPassword(data.password);

      // Create user data
      const userData: CreateUserData = {
        email: data.email,
        passwordHash,
        firstName: data.firstName,
        lastName: data.lastName,
        role,
        communityId: data.communityId,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // Create user in database
      const user = await this.userRepository.create(userData);
      return user;
    } catch (error) {
      // Re-throw known errors
      if (
        error instanceof DuplicateEmailError ||
        error instanceof WeakPasswordError ||
        error instanceof InvalidCommunityError
      ) {
        throw error;
      }

      // Handle database constraint errors
      if (error instanceof Error) {
        if (error.message.includes('Invalid community ID')) {
          throw new InvalidCommunityError();
        }
        // Only handle email format errors, not email existence errors
        if (
          error.message.includes('email') &&
          error.message.includes('format')
        ) {
          throw new Error('Invalid email format');
        }
      }

      // Wrap other errors
      throw new Error(
        `Failed to register user: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Authenticate user with email and password
   *
   * @param email - User email
   * @param password - Plain text password
   * @param communityId - Community scope for authentication
   * @returns Promise<User> - Authenticated user (without password hash)
   * @throws AuthenticationError - If credentials are invalid
   */
  async authenticateUser(
    email: string,
    password: string,
    communityId: number
  ): Promise<User> {
    try {
      // Find user by email in community
      const user = await this.userRepository.findByEmail(email, communityId);
      if (!user) {
        throw new AuthenticationError();
      }

      // Verify password using timing-safe comparison
      const isValidPassword = await passwordService.comparePassword(
        password,
        user.passwordHash
      );
      if (!isValidPassword) {
        throw new AuthenticationError();
      }

      // Check if user is active
      if (!user.isActive) {
        throw new AuthenticationError('Account is deactivated');
      }

      return user;
    } catch (error) {
      if (error instanceof AuthenticationError) {
        throw error;
      }
      throw new AuthenticationError();
    }
  }

  /**
   * Authenticate user with email and password (without community scope)
   * Finds the user across all communities - useful for simplified login
   *
   * @param email - User email
   * @param password - Plain text password
   * @returns Promise<User> - Authenticated user (without password hash)
   * @throws AuthenticationError - If credentials are invalid
   */
  async authenticateUserGlobal(email: string, password: string): Promise<User> {
    try {
      // Find user by email globally (across all communities)
      const user = await this.userRepository.findByEmailGlobal(email);
      if (!user) {
        throw new AuthenticationError();
      }

      // Verify password using timing-safe comparison
      const isValidPassword = await passwordService.comparePassword(
        password,
        user.passwordHash
      );
      if (!isValidPassword) {
        throw new AuthenticationError();
      }

      // Check if user is active
      if (!user.isActive) {
        throw new AuthenticationError('Account is deactivated');
      }

      return user;
    } catch (error) {
      if (error instanceof AuthenticationError) {
        throw error;
      }
      throw new AuthenticationError();
    }
  }

  /**
   * Get user by ID within community scope
   *
   * @param id - User ID
   * @param communityId - Community scope
   * @returns Promise<User> - User data
   * @throws UserNotFoundError - If user not found in community
   */
  async getUserById(id: number, communityId: number): Promise<User> {
    const user = await this.userRepository.findById(id, communityId);
    if (!user) {
      throw new UserNotFoundError();
    }
    return user;
  }

  /**
   * Update user data within community scope
   *
   * @param id - User ID
   * @param updates - Partial user data to update
   * @param communityId - Community scope
   * @returns Promise<User> - Updated user data
   * @throws UserNotFoundError - If user not found in community
   * @throws DuplicateEmailError - If email update conflicts
   */
  async updateUser(
    id: number,
    updates: UpdateUserRequest,
    communityId: number
  ): Promise<User> {
    // Check if user exists in community
    const existingUser = await this.userRepository.findById(id, communityId);
    if (!existingUser) {
      throw new UserNotFoundError();
    }

    // If updating email, check for duplicates
    if (updates.email && updates.email !== existingUser.email) {
      const duplicateUser = await this.userRepository.findByEmail(
        updates.email,
        communityId
      );
      if (duplicateUser && duplicateUser.id !== id) {
        throw new DuplicateEmailError();
      }
    }

    // Prepare update data
    const updateData: UpdateUserData = {
      ...updates,
      updatedAt: new Date(),
    };

    // Update user
    const updatedUser = await this.userRepository.update(
      id,
      updateData,
      communityId
    );
    if (!updatedUser) {
      throw new UserNotFoundError();
    }

    return updatedUser;
  }

  /**
   * Initiate password reset by generating a secure token
   * TEMPORARILY COMMENTED OUT - waiting for database migration completion
   * @param email - User's email address
   * @param communityId - Community scope for the reset
   * @returns Reset token to be sent via email
   */
  // async initiatePasswordReset(
  //   email: string,
  //   communityId: number
  // ): Promise<string> {
  //   // Find user by email within community
  //   const user = await this.userRepository.findByEmail(email, communityId);
  //   if (!user) {
  //     throw new UserNotFoundError();
  //   }

  //   // Generate secure random token (32-character hex)
  //   const resetToken = crypto.randomBytes(16).toString('hex');
  //   const resetSentAt = new Date();

  //   // Update user with reset token and timestamp
  //   await this.userRepository.update(
  //     user.id,
  //     {
  //       resetPasswordToken: resetToken,
  //       resetPasswordSentAt: resetSentAt,
  //       updatedAt: new Date(),
  //     },
  //     communityId
  //   );

  //   return resetToken;
  // }

  /**
   * Reset password using a valid reset token within a specific community
   * TEMPORARILY COMMENTED OUT - waiting for database migration completion
   * @param resetToken - Token from password reset email
   * @param newPassword - New password to set
   * @param communityId - Community ID to scope the token lookup
   */
  // async resetPassword(
  //   resetToken: string,
  //   newPassword: string,
  //   communityId: number
  // ): Promise<void> {
  //   // Validate token format (32-character hex)
  //   if (
  //     !resetToken ||
  //     resetToken.length !== 32 ||
  //     !/^[a-f0-9]+$/i.test(resetToken)
  //   ) {
  //     throw new Error('Invalid or expired reset token');
  //   }

  //   // Find user by reset token within the specified community
  //   const user = await this.userRepository.findByResetToken(
  //     resetToken,
  //     communityId
  //   );
  //   if (!user) {
  //     throw new Error('Invalid or expired reset token');
  //   }

  //   // Check if token is expired (1 hour window)
  //   if (
  //     !user.resetPasswordSentAt ||
  //     Date.now() - user.resetPasswordSentAt.getTime() > 60 * 60 * 1000
  //   ) {
  //     throw new Error('Invalid or expired reset token');
  //   }

  //   // Validate new password strength
  //   const passwordValidation =
  //     passwordService.validatePasswordStrength(newPassword);
  //   if (!passwordValidation.isValid) {
  //     throw new WeakPasswordError(
  //       `Password requirements not met: ${passwordValidation.errors.join(', ')}`
  //     );
  //   }

  //   // Hash new password
  //   const hashedPassword = await passwordService.hashPassword(newPassword);

  //   // Update user with new password and clear reset fields
  //   await this.userRepository.update(
  //     user.id,
  //     {
  //       passwordHash: hashedPassword,
  //       resetPasswordToken: null,
  //       resetPasswordSentAt: null,
  //       updatedAt: new Date(),
  //     },
  //     user.communityId
  //   );
  // }

  /**
   * Authenticate user with IP tracking and sign-in count
   * TEMPORARILY COMMENTED OUT - waiting for database migration completion
   * @param email - User's email
   * @param password - User's password
   * @param communityId - Community ID
   * @param ipAddress - Client IP address for tracking
   * @returns Authenticated user
   */
  // async authenticateUserWithTracking(
  //   email: string,
  //   password: string,
  //   communityId: number,
  //   ipAddress: string
  // ): Promise<User> {
  //   // Authenticate user normally first
  //   const user = await this.authenticateUser(email, password, communityId);

  //   // Update sign-in tracking fields
  //   await this.userRepository.update(
  //     user.id,
  //     {
  //       signInCount: user.signInCount + 1,
  //       lastSignInAt: new Date(), // Always track the sign-in time
  //       currentSignInIp: ipAddress,
  //       updatedAt: new Date(),
  //     },
  //     communityId
  //   );

  //   // Return updated user
  //   return (await this.userRepository.findById(user.id, communityId)) as User;
  // }

  /**
   * Set remember me token for persistent sessions
   * TEMPORARILY COMMENTED OUT - waiting for database migration completion
   * @param userId - User ID
   * @param communityId - Community ID
   */
  // async setRememberToken(userId: number, communityId: number): Promise<void> {
  //   await this.userRepository.update(
  //     userId,
  //     {
  //       rememberCreatedAt: new Date(),
  //       updatedAt: new Date(),
  //     },
  //     communityId
  //   );
  // }

  /**
   * Clear remember me token
   * TEMPORARILY COMMENTED OUT - waiting for database migration completion
   * @param userId - User ID
   * @param communityId - Community ID
   */
  // async clearRememberToken(userId: number, communityId: number): Promise<void> {
  //   await this.userRepository.update(
  //     userId,
  //     {
  //       rememberCreatedAt: null,
  //       updatedAt: new Date(),
  //     },
  //     communityId
  //   );
  // }

  /**
   * Delete user within community scope
   *
   * @param id - User ID
   * @param communityId - Community scope
   * @throws UserNotFoundError - If user not found in community
   */
  async deleteUser(id: number, communityId: number): Promise<void> {
    const existingUser = await this.userRepository.findById(id, communityId);
    if (!existingUser) {
      throw new UserNotFoundError();
    }

    await this.userRepository.delete(id, communityId);
  }

  /**
   * Super Admin Methods
   * These methods provide cross-community access for super admin users only
   */

  /**
   * Get all users across communities with pagination (super admin only)
   * @param options - Query options including pagination and filters
   * @returns Promise<{data: UserResponse[], meta: PaginationMeta}> - Paginated users
   */
  async getAllUsersForSuperAdmin(
    options: {
      page?: number;
      limit?: number;
      community?: number;
      role?: UserRole;
      search?: string;
      active?: boolean;
    } = {}
  ): Promise<{
    data: any[]; // UserResponse type - will define properly
    meta: {
      page: number;
      limit: number;
      total: number;
      totalPages: number;
    };
  }> {
    try {
      const { page = 1, limit = 20, community, role, search, active } = options;

      // Validate pagination
      if (page < 1) {
        throw new Error('Page must be at least 1');
      }
      if (limit < 1 || limit > 100) {
        throw new Error('Limit must be between 1 and 100');
      }

      const offset = (page - 1) * limit;

      // Build search filters
      const searchFilters: {
        limit?: number;
        offset?: number;
        communityId?: number;
        role?: UserRole;
        search?: string;
        isActive?: boolean;
      } = {
        limit,
        offset,
      };

      const countFilters: {
        communityId?: number;
        role?: UserRole;
        search?: string;
        isActive?: boolean;
      } = {};

      if (community) {
        searchFilters.communityId = community;
        countFilters.communityId = community;
      }
      if (role) {
        searchFilters.role = role;
        countFilters.role = role;
      }
      if (active !== undefined) {
        searchFilters.isActive = active;
        countFilters.isActive = active;
      }
      if (search) {
        searchFilters.search = search;
        countFilters.search = search;
      }

      // Get users and count from repository
      const [users, total] = await Promise.all([
        this.userRepository.searchUsers(searchFilters),
        this.userRepository.countUsers(countFilters),
      ]);

      // Transform users to response format
      const data = users.map((user: any) => ({
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        communityId: user.communityId,
        communityName: user.communityName || 'Unknown', // Provided via JOIN in repository
        isActive: user.isActive,
        createdAt: toISOString(user.createdAt),
        updatedAt: toISOString(user.updatedAt),
        lastLoginAt: toISOStringOrNull(user.lastLoginAt),
      }));

      return {
        data,
        meta: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      };
    } catch (error) {
      throw new Error(
        `Super admin failed to get users: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
    }
  }

  /**
   * Create user in any community as super admin
   * @param data - User creation data
   * @returns Promise<User> - Created user
   */
  async createUserAsSuperAdmin(data: {
    email: string;
    password: string;
    firstName: string;
    lastName: string;
    role: string;
    communityId: number;
    isActive?: boolean;
  }): Promise<any> {
    try {
      // Super admin can create users in any community
      // Use the existing registerUser method but bypass community restrictions
      const userData: CreateUserRequest = {
        email: data.email,
        password: data.password,
        firstName: data.firstName,
        lastName: data.lastName,
        communityId: data.communityId,
        role: data.role as 'super_admin' | 'admin' | 'editor' | 'viewer',
        isActive: data.isActive ?? true,
      };

      return await this.registerUser(userData);
    } catch (error) {
      // Re-throw specific error types for proper HTTP status codes
      if (
        error instanceof DuplicateEmailError ||
        error instanceof WeakPasswordError ||
        error instanceof InvalidCommunityError
      ) {
        throw error;
      }
      throw new Error(
        `Super admin failed to create user: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
    }
  }

  /**
   * Update user details as super admin (including role changes)
   * @param id - User ID
   * @param updates - Update data
   * @returns Promise<User> - Updated user
   */
  async updateUserAsSuperAdmin(
    id: number,
    updates: {
      firstName?: string;
      lastName?: string;
      role?: string;
      communityId?: number;
      isActive?: boolean;
    }
  ): Promise<any> {
    try {
      // Super admin can update any user including cross-community changes
      const updateData: Partial<UpdateUserData> = {
        firstName: updates.firstName,
        lastName: updates.lastName,
        role: updates.role as
          | 'super_admin'
          | 'admin'
          | 'editor'
          | 'viewer'
          | undefined,
        communityId: updates.communityId,
        isActive: updates.isActive,
        updatedAt: new Date(),
      };

      return await this.userRepository.updateByIdAsSuperAdmin(id, updateData);
    } catch (error) {
      if (error instanceof Error && error.message.includes('User not found')) {
        throw new UserNotFoundError();
      }
      if (error instanceof UserNotFoundError) {
        throw error;
      }
      throw new Error(
        `Super admin failed to update user: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
    }
  }

  /**
   * Get user by ID as super admin (cross-community access)
   * @param id - User ID
   * @returns Promise<User | null> - User data or null if not found
   */
  async getUserByIdAsSuperAdmin(id: number): Promise<User | null> {
    return await this.userRepository.findByIdAsSuperAdmin(id);
  }

  /**
   * Get user by ID with community name in single query (super admin only)
   * @param id - User ID
   * @returns Promise<(User & { communityName?: string }) | null> - User with community name or null if not found
   */
  async getUserByIdWithCommunityName(
    id: number
  ): Promise<(User & { communityName?: string }) | null> {
    return await this.userRepository.findByIdWithCommunityName(id);
  }

  /**
   * Deactivate user as super admin
   * @param id - User ID
   * @returns Promise<{message: string, id: number}> - Success response
   */
  async deactivateUserAsSuperAdmin(id: number): Promise<{
    message: string;
    id: number;
  }> {
    try {
      // Validate ID
      if (!Number.isInteger(id) || id <= 0) {
        throw new Error('Invalid user ID');
      }

      // Check if user exists
      const user = await this.getUserByIdAsSuperAdmin(id);
      if (!user) {
        throw new UserNotFoundError();
      }

      // Deactivate the user
      await this.userRepository.updateByIdAsSuperAdmin(id, { isActive: false });

      return {
        message: 'User deactivated successfully',
        id,
      };
    } catch (error) {
      // Re-throw specific error types
      if (error instanceof UserNotFoundError) {
        throw error;
      }
      throw new Error(
        `Super admin failed to deactivate user: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
    }
  }

  /**
   * Community-Scoped User Management Methods
   *
   * These methods provide community-scoped user management for regular admins
   * within their community boundaries to ensure data sovereignty compliance.
   */

  /**
   * Get all users in a specific community with pagination and filtering
   * Used by community admins to manage users within their community
   */
  async getAllUsersByCommunity(options: {
    communityId: number;
    page?: number;
    limit?: number;
    search?: string;
    role?: UserRole;
    active?: boolean;
  }): Promise<{
    data: User[];
    meta: {
      page: number;
      limit: number;
      total: number;
      totalPages: number;
    };
  }> {
    try {
      const {
        communityId,
        page = 1,
        limit = 20,
        search,
        role,
        active,
      } = options;

      // Validate community ID
      if (!Number.isInteger(communityId) || communityId <= 0) {
        throw new Error('Invalid community ID');
      }

      // Validate pagination
      if (!Number.isInteger(page) || page < 1) {
        throw new Error('Page must be a positive integer');
      }
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new Error('Limit must be between 1 and 100');
      }

      const result = await this.userRepository.findByCommunity(communityId, {
        page,
        limit,
        search,
        role,
        active,
      });

      return result;
    } catch (error) {
      throw new Error(
        `Failed to get users for community: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
    }
  }

  /**
   * Get a user by ID within a specific community
   * Ensures community data isolation - users can only access users in their community
   */
  async getUserByIdInCommunity(
    userId: number,
    communityId: number
  ): Promise<User | null> {
    try {
      // Validate IDs
      if (!Number.isInteger(userId) || userId <= 0) {
        throw new Error('Invalid user ID');
      }
      if (!Number.isInteger(communityId) || communityId <= 0) {
        throw new Error('Invalid community ID');
      }

      // Get user in the specified community
      const user = await this.userRepository.findById(userId, communityId);
      return user;
    } catch (error) {
      throw new Error(
        `Failed to get user: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
    }
  }

  /**
   * Create a new user within a specific community
   * Enforces community boundary - user will be created in the admin's community
   */
  async createUserInCommunity(
    data: Omit<CreateUserRequest, 'communityId'> & { communityId: number }
  ): Promise<User> {
    try {
      const { communityId, ...userData } = data;

      // Validate community ID
      if (!Number.isInteger(communityId) || communityId <= 0) {
        throw new InvalidCommunityError('Invalid community ID');
      }

      // Community validation will be handled by the database constraint
      // If the community doesn't exist, the foreign key constraint will fail

      // Block super_admin role creation (community admins can't create super admins)
      if (userData.role === 'super_admin') {
        throw new SuperAdminRoleError(
          'Cannot create super admin users through community endpoints'
        );
      }

      // Check for duplicate email within the same community
      const existingUser = await this.userRepository.findByEmailInCommunity(
        userData.email,
        communityId
      );
      if (existingUser) {
        throw new DuplicateEmailError(
          'User with this email already exists in this community'
        );
      }

      // Validate password strength
      if (userData.password.length < 8) {
        throw new WeakPasswordError(
          'Password must be at least 8 characters long'
        );
      }

      // Hash password
      const hashedPassword = await passwordService.hashPassword(
        userData.password
      );

      // Create user data
      const now = new Date();
      const createData: CreateUserData = {
        email: userData.email,
        passwordHash: hashedPassword,
        firstName: userData.firstName,
        lastName: userData.lastName,
        role: userData.role || 'viewer',
        communityId,
        isActive: userData.isActive ?? true,
        createdAt: now,
        updatedAt: now,
      };

      // Create user
      const user = await this.userRepository.create(createData);
      return user;
    } catch (error) {
      // Re-throw known error types
      if (
        error instanceof DuplicateEmailError ||
        error instanceof WeakPasswordError ||
        error instanceof InvalidCommunityError
      ) {
        throw error;
      }
      throw new Error(
        `Failed to create user: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
    }
  }

  /**
   * Update a user within a specific community
   * Ensures community data isolation - users can only update users in their community
   */
  async updateUserInCommunity(
    userId: number,
    data: Omit<UpdateUserRequest, 'communityId'>,
    communityId: number
  ): Promise<User> {
    try {
      // Validate IDs
      if (!Number.isInteger(userId) || userId <= 0) {
        throw new Error('Invalid user ID');
      }
      if (!Number.isInteger(communityId) || communityId <= 0) {
        throw new Error('Invalid community ID');
      }

      // Check if user exists in the same community
      const existingUser = await this.getUserByIdInCommunity(
        userId,
        communityId
      );
      if (!existingUser) {
        throw new UserNotFoundError('User not found');
      }

      // Block super_admin role assignment (community admins can't promote to super admin)
      if (data.role === 'super_admin') {
        throw new SuperAdminRoleError(
          'Cannot assign super admin role through community endpoints'
        );
      }

      // Check for duplicate email if email is being updated
      if (data.email && data.email !== existingUser.email) {
        const duplicateUser = await this.userRepository.findByEmailInCommunity(
          data.email,
          communityId
        );
        if (duplicateUser && duplicateUser.id !== userId) {
          throw new DuplicateEmailError(
            'User with this email already exists in this community'
          );
        }
      }

      // Create update data
      const updateData: UpdateUserData = {
        email: data.email,
        firstName: data.firstName,
        lastName: data.lastName,
        role: data.role,
        isActive: data.isActive,
      };

      // Remove undefined values
      Object.keys(updateData).forEach((key) => {
        if (updateData[key as keyof UpdateUserData] === undefined) {
          delete updateData[key as keyof UpdateUserData];
        }
      });

      // Update user
      const updatedUser = await this.userRepository.update(
        userId,
        updateData,
        communityId
      );
      if (!updatedUser) {
        throw new UserNotFoundError('User not found');
      }
      return updatedUser;
    } catch (error) {
      // Re-throw known error types
      if (
        error instanceof UserNotFoundError ||
        error instanceof DuplicateEmailError
      ) {
        throw error;
      }
      throw new Error(
        `Failed to update user: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
    }
  }

  /**
   * Delete/deactivate a user within a specific community
   * Ensures community data isolation - users can only delete users in their community
   */
  async deleteUserInCommunity(
    userId: number,
    communityId: number,
    actingUserId: number
  ): Promise<{ message: string; id: number }> {
    try {
      // Validate IDs
      if (!Number.isInteger(userId) || userId <= 0) {
        throw new Error('Invalid user ID');
      }
      if (!Number.isInteger(communityId) || communityId <= 0) {
        throw new Error('Invalid community ID');
      }
      if (!Number.isInteger(actingUserId) || actingUserId <= 0) {
        throw new Error('Invalid acting user ID');
      }

      // Prevent self-deletion
      if (userId === actingUserId) {
        throw new SelfDeletionError('Users cannot delete themselves');
      }

      // Check if user exists in the same community
      const existingUser = await this.getUserByIdInCommunity(
        userId,
        communityId
      );
      if (!existingUser) {
        throw new UserNotFoundError('User not found');
      }

      // Deactivate the user (soft delete)
      await this.userRepository.update(
        userId,
        { isActive: false },
        communityId
      );

      return {
        message: 'User deleted successfully',
        id: userId,
      };
    } catch (error) {
      // Re-throw known error types
      if (error instanceof UserNotFoundError) {
        throw error;
      }
      throw new Error(
        `Failed to delete user: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
    }
  }
}
