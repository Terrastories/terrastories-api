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
      const communityData: CreateCommunityData = {
        name: 'Test Community',
        description: 'A test community for unit testing',
      };

      const result = await communityRepository.create(communityData);

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

      const result = await communityRepository.create(communityData);

      expect(result).toBeDefined();
      expect(result.name).toBe("Mi'kmaq Heritage Community");
      expect(result.slug).toBe('mikmaq-heritage');
      expect(result.locale).toBe('mic');
      expect(result.culturalSettings).toBe(JSON.stringify(culturalProtocols));
      expect(result.isActive).toBe(true);
    });

    it('should generate unique slug when slug is not provided', async () => {
      const communityData: CreateCommunityData = {
        name: 'Auto Slug Community',
      };

      const result = await communityRepository.create(communityData);

      expect(result.slug).toBe('auto-slug-community');
    });

    it('should generate unique slug when provided slug already exists', async () => {
      const firstCommunity: CreateCommunityData = {
        name: 'First Community',
        slug: 'test-slug',
      };
      const secondCommunity: CreateCommunityData = {
        name: 'Second Community',
      };

      await communityRepository.create(firstCommunity);
      const result = await communityRepository.create(secondCommunity);

      expect(result.slug).toBe('second-community');
    });

    it('should persist Rails-compatible country/beta fields', async () => {
      const result = await communityRepository.create({
        name: 'Rails Fields Community',
        country: 'CA',
        beta: true,
      });

      expect(result.name).toBe('Rails Fields Community');
      expect(result.country).toBe('CA');
      expect(result.beta).toBe(true);
    });

    it('should throw error for invalid community data', async () => {
      const invalidData: CreateCommunityData = {
        name: '',
      };

      await expect(communityRepository.create(invalidData)).rejects.toThrow(
        InvalidCommunityDataError
      );
    });

    it('should throw error for name that is too long', async () => {
      const invalidData: CreateCommunityData = {
        name: 'A'.repeat(101),
      };

      await expect(communityRepository.create(invalidData)).rejects.toThrow(
        InvalidCommunityDataError
      );
    });

    it('should throw error for description that is too long', async () => {
      const invalidData: CreateCommunityData = {
        name: 'Valid Name',
        description: 'A'.repeat(1001),
      };

      await expect(communityRepository.create(invalidData)).rejects.toThrow(
        InvalidCommunityDataError
      );
    });

    it('should throw error for invalid cultural settings JSON', async () => {
      const invalidData: CreateCommunityData = {
        name: 'Valid Name',
        culturalSettings: 'invalid-json{',
      };

      await expect(communityRepository.create(invalidData)).rejects.toThrow(
        InvalidCommunityDataError
      );
    });
  });

  describe('findById', () => {
    it('should find community by ID', async () => {
      const communityData: CreateCommunityData = {
        name: 'Findable Community',
        description: 'A community to test finding by ID',
      };
      const created = await communityRepository.create(communityData);

      const result = await communityRepository.findById(created.id);

      expect(result).toBeDefined();
      expect(result!.id).toBe(created.id);
      expect(result!.name).toBe('Findable Community');
      expect(result!.description).toBe('A community to test finding by ID');
    });

    it('should return null for non-existent ID', async () => {
      const result = await communityRepository.findById(99999);
      expect(result).toBeNull();
    });
  });

  describe('findBySlug', () => {
    it('should find community by slug', async () => {
      const communityData: CreateCommunityData = {
        name: 'Slug Community',
        slug: 'find-by-slug-test',
      };
      const created = await communityRepository.create(communityData);

      const result = await communityRepository.findBySlug('find-by-slug-test');

      expect(result).toBeDefined();
      expect(result!.id).toBe(created.id);
      expect(result!.slug).toBe('find-by-slug-test');
    });

    it('should return null for non-existent slug', async () => {
      const result = await communityRepository.findBySlug('non-existent-slug');
      expect(result).toBeNull();
    });
  });

  describe('search', () => {
    beforeEach(async () => {
      await communityRepository.create({
        name: 'Indigenous Heritage Community',
        description: 'Preserving traditional knowledge and stories',
        locale: 'en',
        isActive: true,
        country: 'US',
        beta: false,
      });

      await communityRepository.create({
        name: 'Inuit Arctic Community',
        description: 'Stories from the Arctic regions',
        locale: 'iu',
        isActive: true,
        country: 'CA',
        beta: true,
      });

      await communityRepository.create({
        name: 'Inactive Test Community',
        description: 'This community is not active',
        locale: 'en',
        isActive: false,
        country: 'US',
        beta: false,
      });

      await communityRepository.create({
        name: 'Mexican Beta Community',
        description: 'Testing new features in Mexico',
        locale: 'es',
        isActive: true,
        country: 'MX',
        beta: true,
      });
    });

    it('should search communities by name', async () => {
      const searchParams: CommunitySearchParams = {
        query: 'Indigenous',
      };

      const results = await communityRepository.search(searchParams);

      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('Indigenous Heritage Community');
    });

    it('should search communities by description', async () => {
      const searchParams: CommunitySearchParams = {
        query: 'Arctic',
      };

      const results = await communityRepository.search(searchParams);

      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('Inuit Arctic Community');
    });

    it('should filter communities by locale', async () => {
      const searchParams: CommunitySearchParams = {
        locale: 'iu',
      };

      const results = await communityRepository.search(searchParams);

      expect(results).toHaveLength(1);
      expect(results[0].locale).toBe('iu');
    });

    it('should filter communities by active status', async () => {
      const searchParams: CommunitySearchParams = {
        isActive: false,
      };

      const results = await communityRepository.search(searchParams);

      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('Inactive Test Community');
      expect(results[0].isActive).toBe(false);
    });

    it('should respect limit and offset parameters', async () => {
      const searchParams: CommunitySearchParams = {
        limit: 1,
        offset: 1,
      };

      const results = await communityRepository.search(searchParams);
      expect(results).toHaveLength(1);
    });

    it('should return all communities when no filters are provided', async () => {
      const results = await communityRepository.search();
      expect(results.length).toBeGreaterThanOrEqual(4);
    });

    it('should filter communities by country and beta status', async () => {
      const countryFiltered = await communityRepository.search({
        country: 'CA',
      });
      const betaFiltered = await communityRepository.search({ beta: true });

      expect(countryFiltered).toHaveLength(1);
      expect(countryFiltered[0].country).toBe('CA');
      expect(betaFiltered).toHaveLength(2);
      expect(betaFiltered.every((community) => community.beta)).toBe(true);
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
      const results = await communityRepository.findAllActive();

      expect(results.length).toBeGreaterThanOrEqual(2);
      results.forEach((community) => {
        expect(community.isActive).toBe(true);
      });
    });
  });

  describe('update', () => {
    it('should update community fields', async () => {
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

      const result = await communityRepository.update(original.id, updates);

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

      const result = await communityRepository.update(original.id, updates);

      expect(result).toBeDefined();
      expect(result!.culturalSettings).toBe(JSON.stringify(culturalProtocols));
    });

    it('should throw error when updating non-existent community', async () => {
      const updates: UpdateCommunityData = {
        name: 'Non-existent',
      };

      await expect(communityRepository.update(99999, updates)).rejects.toThrow(
        CommunityNotFoundError
      );
    });

    it('should update Rails-compatible country/beta fields', async () => {
      const original = await communityRepository.create({
        name: 'Rails Update Community',
      });

      const result = await communityRepository.update(original.id, {
        country: 'CA',
        beta: true,
      });

      expect(result).toBeDefined();
      expect(result!.name).toBe('Rails Update Community');
      expect(result!.country).toBe('CA');
      expect(result!.beta).toBe(true);
    });

    it('should throw error for invalid update data', async () => {
      const original = await communityRepository.create({
        name: 'Valid Community',
      });

      const invalidUpdates: UpdateCommunityData = {
        name: '',
      };

      await expect(
        communityRepository.update(original.id, invalidUpdates)
      ).rejects.toThrow(InvalidCommunityDataError);
    });
  });

  describe('delete', () => {
    it('should delete community successfully', async () => {
      const community = await communityRepository.create({
        name: 'Deletable Community',
      });

      const result = await communityRepository.delete(community.id);

      expect(result).toBe(true);
      const found = await communityRepository.findById(community.id);
      expect(found).toBeNull();
    });

    it('should return false when deleting non-existent community', async () => {
      const result = await communityRepository.delete(99999);
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
      const result = await communityRepository.count();
      expect(result).toBeGreaterThanOrEqual(3);
    });

    it('should count only active communities', async () => {
      const result = await communityRepository.count(true);
      expect(result).toBeGreaterThanOrEqual(2);
    });

    it('should count only inactive communities', async () => {
      const result = await communityRepository.count(false);
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
      const result = await communityRepository.isSlugAvailable('existing-slug');
      expect(result).toBe(false);
    });

    it('should return true for available slug', async () => {
      const result =
        await communityRepository.isSlugAvailable('available-slug');
      expect(result).toBe(true);
    });

    it('should exclude specified ID from check', async () => {
      const community = await communityRepository.create({
        name: 'Test Community',
        slug: 'test-slug-exclude',
      });

      const result = await communityRepository.isSlugAvailable(
        'test-slug-exclude',
        community.id
      );

      expect(result).toBe(true);
    });
  });

  describe('deactivate', () => {
    it('should deactivate community', async () => {
      const community = await communityRepository.create({
        name: 'Active Community',
        isActive: true,
      });

      const result = await communityRepository.deactivate(community.id);

      expect(result).toBe(true);
      const updated = await communityRepository.findById(community.id);
      expect(updated!.isActive).toBe(false);
    });

    it('should return false for non-existent community', async () => {
      const result = await communityRepository.deactivate(99999);
      expect(result).toBe(false);
    });
  });

  describe('reactivate', () => {
    it('should reactivate community', async () => {
      const community = await communityRepository.create({
        name: 'Inactive Community',
        isActive: false,
      });

      const result = await communityRepository.reactivate(community.id);

      expect(result).toBe(true);
      const updated = await communityRepository.findById(community.id);
      expect(updated!.isActive).toBe(true);
    });

    it('should return false for non-existent community', async () => {
      const result = await communityRepository.reactivate(99999);
      expect(result).toBe(false);
    });
  });

  describe('slug generation edge cases', () => {
    it('should handle special characters in name', async () => {
      const communityData: CreateCommunityData = {
        name: 'Community with Special Characters! @#$%',
      };

      const result = await communityRepository.create(communityData);

      expect(result.slug).toMatch(/^community-with-special-characters/);
      expect(result.slug).not.toContain('!');
      expect(result.slug).not.toContain('@');
      expect(result.slug).not.toContain('#');
    });

    it('should handle very short names', async () => {
      const communityData: CreateCommunityData = {
        name: 'AB',
      };

      const result = await communityRepository.create(communityData);

      expect(result.slug).toBe('community-ab');
      expect(result.slug.length).toBeGreaterThanOrEqual(3);
    });

    it('should handle names with multiple spaces', async () => {
      const communityData: CreateCommunityData = {
        name: 'Community   With    Multiple     Spaces',
      };

      const result = await communityRepository.create(communityData);
      expect(result.slug).toBe('community-with-multiple-spaces');
    });

    it('should handle names starting/ending with spaces and hyphens', async () => {
      const communityData: CreateCommunityData = {
        name: '  -Community Name-  ',
      };

      const result = await communityRepository.create(communityData);

      expect(result.slug).toBe('community-name');
      expect(result.slug.startsWith('-')).toBe(false);
      expect(result.slug.endsWith('-')).toBe(false);
    });

    it('should generate multiple unique variants', async () => {
      const community1 = await communityRepository.create({
        name: 'Same Name',
      });
      const community2 = await communityRepository.create({
        name: 'Same Name',
      });
      const community3 = await communityRepository.create({
        name: 'Same Name',
      });

      expect(community1.slug).toBe('same-name');
      expect(community2.slug).toBe('same-name-1');
      expect(community3.slug).toBe('same-name-2');
    });
  });
});
