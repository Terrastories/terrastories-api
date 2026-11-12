/**
 * Place Service
 *
 * Business logic for place management with Indigenous data sovereignty,
 * cultural protocol support, PostGIS spatial operations, and comprehensive CRUD operations.
 *
 * Features:
 * - Complete place lifecycle management
 * - Cultural protocol enforcement (elder access, sacred places)
 * - Geographic search operations (distance, bounds)
 * - Community isolation and data sovereignty
 * - Story-place association management
 * - Media URL validation and integration
 * - Comprehensive error handling and validation
 */

import {
  PlaceRepository,
  type Place,
  type CreatePlaceData,
  type UpdatePlaceData,
  type NearbySearchParams,
  type BoundsSearchParams,
  type CommunityPlaceParams,
  type PaginatedResponse,
} from '../repositories/place.repository.js';
import { validateCoordinates } from '../db/schema/places.js';
import {
  InsufficientPermissionsError,
  PlaceNotFoundError,
  InvalidCoordinatesError,
  InvalidMediaUrlError,
  InvalidBoundsError,
  InvalidRadiusError,
  InvalidFieldLengthError,
  RequiredFieldError,
} from '../shared/errors/index.js';
import { storyAccessForPhysicalRole } from '../shared/authorization/sovereignty-policy.js';

/**
 * Request data for place creation
 */
export interface CreatePlaceRequest {
  name: string;
  description?: string;
  latitude: number;
  longitude: number;
  region?: string;
  mediaUrls?: string[];
  culturalSignificance?: string;
  isRestricted?: boolean;
}

/**
 * Request data for place updates
 */
export interface UpdatePlaceRequest {
  name?: string;
  description?: string;
  latitude?: number;
  longitude?: number;
  region?: string;
  mediaUrls?: string[];
  culturalSignificance?: string;
  isRestricted?: boolean;
}

/**
 * Geographic search request parameters
 */
export interface NearbySearchRequest {
  latitude: number;
  longitude: number;
  radiusKm: number;
  page?: number;
  limit?: number;
}

/**
 * Bounding box search request parameters
 */
export interface BoundsSearchRequest {
  north: number;
  south: number;
  east: number;
  west: number;
  page?: number;
  limit?: number;
}

/**
 * User role types for cultural protocol enforcement
 */
export type UserRole = 'super_admin' | 'admin' | 'editor' | 'viewer' | 'elder';

/**
 * Place Service Class
 *
 * Provides complete business logic for places with cultural protocol enforcement
 */
export class PlaceService {
  private repository: PlaceRepository;

  constructor(repository: PlaceRepository) {
    this.repository = repository;
  }

  /**
   * Create a new place with validation and cultural protocol enforcement
   */
  async createPlace(
    data: CreatePlaceRequest,
    communityId: number,
    userId: number,
    userRole?: UserRole
  ): Promise<Place> {
    // Validate input data
    this.validatePlaceData(data);

    // Validate coordinates
    if (!validateCoordinates(data.latitude, data.longitude)) {
      throw new InvalidCoordinatesError(data.latitude, data.longitude);
    }

    // Validate media URLs if provided
    if (data.mediaUrls) {
      this.validateMediaUrls(data.mediaUrls);
    }

    // Handle cultural restrictions
    if (data.isRestricted && data.culturalSignificance) {
      // Only admin/elder can create restricted places
      if (userRole && !['admin', 'elder'].includes(userRole)) {
        throw new InsufficientPermissionsError(
          'Only administrators and elders can create restricted places'
        );
      }
    }

    // Create place data for repository
    const createData: CreatePlaceData = {
      name: data.name.trim(),
      description: data.description?.trim(),
      latitude: data.latitude,
      longitude: data.longitude,
      region: data.region?.trim(),
      mediaUrls: data.mediaUrls || [],
      culturalSignificance: data.culturalSignificance?.trim(),
      isRestricted: data.isRestricted || false,
    };

    return await this.repository.create({ ...createData, communityId });
  }

  /**
   * Get place by ID with community isolation and cultural protocol checks.
   * A restricted place (`is_restricted = true`) is unavailable in V2 runtime
   * to EVERY role (SPEC-V2 §6.4) — admin, editor, viewer, and the legacy
   * `elder` role included — so a direct read masks as 404, never 403 (no
   * existence leak).
   */
  async getPlaceById(
    id: number,
    communityId: number,
    _userRole?: UserRole
  ): Promise<Place> {
    const place = await this.repository.getByIdWithCommunityCheck(
      id,
      communityId
    );

    if (!place) {
      throw new PlaceNotFoundError(id);
    }

    // Unavailable rows are indistinguishable from nonexistent ones.

    if (place.isRestricted) {
      throw new PlaceNotFoundError(id);
    }

    return place;
  }

  /**
   * Get paginated places for a community. Restricted places are unavailable
   * to every role (SPEC-V2 §6.4), so they are always excluded from the
   * listing regardless of the caller's role.
   */
  async getPlacesByCommunity(
    communityId: number,
    params: Omit<CommunityPlaceParams, 'includeRestricted'>,
    _userRole?: UserRole
  ): Promise<PaginatedResponse<Place>> {
    const searchParams: CommunityPlaceParams = {
      ...params,
      includeRestricted: false,
    };

    return await this.repository.getByCommunity(communityId, searchParams);
  }

  /**
   * Update place with cultural protocol enforcement
   */
  async updatePlace(
    id: number,
    data: UpdatePlaceRequest,
    communityId: number,
    userId: number,
    userRole?: UserRole
  ): Promise<Place> {
    // Get existing place to check permissions
    const existingPlace = await this.repository.getByIdWithCommunityCheck(
      id,
      communityId
    );

    if (!existingPlace) {
      throw new PlaceNotFoundError('Place not found');
    }

    // A restricted place is unavailable to every role (SPEC-V2 §6.4): the
    // update masks as 404 rather than revealing the restriction.
    if (existingPlace.isRestricted) {
      throw new PlaceNotFoundError(id);
    }

    // Validate update data
    if (data.name !== undefined) {
      this.validatePlaceName(data.name);
    }

    if (data.latitude !== undefined && data.longitude !== undefined) {
      if (!validateCoordinates(data.latitude, data.longitude)) {
        throw new InvalidCoordinatesError(data.latitude, data.longitude);
      }
    }

    if (data.mediaUrls) {
      this.validateMediaUrls(data.mediaUrls);
    }

    // Check permissions for creating restricted places
    if (data.isRestricted && !existingPlace.isRestricted) {
      if (userRole && !['admin', 'elder'].includes(userRole)) {
        throw new InsufficientPermissionsError(
          'Only administrators and elders can mark places as restricted'
        );
      }
    }

    // Prepare update data
    const updateData: UpdatePlaceData = {
      ...(data.name !== undefined && { name: data.name.trim() }),
      ...(data.description !== undefined && {
        description: data.description?.trim(),
      }),
      ...(data.latitude !== undefined && { latitude: data.latitude }),
      ...(data.longitude !== undefined && { longitude: data.longitude }),
      ...(data.region !== undefined && { region: data.region?.trim() }),
      ...(data.mediaUrls !== undefined && { mediaUrls: data.mediaUrls }),
      ...(data.culturalSignificance !== undefined && {
        culturalSignificance: data.culturalSignificance?.trim(),
      }),
      ...(data.isRestricted !== undefined && {
        isRestricted: data.isRestricted,
      }),
    };

    const updated = await this.repository.update(id, updateData);

    if (!updated) {
      throw new PlaceNotFoundError('Place not found or update failed');
    }

    return updated;
  }

  /**
   * Delete place with permission checks
   */
  async deletePlace(
    id: number,
    communityId: number,
    userId: number,
    userRole?: UserRole
  ): Promise<boolean> {
    // Only admin/elder can delete places
    if (userRole && !['admin', 'elder'].includes(userRole)) {
      throw new InsufficientPermissionsError(
        'Only administrators and elders can delete places'
      );
    }

    // Check if place exists in the community
    const existingPlace = await this.repository.getByIdWithCommunityCheck(
      id,
      communityId
    );

    if (!existingPlace) {
      throw new PlaceNotFoundError('Place not found');
    }

    // A restricted place is unavailable to every role (SPEC-V2 §6.4): the
    // deletion masks as 404 rather than revealing the restriction.
    if (existingPlace.isRestricted) {
      throw new PlaceNotFoundError(id);
    }

    // TODO: In the future, we should also check for story associations and handle them appropriately
    // For now, the repository will handle cascade operations

    return await this.repository.delete(id);
  }

  /**
   * Search places near a geographic point. Restricted places are unavailable
   * to every role (SPEC-V2 §6.4) and stay excluded from nearby search.
   */
  async searchPlacesNear(
    params: NearbySearchRequest & { communityId: number },
    _userRole?: UserRole
  ): Promise<PaginatedResponse<Place>> {
    // Validate search coordinates
    if (!validateCoordinates(params.latitude, params.longitude)) {
      throw new InvalidCoordinatesError(params.latitude, params.longitude);
    }

    // Validate radius
    if (params.radiusKm <= 0 || params.radiusKm > 1000) {
      throw new InvalidRadiusError(params.radiusKm, 0, 1000);
    }

    const searchParams: NearbySearchParams = {
      communityId: params.communityId,
      latitude: params.latitude,
      longitude: params.longitude,
      radiusKm: params.radiusKm,
      page: params.page || 1,
      limit: Math.min(params.limit || 20, 100), // Cap at 100 results
      includeRestricted: false,
    };

    return await this.repository.searchNear(searchParams);
  }

  /**
   * Search places within a bounding box. Restricted places are unavailable
   * to every role (SPEC-V2 §6.4) and stay excluded from bounds search.
   */
  async getPlacesByBounds(
    params: BoundsSearchRequest & { communityId: number },
    _userRole?: UserRole
  ): Promise<PaginatedResponse<Place>> {
    // Validate bounding box
    if (params.north <= params.south || params.east <= params.west) {
      throw new InvalidBoundsError(
        'Invalid bounding box: north must be > south, east must be > west'
      );
    }

    if (
      !validateCoordinates(params.north, params.west) ||
      !validateCoordinates(params.south, params.east)
    ) {
      throw new InvalidCoordinatesError();
    }

    const searchParams: BoundsSearchParams = {
      communityId: params.communityId,
      north: params.north,
      south: params.south,
      east: params.east,
      west: params.west,
      page: params.page || 1,
      limit: Math.min(params.limit || 20, 100), // Cap at 100 results
      includeRestricted: false,
    };

    return await this.repository.searchInBounds(searchParams);
  }

  /**
   * Get places associated with a story
   */
  async getPlacesByStory(storyId: number): Promise<Place[]> {
    return await this.repository.getPlacesByStory(storyId);
  }

  /**
   * Get community place statistics (SPEC-V2 §6.4). Count metadata is a
   * projection: restricted Fastify places are unavailable in V2 runtime to
   * EVERY role, so they are never counted and the `restricted` key never
   * appears — `total`/`public` cover unrestricted places only. `withStories`
   * counts only places linked to stories the caller may read (the
   * intersection of place and story access); the legacy `elder` and unknown
   * roles get the same story reach as V2 member.
   */
  async getCommunityPlaceStats(
    communityId: number,
    role: string
  ): Promise<{
    total: number;
    restricted?: number;
    public: number;
    withStories: number;
  }> {
    // Physical role -> runtime story accesses (SPEC-V2 §6.2: Fastify
    // `viewer` reasons as V2 `member`; legacy `elder` keeps member reach;
    // unknown roles hold none, so withStories fails closed to 0).
    return await this.repository.getCommunityPlaceStats(communityId, {
      includeRestricted: false,
      storyAudiences: storyAccessForPhysicalRole(role),
    });
  }

  /**
   * Validate place data
   */
  private validatePlaceData(data: CreatePlaceRequest): void {
    this.validatePlaceName(data.name);

    if (data.description && data.description.length > 2000) {
      throw new InvalidFieldLengthError(
        'Description',
        2000,
        data.description.length
      );
    }

    if (data.region && data.region.length > 100) {
      throw new InvalidFieldLengthError('Region name', 100, data.region.length);
    }

    if (data.culturalSignificance && data.culturalSignificance.length > 1000) {
      throw new InvalidFieldLengthError(
        'Cultural significance description',
        1000,
        data.culturalSignificance.length
      );
    }
  }

  /**
   * Validate place name
   */
  private validatePlaceName(name: string): void {
    if (!name || name.trim().length === 0) {
      throw new RequiredFieldError('Place name');
    }

    if (name.length > 200) {
      throw new InvalidFieldLengthError('Place name', 200, name.length);
    }
  }

  /**
   * Validate media URLs
   */
  private validateMediaUrls(urls: string[]): void {
    if (urls.length > 10) {
      throw new InvalidFieldLengthError('Media URLs', 10, urls.length);
    }

    for (const url of urls) {
      try {
        new URL(url);
      } catch {
        throw new InvalidMediaUrlError(url);
      }

      // Basic security check for URL schemes
      const parsedUrl = new URL(url);
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        throw new InvalidMediaUrlError(
          `Unsupported URL scheme: ${parsedUrl.protocol} for ${url}`
        );
      }
    }
  }
}
