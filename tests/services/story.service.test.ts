/**
 * Story Service Test Suite
 *
 * Comprehensive test coverage for StoryService including:
 * - CRUD operations with cultural protocols
 * - Data sovereignty enforcement
 * - Media file integration and validation
 * - Story-Places and Story-Speakers associations
 * - Search and filtering capabilities
 * - Performance and edge case testing
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StoryService } from '../../src/services/story.service.js';
import type {
  StoryCreateInput,
  StoryWithRelations,
  PaginatedResult,
  StoryFilters,
  PaginationOptions,
} from '../../src/services/story.service.js';

// Mock dependencies
const mockStoryRepository = {
  create: vi.fn(),
  findById: vi.fn(),
  findBySlug: vi.fn(),
  findByIdWithRelations: vi.fn(),
  findBySlugWithRelations: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  findMany: vi.fn(),
  generateUniqueSlug: vi.fn(),
  createAssociations: vi.fn(),
  updateAssociations: vi.fn(),
  deleteAssociations: vi.fn(),
  validatePlacesInCommunity: vi.fn(),
  validateSpeakersInCommunity: vi.fn(),
} as any;

const mockFileRepository = {
  findById: vi.fn(),
  findByPath: vi.fn(),
  findByIds: vi.fn(),
  validateFileAccess: vi.fn(),
  findOrphanedFiles: vi.fn(),
} as any;

const mockUserRepository = {
  findById: vi.fn(),
} as any;

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as any;

// Create mock test data
function createMockTestData() {
  return {
    community: {
      id: 1,
      name: 'Test Indigenous Community',
      description: 'Test community for stories',
      slug: 'test-indigenous-community',
      locale: 'en',
    },
    users: {
      admin: {
        id: 1,
        role: 'admin',
        communityId: 1,
        firstName: 'Admin',
        lastName: 'User',
      },
      editor: {
        id: 2,
        role: 'editor',
        communityId: 1,
        firstName: 'Editor',
        lastName: 'User',
      },
      elder: {
        id: 3,
        role: 'elder',
        communityId: 1,
        firstName: 'Elder',
        lastName: 'User',
      },
      viewer: {
        id: 4,
        role: 'viewer',
        communityId: 1,
        firstName: 'Viewer',
        lastName: 'User',
      },
      superAdmin: {
        id: 5,
        role: 'super_admin',
        communityId: null,
        firstName: 'Super',
        lastName: 'Admin',
      },
      otherCommunityUser: {
        id: 6,
        role: 'editor',
        communityId: 2,
        firstName: 'Other',
        lastName: 'User',
      },
    },
    places: [
      {
        id: 1,
        name: 'Sacred Mountain',
        latitude: 49.3,
        longitude: -123.1,
        communityId: 1,
      },
      {
        id: 2,
        name: 'River Crossing',
        latitude: 49.4,
        longitude: -123.2,
        communityId: 1,
      },
    ],
    speakers: [
      {
        id: 1,
        name: 'Elder Maria Stonebear',
        elderStatus: true,
        communityId: 1,
      },
      {
        id: 2,
        name: 'John Rivercrossing',
        elderStatus: false,
        communityId: 1,
      },
    ],
    files: [
      {
        id: 'file1',
        path: '/uploads/story-image.jpg',
        communityId: 1,
      },
      {
        id: 'file2',
        path: '/uploads/story-audio.mp3',
        communityId: 1,
      },
    ],
  };
}

describe('StoryService', () => {
  let storyService: StoryService;
  let testData: ReturnType<typeof createMockTestData>;

  beforeEach(() => {
    // Reset all mocks
    vi.clearAllMocks();

    // Initialize service with mocked dependencies
    storyService = new StoryService(
      mockStoryRepository,
      mockFileRepository,
      mockUserRepository,
      mockLogger
    );

    // Create test data
    testData = createMockTestData();
  });

  describe('createStory', () => {
    it('should create story with media, places, and speakers', async () => {
      // Arrange
      const storyInput: StoryCreateInput = {
        title: 'The Legend of Sacred Mountain',
        description: 'A traditional story passed down through generations...',
        communityId: testData.community.id,
        createdBy: testData.users.elder.id,
        mediaUrls: [testData.files[0].path, testData.files[1].path],
        placeIds: [testData.places[0].id],
        speakerIds: [testData.speakers[0].id],
        culturalProtocols: {
          permissionLevel: 'elder_only',
          culturalSignificance: 'Creation story with sacred elements',
          ceremonialContent: true,
        },
        language: 'en',
        tags: ['creation', 'sacred', 'mountain'],
      };

      const expectedStory: StoryWithRelations = {
        id: 1,
        title: storyInput.title!,
        description: storyInput.description,
        slug: 'the-legend-of-sacred-mountain',
        communityId: storyInput.communityId,
        createdBy: storyInput.createdBy,
        mediaUrls: storyInput.mediaUrls!,
        language: storyInput.language!,
        tags: storyInput.tags!,
        culturalProtocols: storyInput.culturalProtocols,
        isRestricted: true, // Should be auto-set for elder_only content
        createdAt: new Date(),
        updatedAt: new Date(),
        places: [
          {
            ...testData.places[0],
            culturalContext: undefined,
            storyRelationship: undefined,
          },
        ],
        speakers: [
          {
            ...testData.speakers[0],
            culturalRole: 'narrator',
            storyRole: 'narrator',
          },
        ],
        community: testData.community,
        author: testData.users.elder,
      };

      // Mock repository methods
      mockStoryRepository.generateUniqueSlug.mockResolvedValue('the-legend-of-sacred-mountain');
      mockFileRepository.validateFileAccess.mockResolvedValue({ valid: true });
      mockStoryRepository.validatePlacesInCommunity.mockResolvedValue(true);
      mockStoryRepository.validateSpeakersInCommunity.mockResolvedValue(true);
      mockStoryRepository.create.mockResolvedValue(expectedStory);

      // Act
      const result = await storyService.createStory(
        storyInput,
        testData.users.elder.id,
        testData.users.elder.role,
        testData.community.id
      );

      // Assert
      expect(result).toEqual(expectedStory);
      expect(mockStoryRepository.generateUniqueSlug).toHaveBeenCalledWith(
        storyInput.title,
        storyInput.communityId
      );
      expect(mockFileRepository.validateFileAccess).toHaveBeenCalledWith(
        storyInput.mediaUrls,
        testData.users.elder.id,
        testData.community.id
      );
      expect(mockStoryRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          ...storyInput,
          slug: 'the-legend-of-sacred-mountain',
          isRestricted: true,
        })
      );
    });

    it('should reject creation with cross-community places', async () => {
      // Arrange
      const storyInput: StoryCreateInput = {
        title: 'Test Story',
        communityId: testData.community.id,
        createdBy: testData.users.admin.id,
        placeIds: [999], // Non-existent or cross-community place
      };

      mockStoryRepository.validatePlacesInCommunity.mockResolvedValue(false);

      // Act & Assert
      await expect(
        storyService.createStory(
          storyInput,
          testData.users.admin.id,
          testData.users.admin.role,
          testData.community.id
        )
      ).rejects.toThrow('Places must belong to the same community as the story');
    });

    it('should reject creation with invalid media files', async () => {
      // Arrange
      const storyInput: StoryCreateInput = {
        title: 'Test Story',
        communityId: testData.community.id,
        createdBy: testData.users.editor.id,
        mediaUrls: ['/uploads/invalid-file.jpg'],
      };

      mockFileRepository.validateFileAccess.mockResolvedValue({
        valid: false,
        reason: 'File not found or access denied',
      });

      // Act & Assert
      await expect(
        storyService.createStory(
          storyInput,
          testData.users.editor.id,
          testData.users.editor.role,
          testData.community.id
        )
      ).rejects.toThrow('File not found or access denied');
    });

    it('should auto-generate slug when not provided', async () => {
      // Arrange
      const storyInput: StoryCreateInput = {
        title: 'Another Amazing Story!',
        communityId: testData.community.id,
        createdBy: testData.users.editor.id,
      };

      mockStoryRepository.generateUniqueSlug.mockResolvedValue('another-amazing-story');
      mockStoryRepository.create.mockResolvedValue({
        ...storyInput,
        id: 1,
        slug: 'another-amazing-story',
      } as any);

      // Act
      await storyService.createStory(
        storyInput,
        testData.users.editor.id,
        testData.users.editor.role,
        testData.community.id
      );

      // Assert
      expect(mockStoryRepository.generateUniqueSlug).toHaveBeenCalledWith(
        'Another Amazing Story!',
        testData.community.id
      );
    });
  });

  describe('getStoryById - Data Sovereignty', () => {
    const createElderOnlyStory = (): StoryWithRelations => ({
      id: 1,
      title: 'Sacred Ceremony Story',
      description: 'A ceremony story for elders only',
      slug: 'sacred-ceremony-story',
      communityId: testData.community.id,
      createdBy: testData.users.elder.id,
      mediaUrls: [],
      language: 'en',
      tags: [],
      culturalProtocols: {
        permissionLevel: 'elder_only',
        ceremonialContent: true,
      },
      isRestricted: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      places: [],
      speakers: [],
      community: testData.community,
      author: testData.users.elder,
    });

    it('should block super admin from community stories', async () => {
      // Arrange
      const elderOnlyStory = createElderOnlyStory();
      mockStoryRepository.findByIdWithRelations.mockResolvedValue(elderOnlyStory);

      // Act
      const result = await storyService.getStoryById(
        elderOnlyStory.id,
        testData.users.superAdmin.id,
        testData.users.superAdmin.role,
        null // Super admin has no community
      );

      // Assert
      expect(result).toBeNull();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Data sovereignty protection'),
        expect.any(Object)
      );
    });

    it('should allow elder access to elder-only content', async () => {
      // Arrange
      const elderOnlyStory = createElderOnlyStory();
      mockStoryRepository.findByIdWithRelations.mockResolvedValue(elderOnlyStory);

      // Act
      const result = await storyService.getStoryById(
        elderOnlyStory.id,
        testData.users.elder.id,
        testData.users.elder.role,
        testData.community.id
      );

      // Assert
      expect(result).toEqual(elderOnlyStory);
    });

    it('should deny editor access to elder-only content', async () => {
      // Arrange
      const elderOnlyStory = createElderOnlyStory();
      mockStoryRepository.findByIdWithRelations.mockResolvedValue(elderOnlyStory);

      // Act
      const result = await storyService.getStoryById(
        elderOnlyStory.id,
        testData.users.editor.id,
        testData.users.editor.role,
        testData.community.id
      );

      // Assert
      expect(result).toBeNull();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Cultural protocol access denied'),
        expect.any(Object)
      );
    });

    it('should deny cross-community access', async () => {
      // Arrange
      const elderOnlyStory = createElderOnlyStory();
      mockStoryRepository.findByIdWithRelations.mockResolvedValue(elderOnlyStory);

      // Act
      const result = await storyService.getStoryById(
        elderOnlyStory.id,
        testData.users.otherCommunityUser.id,
        testData.users.otherCommunityUser.role,
        999 // Different community ID
      );

      // Assert
      expect(result).toBeNull();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Cross-community access denied'),
        expect.any(Object)
      );
    });
  });

  describe('getStoryBySlug', () => {
    it('should retrieve story by slug with community scoping', async () => {
      // Arrange
      const story: StoryWithRelations = {
        id: 1,
        title: 'Public Story',
        slug: 'public-story',
        communityId: testData.community.id,
        culturalProtocols: { permissionLevel: 'public' },
      } as any;

      mockStoryRepository.findBySlugWithRelations.mockResolvedValue(story);

      // Act
      const result = await storyService.getStoryBySlug(
        'public-story',
        testData.community.id,
        testData.users.viewer.id,
        testData.users.viewer.role
      );

      // Assert
      expect(result).toEqual(story);
      expect(mockStoryRepository.findBySlugWithRelations).toHaveBeenCalledWith(
        'public-story',
        testData.community.id
      );
    });

    it('should return null for non-existent slug', async () => {
      // Arrange
      mockStoryRepository.findBySlugWithRelations.mockResolvedValue(null);

      // Act
      const result = await storyService.getStoryBySlug(
        'non-existent-story',
        testData.community.id,
        testData.users.viewer.id,
        testData.users.viewer.role
      );

      // Assert
      expect(result).toBeNull();
    });
  });

  describe('updateStory - Association Management', () => {
    const createExistingStory = (): StoryWithRelations => ({
      id: 1,
      title: 'River Crossing Story',
      slug: 'river-crossing-story',
      communityId: testData.community.id,
      createdBy: testData.users.editor.id,
      mediaUrls: ['/uploads/old-image.jpg'],
      places: [testData.places[0]],
      speakers: [testData.speakers[0]],
      culturalProtocols: { permissionLevel: 'community' },
    } as any);

    it('should update place and speaker associations', async () => {
      // Arrange
      const existingStory = createExistingStory();
      const updates = {
        title: 'Updated River Story',
        placeIds: [testData.places[1].id], // Change to different place
        speakerIds: [testData.speakers[1].id], // Change to different speaker
      };

      const updatedStory = {
        ...existingStory,
        ...updates,
        places: [testData.places[1]],
        speakers: [testData.speakers[1]],
      };

      mockStoryRepository.findByIdWithRelations.mockResolvedValue(existingStory);
      mockStoryRepository.validatePlacesInCommunity.mockResolvedValue(true);
      mockStoryRepository.validateSpeakersInCommunity.mockResolvedValue(true);
      mockStoryRepository.update.mockResolvedValue(updatedStory);

      // Act
      const result = await storyService.updateStory(
        existingStory.id,
        updates,
        testData.users.editor.id,
        testData.users.editor.role
      );

      // Assert
      expect(result.places).toHaveLength(1);
      expect(result.places[0].id).toBe(testData.places[1].id);
      expect(result.speakers).toHaveLength(1);
      expect(result.speakers[0].id).toBe(testData.speakers[1].id);
    });

    it('should handle media file cleanup during updates', async () => {
      // Arrange
      const existingStory = createExistingStory();
      const updates = {
        mediaUrls: ['/uploads/new-image.jpg'],
      };

      mockStoryRepository.findByIdWithRelations.mockResolvedValue(existingStory);
      mockFileRepository.validateFileAccess.mockResolvedValue({ valid: true });
      mockStoryRepository.update.mockResolvedValue({
        ...existingStory,
        ...updates,
      });

      // Act
      await storyService.updateStory(
        existingStory.id,
        updates,
        testData.users.editor.id,
        testData.users.editor.role
      );

      // Assert
      expect(mockFileRepository.findOrphanedFiles).toHaveBeenCalled();
    });

    it('should reject updates by unauthorized users', async () => {
      // Arrange
      const existingStory = createExistingStory();
      mockStoryRepository.findByIdWithRelations.mockResolvedValue(existingStory);

      // Act & Assert
      await expect(
        storyService.updateStory(
          existingStory.id,
          { title: 'Unauthorized Update' },
          testData.users.viewer.id, // Viewer cannot edit
          testData.users.viewer.role
        )
      ).rejects.toThrow('Insufficient permissions to modify this story');
    });
  });

  describe('deleteStory', () => {
    const createStoryToDelete = (): StoryWithRelations => ({
      id: 1,
      title: 'Story to Delete',
      communityId: testData.community.id,
      createdBy: testData.users.editor.id,
      mediaUrls: ['/uploads/file-to-cleanup.jpg'],
    } as any);

    it('should delete story and clean up media files', async () => {
      // Arrange
      const storyToDelete = createStoryToDelete();
      mockStoryRepository.findByIdWithRelations.mockResolvedValue(storyToDelete);
      mockStoryRepository.delete.mockResolvedValue(true);

      // Act
      await storyService.deleteStory(
        storyToDelete.id,
        testData.users.admin.id, // Admin can delete any story
        testData.users.admin.role
      );

      // Assert
      expect(mockStoryRepository.delete).toHaveBeenCalledWith(storyToDelete.id);
      expect(mockFileRepository.findOrphanedFiles).toHaveBeenCalled();
    });

    it('should allow creators to delete their own stories', async () => {
      // Arrange
      const storyToDelete = createStoryToDelete();
      mockStoryRepository.findByIdWithRelations.mockResolvedValue(storyToDelete);
      mockStoryRepository.delete.mockResolvedValue(true);

      // Act
      await storyService.deleteStory(
        storyToDelete.id,
        testData.users.editor.id, // Creator can delete own story
        testData.users.editor.role
      );

      // Assert
      expect(mockStoryRepository.delete).toHaveBeenCalledWith(storyToDelete.id);
    });

    it('should reject deletion by unauthorized users', async () => {
      // Arrange
      const storyToDelete = createStoryToDelete();
      mockStoryRepository.findByIdWithRelations.mockResolvedValue(storyToDelete);

      // Act & Assert
      await expect(
        storyService.deleteStory(
          storyToDelete.id,
          testData.users.viewer.id, // Viewer cannot delete
          testData.users.viewer.role
        )
      ).rejects.toThrow('Insufficient permissions to delete this story');
    });
  });

  describe('listStories - Search & Filtering', () => {
    const testStories: StoryWithRelations[] = [
      {
        id: 1,
        title: 'Mountain Spirit Legend',
        description: 'Ancient spirits dwelling in the sacred peaks...',
        communityId: 1, // Same as testData.community.id
        tags: ['spirits', 'mountains', 'ancient'],
        culturalProtocols: { permissionLevel: 'public' },
      } as any,
      {
        id: 2,
        title: 'River Medicine Teachings',
        description: 'Traditional healing practices by the river...',
        communityId: 1, // Same as testData.community.id
        tags: ['healing', 'medicine', 'river'],
        culturalProtocols: { permissionLevel: 'elder_only' },
      } as any,
      {
        id: 3,
        title: 'Seasonal Hunting Story',
        description: 'Respectful hunting practices through the seasons...',
        communityId: 1, // Same as testData.community.id
        tags: ['hunting', 'seasons', 'respect'],
        culturalProtocols: { permissionLevel: 'community' },
      } as any,
    ];

    it('should search stories with text query', async () => {
      // Arrange
      const filters: StoryFilters = {
        search: 'mountain spirit',
      };
      const pagination: PaginationOptions = { page: 1, limit: 10 };

      const expectedResult: PaginatedResult<StoryWithRelations> = {
        data: [testStories[0]],
        total: 1,
        page: 1,
        limit: 10,
        totalPages: 1,
      };

      mockStoryRepository.findMany.mockResolvedValue(expectedResult);

      // Act
      const result = await storyService.listStories(
        filters,
        pagination,
        testData.users.admin.id,
        testData.users.admin.role,
        testData.community.id
      );

      // Assert
      expect(result).toEqual(expectedResult);
      expect(mockStoryRepository.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          search: 'mountain spirit',
          communityId: testData.community.id,
        }),
        pagination
      );
    });

    it('should filter results by cultural permissions', async () => {
      // Arrange
      const filters: StoryFilters = {};
      const pagination: PaginationOptions = { page: 1, limit: 10 };

      // Elder can see all stories
      const elderResult: PaginatedResult<StoryWithRelations> = {
        data: testStories,
        total: 3,
        page: 1,
        limit: 10,
        totalPages: 1,
      };

      // Editor cannot see elder-only content
      const editorResult: PaginatedResult<StoryWithRelations> = {
        data: [testStories[0], testStories[2]], // Excludes elder-only story
        total: 2,
        page: 1,
        limit: 10,
        totalPages: 1,
      };

      mockStoryRepository.findMany
        .mockResolvedValueOnce(elderResult)
        .mockResolvedValueOnce(editorResult);

      // Act - Elder access
      const elderResults = await storyService.listStories(
        filters,
        pagination,
        testData.users.elder.id,
        testData.users.elder.role,
        testData.community.id
      );

      // Act - Editor access
      const editorResults = await storyService.listStories(
        filters,
        pagination,
        testData.users.editor.id,
        testData.users.editor.role,
        testData.community.id
      );

      // Assert
      expect(elderResults.total).toBe(3);
      expect(editorResults.total).toBe(2);
    });

    it('should support geographic proximity filtering', async () => {
      // Arrange
      const filters: StoryFilters = {
        nearPoint: { type: 'Point', coordinates: [-123.11, 49.31] },
        radiusKm: 5,
      };
      const pagination: PaginationOptions = { page: 1, limit: 10 };

      const expectedResult: PaginatedResult<StoryWithRelations> = {
        data: [testStories[0]], // Stories within 5km
        total: 1,
        page: 1,
        limit: 10,
        totalPages: 1,
      };

      mockStoryRepository.findMany.mockResolvedValue(expectedResult);

      // Act
      const result = await storyService.listStories(
        filters,
        pagination,
        testData.users.admin.id,
        testData.users.admin.role,
        testData.community.id
      );

      // Assert
      expect(result).toEqual(expectedResult);
      expect(mockStoryRepository.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          nearPoint: filters.nearPoint,
          radiusKm: 5,
        }),
        pagination
      );
    });
  });

  describe('Performance Tests', () => {
    it('should handle large story collections efficiently', async () => {
      // Arrange
      const largeDataset = Array.from({ length: 1000 }, (_, i) => ({
        id: i + 1,
        title: `Story ${i + 1}`,
        communityId: testData.community.id, // Should be 1
        culturalProtocols: { permissionLevel: 'public' },
      })) as StoryWithRelations[];

      const expectedResult: PaginatedResult<StoryWithRelations> = {
        data: largeDataset.slice(0, 20),
        total: 1000,
        page: 1,
        limit: 20,
        totalPages: 50,
      };

      mockStoryRepository.findMany.mockResolvedValue(expectedResult);

      const startTime = Date.now();

      // Act
      const result = await storyService.listStories(
        {},
        { page: 1, limit: 20 },
        testData.users.admin.id,
        testData.users.admin.role,
        testData.community.id
      );

      const endTime = Date.now();
      const queryTime = endTime - startTime;

      // Assert
      expect(queryTime).toBeLessThan(100); // Should complete very quickly (mocked)
      expect(result.data).toHaveLength(20);
      expect(result.total).toBe(1000);
    });
  });

  describe('Edge Cases', () => {
    it('should handle missing story gracefully', async () => {
      // Arrange
      mockStoryRepository.findByIdWithRelations.mockResolvedValue(null);

      // Act
      const result = await storyService.getStoryById(
        999,
        testData.users.admin.id,
        testData.users.admin.role,
        testData.community.id
      );

      // Assert
      expect(result).toBeNull();
    });

    it('should handle empty search results', async () => {
      // Arrange
      const emptyResult: PaginatedResult<StoryWithRelations> = {
        data: [],
        total: 0,
        page: 1,
        limit: 10,
        totalPages: 0,
      };

      mockStoryRepository.findMany.mockResolvedValue(emptyResult);

      // Act
      const result = await storyService.listStories(
        { search: 'nonexistent' },
        { page: 1, limit: 10 },
        testData.users.admin.id,
        testData.users.admin.role,
        testData.community.id
      );

      // Assert
      expect(result.data).toHaveLength(0);
      expect(result.total).toBe(0);
    });
  });
});