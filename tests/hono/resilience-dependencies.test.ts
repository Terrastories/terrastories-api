/**
 * Issue #149: Hono V2 dependency-failure and cancellation contracts on Node
 * SQLite. Failures are injected at the real route/service/repository boundary;
 * production source is never replaced or modified.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { HonoFoundationRepository } from '../../src/repositories/hono-foundation.repository.js';
import { CommunitySovereigntyRepository } from '../../src/repositories/community-sovereignty.repository.js';
import { CommunityErasureService } from '../../src/services/community-erasure.service.js';
import type { FoundationStorage } from '../../src/services/hono-foundation.service.js';
import { rawUploadRequest } from '../helpers/raw-upload.js';
import {
  PNG_BYTES,
  RESILIENCE_NOW,
  closeResilienceFixtures,
  createMemoryErasureStore,
  createResilienceFixture,
  createResilienceStorage,
  failAfterStatement,
} from './resilience-fixture.js';

afterEach(async () => {
  vi.restoreAllMocks();
  await closeResilienceFixtures();
});

function chunkedBody(
  bytes: Uint8Array,
  chunkSize = 4096
): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.subarray(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
}

describe('storage failure compensation (#149)', () => {
  it('removes a partially stored upload and creates no File row when put fails mid-stream', async () => {
    const memory = createResilienceStorage();
    const failingStorage: FoundationStorage = {
      ...memory.storage,
      async put(key, body) {
        const reader = (body as ReadableStream<Uint8Array>).getReader();
        const first = await reader.read();
        if (!first.done && first.value) memory.store.set(key, first.value);
        await reader.cancel();
        throw new Error('Injected storage outage after partial write');
      },
    };
    const fixture = await createResilienceFixture({ storage: failingStorage });
    const bytes = new Uint8Array(12_288);
    bytes.set(PNG_BYTES);
    const upload = rawUploadRequest({
      filename: 'partial.png',
      contentType: 'image/png',
      bytes,
    });

    const response = await fixture.request(
      'POST',
      `/v2/media${upload.search}`,
      {
        cookie: fixture.cookies.editor,
        headers: upload.headers,
        rawBody: chunkedBody(bytes),
      }
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error' });
    expect(memory.store.size).toBe(0);
    expect(await fixture.db.select().from(fixture.tables.files)).toEqual([]);
    const uploadAudits = await fixture.db
      .select()
      .from(fixture.tables.auditEntries)
      .where(eq(fixture.tables.auditEntries.action, 'media.upload'));
    expect(uploadAudits).toEqual([]);
  });

  it('keeps no orphan File row when delete fails and the recovered orphan sweep removes the bytes', async () => {
    const memory = createResilienceStorage();
    let failDelete = true;
    const flakyStorage: FoundationStorage = {
      ...memory.storage,
      async delete(key) {
        if (failDelete) throw new Error('Injected storage delete outage');
        await memory.storage.delete!(key);
      },
    };
    const fixture = await createResilienceFixture({ storage: flakyStorage });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const uploaded = await fixture.uploadMedia();
    const [fileBefore] = await fixture.db
      .select()
      .from(fixture.tables.files)
      .where(eq(fixture.tables.files.id, uploaded.data.id));
    expect(fileBefore).toBeDefined();
    expect(memory.store.has(fileBefore!.storageKey!)).toBe(true);

    const response = await fixture.request(
      'DELETE',
      `/v2/media/${uploaded.data.id}`,
      {
        cookie: fixture.cookies.editor,
      }
    );
    expect(response.status).toBe(204);
    expect(warning).toHaveBeenCalledOnce();
    expect(
      await fixture.db
        .select()
        .from(fixture.tables.files)
        .where(eq(fixture.tables.files.id, uploaded.data.id))
    ).toEqual([]);
    expect(memory.store.has(fileBefore!.storageKey!)).toBe(true);

    failDelete = false;
    await fixture.cleanup.sweepOrphanObjects();
    expect(memory.store.has(fileBefore!.storageKey!)).toBe(false);
  });
});

describe('database transaction rollback (#149)', () => {
  it('rolls back story, place edges, speaker edges and audit when a later write fails', async () => {
    const fixture = await createResilienceFixture();
    const control = await fixture.createStory('Media control story');
    const uploaded = await fixture.uploadMedia();
    await fixture.attachMedia(uploaded.data.id, control.data.id);
    const failure = failAfterStatement(fixture.sqlite, (sql) =>
      /^insert into "audit_entries"/i.test(sql)
    );

    const response = await fixture.request('POST', '/v2/stories', {
      cookie: fixture.cookies.editor,
      body: {
        title: 'Must not survive partial create',
        description: '<p>Atomic story</p>',
        visibility: 'public',
        topic: 'Atomic topic',
        interviewLocationId: fixture.ids.placeA,
        interviewerId: fixture.ids.speakerA,
        placeIds: [fixture.ids.placeA, fixture.ids.placeA],
        speakerIds: [fixture.ids.speakerB],
      },
    });

    expect(response.status).toBe(500);
    expect(failure.fired).toBe(true);
    expect(
      await fixture.db
        .select()
        .from(fixture.tables.stories)
        .where(
          eq(fixture.tables.stories.title, 'Must not survive partial create')
        )
    ).toEqual([]);
    expect(await fixture.db.select().from(fixture.tables.storyPlaces)).toEqual(
      []
    );
    expect(
      await fixture.db.select().from(fixture.tables.storySpeakers)
    ).toEqual([]);
    expect(
      await fixture.db
        .select()
        .from(fixture.tables.auditEntries)
        .where(
          eq(fixture.tables.auditEntries.action, 'story.visibility.public')
        )
    ).toEqual([]);

    // Story creation has no media field; the separately uploaded/attached
    // control media must remain untouched by the failed multi-write request.
    expect(await fixture.db.select().from(fixture.tables.files)).toHaveLength(
      1
    );
    expect(
      await fixture.db.select().from(fixture.tables.attachments)
    ).toHaveLength(1);
    const [controlFile] = await fixture.db
      .select()
      .from(fixture.tables.files)
      .where(eq(fixture.tables.files.id, uploaded.data.id));
    expect(await fixture.storage.read(controlFile!.storageKey!)).not.toBeNull();
  });

  it('rolls back every import row and relation, then leaves a terminal failed manifest', async () => {
    const fixture = await createResilienceFixture();
    const preview = await fixture.createImportPreview(
      'stories',
      'title,visibility,place_names,speaker_names,media\n' +
        'Atomic Import Story,public,Imported Place,Imported Speaker,atomic.png\n',
      'atomic.png'
    );
    const [manifestBefore] = await fixture.db
      .select()
      .from(fixture.tables.importManifests)
      .where(eq(fixture.tables.importManifests.id, preview.data.id));
    const stagedIds = manifestBefore!.stagedFileIds;
    const sourceFileId = manifestBefore!.sourceFileId;
    const failure = failAfterStatement(fixture.sqlite, (sql) =>
      /^insert into "story_places"/i.test(sql)
    );

    const response = await fixture.request(
      'POST',
      `/v2/imports/${preview.data.id}/commit`,
      { cookie: fixture.cookies.editor }
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      code: 'import_commit_failed',
    });
    expect(failure.fired).toBe(true);
    expect(
      await fixture.db
        .select()
        .from(fixture.tables.stories)
        .where(eq(fixture.tables.stories.title, 'Atomic Import Story'))
    ).toEqual([]);
    expect(
      await fixture.db
        .select()
        .from(fixture.tables.places)
        .where(eq(fixture.tables.places.name, 'Imported Place'))
    ).toEqual([]);
    expect(
      await fixture.db
        .select()
        .from(fixture.tables.speakers)
        .where(eq(fixture.tables.speakers.name, 'Imported Speaker'))
    ).toEqual([]);
    expect(await fixture.db.select().from(fixture.tables.storyPlaces)).toEqual(
      []
    );
    expect(
      await fixture.db.select().from(fixture.tables.storySpeakers)
    ).toEqual([]);
    expect(await fixture.db.select().from(fixture.tables.attachments)).toEqual(
      []
    );
    for (const stagedId of stagedIds)
      expect(
        await fixture.db
          .select()
          .from(fixture.tables.files)
          .where(eq(fixture.tables.files.id, stagedId))
      ).toEqual([]);
    const [sourceAfter] = await fixture.db
      .select()
      .from(fixture.tables.files)
      .where(eq(fixture.tables.files.id, sourceFileId!));
    expect(sourceAfter).toMatchObject({ isActive: false });
    expect(
      (
        await fixture.storage.list!({
          prefix: `communities/${fixture.ids.own}/`,
        })
      ).entries
    ).toEqual([]);
    const [manifestAfter] = await fixture.db
      .select()
      .from(fixture.tables.importManifests)
      .where(eq(fixture.tables.importManifests.id, preview.data.id));
    expect(manifestAfter).toMatchObject({
      status: 'failed',
      committedAt: null,
      resultSummary: null,
    });
    expect((manifestAfter!.normalizedRows as { rows: unknown[] }).rows).toEqual(
      []
    );
    expect(stagedIds).not.toContain(sourceFileId);
    const replay = await fixture.request(
      'POST',
      `/v2/imports/${preview.data.id}/commit`,
      { cookie: fixture.cookies.editor }
    );
    expect(replay.status).toBe(409);
  });

  it('keeps erasure rows intact after a mid-step DB failure and completes on a recovered sweep', async () => {
    const erasure = createMemoryErasureStore();
    const fixture = await createResilienceFixture({
      erasureStore: erasure.store,
    });
    const story = await fixture.createStory('Erasure rollback story');
    await fixture.uploadMedia();
    const failure = failAfterStatement(
      fixture.sqlite,
      (sql) => /delete from "stories"/i.test(sql),
      'all'
    );

    const response = await fixture.request('POST', '/v2/community/erasure', {
      cookie: fixture.cookies.admin,
      body: { confirmFinality: true, currentDerivedKey: fixture.derivedKey },
    });

    expect(response.status).toBe(202);
    // The inline first pass deletes the listed object; a fresh empty listing
    // on the next pass is required before eraseRows() starts.
    expect(failure.fired).toBe(false);
    expect(
      (
        await fixture.storage.list!({
          prefix: `communities/${fixture.ids.own}/`,
        })
      ).entries
    ).toEqual([]);
    const [disabledCommunity] = await fixture.db
      .select()
      .from(fixture.tables.communities)
      .where(eq(fixture.tables.communities.id, fixture.ids.own));
    expect(disabledCommunity!.isActive).toBe(false);
    const service = new CommunityErasureService(
      new CommunitySovereigntyRepository(fixture.db),
      fixture.storage,
      erasure.store,
      () => RESILIENCE_NOW
    );
    await expect(service.sweep(RESILIENCE_NOW)).rejects.toThrow(
      'Injected database failure after statement'
    );
    expect(failure.fired).toBe(true);
    expect(
      await fixture.db
        .select()
        .from(fixture.tables.communities)
        .where(eq(fixture.tables.communities.id, fixture.ids.own))
    ).toHaveLength(1);
    expect(
      await fixture.db
        .select()
        .from(fixture.tables.users)
        .where(eq(fixture.tables.users.communityId, fixture.ids.own))
    ).toHaveLength(4);
    expect(
      await fixture.db
        .select()
        .from(fixture.tables.stories)
        .where(eq(fixture.tables.stories.id, story.data.id))
    ).toHaveLength(1);
    expect(
      await fixture.db
        .select()
        .from(fixture.tables.files)
        .where(eq(fixture.tables.files.communityId, fixture.ids.own))
    ).toHaveLength(1);
    expect(erasure.records.get(fixture.ids.own)).toMatchObject({
      outcome: 'pending',
      completedAt: null,
    });
    expect(
      await fixture.db
        .select()
        .from(fixture.tables.auditEntries)
        .where(
          eq(
            fixture.tables.auditEntries.action,
            'community.sovereignty.erasure.completed'
          )
        )
    ).toEqual([]);

    failure.spy.mockRestore();
    await service.sweep(RESILIENCE_NOW);

    expect(
      await fixture.db
        .select()
        .from(fixture.tables.communities)
        .where(eq(fixture.tables.communities.id, fixture.ids.own))
    ).toEqual([]);
    expect(
      await fixture.db
        .select()
        .from(fixture.tables.users)
        .where(eq(fixture.tables.users.communityId, fixture.ids.own))
    ).toEqual([]);
    expect(
      await fixture.db
        .select()
        .from(fixture.tables.stories)
        .where(eq(fixture.tables.stories.id, story.data.id))
    ).toEqual([]);
    expect(
      await fixture.db
        .select()
        .from(fixture.tables.files)
        .where(eq(fixture.tables.files.communityId, fixture.ids.own))
    ).toEqual([]);
    expect(erasure.records.get(fixture.ids.own)).toMatchObject({
      outcome: 'completed',
      completedAt: RESILIENCE_NOW.toISOString(),
    });
    expect(
      await fixture.db
        .select()
        .from(fixture.tables.communities)
        .where(eq(fixture.tables.communities.id, fixture.ids.foreign))
    ).toHaveLength(1);
  });
});

describe('request cancellation and session-store outage (#149)', () => {
  it('leaves no partial object or File row when the request body errors mid-upload', async () => {
    const memory = createResilienceStorage();
    const partialStorage: FoundationStorage = {
      ...memory.storage,
      async put(key, body) {
        const reader = (body as ReadableStream<Uint8Array>).getReader();
        const chunks: Uint8Array[] = [];
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) chunks.push(value);
          }
        } catch (error) {
          const size = chunks.reduce(
            (total, chunk) => total + chunk.byteLength,
            0
          );
          const partial = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) {
            partial.set(chunk, offset);
            offset += chunk.byteLength;
          }
          memory.store.set(key, partial);
          throw error;
        }
        throw new Error('Expected the request body to fail');
      },
    };
    const fixture = await createResilienceFixture({ storage: partialStorage });
    const bytes = new Uint8Array(12_288);
    bytes.set(PNG_BYTES);
    const upload = rawUploadRequest({
      filename: 'aborted.png',
      contentType: 'image/png',
      bytes,
    });
    let pulls = 0;
    const abortedBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(bytes.subarray(0, 4096));
          return;
        }
        controller.error(
          new DOMException('Client disconnected mid-body', 'AbortError')
        );
      },
    });

    const response = await fixture.request(
      'POST',
      `/v2/media${upload.search}`,
      {
        cookie: fixture.cookies.editor,
        headers: upload.headers,
        rawBody: abortedBody,
      }
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error' });
    expect(memory.store.size).toBe(0);
    expect(await fixture.db.select().from(fixture.tables.files)).toEqual([]);
  });

  it('answers 503 on a session read exception and 401 on a missing session, then recovers', async () => {
    const fixture = await createResilienceFixture();
    const sessionContext = vi
      .spyOn(HonoFoundationRepository.prototype, 'sessionContext')
      .mockRejectedValueOnce(new Error('Session store unavailable'))
      .mockResolvedValueOnce(null);

    const unavailable = await fixture.request('GET', '/v2/auth/me', {
      cookie: fixture.cookies.editor,
    });
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ error: 'Service unavailable' });
    expect(unavailable.headers.get('set-cookie')).toBeNull();

    const missing = await fixture.request('GET', '/v2/auth/me', {
      cookie: fixture.cookies.editor,
    });
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: 'Unauthorized' });
    expect(missing.headers.get('set-cookie')).toBeNull();

    const recovered = await fixture.request('GET', '/v2/auth/me', {
      cookie: fixture.cookies.editor,
    });
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({
      user: { id: fixture.ids.editor, role: 'editor' },
    });
    expect(sessionContext).toHaveBeenCalledTimes(3);
  });
});
