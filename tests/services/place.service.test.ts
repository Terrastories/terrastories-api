/**
 * Place Service Tests
 *
 * Tests the PlaceService class with:
 * - Complete CRUD operations with business logic
 * - Cultural protocol enforcement
 * - Elder access controls
 * - Geographic search operations
 * - Integration with repository layer
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PlaceService } from '../../src/services/place.service.js';
import { PlaceRepository } from '../../src/repositories/place.repository.js';
import type { Place } from '../../src/db/schema/places.js';
// Types imported but may be used in test implementations

// Mock the repository
vi.mock('../../src/repositories/place.repository.js');

describe('PlaceService', () => {
  let service: PlaceService;
  let mockRepository: PlaceRepository;

  const testCommunityId = 1;
  const testUserId = 1;
  const mockPlace: Place = {
    id: 1,
    name: 'Test Place',
    description: 'A test place',
    communityId: testCommunityId,
    latitude: 37.7749,
    longitude: -122.4194,
    region: 'North Region',
    mediaUrls: [],
    culturalSignificance: null,
    isRestricted: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    mockRepository = new PlaceRepository({} as any);
    service = new PlaceService(mockRepository);
    vi.clearAllMocks();
  });

  describe('createPlace()', () => {
    it('should create a place with valid data', async () => {
      const createData = {
        name: 'Sacred Mountain',
        description: 'Traditional gathering place',
        latitude: 37.7749,
        longitude: -122.4194,
        culturalSignificance: 'Sacred ceremonial site',
      };

      vi.spyOn(mockRepository, 'create').mockResolvedValue(mockPlace);

      const result = await service.createPlace(
        createData,
        testCommunityId,
        testUserId
      );

      expect(result).toBeDefined();
      expect(mockRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Sacred Mountain',
          description: 'Traditional gathering place',
          latitude: 37.7749,
          longitude: -122.4194,
          culturalSignificance: 'Sacred ceremonial site',
          communityId: testCommunityId,
          mediaUrls: [],
          isRestricted: false,
        })
      );
    });

    it('should validate coordinates', async () => {
      const invalidData = {
        name: 'Invalid Place',
        latitude: 91, // Invalid
        longitude: -122.4194,
      };

      await expect(
        service.createPlace(invalidData, testCommunityId, testUserId)
      ).rejects.toThrow(
        'Invalid coordinates (91, -122.4194). Latitude must be between -90 and 90, longitude between -180 and 180.'
      );
    });

    it('should handle cultural significance settings', async () => {
      const sacredData = {
        name: 'Sacred Site',
        latitude: 37.7749,
        longitude: -122.4194,
        culturalSignificance: 'Sacred ceremonial ground',
        isRestricted: true,
      };

      vi.spyOn(mockRepository, 'create').mockResolvedValue({
        ...mockPlace,
        isRestricted: true,
        culturalSignificance: 'Sacred ceremonial ground',
      });

      const result = await service.createPlace(
        sacredData,
        testCommunityId,
        testUserId
      );

      expect(result.isRestricted).toBe(true);
      expect(result.culturalSignificance).toBe('Sacred ceremonial ground');
    });
  });

  describe('getPlaceById()', () => {
    it('should return place for valid ID', async () => {
      vi.spyOn(mockRepository, 'getByIdWithCommunityCheck').mockResolvedValue(
        mockPlace
      );

      const result = await service.getPlaceById(1, testCommunityId);

      expect(result).toEqual(mockPlace);
      expect(mockRepository.getByIdWithCommunityCheck).toHaveBeenCalledWith(
        1,
        testCommunityId
      );
    });

    it('should throw error for non-existent place', async () => {
      vi.spyOn(mockRepository, 'getByIdWithCommunityCheck').mockResolvedValue(
        null
      );

      await expect(
        service.getPlaceById(99999, testCommunityId)
      ).rejects.toThrow('Place with ID 99999 not found');
    });
  });

  describe('getPlacesByCommunity()', () => {
    it('should return paginated places', async () => {
      const mockResponse = {
        data: [mockPlace],
        total: 1,
        page: 1,
        limit: 10,
        pages: 1,
      };

      vi.spyOn(mockRepository, 'getByCommunity').mockResolvedValue(
        mockResponse
      );

      const result = await service.getPlacesByCommunity(testCommunityId, {
        page: 1,
        limit: 10,
      });

      expect(result).toEqual(mockResponse);
      expect(mockRepository.getByCommunity).toHaveBeenCalledWith(
        testCommunityId,
        {
          page: 1,
          limit: 10,
          includeRestricted: false,
        }
      );
    });

    it('should exclude restricted places for elders (SPEC-V2 §6.4)', async () => {
      const mockResponse = {
        data: [mockPlace],
        total: 1,
        page: 1,
        limit: 10,
        pages: 1,
      };

      vi.spyOn(mockRepository, 'getByCommunity').mockResolvedValue(
        mockResponse
      );

      await service.getPlacesByCommunity(
        testCommunityId,
        { page: 1, limit: 10 },
        'elder'
      );

      // A restricted place is unavailable to every role, elder included.
      expect(mockRepository.getByCommunity).toHaveBeenCalledWith(
        testCommunityId,
        {
          page: 1,
          limit: 10,
          includeRestricted: false,
        }
      );
    });
  });

  describe('updatePlace()', () => {
    it('should update place with valid data', async () => {
      const updateData = {
        name: 'Updated Place',
        description: 'Updated description',
      };

      const updatedPlace = { ...mockPlace, ...updateData };
      vi.spyOn(mockRepository, 'getByIdWithCommunityCheck').mockResolvedValue(
        mockPlace
      );
      vi.spyOn(mockRepository, 'update').mockResolvedValue(updatedPlace);

      const result = await service.updatePlace(
        1,
        updateData,
        testCommunityId,
        testUserId
      );

      expect(result).toEqual(updatedPlace);
      expect(mockRepository.update).toHaveBeenCalledWith(1, updateData);
    });

    it('should return 404 semantics when a viewer updates a restricted place', async () => {
      const restrictedPlace = { ...mockPlace, isRestricted: true };
      vi.spyOn(mockRepository, 'getByIdWithCommunityCheck').mockResolvedValue(
        restrictedPlace
      );

      // A restricted place is unavailable to every role: the update masks
      // as nonexistent instead of revealing the restriction (SPEC-V2 §6.4).
      await expect(
        service.updatePlace(
          1,
          { name: 'New Name' },
          testCommunityId,
          testUserId,
          'viewer'
        )
      ).rejects.toThrow('Place with ID 1 not found');
    });

    it('should return 404 semantics when an elder updates a restricted place', async () => {
      const restrictedPlace = { ...mockPlace, isRestricted: true };
      vi.spyOn(mockRepository, 'getByIdWithCommunityCheck').mockResolvedValue(
        restrictedPlace
      );

      await expect(
        service.updatePlace(
          1,
          { name: 'Elder Updated' },
          testCommunityId,
          testUserId,
          'elder'
        )
      ).rejects.toThrow('Place with ID 1 not found');
    });

    it('should return 404 semantics when an admin updates a restricted place', async () => {
      const restrictedPlace = { ...mockPlace, isRestricted: true };
      vi.spyOn(mockRepository, 'getByIdWithCommunityCheck').mockResolvedValue(
        restrictedPlace
      );

      await expect(
        service.updatePlace(
          1,
          { name: 'Admin Updated' },
          testCommunityId,
          testUserId,
          'admin'
        )
      ).rejects.toThrow('Place with ID 1 not found');
      expect(mockRepository.update).not.toHaveBeenCalled();
    });
  });

  describe('deletePlace()', () => {
    it('should delete place with proper authorization', async () => {
      vi.spyOn(mockRepository, 'getByIdWithCommunityCheck').mockResolvedValue(
        mockPlace
      );
      vi.spyOn(mockRepository, 'delete').mockResolvedValue(true);

      const result = await service.deletePlace(
        1,
        testCommunityId,
        testUserId,
        'admin'
      );

      expect(result).toBe(true);
      expect(mockRepository.delete).toHaveBeenCalledWith(1);
    });

    it('should prevent non-admin from deleting places', async () => {
      vi.spyOn(mockRepository, 'getByIdWithCommunityCheck').mockResolvedValue(
        mockPlace
      );

      await expect(
        service.deletePlace(1, testCommunityId, testUserId, 'viewer')
      ).rejects.toThrow('Only administrators and elders can delete places');
    });

    it('should handle story-place association cleanup', async () => {
      // Mock place with story associations
      vi.spyOn(mockRepository, 'getByIdWithCommunityCheck').mockResolvedValue(
        mockPlace
      );
      vi.spyOn(mockRepository, 'delete').mockResolvedValue(true);

      const result = await service.deletePlace(
        1,
        testCommunityId,
        testUserId,
        'admin'
      );

      expect(result).toBe(true);
      // Should verify story associations are handled in repository
    });

    it('should return 404 semantics when an admin deletes a restricted place', async () => {
      const restrictedPlace = { ...mockPlace, isRestricted: true };
      vi.spyOn(mockRepository, 'getByIdWithCommunityCheck').mockResolvedValue(
        restrictedPlace
      );

      await expect(
        service.deletePlace(1, testCommunityId, testUserId, 'admin')
      ).rejects.toThrow('Place with ID 1 not found');
      expect(mockRepository.delete).not.toHaveBeenCalled();
    });

    it('should return 404 semantics when an elder deletes a restricted place', async () => {
      const restrictedPlace = { ...mockPlace, isRestricted: true };
      vi.spyOn(mockRepository, 'getByIdWithCommunityCheck').mockResolvedValue(
        restrictedPlace
      );

      await expect(
        service.deletePlace(1, testCommunityId, testUserId, 'elder')
      ).rejects.toThrow('Place with ID 1 not found');
      expect(mockRepository.delete).not.toHaveBeenCalled();
    });
  });

  describe('searchPlacesNear()', () => {
    it('should search places within radius', async () => {
      const mockResponse = {
        data: [mockPlace],
        total: 1,
        page: 1,
        limit: 10,
        pages: 1,
      };

      vi.spyOn(mockRepository, 'searchNear').mockResolvedValue(mockResponse);

      const result = await service.searchPlacesNear({
        communityId: testCommunityId,
        latitude: 37.7749,
        longitude: -122.4194,
        radiusKm: 5,
        page: 1,
        limit: 10,
      });

      expect(result).toEqual(mockResponse);
      expect(mockRepository.searchNear).toHaveBeenCalledWith({
        communityId: testCommunityId,
        latitude: 37.7749,
        longitude: -122.4194,
        radiusKm: 5,
        page: 1,
        limit: 10,
        includeRestricted: false,
      });
    });

    it('should validate search coordinates', async () => {
      await expect(
        service.searchPlacesNear({
          communityId: testCommunityId,
          latitude: 91, // Invalid
          longitude: -122.4194,
          radiusKm: 5,
          page: 1,
          limit: 10,
        })
      ).rejects.toThrow(
        'Invalid coordinates (91, -122.4194). Latitude must be between -90 and 90, longitude between -180 and 180.'
      );
    });
  });

  describe('getPlacesByBounds()', () => {
    it('should search places within bounding box', async () => {
      const mockResponse = {
        data: [mockPlace],
        total: 1,
        page: 1,
        limit: 10,
        pages: 1,
      };

      vi.spyOn(mockRepository, 'searchInBounds').mockResolvedValue(
        mockResponse
      );

      const result = await service.getPlacesByBounds({
        communityId: testCommunityId,
        north: 37.8,
        south: 37.7,
        east: -122.4,
        west: -122.5,
        page: 1,
        limit: 10,
      });

      expect(result).toEqual(mockResponse);
    });

    it('should validate bounding box coordinates', async () => {
      await expect(
        service.getPlacesByBounds({
          communityId: testCommunityId,
          north: 37.7, // North should be > South
          south: 37.8,
          east: -122.4,
          west: -122.5,
          page: 1,
          limit: 10,
        })
      ).rejects.toThrow(
        'Invalid bounding box: north must be > south, east must be > west'
      );
    });
  });

  describe('Cultural Protocol Enforcement', () => {
    it('should mask restricted places as not found for non-elders', async () => {
      const restrictedPlace = { ...mockPlace, isRestricted: true };
      vi.spyOn(mockRepository, 'getByIdWithCommunityCheck').mockResolvedValue(
        restrictedPlace
      );

      // SPEC-V2 §6.4: restricted places are unavailable to every role; a
      // direct read masks as 404, never 403 (no existence leak).
      await expect(
        service.getPlaceById(1, testCommunityId, 'viewer')
      ).rejects.toThrow('Place with ID 1 not found');
    });

    it('should mask restricted places as not found for elders too', async () => {
      const restrictedPlace = { ...mockPlace, isRestricted: true };
      vi.spyOn(mockRepository, 'getByIdWithCommunityCheck').mockResolvedValue(
        restrictedPlace
      );

      await expect(
        service.getPlaceById(1, testCommunityId, 'elder')
      ).rejects.toThrow('Place with ID 1 not found');
    });

    it('should mask restricted places as not found for admins too', async () => {
      const restrictedPlace = { ...mockPlace, isRestricted: true };
      vi.spyOn(mockRepository, 'getByIdWithCommunityCheck').mockResolvedValue(
        restrictedPlace
      );

      await expect(
        service.getPlaceById(1, testCommunityId, 'admin')
      ).rejects.toThrow('Place with ID 1 not found');
    });

    it('should validate cultural significance data', async () => {
      const createData = {
        name: 'Sacred Place',
        latitude: 37.7749,
        longitude: -122.4194,
        culturalSignificance: 'Very important sacred site for our people',
      };

      vi.spyOn(mockRepository, 'create').mockResolvedValue(mockPlace);

      await service.createPlace(createData, testCommunityId, testUserId);

      expect(mockRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          culturalSignificance: 'Very important sacred site for our people',
        })
      );
    });
  });

  describe('getCommunityPlaceStats() - SPEC-V2 §6.4 projection', () => {
    it('always counts unrestricted places only and never returns a restricted count', async () => {
      vi.spyOn(mockRepository, 'getCommunityPlaceStats').mockResolvedValue({
        total: 3,
        public: 3,
        withStories: 1,
      });

      for (const role of ['admin', 'elder', 'editor', 'viewer']) {
        const stats = await service.getCommunityPlaceStats(
          testCommunityId,
          role
        );

        expect(stats).not.toHaveProperty('restricted');
        expect(mockRepository.getCommunityPlaceStats).toHaveBeenCalledWith(
          testCommunityId,
          {
            includeRestricted: false,
            storyAudiences: expect.any(Array),
          }
        );
      }
    });
  });

  describe('Error Handling', () => {
    it('should handle repository errors gracefully', async () => {
      vi.spyOn(mockRepository, 'create').mockRejectedValue(
        new Error('Database error')
      );

      await expect(
        service.createPlace(
          {
            name: 'Test Place',
            latitude: 37.7749,
            longitude: -122.4194,
          },
          testCommunityId,
          testUserId
        )
      ).rejects.toThrow('Database error');
    });

    it('should validate required fields', async () => {
      await expect(
        service.createPlace(
          {
            name: '', // Empty name
            latitude: 37.7749,
            longitude: -122.4194,
          },
          testCommunityId,
          testUserId
        )
      ).rejects.toThrow();
    });
  });
});
