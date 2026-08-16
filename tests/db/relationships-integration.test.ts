import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  speakersSqlite,
  storiesSqlite,
  storyPlacesSqlite,
  storySpeakersSqlite,
} from '../../src/db/schema/index.js';
import { TestDatabaseManager } from '../helpers/database.js';

describe('Relationships Integration Tests', () => {
  let manager: TestDatabaseManager;
  let db: Awaited<ReturnType<TestDatabaseManager['getDb']>>;
  let storyId: number;
  let speakerId: number;
  let placeIds: number[];

  beforeEach(async () => {
    manager = new TestDatabaseManager();
    db = await manager.setup();
    const fixtures = await manager.seedTestData();
    const communityId = fixtures.communities[0].id;
    placeIds = fixtures.places
      .filter((place) => place.communityId === communityId)
      .map((place) => place.id);

    const [story] = await db
      .insert(storiesSqlite)
      .values({
        title: 'Relationship integration story',
        slug: `relationship-story-${Date.now()}`,
        communityId,
        createdBy: 1,
      })
      .returning();
    storyId = story.id;

    const [speaker] = await db
      .insert(speakersSqlite)
      .values({
        name: 'Relationship integration speaker',
        communityId,
      })
      .returning();
    speakerId = speaker.id;
  });

  afterEach(async () => {
    await manager.cleanup();
  });

  it('links a story to multiple places and a speaker', async () => {
    expect(placeIds.length).toBeGreaterThanOrEqual(2);

    await db.insert(storyPlacesSqlite).values(
      placeIds.slice(0, 2).map((placeId, sortOrder) => ({
        storyId,
        placeId,
        sortOrder,
      }))
    );
    await db.insert(storySpeakersSqlite).values({
      storyId,
      speakerId,
      storyRole: 'storyteller',
    });

    const linkedPlaces = await db
      .select()
      .from(storyPlacesSqlite)
      .where(eq(storyPlacesSqlite.storyId, storyId));
    const linkedSpeakers = await db
      .select()
      .from(storySpeakersSqlite)
      .where(eq(storySpeakersSqlite.storyId, storyId));

    expect(linkedPlaces).toHaveLength(2);
    expect(linkedSpeakers).toHaveLength(1);
    expect(linkedSpeakers[0].speakerId).toBe(speakerId);
  });

  it('prevents duplicate many-to-many relationships', async () => {
    const placeRelationship = { storyId, placeId: placeIds[0] };
    const speakerRelationship = { storyId, speakerId };

    await db.insert(storyPlacesSqlite).values(placeRelationship);
    await db.insert(storySpeakersSqlite).values(speakerRelationship);

    await expect(
      db.insert(storyPlacesSqlite).values(placeRelationship)
    ).rejects.toThrow();
    await expect(
      db.insert(storySpeakersSqlite).values(speakerRelationship)
    ).rejects.toThrow();
  });

  it('cascades relationship rows when a story is deleted', async () => {
    await db.insert(storyPlacesSqlite).values({
      storyId,
      placeId: placeIds[0],
    });
    await db.insert(storySpeakersSqlite).values({ storyId, speakerId });

    await db.delete(storiesSqlite).where(eq(storiesSqlite.id, storyId));

    expect(
      await db
        .select()
        .from(storyPlacesSqlite)
        .where(eq(storyPlacesSqlite.storyId, storyId))
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(storySpeakersSqlite)
        .where(eq(storySpeakersSqlite.storyId, storyId))
    ).toHaveLength(0);
  });
});
