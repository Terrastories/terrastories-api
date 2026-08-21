/**
 * Local Storage Adapter
 *
 * Implements the StorageAdapter interface for local filesystem storage.
 * Provides secure, community-scoped file operations with path validation.
 */

import { promises as fs } from 'fs';
import { join, dirname, resolve, normalize } from 'path';
import { createHash } from 'crypto';
import { stat } from 'fs/promises';
import {
  type StorageAdapter,
  type StorageUploadResult,
  type StorageMetadata,
  StorageError,
  StorageNotFoundError,
  StorageConflictError,
  StoragePermissionError,
} from './storage-adapter.interface.js';

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }

  const { code } = error as { code?: unknown };
  return typeof code === 'string' ? code : undefined;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export class LocalStorageAdapter implements StorageAdapter {
  private readonly basePath: string;
  private readonly metadataMap = new Map<string, { contentType?: string }>();

  constructor(basePath: string) {
    this.basePath = resolve(basePath);
  }

  async upload(
    file: Buffer,
    path: string,
    options?: { contentType?: string; overwrite?: boolean }
  ): Promise<StorageUploadResult> {
    try {
      // Validate and normalize path
      const safePath = this.validateAndNormalizePath(path);
      const fullPath = join(this.basePath, safePath);

      // Check if file exists when overwrite is disabled
      if (!options?.overwrite) {
        try {
          await fs.access(fullPath);
          throw new StorageConflictError(safePath);
        } catch (error) {
          // File doesn't exist, which is what we want
          if (getErrorCode(error) !== 'ENOENT') {
            throw error;
          }
        }
      }

      // Ensure directory exists
      await fs.mkdir(dirname(fullPath), { recursive: true });

      // Write file
      await fs.writeFile(fullPath, file);

      // Store metadata for future retrieval
      if (options?.contentType) {
        this.metadataMap.set(safePath, { contentType: options.contentType });
      }

      // Compute ETag (MD5 hash)
      const etag = createHash('md5').update(file).digest('hex');

      return {
        path: safePath,
        size: file.length,
        etag,
        contentType: options?.contentType,
      };
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      if (getErrorCode(error) === 'EACCES') {
        throw new StoragePermissionError(path, asError(error));
      }

      throw new StorageError(`Failed to upload file: ${path}`, asError(error));
    }
  }

  async download(path: string): Promise<Buffer> {
    try {
      const safePath = this.validateAndNormalizePath(path);
      const fullPath = join(this.basePath, safePath);

      return await fs.readFile(fullPath);
    } catch (error) {
      if (getErrorCode(error) === 'ENOENT') {
        throw new StorageNotFoundError(path, asError(error));
      }

      if (getErrorCode(error) === 'EACCES') {
        throw new StoragePermissionError(path, asError(error));
      }

      throw new StorageError(
        `Failed to download file: ${path}`,
        asError(error)
      );
    }
  }

  async delete(path: string): Promise<void> {
    try {
      const safePath = this.validateAndNormalizePath(path);
      const fullPath = join(this.basePath, safePath);

      await fs.unlink(fullPath);

      // Clean up metadata
      this.metadataMap.delete(safePath);
    } catch (error) {
      if (getErrorCode(error) === 'ENOENT') {
        throw new StorageNotFoundError(path, asError(error));
      }

      if (getErrorCode(error) === 'EACCES') {
        throw new StoragePermissionError(path, asError(error));
      }

      throw new StorageError(`Failed to delete file: ${path}`, asError(error));
    }
  }

  async exists(path: string): Promise<boolean> {
    try {
      const safePath = this.validateAndNormalizePath(path);
      const fullPath = join(this.basePath, safePath);

      await fs.access(fullPath);
      return true;
    } catch (error) {
      if (getErrorCode(error) === 'ENOENT') {
        return false;
      }

      // Re-throw other errors (permissions, etc.)
      throw new StorageError(
        `Failed to check file existence: ${path}`,
        asError(error)
      );
    }
  }

  async getMetadata(path: string): Promise<StorageMetadata> {
    try {
      const safePath = this.validateAndNormalizePath(path);
      const fullPath = join(this.basePath, safePath);

      const stats = await stat(fullPath);
      const fileContent = await fs.readFile(fullPath);
      const etag = createHash('md5').update(fileContent).digest('hex');

      // Get stored metadata
      const storedMetadata = this.metadataMap.get(safePath);

      return {
        size: stats.size,
        lastModified: stats.mtime,
        etag,
        contentType: storedMetadata?.contentType,
      };
    } catch (error) {
      if (getErrorCode(error) === 'ENOENT') {
        throw new StorageNotFoundError(path, asError(error));
      }

      if (getErrorCode(error) === 'EACCES') {
        throw new StoragePermissionError(path, asError(error));
      }

      throw new StorageError(
        `Failed to get file metadata: ${path}`,
        asError(error)
      );
    }
  }

  async list(prefix: string): Promise<string[]> {
    try {
      const safePrefix = this.validateAndNormalizePath(prefix);
      const fullPrefixPath = join(this.basePath, safePrefix);

      // Check if directory exists
      try {
        const stats = await stat(fullPrefixPath);
        if (!stats.isDirectory()) {
          return [];
        }
      } catch (error) {
        if (getErrorCode(error) === 'ENOENT') {
          return [];
        }
        throw error;
      }

      // Read directory contents recursively
      const files: string[] = [];
      await this.listRecursive(fullPrefixPath, safePrefix, files);

      return files;
    } catch (error) {
      if (getErrorCode(error) === 'ENOENT') {
        return [];
      }

      throw new StorageError(`Failed to list files: ${prefix}`, asError(error));
    }
  }

  private async listRecursive(
    currentPath: string,
    relativePath: string,
    files: string[]
  ): Promise<void> {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(currentPath, entry.name);
      const relPath = join(relativePath, entry.name);

      if (entry.isFile()) {
        files.push(relPath);
      } else if (entry.isDirectory()) {
        await this.listRecursive(fullPath, relPath, files);
      }
    }
  }

  private validateAndNormalizePath(path: string): string {
    // Normalize path to handle '..' and '.'
    const normalized = normalize(path);

    // Check for path traversal attempts
    if (normalized.includes('..') || normalized.startsWith('/')) {
      throw new StorageError(`Invalid path: ${path} (path traversal detected)`);
    }

    // Remove leading slash if present
    return normalized.startsWith('./') ? normalized.slice(2) : normalized;
  }
}

// Export storage errors for use in other modules
export {
  StorageError,
  StorageNotFoundError,
  StorageConflictError,
  StoragePermissionError,
} from './storage-adapter.interface.js';
