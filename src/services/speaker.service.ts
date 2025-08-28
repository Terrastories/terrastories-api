/**
 * Speaker Service
 *
 * Business logic for speaker management with Indigenous cultural protocols,
 * elder status recognition, and community data sovereignty enforcement.
 *
 * Features:
 * - Complete speaker lifecycle management
 * - Cultural protocol enforcement (elder access, sacred knowledge)
 * - Community isolation and data sovereignty
 * - Elder status recognition and permission validation
 * - Comprehensive error handling and validation
 * - Audit logging for cultural compliance
 */

import {
  SpeakerRepository,
  type Speaker,
  type CommunitySpeakerParams,
  type SpeakerSearchParams,
  type PaginatedResponse,
  type SpeakerStats,
} from '../repositories/speaker.repository.js';
import {
  SpeakerNotFoundError,
  InsufficientPermissionsError,
  RequiredFieldError,
  InvalidFieldLengthError,
  InvalidMediaUrlError,
  CulturalProtocolViolationError,
  InvalidPaginationError,
  InvalidSearchQueryError,
  InvalidBirthYearError,
} from '../shared/errors/index.js';

/**
 * Request data for speaker creation
 */
export interface CreateSpeakerRequest {
  name: string;
  bio?: string;
  photoUrl?: string;
  birthYear?: number;
  elderStatus?: boolean;
  culturalRole?: string;
  isActive?: boolean;
}

/**
 * Request data for speaker updates
 */
export interface UpdateSpeakerRequest {
  name?: string;
  bio?: string;
  photoUrl?: string;
  birthYear?: number;
  elderStatus?: boolean;
  culturalRole?: string;
  isActive?: boolean;
}

/**
 * Speaker listing request parameters
 */
export interface ListSpeakersRequest {
  page?: number;
  limit?: number;
  elderOnly?: boolean;
  culturalRole?: string;
  activeOnly?: boolean;
  sortBy?: 'name' | 'created_at' | 'updated_at';
  sortOrder?: 'asc' | 'desc';
}

/**
 * Speaker search request parameters
 */
export interface SearchSpeakersRequest {
  page?: number;
  limit?: number;
}

/**
 * User role types for cultural protocol enforcement
 */
export type UserRole = 'super_admin' | 'admin' | 'editor' | 'viewer' | 'elder';

/**
 * Speaker Service Class
 *
 * Provides complete business logic for speakers with cultural protocol enforcement
 */
export class SpeakerService {
  private repository: SpeakerRepository;

  constructor(repository: SpeakerRepository) {
    this.repository = repository;
  }

  /**
   * Create a new speaker with cultural protocol validation
   */
  async createSpeaker(
    data: CreateSpeakerRequest,
    communityId: number,
    userId: number,
    userRole: UserRole
  ): Promise<Speaker> {
    // Validate permissions for speaker creation
    if (userRole === 'viewer') {
      throw new InsufficientPermissionsError('Viewers cannot create speakers');
    }

    // Validate elder creation permissions
    if (data.elderStatus && !['admin', 'super_admin'].includes(userRole)) {
      throw new InsufficientPermissionsError(
        'Only admins can create elder speakers'
      );
    }

    // Validate input data
    this.validateSpeakerData(data);

    // Create speaker
    const speaker = await this.repository.create({
      ...data,
      communityId,
    });

    // Audit logging for elder creation
    if (speaker.elderStatus) {
      console.log(
        `Elder speaker created: ID ${speaker.id}, Name: ${speaker.name}, Community: ${communityId}, CreatedBy: ${userId}`
      );
    }

    return speaker;
  }

  /**
   * Get speaker by ID with community isolation
   */
  async getSpeakerById(id: number, communityId: number): Promise<Speaker> {
    const speaker = await this.repository.getByIdWithCommunityCheck(
      id,
      communityId
    );

    if (!speaker) {
      throw new SpeakerNotFoundError();
    }

    return speaker;
  }

  /**
   * Get paginated speakers for a community
   */
  async getSpeakersByCommunity(
    communityId: number,
    params: ListSpeakersRequest,
    userId: number,
    userRole: UserRole
  ): Promise<PaginatedResponse<Speaker>> {
    // Validate pagination parameters
    const page = params.page !== undefined ? params.page : 1;
    const limit = params.limit !== undefined ? params.limit : 20;

    if (page < 1 || limit < 1 || limit > 100) {
      throw new InvalidPaginationError(
        'Page must be >= 1 and limit must be between 1-100'
      );
    }

    // Build repository parameters
    const repositoryParams: CommunitySpeakerParams = {
      page,
      limit,
      elderOnly: params.elderOnly || false,
      culturalRole: params.culturalRole,
      activeOnly:
        params.activeOnly !== undefined
          ? params.activeOnly
          : !['admin', 'super_admin'].includes(userRole),
      sortBy: params.sortBy || 'name',
      sortOrder: params.sortOrder || 'asc',
    };

    return await this.repository.getByCommunity(communityId, repositoryParams);
  }

  /**
   * Update speaker with cultural protocol enforcement
   */
  async updateSpeaker(
    id: number,
    data: UpdateSpeakerRequest,
    communityId: number,
    userId: number,
    userRole: UserRole
  ): Promise<Speaker> {
    // Get existing speaker to check permissions
    const existingSpeaker = await this.repository.getByIdWithCommunityCheck(
      id,
      communityId
    );

    if (!existingSpeaker) {
      throw new SpeakerNotFoundError();
    }

    // Enforce elder update permissions
    if (
      existingSpeaker.elderStatus &&
      !['admin', 'super_admin'].includes(userRole)
    ) {
      throw new InsufficientPermissionsError(
        'Only admins can update elder speakers'
      );
    }

    // Prevent elder status changes by non-admins
    if (
      data.elderStatus !== undefined &&
      !['admin', 'super_admin'].includes(userRole)
    ) {
      throw new InsufficientPermissionsError(
        'Insufficient permissions to modify elder status'
      );
    }

    // Validate update data
    this.validateSpeakerData(data, true);

    // Update speaker
    const updatedSpeaker = await this.repository.update(id, data);

    if (!updatedSpeaker) {
      throw new SpeakerNotFoundError();
    }

    // Audit logging for elder updates
    if (existingSpeaker.elderStatus) {
      console.log(
        `Elder speaker updated: ID ${id}, Community: ${communityId}, UpdatedBy: ${userId}`
      );
    }

    return updatedSpeaker;
  }

  /**
   * Delete speaker with enhanced elder protection
   */
  async deleteSpeaker(
    id: number,
    communityId: number,
    userId: number,
    userRole: UserRole
  ): Promise<boolean> {
    // Only admins can delete speakers
    if (!['admin', 'super_admin'].includes(userRole)) {
      throw new InsufficientPermissionsError('Only admins can delete speakers');
    }

    // Get existing speaker to check elder status
    const existingSpeaker = await this.repository.getByIdWithCommunityCheck(
      id,
      communityId
    );

    if (!existingSpeaker) {
      throw new SpeakerNotFoundError();
    }

    // Enhanced protection for elder speakers
    if (existingSpeaker.elderStatus) {
      throw new CulturalProtocolViolationError(
        'Elder speakers require special authorization to delete'
      );
    }

    // Delete speaker
    const deleted = await this.repository.delete(id);

    // Audit logging
    if (deleted) {
      console.log(
        `Speaker deleted: ID ${id}, Name: ${existingSpeaker.name}, Community: ${communityId}, DeletedBy: ${userId}`
      );
    }

    return deleted;
  }

  /**
   * Search speakers by name
   */
  async searchSpeakers(
    communityId: number,
    query: string,
    params: SearchSpeakersRequest,
    _userId: number,
    _userRole: UserRole
  ): Promise<PaginatedResponse<Speaker>> {
    // Validate search query
    if (!query || query.trim().length === 0) {
      throw new RequiredFieldError('query');
    }

    if (query.trim().length < 2) {
      throw new InvalidSearchQueryError(2);
    }

    // Validate pagination
    const page = params.page || 1;
    const limit = params.limit || 20;

    const searchParams: SpeakerSearchParams = {
      page,
      limit,
    };

    return await this.repository.searchByName(
      communityId,
      query.trim(),
      searchParams
    );
  }

  /**
   * Get community speaker statistics
   */
  async getCommunityStats(communityId: number): Promise<SpeakerStats> {
    return await this.repository.getCommunityStats(communityId);
  }

  /**
   * Validate speaker data with cultural protocol considerations
   */
  private validateSpeakerData(
    data: CreateSpeakerRequest | UpdateSpeakerRequest,
    isUpdate = false
  ): void {
    // Name validation
    if (!isUpdate && (!data.name || data.name.trim().length === 0)) {
      throw new RequiredFieldError('name');
    }

    if (data.name !== undefined) {
      if (!data.name || data.name.trim().length === 0) {
        throw new RequiredFieldError('name');
      }
      if (data.name.length > 200) {
        throw new InvalidFieldLengthError('name', 200, data.name.length);
      }
    }

    // Bio validation
    if (data.bio && data.bio.length > 2000) {
      throw new InvalidFieldLengthError('bio', 2000, data.bio.length);
    }

    // Photo URL validation
    if (data.photoUrl) {
      try {
        new URL(data.photoUrl);
      } catch {
        throw new InvalidMediaUrlError(data.photoUrl);
      }
    }

    // Birth year validation
    if (data.birthYear !== undefined) {
      const currentYear = new Date().getFullYear();
      if (data.birthYear < 1900 || data.birthYear > currentYear) {
        throw new InvalidBirthYearError(data.birthYear, 1900, currentYear);
      }
    }

    // Cultural role validation
    if (data.culturalRole && data.culturalRole.length > 100) {
      throw new InvalidFieldLengthError(
        'culturalRole',
        100,
        data.culturalRole.length
      );
    }
  }
}
