/**
 * Community Service
 *
 * Business logic for community management with Indigenous data sovereignty,
 * cultural protocol support, and comprehensive CRUD operations.
 *
 * Features:
 * - Complete community lifecycle management
 * - Cultural settings and protocol enforcement
 * - Community isolation and data sovereignty
 * - Slug generation and validation
 * - Comprehensive error handling and validation
 * - Multi-tenant architecture support
 */

import { CommunityRepository } from '../repositories/community.repository.js';
import type {
  Community,
  CreateCommunityData,
  UpdateCommunityData,
  CommunitySearchParams,
  CulturalProtocols,
  CommunityStats,
  CommunityNotFoundError,
  DuplicateSlugError,
  InvalidCommunityDataError,
} from '../repositories/community.repository.js';
import type { CommunityResponse as CommunityResponseSchema } from '../shared/schemas/communities.js';
import type { CommunityResponse } from '../shared/schemas/super-admin.js';

/**
 * Request data for community creation
 */
export interface CreateCommunityRequest {
  name: string;
  description?: string;
  slug?: string;
  publicStories?: boolean;
  locale?: string;
  culturalSettings?: CulturalProtocols | string;
  isActive?: boolean;
}

/**
 * Request data for community updates
 */
export interface UpdateCommunityRequest {
  name?: string;
  description?: string;
  publicStories?: boolean;
  locale?: string;
  culturalSettings?: CulturalProtocols | string;
  isActive?: boolean;
}

// Community response type now imported from schema validation

/**
 * Search response with pagination metadata
 */
export interface CommunitySearchResponse {
  communities: Community[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

/**
 * Custom error classes for community service operations
 */
export class CommunityValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommunityValidationError';
  }
}

export class CommunityAccessError extends Error {
  constructor(message = 'Access denied to community') {
    super(message);
    this.name = 'CommunityAccessError';
  }
}

export class CommunityOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommunityOperationError';
  }
}

/**
 * Community Service class providing business logic
 */
export class CommunityService {
  constructor(private communityRepository: CommunityRepository) {}

  /**
   * Validate cultural settings format and content
   * @param culturalSettings - Cultural settings to validate
   * @returns CulturalProtocols - Parsed and validated cultural protocols
   */
  private validateCulturalSettings(
    culturalSettings: CulturalProtocols | string | undefined
  ): string | undefined {
    if (!culturalSettings) {
      return undefined;
    }

    let protocols: CulturalProtocols;

    // Parse if string, otherwise use as object
    if (typeof culturalSettings === 'string') {
      try {
        protocols = JSON.parse(culturalSettings);
      } catch {
        throw new CommunityValidationError(
          'Invalid cultural settings JSON format'
        );
      }
    } else {
      protocols = culturalSettings;
    }

    // Validate required fields and structure
    if (
      !protocols.languagePreferences ||
      !Array.isArray(protocols.languagePreferences)
    ) {
      throw new CommunityValidationError(
        'Language preferences must be an array'
      );
    }

    if (typeof protocols.elderContentRestrictions !== 'boolean') {
      throw new CommunityValidationError(
        'Elder content restrictions must be boolean'
      );
    }

    if (typeof protocols.ceremonialContent !== 'boolean') {
      throw new CommunityValidationError(
        'Ceremonial content flag must be boolean'
      );
    }

    if (typeof protocols.traditionalKnowledge !== 'boolean') {
      throw new CommunityValidationError(
        'Traditional knowledge flag must be boolean'
      );
    }

    if (typeof protocols.communityApprovalRequired !== 'boolean') {
      throw new CommunityValidationError(
        'Community approval flag must be boolean'
      );
    }

    if (
      !protocols.dataRetentionPolicy ||
      typeof protocols.dataRetentionPolicy !== 'string'
    ) {
      throw new CommunityValidationError(
        'Data retention policy must be a string'
      );
    }

    if (
      !protocols.accessRestrictions ||
      !Array.isArray(protocols.accessRestrictions)
    ) {
      throw new CommunityValidationError(
        'Access restrictions must be an array'
      );
    }

    // Validate language preferences format (support ISO 639-1, 639-2, 639-3 codes)
    const validLanguagePattern = /^[a-z]{2,3}(-[A-Z]{2})?$/;
    for (const lang of protocols.languagePreferences) {
      if (typeof lang !== 'string' || !validLanguagePattern.test(lang)) {
        throw new CommunityValidationError(
          `Invalid language code format: ${lang}. Use format like 'en', 'es', 'mic', 'en-US'`
        );
      }
    }

    // Validate data retention policy values
    const validRetentionPolicies = [
      'indefinite',
      'community-controlled',
      'time-limited-5years',
      'time-limited-10years',
      'delete-on-request',
    ];
    if (!validRetentionPolicies.includes(protocols.dataRetentionPolicy)) {
      throw new CommunityValidationError(
        `Invalid data retention policy: ${protocols.dataRetentionPolicy}`
      );
    }

    return JSON.stringify(protocols);
  }

  /**
   * Validate community creation request
   * @param data - Community creation data
   */
  private validateCreateRequest(data: CreateCommunityRequest): void {
    // Validate name
    if (!data.name?.trim()) {
      throw new CommunityValidationError('Community name is required');
    }

    if (data.name.length < 2) {
      throw new CommunityValidationError(
        'Community name must be at least 2 characters long'
      );
    }

    if (data.name.length > 100) {
      throw new CommunityValidationError(
        'Community name cannot exceed 100 characters'
      );
    }

    // Validate description
    if (data.description && data.description.length > 1000) {
      throw new CommunityValidationError(
        'Description cannot exceed 1000 characters'
      );
    }

    // Validate locale (support ISO 639-1, 639-2, 639-3 codes)
    if (data.locale) {
      const validLocalePattern = /^[a-z]{2,3}(-[A-Z]{2})?$/;
      if (!validLocalePattern.test(data.locale)) {
        throw new CommunityValidationError(
          'Invalid locale format. Use format like "en", "es", "mic", "en-US"'
        );
      }
    }

    // Validate slug if provided
    if (data.slug) {
      if (data.slug.length < 3 || data.slug.length > 50) {
        throw new CommunityValidationError(
          'Slug must be between 3 and 50 characters'
        );
      }

      const validSlugPattern = /^[a-z0-9-]+$/;
      if (!validSlugPattern.test(data.slug)) {
        throw new CommunityValidationError(
          'Slug can only contain lowercase letters, numbers, and hyphens'
        );
      }

      if (data.slug.startsWith('-') || data.slug.endsWith('-')) {
        throw new CommunityValidationError(
          'Slug cannot start or end with hyphens'
        );
      }
    }
  }

  /**
   * Create a new community with validation and cultural protocol setup
   * @param data - Community creation data
   * @returns Promise<Community> - Created community
   */
  async createCommunity(data: CreateCommunityRequest): Promise<Community> {
    try {
      // Validate input data
      this.validateCreateRequest(data);

      // Process cultural settings
      const culturalSettingsJson = this.validateCulturalSettings(
        data.culturalSettings
      );

      // Prepare repository data
      const repositoryData: CreateCommunityData = {
        name: data.name.trim(),
        description: data.description?.trim(),
        slug: data.slug,
        publicStories: data.publicStories ?? false,
        locale: data.locale || 'en',
        culturalSettings: culturalSettingsJson,
        isActive: data.isActive ?? true,
      };

      // Create community through repository
      const community = await this.communityRepository.create(repositoryData);

      return community;
    } catch (error) {
      // Re-throw validation errors
      if (error instanceof CommunityValidationError) {
        throw error;
      }

      // Handle repository errors
      if (error instanceof Error) {
        if (error.name === 'DuplicateSlugError') {
          throw new CommunityValidationError('Community slug already exists');
        }
        if (error.name === 'InvalidCommunityDataError') {
          throw new CommunityValidationError(error.message);
        }
      }

      // Wrap other errors
      throw new CommunityOperationError(
        `Failed to create community: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Get community by ID with optional enhanced data
   * @param id - Community ID
   * @param includeStats - Include additional statistics
   * @returns Promise<CommunityResponseSchema | null> - Community data or null if not found
   */
  async getCommunityById(
    id: number,
    includeStats = false
  ): Promise<CommunityResponseSchema | null> {
    try {
      const community = await this.communityRepository.findById(id);
      if (!community) {
        return null;
      }

      const response: CommunityResponseSchema = {
        id: community.id,
        name: community.name,
        description: community.description,
        slug: community.slug,
        publicStories: community.publicStories,
        locale: community.locale,
        culturalSettings: community.culturalSettings,
        isActive: community.isActive,
        createdAt:
          community.createdAt instanceof Date
            ? community.createdAt.toISOString()
            : new Date(community.createdAt).toISOString(),
        updatedAt:
          community.updatedAt instanceof Date
            ? community.updatedAt.toISOString()
            : new Date(community.updatedAt).toISOString(),
      };

      // Parse cultural settings if present
      if (community.culturalSettings) {
        try {
          response.culturalProtocols = JSON.parse(community.culturalSettings);
        } catch {
          // Ignore parsing errors for cultural settings
        }
      }

      // TODO: Add statistics when user/story repositories are available
      if (includeStats) {
        // These would be implemented once we have user/story services
        // response.memberCount = await this.userService.countByCommunity(id);
        // response.storyCount = await this.storyService.countByCommunity(id);
        // response.lastActivityDate = await this.getLastActivity(id);
      }

      return response;
    } catch (error) {
      throw new CommunityOperationError(
        `Failed to get community: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Get community by slug
   * @param slug - Community slug
   * @returns Promise<Community | null> - Community or null if not found
   */
  async getCommunityBySlug(slug: string): Promise<Community | null> {
    try {
      if (!slug?.trim()) {
        return null;
      }

      return await this.communityRepository.findBySlug(
        slug.trim().toLowerCase()
      );
    } catch (error) {
      throw new CommunityOperationError(
        `Failed to get community by slug: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Search communities with filters and pagination
   * @param params - Search parameters
   * @returns Promise<CommunitySearchResponse> - Search results with metadata
   */
  async searchCommunities(
    params: CommunitySearchParams = {}
  ): Promise<CommunitySearchResponse> {
    try {
      const { limit = 20, offset = 0 } = params;

      // Validate pagination parameters
      if (limit < 1 || limit > 100) {
        throw new CommunityValidationError('Limit must be between 1 and 100');
      }

      if (offset < 0) {
        throw new CommunityValidationError('Offset must be non-negative');
      }

      // Get communities and total count
      const [communities, total] = await Promise.all([
        this.communityRepository.search(params),
        this.communityRepository.count(params.isActive),
      ]);

      return {
        communities,
        total,
        limit,
        offset,
        hasMore: offset + communities.length < total,
      };
    } catch (error) {
      if (error instanceof CommunityValidationError) {
        throw error;
      }

      throw new CommunityOperationError(
        `Failed to search communities: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Get all active communities with pagination
   * @param limit - Maximum communities to return
   * @param offset - Number of communities to skip
   * @returns Promise<CommunitySearchResponse> - Active communities
   */
  async getActiveCommunities(
    limit = 20,
    offset = 0
  ): Promise<CommunitySearchResponse> {
    return this.searchCommunities({ isActive: true, limit, offset });
  }

  /**
   * Update community with validation
   * @param id - Community ID
   * @param updates - Update data
   * @returns Promise<Community> - Updated community
   */
  async updateCommunity(
    id: number,
    updates: UpdateCommunityRequest
  ): Promise<Community> {
    try {
      // Validate ID
      if (!Number.isInteger(id) || id <= 0) {
        throw new CommunityValidationError('Invalid community ID');
      }

      // Validate updates
      if (updates.name !== undefined) {
        if (!updates.name?.trim()) {
          throw new CommunityValidationError('Community name cannot be empty');
        }
        if (updates.name.length < 2) {
          throw new CommunityValidationError(
            'Community name must be at least 2 characters long'
          );
        }
        if (updates.name.length > 100) {
          throw new CommunityValidationError(
            'Community name cannot exceed 100 characters'
          );
        }
      }

      if (
        updates.description !== undefined &&
        updates.description &&
        updates.description.length > 1000
      ) {
        throw new CommunityValidationError(
          'Description cannot exceed 1000 characters'
        );
      }

      if (updates.locale) {
        const validLocalePattern = /^[a-z]{2,3}(-[A-Z]{2})?$/;
        if (!validLocalePattern.test(updates.locale)) {
          throw new CommunityValidationError(
            'Invalid locale format. Use format like "en", "es", "mic", "en-US"'
          );
        }
      }

      // Process cultural settings
      const culturalSettingsJson = this.validateCulturalSettings(
        updates.culturalSettings
      );

      // Prepare repository data
      const repositoryData: UpdateCommunityData = {
        name: updates.name?.trim(),
        description: updates.description?.trim(),
        publicStories: updates.publicStories,
        locale: updates.locale,
        culturalSettings: culturalSettingsJson,
        isActive: updates.isActive,
      };

      // Remove undefined values
      const cleanData = Object.fromEntries(
        Object.entries(repositoryData).filter(
          ([_, value]) => value !== undefined
        )
      );

      // Update community through repository
      const updatedCommunity = await this.communityRepository.update(
        id,
        cleanData
      );

      if (!updatedCommunity) {
        throw new CommunityOperationError('Community not found');
      }

      return updatedCommunity;
    } catch (error) {
      if (
        error instanceof CommunityValidationError ||
        error instanceof CommunityOperationError
      ) {
        throw error;
      }

      // Handle repository errors
      if (error instanceof Error) {
        if (error.name === 'CommunityNotFoundError') {
          throw new CommunityOperationError('Community not found');
        }
        if (error.name === 'InvalidCommunityDataError') {
          throw new CommunityValidationError(error.message);
        }
      }

      throw new CommunityOperationError(
        `Failed to update community: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Delete community (hard delete)
   * @param id - Community ID
   * @returns Promise<boolean> - True if deleted, false if not found
   */
  async deleteCommunity(id: number): Promise<boolean> {
    try {
      // Validate ID
      if (!Number.isInteger(id) || id <= 0) {
        throw new CommunityValidationError('Invalid community ID');
      }

      return await this.communityRepository.delete(id);
    } catch (error) {
      if (error instanceof CommunityValidationError) {
        throw error;
      }

      // Handle repository errors
      if (error instanceof Error) {
        if (error.name === 'InvalidCommunityDataError') {
          throw new CommunityOperationError(error.message);
        }
      }

      throw new CommunityOperationError(
        `Failed to delete community: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Deactivate community (soft delete)
   * @param id - Community ID
   * @returns Promise<boolean> - True if deactivated, false if not found
   */
  async deactivateCommunity(id: number): Promise<boolean> {
    try {
      // Validate ID
      if (!Number.isInteger(id) || id <= 0) {
        throw new CommunityValidationError('Invalid community ID');
      }

      return await this.communityRepository.deactivate(id);
    } catch (error) {
      if (error instanceof CommunityValidationError) {
        throw error;
      }

      throw new CommunityOperationError(
        `Failed to deactivate community: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Reactivate community
   * @param id - Community ID
   * @returns Promise<boolean> - True if reactivated, false if not found
   */
  async reactivateCommunity(id: number): Promise<boolean> {
    try {
      // Validate ID
      if (!Number.isInteger(id) || id <= 0) {
        throw new CommunityValidationError('Invalid community ID');
      }

      return await this.communityRepository.reactivate(id);
    } catch (error) {
      if (error instanceof CommunityValidationError) {
        throw error;
      }

      throw new CommunityOperationError(
        `Failed to reactivate community: ${error instanceof Error ? error.message : 'Unknown error'}`
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
      if (!slug?.trim()) {
        return false;
      }

      const cleanSlug = slug.trim().toLowerCase();

      // Validate slug format
      if (cleanSlug.length < 3 || cleanSlug.length > 50) {
        return false;
      }

      const validSlugPattern = /^[a-z0-9-]+$/;
      if (!validSlugPattern.test(cleanSlug)) {
        return false;
      }

      if (cleanSlug.startsWith('-') || cleanSlug.endsWith('-')) {
        return false;
      }

      return await this.communityRepository.isSlugAvailable(
        cleanSlug,
        excludeId
      );
    } catch (error) {
      throw new CommunityOperationError(
        `Failed to check slug availability: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Get community count with optional filters
   * @param isActive - Filter by active status
   * @returns Promise<number> - Number of communities
   */
  async getCommunityCount(isActive?: boolean): Promise<number> {
    try {
      return await this.communityRepository.count(isActive);
    } catch (error) {
      throw new CommunityOperationError(
        `Failed to get community count: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Update cultural protocols for a community
   * @param id - Community ID
   * @param protocols - New cultural protocols
   * @returns Promise<Community> - Updated community
   */
  async updateCulturalProtocols(
    id: number,
    protocols: CulturalProtocols
  ): Promise<Community> {
    try {
      const culturalSettingsJson = this.validateCulturalSettings(protocols);

      return await this.updateCommunity(id, {
        culturalSettings: culturalSettingsJson,
      });
    } catch (error) {
      if (error instanceof CommunityValidationError) {
        throw error;
      }

      throw new CommunityOperationError(
        `Failed to update cultural protocols: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Get cultural protocols for a community
   * @param id - Community ID
   * @returns Promise<CulturalProtocols | null> - Cultural protocols or null
   */
  async getCulturalProtocols(id: number): Promise<CulturalProtocols | null> {
    try {
      const community = await this.communityRepository.findById(id);

      if (!community || !community.culturalSettings) {
        return null;
      }

      try {
        return JSON.parse(community.culturalSettings);
      } catch {
        return null;
      }
    } catch (error) {
      throw new CommunityOperationError(
        `Failed to get cultural protocols: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Super Admin Methods
   * These methods provide cross-community access for super admin users only
   */

  /**
   * Get all communities with pagination (super admin only)
   * @param page - Page number (1-indexed)
   * @param limit - Number of communities per page
   * @param search - Optional search term
   * @param locale - Optional locale filter
   * @param active - Optional active status filter
   * @returns Promise<{data: Community[], meta: PaginationMeta}> - Paginated communities
   */
  async getAllCommunitiesForSuperAdmin(options: {
    page?: number;
    limit?: number;
    search?: string;
    locale?: string;
    active?: boolean;
  } = {}): Promise<{
    data: CommunityResponse[];
    meta: {
      page: number;
      limit: number;
      total: number;
      totalPages: number;
    };
  }> {
    try {
      const { page = 1, limit = 20, search, locale, active } = options;

      // Validate pagination
      if (page < 1) {
        throw new CommunityValidationError('Page must be at least 1');
      }
      if (limit < 1 || limit > 100) {
        throw new CommunityValidationError('Limit must be between 1 and 100');
      }

      const offset = (page - 1) * limit;
      
      // Build search params
      const searchParams: CommunitySearchParams = {
        limit,
        offset,
        query: search,
        locale,
        isActive: active,
      };

      // Get communities and count
      const [communities, total] = await Promise.all([
        this.communityRepository.search(searchParams),
        this.communityRepository.count(active),
      ]);

      // Add user count for each community (placeholder for now)
      const data = communities.map((community) => ({
        id: community.id,
        name: community.name,
        description: community.description,
        slug: community.slug,
        locale: community.locale,
        publicStories: community.publicStories,
        isActive: community.isActive,
        userCount: 0, // TODO: Implement actual user count
        createdAt: community.createdAt instanceof Date 
          ? community.createdAt.toISOString() 
          : new Date(community.createdAt).toISOString(),
        updatedAt: community.updatedAt instanceof Date 
          ? community.updatedAt.toISOString() 
          : new Date(community.updatedAt).toISOString(),
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
      if (error instanceof CommunityValidationError) {
        throw error;
      }

      throw new CommunityOperationError(
        `Failed to get communities for super admin: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
    }
  }

  /**
   * Create community as super admin (with enhanced permissions)
   * @param data - Community creation data
   * @returns Promise<Community> - Created community
   */
  async createCommunityAsSuperAdmin(
    data: CreateCommunityRequest
  ): Promise<Community> {
    try {
      // Super admin can create communities with more relaxed validation
      // and without community-scoped restrictions
      return await this.createCommunity(data);
    } catch (error) {
      throw new CommunityOperationError(
        `Super admin failed to create community: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
    }
  }

  /**
   * Update community as super admin (with enhanced permissions)
   * @param id - Community ID
   * @param updates - Update data
   * @returns Promise<Community> - Updated community
   */
  async updateCommunityAsSuperAdmin(
    id: number,
    updates: UpdateCommunityRequest
  ): Promise<Community> {
    try {
      // Super admin can update any community
      return await this.updateCommunity(id, updates);
    } catch (error) {
      throw new CommunityOperationError(
        `Super admin failed to update community: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
    }
  }

  /**
   * Archive community as super admin (soft delete)
   * @param id - Community ID
   * @returns Promise<{message: string, id: number}> - Success response
   */
  async archiveCommunityAsSuperAdmin(id: number): Promise<{
    message: string;
    id: number;
  }> {
    try {
      // Validate ID
      if (!Number.isInteger(id) || id <= 0) {
        throw new CommunityValidationError('Invalid community ID');
      }

      // Check if community exists
      const community = await this.communityRepository.findById(id);
      if (!community) {
        throw new CommunityOperationError('Community not found');
      }

      // Archive the community
      const success = await this.deactivateCommunity(id);
      if (!success) {
        throw new CommunityOperationError('Failed to archive community');
      }

      return {
        message: 'Community archived successfully',
        id,
      };
    } catch (error) {
      if (
        error instanceof CommunityValidationError ||
        error instanceof CommunityOperationError
      ) {
        throw error;
      }

      throw new CommunityOperationError(
        `Super admin failed to archive community: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
    }
  }
}

// Re-export types for convenience
export type {
  Community,
  CommunitySearchParams,
  CulturalProtocols,
  CommunityStats,
  CommunityNotFoundError,
  DuplicateSlugError,
  InvalidCommunityDataError,
};
