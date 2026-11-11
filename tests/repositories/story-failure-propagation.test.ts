/**
 * Story failure propagation
 *
 * Database failures inside StoryRepository must reject (issue #135): a
 * failed query may never surface as an empty page, `false` validation or a
 * "not found" delete. Failures are forced by closing the underlying
 * better-sqlite3 connection of a real migrated in-memory database.
 */

import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { StoryRepository } from '../../src/repositories/story.repository.js';
import { CommunityRepository } from '../../src/repositories/community.repository.js';
import { PlaceRepository } from '../../src/repositories/place.repository.js';
import { SpeakerRepository } from '../../src/repositories/speaker.repository.js';
import { UserRepository } from '../../src/repositories/user.repository.js';
import { testDb } from '../helpers/database.js';

describe('StoryRepository failure propagation', () => {
  let stories: StoryRepository;
  let communityId: number;
  let placeId: number;
  let speakerId: number;
  let storyId: number;

  beforeEach(async () => {
    const db = await testDb.setup();
    const communities = new CommunityRepository(db);
    const users = new UserRepository(db);
    const places = new PlaceRepository(db);
    const speakers = new SpeakerRepository(db);
    stories = new StoryRepository(db);

    communityId = (
      await communities.create({ name: 'Failure Propagation Community' })
    ).id;
    const author = await users.create({
      email: 'failure.propagation@example.test',
      passwordHash: 'failure-propagation-hash',
      firstName: 'Failure',
      lastName: 'Propagation',
      communityId,
    });
    placeId = (
      await places.create({
        name: 'Failure Propagation Place',
        communityId,
        latitude: -1.4,
        longitude: -48.4,
      })
    ).id;
    speakerId = (
      await speakers.create({
        name: 'Failure Propagation Speaker',
        communityId,
      })
    ).id;
    storyId = (
      await stories.create({
        title: 'Failure Propagation Story',
        slug: 'failure-propagation-story',
        communityId,
        createdBy: author.id,
        tags: ['water'],
        placeIds: [placeId],
        speakerIds: [speakerId],
      })
    ).id;

    // Force every subsequent query to fail: the repository keeps its Drizzle
    // instance, but the underlying connection is gone.
    db.$client.close();
  });

  afterEach(async () => {
    try {
      await testDb.teardown();
    } catch {
      // The test already closed the connection; teardown may complain.
    }
  });

  test('findMany rejects instead of resolving to an empty page', async () => {
    await expect(
      stories.findMany({ communityId }, { page: 1, limit: 10 })
    ).rejects.toThrow();
  });

  test('tag-filtered findMany rejects instead of resolving to an empty page', async () => {
    await expect(
      stories.findMany({ communityId, tags: ['water'] }, { page: 1, limit: 10 })
    ).rejects.toThrow();
  });

  test('validateSpeakersInCommunity rejects instead of returning false', async () => {
    await expect(
      stories.validateSpeakersInCommunity([speakerId], communityId)
    ).rejects.toThrow();
  });

  test('validatePlacesInCommunity rejects instead of returning false', async () => {
    await expect(
      stories.validatePlacesInCommunity([placeId], communityId)
    ).rejects.toThrow();
  });

  test('delete rejects instead of returning false', async () => {
    await expect(stories.delete(storyId)).rejects.toThrow();
  });
});
