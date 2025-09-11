/**
 * Local Storage Adapter Tests
 *
 * Tests the local filesystem storage adapter implementation.
 * Uses the interface compliance test suite plus adapter-specific tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { testStorageAdapterCompliance } from './storage-adapter.interface.test.js';
import { LocalStorageAdapter } from '../../../src/services/storage/local-storage.adapter.js';
import type { StorageAdapterConfig } from '../../../src/services/storage/storage-adapter.interface.js';

describe('LocalStorageAdapter', () => {
  let tempDir: string;
  let config: StorageAdapterConfig;
  let adapter: LocalStorageAdapter;

  beforeEach(async () => {
    tempDir = join(
      tmpdir(),
      `local-storage-test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    );
    await fs.mkdir(tempDir, { recursive: true });

    config = {
      baseDir: tempDir,
      maxFileSize: 10 * 1024 * 1024, // 10MB
      generateEtags: true,
    };

    adapter = new LocalStorageAdapter(config);
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  // Run the interface compliance tests
  testStorageAdapterCompliance(
    'Local',
    () => new LocalStorageAdapter(config),
    async () => {
      // Setup for compliance tests
      tempDir = join(
        tmpdir(),
        `compliance-test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
      );
      await fs.mkdir(tempDir, { recursive: true });
      config = {
        baseDir: tempDir,
        maxFileSize: 10 * 1024 * 1024,
        generateEtags: true,
      };
    },
    async () => {
      // Teardown for compliance tests
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  );

  describe('LocalStorageAdapter-specific functionality', () => {
    describe('constructor', () => {
      it('should create adapter with valid config', () => {
        const adapter = new LocalStorageAdapter(config);
        expect(adapter).toBeInstanceOf(LocalStorageAdapter);
      });

      it('should throw error with invalid base directory', () => {
        const invalidConfig = { ...config, baseDir: '' };
        expect(() => new LocalStorageAdapter(invalidConfig)).toThrow();
      });

      it('should throw error with negative max file size', () => {
        const invalidConfig = { ...config, maxFileSize: -1 };
        expect(() => new LocalStorageAdapter(invalidConfig)).toThrow();
      });
    });

    describe('file size limits', () => {
      it('should enforce max file size limits', async () => {
        const smallConfig = { ...config, maxFileSize: 100 }; // 100 bytes
        const restrictiveAdapter = new LocalStorageAdapter(smallConfig);

        const largeFile = Buffer.alloc(200, 'x'); // 200 bytes
        const testPath = 'uploads/community-1/stories/123/large.txt';

        await expect(
          restrictiveAdapter.upload(largeFile, testPath)
        ).rejects.toThrow();
      });

      it('should allow files at the size limit', async () => {
        const exactConfig = { ...config, maxFileSize: 100 }; // 100 bytes
        const exactAdapter = new LocalStorageAdapter(exactConfig);

        const exactFile = Buffer.alloc(100, 'x'); // Exactly 100 bytes
        const testPath = 'uploads/community-1/stories/123/exact.txt';

        await expect(exactAdapter.upload(exactFile, testPath)).resolves.toBe(
          testPath
        );
      });
    });

    describe('ETag generation', () => {
      it('should generate ETags when enabled', async () => {
        const etagConfig = { ...config, generateEtags: true };
        const etagAdapter = new LocalStorageAdapter(etagConfig);

        const testContent = Buffer.from('etag test content');
        const testPath = 'uploads/community-1/stories/123/etag.txt';

        await etagAdapter.upload(testContent, testPath);
        const metadata = await etagAdapter.getMetadata(testPath);

        expect(metadata.etag).toBeDefined();
        expect(typeof metadata.etag).toBe('string');
        expect(metadata.etag!.length).toBeGreaterThan(0);
      });

      it('should not generate ETags when disabled', async () => {
        const noEtagConfig = { ...config, generateEtags: false };
        const noEtagAdapter = new LocalStorageAdapter(noEtagConfig);

        const testContent = Buffer.from('no etag test');
        const testPath = 'uploads/community-1/stories/123/no-etag.txt';

        await noEtagAdapter.upload(testContent, testPath);
        const metadata = await noEtagAdapter.getMetadata(testPath);

        expect(metadata.etag).toBeUndefined();
      });

      it('should generate consistent ETags for same content', async () => {
        const testContent = Buffer.from('consistent etag test');
        const testPath1 = 'uploads/community-1/stories/123/etag1.txt';
        const testPath2 = 'uploads/community-1/stories/456/etag2.txt';

        await adapter.upload(testContent, testPath1);
        await adapter.upload(testContent, testPath2);

        const metadata1 = await adapter.getMetadata(testPath1);
        const metadata2 = await adapter.getMetadata(testPath2);

        expect(metadata1.etag).toBe(metadata2.etag);
      });

      it('should generate different ETags for different content', async () => {
        const testContent1 = Buffer.from('different content 1');
        const testContent2 = Buffer.from('different content 2');
        const testPath1 = 'uploads/community-1/stories/123/diff1.txt';
        const testPath2 = 'uploads/community-1/stories/123/diff2.txt';

        await adapter.upload(testContent1, testPath1);
        await adapter.upload(testContent2, testPath2);

        const metadata1 = await adapter.getMetadata(testPath1);
        const metadata2 = await adapter.getMetadata(testPath2);

        expect(metadata1.etag).not.toBe(metadata2.etag);
      });
    });

    describe('filesystem operations', () => {
      it('should create nested directory structure', async () => {
        const testFile = Buffer.from('nested test');
        const nestedPath =
          'uploads/community-1/stories/123/very/deeply/nested/file.txt';

        await adapter.upload(testFile, nestedPath);

        // Verify the full path exists on filesystem
        const fullPath = join(tempDir, nestedPath);
        const stats = await fs.stat(fullPath);
        expect(stats.isFile()).toBe(true);
      });

      it('should handle file permissions correctly', async () => {
        const testFile = Buffer.from('permissions test');
        const testPath = 'uploads/community-1/stories/123/permissions.txt';

        await adapter.upload(testFile, testPath);

        // Verify file is readable
        const fullPath = join(tempDir, testPath);
        const content = await fs.readFile(fullPath);
        expect(content).toEqual(testFile);
      });

      it('should handle special characters in filenames', async () => {
        const testFile = Buffer.from('special chars test');
        const specialPaths = [
          'uploads/community-1/stories/123/file with spaces.txt',
          'uploads/community-1/stories/123/file-with-dashes.txt',
          'uploads/community-1/stories/123/file_with_underscores.txt',
          'uploads/community-1/stories/123/file.with.dots.txt',
        ];

        for (const specialPath of specialPaths) {
          await adapter.upload(testFile, specialPath);
          expect(await adapter.exists(specialPath)).toBe(true);

          const downloaded = await adapter.download(specialPath);
          expect(downloaded).toEqual(testFile);
        }
      });
    });

    describe('error scenarios', () => {
      it('should handle disk full scenarios gracefully', async () => {
        // This test simulates disk full by setting a very small max file size
        const tinyConfig = { ...config, maxFileSize: 1 };
        const tinyAdapter = new LocalStorageAdapter(tinyConfig);

        const testFile = Buffer.from('too big');
        const testPath = 'uploads/community-1/stories/123/too-big.txt';

        await expect(tinyAdapter.upload(testFile, testPath)).rejects.toThrow();
      });

      it('should handle corrupted directory structure', async () => {
        // Upload a file first
        const testFile = Buffer.from('test file');
        const testPath = 'uploads/community-1/stories/123/test.txt';
        await adapter.upload(testFile, testPath);

        // Manually corrupt the directory by replacing it with a file
        const dirPath = join(tempDir, 'uploads/community-1/stories');
        await fs.rm(dirPath, { recursive: true, force: true });
        await fs.writeFile(dirPath, 'not a directory');

        // Attempting to upload should handle the error gracefully
        const newTestPath = 'uploads/community-1/stories/456/new-test.txt';
        await expect(adapter.upload(testFile, newTestPath)).rejects.toThrow();
      });
    });

    describe('performance characteristics', () => {
      it('should handle multiple concurrent uploads', async () => {
        const testFile = Buffer.from('concurrent upload test');
        const concurrentUploads = 20;

        const uploadPromises = Array.from(
          { length: concurrentUploads },
          (_, i) =>
            adapter.upload(
              testFile,
              `uploads/community-1/stories/123/concurrent-${i}.txt`
            )
        );

        const results = await Promise.all(uploadPromises);

        // All uploads should succeed
        expect(results).toHaveLength(concurrentUploads);
        results.forEach((result, i) => {
          expect(result).toBe(
            `uploads/community-1/stories/123/concurrent-${i}.txt`
          );
        });

        // All files should exist
        const existsPromises = results.map((path) => adapter.exists(path));
        const existsResults = await Promise.all(existsPromises);
        existsResults.forEach((exists) => expect(exists).toBe(true));
      });

      it('should handle large files efficiently', async () => {
        // Create a 1MB file
        const largeFile = Buffer.alloc(1024 * 1024, 'L');
        const testPath = 'uploads/community-1/stories/123/large-file.bin';

        const startTime = Date.now();
        await adapter.upload(largeFile, testPath);
        const uploadTime = Date.now() - startTime;

        // Upload should complete within reasonable time (5 seconds)
        expect(uploadTime).toBeLessThan(5000);

        // File should exist and be correct size
        const metadata = await adapter.getMetadata(testPath);
        expect(metadata.size).toBe(largeFile.length);
      });
    });
  });
});
