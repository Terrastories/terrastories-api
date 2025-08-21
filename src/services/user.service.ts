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
import type {
  User,
  CreateUserData,
  UpdateUserData,
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
 * User Service class providing business logic for user operations
 */
export class UserService {
  private communityService: CommunityService;

  constructor(
    private userRepository: UserRepository,
    communityRepository?: CommunityRepository
  ) {
    // If community repository is provided, use it; otherwise we need to create one
    // This allows for dependency injection in tests while maintaining backwards compatibility
    if (communityRepository) {
      this.communityService = new CommunityService(communityRepository);
    } else {
      // We'll handle this in the routes where we have access to the database
      // For now, we'll add the validation logic inline
      this.communityService = null as unknown as CommunityService; // Temporary - will be set by routes
    }
  }

  /**
   * Set the community service (for backwards compatibility)
   */
  setCommunityService(communityService: CommunityService): void {
    this.communityService = communityService;
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
      if (this.communityService) {
        const community = await this.communityService.getCommunityById(
          data.communityId
        );
        if (!community) {
          throw new InvalidCommunityError('Community not found');
        }
        if (!community.isActive) {
          throw new InvalidCommunityError('Community is not active');
        }
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
}
