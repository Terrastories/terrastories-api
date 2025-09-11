/**
 * Storage Adapter Interface
 *
 * Defines the contract for pluggable storage systems in the file service v2 architecture.
 * Enables support for local filesystem, S3, GCS, and other storage backends.
 *
 * Design Principles:
 * - Path-based operations for flexibility
 * - Async/await for all operations
 * - Proper error handling with specific error types
 * - Support for streaming and metadata
 */

export interface StorageMetadata {
  /** File size in bytes */
  size: number;
  /** Last modified timestamp */
  lastModified: Date;
  /** Content type/MIME type */
  contentType?: string;
  /** ETag for file integrity */
  etag?: string;
}

export interface StorageUploadResult {
  /** Full path where file was stored */
  path: string;
  /** File size in bytes */
  size: number;
  /** ETag for file integrity */
  etag: string;
  /** Content type determined by adapter */
  contentType?: string;
}

export interface StorageAdapter {
  /**
   * Upload a file to the storage system
   * @param file File buffer to upload
   * @param path Destination path in storage
   * @param options Optional metadata and configuration
   * @returns Upload result with path and metadata
   */
  upload(
    file: Buffer,
    path: string,
    options?: {
      contentType?: string;
      overwrite?: boolean;
    }
  ): Promise<StorageUploadResult>;

  /**
   * Download a file from storage
   * @param path Path to file in storage
   * @returns File buffer
   * @throws StorageNotFoundError if file doesn't exist
   */
  download(path: string): Promise<Buffer>;

  /**
   * Delete a file from storage
   * @param path Path to file in storage
   * @returns Promise that resolves when deletion is complete
   * @throws StorageNotFoundError if file doesn't exist
   */
  delete(path: string): Promise<void>;

  /**
   * Check if file exists in storage
   * @param path Path to check
   * @returns True if file exists, false otherwise
   */
  exists(path: string): Promise<boolean>;

  /**
   * Get file metadata without downloading
   * @param path Path to file
   * @returns File metadata
   * @throws StorageNotFoundError if file doesn't exist
   */
  getMetadata(path: string): Promise<StorageMetadata>;

  /**
   * List files in a directory path
   * @param prefix Directory path prefix
   * @returns Array of file paths
   */
  list(prefix: string): Promise<string[]>;
}

/**
 * Base storage error class
 */
export class StorageError extends Error {
  constructor(
    message: string,
    public cause?: Error
  ) {
    super(message);
    this.name = 'StorageError';
  }
}

/**
 * File not found error
 */
export class StorageNotFoundError extends StorageError {
  constructor(path: string, cause?: Error) {
    super(`File not found: ${path}`, cause);
    this.name = 'StorageNotFoundError';
  }
}

/**
 * File already exists error (when overwrite not allowed)
 */
export class StorageConflictError extends StorageError {
  constructor(path: string, cause?: Error) {
    super(`File already exists: ${path}`, cause);
    this.name = 'StorageConflictError';
  }
}

/**
 * Insufficient storage space error
 */
export class StorageSpaceError extends StorageError {
  constructor(message: string, cause?: Error) {
    super(message, cause);
    this.name = 'StorageSpaceError';
  }
}

/**
 * Permission/access error
 */
export class StoragePermissionError extends StorageError {
  constructor(path: string, cause?: Error) {
    super(`Permission denied: ${path}`, cause);
    this.name = 'StoragePermissionError';
  }
}
