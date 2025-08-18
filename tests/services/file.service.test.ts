/**
 * File Service Tests
 *
 * Comprehensive unit tests for file upload service including:
 * - File upload with validation and community scoping
 * - Security measures (type validation, path sanitization)
 * - Data sovereignty enforcement
 * - Metadata extraction and streaming
 * - Error handling and edge cases
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  vi,
  beforeAll,
  afterAll,
} from 'vitest';
import { randomUUID } from 'crypto';
import { mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { FileService } from '../../src/services/file.service.js';
import { FileRepository } from '../../src/repositories/file.repository.js';

// Mock multipart file interface
interface MockMultipartFile {
  filename: string;
  mimetype: string;
  encoding: string;
  file: AsyncIterable<Buffer>;
  fieldname: string;
}

// Mock database and dependencies
const mockFileRepository = {
  create: vi.fn(),
  findById: vi.fn(),
  findByCommunity: vi.fn(),
  delete: vi.fn(),
  updateCulturalRestrictions: vi.fn(),
  existsByPath: vi.fn(),
} as unknown as FileRepository;

describe('FileService', () => {
  let fileService: FileService;
  let testUploadDir: string;

  beforeAll(async () => {
    // Create temporary upload directory for tests
    testUploadDir = join(process.cwd(), 'test-uploads');
    await mkdir(testUploadDir, { recursive: true });
  });

  afterAll(async () => {
    // Clean up test upload directory
    await rm(testUploadDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.clearAllMocks();

    // Setup default mock responses
    mockFileRepository.existsByPath.mockResolvedValue(false);
    fileService = new FileService(
      testUploadDir,
      {
        maxFileSizes: {
          image: 10 * 1024 * 1024, // 10MB
          audio: 50 * 1024 * 1024, // 50MB
          video: 100 * 1024 * 1024, // 100MB
        },
        allowedImageTypes: ['image/jpeg', 'image/png', 'image/webp'],
        allowedAudioTypes: ['audio/mpeg', 'audio/wav', 'audio/ogg'],
        allowedVideoTypes: ['video/mp4', 'video/webm'],
        enableMetadataExtraction: true,
        streamingThreshold: 5 * 1024 * 1024, // 5MB
        enableAuditLogging: true,
        uploadDir: testUploadDir,
      },
      mockFileRepository
    );
  });

  describe('uploadFile', () => {
    it('should upload valid image file with community scoping', async () => {
      // Create mock JPEG file data
      const jpegHeader = Buffer.from([0xff, 0xd8, 0xff, 0xe0]); // JPEG magic number
      const mockFile: MockMultipartFile = {
        filename: 'test-image.jpg',
        mimetype: 'image/jpeg',
        encoding: '7bit',
        fieldname: 'file',
        file: (async function* () {
          yield jpegHeader;
          yield Buffer.from('fake jpeg data');
        })(),
      };

      const options = {
        communityId: 1,
        uploadedBy: 123,
        maxSize: 10 * 1024 * 1024,
        allowedTypes: ['image/jpeg'],
      };

      mockFileRepository.create = vi.fn().mockResolvedValue({
        id: randomUUID(),
        filename: 'test-image.jpg',
        originalName: 'test-image.jpg',
        path: '/community-1/images/test-image.jpg',
        size: jpegHeader.length + 15,
        mimeType: 'image/jpeg',
        communityId: 1,
        uploadedBy: 123,
        metadata: { width: 100, height: 100 },
        createdAt: new Date(),
      });

      const result = await fileService.uploadFile(mockFile, options);

      expect(result).toBeDefined();
      expect(result.communityId).toBe(1);
      expect(result.uploadedBy).toBe(123);
      expect(result.mimeType).toBe('image/jpeg');
      expect(result.originalName).toBe('test-image.jpg');
      expect(mockFileRepository.create).toHaveBeenCalledOnce();
    });

    it('should reject files exceeding size limit', async () => {
      const largeFile: MockMultipartFile = {
        filename: 'large-image.jpg',
        mimetype: 'image/jpeg',
        encoding: '7bit',
        fieldname: 'file',
        file: (async function* () {
          // Simulate file larger than 10MB
          yield Buffer.alloc(11 * 1024 * 1024);
        })(),
      };

      const options = {
        communityId: 1,
        uploadedBy: 123,
        maxSize: 10 * 1024 * 1024,
        allowedTypes: ['image/jpeg'],
      };

      await expect(fileService.uploadFile(largeFile, options)).rejects.toThrow(
        'File size exceeds maximum allowed'
      );
    });

    it('should reject invalid file types', async () => {
      const textFile: MockMultipartFile = {
        filename: 'malicious.exe',
        mimetype: 'application/octet-stream',
        encoding: '7bit',
        fieldname: 'file',
        file: (async function* () {
          yield Buffer.from('MZ'); // PE executable header
        })(),
      };

      const options = {
        communityId: 1,
        uploadedBy: 123,
        allowedTypes: ['image/jpeg'],
      };

      await expect(fileService.uploadFile(textFile, options)).rejects.toThrow(
        'File type not allowed'
      );
    });

    it('should generate unique UUID filenames', async () => {
      const mockFile: MockMultipartFile = {
        filename: 'test.jpg',
        mimetype: 'image/jpeg',
        encoding: '7bit',
        fieldname: 'file',
        file: (async function* () {
          yield Buffer.from([0xff, 0xd8, 0xff, 0xe0]); // JPEG header
          yield Buffer.from('test data');
        })(),
      };

      const options = {
        communityId: 1,
        uploadedBy: 123,
        generateUniqueName: true,
      };

      mockFileRepository.create = vi.fn().mockResolvedValue({
        id: randomUUID(),
        filename: 'unique-uuid-name.jpg',
        originalName: 'test.jpg',
        path: '/community-1/images/unique-uuid-name.jpg',
        size: 100,
        mimeType: 'image/jpeg',
        communityId: 1,
        uploadedBy: 123,
        createdAt: new Date(),
      });

      const result = await fileService.uploadFile(mockFile, options);

      expect(result.filename).not.toBe('test.jpg');
      expect(result.filename).toMatch(/\.jpg$/);
      expect(result.originalName).toBe('test.jpg');
    });

    it('should extract image metadata (dimensions)', async () => {
      const mockFile: MockMultipartFile = {
        filename: 'test.jpg',
        mimetype: 'image/jpeg',
        encoding: '7bit',
        fieldname: 'file',
        file: (async function* () {
          yield Buffer.from([0xff, 0xd8, 0xff, 0xe0]); // JPEG header
        })(),
      };

      const options = {
        communityId: 1,
        uploadedBy: 123,
      };

      mockFileRepository.create = vi.fn().mockResolvedValue({
        id: randomUUID(),
        filename: 'test.jpg',
        originalName: 'test.jpg',
        path: '/community-1/images/test.jpg',
        size: 100,
        mimeType: 'image/jpeg',
        communityId: 1,
        uploadedBy: 123,
        metadata: { width: 800, height: 600 },
        createdAt: new Date(),
      });

      const result = await fileService.uploadFile(mockFile, options);

      expect(result.metadata).toBeDefined();
      expect(result.metadata?.width).toBe(800);
      expect(result.metadata?.height).toBe(600);
    });

    it('should enforce community data isolation', async () => {
      const mockFile: MockMultipartFile = {
        filename: 'test.jpg',
        mimetype: 'image/jpeg',
        encoding: '7bit',
        fieldname: 'file',
        file: (async function* () {
          yield Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
        })(),
      };

      const options = {
        communityId: 1,
        uploadedBy: 123,
      };

      mockFileRepository.create = vi.fn().mockImplementation((data) => {
        expect(data.communityId).toBe(1);
        expect(data.uploadedBy).toBe(123);
        return Promise.resolve({
          ...data,
          id: randomUUID(),
          createdAt: new Date(),
        });
      });

      await fileService.uploadFile(mockFile, options);

      expect(mockFileRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          communityId: 1,
          uploadedBy: 123,
        })
      );
    });
  });

  describe('getFile', () => {
    it('should allow access to files within same community', async () => {
      const fileId = randomUUID();
      const userId = 123;

      mockFileRepository.findById = vi.fn().mockResolvedValue({
        id: fileId,
        filename: 'test.jpg',
        originalName: 'test.jpg',
        path: '/community-1/images/test.jpg',
        size: 100,
        mimeType: 'image/jpeg',
        communityId: 1,
        uploadedBy: 123,
        createdAt: new Date(),
      });

      const result = await fileService.getFile(fileId, userId, 1); // same community

      expect(result).toBeDefined();
      expect(result.communityId).toBe(1);
      expect(mockFileRepository.findById).toHaveBeenCalledWith(fileId, 1);
    });

    it('should block access to files from different communities', async () => {
      const fileId = randomUUID();
      const userId = 123;

      mockFileRepository.findById = vi.fn().mockResolvedValue({
        id: fileId,
        filename: 'test.jpg',
        originalName: 'test.jpg',
        path: '/community-2/images/test.jpg',
        size: 100,
        mimeType: 'image/jpeg',
        communityId: 2, // Different community
        uploadedBy: 456,
        createdAt: new Date(),
      });

      await expect(fileService.getFile(fileId, userId, 1)) // user in community 1
        .rejects.toThrow('Access denied - community data isolation');
    });

    it('should respect cultural restrictions (elder-only)', async () => {
      const fileId = randomUUID();
      const userId = 123;

      mockFileRepository.findById = vi.fn().mockResolvedValue({
        id: fileId,
        filename: 'sacred-story.mp3',
        originalName: 'sacred-story.mp3',
        path: '/community-1/audio/sacred-story.mp3',
        size: 100,
        mimeType: 'audio/mpeg',
        communityId: 1,
        uploadedBy: 456,
        culturalRestrictions: { elderOnly: true },
        createdAt: new Date(),
      });

      // Non-elder user should be blocked
      await expect(
        fileService.getFile(fileId, userId, 1, 'editor')
      ).rejects.toThrow('Access denied - elder-only cultural content');

      // Elder user should have access
      const result = await fileService.getFile(fileId, userId, 1, 'elder');
      expect(result).toBeDefined();
    });
  });

  describe('deleteFile', () => {
    it('should safely delete file with authorization', async () => {
      const fileId = randomUUID();
      const userId = 123;

      mockFileRepository.findById = vi.fn().mockResolvedValue({
        id: fileId,
        filename: 'test.jpg',
        originalName: 'test.jpg',
        path: '/community-1/images/test.jpg',
        size: 100,
        mimeType: 'image/jpeg',
        communityId: 1,
        uploadedBy: 123, // Same user
        createdAt: new Date(),
      });

      mockFileRepository.delete = vi.fn().mockResolvedValue(true);

      await fileService.deleteFile(fileId, userId, 1);

      expect(mockFileRepository.delete).toHaveBeenCalledWith(fileId, 1);
    });

    it('should prevent unauthorized file deletion', async () => {
      const fileId = randomUUID();
      const userId = 123;

      mockFileRepository.findById = vi.fn().mockResolvedValue({
        id: fileId,
        filename: 'test.jpg',
        originalName: 'test.jpg',
        path: '/community-2/images/test.jpg',
        size: 100,
        mimeType: 'image/jpeg',
        communityId: 2, // Different community
        uploadedBy: 456,
        createdAt: new Date(),
      });

      await expect(fileService.deleteFile(fileId, userId, 1)).rejects.toThrow(
        'Access denied - community data isolation'
      );

      expect(mockFileRepository.delete).not.toHaveBeenCalled();
    });
  });

  describe('validateFile', () => {
    it('should validate file headers match MIME types', async () => {
      // JPEG file with correct header
      const jpegFile: MockMultipartFile = {
        filename: 'test.jpg',
        mimetype: 'image/jpeg',
        encoding: '7bit',
        fieldname: 'file',
        file: (async function* () {
          yield Buffer.from([0xff, 0xd8, 0xff, 0xe0]); // JPEG magic number
        })(),
      };

      const isValid = await fileService.validateFileType(jpegFile);
      expect(isValid).toBe(true);
    });

    it('should reject files with spoofed extensions', async () => {
      // Executable file with .jpg extension
      const maliciousFile: MockMultipartFile = {
        filename: 'malicious.jpg',
        mimetype: 'image/jpeg',
        encoding: '7bit',
        fieldname: 'file',
        file: (async function* () {
          yield Buffer.from([0x4d, 0x5a]); // PE executable header, not JPEG
        })(),
      };

      const isValid = await fileService.validateFileType(maliciousFile);
      expect(isValid).toBe(false);
    });

    it('should sanitize malicious filenames', () => {
      const maliciousNames = [
        '../../../etc/passwd',
        '..\\..\\windows\\system32\\config',
        'file<script>alert(1)</script>.jpg',
        'file with spaces and unicode 🔥.png',
      ];

      maliciousNames.forEach((name) => {
        const sanitized = fileService.sanitizeFilename(name);
        expect(sanitized).not.toContain('../');
        expect(sanitized).not.toContain('..\\');
        expect(sanitized).not.toContain('<');
        expect(sanitized).not.toContain('>');
      });
    });
  });

  describe('listFiles', () => {
    it('should list files with community scoping and pagination', async () => {
      const communityId = 1;
      const userId = 123;

      mockFileRepository.findByCommunity = vi.fn().mockResolvedValue({
        data: [
          {
            id: randomUUID(),
            filename: 'file1.jpg',
            originalName: 'file1.jpg',
            communityId: 1,
            uploadedBy: 123,
            createdAt: new Date(),
          },
          {
            id: randomUUID(),
            filename: 'file2.mp3',
            originalName: 'file2.mp3',
            communityId: 1,
            uploadedBy: 123,
            createdAt: new Date(),
          },
        ],
        meta: {
          page: 1,
          limit: 20,
          total: 2,
          totalPages: 1,
        },
      });

      const result = await fileService.listFiles(communityId, userId, {
        page: 1,
        limit: 20,
      });

      expect(result.data).toHaveLength(2);
      expect(result.meta.total).toBe(2);
      expect(mockFileRepository.findByCommunity).toHaveBeenCalledWith(
        communityId,
        expect.objectContaining({ page: 1, limit: 20 })
      );
    });
  });
});
