/**
 * Local Storage Adapter Tests
 *
 * Comprehensive test suite for the local filesystem storage adapter implementation.
 * Uses temporary directories and proper cleanup for isolated testing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import {
  LocalStorageAdapter,
  type StorageAdapter,
  StorageNotFoundError,
  StorageConflictError,
  StoragePermissionError,
} from '../../../src/services/storage/local-storage.adapter.js';

describe('LocalStorageAdapter', () => {
  let adapter: StorageAdapter;
  let testDir: string;

  beforeEach(async () => {
    // Create unique temporary directory for each test
    testDir = join(tmpdir(), `storage-test-${randomUUID()}`);
    await fs.mkdir(testDir, { recursive: true });
    adapter = new LocalStorageAdapter(testDir);
  });

  afterEach(async () => {
    // Clean up test directory
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('upload', () => {
    it('should upload a file successfully', async () => {
      // Arrange
      const fileContent = Buffer.from('test file content');
      const path = 'community-1/stories/123/test.txt';

      // Act
      const result = await adapter.upload(fileContent, path);

      // Assert
      expect(result.path).toBe(path);
      expect(result.size).toBe(fileContent.length);
      expect(result.etag).toBeDefined();
      expect(typeof result.etag).toBe('string');

      // Verify file was actually written
      const storedContent = await fs.readFile(join(testDir, path));
      expect(storedContent.equals(fileContent)).toBe(true);
    });

    it('should create directory structure when uploading', async () => {
      // Arrange
      const fileContent = Buffer.from('nested file');
      const path = 'community-2/places/456/deep/nested/file.jpg';

      // Act
      await adapter.upload(fileContent, path);

      // Assert
      const storedContent = await fs.readFile(join(testDir, path));
      expect(storedContent.equals(fileContent)).toBe(true);

      // Verify directory structure was created
      const dirPath = join(testDir, dirname(path));
      const dirStat = await fs.stat(dirPath);
      expect(dirStat.isDirectory()).toBe(true);
    });

    it('should include content type when provided', async () => {
      // Arrange
      const fileContent = Buffer.from('image data');
      const path = 'community-1/stories/123/photo.jpg';

      // Act
      const result = await adapter.upload(fileContent, path, {
        contentType: 'image/jpeg',
      });

      // Assert
      expect(result.contentType).toBe('image/jpeg');
    });

    it('should fail when file exists and overwrite is false', async () => {
      // Arrange
      const fileContent = Buffer.from('original content');
      const path = 'community-1/stories/123/existing.txt';
      await adapter.upload(fileContent, path);

      const newContent = Buffer.from('new content');

      // Act & Assert
      await expect(
        adapter.upload(newContent, path, { overwrite: false })
      ).rejects.toThrow(StorageConflictError);
    });

    it('should overwrite when file exists and overwrite is true', async () => {
      // Arrange
      const originalContent = Buffer.from('original content');
      const path = 'community-1/stories/123/overwrite.txt';
      await adapter.upload(originalContent, path);

      const newContent = Buffer.from('new content');

      // Act
      const result = await adapter.upload(newContent, path, {
        overwrite: true,
      });

      // Assert
      expect(result.size).toBe(newContent.length);
      const storedContent = await fs.readFile(join(testDir, path));
      expect(storedContent.equals(newContent)).toBe(true);
    });

    it('should handle path traversal prevention', async () => {
      // Arrange
      const fileContent = Buffer.from('malicious content');
      const maliciousPath = '../../../etc/passwd';

      // Act & Assert
      await expect(
        adapter.upload(fileContent, maliciousPath)
      ).rejects.toThrow();
    });
  });

  describe('download', () => {
    it('should download an existing file', async () => {
      // Arrange
      const fileContent = Buffer.from('download test content');
      const path = 'community-1/stories/123/download.txt';
      await adapter.upload(fileContent, path);

      // Act
      const downloaded = await adapter.download(path);

      // Assert
      expect(downloaded.equals(fileContent)).toBe(true);
    });

    it('should throw StorageNotFoundError for non-existent file', async () => {
      // Arrange
      const path = 'community-1/stories/123/nonexistent.txt';

      // Act & Assert
      await expect(adapter.download(path)).rejects.toThrow(
        StorageNotFoundError
      );
    });

    it('should handle path traversal in download', async () => {
      // Arrange
      const maliciousPath = '../../../etc/passwd';

      // Act & Assert
      await expect(adapter.download(maliciousPath)).rejects.toThrow();
    });
  });

  describe('delete', () => {
    it('should delete an existing file', async () => {
      // Arrange
      const fileContent = Buffer.from('file to delete');
      const path = 'community-1/stories/123/delete-me.txt';
      await adapter.upload(fileContent, path);

      // Verify file exists
      expect(await adapter.exists(path)).toBe(true);

      // Act
      await adapter.delete(path);

      // Assert
      expect(await adapter.exists(path)).toBe(false);
    });

    it('should throw StorageNotFoundError when deleting non-existent file', async () => {
      // Arrange
      const path = 'community-1/stories/123/nonexistent.txt';

      // Act & Assert
      await expect(adapter.delete(path)).rejects.toThrow(StorageNotFoundError);
    });
  });

  describe('exists', () => {
    it('should return true for existing file', async () => {
      // Arrange
      const fileContent = Buffer.from('existing file');
      const path = 'community-1/stories/123/exists.txt';
      await adapter.upload(fileContent, path);

      // Act & Assert
      expect(await adapter.exists(path)).toBe(true);
    });

    it('should return false for non-existent file', async () => {
      // Arrange
      const path = 'community-1/stories/123/nonexistent.txt';

      // Act & Assert
      expect(await adapter.exists(path)).toBe(false);
    });
  });

  describe('getMetadata', () => {
    it('should return metadata for existing file', async () => {
      // Arrange
      const fileContent = Buffer.from('metadata test content');
      const path = 'community-1/stories/123/metadata.txt';
      const uploadResult = await adapter.upload(fileContent, path, {
        contentType: 'text/plain',
      });

      // Act
      const metadata = await adapter.getMetadata(path);

      // Assert
      expect(metadata.size).toBe(fileContent.length);
      expect(metadata.lastModified).toBeInstanceOf(Date);
      expect(metadata.etag).toBe(uploadResult.etag);
      expect(metadata.contentType).toBe('text/plain');
    });

    it('should throw StorageNotFoundError for non-existent file', async () => {
      // Arrange
      const path = 'community-1/stories/123/nonexistent.txt';

      // Act & Assert
      await expect(adapter.getMetadata(path)).rejects.toThrow(
        StorageNotFoundError
      );
    });
  });

  describe('list', () => {
    it('should list files in directory', async () => {
      // Arrange
      const files = [
        'community-1/stories/123/file1.txt',
        'community-1/stories/123/file2.jpg',
        'community-1/stories/456/file3.mp3',
      ];

      for (const file of files) {
        await adapter.upload(Buffer.from(`content of ${file}`), file);
      }

      // Act
      const listedFiles = await adapter.list('community-1/stories/123/');

      // Assert
      expect(listedFiles).toHaveLength(2);
      expect(listedFiles).toContain('community-1/stories/123/file1.txt');
      expect(listedFiles).toContain('community-1/stories/123/file2.jpg');
      expect(listedFiles).not.toContain('community-1/stories/456/file3.mp3');
    });

    it('should return empty array for non-existent directory', async () => {
      // Act
      const listedFiles = await adapter.list('nonexistent/directory/');

      // Assert
      expect(listedFiles).toEqual([]);
    });
  });

  describe('error handling', () => {
    it('should handle permission errors gracefully', async () => {
      // Note: This test may not work in all environments
      // Skip if running in environments without proper permission controls
      if (process.platform === 'win32') {
        // Skip on Windows as permission handling is different
        return;
      }

      // Arrange
      const restrictedDir = join(testDir, 'restricted');
      await fs.mkdir(restrictedDir);
      await fs.chmod(restrictedDir, 0o000); // No permissions

      const path = 'restricted/no-access.txt';
      const fileContent = Buffer.from('should fail');

      try {
        // Act & Assert
        await expect(adapter.upload(fileContent, path)).rejects.toThrow();
      } finally {
        // Cleanup: restore permissions for deletion
        await fs.chmod(restrictedDir, 0o755);
      }
    });
  });

  describe('path safety', () => {
    it('should normalize paths correctly', async () => {
      // Arrange
      const fileContent = Buffer.from('normalized path test');
      const path = 'community-1//stories///123/./file.txt';

      // Act
      const result = await adapter.upload(fileContent, path);

      // Assert
      expect(result.path).toBe('community-1/stories/123/file.txt');
    });

    it('should prevent directory traversal with relative paths', async () => {
      // Arrange
      const fileContent = Buffer.from('traversal test');
      const maliciousPaths = [
        '../../../sensitive-file.txt',
        'community-1/../../../etc/passwd',
        'community-1/stories/../../../home/user/.ssh/id_rsa',
      ];

      // Act & Assert
      for (const path of maliciousPaths) {
        await expect(adapter.upload(fileContent, path)).rejects.toThrow();
      }
    });
  });
});
