/**
 * Story Service
 *
 * Business logic layer for story management with comprehensive cultural protocol
 * enforcement, data sovereignty protection, and Indigenous community oversight.
 *
 * Features:
 * - Full CRUD operations with cultural protocol validation
 * - Data sovereignty enforcement (super admin blocking)
 * - Elder-only and ceremonial content restrictions
 * - Media file integration and validation
 * - Story-place and story-speaker association management
 * - Search and filtering with geographic capabilities
 * - Comprehensive audit logging for Indigenous oversight
 */

import type {
  StoryRepository,
  StoryCreateData,
  StoryWithRelations,
  StoryFilters,
  PaginationOptions,
  PaginatedResult,
} from '../repositories/story.repository.js';
import type { FileRepository } from '../repositories/file.repository.js';
import type { UserRepository } from '../repositories/user.repository.js';
import type { User } from '../db/schema/users.js';
import type { Logger } from '../shared/types/index.js';

/**
 * Cultural protocols for story access and modifications
 */
export interface CulturalProtocols {
  permissionLevel: 'public' | 'community' | 'restricted' | 'elder_only';
  culturalSignificance?: string;
  restrictions?: string[];
  ceremonialContent?: boolean;
  elderApprovalRequired?: boolean;
  accessNotes?: string;
}

/**
 * Story creation input with cultural protocols
 */
export interface StoryCreateInput {
  title: string;
  description?: string;
  slug?: string;
  communityId: number;
  createdBy: number;
  mediaUrls?: string[];
  placeIds?: number[];
  speakerIds?: number[];
  culturalProtocols?: CulturalProtocols;
  language?: string;
  dateInterviewed?: Date;
  interviewer?: string;
  tags?: string[];
}

/**
 * Cultural access validation result
 */
interface CulturalAccessResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Custom error classes for specific scenarios
 */
export class StoryNotFoundError extends Error {
  constructor(message = 'Story not found') {
    super(message);
    this.name = 'StoryNotFoundError';
  }
}

export class CulturalProtocolViolationError extends Error {
  constructor(message = 'Cultural protocol violation') {
    super(message);
    this.name = 'CulturalProtocolViolationError';
  }
}

export class DataSovereigntyViolationError extends Error {
  constructor(message = 'Data sovereignty violation') {
    super(message);
    this.name = 'DataSovereigntyViolationError';
  }
}

export class InsufficientPermissionsError extends Error {
  constructor(message = 'Insufficient permissions') {
    super(message);
    this.name = 'InsufficientPermissionsError';
  }
}

export class InvalidFileAccessError extends Error {
  constructor(message = 'Invalid file access') {
    super(message);
    this.name = 'InvalidFileAccessError';
  }
}

export class StoryService {
  constructor(
    private readonly storyRepository: StoryRepository,
    private readonly fileRepository: FileRepository,
    private readonly userRepository: UserRepository,
    private readonly logger: Logger
  ) {}

  /**
   * Create a new story with cultural protocol validation
   */
  async createStory(
    input: StoryCreateInput,
    userId: number,
    userRole: string,
    userCommunityId: number | null
  ): Promise<StoryWithRelations> {
    this.logger.info('Creating story', {
      title: input.title,
      userId,
      userRole,
      communityId: input.communityId,
    });

    // Data sovereignty check
    await this.validateDataSovereignty(
      userId,
      userRole,
      userCommunityId,
      input.communityId
    );

    // Validate user permissions for creation
    this.validateCreationPermissions(userRole);

    // Validate community access
    if (userCommunityId !== input.communityId) {
      throw new InsufficientPermissionsError(
        'Can only create stories in your own community'
      );
    }

    // Validate media file access if provided
    if (input.mediaUrls?.length) {
      await this.validateMediaAccess(
        input.mediaUrls,
        userId,
        input.communityId
      );
    }

    // Validate place and speaker associations
    if (input.placeIds?.length) {
      const placesValid = await this.storyRepository.validatePlacesInCommunity(
        input.placeIds,
        input.communityId
      );
      if (!placesValid) {
        throw new InsufficientPermissionsError(
          'Places must belong to the same community as the story'
        );
      }
    }

    if (input.speakerIds?.length) {
      const speakersValid =
        await this.storyRepository.validateSpeakersInCommunity(
          input.speakerIds,
          input.communityId
        );
      if (!speakersValid) {
        throw new InsufficientPermissionsError(
          'Speakers must belong to the same community as the story'
        );
      }
    }

    // Process cultural protocols
    const processedProtocols = this.processCulturalProtocols(
      input.culturalProtocols,
      userRole
    );

    // Auto-set restriction flag based on cultural protocols
    const isRestricted = this.shouldSetRestricted(processedProtocols);

    // Generate slug if not provided
    let slug = input.slug;
    if (!slug) {
      slug = await this.storyRepository.generateUniqueSlug(
        input.title,
        input.communityId
      );
    }

    // Prepare data for repository
    const storyData: StoryCreateData = {
      title: input.title,
      description: input.description,
      slug,
      communityId: input.communityId,
      createdBy: input.createdBy,
      mediaUrls: input.mediaUrls,
      language: input.language,
      tags: input.tags,
      isRestricted,
      culturalProtocols: processedProtocols,
      placeIds: input.placeIds,
      speakerIds: input.speakerIds,
    };

    // Create story
    const story = await this.storyRepository.create(storyData);

    // Audit log for cultural oversight
    await this.logCulturalAccess(
      story,
      { id: userId, role: userRole } as Pick<User, 'id' | 'role'>,
      'create',
      true
    );

    this.logger.info('Story created successfully', {
      storyId: story.id,
      slug: story.slug,
      userId,
    });

    return story;
  }

  /**
   * Get story by ID with cultural protocol enforcement
   */
  async getStoryById(
    id: number,
    userId: number,
    userRole: string,
    userCommunityId: number | null
  ): Promise<StoryWithRelations | null> {
    this.logger.debug('Fetching story by ID', {
      storyId: id,
      userId,
      userRole,
    });

    // Data sovereignty check for super admins
    if (userRole === 'super_admin') {
      this.logger.warn(
        'Data sovereignty protection: Super admin blocked from community story access',
        {
          userId,
          storyId: id,
          reason: 'data_sovereignty_protection',
        }
      );
      return null;
    }

    const story = await this.storyRepository.findByIdWithRelations(id);
    if (!story) {
      return null;
    }

    // Community isolation check
    if (story.communityId !== userCommunityId) {
      this.logger.warn('Cross-community access denied', {
        userId,
        userCommunityId,
        storyCommunityId: story.communityId,
        storyId: id,
      });
      return null;
    }

    // Cultural protocol access validation
    const accessResult = await this.validateCulturalAccess(
      story,
      { id: userId, role: userRole, communityId: userCommunityId } as Pick<
        User,
        'id' | 'role' | 'communityId'
      >,
      'read'
    );

    if (!accessResult.allowed) {
      this.logger.warn('Cultural protocol access denied', {
        userId,
        storyId: id,
        reason: accessResult.reason,
      });
      return null;
    }

    // Audit log
    await this.logCulturalAccess(
      story,
      { id: userId, role: userRole } as Pick<User, 'id' | 'role'>,
      'read',
      true
    );

    return story;
  }

  /**
   * Get story by slug with community scoping
   */
  async getStoryBySlug(
    slug: string,
    communityId: number,
    userId: number,
    userRole: string
  ): Promise<StoryWithRelations | null> {
    this.logger.debug('Fetching story by slug', {
      slug,
      communityId,
      userId,
      userRole,
    });

    // Data sovereignty check for super admins
    if (userRole === 'super_admin') {
      this.logger.warn(
        'Data sovereignty protection: Super admin blocked from community story access',
        {
          userId,
          slug,
          communityId,
          reason: 'data_sovereignty_protection',
        }
      );
      return null;
    }

    const story = await this.storyRepository.findBySlugWithRelations(
      slug,
      communityId
    );
    if (!story) {
      return null;
    }

    // Cultural protocol access validation
    const accessResult = await this.validateCulturalAccess(
      story,
      { id: userId, role: userRole, communityId } as Pick<
        User,
        'id' | 'role' | 'communityId'
      >,
      'read'
    );

    if (!accessResult.allowed) {
      this.logger.warn('Cultural protocol access denied', {
        userId,
        slug,
        reason: accessResult.reason,
      });
      return null;
    }

    // Audit log
    await this.logCulturalAccess(
      story,
      { id: userId, role: userRole } as Pick<User, 'id' | 'role'>,
      'read',
      true
    );

    return story;
  }

  /**
   * Update story with cultural protocol validation
   */
  async updateStory(
    id: number,
    updates: Partial<StoryCreateInput>,
    userId: number,
    userRole: string
  ): Promise<StoryWithRelations> {
    this.logger.info('Updating story', { storyId: id, userId, userRole });

    // Get existing story
    const existingStory = await this.storyRepository.findByIdWithRelations(id);
    if (!existingStory) {
      throw new StoryNotFoundError();
    }

    // Cultural protocol validation for modification
    const accessResult = await this.validateCulturalAccess(
      existingStory,
      {
        id: userId,
        role: userRole,
        communityId: existingStory.communityId,
      } as Pick<User, 'id' | 'role' | 'communityId'>,
      'write'
    );

    if (!accessResult.allowed) {
      throw new CulturalProtocolViolationError(accessResult.reason);
    }

    // Permission validation
    this.validateModificationPermissions(existingStory, userId, userRole);

    // Validate media file access if being updated
    if (updates.mediaUrls?.length) {
      await this.validateMediaAccess(
        updates.mediaUrls,
        userId,
        existingStory.communityId
      );
    }

    // Validate associations if being updated
    if (updates.placeIds?.length) {
      const placesValid = await this.storyRepository.validatePlacesInCommunity(
        updates.placeIds,
        existingStory.communityId
      );
      if (!placesValid) {
        throw new InsufficientPermissionsError(
          'Places must belong to the same community as the story'
        );
      }
    }

    if (updates.speakerIds?.length) {
      const speakersValid =
        await this.storyRepository.validateSpeakersInCommunity(
          updates.speakerIds,
          existingStory.communityId
        );
      if (!speakersValid) {
        throw new InsufficientPermissionsError(
          'Speakers must belong to the same community as the story'
        );
      }
    }

    // Process cultural protocol updates
    let processedProtocols = updates.culturalProtocols;
    if (updates.culturalProtocols) {
      processedProtocols = this.processCulturalProtocols(
        updates.culturalProtocols,
        userRole
      );
    }

    // Update restriction flag if cultural protocols changed
    const isRestricted = updates.culturalProtocols
      ? this.shouldSetRestricted(processedProtocols)
      : undefined;

    // Prepare update data
    const updateData: Partial<StoryCreateData> = {
      title: updates.title,
      description: updates.description,
      mediaUrls: updates.mediaUrls,
      language: updates.language,
      tags: updates.tags,
      placeIds: updates.placeIds,
      speakerIds: updates.speakerIds,
      isRestricted,
    };

    // Perform update
    const updatedStory = await this.storyRepository.update(id, updateData);
    if (!updatedStory) {
      throw new StoryNotFoundError('Story not found during update');
    }

    // Add cultural protocols to result
    if (processedProtocols) {
      (
        updatedStory as StoryWithRelations & {
          culturalProtocols?: CulturalProtocols;
        }
      ).culturalProtocols = processedProtocols;
    }

    // Check for orphaned media files
    await this.checkOrphanedFiles();

    // Audit log
    await this.logCulturalAccess(
      updatedStory,
      { id: userId, role: userRole } as Pick<User, 'id' | 'role'>,
      'update',
      true
    );

    this.logger.info('Story updated successfully', { storyId: id, userId });

    return updatedStory;
  }

  /**
   * Delete story with cultural protocol validation
   */
  async deleteStory(
    id: number,
    userId: number,
    userRole: string
  ): Promise<void> {
    this.logger.info('Deleting story', { storyId: id, userId, userRole });

    // Get existing story
    const existingStory = await this.storyRepository.findByIdWithRelations(id);
    if (!existingStory) {
      throw new StoryNotFoundError();
    }

    // Cultural protocol validation for deletion
    const accessResult = await this.validateCulturalAccess(
      existingStory,
      {
        id: userId,
        role: userRole,
        communityId: existingStory.communityId,
      } as Pick<User, 'id' | 'role' | 'communityId'>,
      'delete'
    );

    if (!accessResult.allowed) {
      throw new CulturalProtocolViolationError(accessResult.reason);
    }

    // Permission validation
    this.validateDeletionPermissions(existingStory, userId, userRole);

    // Perform deletion
    const success = await this.storyRepository.delete(id);
    if (!success) {
      throw new StoryNotFoundError('Story not found during deletion');
    }

    // Check for orphaned media files
    await this.checkOrphanedFiles();

    // Audit log
    await this.logCulturalAccess(
      existingStory,
      { id: userId, role: userRole } as Pick<User, 'id' | 'role'>,
      'delete',
      true
    );

    this.logger.info('Story deleted successfully', { storyId: id, userId });
  }

  /**
   * List stories with search, filtering, and cultural protocol enforcement
   */
  async listStories(
    filters: Omit<StoryFilters, 'communityId'>,
    pagination: PaginationOptions,
    userId: number,
    userRole: string,
    userCommunityId: number
  ): Promise<PaginatedResult<StoryWithRelations>> {
    this.logger.debug('Listing stories', {
      filters,
      pagination,
      userId,
      userRole,
      userCommunityId,
    });

    // Data sovereignty check for super admins
    if (userRole === 'super_admin') {
      this.logger.warn(
        'Data sovereignty protection: Super admin blocked from community stories',
        {
          userId,
          userCommunityId,
          reason: 'data_sovereignty_protection',
        }
      );
      return {
        data: [],
        total: 0,
        page: pagination.page,
        limit: pagination.limit,
        totalPages: 0,
      };
    }

    // Add community scoping to filters
    const scopedFilters: StoryFilters = {
      ...filters,
      communityId: userCommunityId,
    };

    // Apply cultural protocol filtering at database level based on user role
    if (userRole !== 'elder' && userRole !== 'admin') {
      // Non-elders cannot see restricted content - filter at DB level
      scopedFilters.isRestricted = false;
    }

    try {
      // Get results with all filtering done at database level
      const result = await this.storyRepository.findMany(
        scopedFilters,
        pagination
      );

      // Return database results directly - no additional in-memory filtering
      // All cultural protocol filtering is now handled by database queries
      return {
        data: result.data,
        total: result.total,
        page: result.page,
        limit: result.limit,
        totalPages: result.totalPages,
      };
    } catch (error) {
      this.logger.error('Error in story repository findMany:', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error; // Re-throw for the caller to handle
    }
  }

  /**
   * Search stories with text query and geographic filtering
   */
  async searchStories(
    query: string,
    filters: Omit<StoryFilters, 'communityId' | 'search'>,
    userId: number,
    userRole: string,
    userCommunityId: number
  ): Promise<StoryWithRelations[]> {
    const searchFilters: Omit<StoryFilters, 'communityId'> = {
      ...filters,
      search: query,
    };

    const result = await this.listStories(
      searchFilters,
      { page: 1, limit: 100 }, // Default search limit
      userId,
      userRole,
      userCommunityId
    );

    return result.data;
  }

  /**
   * Validate data sovereignty - super admins cannot access community content
   */
  private async validateDataSovereignty(
    userId: number,
    userRole: string,
    userCommunityId: number | null,
    targetCommunityId: number
  ): Promise<void> {
    if (userRole === 'super_admin') {
      this.logger.warn('Data sovereignty violation attempt', {
        userId,
        userRole,
        targetCommunityId,
        reason: 'Super administrators cannot access community stories',
      });
      throw new DataSovereigntyViolationError(
        'Super administrators cannot access community stories - data sovereignty protection'
      );
    }
  }

  /**
   * Validate cultural access to story content
   */
  private async validateCulturalAccess(
    story: StoryWithRelations,
    user: Pick<User, 'id' | 'role' | 'communityId'>,
    operation: 'read' | 'write' | 'delete'
  ): Promise<CulturalAccessResult> {
    return this.validateCulturalAccessSync(story, user, operation);
  }

  /**
   * Synchronous cultural access validation
   */
  private validateCulturalAccessSync(
    story: StoryWithRelations,
    user: Pick<User, 'id' | 'role' | 'communityId'>,
    operation: 'read' | 'write' | 'delete'
  ): CulturalAccessResult {
    // Community isolation enforcement
    if (story.communityId !== user.communityId) {
      return {
        allowed: false,
        reason: 'Stories can only be accessed within the same community',
      };
    }

    // Get cultural protocols (mock implementation - in future this would be from DB)
    const protocols = (
      story as StoryWithRelations & { culturalProtocols?: CulturalProtocols }
    ).culturalProtocols;

    if (
      protocols?.permissionLevel === 'elder_only' &&
      user.role !== 'elder' &&
      user.role !== 'admin'
    ) {
      return {
        allowed: false,
        reason: 'Elder-only content requires elevated cultural permissions',
      };
    }

    if (
      protocols?.ceremonialContent &&
      !['elder', 'admin'].includes(user.role)
    ) {
      return {
        allowed: false,
        reason: 'Ceremonial content requires elevated cultural permissions',
      };
    }

    if (
      protocols?.elderApprovalRequired &&
      operation === 'write' &&
      user.role !== 'elder'
    ) {
      return {
        allowed: false,
        reason: 'Modifications to this story require elder approval',
      };
    }

    // Operation-specific permission checks
    if (operation === 'write' || operation === 'delete') {
      const canModify =
        user.role === 'admin' ||
        user.role === 'elder' ||
        (user.role === 'editor' && story.createdBy === user.id);

      if (!canModify) {
        return {
          allowed: false,
          reason:
            operation === 'delete'
              ? 'Insufficient permissions to delete this story'
              : 'Insufficient permissions to modify this story',
        };
      }
    }

    return { allowed: true };
  }

  /**
   * Validate creation permissions
   */
  private validateCreationPermissions(userRole: string): void {
    const allowedRoles = ['admin', 'elder', 'editor'];
    if (!allowedRoles.includes(userRole)) {
      throw new InsufficientPermissionsError(
        'Insufficient permissions to create stories'
      );
    }
  }

  /**
   * Validate modification permissions
   */
  private validateModificationPermissions(
    story: StoryWithRelations,
    userId: number,
    userRole: string
  ): void {
    const canModify =
      userRole === 'admin' ||
      userRole === 'elder' ||
      (userRole === 'editor' && story.createdBy === userId);

    if (!canModify) {
      throw new InsufficientPermissionsError(
        'Insufficient permissions to modify this story'
      );
    }
  }

  /**
   * Validate deletion permissions
   */
  private validateDeletionPermissions(
    story: StoryWithRelations,
    userId: number,
    userRole: string
  ): void {
    const canDelete =
      userRole === 'admin' ||
      userRole === 'elder' ||
      (userRole === 'editor' && story.createdBy === userId);

    if (!canDelete) {
      throw new InsufficientPermissionsError(
        'Insufficient permissions to delete this story'
      );
    }
  }

  /**
   * Validate media file access
   */
  private async validateMediaAccess(
    mediaUrls: string[],
    userId: number,
    communityId: number
  ): Promise<void> {
    const result = await this.fileRepository.validateFileAccess(
      mediaUrls,
      userId,
      communityId
    );
    if (!result.valid) {
      throw new InvalidFileAccessError(result.reason);
    }
  }

  /**
   * Validate places belong to same community
   */

  /**
   * Process cultural protocols with role-based validation
   */
  private processCulturalProtocols(
    protocols: CulturalProtocols | undefined,
    userRole: string
  ): CulturalProtocols | undefined {
    if (!protocols) return undefined;

    // Only elders and admins can set elder-only content
    if (
      protocols.permissionLevel === 'elder_only' &&
      !['elder', 'admin'].includes(userRole)
    ) {
      throw new CulturalProtocolViolationError(
        'Only elders and admins can create elder-only content'
      );
    }

    // Only elders and admins can set ceremonial content
    if (protocols.ceremonialContent && !['elder', 'admin'].includes(userRole)) {
      throw new CulturalProtocolViolationError(
        'Only elders and admins can mark content as ceremonial'
      );
    }

    return protocols;
  }

  /**
   * Determine if story should be marked as restricted based on cultural protocols
   */
  private shouldSetRestricted(
    protocols: CulturalProtocols | undefined
  ): boolean {
    if (!protocols) return false;

    return (
      protocols.permissionLevel === 'elder_only' ||
      protocols.permissionLevel === 'restricted' ||
      protocols.ceremonialContent === true
    );
  }

  /**
   * Check for orphaned media files
   */
  private async checkOrphanedFiles(): Promise<void> {
    try {
      const orphanedFiles = await this.fileRepository.findOrphanedFiles();
      if (orphanedFiles.length > 0) {
        this.logger.info('Found orphaned files after story operation', {
          count: orphanedFiles.length,
        });
        // Files would be cleaned up by a background job
      }
    } catch (error) {
      this.logger.error('Error checking orphaned files', { error });
    }
  }

  /**
   * Log cultural access for Indigenous oversight
   */
  private async logCulturalAccess(
    story: StoryWithRelations,
    user: Pick<User, 'id' | 'role'>,
    operation: string,
    allowed: boolean,
    reason?: string
  ): Promise<void> {
    const logEntry = {
      timestamp: new Date().toISOString(),
      storyId: story.id,
      storyTitle: story.title,
      userId: user.id,
      userRole: user.role,
      communityId: story.communityId,
      operation,
      allowed,
      reason,
      culturalProtocols: (
        story as StoryWithRelations & { culturalProtocols?: CulturalProtocols }
      ).culturalProtocols,
    };

    // Log to appropriate audit system for Indigenous community oversight
    this.logger.info('[CULTURAL_ACCESS_AUDIT]', logEntry);
  }

  /**
   * Get public stories for a community (for public API)
   * Filters out private and elder-restricted content
   */
  async getPublicStoriesByCommunity(
    communityId: string,
    options: { page: number; limit: number }
  ): Promise<{ stories: StoryWithRelations[]; total: number }> {
    try {
      // Get stories that are public and belong to the community
      const result = await this.storyRepository.findMany(
        {
          communityId: parseInt(communityId, 10),
          // Only public stories for the public API
          privacyLevel: 'public',
          isRestricted: false,
        },
        {
          page: options.page,
          limit: options.limit,
        }
      );

      // For the public API, we'll use all non-restricted stories
      // since isRestricted: false already filters out elder-only content
      const publicStories = result.data;

      // Log public access for audit purposes
      this.logger.info('[PUBLIC_API_ACCESS]', {
        timestamp: new Date().toISOString(),
        operation: 'list_public_stories',
        communityId: parseInt(communityId, 10),
        storiesReturned: publicStories.length,
        page: options.page,
        limit: options.limit,
      });

      return {
        stories: publicStories,
        total: result.total, // Use actual total from repository
      };
    } catch (error) {
      this.logger.error('Failed to get public stories by community:', {
        communityId,
        options,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw new Error('Failed to retrieve public stories');
    }
  }

  /**
   * Get a specific public story by ID with community validation
   * Ensures story is public and belongs to the specified community
   */
  async getPublicStoryById(
    storyId: string,
    communityId: string
  ): Promise<StoryWithRelations | null> {
    try {
      // Get the story with relations for public API
      const story = await this.storyRepository.findByIdWithRelations(
        parseInt(storyId, 10)
      );

      if (!story) {
        return null;
      }

      // Verify story belongs to the community
      if (story.communityId !== parseInt(communityId, 10)) {
        this.logger.warn('[PUBLIC_API_ACCESS_DENIED]', {
          timestamp: new Date().toISOString(),
          reason: 'Story does not belong to specified community',
          storyId: parseInt(storyId, 10),
          storyCommunityId: story.communityId,
          requestedCommunityId: parseInt(communityId, 10),
        });
        return null;
      }

      // Check if story is public (not restricted)
      if (story.isRestricted) {
        this.logger.warn('[PUBLIC_API_ACCESS_DENIED]', {
          timestamp: new Date().toISOString(),
          reason: 'Story has cultural restrictions and is not public',
          storyId: parseInt(storyId, 10),
          isRestricted: story.isRestricted,
          communityId: parseInt(communityId, 10),
        });
        return null;
      }

      // Log successful public access
      this.logger.info('[PUBLIC_API_ACCESS]', {
        timestamp: new Date().toISOString(),
        operation: 'get_public_story',
        storyId: parseInt(storyId, 10),
        storyTitle: story.title,
        communityId: parseInt(communityId, 10),
      });

      return story;
    } catch (error) {
      this.logger.error('Failed to get public story by ID:', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw new Error('Failed to retrieve public story');
    }
  }
}

// Export types for external use
export type {
  StoryWithRelations,
  StoryFilters,
  PaginationOptions,
  PaginatedResult,
} from '../repositories/story.repository.js';
