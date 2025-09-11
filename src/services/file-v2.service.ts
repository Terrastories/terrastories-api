/**
 * FileServiceV2 - TypeScript-Native File Service
 *
 * Entity-based file service designed for ActiveStorage replacement.
 * Provides secure file operations with pluggable storage adapters.
 *
 * This is Phase 1 of the ActiveStorage replacement strategy outlined in Issue #86.
 * Creates the service foundation that Issue #86 will build upon for database integration.
 */

import { randomUUID } from 'crypto';
import { extname } from 'path';
import type { MultipartFile } from '@fastify/multipart';
import type { StorageAdapter } from './storage/storage-adapter.interface.js';
import type {
  FileServiceV2Config,
  FileUploadOptions,
  FileUploadResult,
  FileDownloadOptions,
  FileDownloadResult,
  FileDeleteOptions,
  FileListOptions,
  FileListResult,
  EntityType,
} from '../shared/types/file-v2.types.js';

// Rate limiting tracking (in-memory for now)
interface RateLimitEntry {
  count: number;
  windowStart: number;
}

// File tracking for service-layer-only implementation
interface TrackedFile {
  filename: string;
  originalName: string;
  path: string;
  url: string;
  size: number;
  mimeType: string;
  community: string;
  entity: EntityType;
  entityId: number;
  uploadedBy: number;
  createdAt: Date;
  etag?: string;
}

export class FileServiceV2 {
  private rateLimitMap = new Map<string, RateLimitEntry>();
  private fileTracker = new Map<string, TrackedFile>(); // In-memory file tracking

  constructor(
    private readonly storage: StorageAdapter,
    private readonly config: FileServiceV2Config
  ) {}

  async uploadFile(
    file: MultipartFile,
    options: FileUploadOptions
  ): Promise<FileUploadResult> {
    try {
      // Validate inputs
      this.validateUploadOptions(options);

      // Check rate limiting
      await this.checkRateLimit(options.uploadedBy);

      // Read file content
      const buffer = await this.readMultipartFile(file);

      // Validate file
      await this.validateFile(buffer, file.mimetype);

      // Generate filename and path
      const filename = options.preserveFilename
        ? this.sanitizeFilename(file.filename || 'file')
        : this.generateUniqueFilename(file.filename || 'file');

      const path = this.createEntityPath(
        options.community,
        options.entity,
        options.entityId,
        filename
      );

      // Upload to storage
      const storagePath = await this.storage.upload(buffer, path);

      // Generate URL
      const url = this.createFileUrl(
        options.community,
        options.entity,
        options.entityId,
        filename
      );

      // Get file metadata
      const metadata = await this.storage.getMetadata(storagePath);

      const result = {
        filename,
        originalName: file.filename || 'file',
        path: storagePath,
        url,
        size: buffer.length,
        mimeType: file.mimetype,
        community: options.community,
        entity: options.entity,
        entityId: options.entityId,
        uploadedBy: options.uploadedBy,
        createdAt: new Date(),
        etag: metadata.etag,
      };

      // Track file in memory for service-layer-only implementation
      this.fileTracker.set(storagePath, result);

      return result;
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`File upload failed: ${error.message}`);
      }
      throw new Error('File upload failed: Unknown error');
    }
  }

  async downloadFile(
    options: FileDownloadOptions
  ): Promise<FileDownloadResult> {
    try {
      this.validateDownloadOptions(options);

      const path = this.createEntityPath(
        options.community,
        options.entity,
        options.entityId,
        options.filename
      );

      const buffer = await this.storage.download(path);
      const metadata = await this.storage.getMetadata(path);

      // Try to get tracked file info
      const trackedFile = this.fileTracker.get(path);

      // Extract MIME type from filename extension as fallback
      const ext = extname(options.filename).toLowerCase();
      const mimeType =
        trackedFile?.mimeType || this.getMimeTypeFromExtension(ext);
      const originalName = trackedFile?.originalName || options.filename;

      return {
        buffer,
        metadata: {
          filename: options.filename,
          originalName,
          size: buffer.length,
          mimeType,
          etag: metadata.etag,
        },
      };
    } catch (error) {
      if (error instanceof Error && error.message.includes('not found')) {
        throw new Error('File not found');
      }
      throw new Error(
        `File download failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  async deleteFile(options: FileDeleteOptions): Promise<void> {
    try {
      this.validateDeleteOptions(options);

      const path = this.createEntityPath(
        options.community,
        options.entity,
        options.entityId,
        options.filename
      );

      await this.storage.delete(path);

      // Remove from tracking
      this.fileTracker.delete(path);
    } catch (error) {
      if (error instanceof Error && error.message.includes('not found')) {
        throw new Error('File not found');
      }
      throw new Error(
        `File deletion failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  async listFiles(options: FileListOptions): Promise<FileListResult> {
    try {
      this.validateListOptions(options);

      // Use in-memory file tracking for service-layer-only implementation
      // Filter files based on options
      let filteredFiles = Array.from(this.fileTracker.values()).filter(
        (file) => file.community === options.community
      );

      if (options.entity) {
        filteredFiles = filteredFiles.filter(
          (file) => file.entity === options.entity
        );
      }

      if (options.entityId) {
        filteredFiles = filteredFiles.filter(
          (file) => file.entityId === options.entityId
        );
      }

      const total = filteredFiles.length;

      const page = options.page || 1;
      const limit = options.limit || 20;
      const totalPages = Math.ceil(total / limit);

      // Apply pagination
      const startIndex = (page - 1) * limit;
      const paginatedFiles = filteredFiles.slice(
        startIndex,
        startIndex + limit
      );

      return {
        files: paginatedFiles,
        total,
        page,
        totalPages,
      };
    } catch (error) {
      throw new Error(
        `File listing failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Validate upload options
   */
  private validateUploadOptions(options: FileUploadOptions): void {
    if (!options.community || options.community.trim() === '') {
      throw new Error('Community is required');
    }

    if (!['stories', 'places', 'speakers'].includes(options.entity)) {
      throw new Error(`Invalid entity type: ${options.entity}`);
    }

    if (!Number.isInteger(options.entityId) || options.entityId <= 0) {
      throw new Error('Entity ID must be a positive integer');
    }

    if (!Number.isInteger(options.uploadedBy) || options.uploadedBy <= 0) {
      throw new Error('Uploaded by user ID must be a positive integer');
    }

    // Validate community name for security - be more strict
    if (
      options.community.includes('..') ||
      options.community.includes('/') ||
      options.community.includes('\\') ||
      options.community === '.' ||
      options.community === '..' ||
      options.community.startsWith('.')
    ) {
      throw new Error('Invalid community name: path traversal detected');
    }
  }

  /**
   * Validate download options
   */
  private validateDownloadOptions(options: FileDownloadOptions): void {
    if (!options.community || options.community.trim() === '') {
      throw new Error('Community is required');
    }

    if (!['stories', 'places', 'speakers'].includes(options.entity)) {
      throw new Error(`Invalid entity type: ${options.entity}`);
    }

    if (!Number.isInteger(options.entityId) || options.entityId <= 0) {
      throw new Error('Entity ID must be a positive integer');
    }

    if (!options.filename || options.filename.trim() === '') {
      throw new Error('Filename is required');
    }

    // Security validation - be more strict
    if (
      options.community.includes('..') ||
      options.community.includes('/') ||
      options.community.includes('\\') ||
      options.community === '.' ||
      options.community === '..' ||
      options.community.startsWith('.')
    ) {
      throw new Error('Invalid community name');
    }

    if (options.filename.includes('..') || options.filename.includes('/')) {
      throw new Error('Invalid filename');
    }
  }

  /**
   * Validate delete options (same as download)
   */
  private validateDeleteOptions(options: FileDeleteOptions): void {
    this.validateDownloadOptions(options);
  }

  /**
   * Validate list options
   */
  private validateListOptions(options: FileListOptions): void {
    if (!options.community || options.community.trim() === '') {
      throw new Error('Community is required');
    }

    if (
      options.entity &&
      !['stories', 'places', 'speakers'].includes(options.entity)
    ) {
      throw new Error(`Invalid entity type: ${options.entity}`);
    }

    if (
      options.entityId !== undefined &&
      (!Number.isInteger(options.entityId) || options.entityId <= 0)
    ) {
      throw new Error('Entity ID must be a positive integer');
    }

    if (
      options.page !== undefined &&
      (!Number.isInteger(options.page) || options.page < 1)
    ) {
      throw new Error('Page must be a positive integer');
    }

    if (
      options.limit !== undefined &&
      (!Number.isInteger(options.limit) ||
        options.limit < 1 ||
        options.limit > 100)
    ) {
      throw new Error('Limit must be between 1 and 100');
    }

    // Security validation - be more strict
    if (
      options.community.includes('..') ||
      options.community.includes('/') ||
      options.community.includes('\\') ||
      options.community === '.' ||
      options.community === '..' ||
      options.community.startsWith('.')
    ) {
      throw new Error('Invalid community name');
    }
  }

  /**
   * Check rate limiting for user
   */
  private async checkRateLimit(userId: number): Promise<void> {
    const key = `user-${userId}`;
    const now = Date.now();
    const windowStart = now - this.config.rateLimiting.windowMs;

    const entry = this.rateLimitMap.get(key);

    if (!entry || entry.windowStart < windowStart) {
      // New window
      this.rateLimitMap.set(key, {
        count: 1,
        windowStart: now,
      });
      return;
    }

    if (entry.count >= this.config.rateLimiting.maxUploads) {
      throw new Error('Rate limit exceeded: too many uploads in time window');
    }

    entry.count++;
  }

  /**
   * Read multipart file into buffer
   */
  private async readMultipartFile(file: MultipartFile): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let totalSize = 0;

    for await (const chunk of file.file) {
      totalSize += chunk.length;

      // Check size limit during streaming
      if (totalSize > this.config.maxFileSize) {
        throw new Error(
          `File size exceeds maximum allowed ${this.config.maxFileSize} bytes`
        );
      }

      chunks.push(chunk);
    }

    return Buffer.concat(chunks);
  }

  /**
   * Validate file content and type
   */
  private async validateFile(buffer: Buffer, mimeType: string): Promise<void> {
    // Size validation (already done during streaming, but double-check)
    if (buffer.length > this.config.maxFileSize) {
      throw new Error(
        `File size exceeds maximum allowed ${this.config.maxFileSize} bytes`
      );
    }

    // MIME type validation
    const allAllowedTypes = [
      ...this.config.allowedMimeTypes.image,
      ...this.config.allowedMimeTypes.audio,
      ...(this.config.enableVideo ? this.config.allowedMimeTypes.video : []),
    ];

    // Allow text/plain in test/development environments
    if (
      process.env.NODE_ENV === 'test' ||
      process.env.NODE_ENV === 'development'
    ) {
      allAllowedTypes.push('text/plain');
    }

    if (!allAllowedTypes.includes(mimeType)) {
      if (mimeType.startsWith('video/') && !this.config.enableVideo) {
        throw new Error('Video files not enabled');
      }
      throw new Error(`File type not allowed: ${mimeType}`);
    }
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
  private sanitizeFilename(filename: string): string {
    // Remove path traversal attempts
    let sanitized = filename.replace(/[/\\:*?"<>|]/g, '_');

    // Remove dangerous patterns
    sanitized = sanitized.replace(/\.\./g, '_');
    sanitized = sanitized.replace(/^\./, '_');

    // Remove control characters
    sanitized = sanitized.replace(/[\x00-\x1f\x7f]/g, '');

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
   * Create entity-based storage path
   */
  private createEntityPath(
    community: string,
    entity: EntityType,
    entityId: number,
    filename: string
  ): string {
    return `uploads/${community}/${entity}/${entityId}/${filename}`;
  }

  /**
   * Create file URL for API access
   */
  private createFileUrl(
    community: string,
    entity: EntityType,
    entityId: number,
    filename: string
  ): string {
    return `/api/v1/files-v2/${community}/${entity}/${entityId}/${filename}`;
  }

  /**
   * Get MIME type from file extension
   */
  private getMimeTypeFromExtension(ext: string): string {
    const mimeTypes: Record<string, string> = {
      '.txt': 'text/plain',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.ogg': 'audio/ogg',
      '.mp4': 'video/mp4',
      '.webm': 'video/webm',
    };

    return mimeTypes[ext] || 'application/octet-stream';
  }
}
