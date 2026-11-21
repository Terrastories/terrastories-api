import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import { createHonoApp } from '../../src/hono-app.js';
import { createLocalStorage } from '../../src/node-storage.js';
import { HonoFoundationRepository } from '../../src/repositories/hono-foundation.repository.js';
import { CommunityExportRepository } from '../../src/repositories/community-export.repository.js';
import { CommunityExportService } from '../../src/services/community-export.service.js';
import { runMaintenanceSweeps } from '../../src/services/maintenance-sweeps.js';
import type { FoundationStorage } from '../../src/services/hono-foundation.service.js';
import { tablesFor } from '../../src/db/dialect.js';
import { deriveUserIdentityColumns } from '../../src/shared/utils/derived-columns.js';
import { CreateCommunityExportResponseSchema } from '../../src/shared/schemas/community-export.js';
import { parseDeterministicZip } from '../../src/shared/utils/deterministic-zip.js';
import {
  EXPORT_AUDIT_ACTIONS,
  EXPORT_GENERATION_STALE_MS,
  EXPORT_RATE_LIMIT_PER_ACCOUNT,
  EXPORT_RATE_LIMIT_PER_COMMUNITY,
  EXPORT_RATE_LIMIT_WINDOW_MS,
  EXPORT_TOKEN_TTL_MS,
} from '../../src/shared/export-policy.js';
import {
  argon2Seed,
  makeDerivedKey,
  makeServerSecret,
} from './auth-test-utils.js';

const API_ORIGIN = 'https://export.example.test';
const T0 = new Date('2026-11-21T10:00:00.000Z');

function createTestStorage() {
  const objects = new Map<string, Uint8Array>();
  const abortedUploads: Array<{ key: string; uploadId: string }> = [];
  let deleteFailureKey: string | null = null;
  let readBarrier: {
    key: string;
    onEnter: () => void;
    gate: Promise<void>;
  } | null = null;
  let putMultipartId: string | null = null;
  let failOnStreamReadKey: string | null = null;

  const storage: FoundationStorage = {
    async read(key, range) {
      if (readBarrier && key === readBarrier.key) {
        readBarrier.onEnter();
        await readBarrier.gate;
      }
      if (failOnStreamReadKey && key === failOnStreamReadKey) {
        return {
          size: 8,
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([1, 2]));
              controller.error(new Error('Simulated stream read error'));
            },
          }),
        };
      }
      const bytes = objects.get(key);
      if (!bytes) return null;
      return {
        body: range ? bytes.subarray(range.start, range.end + 1) : bytes,
        size: bytes.byteLength,
      };
    },
    async put(key, body, options) {
      if (options?.onMultipartUploadCreated && putMultipartId) {
        await options.onMultipartUploadCreated(putMultipartId);
      }
      if (body instanceof Uint8Array) {
        objects.set(key, Uint8Array.from(body));
        return { size: body.byteLength };
      }
      const reader = body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          total += value.byteLength;
        }
      }
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
      }
      objects.set(key, merged);
      return { size: merged.byteLength };
    },
    async delete(key) {
      if (deleteFailureKey && key === deleteFailureKey) {
        throw new Error('Simulated storage delete error');
      }
      objects.delete(key);
    },
    async abortMultipartUpload(key, uploadId) {
      abortedUploads.push({ key, uploadId });
    },
  };

  return {
    storage,
    objects,
    abortedUploads,
    setDeleteFailureKey: (key: string | null) => {
      deleteFailureKey = key;
    },
    setReadBarrier: (key: string, onEnter: () => void, gate: Promise<void>) => {
      readBarrier = { key, onEnter, gate };
    },
    clearReadBarrier: () => {
      readBarrier = null;
    },
    setPutMultipartId: (uploadId: string | null) => {
      putMultipartId = uploadId;
    },
    setFailOnStreamReadKey: (key: string | null) => {
      failOnStreamReadKey = key;
    },
  };
}

describe('Slice 13a community export endpoints', () => {
  const openDbs: Sqlite.Database[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (openDbs.length > 0) {
      openDbs.pop()?.close();
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  async function setupEnv(options: { isWorkers?: boolean } = {}) {
    const sqlite = new Sqlite(':memory:');
    sqlite.pragma('foreign_keys = ON');
    openDbs.push(sqlite);
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: 'src/db/migrations' });
    const tables = tablesFor(db);
    let currentTime = new Date(T0.getTime());
    const testStorage = createTestStorage();
    const serverSecret = makeServerSecret();

    const app = createHonoApp({
      repository: new HonoFoundationRepository(db),
      storage: testStorage.storage,
      serverSecret,
      isWorkers: options.isWorkers ?? false,
      now: () => currentTime,
      secureCookies: false,
    });

    db.insert(tables.communities)
      .values([
        {
          id: 1,
          name: 'Active Nation',
          slug: 'active-nation',
          publicStories: false,
          isActive: true,
          createdAt: T0,
          updatedAt: T0,
        },
        {
          id: 2,
          name: 'Disabled Nation',
          slug: 'disabled-nation',
          publicStories: true,
          isActive: false,
          createdAt: T0,
          updatedAt: T0,
        },
      ])
      .run();

    const derivedKey = makeDerivedKey();
    const creds = await argon2Seed(derivedKey);

    const seedUser = (
      id: number,
      email: string,
      username: string,
      role: 'admin' | 'editor' | 'member' | 'viewer' | 'super_admin',
      communityId: number | null
    ) => {
      db.insert(tables.users)
        .values({
          id,
          email,
          username,
          ...deriveUserIdentityColumns({ email, username }),
          firstName: role,
          lastName: 'User',
          ...creds,
          role,
          communityId,
          isActive: true,
          createdAt: T0,
          updatedAt: T0,
        })
        .run();
    };

    seedUser(1, 'admin1@c1.test', 'c1_admin1', 'admin', 1);
    seedUser(2, 'admin2@c1.test', 'c1_admin2', 'admin', 1);
    seedUser(3, 'editor@c1.test', 'c1_editor', 'editor', 1);
    seedUser(4, 'member@c1.test', 'c1_member', 'member', 1);
    seedUser(5, 'viewer@c1.test', 'c1_viewer', 'viewer', 1);
    seedUser(6, 'admin@c2.test', 'c2_admin', 'admin', 2);
    seedUser(7, 'super@sys.test', 'sys_super', 'super_admin', null);

    const file1Id = '11111111-1111-4111-8111-111111111111';
    const file1Key = `communities/1/${file1Id}.png`;
    const file1Bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const file1Checksum = createHash('sha256').update(file1Bytes).digest('hex');

    const file2Id = '22222222-2222-4222-8222-222222222222';
    const file2Key = `communities/2/${file2Id}.png`;
    const file2Bytes = new Uint8Array([9, 8, 7, 6]);
    const file2Checksum = createHash('sha256').update(file2Bytes).digest('hex');

    db.insert(tables.files)
      .values([
        {
          id: file1Id,
          filename: `${file1Id}.png`,
          originalName: 'c1.png',
          path: file1Key,
          storageKey: file1Key,
          url: `/v2/media/${file1Id}`,
          mimeType: 'image/png',
          size: file1Bytes.byteLength,
          byteSize: file1Bytes.byteLength,
          checksum: file1Checksum,
          communityId: 1,
          uploadedBy: 1,
          createdAt: T0,
          updatedAt: T0,
        },
        {
          id: file2Id,
          filename: `${file2Id}.png`,
          originalName: 'c2.png',
          path: file2Key,
          storageKey: file2Key,
          url: `/v2/media/${file2Id}`,
          mimeType: 'image/png',
          size: file2Bytes.byteLength,
          byteSize: file2Bytes.byteLength,
          checksum: file2Checksum,
          communityId: 2,
          uploadedBy: 6,
          createdAt: T0,
          updatedAt: T0,
        },
      ])
      .run();
    testStorage.objects.set(file1Key, file1Bytes);
    testStorage.objects.set(file2Key, file2Bytes);

    db.insert(tables.stories)
      .values([
        {
          id: 11,
          title: 'Active Restricted #162',
          slug: 'active-restricted-162',
          communityId: 1,
          createdBy: 1,
          isRestricted: true,
          privacyLevel: 'public',
          language: 'en',
          createdAt: T0,
          updatedAt: T0,
        },
        {
          id: 21,
          title: 'Disabled Restricted #162',
          slug: 'disabled-restricted-162',
          communityId: 2,
          createdBy: 6,
          isRestricted: true,
          privacyLevel: 'editors',
          language: 'en',
          createdAt: T0,
          updatedAt: T0,
        },
      ])
      .run();

    const loginAs = async (email: string) => {
      const res = await app.request(`${API_ORIGIN}/v2/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ identifier: email, derivedKey }),
      });
      expect(res.status).toBe(200);
      return res.headers.get('set-cookie')!.split(';')[0]!;
    };

    return {
      sqlite,
      db,
      tables,
      app,
      testStorage,
      file1Id,
      file1Key,
      file1Bytes,
      file2Id,
      file2Bytes,
      loginAs,
      setNow: (next: Date) => {
        currentTime = next;
      },
      advanceMs: (ms: number) => {
        currentTime = new Date(currentTime.getTime() + ms);
      },
    };
  }

  it('exports active & disabled communities identically, binds tokens to requesting admin, supports Range, and omits export-lifecycle audits for byte-identical re-export', async () => {
    const env = await setupEnv();
    const admin1Cookie = await env.loginAs('admin1@c1.test');
    const admin2Cookie = await env.loginAs('admin2@c1.test');
    const disabledAdminCookie = await env.loginAs('admin@c2.test');

    // First export for community 1
    const res1 = await env.app.request(`${API_ORIGIN}/v2/community/export`, {
      method: 'POST',
      headers: { cookie: admin1Cookie, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res1.status).toBe(201);
    const body1 = CreateCommunityExportResponseSchema.parse(await res1.json());

    const mRes1 = await env.app.request(
      `${API_ORIGIN}${body1.data.artifacts.manifest.downloadPath}`,
      { headers: { cookie: admin1Cookie } }
    );
    expect(mRes1.status).toBe(200);
    expect(mRes1.headers.get('cache-control')).toBe('no-store');
    expect(mRes1.headers.get('x-content-type-options')).toBe('nosniff');
    expect(mRes1.headers.get('content-security-policy')).toBe(
      "default-src 'none'; sandbox"
    );
    expect(mRes1.headers.get('content-disposition')).toBe(
      'attachment; filename="community-export-manifest.json"'
    );
    const manifestBytes1 = new Uint8Array(await mRes1.arrayBuffer());
    expect(createHash('sha256').update(manifestBytes1).digest('hex')).toBe(
      body1.data.artifacts.manifest.checksum
    );

    const zRes1 = await env.app.request(
      `${API_ORIGIN}${body1.data.artifacts.mediaZip.downloadPath}`,
      { headers: { cookie: admin1Cookie } }
    );
    expect(zRes1.status).toBe(200);
    expect(zRes1.headers.get('content-disposition')).toBe(
      'attachment; filename="community-export-media.zip"'
    );
    const zipBytes1 = new Uint8Array(await zRes1.arrayBuffer());
    expect(createHash('sha256').update(zipBytes1).digest('hex')).toBe(
      body1.data.artifacts.mediaZip.checksum
    );
    const entries1 = parseDeterministicZip(zipBytes1);
    expect(entries1).toHaveLength(1);
    expect(entries1[0]!.path).toBe(`media/${env.file1Id}`);
    expect(Array.from(entries1[0]!.data)).toEqual(Array.from(env.file1Bytes));

    // Byte-range download (206) and unsatisfiable range (416)
    const rangeRes = await env.app.request(
      `${API_ORIGIN}${body1.data.artifacts.mediaZip.downloadPath}`,
      { headers: { cookie: admin1Cookie, range: 'bytes=0-3' } }
    );
    expect(rangeRes.status).toBe(206);
    expect(rangeRes.headers.get('content-range')).toBe(
      `bytes 0-3/${zipBytes1.byteLength}`
    );
    const partialBytes = new Uint8Array(await rangeRes.arrayBuffer());
    expect(Array.from(partialBytes)).toEqual(Array.from(zipBytes1.slice(0, 4)));

    const badRangeRes = await env.app.request(
      `${API_ORIGIN}${body1.data.artifacts.mediaZip.downloadPath}`,
      { headers: { cookie: admin1Cookie, range: 'bytes=999999-' } }
    );
    expect(badRangeRes.status).toBe(416);

    // Second admin of SAME community & other community admin cannot use admin1's token (404).
    const sameCommOtherAdmin = await env.app.request(
      `${API_ORIGIN}${body1.data.artifacts.manifest.downloadPath}`,
      { headers: { cookie: admin2Cookie } }
    );
    expect(sameCommOtherAdmin.status).toBe(404);
    const otherCommAdmin = await env.app.request(
      `${API_ORIGIN}${body1.data.artifacts.manifest.downloadPath}`,
      { headers: { cookie: disabledAdminCookie } }
    );
    expect(otherCommAdmin.status).toBe(404);

    // Live audit log recorded request, generate, and downloads without IP/UA or tokens.
    const auditRows = env.db
      .select()
      .from(env.tables.auditEntries)
      .where(eq(env.tables.auditEntries.communityId, 1))
      .all();
    const exportAudits = auditRows.filter((row) =>
      row.action.startsWith('community.export.')
    );
    expect(exportAudits.map((a) => a.action)).toContain(
      EXPORT_AUDIT_ACTIONS.REQUEST
    );
    expect(exportAudits.map((a) => a.action)).toContain(
      EXPORT_AUDIT_ACTIONS.GENERATE
    );
    expect(exportAudits.map((a) => a.action)).toContain(
      EXPORT_AUDIT_ACTIONS.DOWNLOAD
    );
    for (const row of exportAudits) {
      expect(row.ipAddress).toBeNull();
      expect(row.userAgent).toBeNull();
    }

    // Re-export community 1: tokens differ, artifact bytes & checksums are identical.
    env.advanceMs(5_000);
    const res2 = await env.app.request(`${API_ORIGIN}/v2/community/export`, {
      method: 'POST',
      headers: { cookie: admin1Cookie },
    });
    expect(res2.status).toBe(201);
    const body2 = CreateCommunityExportResponseSchema.parse(await res2.json());
    expect(body2.data.exportId).not.toBe(body1.data.exportId);
    expect(body2.data.artifacts.manifest.token).not.toBe(
      body1.data.artifacts.manifest.token
    );
    expect(body2.data.artifacts.manifest.checksum).toBe(
      body1.data.artifacts.manifest.checksum
    );
    expect(body2.data.artifacts.mediaZip.checksum).toBe(
      body1.data.artifacts.mediaZip.checksum
    );

    const mRes2 = await env.app.request(
      `${API_ORIGIN}${body2.data.artifacts.manifest.downloadPath}`,
      { headers: { cookie: admin1Cookie } }
    );
    const manifestBytes2 = new Uint8Array(await mRes2.arrayBuffer());
    expect(
      Buffer.from(manifestBytes2).equals(Buffer.from(manifestBytes1))
    ).toBe(true);

    // Disabled community export works and includes #162 rows.
    const disabledRes = await env.app.request(
      `${API_ORIGIN}/v2/community/export`,
      {
        method: 'POST',
        headers: { cookie: disabledAdminCookie },
      }
    );
    expect(disabledRes.status).toBe(201);
    const disabledBody = CreateCommunityExportResponseSchema.parse(
      await disabledRes.json()
    );
    const disabledManifestRes = await env.app.request(
      `${API_ORIGIN}${disabledBody.data.artifacts.manifest.downloadPath}`,
      { headers: { cookie: disabledAdminCookie } }
    );
    expect(disabledManifestRes.status).toBe(200);
    const disabledManifest = JSON.parse(await disabledManifestRes.text()) as {
      community: { status: string };
      stories: Array<{
        id: number;
        isRestricted: boolean;
        privacyLevel: string;
      }>;
    };
    expect(disabledManifest.community.status).toBe('disabled');
    expect(disabledManifest.stories).toHaveLength(1);
    expect(disabledManifest.stories[0]!.isRestricted).toBe(true);
    expect(disabledManifest.stories[0]!.privacyLevel).toBe('editors');
  });

  it('rejects unauthenticated, non-admin, super_admin, and malformed requests cleanly', async () => {
    const env = await setupEnv();
    const adminCookie = await env.loginAs('admin1@c1.test');
    const editorCookie = await env.loginAs('editor@c1.test');
    const memberCookie = await env.loginAs('member@c1.test');
    const viewerCookie = await env.loginAs('viewer@c1.test');
    const superCookie = await env.loginAs('super@sys.test');

    // Unauthenticated
    expect(
      (
        await env.app.request(`${API_ORIGIN}/v2/community/export`, {
          method: 'POST',
        })
      ).status
    ).toBe(401);
    expect(
      (
        await env.app.request(
          `${API_ORIGIN}/v2/community/export/download/${'a'.repeat(64)}`
        )
      ).status
    ).toBe(401);

    // Non-admin & super_admin -> 403
    for (const cookie of [
      editorCookie,
      memberCookie,
      viewerCookie,
      superCookie,
    ]) {
      expect(
        (
          await env.app.request(`${API_ORIGIN}/v2/community/export`, {
            method: 'POST',
            headers: { cookie },
          })
        ).status
      ).toBe(403);
      expect(
        (
          await env.app.request(
            `${API_ORIGIN}/v2/community/export/download/${'a'.repeat(64)}`,
            { headers: { cookie } }
          )
        ).status
      ).toBe(403);
    }

    // Malformed bodies -> 400 / 415
    expect(
      (
        await env.app.request(`${API_ORIGIN}/v2/community/export`, {
          method: 'POST',
          headers: { cookie: adminCookie, 'content-type': 'text/plain' },
          body: 'hello',
        })
      ).status
    ).toBe(415);
    expect(
      (
        await env.app.request(`${API_ORIGIN}/v2/community/export`, {
          method: 'POST',
          headers: { cookie: adminCookie, 'content-type': 'application/json' },
          body: '{bad',
        })
      ).status
    ).toBe(400);
    expect(
      (
        await env.app.request(`${API_ORIGIN}/v2/community/export`, {
          method: 'POST',
          headers: { cookie: adminCookie, 'content-type': 'application/json' },
          body: JSON.stringify({ communityId: 2 }),
        })
      ).status
    ).toBe(400);

    // Malformed / unknown token -> 404
    expect(
      (
        await env.app.request(
          `${API_ORIGIN}/v2/community/export/download/not-a-hex-token`,
          { headers: { cookie: adminCookie } }
        )
      ).status
    ).toBe(404);
    expect(
      (
        await env.app.request(
          `${API_ORIGIN}/v2/community/export/download/${'f'.repeat(64)}`,
          { headers: { cookie: adminCookie } }
        )
      ).status
    ).toBe(404);
  });

  it('enforces single-active-generation lock with a real concurrency barrier', async () => {
    const env = await setupEnv();
    const admin1Cookie = await env.loginAs('admin1@c1.test');
    const admin2Cookie = await env.loginAs('admin2@c1.test');

    let enteredBarrier!: () => void;
    const barrierEntered = new Promise<void>((resolve) => {
      enteredBarrier = resolve;
    });
    let releaseBarrier!: () => void;
    const barrierReleased = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });

    env.testStorage.setReadBarrier(
      env.file1Key,
      enteredBarrier,
      barrierReleased
    );

    const firstPromise = env.app.request(`${API_ORIGIN}/v2/community/export`, {
      method: 'POST',
      headers: { cookie: admin1Cookie },
    });

    await barrierEntered;

    // Request #2 collides deterministically while Request #1 holds 'generating'.
    const secondRes = await env.app.request(
      `${API_ORIGIN}/v2/community/export`,
      {
        method: 'POST',
        headers: { cookie: admin2Cookie },
      }
    );
    expect(secondRes.status).toBe(409);
    expect(await secondRes.json()).toEqual({
      error: 'Export already in progress',
      code: 'export_in_progress',
    });

    releaseBarrier();
    const firstRes = await firstPromise;
    expect(firstRes.status).toBe(201);
  });

  it('counts failed generations against both account and community quotas', async () => {
    const env = await setupEnv();
    const cookie1 = await env.loginAs('admin1@c1.test');
    const cookie2 = await env.loginAs('admin2@c1.test');
    env.testStorage.setFailOnStreamReadKey(env.file1Key);
    for (let i = 0; i < EXPORT_RATE_LIMIT_PER_COMMUNITY; i += 1) {
      const cookie = i < EXPORT_RATE_LIMIT_PER_ACCOUNT ? cookie1 : cookie2;
      expect(
        (
          await env.app.request(`${API_ORIGIN}/v2/community/export`, {
            method: 'POST',
            headers: { cookie },
          })
        ).status
      ).toBe(503);
    }
    for (const cookie of [cookie1, cookie2]) {
      const res = await env.app.request(`${API_ORIGIN}/v2/community/export`, {
        method: 'POST',
        headers: { cookie },
      });
      expect(res.status).toBe(429);
      expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    }
  });

  it('cleans expired community exports even when a download token is malformed', async () => {
    const env = await setupEnv({ isWorkers: true });
    const cookie = await env.loginAs('admin1@c1.test');
    expect(
      (
        await env.app.request(`${API_ORIGIN}/v2/community/export`, {
          method: 'POST',
          headers: { cookie },
        })
      ).status
    ).toBe(201);
    env.advanceMs(EXPORT_TOKEN_TTL_MS);
    expect(
      (
        await env.app.request(
          `${API_ORIGIN}/v2/community/export/download/bad`,
          {
            headers: { cookie },
          }
        )
      ).status
    ).toBe(404);
    expect(
      [...env.testStorage.objects.keys()].filter((key) =>
        key.includes('/exports/')
      )
    ).toEqual([]);
  });

  it('expires Node artifacts without a download or subsequent export request', async () => {
    const env = await setupEnv();
    const cookie = await env.loginAs('admin1@c1.test');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      expect(
        (
          await env.app.request(`${API_ORIGIN}/v2/community/export`, {
            method: 'POST',
            headers: { cookie },
          })
        ).status
      ).toBe(201);
      env.advanceMs(EXPORT_TOKEN_TTL_MS);
      await vi.advanceTimersByTimeAsync(EXPORT_TOKEN_TTL_MS);
      expect(
        [...env.testStorage.objects.keys()].filter((key) =>
          key.includes('/exports/')
        )
      ).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects large descriptions in SQL before fetching or serializing the snapshot', async () => {
    const env = await setupEnv({ isWorkers: true });
    const repo = new CommunityExportRepository(env.db);
    env.db
      .update(env.tables.communities)
      .set({ description: '中'.repeat(20_000) })
      .where(eq(env.tables.communities.id, 1))
      .run();
    await expect(
      repo.readCommunityExportSnapshot(1, { maxBytes: 40_000 })
    ).rejects.toMatchObject({ limitName: 'maxManifestBytes' });
    const [actor] = await new HonoFoundationRepository(env.db).candidates(
      'admin1@c1.test'
    );
    const service = new CommunityExportService(repo, env.testStorage.storage, {
      isWorkers: true,
      now: () => T0,
      limits: { maxManifestBytes: 40_000 },
    });
    const res = await service.createExport(actor!);
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      code: 'export_limit_exceeded',
      error: expect.stringContaining('maxManifestBytes'),
    });
    expect(
      [...env.testStorage.objects.keys()].filter((key) =>
        key.includes('/exports/')
      )
    ).toEqual([]);
  });

  it('rejects thousands of long descriptions before materializing the snapshot', async () => {
    const env = await setupEnv({ isWorkers: true });
    const description = 'x'.repeat(20_000);
    const rows = Array.from({ length: 1000 }, (_, i) => ({
      communityId: 1,
      name: `Large place ${i}`,
      description,
      createdAt: T0,
      updatedAt: T0,
    }));
    for (let i = 0; i < rows.length; i += 20) {
      env.db
        .insert(env.tables.places)
        .values(rows.slice(i, i + 20))
        .run();
    }
    await expect(
      new CommunityExportRepository(env.db).readCommunityExportSnapshot(1, {
        maxRows: 10_000,
        maxBytes: 8 * 1024 * 1024,
      })
    ).rejects.toMatchObject({ limitName: 'maxManifestBytes' });
  });

  it('enforces per-account and per-community rate limits and resets after the window', async () => {
    const env = await setupEnv();
    const admin1Cookie = await env.loginAs('admin1@c1.test');
    const admin2Cookie = await env.loginAs('admin2@c1.test');

    // admin1 hits per-account limit (5)
    for (let i = 0; i < EXPORT_RATE_LIMIT_PER_ACCOUNT; i += 1) {
      const r = await env.app.request(`${API_ORIGIN}/v2/community/export`, {
        method: 'POST',
        headers: { cookie: admin1Cookie },
      });
      expect(r.status).toBe(201);
      env.advanceMs(1000);
    }

    const blockedAccount = await env.app.request(
      `${API_ORIGIN}/v2/community/export`,
      {
        method: 'POST',
        headers: { cookie: admin1Cookie },
      }
    );
    expect(blockedAccount.status).toBe(429);
    expect(Number(blockedAccount.headers.get('retry-after'))).toBeGreaterThan(
      0
    );

    // admin2 uses remaining community quota up to EXPORT_RATE_LIMIT_PER_COMMUNITY (8)
    for (
      let i = EXPORT_RATE_LIMIT_PER_ACCOUNT;
      i < EXPORT_RATE_LIMIT_PER_COMMUNITY;
      i += 1
    ) {
      const r = await env.app.request(`${API_ORIGIN}/v2/community/export`, {
        method: 'POST',
        headers: { cookie: admin2Cookie },
      });
      expect(r.status).toBe(201);
      env.advanceMs(1000);
    }

    const blockedCommunity = await env.app.request(
      `${API_ORIGIN}/v2/community/export`,
      {
        method: 'POST',
        headers: { cookie: admin2Cookie },
      }
    );
    expect(blockedCommunity.status).toBe(429);
    expect(Number(blockedCommunity.headers.get('retry-after'))).toBeGreaterThan(
      0
    );

    // Advance past the 1-hour window (re-login since standard session expires at 12h < 1h is fine)
    env.advanceMs(EXPORT_RATE_LIMIT_WINDOW_MS + 10_000);
    const afterWindow = await env.app.request(
      `${API_ORIGIN}/v2/community/export`,
      {
        method: 'POST',
        headers: { cookie: admin1Cookie },
      }
    );
    expect(afterWindow.status).toBe(201);
  });

  it('deletes artifacts on token expiry, retries failed cleanups restart-safely, and aborts multipart uploads on failure', async () => {
    const env = await setupEnv({ isWorkers: true });
    const admin1Cookie = await env.loginAs('admin1@c1.test');

    // 1. Expired download triggers immediate per-object deletion.
    const res1 = await env.app.request(`${API_ORIGIN}/v2/community/export`, {
      method: 'POST',
      headers: { cookie: admin1Cookie },
    });
    expect(res1.status).toBe(201);
    const body1 = CreateCommunityExportResponseSchema.parse(await res1.json());
    const manifestKey1 = `communities/1/exports/${body1.data.exportId}/manifest.json`;
    const zipKey1 = `communities/1/exports/${body1.data.exportId}/media.zip`;
    expect(env.testStorage.objects.has(manifestKey1)).toBe(true);
    expect(env.testStorage.objects.has(zipKey1)).toBe(true);

    // Simulate partial delete failure on first expiry attempt -> cleanedUpAt stays NULL.
    env.testStorage.setDeleteFailureKey(zipKey1);
    env.advanceMs(EXPORT_TOKEN_TTL_MS + 1000);
    const expiredAttempt = await env.app.request(
      `${API_ORIGIN}${body1.data.artifacts.manifest.downloadPath}`,
      { headers: { cookie: admin1Cookie } }
    );
    expect(expiredAttempt.status).toBe(404);
    expect(env.testStorage.objects.has(manifestKey1)).toBe(false);
    expect(env.testStorage.objects.has(zipKey1)).toBe(true);

    const repo = new CommunityExportRepository(env.db);
    const jobAfterPartialFail = await repo.findJobById(body1.data.exportId);
    expect(jobAfterPartialFail?.status).toBe('expired');
    expect(jobAfterPartialFail?.cleanedUpAt).toBeNull();

    // Restart-safe maintenance sweep retries when storage recovers and finishes cleanup.
    env.testStorage.setDeleteFailureKey(null);
    await runMaintenanceSweeps(env.db, {
      now: () => new Date(T0.getTime() + EXPORT_TOKEN_TTL_MS + 2000),
      storage: env.testStorage.storage,
    });
    expect(env.testStorage.objects.has(zipKey1)).toBe(false);
    const jobAfterSweep = await repo.findJobById(body1.data.exportId);
    expect(jobAfterSweep?.cleanedUpAt).not.toBeNull();

    // 2. Failing mid-stream during multipart generation aborts the upload id cleanly.
    env.testStorage.setPutMultipartId('upload-id-fail-123');
    env.testStorage.setFailOnStreamReadKey(env.file1Key);
    const failedRes = await env.app.request(
      `${API_ORIGIN}/v2/community/export`,
      {
        method: 'POST',
        headers: { cookie: admin1Cookie },
      }
    );
    expect(failedRes.status).toBe(503);
    expect(env.testStorage.abortedUploads).toHaveLength(1);
    expect(env.testStorage.abortedUploads[0]!.uploadId).toBe(
      'upload-id-fail-123'
    );
    env.testStorage.setFailOnStreamReadKey(null);
    env.testStorage.setPutMultipartId(null);

    // 3. Stale crashed 'generating' job is reclaimed & its multipart upload aborted.
    const crashedJobId = 'crashed-generating-job-1';
    const crashedZipKey = `communities/1/exports/${crashedJobId}/media.zip`;
    env.db
      .insert(env.tables.exportJobs)
      .values({
        id: crashedJobId,
        communityId: 1,
        requestedBy: 1,
        status: 'generating',
        manifestStorageKey: `communities/1/exports/${crashedJobId}/manifest.json`,
        zipStorageKey: crashedZipKey,
        zipUploadId: 'crashed-upload-id-999',
        createdAt: T0.getTime() - EXPORT_GENERATION_STALE_MS - 10_000,
        expiresAt: T0.getTime() + 60_000,
      })
      .run();

    const sweepSvc = new CommunityExportService(repo, env.testStorage.storage, {
      now: () => new Date(T0.getTime() + EXPORT_TOKEN_TTL_MS + 3000),
    });
    await sweepSvc.cleanupExpiredExports();
    expect(
      env.testStorage.abortedUploads.some(
        (u) => u.uploadId === 'crashed-upload-id-999'
      )
    ).toBe(true);
    const reclaimedJob = await repo.findJobById(crashedJobId);
    expect(reclaimedJob?.status).toBe('failed');
    expect(reclaimedJob?.zipUploadId).toBeNull();
  });

  it('fails closed with 422 naming profile limit and self-hosted/field-kit alternative when Workers Free limit is exceeded', async () => {
    const env = await setupEnv({ isWorkers: true });
    const admin1Cookie = await env.loginAs('admin1@c1.test');

    // Insert 30 more files -> 31 total > WORKERS_EXPORT_MAX_FILES (30)
    for (let i = 0; i < 30; i += 1) {
      const id = `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`;
      const key = `communities/1/${id}.png`;
      env.db
        .insert(env.tables.files)
        .values({
          id,
          filename: `${id}.png`,
          originalName: `${i}.png`,
          path: key,
          storageKey: key,
          url: `/v2/media/${id}`,
          mimeType: 'image/png',
          size: 2,
          byteSize: 2,
          checksum: createHash('sha256')
            .update(new Uint8Array([i, i]))
            .digest('hex'),
          communityId: 1,
          uploadedBy: 1,
          createdAt: T0,
          updatedAt: T0,
        })
        .run();
      env.testStorage.objects.set(key, new Uint8Array([i, i]));
    }

    const res = await env.app.request(`${API_ORIGIN}/v2/community/export`, {
      method: 'POST',
      headers: { cookie: admin1Cookie },
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe('export_limit_exceeded');
    expect(body.error).toContain('maxFiles');
    expect(body.error).toContain('self-hosted or field-kit');

    // No export artifacts leaked in storage.
    for (const key of env.testStorage.objects.keys()) {
      expect(key).not.toContain('/exports/');
    }
  });

  it('fences stale-job cleanup against concurrent export completion in both race directions', async () => {
    // Case (a): cleanup reclaims stale 'generating' job before completion lands -> 409 & zero leaks.
    const envA = await setupEnv({ isWorkers: true });
    const adminACookie = await envA.loginAs('admin1@c1.test');

    let enteredA!: () => void;
    const barrierEnteredA = new Promise<void>((resolve) => {
      enteredA = resolve;
    });
    let releaseA!: () => void;
    const barrierReleasedA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    envA.testStorage.setPutMultipartId('upload-race-stale-a');
    envA.testStorage.setReadBarrier(envA.file1Key, enteredA, barrierReleasedA);

    const exportPromiseA = envA.app.request(
      `${API_ORIGIN}/v2/community/export`,
      {
        method: 'POST',
        headers: { cookie: adminACookie },
      }
    );
    await barrierEnteredA;

    envA.advanceMs(EXPORT_GENERATION_STALE_MS + 5_000);
    const repoA = new CommunityExportRepository(envA.db);
    const svcA = new CommunityExportService(repoA, envA.testStorage.storage, {
      isWorkers: true,
      now: () => new Date(T0.getTime() + EXPORT_GENERATION_STALE_MS + 5_000),
    });
    const sweepA = await svcA.cleanupExpiredExports();
    expect(sweepA).toEqual({ cleanedCount: 1, failedCount: 0 });
    expect(
      envA.testStorage.abortedUploads.some(
        (u) => u.uploadId === 'upload-race-stale-a'
      )
    ).toBe(true);

    const staleJob = envA.db.select().from(envA.tables.exportJobs).get()!;
    expect(staleJob.cleanedUpAt).toBeNull();
    envA.testStorage.setDeleteFailureKey(staleJob.zipStorageKey);
    envA.testStorage.clearReadBarrier();
    releaseA();
    const resA = await exportPromiseA;
    expect(resA.status).toBe(409);

    expect((await repoA.findJobById(staleJob.id))?.cleanedUpAt).toBeNull();
    expect(envA.testStorage.objects.has(staleJob.zipStorageKey!)).toBe(true);
    envA.testStorage.setDeleteFailureKey(null);
    await svcA.cleanupExpiredExports();
    expect((await repoA.findJobById(staleJob.id))?.cleanedUpAt).not.toBeNull();
    for (const key of envA.testStorage.objects.keys()) {
      expect(key).not.toContain('/exports/');
    }
    const tokensA = envA.db.select().from(envA.tables.exportTokens).all();
    expect(tokensA).toHaveLength(0);

    // Case (b): stale 'generating' candidate finishes to 'ready' before cleanup claims -> skipped & artifacts stay downloadable.
    const envB = await setupEnv();
    const adminBCookie = await envB.loginAs('admin1@c1.test');

    let enteredB!: () => void;
    const barrierEnteredB = new Promise<void>((resolve) => {
      enteredB = resolve;
    });
    let releaseB!: () => void;
    const barrierReleasedB = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    envB.testStorage.setReadBarrier(envB.file1Key, enteredB, barrierReleasedB);

    const exportPromiseB = envB.app.request(
      `${API_ORIGIN}/v2/community/export`,
      {
        method: 'POST',
        headers: { cookie: adminBCookie },
      }
    );
    await barrierEnteredB;

    envB.advanceMs(EXPORT_GENERATION_STALE_MS + 5_000);
    const repoB = new CommunityExportRepository(envB.db);
    const origClaim = repoB.claimJobForCleanup.bind(repoB);
    let exportCompletedB: Awaited<typeof exportPromiseB> | null = null;
    repoB.claimJobForCleanup = async (input) => {
      // Let export complete to 'ready' right between discovery and claim.
      envB.testStorage.clearReadBarrier();
      releaseB();
      exportCompletedB = await exportPromiseB;
      return origClaim(input);
    };

    const svcB = new CommunityExportService(repoB, envB.testStorage.storage, {
      now: () => new Date(T0.getTime() + EXPORT_GENERATION_STALE_MS + 5_000),
    });
    const sweepB = await svcB.cleanupExpiredExports();
    expect(sweepB).toEqual({ cleanedCount: 0, failedCount: 0 });
    expect(exportCompletedB).not.toBeNull();
    expect(exportCompletedB!.status).toBe(201);

    const payloadB = CreateCommunityExportResponseSchema.parse(
      await exportCompletedB!.json()
    );
    const downloadManifestB = await envB.app.request(
      `${API_ORIGIN}${payloadB.data.artifacts.manifest.downloadPath}`,
      { headers: { cookie: adminBCookie } }
    );
    expect(downloadManifestB.status).toBe(200);
    const downloadZipB = await envB.app.request(
      `${API_ORIGIN}${payloadB.data.artifacts.mediaZip.downloadPath}`,
      { headers: { cookie: adminBCookie } }
    );
    expect(downloadZipB.status).toBe(200);
  });

  it('prevents a sweep paused between delete and markJobCleanedUp from marking cleaned after a reclaimed writer writes and fails cleanup', async () => {
    const env = await setupEnv({ isWorkers: true });
    const adminCookie = await env.loginAs('admin1@c1.test');

    let entered!: () => void;
    const barrierEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let releaseWriter!: () => void;
    const barrierReleased = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });

    env.testStorage.setPutMultipartId('upload-pause-between-delete-and-mark');
    env.testStorage.setReadBarrier(env.file1Key, entered, barrierReleased);

    const exportPromise = env.app.request(`${API_ORIGIN}/v2/community/export`, {
      method: 'POST',
      headers: { cookie: adminCookie },
    });
    await barrierEntered;

    const sweepTimeMs = T0.getTime() + EXPORT_GENERATION_STALE_MS + 5_000;
    env.advanceMs(EXPORT_GENERATION_STALE_MS + 5_000);
    const repo = new CommunityExportRepository(env.db);
    const svc = new CommunityExportService(repo, env.testStorage.storage, {
      isWorkers: true,
      now: () => new Date(sweepTimeMs),
    });

    let markEntered!: () => void;
    const markEnteredPromise = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    let releaseMark!: () => void;
    const markReleasedPromise = new Promise<void>((resolve) => {
      releaseMark = resolve;
    });
    const origMark = repo.markJobCleanedUp.bind(repo);
    let pauseFirstMark = true;
    repo.markJobCleanedUp = async (input) => {
      if (pauseFirstMark) {
        pauseFirstMark = false;
        markEntered();
        await markReleasedPromise;
      }
      return origMark(input);
    };

    const sweep1Promise = svc.cleanupExpiredExports();
    await markEnteredPromise;

    expect(
      env.testStorage.abortedUploads.some(
        (u) => u.uploadId === 'upload-pause-between-delete-and-mark'
      )
    ).toBe(true);
    const staleJob = env.db.select().from(env.tables.exportJobs).get()!;
    expect(staleJob.status).toBe('failed');
    expect(staleJob.completedAt).toBeNull();
    expect(staleJob.cleanedUpAt).toBeNull();
    expect(env.testStorage.objects.has(staleJob.manifestStorageKey!)).toBe(
      false
    );
    expect(env.testStorage.objects.has(staleJob.zipStorageKey!)).toBe(false);

    // Reclaimed writer finishes writing artifacts, fails to delete the ZIP,
    // and acknowledges failure via failExportJob while Sweep 1 is paused.
    env.testStorage.setDeleteFailureKey(staleJob.zipStorageKey);
    env.testStorage.clearReadBarrier();
    releaseWriter();
    const res = await exportPromise;
    expect(res.status).toBe(409);
    expect(env.testStorage.objects.has(staleJob.zipStorageKey!)).toBe(true);
    const afterWriterFail = await repo.findJobById(staleJob.id);
    expect(afterWriterFail?.completedAt).not.toBeNull();
    expect(afterWriterFail?.cleanedUpAt).toBeNull();

    // Resumed Sweep 1 must fail the completedAt generation guard so it does
    // not mark cleanedUpAt over the leftover artifact.
    releaseMark();
    const sweep1Result = await sweep1Promise;
    expect(sweep1Result).toEqual({ cleanedCount: 0, failedCount: 0 });
    expect((await repo.findJobById(staleJob.id))?.cleanedUpAt).toBeNull();
    expect(env.testStorage.objects.has(staleJob.zipStorageKey!)).toBe(true);

    const pendingCleanup = await repo.findJobsNeedingCleanup({
      nowMs: sweepTimeMs + 1_000,
      staleBeforeMs: T0.getTime() + 10_000,
      limit: 10,
    });
    expect(pendingCleanup.map((job) => job.id)).toContain(staleJob.id);

    // Subsequent Sweep 2 deletes the leftover ZIP and marks cleanedUpAt.
    env.testStorage.setDeleteFailureKey(null);
    const sweep2Result = await svc.cleanupExpiredExports();
    expect(sweep2Result).toEqual({ cleanedCount: 1, failedCount: 0 });
    expect((await repo.findJobById(staleJob.id))?.cleanedUpAt).not.toBeNull();
    for (const key of env.testStorage.objects.keys()) {
      expect(key).not.toContain('/exports/');
    }
    expect(env.db.select().from(env.tables.exportTokens).all()).toHaveLength(0);
  });

  it('streams local filesystem archive on Node, supports Range 206, and deletes disk files on expiry', async () => {
    const storageDir = await mkdtemp(path.join(tmpdir(), 'ts-export-node-'));
    tempDirs.push(storageDir);
    const localStorage = await createLocalStorage(storageDir);

    const sqlite = new Sqlite(':memory:');
    sqlite.pragma('foreign_keys = ON');
    openDbs.push(sqlite);
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: 'src/db/migrations' });
    const tables = tablesFor(db);
    let currentTime = new Date(T0.getTime());

    const app = createHonoApp({
      repository: new HonoFoundationRepository(db),
      storage: localStorage,
      serverSecret: makeServerSecret(),
      isWorkers: false,
      now: () => currentTime,
      secureCookies: false,
    });

    db.insert(tables.communities)
      .values({
        id: 1,
        name: 'Node Local Nation',
        slug: 'node-local-nation',
        publicStories: false,
        isActive: true,
        createdAt: T0,
        updatedAt: T0,
      })
      .run();

    const derivedKey = makeDerivedKey();
    const creds = await argon2Seed(derivedKey);
    db.insert(tables.users)
      .values({
        id: 1,
        email: 'nodeadmin@c1.test',
        username: 'node_admin',
        ...deriveUserIdentityColumns({
          email: 'nodeadmin@c1.test',
          username: 'node_admin',
        }),
        firstName: 'Node',
        lastName: 'Admin',
        ...creds,
        role: 'admin',
        communityId: 1,
        isActive: true,
        createdAt: T0,
        updatedAt: T0,
      })
      .run();

    const fileId = '33333333-3333-4333-8333-333333333333';
    const fileKey = `communities/1/${fileId}.bin`;
    const fileBytes = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);
    const fileChecksum = createHash('sha256').update(fileBytes).digest('hex');
    await localStorage.put!(fileKey, fileBytes);
    db.insert(tables.files)
      .values({
        id: fileId,
        filename: `${fileId}.bin`,
        originalName: 'local.bin',
        path: fileKey,
        storageKey: fileKey,
        url: `/v2/media/${fileId}`,
        mimeType: 'application/octet-stream',
        size: fileBytes.byteLength,
        byteSize: fileBytes.byteLength,
        checksum: fileChecksum,
        communityId: 1,
        uploadedBy: 1,
        createdAt: T0,
        updatedAt: T0,
      })
      .run();

    const loginRes = await app.request(`${API_ORIGIN}/v2/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: 'nodeadmin@c1.test', derivedKey }),
    });
    expect(loginRes.status).toBe(200);
    const cookie = loginRes.headers.get('set-cookie')!.split(';')[0]!;

    const exportRes = await app.request(`${API_ORIGIN}/v2/community/export`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(exportRes.status).toBe(201);
    const payload = CreateCommunityExportResponseSchema.parse(
      await exportRes.json()
    );

    const manifestKey = `communities/1/exports/${payload.data.exportId}/manifest.json`;
    const zipKey = `communities/1/exports/${payload.data.exportId}/media.zip`;
    expect(await localStorage.read(manifestKey)).not.toBeNull();
    expect(await localStorage.read(zipKey)).not.toBeNull();

    const fullZipRes = await app.request(
      `${API_ORIGIN}${payload.data.artifacts.mediaZip.downloadPath}`,
      { headers: { cookie } }
    );
    expect(fullZipRes.status).toBe(200);
    const fullZipBytes = new Uint8Array(await fullZipRes.arrayBuffer());
    expect(createHash('sha256').update(fullZipBytes).digest('hex')).toBe(
      payload.data.artifacts.mediaZip.checksum
    );
    const parsedZip = parseDeterministicZip(fullZipBytes);
    expect(parsedZip).toHaveLength(1);
    expect(Array.from(parsedZip[0]!.data)).toEqual(Array.from(fileBytes));

    const rangeRes = await app.request(
      `${API_ORIGIN}${payload.data.artifacts.mediaZip.downloadPath}`,
      { headers: { cookie, range: 'bytes=0-3' } }
    );
    expect(rangeRes.status).toBe(206);
    expect(Array.from(new Uint8Array(await rangeRes.arrayBuffer()))).toEqual(
      Array.from(fullZipBytes.slice(0, 4))
    );

    // Expire token and confirm disk files are deleted while master media stays intact.
    currentTime = new Date(T0.getTime() + EXPORT_TOKEN_TTL_MS + 1000);
    const expiredRes = await app.request(
      `${API_ORIGIN}${payload.data.artifacts.manifest.downloadPath}`,
      { headers: { cookie } }
    );
    expect(expiredRes.status).toBe(404);
    expect(await localStorage.read(manifestKey)).toBeNull();
    expect(await localStorage.read(zipKey)).toBeNull();
    expect(await localStorage.read(fileKey)).not.toBeNull();
  });
});
