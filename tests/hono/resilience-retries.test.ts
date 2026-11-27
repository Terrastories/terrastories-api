/**
 * Issue #149: duplicate and racing submissions against the Hono V2 app.
 * Single-use credentials must elect one winner; an import replay must return
 * its recorded result; upload completion must never duplicate or lose bytes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { FoundationStorage } from '../../src/services/hono-foundation.service.js';
import { MediaWritesRepository } from '../../src/repositories/media-writes.repository.js';
import {
  PNG_BYTES,
  closeResilienceFixtures,
  createResilienceFixture,
  createResilienceStorage,
  passwordPayload,
} from './resilience-fixture.js';

afterEach(async () => {
  vi.restoreAllMocks();
  await closeResilienceFixtures();
});

function barrierStorage(
  storage: FoundationStorage,
  matches: (key: string) => boolean
) {
  let armed = false;
  let arrivals = 0;
  let release!: () => void;
  let gate!: Promise<void>;
  const decorate = (): FoundationStorage => ({
    ...storage,
    async read(key, range) {
      if (armed && matches(key)) {
        arrivals += 1;
        if (arrivals === 2) release();
        await gate;
      }
      return storage.read(key, range);
    },
  });
  return {
    decorate,
    arm() {
      arrivals = 0;
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      armed = true;
    },
    disarm() {
      armed = false;
    },
  };
}

const completeDirectUpload = (
  fixture: Awaited<ReturnType<typeof createResilienceFixture>>,
  session: { id: string; parts: Array<{ partNumber: number; etag: string }> }
) =>
  fixture.request('POST', `/v2/media/uploads/${session.id}/complete`, {
    cookie: fixture.cookies.editor,
    body: { parts: session.parts },
  });

type UploadedMediaInput = Parameters<
  MediaWritesRepository['createUploadedMedia']
>[0];

const uploadedMediaInput = (
  fixture: Awaited<ReturnType<typeof createResilienceFixture>>,
  userPhotoTargetUserId: number | null = null
): UploadedMediaInput => {
  const fileId = crypto.randomUUID();
  return {
    fileId,
    actor: {
      id: fixture.ids.editor,
      email: 'editor@resilience.example.test',
      username: 'resilience_editor',
      displayName: 'Resilience User',
      passwordHash: 'unused',
      role: 'editor',
      communityId: fixture.ids.own,
    },
    storageKey: `communities/${fixture.ids.own}/media/${fileId}`,
    originalName: 'race.png',
    mimeType: 'image/png',
    byteSize: PNG_BYTES.byteLength,
    checksum: null,
    metadata: null,
    userPhotoTargetUserId,
  };
};

describe('single-use credential retries (#149)', () => {
  it('elects one winner for concurrent login-code redemption and keeps replay uniformly rejected', async () => {
    const fixture = await createResilienceFixture();
    const code = await fixture.insertLoginCode(
      fixture.ids.member,
      fixture.ids.own
    );
    const redeem = () =>
      fixture.request('POST', '/v2/auth/recovery/redeem', { body: { code } });

    const responses = await Promise.all([redeem(), redeem()]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 401,
    ]);
    const rejected = responses.find((response) => response.status === 401)!;
    expect(await rejected.json()).toEqual({ error: 'Invalid credentials' });
    const accepted = responses.find((response) => response.status === 200)!;
    expect(accepted.headers.get('set-cookie')).toContain('ts_session=');

    const [loginCode] = await fixture.db
      .select()
      .from(fixture.tables.loginCodes)
      .where(eq(fixture.tables.loginCodes.userId, fixture.ids.member));
    expect(loginCode!.usedAt).not.toBeNull();
    expect(
      await fixture.db
        .select()
        .from(fixture.tables.sessions)
        .where(eq(fixture.tables.sessions.userId, fixture.ids.member))
    ).toHaveLength(1);
    expect(
      await fixture.db
        .select()
        .from(fixture.tables.users)
        .where(eq(fixture.tables.users.id, fixture.ids.member))
    ).toHaveLength(1);

    const replay = await redeem();
    expect(replay.status).toBe(401);
    expect(await replay.json()).toEqual({ error: 'Invalid credentials' });
    expect(
      await fixture.db
        .select()
        .from(fixture.tables.sessions)
        .where(eq(fixture.tables.sessions.userId, fixture.ids.member))
    ).toHaveLength(1);
  });

  it('elects one claimant for a racing claim token and creates exactly one administrator', async () => {
    const fixture = await createResilienceFixture();
    const claim = await fixture.insertClaimToken();
    const body = {
      token: claim.token,
      username: 'claimed_admin',
      email: 'claimed@resilience.example.test',
      password: passwordPayload(),
    };
    const postClaim = () =>
      fixture.request('POST', '/v2/bootstrap/claim', { body });

    const responses = await Promise.all([postClaim(), postClaim()]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      201, 401,
    ]);
    const rejected = responses.find((response) => response.status === 401)!;
    expect(await rejected.json()).toEqual({ error: 'Invalid credentials' });

    const users = await fixture.db
      .select()
      .from(fixture.tables.users)
      .where(eq(fixture.tables.users.communityId, fixture.ids.claimCommunity));
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({
      role: 'admin',
      username: 'claimed_admin',
    });
    const [tokenRow] = await fixture.db
      .select()
      .from(fixture.tables.claimTokens)
      .where(eq(fixture.tables.claimTokens.id, claim.id));
    expect(tokenRow).toMatchObject({ consumedBy: users[0]!.id });
    expect(tokenRow!.consumedAt).not.toBeNull();
    expect(
      await fixture.db
        .select()
        .from(fixture.tables.loginCodes)
        .where(eq(fixture.tables.loginCodes.userId, users[0]!.id))
    ).toHaveLength(10);
    expect(
      await fixture.db
        .select()
        .from(fixture.tables.sessions)
        .where(eq(fixture.tables.sessions.userId, users[0]!.id))
    ).toHaveLength(1);
    const successfulClaims = await fixture.db
      .select()
      .from(fixture.tables.auditEntries)
      .where(
        and(
          eq(fixture.tables.auditEntries.action, 'claim_token.consume'),
          eq(fixture.tables.auditEntries.outcome, 'success')
        )
      );
    expect(successfulClaims).toHaveLength(1);

    const replay = await postClaim();
    expect(replay.status).toBe(401);
    expect(await replay.json()).toEqual({ error: 'Invalid credentials' });
    expect(
      await fixture.db
        .select()
        .from(fixture.tables.users)
        .where(eq(fixture.tables.users.communityId, fixture.ids.claimCommunity))
    ).toHaveLength(1);
  });
});

describe('import confirmation retries (#149)', () => {
  it('returns the same recorded result for racing commits and applies the manifest once', async () => {
    const memory = createResilienceStorage();
    const barrier = barrierStorage(memory.storage, () => true);
    const fixture = await createResilienceFixture({
      storage: barrier.decorate(),
    });
    const preview = await fixture.createImportPreview(
      'places',
      'name,photo\nRetry Import Place,retry.png\n',
      'retry.png'
    );
    const commit = () =>
      fixture.request('POST', `/v2/imports/${preview.data.id}/commit`, {
        cookie: fixture.cookies.editor,
      });

    barrier.arm();
    const responses = await Promise.all([commit(), commit()]);
    barrier.disarm();

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const first = (await responses[0]!.json()) as {
      data: Record<string, unknown>;
    };
    const second = (await responses[1]!.json()) as {
      data: Record<string, unknown>;
    };
    expect(first.data).toEqual(second.data);
    expect(first.data).toMatchObject({ status: 'committed' });
    expect(
      await fixture.db
        .select()
        .from(fixture.tables.places)
        .where(eq(fixture.tables.places.name, 'Retry Import Place'))
    ).toHaveLength(1);
    expect(
      await fixture.db.select().from(fixture.tables.attachments)
    ).toHaveLength(1);
    const files = await fixture.db.select().from(fixture.tables.files);
    const [manifest] = await fixture.db
      .select()
      .from(fixture.tables.importManifests)
      .where(eq(fixture.tables.importManifests.id, preview.data.id));
    expect(files.map((file) => file.id).sort()).toEqual(
      [manifest!.sourceFileId, ...manifest!.stagedFileIds].sort()
    );
    const audits = await fixture.db
      .select()
      .from(fixture.tables.auditEntries)
      .where(eq(fixture.tables.auditEntries.action, 'import.commit'));
    expect(audits).toHaveLength(1);

    const replay = await commit();
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(first);
    expect(
      await fixture.db
        .select()
        .from(fixture.tables.places)
        .where(eq(fixture.tables.places.name, 'Retry Import Place'))
    ).toHaveLength(1);
  });
});

describe('upload insert race backstops (#149)', () => {
  it('re-reads the SQLite winner and its user_photo binding after a duplicate insert', async () => {
    const fixture = await createResilienceFixture();
    const repository = new MediaWritesRepository(fixture.db);
    const input = uploadedMediaInput(fixture, fixture.ids.editor);

    const created = await repository.createUploadedMedia(input);
    const replay = await repository.createUploadedMedia(input);

    if (created.status !== 'created' || replay.status !== 'existing') {
      throw new Error('Expected one created upload and one existing replay');
    }
    expect(replay.record.file.id).toBe(created.record.file.id);
    expect(replay.record.attachment).toEqual(created.record.attachment);
    expect(
      await fixture.db
        .select()
        .from(fixture.tables.files)
        .where(eq(fixture.tables.files.id, input.fileId))
    ).toHaveLength(1);
    expect(
      await fixture.db
        .select()
        .from(fixture.tables.attachments)
        .where(eq(fixture.tables.attachments.fileId, input.fileId))
    ).toHaveLength(1);
    expect(
      await fixture.db
        .select()
        .from(fixture.tables.auditEntries)
        .where(
          eq(fixture.tables.auditEntries.action, 'media.upload.user_photo')
        )
    ).toHaveLength(1);
  });

  it('re-reads the winner after a D1-wrapped unique batch failure', async () => {
    const fixture = await createResilienceFixture();
    const d1Like = fixture.db as typeof fixture.db & {
      batch: (
        statements: Array<{
          toSQL: () => { sql: string; params: unknown[] };
        }>
      ) => Promise<unknown[]>;
    };
    d1Like.batch = async (statements) => {
      try {
        return fixture.sqlite.transaction(() =>
          statements.map((statement) => {
            const { sql, params } = statement.toSQL();
            const prepared = fixture.sqlite.prepare(sql);
            return prepared.reader
              ? prepared.all(...params)
              : prepared.run(...params);
          })
        )();
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes('UNIQUE constraint failed')
        ) {
          throw new Error('D1_ERROR: UNIQUE constraint failed: files.id', {
            cause: error,
          });
        }
        throw error;
      }
    };
    const repository = new MediaWritesRepository(d1Like as never);
    const input = uploadedMediaInput(fixture);

    const created = await repository.createUploadedMedia(input);
    const replay = await repository.createUploadedMedia(input);

    if (created.status !== 'created' || replay.status !== 'existing') {
      throw new Error('Expected one created upload and one existing replay');
    }
    expect(replay.record.file.id).toBe(created.record.file.id);
    expect(
      await fixture.db
        .select()
        .from(fixture.tables.files)
        .where(eq(fixture.tables.files.id, input.fileId))
    ).toHaveLength(1);
    expect(
      await fixture.db
        .select()
        .from(fixture.tables.auditEntries)
        .where(eq(fixture.tables.auditEntries.action, 'media.upload'))
    ).toHaveLength(1);
  });

  it('re-reads the winner when Drizzle wraps PostgreSQL 23505 in error.cause', async () => {
    const fixture = await createResilienceFixture();
    const repository = new MediaWritesRepository(fixture.db);
    const input = uploadedMediaInput(fixture);
    const created = await repository.createUploadedMedia(input);
    if (created.status !== 'created')
      throw new Error('Expected created upload');

    const internals = repository as unknown as {
      createUploadedMediaOnce(
        value: UploadedMediaInput
      ): ReturnType<MediaWritesRepository['createUploadedMedia']>;
    };
    vi.spyOn(internals, 'createUploadedMediaOnce').mockRejectedValueOnce(
      Object.assign(new Error('Failed query'), {
        cause: Object.assign(
          new Error('duplicate key value violates unique constraint'),
          { code: '23505' }
        ),
      })
    );

    const replay = await repository.createUploadedMedia(input);
    if (replay.status !== 'existing')
      throw new Error('Expected existing replay');
    expect(replay.record.file.id).toBe(created.record.file.id);
  });
});

describe('upload completion retries (#149)', () => {
  it('keeps a sequential completion retry stable with one File row and intact bytes', async () => {
    const memory = createResilienceStorage();
    const fixture = await createResilienceFixture({ storage: memory.storage });
    const session = await fixture.createDirectUpload();

    const first = await completeDirectUpload(fixture, session);
    expect(first.status).toBe(201);
    const file = (await first.json()) as { data: { id: string } };
    const replay = await completeDirectUpload(fixture, session);
    expect(replay.status).toBe(409);
    expect(await replay.json()).toEqual({ error: 'Conflict' });
    expect(
      await fixture.db
        .select()
        .from(fixture.tables.files)
        .where(eq(fixture.tables.files.id, file.data.id))
    ).toHaveLength(1);
    const [row] = await fixture.db
      .select()
      .from(fixture.tables.files)
      .where(eq(fixture.tables.files.id, file.data.id));
    expect(memory.store.get(row!.storageKey!)).toEqual(PNG_BYTES);
    expect(
      [...memory.store.keys()].filter((key) => key.includes('.multipart/'))
    ).toEqual([]);
  });

  it('returns 409 for the loser of racing Node completions without duplicating or deleting bytes', async () => {
    const memory = createResilienceStorage();
    const barrier = barrierStorage(
      memory.storage,
      (key) => key.includes('/.multipart/') && key.endsWith('.json')
    );
    const fixture = await createResilienceFixture({
      storage: barrier.decorate(),
    });
    const session = await fixture.createDirectUpload();

    barrier.arm();
    const responses = await Promise.all([
      completeDirectUpload(fixture, session),
      completeDirectUpload(fixture, session),
    ]);
    barrier.disarm();

    expect(responses.map((response) => response.status).sort()).toEqual([
      201, 409,
    ]);
    const winner = responses.find((response) => response.status === 201)!;
    const loser = responses.find((response) => response.status === 409)!;
    expect(await loser.json()).toEqual({ error: 'Conflict' });
    const file = (await winner.json()) as { data: { id: string } };
    const files = await fixture.db.select().from(fixture.tables.files);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ id: file.data.id });
    expect(memory.store.get(files[0]!.storageKey!)).toEqual(PNG_BYTES);
    expect(
      [...memory.store.keys()].filter((key) => key.includes('.multipart/'))
    ).toEqual([]);
  });
});
