/**
 * Unit tests for Issue #113 - Individual Resource Error Handling
 *
 * These tests verify that repositories and services properly convert
 * missing resources into appropriate errors (404) rather than 500 errors.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SpeakerService } from '../../src/services/speaker.service.js';
import { SpeakerRepository } from '../../src/repositories/speaker.repository.js';
import { PlaceService } from '../../src/services/place.service.js';
import { PlaceRepository } from '../../src/repositories/place.repository.js';
import { testDb } from '../helpers/database.js';
import {
  SpeakerNotFoundError,
  PlaceNotFoundError,
} from '../../src/shared/errors/index.js';

describe('Issue #113 - Individual Resource Error Handling (Unit Tests)', () => {
  let speakerService: SpeakerService;
  let placeService: PlaceService;
  let testCommunityId: number;

  beforeAll(async () => {
    await testDb.setup();
    const fixtures = await testDb.seedTestData();
    testCommunityId = fixtures.communities[0].id;

    const speakerRepo = new SpeakerRepository(testDb.db);
    const placeRepo = new PlaceRepository(testDb.db);

    speakerService = new SpeakerService(speakerRepo);
    placeService = new PlaceService(placeRepo);
  });

  afterAll(async () => {
    await testDb.cleanup();
  });

  describe('Speaker Service Error Handling', () => {
    it('should throw SpeakerNotFoundError for non-existent speaker', async () => {
      await expect(
        speakerService.getSpeakerById(99999, testCommunityId)
      ).rejects.toThrow(SpeakerNotFoundError);
    });

    it('should throw SpeakerNotFoundError for speaker in different community', async () => {
      // This tests the community isolation - a speaker in community 1 should not be
      // accessible when queried with community 2 context
      await expect(
        speakerService.getSpeakerById(1, 99999) // assuming speaker 1 exists in testCommunityId
      ).rejects.toThrow(SpeakerNotFoundError);
    });
  });

  describe('Place Service Error Handling', () => {
    it('should throw PlaceNotFoundError for non-existent place', async () => {
      await expect(
        placeService.getPlaceById(99999, testCommunityId)
      ).rejects.toThrow(PlaceNotFoundError);
    });

    it('should throw PlaceNotFoundError for place in different community', async () => {
      // This tests the community isolation - a place in community 1 should not be
      // accessible when queried with community 2 context
      await expect(
        placeService.getPlaceById(1, 99999) // assuming place 1 exists in testCommunityId
      ).rejects.toThrow(PlaceNotFoundError);
    });
  });

  describe('Error to HTTP Status Code Mapping', () => {
    it('should map SpeakerNotFoundError to 404', () => {
      const error = new SpeakerNotFoundError();
      expect(error.statusCode).toBe(404);
      expect(error.message).toContain('not found');
    });

    it('should map PlaceNotFoundError to 404', () => {
      const error = new PlaceNotFoundError();
      expect(error.statusCode).toBe(404);
      expect(error.message).toContain('not found');
    });
  });
});
