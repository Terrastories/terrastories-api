/**
 * Story Repository Test Suite
 *
 * Comprehensive database-level testing for StoryRepository including:
 * - CRUD operations with transactions
 * - Association management (story_places, story_speakers)
 * - Slug generation and uniqueness
 * - Complex queries with joins
 * - Search and filtering with PostGIS
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StoryRepository } from '../../src/repositories/story.repository.js';
import type {
  Story,
  StoryCreateData,
  StoryFilters,
  PaginationOptions,
} from '../../src/repositories/story.repository.js';
import type { Database } from '../../src/db/index.js';
import { setupTestDb, cleanupTestDb, createTestData } from '../helpers/database.js';

describe('StoryRepository', () => {
  let storyRepository: StoryRepository;
  let testDb: Database;
  let testData: {
    community: any;
    users: any;
    places: any[];
    speakers: any[];
  };

  beforeEach(async () => {
    testDb = await setupTestDb();
    storyRepository = new StoryRepository(testDb);
    testData = await createTestData();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  describe('create', () => {
    it('should create story with all fields and associations', async () => {
      // Arrange
      const storyData: StoryCreateData = {
        title: 'The Legend of Sacred Mountain',
        description: 'A traditional creation story',
        slug: 'legend-sacred-mountain',
        communityId: testData.community.id,
        createdBy: testData.users.elder.id,
        mediaUrls: ['/uploads/image1.jpg', '/uploads/audio1.mp3'],
        language: 'en',
        tags: ['creation', 'sacred', 'mountain'],
        isRestricted: true,
        placeIds: [testData.places[0].id, testData.places[1].id],
        speakerIds: [testData.speakers[0].id],
        placeContexts: ['Sacred origin site', 'Ceremonial gathering place'],
        speakerRoles: ['narrator'],
      };

      // Act
      const result = await storyRepository.create(storyData);

      // Assert
      expect(result).toMatchObject({
        title: storyData.title,
        description: storyData.description,
        slug: storyData.slug,
        communityId: storyData.communityId,
        createdBy: storyData.createdBy,
        mediaUrls: storyData.mediaUrls,
        language: storyData.language,
        tags: storyData.tags,
        isRestricted: storyData.isRestricted,
      });
      expect(result.id).toBeDefined();
      expect(result.createdAt).toBeDefined();
      expect(result.updatedAt).toBeDefined();

      // Verify associations were created
      const storyWithRelations = await storyRepository.findByIdWithRelations(result.id);
      expect(storyWithRelations?.places).toHaveLength(2);
      expect(storyWithRelations?.speakers).toHaveLength(1);
      expect(storyWithRelations?.places[0].culturalContext).toBe('Sacred origin site');
      expect(storyWithRelations?.speakers[0].culturalRole).toBe('narrator');
    });

    it('should auto-generate slug when not provided', async () => {
      // Arrange
      const storyData: StoryCreateData = {
        title: 'Another Amazing Story!',
        communityId: testData.community.id,
        createdBy: testData.users.editor.id,
      };

      // Act
      const result = await storyRepository.create(storyData);

      // Assert
      expect(result.slug).toBe('another-amazing-story');
      expect(result.slug).toMatch(/^[a-z0-9-]+$/);
    });

    it('should handle duplicate slug by appending counter', async () => {
      // Arrange
      const baseStoryData: StoryCreateData = {
        title: 'Duplicate Title',
        communityId: testData.community.id,
        createdBy: testData.users.editor.id,
      };

      // Act - Create first story
      const firstStory = await storyRepository.create(baseStoryData);
      
      // Act - Create second story with same title
      const secondStory = await storyRepository.create(baseStoryData);

      // Assert
      expect(firstStory.slug).toBe('duplicate-title');
      expect(secondStory.slug).toBe('duplicate-title-1');
    });

    it('should enforce database constraints', async () => {
      // Arrange - Invalid data
      const invalidStoryData: StoryCreateData = {
        title: '', // Empty title should fail
        communityId: testData.community.id,
        createdBy: testData.users.editor.id,
      };

      // Act & Assert
      await expect(storyRepository.create(invalidStoryData)).rejects.toThrow();
    });
  });

  describe('findByIdWithRelations', () => {
    let testStory: Story;

    beforeEach(async () => {
      // Create a test story with associations
      testStory = await storyRepository.create({
        title: 'Test Story with Relations',
        slug: 'test-story-relations',
        communityId: testData.community.id,
        createdBy: testData.users.editor.id,
        placeIds: [testData.places[0].id],
        speakerIds: [testData.speakers[0].id],
        placeContexts: ['Test place context'],
        speakerRoles: ['narrator'],
      });
    });

    it('should fetch story with all relations populated', async () => {
      // Act
      const result = await storyRepository.findByIdWithRelations(testStory.id);

      // Assert
      expect(result).toBeDefined();
      expect(result!.id).toBe(testStory.id);
      expect(result!.places).toHaveLength(1);
      expect(result!.speakers).toHaveLength(1);
      expect(result!.community).toBeDefined();
      expect(result!.author).toBeDefined();

      // Check place relation details
      expect(result!.places[0]).toMatchObject({
        id: testData.places[0].id,
        name: testData.places[0].name,
        culturalContext: 'Test place context',
      });

      // Check speaker relation details
      expect(result!.speakers[0]).toMatchObject({
        id: testData.speakers[0].id,
        name: testData.speakers[0].name,
        culturalRole: 'narrator',
      });
    });

    it('should return null for non-existent story', async () => {
      // Act
      const result = await storyRepository.findByIdWithRelations(999);

      // Assert
      expect(result).toBeNull();
    });

    it('should handle story without associations', async () => {
      // Arrange - Create story without associations
      const storyWithoutAssociations = await storyRepository.create({
        title: 'Standalone Story',
        slug: 'standalone-story',
        communityId: testData.community.id,
        createdBy: testData.users.editor.id,
      });

      // Act
      const result = await storyRepository.findByIdWithRelations(storyWithoutAssociations.id);

      // Assert
      expect(result).toBeDefined();
      expect(result!.places).toHaveLength(0);
      expect(result!.speakers).toHaveLength(0);
      expect(result!.community).toBeDefined();
      expect(result!.author).toBeDefined();
    });
  });

  describe('findBySlugWithRelations', () => {
    let testStory: Story;

    beforeEach(async () => {
      testStory = await storyRepository.create({
        title: 'Slug Test Story',
        slug: 'unique-slug-test',
        communityId: testData.community.id,
        createdBy: testData.users.editor.id,
      });
    });

    it('should find story by slug within community', async () => {
      // Act
      const result = await storyRepository.findBySlugWithRelations(
        'unique-slug-test',
        testData.community.id
      );

      // Assert
      expect(result).toBeDefined();
      expect(result!.id).toBe(testStory.id);
      expect(result!.slug).toBe('unique-slug-test');
    });

    it('should enforce community scoping', async () => {
      // Act - Try to find story with wrong community ID
      const result = await storyRepository.findBySlugWithRelations(
        'unique-slug-test',
        999 // Wrong community ID
      );

      // Assert
      expect(result).toBeNull();
    });

    it('should return null for non-existent slug', async () => {
      // Act
      const result = await storyRepository.findBySlugWithRelations(
        'non-existent-slug',
        testData.community.id
      );

      // Assert
      expect(result).toBeNull();
    });
  });

  describe('update', () => {
    let testStory: Story;

    beforeEach(async () => {
      testStory = await storyRepository.create({
        title: 'Original Title',
        slug: 'original-title',
        description: 'Original description',
        communityId: testData.community.id,
        createdBy: testData.users.editor.id,
        placeIds: [testData.places[0].id],
        speakerIds: [testData.speakers[0].id],
      });
    });

    it('should update story fields', async () => {
      // Arrange
      const updates = {
        title: 'Updated Title',
        description: 'Updated description',
        tags: ['updated', 'test'],
      };

      // Act
      const result = await storyRepository.update(testStory.id, updates);

      // Assert - only compare fields that exist in the database schema
      expect(result).toMatchObject({
        id: testStory.id,
        slug: testStory.slug,
        communityId: testStory.communityId,
        createdBy: testStory.createdBy,
        language: testStory.language,
        mediaUrls: testStory.mediaUrls,
        isRestricted: testStory.isRestricted,
        createdAt: testStory.createdAt,
        ...updates,
      });
      expect(result.updatedAt.getTime()).toBeGreaterThan(testStory.updatedAt.getTime());
    });

    it('should update associations', async () => {
      // Arrange
      const updates = {
        placeIds: [testData.places[1].id], // Change to different place
        speakerIds: [testData.speakers[1].id], // Change to different speaker
      };

      // Act
      await storyRepository.update(testStory.id, updates);

      // Assert
      const updatedStory = await storyRepository.findByIdWithRelations(testStory.id);
      expect(updatedStory!.places).toHaveLength(1);
      expect(updatedStory!.places[0].id).toBe(testData.places[1].id);
      expect(updatedStory!.speakers).toHaveLength(1);
      expect(updatedStory!.speakers[0].id).toBe(testData.speakers[1].id);
    });

    it('should clear associations when empty arrays provided', async () => {
      // Arrange
      const updates = {
        placeIds: [],
        speakerIds: [],
      };

      // Act
      await storyRepository.update(testStory.id, updates);

      // Assert
      const updatedStory = await storyRepository.findByIdWithRelations(testStory.id);
      expect(updatedStory!.places).toHaveLength(0);
      expect(updatedStory!.speakers).toHaveLength(0);
    });

    it('should return null for non-existent story', async () => {
      // Act
      const result = await storyRepository.update(999, { title: 'Updated' });

      // Assert
      expect(result).toBeNull();
    });
  });

  describe('delete', () => {
    let testStory: Story;

    beforeEach(async () => {
      testStory = await storyRepository.create({
        title: 'Story to Delete',
        slug: 'story-to-delete',
        communityId: testData.community.id,
        createdBy: testData.users.editor.id,
        placeIds: [testData.places[0].id],
        speakerIds: [testData.speakers[0].id],
      });
    });

    it('should delete story and cascade associations', async () => {
      // Act
      const success = await storyRepository.delete(testStory.id);

      // Assert
      expect(success).toBe(true);

      // Verify story is deleted
      const deletedStory = await storyRepository.findById(testStory.id);
      expect(deletedStory).toBeNull();

      // Verify associations are cleaned up (this would be tested with actual DB)
      // In a real implementation, we'd check that story_places and story_speakers entries are deleted
    });

    it('should return false for non-existent story', async () => {
      // Act
      const success = await storyRepository.delete(999);

      // Assert
      expect(success).toBe(false);
    });
  });

  describe('findMany - Search and Filtering', () => {
    beforeEach(async () => {
      // Create test stories with different characteristics
      await Promise.all([
        storyRepository.create({
          title: 'Mountain Spirit Legend',
          description: 'Ancient spirits dwelling in the sacred peaks...',
          slug: 'mountain-spirit-legend',
          communityId: testData.community.id,
          createdBy: testData.users.elder.id,
          tags: ['spirits', 'mountains', 'ancient'],
          isRestricted: false,
          placeIds: [testData.places[0].id], // Mountain location
        }),
        storyRepository.create({
          title: 'River Medicine Teachings',
          description: 'Traditional healing practices by the river...',
          slug: 'river-medicine-teachings',
          communityId: testData.community.id,
          createdBy: testData.users.elder.id,
          tags: ['healing', 'medicine', 'river'],
          isRestricted: true,
          placeIds: [testData.places[1].id], // River location
        }),
        storyRepository.create({
          title: 'Seasonal Hunting Story',
          description: 'Respectful hunting practices through the seasons...',
          slug: 'seasonal-hunting-story',
          communityId: testData.community.id,
          createdBy: testData.users.editor.id,
          tags: ['hunting', 'seasons', 'respect'],
          isRestricted: false,
        }),
      ]);
    });

    it('should search stories by text query', async () => {
      // Arrange
      const filters: StoryFilters = {
        search: 'mountain spirit',
        communityId: testData.community.id,
      };
      const pagination: PaginationOptions = { page: 1, limit: 10 };

      // Act
      const result = await storyRepository.findMany(filters, pagination);

      // Assert
      expect(result.data).toHaveLength(1);
      expect(result.data[0].title).toBe('Mountain Spirit Legend');
      expect(result.total).toBe(1);
    });

    it('should filter by community ID', async () => {
      // Arrange
      const filters: StoryFilters = {
        communityId: testData.community.id,
      };
      const pagination: PaginationOptions = { page: 1, limit: 10 };

      // Act
      const result = await storyRepository.findMany(filters, pagination);

      // Assert
      expect(result.data.length).toBeGreaterThan(0);
      result.data.forEach(story => {
        expect(story.communityId).toBe(testData.community.id);
      });
    });

    it('should filter by restriction status', async () => {
      // Arrange
      const filters: StoryFilters = {
        communityId: testData.community.id,
        isRestricted: false,
      };
      const pagination: PaginationOptions = { page: 1, limit: 10 };

      // Act
      const result = await storyRepository.findMany(filters, pagination);

      // Assert
      expect(result.data.length).toBeGreaterThan(0);
      result.data.forEach(story => {
        expect(story.isRestricted).toBe(false);
      });
    });

    it('should filter by tags', async () => {
      // Arrange
      const filters: StoryFilters = {
        communityId: testData.community.id,
        tags: ['healing', 'medicine'],
      };
      const pagination: PaginationOptions = { page: 1, limit: 10 };

      // Act
      const result = await storyRepository.findMany(filters, pagination);

      // Assert
      expect(result.data).toHaveLength(1);
      expect(result.data[0].title).toBe('River Medicine Teachings');
    });

    it('should handle geographic proximity filtering', async () => {
      // Arrange - Point near the mountain location
      const filters: StoryFilters = {
        communityId: testData.community.id,
        nearPoint: { type: 'Point', coordinates: [-123.11, 49.31] },
        radiusKm: 5,
      };
      const pagination: PaginationOptions = { page: 1, limit: 10 };

      // Act
      const result = await storyRepository.findMany(filters, pagination);

      // Assert
      expect(result.data.length).toBeGreaterThan(0);
      // Should include stories associated with places within 5km
    });

    it('should support pagination', async () => {
      // Arrange
      const filters: StoryFilters = {
        communityId: testData.community.id,
      };
      const pagination: PaginationOptions = { page: 1, limit: 2 };

      // Act
      const result = await storyRepository.findMany(filters, pagination);

      // Assert
      expect(result.data.length).toBeLessThanOrEqual(2);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(2);
      expect(result.totalPages).toBeGreaterThanOrEqual(1);
    });

    it('should sort results consistently', async () => {
      // Arrange
      const filters: StoryFilters = {
        communityId: testData.community.id,
      };
      const pagination: PaginationOptions = { page: 1, limit: 10 };

      // Act
      const result = await storyRepository.findMany(filters, pagination);

      // Assert
      // Results should be sorted by creation date (newest first) by default
      for (let i = 1; i < result.data.length; i++) {
        expect(result.data[i-1].createdAt.getTime()).toBeGreaterThanOrEqual(
          result.data[i].createdAt.getTime()
        );
      }
    });
  });

  describe('generateUniqueSlug', () => {
    it('should generate URL-friendly slug from title', async () => {
      // Act
      const slug = await storyRepository.generateUniqueSlug(
        'The Amazing Story: Part One!',
        testData.community.id
      );

      // Assert
      expect(slug).toBe('the-amazing-story-part-one');
      expect(slug).toMatch(/^[a-z0-9-]+$/);
    });

    it('should handle special characters and spaces', async () => {
      // Act
      const slug = await storyRepository.generateUniqueSlug(
        'Sp3ci@l Ch@rs & Spac3s!!!',
        testData.community.id
      );

      // Assert
      expect(slug).toBe('sp3cil-chrs-spac3s');
    });

    it('should truncate long titles', async () => {
      // Arrange
      const longTitle = 'This is a very long title that should be truncated to a reasonable length for URL use and database storage';

      // Act
      const slug = await storyRepository.generateUniqueSlug(longTitle, testData.community.id);

      // Assert
      expect(slug.length).toBeLessThanOrEqual(50);
      expect(slug).toMatch(/^[a-z0-9-]+$/);
    });

    it('should ensure uniqueness within community', async () => {
      // Arrange - Create story with a specific slug
      await storyRepository.create({
        title: 'Unique Title',
        slug: 'unique-title',
        communityId: testData.community.id,
        createdBy: testData.users.editor.id,
      });

      // Act - Generate slug for same title
      const newSlug = await storyRepository.generateUniqueSlug(
        'Unique Title',
        testData.community.id
      );

      // Assert
      expect(newSlug).toBe('unique-title-1');
    });
  });

  describe('Performance Tests', () => {
    it('should handle complex queries efficiently', async () => {
      // Arrange - Create many test stories
      const manyStories = Array.from({ length: 100 }, (_, i) => ({
        title: `Performance Test Story ${i + 1}`,
        slug: `performance-test-story-${i + 1}`,
        communityId: testData.community.id,
        createdBy: testData.users.editor.id,
        tags: [`tag${i % 10}`],
      }));

      await Promise.all(
        manyStories.map(story => storyRepository.create(story))
      );

      const startTime = Date.now();

      // Act - Complex query with search and filtering
      const result = await storyRepository.findMany(
        {
          communityId: testData.community.id,
          search: 'Performance',
          tags: ['tag5'],
        },
        { page: 1, limit: 20 }
      );

      const endTime = Date.now();
      const queryTime = endTime - startTime;

      // Assert
      expect(queryTime).toBeLessThan(1000); // Should complete in under 1 second
      expect(result.data.length).toBeGreaterThan(0);
    });
  });
});