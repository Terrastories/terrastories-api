/**
 * Storage Adapter Interface
 *
 * Pluggable storage architecture for the TypeScript-native file service.
 * Supports local filesystem storage with interface for future cloud storage adapters.
 *
 * This interface is specifically designed for Issue #87 (ActiveStorage replacement foundation)
 * and uses entity-based path structures for Issue #86 compatibility.
 */

export interface StorageAdapter {
  /**
   * Upload a file to storage
   * @param file - File buffer to upload
   * @param path - Storage path (e.g., "uploads/community-1/stories/123/photo.jpg")
   * @returns Promise resolving to the storage path
   */
  upload(file: Buffer, path: string): Promise<string>;

  /**
   * Download a file from storage
   * @param path - Storage path to download from
   * @returns Promise resolving to file buffer
   * @throws Error if file not found
   */
  download(path: string): Promise<Buffer>;

  /**
   * Delete a file from storage
   * @param path - Storage path to delete
   * @returns Promise resolving when deletion complete
   * @throws Error if file not found
   */
  delete(path: string): Promise<void>;

  /**
   * Check if a file exists in storage
   * @param path - Storage path to check
   * @returns Promise resolving to boolean indicating existence
   */
  exists(path: string): Promise<boolean>;

  /**
   * Get file metadata without downloading
   * @param path - Storage path to get metadata for
   * @returns Promise resolving to file metadata
   * @throws Error if file not found
   */
  getMetadata(path: string): Promise<StorageFileMetadata>;
}

/**
 * File metadata returned by storage adapter
 */
export interface StorageFileMetadata {
  /** File size in bytes */
  size: number;
  /** Last modified timestamp */
  lastModified: Date;
  /** Content type/MIME type if available */
  contentType?: string;
  /** ETag or file hash if available */
  etag?: string;
}

/**
 * Configuration for storage adapters
 */
export interface StorageAdapterConfig {
  /** Base directory for file storage */
  baseDir: string;
  /** Maximum file size in bytes */
  maxFileSize: number;
  /** Whether to generate ETags for files */
  generateEtags: boolean;
}

/**
 * Storage adapter factory interface for dependency injection
 */
export interface StorageAdapterFactory {
  create(config: StorageAdapterConfig): StorageAdapter;
}
