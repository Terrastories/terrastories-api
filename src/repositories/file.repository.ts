/**
 * File Repository
 *
 * Database operations for file management with community scoping.
 * Handles CRUD operations while enforcing multi-tenant data isolation
 * for Indigenous community data sovereignty.
 *
 * Features:
 * - Community-scoped operations for data sovereignty
 * - File type filtering and search capabilities
 * - Multi-database compatibility (PostgreSQL/SQLite)
 * - Comprehensive error handling
 * - Pagination and filtering support
 * - Cultural restrictions management
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { eq, and, like, desc, asc, count, or, sql, inArray } from 'drizzle-orm';
import {
  getFilesTable,
  type File,
  type NewFile,
  type UpdateFile,
  type CulturalRestrictions,
} from '../db/schema/files.js';
import type { Database } from '../db/index.js';

/**
 * Options for listing files with filtering and pagination
 */
export interface FileListOptions {
  page?: number;
  limit?: number;
  search?: string; // Search in filename or original name
  mimeTypeFilter?: string[]; // Filter by MIME types
  communityId?: number; // Community scoping (required for data sovereignty)
  uploadedBy?: number; // Filter by uploader
  dateRange?: {
    start: Date;
    end: Date;
  };
  culturalRestrictions?: {
    elderOnly?: boolean;
    public?: boolean;
  };
  orderBy?: 'createdAt' | 'updatedAt' | 'filename' | 'size' | 'originalName';
  orderDirection?: 'asc' | 'desc';
  includeInactive?: boolean; // Include soft-deleted files
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
    hasNextPage: boolean;
    hasPreviousPage: boolean;
  };
}

/**
 * File usage statistics
 */
export interface FileUsageStats {
  totalFiles: number;
  totalSize: number;
  filesByType: Record<string, number>;
  averageFileSize: number;
  communityUsage: {
    communityId: number;
    fileCount: number;
    totalSize: number;
  }[];
}

/**
 * File Repository class for database operations
 */
export class FileRepository {
  constructor(private readonly db: Database) {}

  /**
   * Create a new file record
   */
  async create(
    fileData: Omit<NewFile, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<File> {
    const filesTable = await getFilesTable();

    const newFile: NewFile = {
      ...fileData,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    try {
      const result = await (this.db as any)
        .insert(filesTable)
        .values(newFile)
        .returning();

      return result[0] as File;
    } catch (error) {
      if (error instanceof Error) {
        // Handle specific database errors
        if (error.message.includes('FOREIGN KEY constraint failed')) {
          throw new Error('Invalid community or user reference');
        }
        if (error.message.includes('UNIQUE constraint failed')) {
          throw new Error('File with this path already exists');
        }
      }
      throw new Error(`Failed to create file: ${error}`);
    }
  }

  /**
   * Find file by ID with community scoping
   */
  async findById(id: string, communityId?: number): Promise<File | null> {
    const filesTable = await getFilesTable();

    try {
      const conditions = [eq(filesTable.id, id)];

      // Add community scoping for data sovereignty
      if (communityId !== undefined) {
        conditions.push(eq(filesTable.communityId, communityId));
      }

      const result = await (this.db as any)
        .select()
        .from(filesTable)
        .where(and(...conditions))
        .limit(1);

      const [file] = result;

      return (file as File) || null;
    } catch (error) {
      throw new Error(`Failed to find file: ${error}`);
    }
  }

  /**
   * Find files by community with pagination and filtering
   */
  async findByCommunity(
    communityId: number,
    options: FileListOptions = {}
  ): Promise<PaginatedResult<File>> {
    const filesTable = await getFilesTable();

    const {
      page = 1,
      limit = 20,
      search,
      mimeTypeFilter,
      uploadedBy,
      dateRange,
      culturalRestrictions,
      orderBy = 'createdAt',
      orderDirection = 'desc',
      includeInactive = false,
    } = options;

    try {
      // Build WHERE conditions
      const conditions = [eq(filesTable.communityId, communityId)];

      // Add active filter unless explicitly including inactive files
      if (!includeInactive) {
        conditions.push(eq(filesTable.isActive, true));
      }

      // Search filter
      if (search) {
        conditions.push(
          or(
            like(filesTable.filename, `%${search}%`),
            like(filesTable.originalName, `%${search}%`)
          )!
        );
      }

      // MIME type filter
      if (mimeTypeFilter && mimeTypeFilter.length > 0) {
        conditions.push(inArray(filesTable.mimeType, mimeTypeFilter));
      }

      // Uploader filter
      if (uploadedBy) {
        conditions.push(eq(filesTable.uploadedBy, uploadedBy));
      }

      // Date range filter
      if (dateRange) {
        conditions.push(
          and(
            sql`${filesTable.createdAt} >= ${dateRange.start}`,
            sql`${filesTable.createdAt} <= ${dateRange.end}`
          )!
        );
      }

      // Cultural restrictions filter
      if (culturalRestrictions) {
        if (culturalRestrictions.elderOnly !== undefined) {
          const elderOnlyCondition = culturalRestrictions.elderOnly
            ? sql`JSON_EXTRACT(${filesTable.culturalRestrictions}, '$.elderOnly') = true`
            : or(
                sql`JSON_EXTRACT(${filesTable.culturalRestrictions}, '$.elderOnly') = false`,
                sql`JSON_EXTRACT(${filesTable.culturalRestrictions}, '$.elderOnly') IS NULL`
              )!;
          conditions.push(elderOnlyCondition);
        }
      }

      // Build ORDER BY clause
      const orderColumn = filesTable[orderBy];
      const orderClause =
        orderDirection === 'desc' ? desc(orderColumn) : asc(orderColumn);

      // Calculate offset
      const offset = (page - 1) * limit;

      // Execute query with pagination
      const [files, totalCountResult] = await Promise.all([
        (this.db as any)
          .select()
          .from(filesTable)
          .where(and(...conditions))
          .orderBy(orderClause)
          .limit(limit)
          .offset(offset),
        (this.db as any)
          .select({ count: count() })
          .from(filesTable)
          .where(and(...conditions)),
      ]);

      const total = totalCountResult[0]?.count || 0;
      const totalPages = Math.ceil(total / limit);

      return {
        data: files as File[],
        meta: {
          page,
          limit,
          total,
          totalPages,
          hasNextPage: page < totalPages,
          hasPreviousPage: page > 1,
        },
      };
    } catch (error) {
      throw new Error(`Failed to find files by community: ${error}`);
    }
  }

  /**
   * Update file record
   */
  async update(
    id: string,
    updates: Partial<UpdateFile>,
    communityId?: number
  ): Promise<File> {
    const filesTable = await getFilesTable();

    try {
      const conditions = [eq(filesTable.id, id)];

      // Add community scoping for data sovereignty
      if (communityId !== undefined) {
        conditions.push(eq(filesTable.communityId, communityId));
      }

      const updateData = {
        ...updates,
        updatedAt: new Date(),
      };

      const result = await (this.db as any)
        .update(filesTable)
        .set(updateData)
        .where(and(...conditions))
        .returning();

      const [updatedFile] = result;

      if (!updatedFile) {
        throw new Error('File not found or access denied');
      }

      return updatedFile as File;
    } catch (error) {
      throw new Error(`Failed to update file: ${error}`);
    }
  }

  /**
   * Update cultural restrictions for a file
   */
  async updateCulturalRestrictions(
    id: string,
    restrictions: CulturalRestrictions,
    communityId: number
  ): Promise<File> {
    return this.update(id, { culturalRestrictions: restrictions }, communityId);
  }

  /**
   * Soft delete file (mark as inactive)
   */
  async softDelete(id: string, communityId?: number): Promise<boolean> {
    const filesTable = await getFilesTable();

    try {
      const conditions = [eq(filesTable.id, id)];

      // Add community scoping for data sovereignty
      if (communityId !== undefined) {
        conditions.push(eq(filesTable.communityId, communityId));
      }

      const result = await (this.db as any)
        .update(filesTable)
        .set({
          isActive: false,
          updatedAt: new Date(),
        })
        .where(and(...conditions))
        .returning();

      const [deletedFile] = result;

      return !!deletedFile;
    } catch (error) {
      throw new Error(`Failed to soft delete file: ${error}`);
    }
  }

  /**
   * Hard delete file (permanent removal)
   */
  async delete(id: string, communityId?: number): Promise<boolean> {
    const filesTable = await getFilesTable();

    try {
      const conditions = [eq(filesTable.id, id)];

      // Add community scoping for data sovereignty
      if (communityId !== undefined) {
        conditions.push(eq(filesTable.communityId, communityId));
      }

      const result = await (this.db as any)
        .delete(filesTable)
        .where(and(...conditions));

      return result.changes > 0;
    } catch (error) {
      throw new Error(`Failed to delete file: ${error}`);
    }
  }

  /**
   * Get file usage statistics for a community
   */
  async getUsageStats(communityId: number): Promise<FileUsageStats> {
    const filesTable = await getFilesTable();

    try {
      // Get total files and size
      const totalStatsResult = await (this.db as any)
        .select({
          totalFiles: count(),
          totalSize: sql<number>`SUM(${filesTable.size})`.as('totalSize'),
        })
        .from(filesTable)
        .where(
          and(
            eq(filesTable.communityId, communityId),
            eq(filesTable.isActive, true)
          )
        );

      const [totalStats] = totalStatsResult;

      // Get files by type
      const filesByType = await (this.db as any)
        .select({
          mimeType: filesTable.mimeType,
          count: count(),
        })
        .from(filesTable)
        .where(
          and(
            eq(filesTable.communityId, communityId),
            eq(filesTable.isActive, true)
          )
        )
        .groupBy(filesTable.mimeType);

      const filesByTypeRecord = filesByType.reduce(
        (
          acc: Record<string, number>,
          { mimeType, count }: { mimeType: string; count: number }
        ) => {
          acc[mimeType] = count;
          return acc;
        },
        {} as Record<string, number>
      );

      const averageFileSize =
        totalStats.totalFiles > 0
          ? Math.round(totalStats.totalSize / totalStats.totalFiles)
          : 0;

      return {
        totalFiles: totalStats.totalFiles,
        totalSize: totalStats.totalSize || 0,
        filesByType: filesByTypeRecord,
        averageFileSize,
        communityUsage: [
          {
            communityId,
            fileCount: totalStats.totalFiles,
            totalSize: totalStats.totalSize || 0,
          },
        ],
      };
    } catch (error) {
      throw new Error(`Failed to get usage stats: ${error}`);
    }
  }

  /**
   * Find files by MIME type pattern
   */
  async findByMimeType(
    mimeTypePattern: string,
    communityId?: number,
    limit: number = 100
  ): Promise<File[]> {
    const filesTable = await getFilesTable();

    try {
      const conditions = [
        like(filesTable.mimeType, `${mimeTypePattern}%`),
        eq(filesTable.isActive, true),
      ];

      if (communityId !== undefined) {
        conditions.push(eq(filesTable.communityId, communityId));
      }

      const files = await (this.db as any)
        .select()
        .from(filesTable)
        .where(and(...conditions))
        .orderBy(desc(filesTable.createdAt))
        .limit(limit);

      return files as File[];
    } catch (error) {
      throw new Error(`Failed to find files by MIME type: ${error}`);
    }
  }

  /**
   * Check if file path already exists
   */
  async existsByPath(path: string, communityId?: number): Promise<boolean> {
    const filesTable = await getFilesTable();

    try {
      const conditions = [eq(filesTable.path, path)];

      if (communityId !== undefined) {
        conditions.push(eq(filesTable.communityId, communityId));
      }

      const result = await (this.db as any)
        .select({ id: filesTable.id })
        .from(filesTable)
        .where(and(...conditions))
        .limit(1);

      const [existingFile] = result;

      return !!existingFile;
    } catch (error) {
      throw new Error(`Failed to check file path existence: ${error}`);
    }
  }

  /**
   * Get files that need cleanup (inactive files older than specified days)
   */
  async getFilesForCleanup(daysOld: number = 30): Promise<File[]> {
    const filesTable = await getFilesTable();

    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysOld);

      const files = await (this.db as any)
        .select()
        .from(filesTable)
        .where(
          and(
            eq(filesTable.isActive, false),
            sql`${filesTable.updatedAt} < ${cutoffDate}`
          )
        )
        .orderBy(asc(filesTable.updatedAt));

      return files as File[];
    } catch (error) {
      throw new Error(`Failed to get files for cleanup: ${error}`);
    }
  }
}
