/**
 * Speaker Repository Tests
 *
 * Tests the SpeakerRepository class with:
 * - Complete CRUD operations
 * - Community data isolation and multi-tenancy
 * - Elder status recognition and cultural role filtering
 * - Cultural protocol enforcement
 * - Indigenous community considerations
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { SpeakerRepository } from '../../src/repositories/speaker.repository.js';
import { testDb } from '../helpers/database.js';
import type { CreateSpeakerData } from '../../src/repositories/speaker.repository.js';

describe('SpeakerRepository', () => {
  let repository: SpeakerRepository;
  let testCommunityId: number;
  let otherCommunityId: number;
  let db: any;

  beforeEach(async () => {
    db = await testDb.setup();
    repository = new SpeakerRepository(db);

    // Clear and seed test data fresh each time
    await testDb.clearData();
    const fixtures = await testDb.seedTestData();
    testCommunityId = fixtures.communities[1].id; // Skip system community (index 0)
    otherCommunityId = fixtures.communities[2].id;
  });

  afterEach(async () => {
    await testDb.teardown();
  });

  describe('create', () => {
    test('should create a new speaker with valid data', async () => {
      const speakerData: CreateSpeakerData = {
        name: 'Maria Santos',
        bio: 'Traditional storyteller and knowledge keeper',
        photoUrl: 'https://example.com/maria.jpg',
        birthYear: 1965,
        elderStatus: true,
        culturalRole: 'Traditional Knowledge Keeper',
        isActive: true,
      };

      const speaker = await repository.create({
        ...speakerData,
        communityId: testCommunityId,
      });

      expect(speaker).toBeDefined();
      expect(speaker.id).toBeTypeOf('number');
      expect(speaker.name).toBe(speakerData.name);
      expect(speaker.bio).toBe(speakerData.bio);
      expect(speaker.communityId).toBe(testCommunityId);
      expect(speaker.elderStatus).toBe(true);
      expect(speaker.culturalRole).toBe(speakerData.culturalRole);
      expect(speaker.isActive).toBe(true);
      expect(speaker.createdAt).toBeInstanceOf(Date);
      expect(speaker.updatedAt).toBeInstanceOf(Date);
    });

    test('should create speaker with minimal required data', async () => {
      const speakerData: CreateSpeakerData = {
        name: 'John Traditional',
      };

      const speaker = await repository.create({
        ...speakerData,
        communityId: testCommunityId,
      });

      expect(speaker).toBeDefined();
      expect(speaker.name).toBe(speakerData.name);
      expect(speaker.bio).toBeNull();
      expect(speaker.elderStatus).toBe(false); // Default value
      expect(speaker.isActive).toBe(true); // Default value
      expect(speaker.culturalRole).toBeNull();
    });

    test('should throw error for invalid community ID', async () => {
      const speakerData: CreateSpeakerData = {
        name: 'Invalid Community Speaker',
      };

      await expect(
        repository.create({
          ...speakerData,
          communityId: 99999, // Non-existent community
        })
      ).rejects.toThrow('Community');
    });

    test('should enforce name length constraints', async () => {
      const speakerData: CreateSpeakerData = {
        name: '', // Empty name should fail
      };

      await expect(
        repository.create({
          ...speakerData,
          communityId: testCommunityId,
        })
      ).rejects.toThrow();
    });
  });

  describe('getById', () => {
    test('should return speaker by ID', async () => {
      const speakerData: CreateSpeakerData = {
        name: 'Elder Rosa',
        elderStatus: true,
        culturalRole: 'Elder Council Member',
      };

      const created = await repository.create({
        ...speakerData,
        communityId: testCommunityId,
      });

      const found = await repository.getById(created.id);

      expect(found).toBeDefined();
      expect(found?.id).toBe(created.id);
      expect(found?.name).toBe(speakerData.name);
      expect(found?.elderStatus).toBe(true);
    });

    test('should return null for non-existent ID', async () => {
      const found = await repository.getById(99999);
      expect(found).toBeNull();
    });
  });

  describe('getByIdWithCommunityCheck', () => {
    test('should return speaker when community matches', async () => {
      const speakerData: CreateSpeakerData = {
        name: 'Community Speaker',
        culturalRole: 'Story Teller',
      };

      const created = await repository.create({
        ...speakerData,
        communityId: testCommunityId,
      });

      const found = await repository.getByIdWithCommunityCheck(
        created.id,
        testCommunityId
      );

      expect(found).toBeDefined();
      expect(found?.id).toBe(created.id);
      expect(found?.communityId).toBe(testCommunityId);
    });

    test('should return null when community does not match', async () => {
      const speakerData: CreateSpeakerData = {
        name: 'Other Community Speaker',
      };

      const created = await repository.create({
        ...speakerData,
        communityId: testCommunityId,
      });

      const found = await repository.getByIdWithCommunityCheck(
        created.id,
        otherCommunityId // Different community
      );

      expect(found).toBeNull();
    });
  });

  describe('getByCommunity', () => {
    beforeEach(async () => {
      // Create test speakers in different communities
      await repository.create({
        name: 'Community 1 Elder',
        elderStatus: true,
        culturalRole: 'Elder',
        communityId: testCommunityId,
      });

      await repository.create({
        name: 'Community 1 Storyteller',
        elderStatus: false,
        culturalRole: 'Storyteller',
        communityId: testCommunityId,
      });

      await repository.create({
        name: 'Community 2 Speaker',
        elderStatus: false,
        communityId: otherCommunityId,
      });
    });

    test('should return paginated speakers for a community', async () => {
      const result = await repository.getByCommunity(testCommunityId, {
        page: 1,
        limit: 10,
      });

      expect(result.data).toHaveLength(2); // Only community 1 speakers
      expect(result.total).toBe(2);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(10);
      expect(result.pages).toBe(1);

      // Verify all speakers belong to test community
      result.data.forEach((speaker) => {
        expect(speaker.communityId).toBe(testCommunityId);
      });
    });

    test('should filter by elder status', async () => {
      const result = await repository.getByCommunity(testCommunityId, {
        page: 1,
        limit: 10,
        elderOnly: true,
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].elderStatus).toBe(true);
      expect(result.data[0].name).toBe('Community 1 Elder');
    });

    test('should filter by cultural role', async () => {
      const result = await repository.getByCommunity(testCommunityId, {
        page: 1,
        limit: 10,
        culturalRole: 'Storyteller',
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].culturalRole).toBe('Storyteller');
    });

    test('should filter by active status', async () => {
      // Create inactive speaker
      await repository.create({
        name: 'Inactive Speaker',
        isActive: false,
        communityId: testCommunityId,
      });

      const activeResult = await repository.getByCommunity(testCommunityId, {
        page: 1,
        limit: 10,
        activeOnly: true,
      });

      expect(activeResult.data).toHaveLength(2); // Only active speakers

      const allResult = await repository.getByCommunity(testCommunityId, {
        page: 1,
        limit: 10,
        activeOnly: false,
      });

      expect(allResult.data).toHaveLength(3); // All speakers including inactive
    });

    test('should support pagination', async () => {
      const firstPage = await repository.getByCommunity(testCommunityId, {
        page: 1,
        limit: 1,
      });

      expect(firstPage.data).toHaveLength(1);
      expect(firstPage.total).toBe(2);
      expect(firstPage.pages).toBe(2);

      const secondPage = await repository.getByCommunity(testCommunityId, {
        page: 2,
        limit: 1,
      });

      expect(secondPage.data).toHaveLength(1);
      expect(secondPage.page).toBe(2);

      // Verify different speakers on different pages
      expect(firstPage.data[0].id).not.toBe(secondPage.data[0].id);
    });

    test('should support sorting', async () => {
      const nameAsc = await repository.getByCommunity(testCommunityId, {
        page: 1,
        limit: 10,
        sortBy: 'name',
        sortOrder: 'asc',
      });

      expect(nameAsc.data[0].name).toBe('Community 1 Elder');
      expect(nameAsc.data[1].name).toBe('Community 1 Storyteller');

      const nameDesc = await repository.getByCommunity(testCommunityId, {
        page: 1,
        limit: 10,
        sortBy: 'name',
        sortOrder: 'desc',
      });

      expect(nameDesc.data[0].name).toBe('Community 1 Storyteller');
      expect(nameDesc.data[1].name).toBe('Community 1 Elder');
    });
  });

  describe('update', () => {
    test('should update speaker data', async () => {
      const speakerData: CreateSpeakerData = {
        name: 'Original Name',
        bio: 'Original bio',
        elderStatus: false,
      };

      const created = await repository.create({
        ...speakerData,
        communityId: testCommunityId,
      });

      // Small delay to ensure updatedAt is different
      await new Promise((resolve) => setTimeout(resolve, 10));

      const updateData = {
        name: 'Updated Name',
        bio: 'Updated bio',
        elderStatus: true,
        culturalRole: 'Elder Council',
      };

      const updated = await repository.update(created.id, updateData);

      expect(updated).toBeDefined();
      expect(updated?.name).toBe('Updated Name');
      expect(updated?.bio).toBe('Updated bio');
      expect(updated?.elderStatus).toBe(true);
      expect(updated?.culturalRole).toBe('Elder Council');
      expect(updated?.updatedAt).toBeInstanceOf(Date);
    });

    test('should return null for non-existent speaker', async () => {
      const updated = await repository.update(99999, { name: 'Test' });
      expect(updated).toBeNull();
    });

    test('should update only provided fields', async () => {
      const speakerData: CreateSpeakerData = {
        name: 'Original Name',
        bio: 'Original bio',
        elderStatus: false,
      };

      const created = await repository.create({
        ...speakerData,
        communityId: testCommunityId,
      });

      const updated = await repository.update(created.id, {
        name: 'Updated Name Only',
      });

      expect(updated?.name).toBe('Updated Name Only');
      expect(updated?.bio).toBe('Original bio'); // Unchanged
      expect(updated?.elderStatus).toBe(false); // Unchanged
    });
  });

  describe('delete', () => {
    test('should delete speaker and return true', async () => {
      const speakerData: CreateSpeakerData = {
        name: 'To Be Deleted',
      };

      const created = await repository.create({
        ...speakerData,
        communityId: testCommunityId,
      });

      const deleted = await repository.delete(created.id);
      expect(deleted).toBe(true);

      // Verify speaker is deleted
      const found = await repository.getById(created.id);
      expect(found).toBeNull();
    });

    test('should return false for non-existent speaker', async () => {
      const deleted = await repository.delete(99999);
      expect(deleted).toBe(false);
    });
  });

  describe('getCommunityStats', () => {
    beforeEach(async () => {
      // Create speakers with different characteristics
      await repository.create({
        name: 'Active Elder',
        elderStatus: true,
        isActive: true,
        communityId: testCommunityId,
      });

      await repository.create({
        name: 'Active Non-Elder',
        elderStatus: false,
        isActive: true,
        communityId: testCommunityId,
      });

      await repository.create({
        name: 'Inactive Speaker',
        elderStatus: false,
        isActive: false,
        communityId: testCommunityId,
      });

      // Speaker in different community
      await repository.create({
        name: 'Other Community Speaker',
        elderStatus: true,
        communityId: otherCommunityId,
      });
    });

    test('should return correct community statistics', async () => {
      const stats = await repository.getCommunityStats(testCommunityId);

      expect(stats.total).toBe(3); // Total speakers in community
      expect(stats.active).toBe(2); // Active speakers
      expect(stats.inactive).toBe(1); // Inactive speakers
      expect(stats.elders).toBe(1); // Elder speakers
      expect(stats.nonElders).toBe(2); // Non-elder speakers
    });

    test('should return zero stats for community with no speakers', async () => {
      // Create new empty community
      const emptyCommunityId = 99;
      const stats = await repository.getCommunityStats(emptyCommunityId);

      expect(stats.total).toBe(0);
      expect(stats.active).toBe(0);
      expect(stats.inactive).toBe(0);
      expect(stats.elders).toBe(0);
      expect(stats.nonElders).toBe(0);
    });
  });

  describe('searchByName', () => {
    beforeEach(async () => {
      await repository.create({
        name: 'Maria Santos',
        culturalRole: 'Elder',
        communityId: testCommunityId,
      });

      await repository.create({
        name: 'Maria Rodriguez',
        culturalRole: 'Storyteller',
        communityId: testCommunityId,
      });

      await repository.create({
        name: 'John Smith',
        culturalRole: 'Knowledge Keeper',
        communityId: testCommunityId,
      });

      await repository.create({
        name: 'Maria Other Community',
        communityId: otherCommunityId,
      });
    });

    test('should search speakers by name', async () => {
      const result = await repository.searchByName(testCommunityId, 'Maria', {
        page: 1,
        limit: 10,
      });

      expect(result.data).toHaveLength(2);
      expect(result.total).toBe(2);
      result.data.forEach((speaker) => {
        expect(speaker.name).toContain('Maria');
        expect(speaker.communityId).toBe(testCommunityId);
      });
    });

    test('should return empty result for non-matching search', async () => {
      const result = await repository.searchByName(
        testCommunityId,
        'NonExistent',
        {
          page: 1,
          limit: 10,
        }
      );

      expect(result.data).toHaveLength(0);
      expect(result.total).toBe(0);
    });

    test('should respect community isolation in search', async () => {
      const result = await repository.searchByName(otherCommunityId, 'Maria', {
        page: 1,
        limit: 10,
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].name).toBe('Maria Other Community');
      expect(result.data[0].communityId).toBe(otherCommunityId);
    });
  });
});
