/**
 * Speaker Service Tests
 *
 * Tests the SpeakerService class with:
 * - Complete CRUD operations with business logic
 * - Cultural protocol enforcement
 * - Elder status recognition and permission validation
 * - Community data sovereignty enforcement
 * - Integration with repository layer
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SpeakerService } from '../../src/services/speaker.service.js';
import { SpeakerRepository } from '../../src/repositories/speaker.repository.js';
import type { Speaker } from '../../src/db/schema/speakers.js';

// Mock the repository
vi.mock('../../src/repositories/speaker.repository.js');

describe('SpeakerService', () => {
  let service: SpeakerService;
  let mockRepository: SpeakerRepository;

  const testCommunityId = 1;
  const testUserId = 1;
  const mockSpeaker: Speaker = {
    id: 1,
    name: 'Maria Santos',
    bio: 'Traditional storyteller and knowledge keeper',
    communityId: testCommunityId,
    photoUrl: 'https://example.com/maria.jpg',
    birthYear: 1965,
    elderStatus: true,
    culturalRole: 'Traditional Knowledge Keeper',
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    mockRepository = new SpeakerRepository({} as any);
    service = new SpeakerService(mockRepository);
    vi.clearAllMocks();
  });

  describe('createSpeaker()', () => {
    it('should create a speaker with valid data', async () => {
      const createData = {
        name: 'Maria Santos',
        bio: 'Traditional storyteller',
        photoUrl: 'https://example.com/maria.jpg',
        birthYear: 1965,
        elderStatus: true,
        culturalRole: 'Traditional Knowledge Keeper',
      };

      vi.mocked(mockRepository.create).mockResolvedValue(mockSpeaker);

      const result = await service.createSpeaker(
        createData,
        testCommunityId,
        testUserId,
        'admin'
      );

      expect(result).toEqual(mockSpeaker);
      expect(mockRepository.create).toHaveBeenCalledWith({
        ...createData,
        communityId: testCommunityId,
      });
    });

    it('should validate required fields', async () => {
      await expect(
        service.createSpeaker(
          { name: '' } as any,
          testCommunityId,
          testUserId,
          'admin'
        )
      ).rejects.toThrow('name is required');
    });

    it('should validate name length', async () => {
      const longName = 'a'.repeat(201); // Exceeds 200 char limit
      await expect(
        service.createSpeaker(
          { name: longName },
          testCommunityId,
          testUserId,
          'admin'
        )
      ).rejects.toThrow('cannot exceed');
    });

    it('should validate bio length', async () => {
      const longBio = 'a'.repeat(2001); // Exceeds 2000 char limit
      await expect(
        service.createSpeaker(
          {
            name: 'Valid Name',
            bio: longBio,
          },
          testCommunityId,
          testUserId,
          'admin'
        )
      ).rejects.toThrow('cannot exceed');
    });

    it('should validate photo URL format', async () => {
      await expect(
        service.createSpeaker(
          {
            name: 'Valid Name',
            photoUrl: 'not-a-url',
          },
          testCommunityId,
          testUserId,
          'admin'
        )
      ).rejects.toThrow('Invalid media URL: not-a-url');
    });

    it('should validate birth year range', async () => {
      await expect(
        service.createSpeaker(
          {
            name: 'Valid Name',
            birthYear: 1800, // Too early
          },
          testCommunityId,
          testUserId,
          'admin'
        )
      ).rejects.toThrow('Birth year too early');

      await expect(
        service.createSpeaker(
          {
            name: 'Valid Name',
            birthYear: new Date().getFullYear() + 1, // Future
          },
          testCommunityId,
          testUserId,
          'admin'
        )
      ).rejects.toThrow('Birth year cannot be in the future');
    });

    it('should validate cultural role length', async () => {
      const longRole = 'a'.repeat(101); // Exceeds 100 char limit
      await expect(
        service.createSpeaker(
          {
            name: 'Valid Name',
            culturalRole: longRole,
          },
          testCommunityId,
          testUserId,
          'admin'
        )
      ).rejects.toThrow('cannot exceed');
    });

    it('should enforce elder creation permissions', async () => {
      const elderData = {
        name: 'Elder Speaker',
        elderStatus: true,
        culturalRole: 'Elder Council',
      };

      // Viewer role should not be able to create elders
      await expect(
        service.createSpeaker(elderData, testCommunityId, testUserId, 'viewer')
      ).rejects.toThrow('Viewers cannot create speakers');

      // Editor role should not be able to create elders
      await expect(
        service.createSpeaker(elderData, testCommunityId, testUserId, 'editor')
      ).rejects.toThrow('Only admins can create elder speakers');

      // Admin should be able to create elders
      vi.mocked(mockRepository.create).mockResolvedValue({
        ...mockSpeaker,
        elderStatus: true,
      });

      await expect(
        service.createSpeaker(elderData, testCommunityId, testUserId, 'admin')
      ).resolves.toBeDefined();
    });

    it('should create elder speakers with proper validation', async () => {
      const elderData = {
        name: 'Elder Speaker',
        elderStatus: true,
        culturalRole: 'Elder Council',
      };

      const expectedSpeaker = {
        ...mockSpeaker,
        elderStatus: true,
        culturalRole: 'Elder Council',
      };

      vi.mocked(mockRepository.create).mockResolvedValue(expectedSpeaker);

      const result = await service.createSpeaker(
        elderData,
        testCommunityId,
        testUserId,
        'admin'
      );

      expect(result).toEqual(expectedSpeaker);
      expect(mockRepository.create).toHaveBeenCalledWith({
        ...elderData,
        communityId: testCommunityId,
      });
    });
  });

  describe('getSpeakerById()', () => {
    it('should return speaker when found and community matches', async () => {
      vi.mocked(mockRepository.getByIdWithCommunityCheck).mockResolvedValue(
        mockSpeaker
      );

      const result = await service.getSpeakerById(1, testCommunityId);

      expect(result).toEqual(mockSpeaker);
      expect(mockRepository.getByIdWithCommunityCheck).toHaveBeenCalledWith(
        1,
        testCommunityId
      );
    });

    it('should throw error when speaker not found', async () => {
      vi.mocked(mockRepository.getByIdWithCommunityCheck).mockResolvedValue(
        null
      );

      await expect(service.getSpeakerById(1, testCommunityId)).rejects.toThrow(
        'Speaker not found'
      );
    });

    it('should enforce community isolation', async () => {
      const otherCommunitySpeaker = { ...mockSpeaker, communityId: 2 };
      vi.mocked(mockRepository.getById).mockResolvedValue(
        otherCommunitySpeaker
      );
      vi.mocked(mockRepository.getByIdWithCommunityCheck).mockResolvedValue(
        null
      );

      await expect(service.getSpeakerById(1, testCommunityId)).rejects.toThrow(
        'Speaker not found'
      );
    });
  });

  describe('getSpeakersByCommunity()', () => {
    it('should return paginated speakers for community', async () => {
      const mockResponse = {
        data: [mockSpeaker],
        total: 1,
        page: 1,
        limit: 10,
        pages: 1,
      };

      vi.mocked(mockRepository.getByCommunity).mockResolvedValue(mockResponse);

      const result = await service.getSpeakersByCommunity(
        testCommunityId,
        { page: 1, limit: 10 },
        testUserId,
        'viewer'
      );

      expect(result).toEqual(mockResponse);
      expect(mockRepository.getByCommunity).toHaveBeenCalledWith(
        testCommunityId,
        expect.objectContaining({ page: 1, limit: 10 })
      );
    });

    it('should filter out inactive speakers for non-admin users', async () => {
      const params = { page: 1, limit: 10, activeOnly: undefined };

      await service.getSpeakersByCommunity(
        testCommunityId,
        params,
        testUserId,
        'viewer'
      );

      expect(mockRepository.getByCommunity).toHaveBeenCalledWith(
        testCommunityId,
        expect.objectContaining({ activeOnly: true })
      );
    });

    it('should allow admins to see inactive speakers', async () => {
      const params = { page: 1, limit: 10, activeOnly: false };

      await service.getSpeakersByCommunity(
        testCommunityId,
        params,
        testUserId,
        'admin'
      );

      expect(mockRepository.getByCommunity).toHaveBeenCalledWith(
        testCommunityId,
        expect.objectContaining({ activeOnly: false })
      );
    });

    it('should validate pagination parameters', async () => {
      await expect(
        service.getSpeakersByCommunity(
          testCommunityId,
          { page: 0, limit: 10 }, // Invalid page
          testUserId,
          'viewer'
        )
      ).rejects.toThrow('Page must be >= 1 and limit must be between 1-100');

      await expect(
        service.getSpeakersByCommunity(
          testCommunityId,
          { page: 1, limit: 0 }, // Invalid limit
          testUserId,
          'viewer'
        )
      ).rejects.toThrow('Page must be >= 1 and limit must be between 1-100');

      await expect(
        service.getSpeakersByCommunity(
          testCommunityId,
          { page: 1, limit: 101 }, // Too large limit
          testUserId,
          'viewer'
        )
      ).rejects.toThrow('Page must be >= 1 and limit must be between 1-100');
    });
  });

  describe('updateSpeaker()', () => {
    it('should update speaker with valid data', async () => {
      const updateData = {
        name: 'Updated Name',
        bio: 'Updated bio',
        culturalRole: 'Updated Role',
      };

      const updatedSpeaker = { ...mockSpeaker, ...updateData };
      vi.mocked(mockRepository.getByIdWithCommunityCheck).mockResolvedValue(
        mockSpeaker
      );
      vi.mocked(mockRepository.update).mockResolvedValue(updatedSpeaker);

      const result = await service.updateSpeaker(
        1,
        updateData,
        testCommunityId,
        testUserId,
        'admin'
      );

      expect(result).toEqual(updatedSpeaker);
      expect(mockRepository.update).toHaveBeenCalledWith(1, updateData);
    });

    it('should throw error when speaker not found', async () => {
      vi.mocked(mockRepository.getByIdWithCommunityCheck).mockResolvedValue(
        null
      );

      await expect(
        service.updateSpeaker(
          1,
          { name: 'New Name' },
          testCommunityId,
          testUserId,
          'admin'
        )
      ).rejects.toThrow('Speaker not found');
    });

    it('should enforce elder update permissions', async () => {
      const elderSpeaker = { ...mockSpeaker, elderStatus: true };
      vi.mocked(mockRepository.getByIdWithCommunityCheck).mockResolvedValue(
        elderSpeaker
      );

      // Viewer should not be able to update elders
      await expect(
        service.updateSpeaker(
          1,
          { name: 'New Name' },
          testCommunityId,
          testUserId,
          'viewer'
        )
      ).rejects.toThrow('Only admins can update elder speakers');

      // Editor should not be able to update elders
      await expect(
        service.updateSpeaker(
          1,
          { name: 'New Name' },
          testCommunityId,
          testUserId,
          'editor'
        )
      ).rejects.toThrow('Only admins can update elder speakers');
    });

    it('should prevent elder status changes by non-admins', async () => {
      const regularSpeaker = { ...mockSpeaker, elderStatus: false };
      vi.mocked(mockRepository.getByIdWithCommunityCheck).mockResolvedValue(
        regularSpeaker
      );

      await expect(
        service.updateSpeaker(
          1,
          { elderStatus: true },
          testCommunityId,
          testUserId,
          'editor'
        )
      ).rejects.toThrow('Insufficient permissions to modify elder status');
    });

    it('should validate update data', async () => {
      vi.mocked(mockRepository.getByIdWithCommunityCheck).mockResolvedValue(
        mockSpeaker
      );

      await expect(
        service.updateSpeaker(
          1,
          { name: '' },
          testCommunityId,
          testUserId,
          'admin'
        )
      ).rejects.toThrow('name is required');

      await expect(
        service.updateSpeaker(
          1,
          { photoUrl: 'not-a-url' },
          testCommunityId,
          testUserId,
          'admin'
        )
      ).rejects.toThrow('Invalid media URL: not-a-url');
    });

    it('should update elder speakers with proper validation', async () => {
      const elderSpeaker = { ...mockSpeaker, elderStatus: true };
      const updateData = { name: 'Updated Elder' };
      const updatedSpeaker = { ...elderSpeaker, ...updateData };

      vi.mocked(mockRepository.getByIdWithCommunityCheck).mockResolvedValue(
        elderSpeaker
      );
      vi.mocked(mockRepository.update).mockResolvedValue(updatedSpeaker);

      const result = await service.updateSpeaker(
        1,
        updateData,
        testCommunityId,
        testUserId,
        'admin'
      );

      expect(result).toEqual(updatedSpeaker);
      expect(mockRepository.update).toHaveBeenCalledWith(1, updateData);
    });
  });

  describe('deleteSpeaker()', () => {
    it('should delete speaker when user has permission', async () => {
      const regularSpeaker = { ...mockSpeaker, elderStatus: false };
      vi.mocked(mockRepository.getByIdWithCommunityCheck).mockResolvedValue(
        regularSpeaker
      );
      vi.mocked(mockRepository.delete).mockResolvedValue(true);

      const result = await service.deleteSpeaker(
        1,
        testCommunityId,
        testUserId,
        'admin'
      );

      expect(result).toBe(true);
      expect(mockRepository.delete).toHaveBeenCalledWith(1);
    });

    it('should throw error when speaker not found', async () => {
      vi.mocked(mockRepository.getByIdWithCommunityCheck).mockResolvedValue(
        null
      );

      await expect(
        service.deleteSpeaker(1, testCommunityId, testUserId, 'admin')
      ).rejects.toThrow('Speaker not found');
    });

    it('should enforce deletion permissions', async () => {
      const regularSpeaker = { ...mockSpeaker, elderStatus: false };
      vi.mocked(mockRepository.getByIdWithCommunityCheck).mockResolvedValue(
        regularSpeaker
      );

      // Only admins can delete speakers
      await expect(
        service.deleteSpeaker(1, testCommunityId, testUserId, 'viewer')
      ).rejects.toThrow('Only admins can delete speakers');

      await expect(
        service.deleteSpeaker(1, testCommunityId, testUserId, 'editor')
      ).rejects.toThrow('Only admins can delete speakers');
    });

    it('should enforce enhanced elder deletion permissions', async () => {
      const elderSpeaker = { ...mockSpeaker, elderStatus: true };
      vi.mocked(mockRepository.getByIdWithCommunityCheck).mockResolvedValue(
        elderSpeaker
      );

      await expect(
        service.deleteSpeaker(1, testCommunityId, testUserId, 'admin')
      ).rejects.toThrow('Elder speakers require special authorization');
    });

    it('should delete regular speakers successfully', async () => {
      const regularSpeaker = { ...mockSpeaker, elderStatus: false };
      vi.mocked(mockRepository.getByIdWithCommunityCheck).mockResolvedValue(
        regularSpeaker
      );
      vi.mocked(mockRepository.delete).mockResolvedValue(true);

      const result = await service.deleteSpeaker(
        1,
        testCommunityId,
        testUserId,
        'admin'
      );

      expect(result).toBe(true);
      expect(mockRepository.delete).toHaveBeenCalledWith(1);
    });
  });

  describe('searchSpeakers()', () => {
    it('should search speakers by name', async () => {
      const mockResponse = {
        data: [mockSpeaker],
        total: 1,
        page: 1,
        limit: 10,
        pages: 1,
      };

      vi.mocked(mockRepository.searchByName).mockResolvedValue(mockResponse);

      const result = await service.searchSpeakers(
        testCommunityId,
        'Maria',
        { page: 1, limit: 10 },
        testUserId,
        'viewer'
      );

      expect(result).toEqual(mockResponse);
      expect(mockRepository.searchByName).toHaveBeenCalledWith(
        testCommunityId,
        'Maria',
        { page: 1, limit: 10 }
      );
    });

    it('should validate search query', async () => {
      await expect(
        service.searchSpeakers(
          testCommunityId,
          '', // Empty query
          { page: 1, limit: 10 },
          testUserId,
          'viewer'
        )
      ).rejects.toThrow('query is required');

      await expect(
        service.searchSpeakers(
          testCommunityId,
          'a', // Too short
          { page: 1, limit: 10 },
          testUserId,
          'viewer'
        )
      ).rejects.toThrow('Search query must be at least 2 characters long');
    });
  });

  describe('getCommunityStats()', () => {
    it('should return community speaker statistics', async () => {
      const mockStats = {
        total: 10,
        active: 8,
        inactive: 2,
        elders: 3,
        nonElders: 7,
      };

      vi.mocked(mockRepository.getCommunityStats).mockResolvedValue(mockStats);

      const result = await service.getCommunityStats(testCommunityId);

      expect(result).toEqual(mockStats);
      expect(mockRepository.getCommunityStats).toHaveBeenCalledWith(
        testCommunityId
      );
    });
  });
});
