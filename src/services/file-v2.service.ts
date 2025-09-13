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
 * - Security validation for upload paths (prevents path traversal)
 *
 * Indigenous Data Sovereignty Considerations:
 * - Community-scoped file paths ensure data isolation
 * - Cultural protocol hooks can be added via middleware or service decoration
 * - Future: Elder-only content restrictions, cultural metadata, viewing permissions
 * - Future: Integration with cultural protocol validation system
 *
 * Cultural Protocol Integration (Future Enhancement):
 * The service is designed to support cultural protocols through:
 * 1. Middleware decorators for cultural validation
 * 2. Metadata attachment for cultural context
 * 3. Access control integration with Elder/cultural roles
 * 4. Community-specific upload policies
 */

import { createHash } from 'crypto';
import { extname, basename } from 'path';
import type { MultipartFile } from '@fastify/multipart';
import type { StorageAdapter } from './storage/storage-adapter.interface.js';
import type { AppConfig } from '../shared/config/types.js';

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
    config?: FileServiceV2Config | AppConfig
  ) {
    // Determine if config is AppConfig or FileServiceV2Config
    if (this.isAppConfig(config)) {
      // Convert AppConfig to internal format
      this.config = this.convertAppConfigToInternal(config);
      // eslint-disable-next-line no-console
      console.warn(
        'FileServiceV2: Using centralized AppConfig. Consider migrating legacy FileServiceV2Config usage.'
      );
    } else {
      // Handle legacy FileServiceV2Config format
      const baseUploadPath = config?.baseUploadPath || 'uploads';

      // Validate baseUploadPath for security (even in legacy mode)
      this.validateUploadPath(baseUploadPath);

      // eslint-disable-next-line no-console
      console.warn(
        'FileServiceV2: Using legacy FileServiceV2Config format. Consider migrating to centralized AppConfig system for better configuration management.'
      );

      this.config = {
        maxSizeBytes: config?.maxSizeBytes || 25 * 1024 * 1024, // 25MB
        allowedMimeTypes: config?.allowedMimeTypes || ['image/*', 'audio/*'],
        enableVideo: config?.enableVideo || false,
        uploadRateLimit: config?.uploadRateLimit || 10,
        baseUploadPath,
      };
    }

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

  /**
   * Type guard to detect if config is AppConfig
   *
   * Validates that the config object has a properly structured fileService
   * property with all required fields for FileServiceV2 configuration.
   *
   * Uses positive identification rather than exclusion to be more resilient
   * to future config schema evolution.
   */
  private isAppConfig(
    config?: FileServiceV2Config | AppConfig
  ): config is AppConfig {
    if (!config || typeof config !== 'object') return false;

    // Check for fileService property with proper structure
    const hasFileService =
      'fileService' in config &&
      config.fileService != null &&
      typeof config.fileService === 'object';

    if (!hasFileService) return false;

    // Validate that fileService has the expected structure
    const fileService = config.fileService as unknown as Record<
      string,
      unknown
    >;
    const hasRequiredProps =
      typeof fileService.maxSizeMB === 'number' &&
      typeof fileService.enableVideo === 'boolean' &&
      typeof fileService.encryptAtRest === 'boolean' &&
      typeof fileService.uploadRateLimit === 'number' &&
      typeof fileService.baseUploadPath === 'string';

    // Additional check: if it has legacy props but also valid fileService,
    // it might be a test fixture or hybrid object - trust the fileService structure
    return hasRequiredProps;
  }

  /**
   * Convert AppConfig to internal FileServiceV2Config format
   */
  private convertAppConfigToInternal(
    appConfig: AppConfig
  ): Required<FileServiceV2Config> {
    const fileServiceConfig = appConfig.fileService;

    // Validate baseUploadPath for security
    this.validateUploadPath(fileServiceConfig.baseUploadPath);

    // Build MIME types array based on enableVideo flag
    const allowedMimeTypes = ['image/*', 'audio/*'];
    if (fileServiceConfig.enableVideo) {
      allowedMimeTypes.push('video/*');
    }

    return {
      maxSizeBytes: fileServiceConfig.maxSizeMB * 1024 * 1024, // Convert MB to bytes
      allowedMimeTypes,
      enableVideo: fileServiceConfig.enableVideo,
      uploadRateLimit: fileServiceConfig.uploadRateLimit,
      baseUploadPath: fileServiceConfig.baseUploadPath,
    };
  }

  /**
   * Validate upload path to prevent security issues
   *
   * Checks for path traversal attempts and ensures the path is safe
   * for use as a base upload directory.
   */
  private validateUploadPath(uploadPath: string): void {
    if (!uploadPath || uploadPath.trim() === '') {
      throw new FileValidationError(
        'Upload path is required',
        'baseUploadPath'
      );
    }

    // Check for very long paths that could cause filesystem issues
    if (uploadPath.length > 255) {
      throw new FileValidationError(
        'Upload path is too long (max 255 characters)',
        'baseUploadPath'
      );
    }

    // Check for URL schemes (http://, https://, ftp://, etc.)
    if (/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(uploadPath)) {
      throw new FileValidationError(
        'Invalid upload path: URLs are not allowed',
        'baseUploadPath'
      );
    }

    // Check for Windows drive notation (C:, D:, etc.)
    if (/^[a-zA-Z]:/.test(uploadPath)) {
      throw new FileValidationError(
        'Invalid upload path: Windows drive notation not allowed',
        'baseUploadPath'
      );
    }

    // Check for path traversal attempts
    if (
      uploadPath.includes('..') ||
      uploadPath.includes('//') ||
      uploadPath.startsWith('/') ||
      uploadPath.includes('\\') ||
      uploadPath.includes('\0')
    ) {
      throw new FileValidationError(
        'Invalid upload path: contains path traversal or dangerous characters',
        'baseUploadPath'
      );
    }

    // Check for Unicode path traversal attempts
    if (
      uploadPath.includes('\u2215') || // Division slash
      uploadPath.includes('\u2216') || // Set minus
      uploadPath.includes('\u2044') || // Fraction slash
      uploadPath.includes('\u29F8') // Big solidus
    ) {
      throw new FileValidationError(
        'Invalid upload path: contains Unicode path traversal characters',
        'baseUploadPath'
      );
    }

    // Ensure path doesn't contain dangerous patterns
    const dangerousPatterns = [
      /\.\./, // Path traversal
      /\/\//, // Double slashes
      /[<>:"|?*]/, // Windows invalid characters
      /[\x00-\x1f]/, // Control characters
    ];

    for (const pattern of dangerousPatterns) {
      if (pattern.test(uploadPath)) {
        throw new FileValidationError(
          `Invalid upload path: contains dangerous pattern`,
          'baseUploadPath'
        );
      }
    }

    // Basic format validation - should be relative path
    if (!/^[a-zA-Z0-9._\-\/]+$/.test(uploadPath)) {
      throw new FileValidationError(
        'Upload path contains invalid characters',
        'baseUploadPath'
      );
    }
  }
}
