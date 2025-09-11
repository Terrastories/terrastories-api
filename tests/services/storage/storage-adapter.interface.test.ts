/**
 * Storage Adapter Interface Tests
 *
 * Tests the storage adapter interface contract and behavior expectations.
 * These tests define the expected behavior that all storage adapter implementations must follow.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type {
  StorageAdapter,
  StorageFileMetadata,
} from '../../../src/services/storage/storage-adapter.interface.js';

/**
 * Storage adapter interface compliance test suite
 *
 * This suite can be used to test any implementation of StorageAdapter
 * to ensure it follows the expected contract.
 */
export function testStorageAdapterCompliance(
  name: string,
  createAdapter: () => StorageAdapter,
  setup?: () => Promise<void>,
  teardown?: () => Promise<void>
) {
  describe(`${name} StorageAdapter`, () => {
    let adapter: StorageAdapter;
    let testDir: string;

    beforeEach(async () => {
      if (setup) await setup();
      adapter = createAdapter();
      testDir = join(
        tmpdir(),
        `storage-test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
      );
      await fs.mkdir(testDir, { recursive: true });
    });

    afterEach(async () => {
      try {
        await fs.rm(testDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
      if (teardown) await teardown();
    });

    describe('upload()', () => {
      it('should upload a file and return the path', async () => {
        const testFile = Buffer.from('test file content');
        const testPath = 'uploads/community-1/stories/123/test.txt';

        const result = await adapter.upload(testFile, testPath);

        expect(result).toBe(testPath);
        expect(await adapter.exists(testPath)).toBe(true);
      });

      it('should handle binary file content', async () => {
        const binaryData = Buffer.from([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        ]); // PNG header
        const testPath = 'uploads/community-1/places/456/image.png';

        const result = await adapter.upload(binaryData, testPath);

        expect(result).toBe(testPath);

        const downloaded = await adapter.download(testPath);
        expect(downloaded).toEqual(binaryData);
      });

      it('should create directories automatically', async () => {
        const testFile = Buffer.from('nested file');
        const testPath =
          'uploads/community-2/speakers/789/nested/deep/file.txt';

        await adapter.upload(testFile, testPath);

        expect(await adapter.exists(testPath)).toBe(true);
      });

      it('should overwrite existing files', async () => {
        const testPath = 'uploads/community-1/stories/123/overwrite.txt';
        const originalContent = Buffer.from('original content');
        const newContent = Buffer.from('new content');

        await adapter.upload(originalContent, testPath);
        await adapter.upload(newContent, testPath);

        const downloaded = await adapter.download(testPath);
        expect(downloaded.toString()).toBe('new content');
      });

      it('should handle empty files', async () => {
        const emptyFile = Buffer.alloc(0);
        const testPath = 'uploads/community-1/stories/123/empty.txt';

        await adapter.upload(emptyFile, testPath);

        expect(await adapter.exists(testPath)).toBe(true);
        const downloaded = await adapter.download(testPath);
        expect(downloaded.length).toBe(0);
      });

      it('should reject invalid paths', async () => {
        const testFile = Buffer.from('test');

        // Test various invalid paths
        await expect(adapter.upload(testFile, '')).rejects.toThrow();
        await expect(
          adapter.upload(testFile, '../../etc/passwd')
        ).rejects.toThrow();
        await expect(
          adapter.upload(testFile, '/absolute/path')
        ).rejects.toThrow();
      });
    });

    describe('download()', () => {
      it('should download an uploaded file', async () => {
        const testContent = Buffer.from('download test content');
        const testPath = 'uploads/community-1/stories/123/download.txt';

        await adapter.upload(testContent, testPath);
        const downloaded = await adapter.download(testPath);

        expect(downloaded).toEqual(testContent);
      });

      it('should throw error for non-existent files', async () => {
        const nonExistentPath =
          'uploads/community-1/stories/999/nonexistent.txt';

        await expect(adapter.download(nonExistentPath)).rejects.toThrow();
      });

      it('should handle large files', async () => {
        // Create a 1MB test file
        const largeContent = Buffer.alloc(1024 * 1024, 'x');
        const testPath = 'uploads/community-1/stories/123/large.txt';

        await adapter.upload(largeContent, testPath);
        const downloaded = await adapter.download(testPath);

        expect(downloaded.length).toBe(largeContent.length);
        expect(downloaded.toString('utf8', 0, 10)).toBe('xxxxxxxxxx');
      });
    });

    describe('delete()', () => {
      it('should delete an existing file', async () => {
        const testFile = Buffer.from('to be deleted');
        const testPath = 'uploads/community-1/stories/123/delete.txt';

        await adapter.upload(testFile, testPath);
        expect(await adapter.exists(testPath)).toBe(true);

        await adapter.delete(testPath);
        expect(await adapter.exists(testPath)).toBe(false);
      });

      it('should throw error when deleting non-existent files', async () => {
        const nonExistentPath =
          'uploads/community-1/stories/999/nonexistent.txt';

        await expect(adapter.delete(nonExistentPath)).rejects.toThrow();
      });

      it('should not affect other files in same directory', async () => {
        const testPath1 = 'uploads/community-1/stories/123/file1.txt';
        const testPath2 = 'uploads/community-1/stories/123/file2.txt';

        await adapter.upload(Buffer.from('file 1'), testPath1);
        await adapter.upload(Buffer.from('file 2'), testPath2);

        await adapter.delete(testPath1);

        expect(await adapter.exists(testPath1)).toBe(false);
        expect(await adapter.exists(testPath2)).toBe(true);
      });
    });

    describe('exists()', () => {
      it('should return true for existing files', async () => {
        const testFile = Buffer.from('exists test');
        const testPath = 'uploads/community-1/stories/123/exists.txt';

        await adapter.upload(testFile, testPath);

        expect(await adapter.exists(testPath)).toBe(true);
      });

      it('should return false for non-existent files', async () => {
        const nonExistentPath =
          'uploads/community-1/stories/999/nonexistent.txt';

        expect(await adapter.exists(nonExistentPath)).toBe(false);
      });

      it('should return false after file deletion', async () => {
        const testFile = Buffer.from('temporary file');
        const testPath = 'uploads/community-1/stories/123/temporary.txt';

        await adapter.upload(testFile, testPath);
        expect(await adapter.exists(testPath)).toBe(true);

        await adapter.delete(testPath);
        expect(await adapter.exists(testPath)).toBe(false);
      });
    });

    describe('getMetadata()', () => {
      it('should return metadata for existing files', async () => {
        const testContent = Buffer.from('metadata test content');
        const testPath = 'uploads/community-1/stories/123/metadata.txt';

        await adapter.upload(testContent, testPath);
        const metadata = await adapter.getMetadata(testPath);

        expect(metadata).toMatchObject({
          size: testContent.length,
          lastModified: expect.any(Date),
        });

        // lastModified should be recent (within last minute)
        const now = new Date();
        const timeDiff = now.getTime() - metadata.lastModified.getTime();
        expect(timeDiff).toBeLessThan(60000); // Less than 1 minute
      });

      it('should throw error for non-existent files', async () => {
        const nonExistentPath =
          'uploads/community-1/stories/999/nonexistent.txt';

        await expect(adapter.getMetadata(nonExistentPath)).rejects.toThrow();
      });

      it('should handle empty files', async () => {
        const emptyFile = Buffer.alloc(0);
        const testPath = 'uploads/community-1/stories/123/empty-metadata.txt';

        await adapter.upload(emptyFile, testPath);
        const metadata = await adapter.getMetadata(testPath);

        expect(metadata.size).toBe(0);
      });

      it('should include ETag if supported', async () => {
        const testContent = Buffer.from('etag test content');
        const testPath = 'uploads/community-1/stories/123/etag.txt';

        await adapter.upload(testContent, testPath);
        const metadata = await adapter.getMetadata(testPath);

        // ETag is optional but if present should be a non-empty string
        if (metadata.etag) {
          expect(typeof metadata.etag).toBe('string');
          expect(metadata.etag.length).toBeGreaterThan(0);
        }
      });
    });

    describe('path security', () => {
      it('should prevent directory traversal attacks', async () => {
        const testFile = Buffer.from('malicious content');

        const maliciousPaths = [
          '../../../etc/passwd',
          '..\\..\\..\\windows\\system32\\hosts',
          'uploads/../../sensitive-file.txt',
          'uploads/../outside-uploads.txt',
        ];

        for (const maliciousPath of maliciousPaths) {
          await expect(
            adapter.upload(testFile, maliciousPath)
          ).rejects.toThrow();
        }
      });

      it('should reject absolute paths', async () => {
        const testFile = Buffer.from('test content');

        const absolutePaths = [
          '/etc/passwd',
          'C:\\Windows\\System32\\hosts',
          '/home/user/file.txt',
        ];

        for (const absolutePath of absolutePaths) {
          await expect(
            adapter.upload(testFile, absolutePath)
          ).rejects.toThrow();
        }
      });

      it('should allow valid relative paths within uploads', async () => {
        const testFile = Buffer.from('valid content');

        const validPaths = [
          'uploads/community-1/stories/123/file.txt',
          'uploads/community-2/places/456/image.jpg',
          'uploads/community-3/speakers/789/audio.mp3',
          'uploads/community-1/stories/123/nested/deep/file.txt',
        ];

        for (const validPath of validPaths) {
          await expect(adapter.upload(testFile, validPath)).resolves.toBe(
            validPath
          );
          expect(await adapter.exists(validPath)).toBe(true);
        }
      });
    });

    describe('error handling', () => {
      it('should provide meaningful error messages', async () => {
        const nonExistentPath =
          'uploads/community-1/stories/999/nonexistent.txt';

        try {
          await adapter.download(nonExistentPath);
          expect.fail('Should have thrown an error');
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
          expect((error as Error).message).toBeTruthy();
          expect((error as Error).message.length).toBeGreaterThan(0);
        }
      });

      it('should handle concurrent operations gracefully', async () => {
        const testFile = Buffer.from('concurrent test');
        const testPaths = Array.from(
          { length: 10 },
          (_, i) => `uploads/community-1/stories/123/concurrent-${i}.txt`
        );

        // Upload all files concurrently
        const uploadPromises = testPaths.map((path) =>
          adapter.upload(testFile, path)
        );
        await Promise.all(uploadPromises);

        // Verify all files exist
        const existsPromises = testPaths.map((path) => adapter.exists(path));
        const results = await Promise.all(existsPromises);

        results.forEach((exists) => expect(exists).toBe(true));
      });
    });
  });
}
