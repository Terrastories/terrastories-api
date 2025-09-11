/**
 * Themes Service
 *
 * Business logic layer for theme management with comprehensive cultural protocol
 * enforcement, data sovereignty protection, and Indigenous community oversight.
 * Handles map visualization themes with geographic boundaries and Mapbox integration.
 *
 * Features:
 * - Full CRUD operations with cultural protocol validation
 * - Data sovereignty enforcement (super admin blocking)
 * - Geographic bounds validation and coordinate management
 * - Mapbox style URL integration and validation
 * - Community data isolation and multi-tenant support
 * - Comprehensive audit logging for Indigenous oversight
 * - Performance optimization with caching and efficient queries
 */

import type {
  ThemesRepository,
  PaginatedResponse,
  FindThemesParams,
  SearchThemesParams,
} from '../repositories/themes.repository.js';
import type { Theme, CreateTheme, UpdateTheme } from '../db/schema/themes.js';
import type { Logger } from '../shared/types/index.js';

/**
 * Cultural protocols for theme access and modifications
 */
export interface ThemeCulturalProtocols {
  communityRestricted?: boolean;
  elderApprovalRequired?: boolean;
  culturalSignificance?: string;
  accessNotes?: string;
}

/**
 * Theme creation input with cultural protocols
 */
export interface ThemeCreateInput {
  name: string;
  description?: string;
  mapboxStyleUrl?: string;
  mapboxAccessToken?: string;
  centerLat?: number;
  centerLong?: number;
  swBoundaryLat?: number;
  swBoundaryLong?: number;
  neBoundaryLat?: number;
  neBoundaryLong?: number;
  active?: boolean;
  communityId: number;
  culturalProtocols?: ThemeCulturalProtocols;
}

/**
 * Theme update input with cultural protocols
 */
export interface ThemeUpdateInput {
  name?: string;
  description?: string;
  mapboxStyleUrl?: string;
  mapboxAccessToken?: string;
  centerLat?: number;
  centerLong?: number;
  swBoundaryLat?: number;
  swBoundaryLong?: number;
  neBoundaryLat?: number;
  neBoundaryLong?: number;
  active?: boolean;
  culturalProtocols?: ThemeCulturalProtocols;
}

/**
 * Cultural access validation result
 */
interface CulturalAccessResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Theme search and filter options
 */
export interface ThemeSearchOptions extends FindThemesParams {
  activeOnly?: boolean;
  withBounds?: boolean;
  withMapbox?: boolean;
  searchTerm?: string;
}

/**
 * Custom error classes for specific scenarios
 */
export class ThemeServiceError extends Error {
  constructor(message = 'Theme service error') {
    super(message);
    this.name = 'ThemeServiceError';
  }
}

export class ThemeNotFoundServiceError extends Error {
  constructor(message = 'Theme not found') {
    super(message);
    this.name = 'ThemeNotFoundServiceError';
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

export class InvalidGeographicBoundsError extends Error {
  constructor(message = 'Invalid geographic bounds') {
    super(message);
    this.name = 'InvalidGeographicBoundsError';
  }
}

export class InvalidMapboxConfigError extends Error {
  constructor(message = 'Invalid Mapbox configuration') {
    super(message);
    this.name = 'InvalidMapboxConfigError';
  }
}

export class ThemesService {
  constructor(
    private readonly themesRepository: ThemesRepository,
    private readonly logger: Logger
  ) {}

  /**
   * Create a new theme with cultural protocol validation
   */
  async createTheme(
    input: ThemeCreateInput,
    userId: number,
    userRole: string,
    userCommunityId: number | null
  ): Promise<Theme> {
    this.logger.info('Creating theme', {
      name: input.name,
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
        'Can only create themes in your own community'
      );
    }

    // Validate geographic bounds if provided
    if (this.hasBoundaryCoordinates(input)) {
      this.validateGeographicBounds(
        input.swBoundaryLat!,
        input.swBoundaryLong!,
        input.neBoundaryLat!,
        input.neBoundaryLong!
      );
    }

    // Validate center coordinates if provided
    if (input.centerLat !== undefined && input.centerLong !== undefined) {
      this.validateCenterCoordinates(input.centerLat, input.centerLong);
    }

    // Validate Mapbox configuration
    if (input.mapboxStyleUrl) {
      this.validateMapboxConfig(input.mapboxStyleUrl);
    }

    // Validate cultural protocols
    await this.validateCulturalProtocols(
      input.culturalProtocols,
      userRole,
      input.communityId
    );

    const createData: CreateTheme = {
      name: input.name,
      description: input.description,
      mapboxStyleUrl: input.mapboxStyleUrl,
      mapboxAccessToken: input.mapboxAccessToken,
      centerLat: input.centerLat,
      centerLong: input.centerLong,
      swBoundaryLat: input.swBoundaryLat,
      swBoundaryLong: input.swBoundaryLong,
      neBoundaryLat: input.neBoundaryLat,
      neBoundaryLong: input.neBoundaryLong,
      active: input.active ?? false,
      communityId: input.communityId,
    };

    try {
      const theme = await this.themesRepository.create(createData);

      // Audit log for Indigenous oversight
      this.auditLog('CREATE_THEME', userId, userRole, {
        themeId: theme.id,
        themeName: theme.name,
        communityId: theme.communityId,
        culturalProtocols: input.culturalProtocols,
      });

      this.logger.info('Theme created successfully', {
        themeId: theme.id,
        userId,
        communityId: theme.communityId,
      });

      return theme;
    } catch (error) {
      this.logger.error('Failed to create theme', {
        error: error instanceof Error ? error.message : String(error),
        userId,
        communityId: input.communityId,
      });
      throw this.handleRepositoryError(error);
    }
  }

  /**
   * Get theme by ID with community isolation and cultural protocol enforcement
   */
  async getThemeById(
    id: number,
    userId: number,
    userRole: string,
    userCommunityId: number | null
  ): Promise<Theme | null> {
    this.logger.debug('Getting theme by ID', { themeId: id, userId, userRole });

    try {
      let theme: Theme | null = null;

      // Super admins are blocked from accessing community data (data sovereignty)
      if (userRole === 'super_admin') {
        throw new DataSovereigntyViolationError(
          'Super admins cannot access community theme data'
        );
      }

      // For other roles, use community isolation
      if (userCommunityId !== null) {
        theme = await this.themesRepository.findByIdWithCommunityCheck(
          id,
          userCommunityId
        );
      } else {
        // Handle edge case where user has no community
        return null;
      }

      if (!theme) {
        return null;
      }

      // Validate cultural access
      const accessResult = await this.validateCulturalAccess(
        theme,
        userRole,
        userCommunityId
      );

      if (!accessResult.allowed) {
        this.logger.warn('Cultural access denied for theme', {
          themeId: id,
          userId,
          reason: accessResult.reason,
        });
        return null;
      }

      // Audit log for access tracking
      this.auditLog('ACCESS_THEME', userId, userRole, {
        themeId: theme.id,
        themeName: theme.name,
        communityId: theme.communityId,
      });

      return theme;
    } catch (error) {
      this.logger.error('Failed to get theme by ID', {
        themeId: id,
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw this.handleRepositoryError(error);
    }
  }

  /**
   * List themes for a community with pagination and filtering
   */
  async listThemes(
    options: ThemeSearchOptions,
    userId: number,
    userRole: string,
    userCommunityId: number | null
  ): Promise<PaginatedResponse<Theme>> {
    this.logger.debug('Listing themes', {
      options,
      userId,
      userRole,
      userCommunityId,
    });

    // Data sovereignty check
    if (userRole === 'super_admin') {
      throw new DataSovereigntyViolationError(
        'Super admins cannot access community theme data'
      );
    }

    if (!userCommunityId) {
      throw new InsufficientPermissionsError(
        'User must belong to a community to access themes'
      );
    }

    try {
      let result: PaginatedResponse<Theme>;

      if (options.searchTerm) {
        // Use search functionality
        const searchParams: SearchThemesParams = {
          query: options.searchTerm,
          page: options.page,
          limit: options.limit,
          sortBy: options.sortBy,
          sortOrder: options.sortOrder,
        };
        result = await this.themesRepository.searchThemes(
          userCommunityId,
          searchParams
        );
      } else {
        // Use regular pagination
        const findParams: FindThemesParams = {
          page: options.page,
          limit: options.limit,
          sortBy: options.sortBy,
          sortOrder: options.sortOrder,
        };
        result = (await this.themesRepository.findByCommunityId(
          userCommunityId,
          findParams
        )) as PaginatedResponse<Theme>;
      }

      // Filter by additional options
      let filteredData = result.data;

      if (options.activeOnly) {
        filteredData = filteredData.filter((theme) => theme.active);
      }

      if (options.withBounds) {
        filteredData = filteredData.filter(
          (theme) =>
            theme.swBoundaryLat &&
            theme.swBoundaryLong &&
            theme.neBoundaryLat &&
            theme.neBoundaryLong
        );
      }

      if (options.withMapbox) {
        filteredData = filteredData.filter((theme) => theme.mapboxStyleUrl);
      }

      // Apply cultural protocol filtering
      const accessibleThemes: Theme[] = [];
      for (const theme of filteredData) {
        const accessResult = await this.validateCulturalAccess(
          theme,
          userRole,
          userCommunityId
        );
        if (accessResult.allowed) {
          accessibleThemes.push(theme);
        }
      }

      // Audit log for bulk access
      this.auditLog('LIST_THEMES', userId, userRole, {
        communityId: userCommunityId,
        resultCount: accessibleThemes.length,
        options,
      });

      return {
        data: accessibleThemes,
        total: accessibleThemes.length,
        page: options.page,
        limit: options.limit,
        pages: Math.ceil(accessibleThemes.length / options.limit),
      };
    } catch (error) {
      this.logger.error('Failed to list themes', {
        userId,
        userCommunityId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw this.handleRepositoryError(error);
    }
  }

  /**
   * Get active themes for a community
   */
  async getActiveThemes(
    userId: number,
    userRole: string,
    userCommunityId: number | null
  ): Promise<Theme[]> {
    this.logger.debug('Getting active themes', {
      userId,
      userRole,
      userCommunityId,
    });

    // Data sovereignty check
    if (userRole === 'super_admin') {
      throw new DataSovereigntyViolationError(
        'Super admins cannot access community theme data'
      );
    }

    if (!userCommunityId) {
      return [];
    }

    try {
      const themes =
        await this.themesRepository.findActiveThemes(userCommunityId);

      // Apply cultural protocol filtering
      const accessibleThemes: Theme[] = [];
      for (const theme of themes) {
        const accessResult = await this.validateCulturalAccess(
          theme,
          userRole,
          userCommunityId
        );
        if (accessResult.allowed) {
          accessibleThemes.push(theme);
        }
      }

      // Audit log
      this.auditLog('LIST_ACTIVE_THEMES', userId, userRole, {
        communityId: userCommunityId,
        resultCount: accessibleThemes.length,
      });

      return accessibleThemes;
    } catch (error) {
      this.logger.error('Failed to get active themes', {
        userId,
        userCommunityId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw this.handleRepositoryError(error);
    }
  }

  /**
   * Update theme with cultural protocol validation
   */
  async updateTheme(
    id: number,
    input: ThemeUpdateInput,
    userId: number,
    userRole: string,
    userCommunityId: number | null
  ): Promise<Theme | null> {
    this.logger.info('Updating theme', {
      themeId: id,
      userId,
      userRole,
      updates: Object.keys(input),
    });

    // Validate permissions
    this.validateUpdatePermissions(userRole);

    // Get existing theme with community check
    const existingTheme = await this.getThemeById(
      id,
      userId,
      userRole,
      userCommunityId
    );

    if (!existingTheme) {
      throw new ThemeNotFoundServiceError(`Theme with ID ${id} not found`);
    }

    // Validate geographic bounds if being updated
    if (this.hasBoundaryCoordinatesUpdate(input)) {
      const bounds = this.buildCompleteBounds(existingTheme, input);
      this.validateGeographicBounds(
        bounds.swLat,
        bounds.swLng,
        bounds.neLat,
        bounds.neLng
      );
    }

    // Validate center coordinates if being updated
    if (input.centerLat !== undefined && input.centerLong !== undefined) {
      this.validateCenterCoordinates(input.centerLat, input.centerLong);
    }

    // Validate Mapbox configuration if being updated
    if (input.mapboxStyleUrl !== undefined) {
      this.validateMapboxConfig(input.mapboxStyleUrl);
    }

    // Validate cultural protocols
    await this.validateCulturalProtocols(
      input.culturalProtocols,
      userRole,
      existingTheme.communityId
    );

    const updateData: UpdateTheme = {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.description !== undefined && {
        description: input.description,
      }),
      ...(input.mapboxStyleUrl !== undefined && {
        mapboxStyleUrl: input.mapboxStyleUrl,
      }),
      ...(input.mapboxAccessToken !== undefined && {
        mapboxAccessToken: input.mapboxAccessToken,
      }),
      ...(input.centerLat !== undefined && { centerLat: input.centerLat }),
      ...(input.centerLong !== undefined && { centerLong: input.centerLong }),
      ...(input.swBoundaryLat !== undefined && {
        swBoundaryLat: input.swBoundaryLat,
      }),
      ...(input.swBoundaryLong !== undefined && {
        swBoundaryLong: input.swBoundaryLong,
      }),
      ...(input.neBoundaryLat !== undefined && {
        neBoundaryLat: input.neBoundaryLat,
      }),
      ...(input.neBoundaryLong !== undefined && {
        neBoundaryLong: input.neBoundaryLong,
      }),
      ...(input.active !== undefined && { active: input.active }),
    };

    try {
      const updatedTheme = await this.themesRepository.updateWithCommunityCheck(
        id,
        existingTheme.communityId,
        updateData
      );

      if (!updatedTheme) {
        throw new ThemeNotFoundServiceError(`Theme with ID ${id} not found`);
      }

      // Audit log for updates
      this.auditLog('UPDATE_THEME', userId, userRole, {
        themeId: id,
        themeName: updatedTheme.name,
        communityId: updatedTheme.communityId,
        updates: Object.keys(input),
        culturalProtocols: input.culturalProtocols,
      });

      this.logger.info('Theme updated successfully', {
        themeId: id,
        userId,
        communityId: updatedTheme.communityId,
      });

      return updatedTheme;
    } catch (error) {
      this.logger.error('Failed to update theme', {
        themeId: id,
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw this.handleRepositoryError(error);
    }
  }

  /**
   * Delete theme with cultural protocol validation
   */
  async deleteTheme(
    id: number,
    userId: number,
    userRole: string,
    userCommunityId: number | null
  ): Promise<boolean> {
    this.logger.info('Deleting theme', { themeId: id, userId, userRole });

    // Validate permissions
    this.validateDeletePermissions(userRole);

    // Get existing theme with community check
    const existingTheme = await this.getThemeById(
      id,
      userId,
      userRole,
      userCommunityId
    );

    if (!existingTheme) {
      throw new ThemeNotFoundServiceError(`Theme with ID ${id} not found`);
    }

    // Validate cultural protocols for deletion
    await this.validateDeletionProtocols(existingTheme, userRole);

    try {
      const deleted = await this.themesRepository.deleteWithCommunityCheck(
        id,
        existingTheme.communityId
      );

      if (deleted) {
        // Audit log for deletion
        this.auditLog('DELETE_THEME', userId, userRole, {
          themeId: id,
          themeName: existingTheme.name,
          communityId: existingTheme.communityId,
        });

        this.logger.info('Theme deleted successfully', {
          themeId: id,
          userId,
          communityId: existingTheme.communityId,
        });
      }

      return deleted;
    } catch (error) {
      this.logger.error('Failed to delete theme', {
        themeId: id,
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw this.handleRepositoryError(error);
    }
  }

  /**
   * Get theme statistics for a community
   */
  async getThemeStats(
    userId: number,
    userRole: string,
    userCommunityId: number | null
  ): Promise<{
    total: number;
    active: number;
    inactive: number;
    withMapbox: number;
    withBounds: number;
  }> {
    this.logger.debug('Getting theme statistics', {
      userId,
      userRole,
      userCommunityId,
    });

    // Data sovereignty check
    if (userRole === 'super_admin') {
      throw new DataSovereigntyViolationError(
        'Super admins cannot access community theme statistics'
      );
    }

    if (!userCommunityId) {
      return {
        total: 0,
        active: 0,
        inactive: 0,
        withMapbox: 0,
        withBounds: 0,
      };
    }

    try {
      const stats =
        await this.themesRepository.getCommunityThemeStats(userCommunityId);

      // Audit log
      this.auditLog('GET_THEME_STATS', userId, userRole, {
        communityId: userCommunityId,
        stats,
      });

      return stats;
    } catch (error) {
      this.logger.error('Failed to get theme statistics', {
        userId,
        userCommunityId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw this.handleRepositoryError(error);
    }
  }

  /**
   * Validate data sovereignty - prevent super admin access to community data
   */
  private async validateDataSovereignty(
    userId: number,
    userRole: string,
    userCommunityId: number | null,
    targetCommunityId: number
  ): Promise<void> {
    if (userRole === 'super_admin') {
      throw new DataSovereigntyViolationError(
        'Super admins cannot access community data - this violates Indigenous data sovereignty'
      );
    }

    // Additional validation for community members
    if (userCommunityId && userCommunityId !== targetCommunityId) {
      throw new DataSovereigntyViolationError(
        'Cannot access themes from other communities'
      );
    }
  }

  /**
   * Validate creation permissions
   */
  private validateCreationPermissions(userRole: string): void {
    const allowedRoles = ['admin', 'editor'];
    if (!allowedRoles.includes(userRole)) {
      throw new InsufficientPermissionsError(
        'Only admins and editors can create themes'
      );
    }
  }

  /**
   * Validate update permissions
   */
  private validateUpdatePermissions(userRole: string): void {
    const allowedRoles = ['admin', 'editor'];
    if (!allowedRoles.includes(userRole)) {
      throw new InsufficientPermissionsError(
        'Only admins and editors can update themes'
      );
    }
  }

  /**
   * Validate delete permissions
   */
  private validateDeletePermissions(userRole: string): void {
    const allowedRoles = ['admin'];
    if (!allowedRoles.includes(userRole)) {
      throw new InsufficientPermissionsError('Only admins can delete themes');
    }
  }

  /**
   * Validate cultural access to a theme
   */
  private async validateCulturalAccess(
    theme: Theme,
    userRole: string,
    userCommunityId: number | null
  ): Promise<CulturalAccessResult> {
    // Basic community isolation check
    if (theme.communityId !== userCommunityId) {
      return {
        allowed: false,
        reason: 'Theme belongs to different community',
      };
    }

    // For now, allow all community members to access themes
    // Future enhancement: implement elder-only or restricted themes
    return { allowed: true };
  }

  /**
   * Validate cultural protocols
   */
  private async validateCulturalProtocols(
    protocols: ThemeCulturalProtocols | undefined,
    userRole: string,
    _communityId: number
  ): Promise<void> {
    if (!protocols) return;

    if (protocols.elderApprovalRequired && userRole !== 'elder') {
      throw new CulturalProtocolViolationError(
        'Elder approval required for this theme operation'
      );
    }

    // Additional cultural validations can be added here
  }

  /**
   * Validate deletion protocols
   */
  private async validateDeletionProtocols(
    theme: Theme,
    userRole: string
  ): Promise<void> {
    // Check if theme is active and has cultural significance
    if (theme.active && userRole !== 'admin') {
      throw new CulturalProtocolViolationError(
        'Only admins can delete active themes with potential cultural significance'
      );
    }
  }

  /**
   * Validate geographic bounds
   */
  private validateGeographicBounds(
    swLat: number,
    swLng: number,
    neLat: number,
    neLng: number
  ): void {
    // Validate coordinate ranges
    if (!this.isValidLatitude(swLat) || !this.isValidLatitude(neLat)) {
      throw new InvalidGeographicBoundsError(
        'Latitude must be between -90 and 90 degrees'
      );
    }

    if (!this.isValidLongitude(swLng) || !this.isValidLongitude(neLng)) {
      throw new InvalidGeographicBoundsError(
        'Longitude must be between -180 and 180 degrees'
      );
    }

    // Validate bounds relationship
    if (swLat >= neLat) {
      throw new InvalidGeographicBoundsError(
        'Southwest latitude must be less than northeast latitude'
      );
    }

    if (swLng >= neLng) {
      throw new InvalidGeographicBoundsError(
        'Southwest longitude must be less than northeast longitude'
      );
    }
  }

  /**
   * Validate center coordinates
   */
  private validateCenterCoordinates(lat: number, lng: number): void {
    if (!this.isValidLatitude(lat)) {
      throw new InvalidGeographicBoundsError(
        'Center latitude must be between -90 and 90 degrees'
      );
    }

    if (!this.isValidLongitude(lng)) {
      throw new InvalidGeographicBoundsError(
        'Center longitude must be between -180 and 180 degrees'
      );
    }
  }

  /**
   * Validate Mapbox configuration
   */
  private validateMapboxConfig(styleUrl?: string): void {
    if (styleUrl && !styleUrl.startsWith('mapbox://styles/')) {
      throw new InvalidMapboxConfigError(
        'Mapbox style URL must start with "mapbox://styles/"'
      );
    }
  }

  /**
   * Check if input has boundary coordinates
   */
  private hasBoundaryCoordinates(input: ThemeCreateInput): boolean {
    return (
      input.swBoundaryLat !== undefined &&
      input.swBoundaryLong !== undefined &&
      input.neBoundaryLat !== undefined &&
      input.neBoundaryLong !== undefined
    );
  }

  /**
   * Check if update input has boundary coordinates
   */
  private hasBoundaryCoordinatesUpdate(input: ThemeUpdateInput): boolean {
    return (
      input.swBoundaryLat !== undefined ||
      input.swBoundaryLong !== undefined ||
      input.neBoundaryLat !== undefined ||
      input.neBoundaryLong !== undefined
    );
  }

  /**
   * Build complete bounds from existing theme and update input
   */
  private buildCompleteBounds(
    existing: Theme,
    input: ThemeUpdateInput
  ): {
    swLat: number;
    swLng: number;
    neLat: number;
    neLng: number;
  } {
    return {
      swLat:
        input.swBoundaryLat !== undefined
          ? input.swBoundaryLat
          : Number(existing.swBoundaryLat) || 0,
      swLng:
        input.swBoundaryLong !== undefined
          ? input.swBoundaryLong
          : Number(existing.swBoundaryLong) || 0,
      neLat:
        input.neBoundaryLat !== undefined
          ? input.neBoundaryLat
          : Number(existing.neBoundaryLat) || 0,
      neLng:
        input.neBoundaryLong !== undefined
          ? input.neBoundaryLong
          : Number(existing.neBoundaryLong) || 0,
    };
  }

  /**
   * Validate latitude value
   */
  private isValidLatitude(lat: number): boolean {
    return typeof lat === 'number' && !isNaN(lat) && lat >= -90 && lat <= 90;
  }

  /**
   * Validate longitude value
   */
  private isValidLongitude(lng: number): boolean {
    return typeof lng === 'number' && !isNaN(lng) && lng >= -180 && lng <= 180;
  }

  /**
   * Handle repository errors and convert to service errors
   */
  private handleRepositoryError(error: unknown): Error {
    if (error instanceof Error) {
      if (error.name === 'CommunityNotFoundError') {
        return new ThemeServiceError('Community not found');
      }

      if (error.name === 'ThemeNotFoundError') {
        return new ThemeNotFoundServiceError('Theme not found');
      }

      if (error.name === 'InvalidCoordinatesError') {
        return new InvalidGeographicBoundsError(error.message);
      }

      if (error.name === 'InvalidMapboxUrlError') {
        return new InvalidMapboxConfigError(error.message);
      }

      // Return original error if not recognized
      return error;
    }

    // Convert unknown error to Error type
    return new ThemeServiceError(String(error));
  }

  /**
   * Audit logging for Indigenous oversight and compliance
   */
  private auditLog(
    action: string,
    userId: number,
    userRole: string,
    details: Record<string, unknown>
  ): void {
    try {
      this.logger.info('THEMES_AUDIT', {
        action,
        userId,
        userRole,
        timestamp: new Date().toISOString(),
        ...details,
      });
    } catch (error) {
      // Don't let audit logging failures affect main operation
      this.logger.error('Failed to write audit log', {
        action,
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
