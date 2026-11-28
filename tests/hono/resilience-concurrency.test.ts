/**
 * Issue #149: conflicting story writes and delete-while-update on Hono V2.
 * SQLite may serialize the writes, but no response may expose a torn story or
 * resurrect a story that a successful delete removed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { StoryWritesRepository } from '../../src/repositories/story-writes.repository.js';
import {
  closeResilienceFixtures,
  createResilienceFixture,
  createResilienceStorage,
  storyRow,
} from './resilience-fixture.js';

afterEach(async () => {
  vi.restoreAllMocks();
  await closeResilienceFixtures();
});

describe('story write races (#149)', () => {
  it('serializes conflicting updates without tearing fields from both requests', async () => {
    const fixture = await createResilienceFixture();
    const story = await fixture.createStory('Concurrent update story', {
      placeIds: [fixture.ids.placeA],
      speakerIds: [fixture.ids.speakerA],
    });
    const alpha = {
      title: 'Alpha complete update',
      description: '<p>Alpha notes</p>',
      topic: 'Alpha topic',
      language: 'en',
      interviewLocationId: fixture.ids.placeA,
      interviewerId: fixture.ids.speakerA,
    };
    const beta = {
      title: 'Beta complete update',
      description: '<p>Beta notes</p>',
      topic: 'Beta topic',
      language: 'fr',
      interviewLocationId: fixture.ids.placeB,
      interviewerId: fixture.ids.speakerB,
    };

    const responses = await Promise.all([
      fixture.request('PATCH', `/v2/stories/${story.data.id}`, {
        cookie: fixture.cookies.editor,
        body: alpha,
      }),
      fixture.request('PATCH', `/v2/stories/${story.data.id}`, {
        cookie: fixture.cookies.editor2,
        body: beta,
      }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const row = await storyRow(fixture, story.data.id);
    const snapshots = [
      {
        title: alpha.title,
        description: alpha.description,
        descriptionPlain: 'Alpha notes',
        topic: alpha.topic,
        topicNormalized: 'alpha topic',
        language: alpha.language,
        interviewLocationId: alpha.interviewLocationId,
        interviewerId: alpha.interviewerId,
      },
      {
        title: beta.title,
        description: beta.description,
        descriptionPlain: 'Beta notes',
        topic: beta.topic,
        topicNormalized: 'beta topic',
        language: beta.language,
        interviewLocationId: beta.interviewLocationId,
        interviewerId: beta.interviewerId,
      },
    ];
    expect(snapshots).toContainEqual({
      title: row!.title,
      description: row!.description,
      descriptionPlain: row!.descriptionPlain,
      topic: row!.topic,
      topicNormalized: row!.topicNormalized,
      language: row!.language,
      interviewLocationId: row!.interviewLocationId,
      interviewerId: row!.interviewerId,
    });
    expect(
      await fixture.db
        .select()
        .from(fixture.tables.storyPlaces)
        .where(eq(fixture.tables.storyPlaces.storyId, story.data.id))
    ).toHaveLength(1);
    expect(
      await fixture.db
        .select()
        .from(fixture.tables.storySpeakers)
        .where(eq(fixture.tables.storySpeakers.storyId, story.data.id))
    ).toHaveLength(1);
  });

  it('does not resurrect a story when delete overlaps an update that already passed its read check', async () => {
    const memory = createResilienceStorage();
    const fixture = await createResilienceFixture({ storage: memory.storage });
    const story = await fixture.createStory('Delete while updating', {
      placeIds: [fixture.ids.placeA],
      speakerIds: [fixture.ids.speakerB],
    });
    const uploaded = await fixture.uploadMedia();
    await fixture.attachMedia(uploaded.data.id, story.data.id);
    const [file] = await fixture.db
      .select()
      .from(fixture.tables.files)
      .where(eq(fixture.tables.files.id, uploaded.data.id));

    let markEntered!: () => void;
    let releaseUpdate!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseUpdate = resolve;
    });
    const originalUpdate = StoryWritesRepository.prototype.updateStory;
    vi.spyOn(StoryWritesRepository.prototype, 'updateStory').mockImplementation(
      async function (
        this: StoryWritesRepository,
        ...args: Parameters<StoryWritesRepository['updateStory']>
      ) {
        markEntered();
        await gate;
        return originalUpdate.call(this, ...args);
      }
    );

    const update = fixture.request('PATCH', `/v2/stories/${story.data.id}`, {
      cookie: fixture.cookies.editor,
      body: { title: 'Must not resurrect', topic: 'Race topic' },
    });
    await entered;
    const deleted = await fixture.request(
      'DELETE',
      `/v2/stories/${story.data.id}`,
      {
        cookie: fixture.cookies.editor2,
      }
    );
    releaseUpdate();
    const updated = await update;

    expect(deleted.status).toBe(204);
    expect(updated.status).toBe(404);
    expect(await updated.json()).toEqual({ error: 'Not found' });
    expect(await storyRow(fixture, story.data.id)).toBeUndefined();
    expect(
      await fixture.db
        .select()
        .from(fixture.tables.storyPlaces)
        .where(eq(fixture.tables.storyPlaces.storyId, story.data.id))
    ).toEqual([]);
    expect(
      await fixture.db
        .select()
        .from(fixture.tables.storySpeakers)
        .where(eq(fixture.tables.storySpeakers.storyId, story.data.id))
    ).toEqual([]);
    expect(
      await fixture.db
        .select()
        .from(fixture.tables.attachments)
        .where(eq(fixture.tables.attachments.ownerId, story.data.id))
    ).toEqual([]);
    expect(
      await fixture.db
        .select()
        .from(fixture.tables.files)
        .where(eq(fixture.tables.files.id, uploaded.data.id))
    ).toEqual([]);
    expect(memory.store.has(file!.storageKey!)).toBe(false);
  });
});
