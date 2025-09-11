/**
 * Local Storage Adapter
 *
 * Local filesystem implementation of the StorageAdapter interface.
 * Provides secure file storage with path validation and ETag generation.
 *
 * This adapter is designed for Issue #87 (ActiveStorage replacement foundation)
 * and implements entity-based path structures for Issue #86 compatibility.
 */

import { promises as fs } from 'fs';
import { join, dirname, normalize, resolve, relative } from 'path';
import { createHash } from 'crypto';
import type {
  StorageAdapter,
  StorageFileMetadata,
  StorageAdapterConfig,
} from './storage-adapter.interface.js';

export class LocalStorageAdapter implements StorageAdapter {
  private readonly baseDir: string;
  private readonly maxFileSize: number;
  private readonly generateEtags: boolean;

  constructor(config: StorageAdapterConfig) {
    if (!config.baseDir || config.baseDir.trim() === '') {
      throw new Error('Base directory is required');
    }

    if (config.maxFileSize < 0) {
      throw new Error('Max file size must be non-negative');
    }

    this.baseDir = resolve(config.baseDir);
    this.maxFileSize = config.maxFileSize;
    this.generateEtags = config.generateEtags;
  }

  async upload(file: Buffer, path: string): Promise<string> {
    // Validate file size
    if (file.length > this.maxFileSize) {
      throw new Error(
        `File size ${file.length} exceeds maximum allowed ${this.maxFileSize} bytes`
      );
    }

    // Validate and sanitize path
    const safePath = this.validateAndSanitizePath(path);
    const fullPath = join(this.baseDir, safePath);

    // Ensure the file path doesn't escape the base directory
    const resolvedPath = resolve(fullPath);
    const resolvedBaseDir = resolve(this.baseDir);

    // Use path.relative to check containment in a cross-platform way
    const relativePath = relative(resolvedBaseDir, resolvedPath);
    const isInsideBase =
      relativePath === '' ||
      (!relativePath.startsWith('..') && !relativePath.startsWith('/'));

    if (!isInsideBase) {
      throw new Error('Invalid path: path traversal detected');
    }

    try {
      // Create directory structure
      await fs.mkdir(dirname(fullPath), { recursive: true });

      // Write file to disk
      await fs.writeFile(fullPath, file);

      return safePath;
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to upload file: ${error.message}`);
      }
      throw new Error('Failed to upload file: Unknown error');
    }
  }

  async download(path: string): Promise<Buffer> {
    const safePath = this.validateAndSanitizePath(path);
    const fullPath = join(this.baseDir, safePath);

    // Ensure the file path doesn't escape the base directory
    if (!this.isPathContained(fullPath)) {
      throw new Error('Invalid path: path traversal detected');
    }

    try {
      const buffer = await fs.readFile(fullPath);
      return buffer;
    } catch (error) {
      if (error instanceof Error && 'code' in error) {
        if (error.code === 'ENOENT') {
          throw new Error(`File not found: ${path}`);
        }
        if (error.code === 'EISDIR') {
          throw new Error(`Path is a directory, not a file: ${path}`);
        }
      }
      throw new Error(
        `Failed to download file: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  async delete(path: string): Promise<void> {
    const safePath = this.validateAndSanitizePath(path);
    const fullPath = join(this.baseDir, safePath);

    // Ensure the file path doesn't escape the base directory
    if (!this.isPathContained(fullPath)) {
      throw new Error('Invalid path: path traversal detected');
    }

    try {
      await fs.unlink(fullPath);
    } catch (error) {
      if (error instanceof Error && 'code' in error) {
        if (error.code === 'ENOENT') {
          throw new Error(`File not found: ${path}`);
        }
      }
      throw new Error(
        `Failed to delete file: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  async exists(path: string): Promise<boolean> {
    try {
      const safePath = this.validateAndSanitizePath(path);
      const fullPath = join(this.baseDir, safePath);

      // Ensure the file path doesn't escape the base directory
      if (!this.isPathContained(fullPath)) {
        return false;
      }

      const stats = await fs.stat(fullPath);
      return stats.isFile();
    } catch {
      return false;
    }
  }

  async getMetadata(path: string): Promise<StorageFileMetadata> {
    const safePath = this.validateAndSanitizePath(path);
    const fullPath = join(this.baseDir, safePath);

    // Ensure the file path doesn't escape the base directory
    if (!this.isPathContained(fullPath)) {
      throw new Error('Invalid path: path traversal detected');
    }

    try {
      const stats = await fs.stat(fullPath);

      if (!stats.isFile()) {
        throw new Error(`Path is not a file: ${path}`);
      }

      const metadata: StorageFileMetadata = {
        size: stats.size,
        lastModified: stats.mtime,
      };

      // Generate ETag if enabled
      if (this.generateEtags) {
        try {
          const buffer = await fs.readFile(fullPath);
          const hash = createHash('md5').update(buffer).digest('hex');
          metadata.etag = `"${hash}"`;
        } catch {
          // If we can't read the file for ETag generation, continue without it
          // This could happen if the file was deleted between stat and read
        }
      }

      return metadata;
    } catch (error) {
      if (error instanceof Error && 'code' in error) {
        if (error.code === 'ENOENT') {
          throw new Error(`File not found: ${path}`);
        }
      }
      throw new Error(
        `Failed to get file metadata: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Validate and sanitize a file path to prevent security issues
   */
  private validateAndSanitizePath(path: string): string {
    if (!path || path.trim() === '') {
      throw new Error('Path cannot be empty');
    }

    // Normalize the path to resolve any . or .. segments
    const normalized = normalize(path);

    // Reject absolute paths
    if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
      throw new Error('Absolute paths are not allowed');
    }

    // Reject paths that try to traverse upward
    if (normalized.includes('..') || normalized.startsWith('.')) {
      throw new Error('Path traversal attempts are not allowed');
    }

    // Reject paths with null bytes or other control characters
    if (/[\x00-\x1f\x7f]/.test(normalized)) {
      throw new Error('Paths cannot contain control characters');
    }

    // Ensure path starts with 'uploads/' for security
    if (!normalized.startsWith('uploads/')) {
      throw new Error('All file paths must start with "uploads/"');
    }

    return normalized;
  }

  /**
   * Cross-platform containment check using path.relative
   * @param fullPath - The full resolved path to check
   * @returns true if path is contained within base directory
   */
  private isPathContained(fullPath: string): boolean {
    const resolvedPath = resolve(fullPath);
    const resolvedBaseDir = resolve(this.baseDir);

    // Use path.relative to check containment in a cross-platform way
    const relativePath = relative(resolvedBaseDir, resolvedPath);
    return (
      relativePath === '' ||
      (!relativePath.startsWith('..') && !relativePath.startsWith('/'))
    );
  }
}
