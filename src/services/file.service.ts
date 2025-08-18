/**
 * File Service
 *
 * Core file upload service with comprehensive security, validation, and community data sovereignty.
 * Handles multipart file uploads with streaming, metadata extraction, and cultural protocol enforcement.
 *
 * Features:
 * - Secure file upload with magic number validation
 * - Community-scoped data sovereignty
 * - Streaming for large files (>5MB)
 * - Metadata extraction (images, audio, video)
 * - Cultural restrictions framework
 * - Path sanitization and security validation
 * - Audit logging for Indigenous oversight
 */

import { promises as fs } from 'fs';
import { join, extname, dirname } from 'path';
import { randomUUID } from 'crypto';
import sharp from 'sharp';
import { fileTypeFromBuffer } from 'file-type';
import type { MultipartFile } from '@fastify/multipart';
import {
  FileRepository,
  type PaginatedResult,
} from '../repositories/file.repository.js';
import type {
  FileUploadResult,
  FileUploadOptions,
  FileMetadata,
  CulturalRestrictions,
} from '../db/schema/files.js';
import type { FileUploadConfig } from '../shared/config/types.js';

/**
 * File validation result
 */
interface FileValidationResult {
  isValid: boolean;
  detectedType?: string;
  error?: string;
}

/**
 * Audit log entry for file operations
 */
interface FileAuditLog {
  action: 'upload' | 'access' | 'delete' | 'update';
  fileId?: string;
  userId: number;
  communityId: number;
  filename?: string;
  success: boolean;
  reason?: string;
  timestamp: Date;
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Core file service for secure uploads and management
 */
export class FileService {
  private logger?: (entry: FileAuditLog) => void;

  constructor(
    private readonly uploadDir: string,
    private readonly config: FileUploadConfig,
    private readonly fileRepository: FileRepository
  ) {}

  /**
   * Set logger for audit logging
   */
  setLogger(logger: (entry: FileAuditLog) => void): void {
    this.logger = logger;
  }

  /**
   * Upload a file with comprehensive validation and security checks
   */
  async uploadFile(
    file: MultipartFile,
    options: FileUploadOptions
  ): Promise<FileUploadResult> {
    try {
      // 1. Validate file type and headers
      const validation = await this.validateFileType(file);
      if (!validation.isValid) {
        throw new Error(validation.error || 'Invalid file type');
      }

      // 2. Check file size limits
      await this.validateFileSize(file, options);

      // 3. Generate secure filename and path
      const filename =
        options.generateUniqueName !== false
          ? this.generateUniqueFilename(file.filename || 'file')
          : this.sanitizeFilename(file.filename || 'file');

      // 4. Create community-specific directory structure
      const relativePath = this.createFilePath(
        filename,
        options.communityId,
        validation.detectedType!
      );
      const fullPath = join(this.uploadDir, relativePath);
      const url = `/api/v1/files/${relativePath}`;

      // 5. Ensure directory exists
      await fs.mkdir(dirname(fullPath), { recursive: true });

      // 6. Check for path conflicts
      const pathExists = await this.fileRepository.existsByPath(
        relativePath,
        options.communityId
      );
      if (pathExists) {
        throw new Error('File path already exists');
      }

      // 7. Stream file to filesystem
      let fileSize = 0;
      const chunks: Buffer[] = [];

      for await (const chunk of file.file) {
        fileSize += chunk.length;

        // Check size limit during streaming
        if (options.maxSize && fileSize > options.maxSize) {
          throw new Error('File size exceeds maximum allowed');
        }

        chunks.push(chunk);
      }

      const fileBuffer = Buffer.concat(chunks);

      // 8. Final validation with complete file
      const finalValidation = await this.validateCompleteFile(
        fileBuffer,
        validation.detectedType!
      );
      if (!finalValidation.isValid) {
        throw new Error(finalValidation.error || 'File validation failed');
      }

      // 9. Write file to disk
      await fs.writeFile(fullPath, fileBuffer);

      // 10. Extract metadata
      let metadata: FileMetadata | undefined;
      if (this.config.enableMetadataExtraction) {
        metadata = await this.extractMetadata(
          fileBuffer,
          validation.detectedType!
        );
      }

      // 11. Save file record to database
      const fileRecord = await this.fileRepository.create({
        filename,
        originalName: file.filename,
        path: relativePath,
        url,
        mimeType: validation.detectedType!,
        size: fileSize,
        communityId: options.communityId,
        uploadedBy: options.uploadedBy,
        metadata: metadata ? JSON.stringify(metadata) : undefined,
        culturalRestrictions: options.culturalRestrictions
          ? JSON.stringify(options.culturalRestrictions)
          : undefined,
        isActive: true,
      });

      // 12. Audit log
      if (this.config.enableAuditLogging && this.logger) {
        this.logger({
          action: 'upload',
          fileId: fileRecord.id,
          userId: options.uploadedBy,
          communityId: options.communityId,
          filename: file.filename,
          success: true,
          timestamp: new Date(),
        });
      }

      return {
        id: fileRecord.id,
        filename: fileRecord.filename,
        originalName: fileRecord.originalName,
        path: fileRecord.path,
        url: fileRecord.url,
        size: fileRecord.size,
        mimeType: fileRecord.mimeType,
        communityId: fileRecord.communityId,
        uploadedBy: fileRecord.uploadedBy,
        metadata,
        culturalRestrictions: options.culturalRestrictions,
        createdAt: fileRecord.createdAt,
      };
    } catch (error) {
      // Audit log failure
      if (this.config.enableAuditLogging && this.logger) {
        this.logger({
          action: 'upload',
          userId: options.uploadedBy,
          communityId: options.communityId,
          filename: file.filename,
          success: false,
          reason: error instanceof Error ? error.message : 'Unknown error',
          timestamp: new Date(),
        });
      }

      throw error;
    }
  }

  /**
   * Get file with access control and community scoping
   */
  async getFile(
    fileId: string,
    userId: number,
    communityId: number | null,
    userRole?: string
  ): Promise<FileUploadResult> {
    // Super admin data sovereignty protection
    if (userRole === 'super_admin') {
      const error = 'Super administrators cannot access community files';

      if (this.config.enableAuditLogging && this.logger) {
        this.logger({
          action: 'access',
          fileId,
          userId,
          communityId: communityId || 0,
          success: false,
          reason: 'data_sovereignty_protection',
          timestamp: new Date(),
        });
      }

      throw new Error(error);
    }

    // Find file with community scoping
    const file = await this.fileRepository.findById(
      fileId,
      communityId || undefined
    );
    if (!file) {
      throw new Error('File not found');
    }

    // Community isolation check
    if (communityId && file.communityId !== communityId) {
      const error = 'Access denied - community data isolation';

      if (this.config.enableAuditLogging && this.logger) {
        this.logger({
          action: 'access',
          fileId,
          userId,
          communityId,
          success: false,
          reason: 'cross_community_access_denied',
          timestamp: new Date(),
        });
      }

      throw new Error(error);
    }

    // Cultural restrictions check
    if (file.culturalRestrictions) {
      const restrictions: CulturalRestrictions =
        typeof file.culturalRestrictions === 'string'
          ? JSON.parse(file.culturalRestrictions)
          : file.culturalRestrictions;

      if (restrictions.elderOnly && userRole !== 'elder') {
        throw new Error('Access denied - elder-only cultural content');
      }
    }

    // Parse metadata
    let metadata: FileMetadata | undefined;
    if (file.metadata) {
      metadata =
        typeof file.metadata === 'string'
          ? JSON.parse(file.metadata)
          : file.metadata;
    }

    // Parse cultural restrictions
    let culturalRestrictions: CulturalRestrictions | undefined;
    if (file.culturalRestrictions) {
      culturalRestrictions =
        typeof file.culturalRestrictions === 'string'
          ? JSON.parse(file.culturalRestrictions)
          : file.culturalRestrictions;
    }

    // Audit log successful access
    if (this.config.enableAuditLogging && this.logger) {
      this.logger({
        action: 'access',
        fileId,
        userId,
        communityId: file.communityId,
        success: true,
        timestamp: new Date(),
      });
    }

    return {
      id: file.id,
      filename: file.filename,
      originalName: file.originalName,
      path: file.path,
      url: file.url,
      size: file.size,
      mimeType: file.mimeType,
      communityId: file.communityId,
      uploadedBy: file.uploadedBy,
      metadata,
      culturalRestrictions,
      createdAt: file.createdAt,
    };
  }

  /**
   * Delete file with authorization and cleanup
   */
  async deleteFile(
    fileId: string,
    userId: number,
    communityId: number
  ): Promise<void> {
    try {
      // Get file to check permissions
      const file = await this.getFile(fileId, userId, communityId);

      // Check if user can delete (uploader or admin)
      // For now, only the uploader can delete their files
      if (file.uploadedBy !== userId) {
        throw new Error('Access denied - you can only delete your own files');
      }

      // Delete from filesystem
      const fullPath = join(this.uploadDir, file.path);
      try {
        await fs.unlink(fullPath);
      } catch {
        // File may not exist on disk, but continue with database deletion
        console.warn(`File not found on disk: ${fullPath}`);
      }

      // Delete from database
      const deleted = await this.fileRepository.delete(fileId, communityId);
      if (!deleted) {
        throw new Error('Failed to delete file record');
      }

      // Audit log
      if (this.config.enableAuditLogging && this.logger) {
        this.logger({
          action: 'delete',
          fileId,
          userId,
          communityId,
          filename: file.originalName,
          success: true,
          timestamp: new Date(),
        });
      }
    } catch (error) {
      // Audit log failure
      if (this.config.enableAuditLogging && this.logger) {
        this.logger({
          action: 'delete',
          fileId,
          userId,
          communityId,
          success: false,
          reason: error instanceof Error ? error.message : 'Unknown error',
          timestamp: new Date(),
        });
      }

      throw error;
    }
  }

  /**
   * List files with community scoping and pagination
   */
  async listFiles(
    communityId: number,
    userId: number,
    options: {
      page?: number;
      limit?: number;
      type?: string;
      search?: string;
    } = {}
  ): Promise<PaginatedResult<FileUploadResult>> {
    try {
      const { page = 1, limit = 20, type, search } = options;

      // Build MIME type filter
      let mimeTypeFilter: string[] | undefined;
      if (type) {
        switch (type) {
          case 'image':
            mimeTypeFilter = this.config.allowedImageTypes;
            break;
          case 'audio':
            mimeTypeFilter = this.config.allowedAudioTypes;
            break;
          case 'video':
            mimeTypeFilter = this.config.allowedVideoTypes;
            break;
        }
      }

      const result = await this.fileRepository.findByCommunity(communityId, {
        page,
        limit,
        search,
        mimeTypeFilter,
        communityId,
      });

      // Transform to FileUploadResult format
      const transformedData = result.data.map((file) => {
        let metadata: FileMetadata | undefined;
        if (file.metadata) {
          metadata =
            typeof file.metadata === 'string'
              ? JSON.parse(file.metadata)
              : file.metadata;
        }

        let culturalRestrictions: CulturalRestrictions | undefined;
        if (file.culturalRestrictions) {
          culturalRestrictions =
            typeof file.culturalRestrictions === 'string'
              ? JSON.parse(file.culturalRestrictions)
              : file.culturalRestrictions;
        }

        return {
          id: file.id,
          filename: file.filename,
          originalName: file.originalName,
          path: file.path,
          url: file.url,
          size: file.size,
          mimeType: file.mimeType,
          communityId: file.communityId,
          uploadedBy: file.uploadedBy,
          metadata,
          culturalRestrictions,
          createdAt: file.createdAt,
        };
      });

      return {
        data: transformedData,
        meta: result.meta,
      };
    } catch (error) {
      throw new Error(`Failed to list files: ${error}`);
    }
  }

  /**
   * Validate file type using magic numbers
   */
  async validateFileType(file: MultipartFile): Promise<FileValidationResult> {
    try {
      // Read first chunk to check magic numbers
      const chunks: Buffer[] = [];
      let totalSize = 0;

      for await (const chunk of file.file) {
        chunks.push(chunk);
        totalSize += chunk.length;

        // Read enough for magic number detection (typically first 4096 bytes)
        if (totalSize >= 4096) {
          break;
        }
      }

      const buffer = Buffer.concat(chunks);

      // Detect actual file type from magic numbers
      const detectedType = await fileTypeFromBuffer(buffer);

      if (!detectedType) {
        return {
          isValid: false,
          error: 'Unable to detect file type from content',
        };
      }

      // Check if detected type is in allowed types
      const allAllowedTypes = [
        ...this.config.allowedImageTypes,
        ...this.config.allowedAudioTypes,
        ...this.config.allowedVideoTypes,
      ];

      if (!allAllowedTypes.includes(detectedType.mime)) {
        return {
          isValid: false,
          error: `File type not allowed: ${detectedType.mime}`,
        };
      }

      // Verify claimed MIME type matches detected type
      if (file.mimetype !== detectedType.mime) {
        return {
          isValid: false,
          error: 'File header does not match declared type',
        };
      }

      return {
        isValid: true,
        detectedType: detectedType.mime,
      };
    } catch (error) {
      return {
        isValid: false,
        error: `File validation error: ${error}`,
      };
    }
  }

  /**
   * Validate complete file after streaming
   */
  private async validateCompleteFile(
    buffer: Buffer,
    mimeType: string
  ): Promise<FileValidationResult> {
    try {
      // Re-verify file type with complete buffer
      const detectedType = await fileTypeFromBuffer(buffer);

      if (!detectedType || detectedType.mime !== mimeType) {
        return {
          isValid: false,
          error: 'File type changed during upload',
        };
      }

      // Additional security checks for specific file types
      if (mimeType.startsWith('image/')) {
        try {
          // Validate image using sharp (will throw if corrupted)
          await sharp(buffer).metadata();
        } catch {
          return {
            isValid: false,
            error: 'Invalid or corrupted image file',
          };
        }
      }

      return { isValid: true, detectedType: mimeType };
    } catch (error) {
      return {
        isValid: false,
        error: `File validation error: ${error}`,
      };
    }
  }

  /**
   * Validate file size against limits
   */
  private async validateFileSize(
    file: MultipartFile,
    options: FileUploadOptions
  ): Promise<void> {
    const maxSize =
      options.maxSize || this.getMaxSizeForMimeType(file.mimetype);

    if (maxSize && file.file.readableLength > maxSize) {
      throw new Error(
        `File size exceeds maximum allowed (${Math.round(maxSize / 1024 / 1024)}MB)`
      );
    }
  }

  /**
   * Get maximum file size for MIME type
   */
  getMaxSizeForMimeType(mimeType: string): number {
    if (this.config.allowedImageTypes.includes(mimeType)) {
      return this.config.maxFileSizes.image;
    }
    if (this.config.allowedAudioTypes.includes(mimeType)) {
      return this.config.maxFileSizes.audio;
    }
    if (this.config.allowedVideoTypes.includes(mimeType)) {
      return this.config.maxFileSizes.video;
    }
    return this.config.maxFileSizes.image; // Default to smallest
  }

  /**
   * Generate unique filename with UUID
   */
  private generateUniqueFilename(originalName: string): string {
    const ext = extname(originalName);
    const uuid = randomUUID();
    return `${uuid}${ext}`;
  }

  /**
   * Sanitize filename for security
   */
  sanitizeFilename(filename: string): string {
    // Remove path traversal attempts
    let sanitized = filename.replace(/[./\\:*?"<>|]/g, '_');

    // Remove control characters and null bytes
    // eslint-disable-next-line no-control-regex
    sanitized = sanitized.replace(/[\x00-\x1F\x7F]/g, '');

    // Limit length
    if (sanitized.length > 255) {
      const ext = extname(sanitized);
      const name = sanitized.slice(0, 255 - ext.length);
      sanitized = name + ext;
    }

    // Ensure it's not empty
    if (!sanitized || sanitized === '_') {
      sanitized = `file_${Date.now()}`;
    }

    return sanitized;
  }

  /**
   * Create file path with community isolation
   */
  private createFilePath(
    filename: string,
    communityId: number,
    mimeType: string
  ): string {
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');

    let typeDir = 'files';
    if (mimeType.startsWith('image/')) typeDir = 'images';
    else if (mimeType.startsWith('audio/')) typeDir = 'audio';
    else if (mimeType.startsWith('video/')) typeDir = 'video';

    return join(
      `community-${communityId}`,
      typeDir,
      `${year}`,
      `${month}`,
      filename
    );
  }

  /**
   * Extract metadata from file buffer
   */
  private async extractMetadata(
    buffer: Buffer,
    mimeType: string
  ): Promise<FileMetadata | undefined> {
    try {
      if (mimeType.startsWith('image/')) {
        const metadata = await sharp(buffer).metadata();
        return {
          width: metadata.width,
          height: metadata.height,
          channels: metadata.channels,
        };
      }

      // TODO: Add audio/video metadata extraction with ffprobe or similar
      // For now, return undefined for non-image files

      return undefined;
    } catch (error) {
      console.warn(`Failed to extract metadata: ${error}`);
      return undefined;
    }
  }
}
