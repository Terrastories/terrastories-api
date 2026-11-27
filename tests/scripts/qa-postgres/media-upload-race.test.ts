/**
 * Issue #149, PostgreSQL evidence: the upload insert backstop must recover
 * from a real unique violation (SQLSTATE 23505), not only from a SQLite-shaped
 * error. Runs only under the PostgreSQL QA gate and skips without it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  decidePostgresPersonaQa,
  openPersonaQaDatabase,
  type PersonaQaDatabase,
} from '../../../scripts/qa/qa-database.js';
import { tablesFor } from '../../../src/db/dialect.js';
import { MediaWritesRepository } from '../../../src/repositories/media-writes.repository.js';
import { deriveUserIdentityColumns } from '../../../src/shared/utils/derived-columns.js';

// Module scope: resolve before any hook rewrites the environment. The gate
// marker and QA_POSTGRES_URL are the same ones the persona wrappers use.
const decision = decidePostgresPersonaQa(
  process.env.QA_PERSONAS_POSTGRES,
  process.env.QA_POSTGRES_URL,
  process.env.ALLOW_POSTGRES_TEST_RESET
);

const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);

describe(
  decision.run
    ? 'Upload insert race backstop (PostgreSQL)'
    : `Upload insert race backstop (PostgreSQL) — skipped: ${decision.reason}`,
  () => {
    let database: PersonaQaDatabase | null = null;
    let repository: MediaWritesRepository;
    let input: Parameters<MediaWritesRepository['createUploadedMedia']>[0];

    beforeAll(async () => {
      if (!decision.run) return;
      database = await openPersonaQaDatabase();
      if (database.dialect !== 'postgresql')
        throw new Error('Expected the PostgreSQL QA database');
      const fixtures = await database.seed();
      const tables = tablesFor(database.db);
      const communityId = fixtures.communities[0]!.id;
      const now = new Date();
      const identity = deriveUserIdentityColumns({
        email: 'pg-race@example.test',
        username: 'pg_race',
      });
      const [user] = await database.db
        .insert(tables.users)
        .values({
          email: 'pg-race@example.test',
          username: 'pg_race',
          ...identity,
          passwordHash: 'unused',
          firstName: 'Race',
          lastName: 'Tester',
          role: 'editor',
          communityId,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      repository = new MediaWritesRepository(database.db);
      const fileId = crypto.randomUUID();
      input = {
        fileId,
        actor: {
          id: user.id,
          email: 'pg-race@example.test',
          username: 'pg_race',
          displayName: 'Race Tester',
          passwordHash: 'unused',
          role: 'editor',
          communityId,
        },
        storageKey: `communities/${communityId}/media/${fileId}`,
        originalName: 'race.png',
        mimeType: 'image/png',
        byteSize: PNG_BYTES.byteLength,
        checksum: null,
        metadata: null,
        userPhotoTargetUserId: null,
      };
    });

    afterAll(async () => {
      await database?.close();
    });

    it.skipIf(!decision.run)(
      'recovers the committed winner after a real 23505 unique violation',
      async () => {
        const created = await repository.createUploadedMedia(input);
        expect(created.status).toBe('created');
        const replay = await repository.createUploadedMedia(input);
        expect(replay.status).toBe('existing');
        if (created.status !== 'created' || replay.status !== 'existing')
          throw new Error('Expected one created upload and one replay');
        expect(replay.record.file.id).toBe(created.record.file.id);

        const tables = tablesFor(database!.db);
        const rows = await database!.db
          .select()
          .from(tables.files)
          .where(eq(tables.files.id, input.fileId));
        expect(rows).toHaveLength(1);
      },
      30000
    );
  }
);
