/**
 * Community Service Test Suite
 *
 * Comprehensive business logic testing for CommunityService including:
 * - Input validation and sanitization
 * - Cultural protocol validation and management
 * - Business rule enforcement
 * - Error handling and edge cases
 * - Integration with repository layer
 * - Data sovereignty and Indigenous protocol compliance
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  CommunityService,
  CommunityValidationError,
  CommunityOperationError,
  type CreateCommunityRequest,
  type UpdateCommunityRequest,
} from '../../src/services/community.service.js';
import {
  CommunityRepository,
  type CulturalProtocols,
} from '../../src/repositories/community.repository.js';
import { TestDatabaseManager } from '../helpers/database.js';

describe('CommunityService', () => {
  let communityService: CommunityService;
  let communityRepository: CommunityRepository;
  let testDb: TestDatabaseManager;

  beforeEach(async () => {
    testDb = new TestDatabaseManager();
    const db = await testDb.setup();
    communityRepository = new CommunityRepository(db);
    communityService = new CommunityService(communityRepository);
  });

  afterEach(async () => {
    await testDb.teardown();
  });

  describe('createCommunity', () => {
    it('should create community with minimal valid data', async () => {
      // Arrange
      const createRequest: CreateCommunityRequest = {
        name: 'Test Indigenous Community',
        description: 'A test community for Indigenous stories',
      };

      // Act
      const result = await communityService.createCommunity(createRequest);

      // Assert
      expect(result).toBeDefined();
      expect(result.name).toBe('Test Indigenous Community');
      expect(result.description).toBe(
        'A test community for Indigenous stories'
      );
      expect(result.slug).toMatch(/^test-indigenous-community/);
      expect(result.publicStories).toBe(false);
      expect(result.locale).toBe('en');
      expect(result.isActive).toBe(true);
    });

    it('should create community with complete cultural protocols', async () => {
      // Arrange
      const culturalProtocols: CulturalProtocols = {
        languagePreferences: ['en', 'mic', 'fr'],
        elderContentRestrictions: true,
        ceremonialContent: true,
        traditionalKnowledge: true,
        communityApprovalRequired: true,
        dataRetentionPolicy: 'community-controlled',
        accessRestrictions: [
          'elder-approval-required',
          'ceremonial-restricted',
        ],
        culturalNotes: "Traditional Mi'kmaq community protocols apply",
      };

      const createRequest: CreateCommunityRequest = {
        name: "Mi'kmaq Heritage Community",
        description: "Community preserving Mi'kmaq traditions and stories",
        slug: 'mikmaq-heritage',
        publicStories: false,
        locale: 'mic',
        culturalSettings: culturalProtocols,
        isActive: true,
      };

      // Act
      const result = await communityService.createCommunity(createRequest);

      // Assert
      expect(result).toBeDefined();
      expect(result.name).toBe("Mi'kmaq Heritage Community");
      expect(result.slug).toBe('mikmaq-heritage');
      expect(result.locale).toBe('mic');
      expect(result.culturalSettings).toBeDefined();

      // Verify cultural settings are properly stored
      const parsedSettings = JSON.parse(result.culturalSettings!);
      expect(parsedSettings.languagePreferences).toContain('mic');
      expect(parsedSettings.elderContentRestrictions).toBe(true);
      expect(parsedSettings.ceremonialContent).toBe(true);
    });

    it('should create community with cultural settings as JSON string', async () => {
      // Arrange
      const culturalProtocols: CulturalProtocols = {
        languagePreferences: ['en'],
        elderContentRestrictions: false,
        ceremonialContent: false,
        traditionalKnowledge: true,
        communityApprovalRequired: false,
        dataRetentionPolicy: 'indefinite',
        accessRestrictions: ['public'],
      };

      const createRequest: CreateCommunityRequest = {
        name: 'JSON Settings Community',
        culturalSettings: JSON.stringify(culturalProtocols),
      };

      // Act
      const result = await communityService.createCommunity(createRequest);

      // Assert
      expect(result.culturalSettings).toBe(JSON.stringify(culturalProtocols));
    });

    it('should validate and trim community name', async () => {
      // Arrange
      const createRequest: CreateCommunityRequest = {
        name: '  Community With Spaces  ',
        description: '  Description with spaces  ',
      };

      // Act
      const result = await communityService.createCommunity(createRequest);

      // Assert
      expect(result.name).toBe('Community With Spaces');
      expect(result.description).toBe('Description with spaces');
    });

    describe('validation errors', () => {
      it('should throw error for empty name', async () => {
        // Arrange
        const createRequest: CreateCommunityRequest = {
          name: '',
        };

        // Act & Assert
        await expect(
          communityService.createCommunity(createRequest)
        ).rejects.toThrow(CommunityValidationError);
      });

      it('should throw error for name that is too short', async () => {
        // Arrange
        const createRequest: CreateCommunityRequest = {
          name: 'A',
        };

        // Act & Assert
        await expect(
          communityService.createCommunity(createRequest)
        ).rejects.toThrow(CommunityValidationError);
      });

      it('should throw error for name that is too long', async () => {
        // Arrange
        const createRequest: CreateCommunityRequest = {
          name: 'A'.repeat(101),
        };

        // Act & Assert
        await expect(
          communityService.createCommunity(createRequest)
        ).rejects.toThrow(CommunityValidationError);
      });

      it('should throw error for description that is too long', async () => {
        // Arrange
        const createRequest: CreateCommunityRequest = {
          name: 'Valid Name',
          description: 'A'.repeat(1001),
        };

        // Act & Assert
        await expect(
          communityService.createCommunity(createRequest)
        ).rejects.toThrow(CommunityValidationError);
      });

      it('should throw error for invalid locale format', async () => {
        // Arrange
        const createRequest: CreateCommunityRequest = {
          name: 'Valid Name',
          locale: 'invalid-locale-format',
        };

        // Act & Assert
        await expect(
          communityService.createCommunity(createRequest)
        ).rejects.toThrow(CommunityValidationError);
      });

      it('should throw error for invalid slug format', async () => {
        // Arrange
        const createRequest: CreateCommunityRequest = {
          name: 'Valid Name',
          slug: 'Invalid_Slug!',
        };

        // Act & Assert
        await expect(
          communityService.createCommunity(createRequest)
        ).rejects.toThrow(CommunityValidationError);
      });

      it('should throw error for slug starting with hyphen', async () => {
        // Arrange
        const createRequest: CreateCommunityRequest = {
          name: 'Valid Name',
          slug: '-invalid-slug',
        };

        // Act & Assert
        await expect(
          communityService.createCommunity(createRequest)
        ).rejects.toThrow(CommunityValidationError);
      });

      it('should throw error for slug ending with hyphen', async () => {
        // Arrange
        const createRequest: CreateCommunityRequest = {
          name: 'Valid Name',
          slug: 'invalid-slug-',
        };

        // Act & Assert
        await expect(
          communityService.createCommunity(createRequest)
        ).rejects.toThrow(CommunityValidationError);
      });
    });

    describe('cultural protocol validation', () => {
      it('should throw error for missing language preferences', async () => {
        // Arrange
        const invalidProtocols = {
          elderContentRestrictions: true,
          ceremonialContent: true,
          traditionalKnowledge: true,
          communityApprovalRequired: true,
          dataRetentionPolicy: 'indefinite',
          accessRestrictions: ['public'],
        };

        const createRequest: CreateCommunityRequest = {
          name: 'Valid Name',
          culturalSettings: invalidProtocols as any,
        };

        // Act & Assert
        await expect(
          communityService.createCommunity(createRequest)
        ).rejects.toThrow(CommunityValidationError);
      });

      it('should throw error for invalid language code format', async () => {
        // Arrange
        const invalidProtocols: CulturalProtocols = {
          languagePreferences: ['invalid_lang_code'],
          elderContentRestrictions: true,
          ceremonialContent: true,
          traditionalKnowledge: true,
          communityApprovalRequired: true,
          dataRetentionPolicy: 'indefinite',
          accessRestrictions: ['public'],
        };

        const createRequest: CreateCommunityRequest = {
          name: 'Valid Name',
          culturalSettings: invalidProtocols,
        };

        // Act & Assert
        await expect(
          communityService.createCommunity(createRequest)
        ).rejects.toThrow(CommunityValidationError);
      });

      it('should throw error for invalid data retention policy', async () => {
        // Arrange
        const invalidProtocols = {
          languagePreferences: ['en'],
          elderContentRestrictions: true,
          ceremonialContent: true,
          traditionalKnowledge: true,
          communityApprovalRequired: true,
          dataRetentionPolicy: 'invalid-policy',
          accessRestrictions: ['public'],
        };

        const createRequest: CreateCommunityRequest = {
          name: 'Valid Name',
          culturalSettings: invalidProtocols as any,
        };

        // Act & Assert
        await expect(
          communityService.createCommunity(createRequest)
        ).rejects.toThrow(CommunityValidationError);
      });

      it('should throw error for invalid JSON string in cultural settings', async () => {
        // Arrange
        const createRequest: CreateCommunityRequest = {
          name: 'Valid Name',
          culturalSettings: 'invalid-json{',
        };

        // Act & Assert
        await expect(
          communityService.createCommunity(createRequest)
        ).rejects.toThrow(CommunityValidationError);
      });
    });
  });

  describe('getCommunityById', () => {
    it('should get community by ID', async () => {
      // Arrange
      const community = await communityService.createCommunity({
        name: 'Findable Community',
        description: 'A community to find by ID',
      });

      // Act
      const result = await communityService.getCommunityById(community.id);

      // Assert
      expect(result).toBeDefined();
      expect(result!.id).toBe(community.id);
      expect(result!.name).toBe('Findable Community');
    });

    it('should return null for non-existent community', async () => {
      // Act
      const result = await communityService.getCommunityById(99999);

      // Assert
      expect(result).toBeNull();
    });

    it('should parse cultural protocols in response', async () => {
      // Arrange
      const culturalProtocols: CulturalProtocols = {
        languagePreferences: ['en', 'mic'],
        elderContentRestrictions: true,
        ceremonialContent: true,
        traditionalKnowledge: true,
        communityApprovalRequired: true,
        dataRetentionPolicy: 'community-controlled',
        accessRestrictions: ['elder-approval-required'],
      };

      const community = await communityService.createCommunity({
        name: 'Cultural Community',
        culturalSettings: culturalProtocols,
      });

      // Act
      const result = await communityService.getCommunityById(community.id);

      // Assert
      expect(result).toBeDefined();
      expect(result!.culturalProtocols).toBeDefined();
      expect(result!.culturalProtocols!.languagePreferences).toContain('mic');
      expect(result!.culturalProtocols!.elderContentRestrictions).toBe(true);
    });
  });

  describe('getCommunityBySlug', () => {
    it('should get community by slug', async () => {
      // Arrange
      const community = await communityService.createCommunity({
        name: 'Slug Community',
        slug: 'test-slug-community',
      });

      // Act
      const result = await communityService.getCommunityBySlug(community.slug);

      // Assert
      expect(result).toBeDefined();
      expect(result!.slug).toBe(community.slug);
    });

    it('should return null for non-existent slug', async () => {
      // Act
      const result =
        await communityService.getCommunityBySlug('non-existent-slug');

      // Assert
      expect(result).toBeNull();
    });

    it('should return null for empty slug', async () => {
      // Act
      const result = await communityService.getCommunityBySlug('');

      // Assert
      expect(result).toBeNull();
    });
  });

  describe('searchCommunities', () => {
    beforeEach(async () => {
      // Create test communities
      await communityService.createCommunity({
        name: 'Indigenous Heritage Community',
        description: 'Preserving traditional knowledge',
        locale: 'en',
        isActive: true,
      });

      await communityService.createCommunity({
        name: 'Inuit Arctic Community',
        description: 'Stories from the Arctic',
        locale: 'iu',
        isActive: true,
      });

      await communityService.createCommunity({
        name: 'Inactive Community',
        description: 'Not active',
        locale: 'en',
        isActive: false,
      });
    });

    it('should search communities with default parameters', async () => {
      // Act
      const result = await communityService.searchCommunities();

      // Assert
      expect(result).toBeDefined();
      expect(result.communities.length).toBeGreaterThanOrEqual(3);
      expect(result.total).toBeGreaterThanOrEqual(3);
      expect(result.limit).toBe(20);
      expect(result.offset).toBe(0);
    });

    it('should search communities with query parameter', async () => {
      // Act
      const result = await communityService.searchCommunities({
        query: 'Indigenous',
      });

      // Assert
      expect(result.communities).toHaveLength(1);
      expect(result.communities[0].name).toBe('Indigenous Heritage Community');
    });

    it('should filter communities by locale', async () => {
      // Act
      const result = await communityService.searchCommunities({ locale: 'iu' });

      // Assert
      expect(result.communities).toHaveLength(1);
      expect(result.communities[0].locale).toBe('iu');
    });

    it('should filter communities by active status', async () => {
      // Act
      const result = await communityService.searchCommunities({
        isActive: false,
      });

      // Assert
      expect(result.communities).toHaveLength(1);
      expect(result.communities[0].isActive).toBe(false);
    });

    it('should throw error for invalid limit', async () => {
      // Act & Assert
      await expect(
        communityService.searchCommunities({ limit: 101 })
      ).rejects.toThrow(CommunityValidationError);
    });

    it('should throw error for negative offset', async () => {
      // Act & Assert
      await expect(
        communityService.searchCommunities({ offset: -1 })
      ).rejects.toThrow(CommunityValidationError);
    });
  });

  describe('getActiveCommunities', () => {
    beforeEach(async () => {
      await communityService.createCommunity({
        name: 'Active Community 1',
        isActive: true,
      });

      await communityService.createCommunity({
        name: 'Active Community 2',
        isActive: true,
      });

      await communityService.createCommunity({
        name: 'Inactive Community',
        isActive: false,
      });
    });

    it('should return only active communities', async () => {
      // Act
      const result = await communityService.getActiveCommunities();

      // Assert
      expect(result.communities.length).toBeGreaterThanOrEqual(2);
      result.communities.forEach((community) => {
        expect(community.isActive).toBe(true);
      });
    });
  });

  describe('updateCommunity', () => {
    it('should update community fields', async () => {
      // Arrange
      const community = await communityService.createCommunity({
        name: 'Original Name',
        description: 'Original description',
      });

      const updates: UpdateCommunityRequest = {
        name: 'Updated Name',
        description: 'Updated description',
        publicStories: true,
        locale: 'fr',
      };

      // Act
      const result = await communityService.updateCommunity(
        community.id,
        updates
      );

      // Assert
      expect(result.name).toBe('Updated Name');
      expect(result.description).toBe('Updated description');
      expect(result.publicStories).toBe(true);
      expect(result.locale).toBe('fr');
    });

    it('should update cultural protocols', async () => {
      // Arrange
      const community = await communityService.createCommunity({
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

      const updates: UpdateCommunityRequest = {
        culturalSettings: culturalProtocols,
      };

      // Act
      const result = await communityService.updateCommunity(
        community.id,
        updates
      );

      // Assert
      expect(result.culturalSettings).toBeDefined();
      const parsed = JSON.parse(result.culturalSettings!);
      expect(parsed.languagePreferences).toContain('mic');
      expect(parsed.elderContentRestrictions).toBe(true);
    });

    it('should throw error for invalid community ID', async () => {
      // Act & Assert
      await expect(
        communityService.updateCommunity(-1, { name: 'Test' })
      ).rejects.toThrow(CommunityValidationError);
    });

    it('should throw error for non-existent community', async () => {
      // Act & Assert
      await expect(
        communityService.updateCommunity(99999, { name: 'Test' })
      ).rejects.toThrow(CommunityOperationError);
    });

    it('should validate update data', async () => {
      // Arrange
      const community = await communityService.createCommunity({
        name: 'Test Community',
      });

      // Act & Assert
      await expect(
        communityService.updateCommunity(community.id, { name: '' })
      ).rejects.toThrow(CommunityValidationError);
    });
  });

  describe('deleteCommunity', () => {
    it('should delete community successfully', async () => {
      // Arrange
      const community = await communityService.createCommunity({
        name: 'Deletable Community',
      });

      // Act
      const result = await communityService.deleteCommunity(community.id);

      // Assert
      expect(result).toBe(true);
    });

    it('should return false for non-existent community', async () => {
      // Act
      const result = await communityService.deleteCommunity(99999);

      // Assert
      expect(result).toBe(false);
    });

    it('should throw error for invalid ID', async () => {
      // Act & Assert
      await expect(communityService.deleteCommunity(-1)).rejects.toThrow(
        CommunityValidationError
      );
    });
  });

  describe('deactivateCommunity', () => {
    it('should deactivate community', async () => {
      // Arrange
      const community = await communityService.createCommunity({
        name: 'Active Community',
        isActive: true,
      });

      // Act
      const result = await communityService.deactivateCommunity(community.id);

      // Assert
      expect(result).toBe(true);
    });

    it('should throw error for invalid ID', async () => {
      // Act & Assert
      await expect(communityService.deactivateCommunity(0)).rejects.toThrow(
        CommunityValidationError
      );
    });
  });

  describe('reactivateCommunity', () => {
    it('should reactivate community', async () => {
      // Arrange
      const community = await communityService.createCommunity({
        name: 'Inactive Community',
        isActive: false,
      });

      // Act
      const result = await communityService.reactivateCommunity(community.id);

      // Assert
      expect(result).toBe(true);
    });
  });

  describe('isSlugAvailable', () => {
    beforeEach(async () => {
      await communityService.createCommunity({
        name: 'Existing Community',
        slug: 'existing-slug',
      });
    });

    it('should return false for existing slug', async () => {
      // Act
      const result = await communityService.isSlugAvailable('existing-slug');

      // Assert
      expect(result).toBe(false);
    });

    it('should return true for available slug', async () => {
      // Act
      const result = await communityService.isSlugAvailable('available-slug');

      // Assert
      expect(result).toBe(true);
    });

    it('should return false for invalid slug format', async () => {
      // Act
      const result = await communityService.isSlugAvailable('invalid_slug!');

      // Assert
      expect(result).toBe(false);
    });

    it('should return false for empty slug', async () => {
      // Act
      const result = await communityService.isSlugAvailable('');

      // Assert
      expect(result).toBe(false);
    });

    it('should return false for slug that is too short', async () => {
      // Act
      const result = await communityService.isSlugAvailable('ab');

      // Assert
      expect(result).toBe(false);
    });
  });

  describe('getCommunityCount', () => {
    beforeEach(async () => {
      await communityService.createCommunity({
        name: 'Active Community 1',
        isActive: true,
      });

      await communityService.createCommunity({
        name: 'Active Community 2',
        isActive: true,
      });

      await communityService.createCommunity({
        name: 'Inactive Community',
        isActive: false,
      });
    });

    it('should count all communities', async () => {
      // Act
      const result = await communityService.getCommunityCount();

      // Assert
      expect(result).toBeGreaterThanOrEqual(3);
    });

    it('should count active communities', async () => {
      // Act
      const result = await communityService.getCommunityCount(true);

      // Assert
      expect(result).toBeGreaterThanOrEqual(2);
    });

    it('should count inactive communities', async () => {
      // Act
      const result = await communityService.getCommunityCount(false);

      // Assert
      expect(result).toBeGreaterThanOrEqual(1);
    });
  });

  describe('updateCulturalProtocols', () => {
    it('should update cultural protocols specifically', async () => {
      // Arrange
      const community = await communityService.createCommunity({
        name: 'Cultural Community',
      });

      const protocols: CulturalProtocols = {
        languagePreferences: ['en', 'mic'],
        elderContentRestrictions: true,
        ceremonialContent: true,
        traditionalKnowledge: true,
        communityApprovalRequired: true,
        dataRetentionPolicy: 'community-controlled',
        accessRestrictions: ['elder-approval-required'],
        culturalNotes: "Traditional Mi'kmaq protocols",
      };

      // Act
      const result = await communityService.updateCulturalProtocols(
        community.id,
        protocols
      );

      // Assert
      expect(result.culturalSettings).toBeDefined();
      const parsed = JSON.parse(result.culturalSettings!);
      expect(parsed.culturalNotes).toBe("Traditional Mi'kmaq protocols");
      expect(parsed.languagePreferences).toContain('mic');
    });
  });

  describe('getCulturalProtocols', () => {
    it('should get cultural protocols for community', async () => {
      // Arrange
      const culturalProtocols: CulturalProtocols = {
        languagePreferences: ['en', 'mic'],
        elderContentRestrictions: true,
        ceremonialContent: true,
        traditionalKnowledge: true,
        communityApprovalRequired: true,
        dataRetentionPolicy: 'community-controlled',
        accessRestrictions: ['elder-approval-required'],
      };

      const community = await communityService.createCommunity({
        name: 'Cultural Community',
        culturalSettings: culturalProtocols,
      });

      // Act
      const result = await communityService.getCulturalProtocols(community.id);

      // Assert
      expect(result).toBeDefined();
      expect(result!.languagePreferences).toContain('mic');
      expect(result!.elderContentRestrictions).toBe(true);
    });

    it('should return null for community without cultural settings', async () => {
      // Arrange
      const community = await communityService.createCommunity({
        name: 'Basic Community',
      });

      // Act
      const result = await communityService.getCulturalProtocols(community.id);

      // Assert
      expect(result).toBeNull();
    });

    it('should return null for non-existent community', async () => {
      // Act
      const result = await communityService.getCulturalProtocols(99999);

      // Assert
      expect(result).toBeNull();
    });
  });
});
