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

import { PlaceRepository } from '../repositories/place.repository.js';
import type {
  Place,
  CreatePlaceData,
  UpdatePlaceData,
  NearbySearchParams,
  BoundsSearchParams,
  CommunityPlaceParams,
  PaginatedResponse,
  InvalidBoundsError,
} from '../repositories/place.repository.js';
import { validateCoordinates } from '../db/schema/places.js';

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
 * Custom error classes
 */
export class CulturalProtocolViolationError extends Error {
  constructor(message = 'Cultural protocol access violation') {
    super(message);
    this.name = 'CulturalProtocolViolationError';
  }
}

export class InsufficientPermissionsError extends Error {
  constructor(message = 'Insufficient permissions for this operation') {
    super(message);
    this.name = 'InsufficientPermissionsError';
  }
}

export class PlaceNotFoundError extends Error {
  constructor(message = 'Place not found') {
    super(message);
    this.name = 'PlaceNotFoundError';
  }
}

export class InvalidCoordinatesError extends Error {
  constructor(message = 'Invalid coordinates') {
    super(message);
    this.name = 'InvalidCoordinatesError';
  }
}

export { InvalidBoundsError };

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
      throw new Error('Invalid geographic coordinates provided');
    }

    // Validate media URLs if provided
    if (data.mediaUrls) {
      this.validateMediaUrls(data.mediaUrls);
    }

    // Handle cultural restrictions
    if (data.isRestricted && data.culturalSignificance) {
      // Only admin/elder can create restricted places
      if (userRole && !['admin', 'elder'].includes(userRole)) {
        throw new InsufficientPermissionsError('Only administrators and elders can create restricted places');
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
   * Get place by ID with community isolation and cultural protocol checks
   */
  async getPlaceById(
    id: number,
    communityId: number,
    userRole?: UserRole
  ): Promise<Place> {
    const place = await this.repository.getByIdWithCommunityCheck(id, communityId);
    
    if (!place) {
      throw new Error('Place not found');
    }

    // Check cultural protocol access
    if (place.isRestricted && userRole !== 'elder') {
      throw new CulturalProtocolViolationError('Access to this sacred place is restricted to elders');
    }

    return place;
  }

  /**
   * Get paginated places for a community with cultural protocol filtering
   */
  async getPlacesByCommunity(
    communityId: number,
    params: Omit<CommunityPlaceParams, 'includeRestricted'>,
    userRole?: UserRole
  ): Promise<PaginatedResponse<Place>> {
    // Determine if user can see restricted places
    const includeRestricted = userRole === 'elder' || userRole === 'admin';

    const searchParams: CommunityPlaceParams = {
      ...params,
      includeRestricted,
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
    const existingPlace = await this.repository.getByIdWithCommunityCheck(id, communityId);
    
    if (!existingPlace) {
      throw new PlaceNotFoundError('Place not found');
    }

    // Check cultural protocol permissions
    if (existingPlace.isRestricted && userRole !== 'elder' && userRole !== 'admin') {
      throw new CulturalProtocolViolationError('Only elders and administrators can modify restricted places');
    }

    // Validate update data
    if (data.name !== undefined) {
      this.validatePlaceName(data.name);
    }

    if (data.latitude !== undefined && data.longitude !== undefined) {
      if (!validateCoordinates(data.latitude, data.longitude)) {
        throw new InvalidCoordinatesError('Invalid geographic coordinates provided');
      }
    }

    if (data.mediaUrls) {
      this.validateMediaUrls(data.mediaUrls);
    }

    // Check permissions for creating restricted places
    if (data.isRestricted && !existingPlace.isRestricted) {
      if (userRole && !['admin', 'elder'].includes(userRole)) {
        throw new InsufficientPermissionsError('Only administrators and elders can mark places as restricted');
      }
    }

    // Prepare update data
    const updateData: UpdatePlaceData = {
      ...(data.name !== undefined && { name: data.name.trim() }),
      ...(data.description !== undefined && { description: data.description?.trim() }),
      ...(data.latitude !== undefined && { latitude: data.latitude }),
      ...(data.longitude !== undefined && { longitude: data.longitude }),
      ...(data.region !== undefined && { region: data.region?.trim() }),
      ...(data.mediaUrls !== undefined && { mediaUrls: data.mediaUrls }),
      ...(data.culturalSignificance !== undefined && { culturalSignificance: data.culturalSignificance?.trim() }),
      ...(data.isRestricted !== undefined && { isRestricted: data.isRestricted }),
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
      throw new InsufficientPermissionsError('Only administrators and elders can delete places');
    }

    // Check if place exists in the community
    const existingPlace = await this.repository.getByIdWithCommunityCheck(id, communityId);
    
    if (!existingPlace) {
      throw new PlaceNotFoundError('Place not found');
    }

    // TODO: In the future, we should also check for story associations and handle them appropriately
    // For now, the repository will handle cascade operations

    return await this.repository.delete(id);
  }

  /**
   * Search places near a geographic point
   */
  async searchPlacesNear(
    params: NearbySearchRequest & { communityId: number },
    userRole?: UserRole
  ): Promise<PaginatedResponse<Place>> {
    // Validate search coordinates
    if (!validateCoordinates(params.latitude, params.longitude)) {
      throw new Error('Invalid search coordinates provided');
    }

    // Validate radius
    if (params.radiusKm <= 0 || params.radiusKm > 1000) {
      throw new Error('Search radius must be between 0 and 1000 kilometers');
    }

    // Determine if user can see restricted places
    const includeRestricted = userRole === 'elder' || userRole === 'admin';

    const searchParams: NearbySearchParams = {
      communityId: params.communityId,
      latitude: params.latitude,
      longitude: params.longitude,
      radiusKm: params.radiusKm,
      page: params.page || 1,
      limit: Math.min(params.limit || 20, 100), // Cap at 100 results
      includeRestricted,
    };

    return await this.repository.searchNear(searchParams);
  }

  /**
   * Search places within a bounding box
   */
  async getPlacesByBounds(
    params: BoundsSearchRequest & { communityId: number },
    userRole?: UserRole
  ): Promise<PaginatedResponse<Place>> {
    // Validate bounding box
    if (params.north <= params.south || params.east <= params.west) {
      throw new Error('Invalid bounding box: north must be > south, east must be > west');
    }

    if (!validateCoordinates(params.north, params.west) || !validateCoordinates(params.south, params.east)) {
      throw new Error('Invalid bounding box coordinates');
    }

    // Determine if user can see restricted places
    const includeRestricted = userRole === 'elder' || userRole === 'admin';

    const searchParams: BoundsSearchParams = {
      communityId: params.communityId,
      north: params.north,
      south: params.south,
      east: params.east,
      west: params.west,
      page: params.page || 1,
      limit: Math.min(params.limit || 20, 100), // Cap at 100 results
      includeRestricted,
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
   * Get community place statistics
   */
  async getCommunityPlaceStats(communityId: number): Promise<{
    total: number;
    restricted: number;
    public: number;
    withStories: number;
  }> {
    return await this.repository.getCommunityPlaceStats(communityId);
  }

  /**
   * Validate place data
   */
  private validatePlaceData(data: CreatePlaceRequest): void {
    this.validatePlaceName(data.name);

    if (data.description && data.description.length > 2000) {
      throw new Error('Description cannot exceed 2000 characters');
    }

    if (data.region && data.region.length > 100) {
      throw new Error('Region name cannot exceed 100 characters');
    }

    if (data.culturalSignificance && data.culturalSignificance.length > 1000) {
      throw new Error('Cultural significance description cannot exceed 1000 characters');
    }
  }

  /**
   * Validate place name
   */
  private validatePlaceName(name: string): void {
    if (!name || name.trim().length === 0) {
      throw new Error('Place name is required');
    }

    if (name.length > 200) {
      throw new Error('Place name cannot exceed 200 characters');
    }
  }

  /**
   * Validate media URLs
   */
  private validateMediaUrls(urls: string[]): void {
    if (urls.length > 10) {
      throw new Error('Cannot have more than 10 media URLs per place');
    }

    for (const url of urls) {
      try {
        new URL(url);
      } catch {
        throw new Error(`Invalid URL format: ${url}`);
      }

      // Basic security check for URL schemes
      const parsedUrl = new URL(url);
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        throw new Error(`Unsupported URL scheme: ${parsedUrl.protocol}`);
      }
    }
  }
}