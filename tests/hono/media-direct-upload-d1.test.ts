/**
 * Real-D1 evidence for the direct-upload duplicate-insert backstop (#323).
 *
 * `MediaWritesRepository.createUploadedMedia` relies on the unique `files`
 * primary key as the concurrency arbiter and re-reads the committed winner
 * when the insert loses. The Node SQLite and PostgreSQL gates cover their
 * dialects; this test runs the same repository/service path against a real D1
 * database under workerd (Miniflare's `DB` binding), the Workers Free profile,
 * so a D1-only error shape cannot quietly turn the loser into a 500.
 */
import { expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/d1';
import {
  applyD1Migrations,
  startWorkerRuntime,
} from '../helpers/worker-runtime.js';
import { MediaWritesRepository } from '../../src/repositories/media-writes.repository.js';
import { MediaWritesService } from '../../src/services/media-writes.service.js';
import type { FoundationUser } from '../../src/repositories/hono-foundation.repository.js';
import type { FoundationStorage } from '../../src/services/hono-foundation.service.js';
import type { MediaCleanupCoordinator } from '../../src/services/media-cleanup.service.js';

it('resolves a duplicate File insert on real D1 to the winner row and a 409, without a second row', async () => {
  // Only the D1 binding matters here; the worker itself serves no route.
  const mf = startWorkerRuntime(
    "export default { fetch() { return new Response('ok'); } };"
  );
  try {
    const d1 = await mf.getD1Database('DB');
    await applyD1Migrations(d1);
    await d1.batch([
      d1.prepare(
        "INSERT INTO communities(id,name,slug,is_active,created_at,updated_at) VALUES(1,'Own','own',1,0,0)"
      ),
      d1.prepare(
        "INSERT INTO users(id,email,password_hash,first_name,last_name,role,community_id,is_active,created_at,updated_at) VALUES(1,'editor@own.test','verifier','Ed','Itor','editor',1,1,0,0)"
      ),
    ]);

    const repository = new MediaWritesRepository(drizzle(d1));
    const service = new MediaWritesService(
      repository,
      {} as unknown as FoundationStorage,
      {
        deleteStorageBestEffort: async () => undefined,
      } as unknown as MediaCleanupCoordinator
    );
    const actor: FoundationUser = {
      id: 1,
      email: 'editor@own.test',
      username: null,
      displayName: null,
      passwordHash: 'verifier',
      role: 'editor',
      communityId: 1,
    };
    const input = {
      actor,
      fileId: crypto.randomUUID(),
      storageKey: 'communities/1/media/direct-upload-d1',
      originalName: 'clip.mp4',
      mimeType: 'video/mp4',
      byteSize: 1024,
      checksum: null,
      binding: { userPhotoTargetUserId: null, metadata: null },
      origin: 'https://api.test',
    };

    const first = await service.registerStagedUpload(input);
    expect(first.status).toBe(201);

    // The loser reaches the insert while the winner's row already commits:
    // D1's unique violation is caught and mapped to the replay conflict.
    const loser = await service.registerStagedUpload(input);
    expect(loser.status).toBe(409);
    expect(loser.body).toEqual({ error: 'Conflict' });

    const count = await d1
      .prepare('SELECT COUNT(*) AS total FROM files WHERE id = ?')
      .bind(input.fileId)
      .first<{ total: number }>();
    expect(Number(count?.total)).toBe(1);
    const winner = await d1
      .prepare('SELECT storage_key FROM files WHERE id = ?')
      .bind(input.fileId)
      .first<{ storage_key: string }>();
    expect(winner?.storage_key).toBe(input.storageKey);
  } finally {
    await mf.dispose();
  }
}, 30000);
