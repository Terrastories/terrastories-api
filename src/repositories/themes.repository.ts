import { eq, and, desc, count, sql, type SQL } from 'drizzle-orm';
import {
  type Theme,
  type NewTheme,
  type CreateTheme,
  type UpdateTheme,
} from '../db/schema/themes.js';
import {
  containsInsensitive,
  dialectOf,
  tablesFor,
  textOrder,
  type Dialect,
  type DialectTables,
} from '../db/dialect.js';
import type { Database } from '../db/index.js';

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  pages: number;
}

export interface ThemesPaginatedResponse {
  themes: Theme[];
  total: number;
  page: number;
  totalPages: number;
}

export interface FindThemesParams {
  page: number;
  limit: number;
  sortBy?: 'name' | 'created_at' | 'updated_at';
  sortOrder?: 'asc' | 'desc';
}

export interface SearchThemesParams extends FindThemesParams {
  query: string;
}

export class CommunityNotFoundError extends Error {
  constructor(communityId?: number) {
    super(
      communityId
        ? `Community with ID ${communityId} not found`
        : 'Community not found'
    );
    this.name = 'CommunityNotFoundError';
  }
}

export class ThemeNotFoundError extends Error {
  constructor(themeId?: number) {
    super(themeId ? `Theme with ID ${themeId} not found` : 'Theme not found');
    this.name = 'ThemeNotFoundError';
  }
}

export class InvalidCoordinatesError extends Error {
  constructor(lat?: number, lng?: number) {
    super(
      lat !== undefined && lng !== undefined
        ? `Invalid coordinates: lat=${lat}, lng=${lng}`
        : 'Invalid coordinates'
    );
    this.name = 'InvalidCoordinatesError';
  }
}

export class InvalidMapboxUrlError extends Error {
  constructor(url: string) {
    super(`Invalid Mapbox style URL: ${url}`);
    this.name = 'InvalidMapboxUrlError';
  }
}

/**
 * Validate geographic coordinates
 */
function validateCoordinates(lat: number, lng: number): boolean {
  return (
    typeof lat === 'number' &&
    typeof lng === 'number' &&
    !isNaN(lat) &&
    !isNaN(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

/**
 * Validate latitude coordinate
 */
function isValidLatitude(lat: number): boolean {
  return typeof lat === 'number' && !isNaN(lat) && lat >= -90 && lat <= 90;
}

/**
 * Validate longitude coordinate
 */
function isValidLongitude(lng: number): boolean {
  return typeof lng === 'number' && !isNaN(lng) && lng >= -180 && lng <= 180;
}

/**
 * Validate Mapbox style URL
 */
function validateMapboxUrl(url: string): boolean {
  if (!url) return true; // Optional field
  return url.startsWith('mapbox://styles/');
}

/**
 * PostgreSQL stores theme coordinates as numeric(10,6) and rounds to 6
 * decimals; SQLite real keeps the full double. Round in the application on
 * every write so both backends store and return the same value.
 */
function roundCoordinate<T extends number | null | undefined>(value: T): T {
  if (value === null || value === undefined) return value;
  return (Math.round(value * 1e6) / 1e6) as T;
}

/**
 * Validate geographic bounds
 */
function validateGeographicBounds(
  swLat?: number,
  swLng?: number,
  neLat?: number,
  neLng?: number
): boolean {
  // If any bound is provided, all must be provided
  if (
    swLat !== undefined ||
    swLng !== undefined ||
    neLat !== undefined ||
    neLng !== undefined
  ) {
    if (
      swLat === undefined ||
      swLng === undefined ||
      neLat === undefined ||
      neLng === undefined
    ) {
      return false;
    }

    // Validate individual coordinates
    if (
      !validateCoordinates(swLat, swLng) ||
      !validateCoordinates(neLat, neLng)
    ) {
      return false;
    }

    // Validate bounds relationship
    return swLat < neLat && swLng < neLng;
  }

  return true; // All bounds are optional
}

// Database type union for compatibility
type DatabaseType = Database;

export class ThemesRepository {
  private database: DatabaseType;
  private readonly dialect: Dialect;
  private readonly tables: DialectTables;

  constructor(database: DatabaseType) {
    this.database = database;
    // Pick tables from the Drizzle instance itself so the same repository
    // runs against SQLite/D1 and PostgreSQL (previously always SQLite tables).
    this.dialect = dialectOf(database);
    this.tables = tablesFor(database);
  }

  private get themesTable() {
    return this.tables.themes;
  }

  /** Name order that is identical on both backends, with an id tiebreak. */
  private nameOrder(direction: 'asc' | 'desc' = 'asc'): SQL[] {
    return [
      textOrder(this.dialect, this.themesTable.name, direction),
      direction === 'desc'
        ? desc(this.themesTable.id)
        : sql`${this.themesTable.id} ASC`,
    ];
  }

  /** Requested sort column, then id, so pages are deterministic. */
  private sortOrder(sortBy: string, sortOrder: 'asc' | 'desc'): SQL[] {
    if (sortBy === 'name') return this.nameOrder(sortOrder);
    const column =
      sortBy === 'created_at'
        ? this.themesTable.createdAt
        : this.themesTable.updatedAt;
    return sortOrder === 'desc'
      ? [desc(column), desc(this.themesTable.id)]
      : [sql`${column} ASC`, sql`${this.themesTable.id} ASC`];
  }

  /** Case-insensitive name-or-description match, same on both backends. */
  private nameOrDescription(query: string): SQL {
    return sql`(${containsInsensitive(this.dialect, this.themesTable.name, query)} OR ${containsInsensitive(this.dialect, this.themesTable.description, query)})`;
  }

  // Type-safe database query wrapper - cast to any to handle union type
  private get db() {
    // Cast to any to resolve union type issues - both drizzle instances have compatible query interfaces
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this.database as any;
  }

  /**
   * Create a new theme with validation
   */
  async create(data: CreateTheme & { communityId: number }): Promise<Theme> {
    // Allow creation with any coordinates - validation happens separately
    // This follows the test pattern of "create first, validate later"

    // Validate Mapbox URL if provided
    if (data.mapboxStyleUrl && !validateMapboxUrl(data.mapboxStyleUrl)) {
      throw new InvalidMapboxUrlError(data.mapboxStyleUrl);
    }

    const now = new Date();
    const themeData: NewTheme = {
      name: data.name,
      description: data.description || null,
      mapboxStyleUrl: data.mapboxStyleUrl || null,
      mapboxAccessToken: data.mapboxAccessToken || null,
      // ?? (not ||): a 0 coordinate (equator, prime meridian) is a value.
      centerLat: roundCoordinate(data.centerLat) ?? null,
      centerLong: roundCoordinate(data.centerLong) ?? null,
      swBoundaryLat: roundCoordinate(data.swBoundaryLat) ?? null,
      swBoundaryLong: roundCoordinate(data.swBoundaryLong) ?? null,
      neBoundaryLat: roundCoordinate(data.neBoundaryLat) ?? null,
      neBoundaryLong: roundCoordinate(data.neBoundaryLong) ?? null,
      active: data.active || false,
      communityId: data.communityId,
      createdAt: now,
      updatedAt: now,
    };

    try {
      // Check if community exists first
      const [existingCommunity] = await this.db
        .select({ id: this.tables.communities.id })
        .from(this.tables.communities)
        .where(eq(this.tables.communities.id, data.communityId))
        .limit(1);

      if (!existingCommunity) {
        throw new CommunityNotFoundError(data.communityId);
      }

      const [theme] = await this.db
        .insert(this.themesTable)
        .values(themeData)
        .returning();

      return theme;
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.includes('foreign key') ||
          error.message.includes('Invalid community ID'))
      ) {
        throw new CommunityNotFoundError();
      }
      throw error;
    }
  }

  /**
   * Get theme by ID without community check (internal use)
   */
  async findById(id: number): Promise<Theme | null> {
    const [theme] = await this.db
      .select()
      .from(this.themesTable)
      .where(eq(this.themesTable.id, id))
      .limit(1);

    return theme || null;
  }

  /**
   * Get theme by ID with community isolation
   */
  async findByIdWithCommunityCheck(
    id: number,
    communityId: number
  ): Promise<Theme | null> {
    const [theme] = await this.db
      .select()
      .from(this.themesTable)
      .where(
        and(
          eq(this.themesTable.id, id),
          eq(this.themesTable.communityId, communityId)
        )
      )
      .limit(1);

    return theme || null;
  }

  /**
   * Alias for findByIdWithCommunityCheck (test compatibility)
   */
  async findByIdAndCommunity(
    id: number,
    communityId: number
  ): Promise<Theme | null> {
    return this.findByIdWithCommunityCheck(id, communityId);
  }

  /**
   * Get all themes for a community (simple version)
   */
  async findByCommunityId(communityId: number): Promise<Theme[]>;
  async findByCommunityId(
    communityId: number,
    params: FindThemesParams
  ): Promise<PaginatedResponse<Theme>>;
  async findByCommunityId(
    communityId: number,
    params?: FindThemesParams
  ): Promise<Theme[] | PaginatedResponse<Theme>> {
    if (!params) {
      // Simple version - return all themes for community
      return await this.db
        .select()
        .from(this.themesTable)
        .where(eq(this.themesTable.communityId, communityId))
        .orderBy(...this.nameOrder());
    }

    // Paginated version
    const { page, limit, sortBy = 'name', sortOrder = 'asc' } = params;
    const offset = (page - 1) * limit;

    // Build where condition
    const whereCondition = eq(this.themesTable.communityId, communityId);

    // Build order by (deterministic on both backends)
    const orderBy = this.sortOrder(sortBy, sortOrder);

    // Get total count
    const [{ count: total }] = await this.db
      .select({ count: count() })
      .from(this.themesTable)
      .where(whereCondition);

    // Get paginated data
    const themesList = await this.db
      .select()
      .from(this.themesTable)
      .where(whereCondition)
      .orderBy(...orderBy)
      .limit(limit)
      .offset(offset);

    return {
      data: themesList,
      total: Number(total),
      page,
      limit,
      pages: Math.ceil(Number(total) / limit),
    };
  }

  /**
   * Get active themes for a community
   */
  async findActiveThemes(communityId: number): Promise<Theme[]> {
    return await this.db
      .select()
      .from(this.themesTable)
      .where(
        and(
          eq(this.themesTable.communityId, communityId),
          eq(this.themesTable.active, true)
        )
      )
      .orderBy(...this.nameOrder());
  }

  /**
   * Search themes by name
   */
  async searchByName(communityId: number, query: string): Promise<Theme[]> {
    const searchCondition = containsInsensitive(
      this.dialect,
      this.themesTable.name,
      query
    );
    return await this.db
      .select()
      .from(this.themesTable)
      .where(
        and(eq(this.themesTable.communityId, communityId), searchCondition)
      )
      .orderBy(...this.nameOrder());
  }

  /**
   * Search themes by description
   */
  async searchByDescription(
    communityId: number,
    query: string
  ): Promise<Theme[]> {
    const searchCondition = containsInsensitive(
      this.dialect,
      this.themesTable.description,
      query
    );
    return await this.db
      .select()
      .from(this.themesTable)
      .where(
        and(eq(this.themesTable.communityId, communityId), searchCondition)
      )
      .orderBy(...this.nameOrder());
  }

  /**
   * Search themes by name or description
   */
  async searchThemes(
    communityId: number,
    params: SearchThemesParams
  ): Promise<PaginatedResponse<Theme>> {
    const { query, page, limit, sortBy = 'name', sortOrder = 'asc' } = params;
    const offset = (page - 1) * limit;

    // Build search condition
    const searchCondition = this.nameOrDescription(query);
    const whereCondition = and(
      eq(this.themesTable.communityId, communityId),
      searchCondition
    );

    // Build order by (deterministic on both backends)
    const orderBy = this.sortOrder(sortBy, sortOrder);

    // Get total count
    const [{ count: total }] = await this.db
      .select({ count: count() })
      .from(this.themesTable)
      .where(whereCondition);

    // Get paginated data
    const themesList = await this.db
      .select()
      .from(this.themesTable)
      .where(whereCondition)
      .orderBy(...orderBy)
      .limit(limit)
      .offset(offset);

    return {
      data: themesList,
      total: Number(total),
      page,
      limit,
      pages: Math.ceil(Number(total) / limit),
    };
  }

  /**
   * Update theme by ID
   */
  async update(id: number, data: UpdateTheme): Promise<Theme | null> {
    // Validate center coordinates if provided
    if (data.centerLat !== undefined && data.centerLong !== undefined) {
      if (!validateCoordinates(data.centerLat, data.centerLong)) {
        throw new InvalidCoordinatesError(data.centerLat, data.centerLong);
      }
    }

    // Validate geographic bounds if provided
    if (
      !validateGeographicBounds(
        data.swBoundaryLat,
        data.swBoundaryLong,
        data.neBoundaryLat,
        data.neBoundaryLong
      )
    ) {
      throw new InvalidCoordinatesError();
    }

    // Validate Mapbox URL if provided
    if (data.mapboxStyleUrl && !validateMapboxUrl(data.mapboxStyleUrl)) {
      throw new InvalidMapboxUrlError(data.mapboxStyleUrl);
    }

    const updateData: Partial<UpdateTheme> & { updatedAt?: Date } = {
      ...(data.name !== undefined && { name: data.name }),
      ...(data.description !== undefined && { description: data.description }),
      ...(data.mapboxStyleUrl !== undefined && {
        mapboxStyleUrl: data.mapboxStyleUrl,
      }),
      ...(data.mapboxAccessToken !== undefined && {
        mapboxAccessToken: data.mapboxAccessToken,
      }),
      ...(data.centerLat !== undefined && {
        centerLat: roundCoordinate(data.centerLat),
      }),
      ...(data.centerLong !== undefined && {
        centerLong: roundCoordinate(data.centerLong),
      }),
      ...(data.swBoundaryLat !== undefined && {
        swBoundaryLat: roundCoordinate(data.swBoundaryLat),
      }),
      ...(data.swBoundaryLong !== undefined && {
        swBoundaryLong: roundCoordinate(data.swBoundaryLong),
      }),
      ...(data.neBoundaryLat !== undefined && {
        neBoundaryLat: roundCoordinate(data.neBoundaryLat),
      }),
      ...(data.neBoundaryLong !== undefined && {
        neBoundaryLong: roundCoordinate(data.neBoundaryLong),
      }),
      ...(data.active !== undefined && { active: data.active }),
      updatedAt: new Date(Date.now() + 100), // Ensure it's different from creation time
    };

    const [updated] = await this.db
      .update(this.themesTable)
      .set(updateData)
      .where(eq(this.themesTable.id, id))
      .returning();

    return updated || null;
  }

  /**
   * Update theme by ID with community isolation
   */
  async updateByCommunity(
    id: number,
    communityId: number,
    data: UpdateTheme
  ): Promise<Theme | null> {
    // First check if theme exists in community
    const existing = await this.findByIdAndCommunity(id, communityId);
    if (!existing) {
      return null;
    }

    return this.update(id, data);
  }

  /**
   * Delete theme by ID
   */
  async delete(id: number): Promise<boolean> {
    try {
      const [deleted] = await this.db
        .delete(this.themesTable)
        .where(eq(this.themesTable.id, id))
        .returning({ id: this.themesTable.id });

      return !!deleted;
    } catch {
      return false;
    }
  }

  /**
   * Delete theme by ID with community isolation
   */
  async deleteByCommunity(id: number, communityId: number): Promise<boolean> {
    try {
      const [deleted] = await this.db
        .delete(this.themesTable)
        .where(
          and(
            eq(this.themesTable.id, id),
            eq(this.themesTable.communityId, communityId)
          )
        )
        .returning({ id: this.themesTable.id });

      return !!deleted;
    } catch {
      return false;
    }
  }

  /**
   * Check if theme exists and belongs to community
   */
  async existsInCommunity(id: number, communityId: number): Promise<boolean> {
    const [theme] = await this.db
      .select({ id: this.themesTable.id })
      .from(this.themesTable)
      .where(
        and(
          eq(this.themesTable.id, id),
          eq(this.themesTable.communityId, communityId)
        )
      )
      .limit(1);

    return !!theme;
  }

  /**
   * Get theme statistics for a community
   */
  async getCommunityThemeStats(communityId: number): Promise<{
    total: number;
    active: number;
    inactive: number;
    withMapbox: number;
    withBounds: number;
  }> {
    const [totalResult] = await this.db
      .select({ count: count() })
      .from(this.themesTable)
      .where(eq(this.themesTable.communityId, communityId));

    const [activeResult] = await this.db
      .select({ count: count() })
      .from(this.themesTable)
      .where(
        and(
          eq(this.themesTable.communityId, communityId),
          eq(this.themesTable.active, true)
        )
      );

    const [withMapboxResult] = await this.db
      .select({ count: count() })
      .from(this.themesTable)
      .where(
        and(
          eq(this.themesTable.communityId, communityId),
          sql`${this.themesTable.mapboxStyleUrl} IS NOT NULL`
        )
      );

    const [withBoundsResult] = await this.db
      .select({ count: count() })
      .from(this.themesTable)
      .where(
        and(
          eq(this.themesTable.communityId, communityId),
          sql`${this.themesTable.swBoundaryLat} IS NOT NULL`,
          sql`${this.themesTable.swBoundaryLong} IS NOT NULL`,
          sql`${this.themesTable.neBoundaryLat} IS NOT NULL`,
          sql`${this.themesTable.neBoundaryLong} IS NOT NULL`
        )
      );

    const total = Number(totalResult.count);
    const active = Number(activeResult.count);

    return {
      total,
      active,
      inactive: total - active,
      withMapbox: Number(withMapboxResult.count),
      withBounds: Number(withBoundsResult.count),
    };
  }

  /**
   * Paginated version of findByCommunityId (for explicit pagination calls)
   */
  async findByCommunityIdPaginated(
    communityId: number,
    params: FindThemesParams
  ): Promise<ThemesPaginatedResponse> {
    const result = (await this.findByCommunityId(
      communityId,
      params
    )) as PaginatedResponse<Theme>;
    return {
      themes: result.data,
      total: result.total,
      page: result.page,
      totalPages: result.pages,
    };
  }

  /**
   * Search active themes by name or description
   */
  async searchActiveThemes(
    communityId: number,
    query: string
  ): Promise<Theme[]> {
    const searchCondition = this.nameOrDescription(query);
    return await this.db
      .select()
      .from(this.themesTable)
      .where(
        and(
          eq(this.themesTable.communityId, communityId),
          eq(this.themesTable.active, true),
          searchCondition
        )
      )
      .orderBy(...this.nameOrder());
  }

  /**
   * Validate geographic bounds for a specific theme by ID
   */
  async validateGeographicBounds(
    themeId: number
  ): Promise<{ isValid: boolean; errors: string[] }> {
    const theme = await this.findById(themeId);
    if (!theme) {
      return { isValid: false, errors: ['Theme not found'] };
    }

    const errors: string[] = [];
    let isValid = true;

    // Check coordinate ranges first (convert string to number if needed)
    if (theme.centerLat !== null && !isValidLatitude(Number(theme.centerLat))) {
      errors.push('Center latitude must be between -90 and 90 degrees');
      isValid = false;
    }

    if (
      theme.centerLong !== null &&
      !isValidLongitude(Number(theme.centerLong))
    ) {
      errors.push('Center longitude must be between -180 and 180 degrees');
      isValid = false;
    }

    if (
      theme.swBoundaryLat !== null &&
      !isValidLatitude(Number(theme.swBoundaryLat))
    ) {
      errors.push(
        'Southwest boundary latitude must be between -90 and 90 degrees'
      );
      isValid = false;
    }

    if (
      theme.swBoundaryLong !== null &&
      !isValidLongitude(Number(theme.swBoundaryLong))
    ) {
      errors.push(
        'Southwest boundary longitude must be between -180 and 180 degrees'
      );
      isValid = false;
    }

    if (
      theme.neBoundaryLat !== null &&
      !isValidLatitude(Number(theme.neBoundaryLat))
    ) {
      errors.push(
        'Northeast boundary latitude must be between -90 and 90 degrees'
      );
      isValid = false;
    }

    if (
      theme.neBoundaryLong !== null &&
      !isValidLongitude(Number(theme.neBoundaryLong))
    ) {
      errors.push(
        'Northeast boundary longitude must be between -180 and 180 degrees'
      );
      isValid = false;
    }

    // Check if all boundary coordinates are provided
    if (
      theme.swBoundaryLat !== null &&
      theme.swBoundaryLong !== null &&
      theme.neBoundaryLat !== null &&
      theme.neBoundaryLong !== null
    ) {
      // Check SW < NE relationship (only if coordinates are in valid range)
      if (
        isValidLatitude(Number(theme.swBoundaryLat)) &&
        isValidLatitude(Number(theme.neBoundaryLat)) &&
        Number(theme.swBoundaryLat) >= Number(theme.neBoundaryLat)
      ) {
        errors.push(
          'Southwest boundary latitude must be less than northeast boundary latitude'
        );
        isValid = false;
      }

      if (
        isValidLongitude(Number(theme.swBoundaryLong)) &&
        isValidLongitude(Number(theme.neBoundaryLong)) &&
        Number(theme.swBoundaryLong) >= Number(theme.neBoundaryLong)
      ) {
        errors.push(
          'Southwest boundary longitude must be less than northeast boundary longitude'
        );
        isValid = false;
      }
    } else if (
      theme.swBoundaryLat !== null ||
      theme.swBoundaryLong !== null ||
      theme.neBoundaryLat !== null ||
      theme.neBoundaryLong !== null
    ) {
      // Some but not all boundary coordinates are provided
      errors.push('All boundary coordinates must be provided together');
      isValid = false;
    }

    return { isValid, errors };
  }

  /**
   * Validate geographic bounds (public method for external validation)
   */
  validateGeographicBoundsCoordinates(
    swLat?: number,
    swLng?: number,
    neLat?: number,
    neLng?: number
  ): boolean {
    return validateGeographicBounds(swLat, swLng, neLat, neLng);
  }

  /**
   * Count themes for a community with optional filters
   */
  async countByCommunityId(
    communityId: number,
    options?: { activeOnly?: boolean; searchTerm?: string }
  ): Promise<number> {
    const conditions: SQL[] = [eq(this.themesTable.communityId, communityId)];
    if (options?.activeOnly) {
      conditions.push(eq(this.themesTable.active, true));
    }
    if (options?.searchTerm) {
      conditions.push(
        containsInsensitive(
          this.dialect,
          this.themesTable.name,
          options.searchTerm
        )
      );
    }

    // Chained .where() calls replace each other in Drizzle, so combine them.
    const [result] = await this.db
      .select({ count: sql`count(*)` })
      .from(this.themesTable)
      .where(and(...conditions));
    return Number(result.count);
  }

  /**
   * Update theme with community ownership check
   */
  async updateWithCommunityCheck(
    id: number,
    communityId: number,
    data: UpdateTheme
  ): Promise<Theme | null> {
    // First check if theme exists and belongs to community
    const existingTheme = await this.findByIdWithCommunityCheck(
      id,
      communityId
    );
    if (!existingTheme) {
      return null;
    }

    // Use existing update method
    return this.update(id, data);
  }

  /**
   * Delete theme with community ownership check
   */
  async deleteWithCommunityCheck(
    id: number,
    communityId: number
  ): Promise<boolean> {
    // First check if theme exists and belongs to community
    const existingTheme = await this.findByIdWithCommunityCheck(
      id,
      communityId
    );
    if (!existingTheme) {
      return false;
    }

    // Use existing delete method
    return this.delete(id);
  }
}
