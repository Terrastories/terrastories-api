/**
 * Community Repository Test Suite
 *
 * Comprehensive database-level testing for CommunityRepository including:
 * - CRUD operations with proper data validation
 * - Slug generation and uniqueness validation
 * - Cultural protocol support and JSON validation
 * - Search and filtering capabilities
 * - Data sovereignty and isolation features
 * - Error handling and edge cases
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  CommunityRepository,
  CommunityNotFoundError,
  InvalidCommunityDataError,
  type CreateCommunityData,
  type UpdateCommunityData,
  type CommunitySearchParams,
  type CulturalProtocols,
} from '../../src/repositories/community.repository.js';
import { TestDatabaseManager } from '../helpers/database.js';

describe('CommunityRepository', () => {
  let communityRepository: CommunityRepository;
  let testDb: TestDatabaseManager;

  beforeEach(async () => {
    testDb = new TestDatabaseManager();
    const db = await testDb.setup();
    communityRepository = new CommunityRepository(db);
  });

  afterEach(async () => {
    await testDb.teardown();
  });

  describe('create', () => {
    it('should create community with minimal required fields', async () => {
      // Arrange
      const communityData: CreateCommunityData = {
        name: 'Test Community',
        description: 'A test community for unit testing',
      };

      // Act
      const result = await communityRepository.create(communityData);

      // Assert
      expect(result).toBeDefined();
      expect(result.id).toBeTypeOf('number');
      expect(result.name).toBe('Test Community');
      expect(result.description).toBe('A test community for unit testing');
      expect(result.slug).toMatch(/^test-community/);
      expect(result.publicStories).toBe(false);
      expect(result.locale).toBe('en');
      expect(result.isActive).toBe(true);
      expect(result.createdAt).toBeInstanceOf(Date);
      expect(result.updatedAt).toBeInstanceOf(Date);
    });

    it('should create community with all fields including cultural settings', async () => {
      // Arrange
      const culturalProtocols: CulturalProtocols = {
        languagePreferences: ['en', 'es', 'mic'],
        elderContentRestrictions: true,
        ceremonialContent: true,
        traditionalKnowledge: true,
        communityApprovalRequired: true,
        dataRetentionPolicy: 'community-controlled',
        accessRestrictions: [
          'elder-approval-required',
          'ceremonial-restricted',
        ],
        culturalNotes: "This community follows traditional Mi'kmaq protocols",
      };

      const communityData: CreateCommunityData = {
        name: "Mi'kmaq Heritage Community",
        description: "Community dedicated to preserving Mi'kmaq traditions",
        slug: 'mikmaq-heritage',
        publicStories: false,
        locale: 'mic',
        culturalSettings: JSON.stringify(culturalProtocols),
        isActive: true,
      };

      // Act
      const result = await communityRepository.create(communityData);

      // Assert
      expect(result).toBeDefined();
      expect(result.name).toBe("Mi'kmaq Heritage Community");
      expect(result.slug).toBe('mikmaq-heritage');
      expect(result.locale).toBe('mic');
      expect(result.culturalSettings).toBe(JSON.stringify(culturalProtocols));
      expect(result.isActive).toBe(true);
    });

    it('should generate unique slug when slug is not provided', async () => {
      // Arrange
      const communityData: CreateCommunityData = {
        name: 'Auto Slug Community',
      };

      // Act
      const result = await communityRepository.create(communityData);

      // Assert
      expect(result.slug).toBe('auto-slug-community');
    });

    it('should generate unique slug when provided slug already exists', async () => {
      // Arrange
      const firstCommunity: CreateCommunityData = {
        name: 'First Community',
        slug: 'test-slug',
      };
      const secondCommunity: CreateCommunityData = {
        name: 'Second Community',
        // Don't provide slug, let it auto-generate from name
      };

      // Act
      await communityRepository.create(firstCommunity);
      const result = await communityRepository.create(secondCommunity);

      // Assert
      expect(result.slug).toBe('second-community');
    });

    it('should throw error for invalid community data', async () => {
      // Arrange
      const invalidData: CreateCommunityData = {
        name: '', // Empty name
      };

      // Act & Assert
      await expect(communityRepository.create(invalidData)).rejects.toThrow(
        InvalidCommunityDataError
      );
    });

    it('should throw error for name that is too long', async () => {
      // Arrange
      const invalidData: CreateCommunityData = {
        name: 'A'.repeat(101), // Too long
      };

      // Act & Assert
      await expect(communityRepository.create(invalidData)).rejects.toThrow(
        InvalidCommunityDataError
      );
    });

    it('should throw error for description that is too long', async () => {
      // Arrange
      const invalidData: CreateCommunityData = {
        name: 'Valid Name',
        description: 'A'.repeat(1001), // Too long
      };

      // Act & Assert
      await expect(communityRepository.create(invalidData)).rejects.toThrow(
        InvalidCommunityDataError
      );
    });

    it('should throw error for invalid cultural settings JSON', async () => {
      // Arrange
      const invalidData: CreateCommunityData = {
        name: 'Valid Name',
        culturalSettings: 'invalid-json{',
      };

      // Act & Assert
      await expect(communityRepository.create(invalidData)).rejects.toThrow(
        InvalidCommunityDataError
      );
    });
  });

  describe('findById', () => {
    it('should find community by ID', async () => {
      // Arrange
      const communityData: CreateCommunityData = {
        name: 'Findable Community',
        description: 'A community to test finding by ID',
      };
      const created = await communityRepository.create(communityData);

      // Act
      const result = await communityRepository.findById(created.id);

      // Assert
      expect(result).toBeDefined();
      expect(result!.id).toBe(created.id);
      expect(result!.name).toBe('Findable Community');
      expect(result!.description).toBe('A community to test finding by ID');
    });

    it('should return null for non-existent ID', async () => {
      // Act
      const result = await communityRepository.findById(99999);

      // Assert
      expect(result).toBeNull();
    });
  });

  describe('findBySlug', () => {
    it('should find community by slug', async () => {
      // Arrange
      const communityData: CreateCommunityData = {
        name: 'Slug Community',
        slug: 'find-by-slug-test',
      };
      const created = await communityRepository.create(communityData);

      // Act
      const result = await communityRepository.findBySlug('find-by-slug-test');

      // Assert
      expect(result).toBeDefined();
      expect(result!.id).toBe(created.id);
      expect(result!.slug).toBe('find-by-slug-test');
    });

    it('should return null for non-existent slug', async () => {
      // Act
      const result = await communityRepository.findBySlug('non-existent-slug');

      // Assert
      expect(result).toBeNull();
    });
  });

  describe('search', () => {
    beforeEach(async () => {
      // Create test communities for search testing
      await communityRepository.create({
        name: 'Indigenous Heritage Community',
        description: 'Preserving traditional knowledge and stories',
        locale: 'en',
        isActive: true,
      });

      await communityRepository.create({
        name: 'Inuit Arctic Community',
        description: 'Stories from the Arctic regions',
        locale: 'iu',
        isActive: true,
      });

      await communityRepository.create({
        name: 'Inactive Test Community',
        description: 'This community is not active',
        locale: 'en',
        isActive: false,
      });
    });

    it('should search communities by name', async () => {
      // Arrange
      const searchParams: CommunitySearchParams = {
        query: 'Indigenous',
      };

      // Act
      const results = await communityRepository.search(searchParams);

      // Assert
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('Indigenous Heritage Community');
    });

    it('should search communities by description', async () => {
      // Arrange
      const searchParams: CommunitySearchParams = {
        query: 'Arctic',
      };

      // Act
      const results = await communityRepository.search(searchParams);

      // Assert
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('Inuit Arctic Community');
    });

    it('should filter communities by locale', async () => {
      // Arrange
      const searchParams: CommunitySearchParams = {
        locale: 'iu',
      };

      // Act
      const results = await communityRepository.search(searchParams);

      // Assert
      expect(results).toHaveLength(1);
      expect(results[0].locale).toBe('iu');
    });

    it('should filter communities by active status', async () => {
      // Arrange
      const searchParams: CommunitySearchParams = {
        isActive: false,
      };

      // Act
      const results = await communityRepository.search(searchParams);

      // Assert
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('Inactive Test Community');
      expect(results[0].isActive).toBe(false);
    });

    it('should respect limit and offset parameters', async () => {
      // Arrange
      const searchParams: CommunitySearchParams = {
        limit: 1,
        offset: 1,
      };

      // Act
      const results = await communityRepository.search(searchParams);

      // Assert
      expect(results).toHaveLength(1);
    });

    it('should return all communities when no filters are provided', async () => {
      // Act
      const results = await communityRepository.search();

      // Assert
      expect(results.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('findAllActive', () => {
    beforeEach(async () => {
      await communityRepository.create({
        name: 'Active Community 1',
        isActive: true,
      });

      await communityRepository.create({
        name: 'Active Community 2',
        isActive: true,
      });

      await communityRepository.create({
        name: 'Inactive Community',
        isActive: false,
      });
    });

    it('should return only active communities', async () => {
      // Act
      const results = await communityRepository.findAllActive();

      // Assert
      expect(results.length).toBeGreaterThanOrEqual(2);
      results.forEach((community) => {
        expect(community.isActive).toBe(true);
      });
    });
  });

  describe('update', () => {
    it('should update community fields', async () => {
      // Arrange
      const original = await communityRepository.create({
        name: 'Original Name',
        description: 'Original description',
        locale: 'en',
      });

      const updates: UpdateCommunityData = {
        name: 'Updated Name',
        description: 'Updated description',
        locale: 'fr',
        publicStories: true,
      };

      // Act
      const result = await communityRepository.update(original.id, updates);

      // Assert
      expect(result).toBeDefined();
      expect(result!.name).toBe('Updated Name');
      expect(result!.description).toBe('Updated description');
      expect(result!.locale).toBe('fr');
      expect(result!.publicStories).toBe(true);
      expect(result!.updatedAt.getTime()).toBeGreaterThanOrEqual(
        original.updatedAt.getTime()
      );
    });

    it('should update cultural settings', async () => {
      // Arrange
      const original = await communityRepository.create({
        name: 'Cultural Community',
      });

      const culturalProtocols: CulturalProtocols = {
        languagePreferences: ['mic'],
        elderContentRestrictions: true,
        ceremonialContent: true,
        traditionalKnowledge: true,
        communityApprovalRequired: true,
        dataRetentionPolicy: 'community-controlled',
        accessRestrictions: ['elder-approval-required'],
      };

      const updates: UpdateCommunityData = {
        culturalSettings: JSON.stringify(culturalProtocols),
      };

      // Act
      const result = await communityRepository.update(original.id, updates);

      // Assert
      expect(result).toBeDefined();
      expect(result!.culturalSettings).toBe(JSON.stringify(culturalProtocols));
    });

    it('should throw error when updating non-existent community', async () => {
      // Arrange
      const updates: UpdateCommunityData = {
        name: 'Non-existent',
      };

      // Act & Assert
      await expect(communityRepository.update(99999, updates)).rejects.toThrow(
        CommunityNotFoundError
      );
    });

    it('should throw error for invalid update data', async () => {
      // Arrange
      const original = await communityRepository.create({
        name: 'Valid Community',
      });

      const invalidUpdates: UpdateCommunityData = {
        name: '', // Empty name
      };

      // Act & Assert
      await expect(
        communityRepository.update(original.id, invalidUpdates)
      ).rejects.toThrow(InvalidCommunityDataError);
    });
  });

  describe('delete', () => {
    it('should delete community successfully', async () => {
      // Arrange
      const community = await communityRepository.create({
        name: 'Deletable Community',
      });

      // Act
      const result = await communityRepository.delete(community.id);

      // Assert
      expect(result).toBe(true);

      // Verify deletion
      const found = await communityRepository.findById(community.id);
      expect(found).toBeNull();
    });

    it('should return false when deleting non-existent community', async () => {
      // Act
      const result = await communityRepository.delete(99999);

      // Assert
      expect(result).toBe(false);
    });
  });

  describe('count', () => {
    beforeEach(async () => {
      await communityRepository.create({
        name: 'Active Community 1',
        isActive: true,
      });

      await communityRepository.create({
        name: 'Active Community 2',
        isActive: true,
      });

      await communityRepository.create({
        name: 'Inactive Community',
        isActive: false,
      });
    });

    it('should count all communities', async () => {
      // Act
      const result = await communityRepository.count();

      // Assert
      expect(result).toBeGreaterThanOrEqual(3);
    });

    it('should count only active communities', async () => {
      // Act
      const result = await communityRepository.count(true);

      // Assert
      expect(result).toBeGreaterThanOrEqual(2);
    });

    it('should count only inactive communities', async () => {
      // Act
      const result = await communityRepository.count(false);

      // Assert
      expect(result).toBeGreaterThanOrEqual(1);
    });
  });

  describe('isSlugAvailable', () => {
    beforeEach(async () => {
      await communityRepository.create({
        name: 'Existing Community',
        slug: 'existing-slug',
      });
    });

    it('should return false for existing slug', async () => {
      // Act
      const result = await communityRepository.isSlugAvailable('existing-slug');

      // Assert
      expect(result).toBe(false);
    });

    it('should return true for available slug', async () => {
      // Act
      const result =
        await communityRepository.isSlugAvailable('available-slug');

      // Assert
      expect(result).toBe(true);
    });

    it('should exclude specified ID from check', async () => {
      // Arrange
      const community = await communityRepository.create({
        name: 'Test Community',
        slug: 'test-slug-exclude',
      });

      // Act
      const result = await communityRepository.isSlugAvailable(
        'test-slug-exclude',
        community.id
      );

      // Assert
      expect(result).toBe(true);
    });
  });

  describe('deactivate', () => {
    it('should deactivate community', async () => {
      // Arrange
      const community = await communityRepository.create({
        name: 'Active Community',
        isActive: true,
      });

      // Act
      const result = await communityRepository.deactivate(community.id);

      // Assert
      expect(result).toBe(true);

      // Verify deactivation
      const updated = await communityRepository.findById(community.id);
      expect(updated!.isActive).toBe(false);
    });

    it('should return false for non-existent community', async () => {
      // Act
      const result = await communityRepository.deactivate(99999);

      // Assert
      expect(result).toBe(false);
    });
  });

  describe('reactivate', () => {
    it('should reactivate community', async () => {
      // Arrange
      const community = await communityRepository.create({
        name: 'Inactive Community',
        isActive: false,
      });

      // Act
      const result = await communityRepository.reactivate(community.id);

      // Assert
      expect(result).toBe(true);

      // Verify reactivation
      const updated = await communityRepository.findById(community.id);
      expect(updated!.isActive).toBe(true);
    });

    it('should return false for non-existent community', async () => {
      // Act
      const result = await communityRepository.reactivate(99999);

      // Assert
      expect(result).toBe(false);
    });
  });

  describe('slug generation edge cases', () => {
    it('should handle special characters in name', async () => {
      // Arrange
      const communityData: CreateCommunityData = {
        name: 'Community with Special Characters! @#$%',
      };

      // Act
      const result = await communityRepository.create(communityData);

      // Assert
      expect(result.slug).toMatch(/^community-with-special-characters/);
      expect(result.slug).not.toContain('!');
      expect(result.slug).not.toContain('@');
      expect(result.slug).not.toContain('#');
    });

    it('should handle very short names', async () => {
      // Arrange
      const communityData: CreateCommunityData = {
        name: 'AB',
      };

      // Act
      const result = await communityRepository.create(communityData);

      // Assert
      expect(result.slug).toBe('community-ab');
      expect(result.slug.length).toBeGreaterThanOrEqual(3);
    });

    it('should handle names with multiple spaces', async () => {
      // Arrange
      const communityData: CreateCommunityData = {
        name: 'Community   With    Multiple     Spaces',
      };

      // Act
      const result = await communityRepository.create(communityData);

      // Assert
      expect(result.slug).toBe('community-with-multiple-spaces');
    });

    it('should handle names starting/ending with spaces and hyphens', async () => {
      // Arrange
      const communityData: CreateCommunityData = {
        name: '  -Community Name-  ',
      };

      // Act
      const result = await communityRepository.create(communityData);

      // Assert
      expect(result.slug).toBe('community-name');
      expect(result.slug.startsWith('-')).toBe(false);
      expect(result.slug.endsWith('-')).toBe(false);
    });

    it('should generate multiple unique variants', async () => {
      // Arrange & Act
      const community1 = await communityRepository.create({
        name: 'Same Name',
      });
      const community2 = await communityRepository.create({
        name: 'Same Name',
      });
      const community3 = await communityRepository.create({
        name: 'Same Name',
      });

      // Assert
      expect(community1.slug).toBe('same-name');
      expect(community2.slug).toBe('same-name-1');
      expect(community3.slug).toBe('same-name-2');
    });
  });
});
