/**
 * File Service V2
 *
 * TypeScript-native file service designed for ActiveStorage replacement.
 * Provides entity-based file operations with security, validation, and community isolation.
 *
 * Features:
 * - Entity-based path structure (uploads/<community>/<entity>/<id>/<filename>)
 * - Storage adapter interface for pluggable storage backends
 * - MIME type validation with video support toggle
 * - File size limits and filename sanitization
 * - Community data sovereignty enforcement
 * - No database integration (service layer only)
 */

import { createHash } from 'crypto';
import { extname, basename } from 'path';
import type { MultipartFile } from '@fastify/multipart';
import type { StorageAdapter } from './storage/storage-adapter.interface.js';

// Entity types supported by the service
export type FileServiceV2Entity = 'stories' | 'places' | 'speakers';

// Configuration interface
export interface FileServiceV2Config {
  /** Maximum file size in bytes (default: 25MB) */
  maxSizeBytes?: number;
  /** Allowed MIME type patterns (default: ['image/*', 'audio/*']) */
  allowedMimeTypes?: string[];
  /** Enable video upload support (default: false) */
  enableVideo?: boolean;
  /** Upload rate limit per user per minute (default: 10) */
  uploadRateLimit?: number;
  /** Base path for uploads (default: 'uploads') */
  baseUploadPath?: string;
}

// File upload result
export interface FileV2UploadResult {
  filename: string;
  path: string;
  size: number;
  contentType: string;
  etag: string;
  entity: FileServiceV2Entity;
  entityId: number;
  community: string;
  uploadedAt: Date;
}

// File download result
export interface FileV2DownloadResult {
  content: Buffer;
  metadata: {
    size: number;
    contentType?: string;
    etag?: string;
    lastModified?: Date;
  };
}

// File list item
export interface FileV2ListItem {
  filename: string;
  path: string;
  size: number;
  contentType?: string;
  etag?: string;
  lastModified?: Date;
}

// Custom error classes
export class FileValidationError extends Error {
  constructor(
    message: string,
    public field?: string
  ) {
    super(message);
    this.name = 'FileValidationError';
  }
}

export class FileSizeError extends Error {
  constructor(size: number, maxSize: number) {
    super(`File size ${size} bytes exceeds maximum ${maxSize} bytes`);
    this.name = 'FileSizeError';
  }
}

export class FileTypeError extends Error {
  constructor(mimeType: string, allowedTypes: string[]) {
    super(
      `MIME type ${mimeType} not allowed. Allowed types: ${allowedTypes.join(', ')}`
    );
    this.name = 'FileTypeError';
  }
}

export class FileServiceV2 {
  private readonly config: Required<FileServiceV2Config>;

  constructor(
    private readonly storage: StorageAdapter,
    config?: FileServiceV2Config
  ) {
    // Set default configuration
    this.config = {
      maxSizeBytes: config?.maxSizeBytes || 25 * 1024 * 1024, // 25MB
      allowedMimeTypes: config?.allowedMimeTypes || ['image/*', 'audio/*'],
      enableVideo: config?.enableVideo || false,
      uploadRateLimit: config?.uploadRateLimit || 10,
      baseUploadPath: config?.baseUploadPath || 'uploads',
    };

    // Add video support if enabled
    if (
      this.config.enableVideo &&
      !this.config.allowedMimeTypes.includes('video/*')
    ) {
      this.config.allowedMimeTypes.push('video/*');
    }
  }

  /**
   * Upload a file for a specific entity
   */
  async uploadFile(
    file: MultipartFile,
    community: string,
    entity: FileServiceV2Entity,
    entityId: number
  ): Promise<FileV2UploadResult> {
    // Validate inputs
    this.validateCommunityName(community);
    this.validateEntity(entity);
    this.validateEntityId(entityId);

    if (!file.file) {
      throw new FileValidationError('File buffer is required', 'file');
    }

    if (!file.filename) {
      throw new FileValidationError('Filename is required', 'filename');
    }

    // Convert to buffer (support stream and buffer)
    let fileBuffer: Buffer;
    if (Buffer.isBuffer(file.file)) {
      fileBuffer = file.file;
    } else if (typeof (file.file as any).on === 'function') {
      const chunks: Buffer[] = [];
      let total = 0;
      await new Promise<void>((resolve, reject) => {
        (file.file as any)
          .on('data', (chunk: Buffer) => {
            total += chunk.length;
            if (total > this.config.maxSizeBytes) {
              (file.file as any).destroy?.();
              reject(new FileSizeError(total, this.config.maxSizeBytes));
              return;
            }
            chunks.push(chunk);
          })
          .on('end', () => resolve())
          .on('error', (err: Error) => reject(err));
      });
      fileBuffer = Buffer.concat(chunks);
    } else {
      throw new FileValidationError('Unsupported file input type', 'file');
    }

    // Validate file size
    if (fileBuffer.length > this.config.maxSizeBytes) {
      throw new FileSizeError(fileBuffer.length, this.config.maxSizeBytes);
    }

    // Validate MIME type
    if (!this.isAllowedMimeType(file.mimetype)) {
      throw new FileTypeError(file.mimetype, this.config.allowedMimeTypes);
    }

    // Sanitize filename
    const sanitizedFilename = this.sanitizeFilename(file.filename);

    // Generate file path
    let filePath = this.generateFilePath(
      community,
      entity,
      entityId,
      sanitizedFilename
    );

    // Handle filename collisions
    if (await this.storage.exists(filePath)) {
      const uniqueFilename = this.generateUniqueFilename(sanitizedFilename);
      filePath = this.generateFilePath(
        community,
        entity,
        entityId,
        uniqueFilename
      );
    }

    // Upload to storage
    const uploadResult = await this.storage.upload(fileBuffer, filePath, {
      contentType: file.mimetype,
      overwrite: false,
    });

    return {
      filename: basename(uploadResult.path),
      path: uploadResult.path,
      size: uploadResult.size,
      contentType: file.mimetype,
      etag: uploadResult.etag,
      entity,
      entityId,
      community,
      uploadedAt: new Date(),
    };
  }

  /**
   * Download a file by entity and filename
   */
  async downloadFile(
    community: string,
    entity: FileServiceV2Entity,
    entityId: number,
    filename: string
  ): Promise<FileV2DownloadResult> {
    // Validate inputs
    this.validateCommunityName(community);
    this.validateEntity(entity);
    this.validateEntityId(entityId);

    if (!filename || filename.trim() === '') {
      throw new FileValidationError('Filename is required', 'filename');
    }

    // Generate file path
    const filePath = this.generateFilePath(
      community,
      entity,
      entityId,
      filename
    );

    // Download from storage
    const content = await this.storage.download(filePath);
    const metadata = await this.storage.getMetadata(filePath);

    return {
      content,
      metadata: {
        size: metadata.size,
        contentType: metadata.contentType,
        etag: metadata.etag,
        lastModified: metadata.lastModified,
      },
    };
  }

  /**
   * Delete a file by entity and filename
   */
  async deleteFile(
    community: string,
    entity: FileServiceV2Entity,
    entityId: number,
    filename: string
  ): Promise<void> {
    // Validate inputs
    this.validateCommunityName(community);
    this.validateEntity(entity);
    this.validateEntityId(entityId);

    if (!filename || filename.trim() === '') {
      throw new FileValidationError('Filename is required', 'filename');
    }

    // Generate file path
    const filePath = this.generateFilePath(
      community,
      entity,
      entityId,
      filename
    );

    // Delete from storage
    await this.storage.delete(filePath);
  }

  /**
   * Check if a file exists
   */
  async fileExists(
    community: string,
    entity: FileServiceV2Entity,
    entityId: number,
    filename: string
  ): Promise<boolean> {
    try {
      // Validate inputs
      this.validateCommunityName(community);
      this.validateEntity(entity);
      this.validateEntityId(entityId);

      if (!filename || filename.trim() === '') {
        return false;
      }

      // Generate file path
      const filePath = this.generateFilePath(
        community,
        entity,
        entityId,
        filename
      );

      // Check existence in storage
      return await this.storage.exists(filePath);
    } catch {
      return false;
    }
  }

  /**
   * List all files for an entity
   */
  async listFiles(
    community: string,
    entity: FileServiceV2Entity,
    entityId: number
  ): Promise<FileV2ListItem[]> {
    // Validate inputs
    this.validateCommunityName(community);
    this.validateEntity(entity);
    this.validateEntityId(entityId);

    // Generate directory prefix
    const directoryPrefix = `${this.config.baseUploadPath}/${community}/${entity}/${entityId}/`;

    // List files from storage
    const filePaths = await this.storage.list(directoryPrefix);

    // Get metadata for each file
    const fileItems: FileV2ListItem[] = [];
    for (const filePath of filePaths) {
      try {
        const metadata = await this.storage.getMetadata(filePath);
        fileItems.push({
          filename: basename(filePath),
          path: filePath,
          size: metadata.size,
          contentType: metadata.contentType,
          etag: metadata.etag,
          lastModified: metadata.lastModified,
        });
      } catch {
        // Skip files with metadata errors (don't need to use error variable)
      }
    }

    return fileItems;
  }

  /**
   * Generate file path for entity-based storage
   */
  generateFilePath(
    community: string,
    entity: FileServiceV2Entity,
    entityId: number,
    filename: string
  ): string {
    return `${this.config.baseUploadPath}/${community}/${entity}/${entityId}/${filename}`;
  }

  /**
   * Sanitize filename to prevent security issues
   */
  sanitizeFilename(filename: string): string {
    // Remove path traversal attempts
    const baseName = basename(filename);

    // Replace dangerous characters with hyphens, but preserve unicode letters
    let safe = baseName.replace(/[^a-zA-Z0-9\-_\.ñáéíóúÁÉÍÓÚüÜ]/g, '-');

    // Remove consecutive hyphens and leading/trailing hyphens
    safe = safe.replace(/[-]{2,}/g, '-').replace(/^-+|-+$/g, '');

    // Get extension and name parts
    const extension = extname(safe);
    const nameWithoutExt = safe.slice(0, safe.length - extension.length);

    // Ensure we don't end up with an empty name
    const finalName = nameWithoutExt || 'file';

    return finalName + extension;
  }

  /**
   * Validate community name format
   */
  validateCommunityName(community: string): void {
    if (!community || community.trim() === '') {
      throw new FileValidationError('Community name is required', 'community');
    }

    // Check for path traversal and invalid characters
    if (
      community.includes('..') ||
      community.includes('/') ||
      community.includes('\\')
    ) {
      throw new FileValidationError(
        'Invalid community name format',
        'community'
      );
    }

    // Basic format validation
    if (!/^[a-zA-Z0-9\-_]+$/.test(community)) {
      throw new FileValidationError(
        'Community name contains invalid characters',
        'community'
      );
    }
  }

  /**
   * Validate entity type
   */
  private validateEntity(
    entity: string
  ): asserts entity is FileServiceV2Entity {
    const validEntities: FileServiceV2Entity[] = [
      'stories',
      'places',
      'speakers',
    ];

    if (!validEntities.includes(entity as FileServiceV2Entity)) {
      throw new FileValidationError(
        `Invalid entity type: ${entity}. Valid types: ${validEntities.join(', ')}`,
        'entity'
      );
    }
  }

  /**
   * Validate entity ID
   */
  validateEntityId(entityId: number): void {
    if (!Number.isInteger(entityId) || entityId <= 0) {
      throw new FileValidationError(
        'Entity ID must be a positive integer',
        'entityId'
      );
    }
  }

  /**
   * Check if MIME type is allowed
   */
  private isAllowedMimeType(mimeType: string): boolean {
    return this.config.allowedMimeTypes.some((pattern) => {
      if (pattern.endsWith('/*')) {
        const baseType = pattern.slice(0, -2);
        return mimeType.startsWith(baseType + '/');
      }
      return mimeType === pattern;
    });
  }

  /**
   * Generate unique filename for collision handling
   */
  private generateUniqueFilename(originalFilename: string): string {
    const extension = extname(originalFilename);
    const nameWithoutExt = originalFilename.slice(
      0,
      originalFilename.length - extension.length
    );
    const uniqueSuffix = createHash('md5')
      .update(Date.now().toString())
      .digest('hex')
      .slice(0, 8);

    return `${nameWithoutExt}-${uniqueSuffix}${extension}`;
  }
}
