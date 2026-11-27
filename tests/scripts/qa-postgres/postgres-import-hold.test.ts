/**
 * #282: two previews race for one staged upload on PostgreSQL.
 *
 * PostgreSQL is the only backend where two previews can reach the hold at the
 * same time through row locks and the per-community advisory lock: SQLite
 * serializes writers and D1 runs one batch per request. Both requests here
 * have resolved the declared upload as adoptable before either transaction
 * starts, so the loser must roll back everything it wrote and leave the
 * upload held by exactly one preview.
 *
 * Gated like the persona wrappers: it resets the shared test database, so it
 * runs only under `npm run qa:personas:postgres` against a ready target.
 */
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  decidePostgresPersonaQa,
  openPersonaQaDatabase,
} from '../../../scripts/qa/qa-database.js';
import { tablesFor } from '../../../src/db/dialect.js';
import { createHonoApp } from '../../../src/hono-app.js';
import { HonoFoundationRepository } from '../../../src/repositories/hono-foundation.repository.js';
import { MediaCleanupCoordinator } from '../../../src/services/media-cleanup.service.js';
import type { FoundationStorage } from '../../../src/services/hono-foundation.service.js';
import { deriveUserIdentityColumns } from '../../../src/shared/utils/derived-columns.js';
import { ImportManifestDetailResponseSchema } from '../../../src/shared/schemas/imports.js';
import { MediaUploadResponseSchema } from '../../../src/shared/schemas/media-v2.js';
import { assertPutSha256, rawUploadRequest } from '../../helpers/raw-upload.js';
import {
  argon2Seed,
  makeDerivedKey,
  makeServerSecret,
} from '../../hono/auth-test-utils.js';

// Module scope: resolve before any hook could rewrite the environment, so the
// wrapper always reports what the operator actually configured.
const decision = decidePostgresPersonaQa(
  process.env.QA_PERSONAS_POSTGRES,
  process.env.QA_POSTGRES_URL,
  process.env.ALLOW_POSTGRES_TEST_RESET
);

const API_ORIGIN = 'https://api.example.test';
const CLIENT_ORIGIN = 'https://app.example.test';
const APP_NOW = new Date('2026-06-15T12:00:00.000Z');
const DERIVED_KEY = makeDerivedKey();
const NOT_FOUND = { error: 'Not found' };

const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06,
  0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
]);

/**
 * In-memory bytes with a hook after each source CSV is stored: that put is
 * the last write before a preview's transaction, so the hook is where two
 * previews can be held until both have resolved their uploads.
 */
function createRacingMemoryStorage(onSourceCsvStored: () => Promise<void>): {
  store: Map<string, Uint8Array>;
  storage: FoundationStorage;
} {
  const store = new Map<string, Uint8Array>();
  const storage: FoundationStorage = {
    async read(storageKey, range) {
      const bytes = store.get(storageKey);
      if (!bytes) return null;
      return {
        size: bytes.byteLength,
        body: range ? bytes.subarray(range.start, range.end + 1) : bytes,
      };
    },
    async put(storageKey, body, opts) {
      const bytes =
        body instanceof Uint8Array
          ? body
          : await new Response(body)
              .arrayBuffer()
              .then((buffer) => new Uint8Array(buffer));
      assertPutSha256(bytes, opts?.sha256);
      store.set(storageKey, bytes);
      if (storageKey.includes('/imports/')) await onSourceCsvStored();
      return { size: bytes.byteLength };
    },
    async delete(storageKey) {
      store.delete(storageKey);
    },
  };
  return { store, storage };
}

type App = ReturnType<typeof createHonoApp>;

/** `POST /v2/imports/preview` with one place that references `stagedId`. */
function postPreview(
  app: App,
  cookie: string,
  csvFilename: string,
  placeName: string,
  stagedId: string
): Promise<Response> {
  const boundary = `pg-staged-${Math.random().toString(16).slice(2)}`;
  const enc = new TextEncoder();
  const body = new Uint8Array(
    Buffer.concat([
      enc.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\nplaces\r\n`
      ),
      enc.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="mediaFileIds"\r\n\r\n${JSON.stringify(
          [stagedId]
        )}\r\n`
      ),
      enc.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${csvFilename}"\r\nContent-Type: text/csv\r\n\r\n`
      ),
      enc.encode(`name,photo\n${placeName},${stagedId}\n`),
      enc.encode(`\r\n--${boundary}--\r\n`),
    ])
  );
  return app.request(`${API_ORIGIN}/v2/imports/preview`, {
    method: 'POST',
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      origin: CLIENT_ORIGIN,
      cookie,
    },
    body,
  });
}

describe(
  decision.run
    ? 'Import preview holds a staged upload for exactly one preview (PostgreSQL)'
    : `Import preview holds a staged upload for exactly one preview (PostgreSQL) — skipped: ${decision.reason}`,
  () => {
    // A run whose target is not ready fails closed instead of skipping green.
    it.skipIf(!decision.run)(
      'lets exactly one of two concurrent previews hold the same staged upload',
      async () => {
        if (decision.target.status !== 'ready')
          throw new Error(
            `qa:personas:postgres requires a PostgreSQL target: ${decision.target.reason}`
          );
        // Resets and re-migrates the shared test database, like the persona
        // wrappers.
        const qa = await openPersonaQaDatabase();
        try {
          const db = qa.db;
          const tables = tablesFor(db);
          const [community] = await db
            .insert(tables.communities)
            .values({
              name: 'PG Staged Import',
              description: 'Import staged-media hold race',
              slug: `pg-staged-import-${Date.now()}`,
              publicStories: false,
              locale: 'en',
              isActive: true,
              createdAt: APP_NOW,
              updatedAt: APP_NOW,
            })
            .returning({
              id: tables.communities.id,
              slug: tables.communities.slug,
            });
          const email = 'pg-staged-editor@example.test';
          const username = 'pg_staged_editor';
          await db.insert(tables.users).values({
            email,
            username,
            displayName: 'PG Staged',
            ...deriveUserIdentityColumns({ email, username }),
            ...(await argon2Seed(DERIVED_KEY)),
            firstName: 'PG',
            lastName: 'Staged',
            role: 'editor',
            communityId: community.id,
            isActive: true,
          });

          let arrived = 0;
          let release!: () => void;
          const bothStored = new Promise<void>((resolve) => {
            release = resolve;
          });
          let racing = false;
          const { store, storage } = createRacingMemoryStorage(async () => {
            if (!racing) return;
            arrived += 1;
            if (arrived >= 2) {
              racing = false;
              release();
            } else {
              await bothStored;
            }
          });
          const app = createHonoApp({
            repository: new HonoFoundationRepository(db),
            storage,
            mediaCleanup: new MediaCleanupCoordinator(db, storage, {
              now: () => APP_NOW,
            }),
            publicOrigin: API_ORIGIN,
            corsOrigins: [CLIENT_ORIGIN],
            secureCookies: false,
            serverSecret: makeServerSecret(),
            now: () => APP_NOW,
          });

          const login = await app.request(`${API_ORIGIN}/v2/auth/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              identifier: email,
              communitySlug: community.slug,
              derivedKey: DERIVED_KEY,
            }),
          });
          expect(login.status).toBe(200);
          const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;

          const upload = rawUploadRequest({
            filename: 'contested-pic.png',
            contentType: 'image/png',
            bytes: PNG_BYTES,
          });
          const staged = await app.request(
            `${API_ORIGIN}/v2/media${upload.search}`,
            {
              method: 'POST',
              headers: { ...upload.headers, cookie, origin: CLIENT_ORIGIN },
              body: upload.body,
            }
          );
          expect(staged.status).toBe(201);
          const contestedId = MediaUploadResponseSchema.parse(
            await staged.json()
          ).data.id;
          const keysWithUpload = store.size;

          racing = true;
          const [raceA, raceB] = await Promise.all([
            postPreview(app, cookie, 'race-a.csv', 'Race Place A', contestedId),
            postPreview(app, cookie, 'race-b.csv', 'Race Place B', contestedId),
          ]);
          const statuses = [raceA.status, raceB.status].sort((a, b) => a - b);
          expect(statuses).toEqual([201, 404]);
          const loser = raceA.status === 404 ? raceA : raceB;
          const winner = raceA.status === 201 ? raceA : raceB;
          expect(await loser.json()).toEqual(NOT_FOUND);
          expect(
            ImportManifestDetailResponseSchema.parse(await winner.json()).data
              .stagedMediaCount
          ).toBe(1);

          const manifests = await db
            .select({
              status: tables.importManifests.status,
              stagedFileIds: tables.importManifests.stagedFileIds,
            })
            .from(tables.importManifests);
          expect(manifests).toHaveLength(1);
          expect(manifests[0]?.status).toBe('previewed');
          const stagedIds: unknown = manifests[0]?.stagedFileIds;
          expect(
            typeof stagedIds === 'string' ? JSON.parse(stagedIds) : stagedIds
          ).toEqual([contestedId]);

          const previewAudits = await db
            .select({ id: tables.auditEntries.id })
            .from(tables.auditEntries)
            .where(eq(tables.auditEntries.action, 'import.preview'));
          expect(previewAudits).toHaveLength(1);

          // The loser's source CSV row was rolled back: the upload and the
          // winner's CSV are the only file rows, and its bytes were deleted.
          const fileRows = await db
            .select({
              id: tables.files.id,
              isActive: tables.files.isActive,
              path: tables.files.path,
            })
            .from(tables.files);
          expect(fileRows).toHaveLength(2);
          expect(fileRows.find((row) => row.id === contestedId)?.isActive).toBe(
            false
          );
          expect(
            fileRows.filter((row) => row.path.includes('/imports/'))
          ).toHaveLength(1);
          expect(store.size).toBe(keysWithUpload + 1);
        } finally {
          await qa.close();
        }
      },
      // Same generous bound as the persona wrappers: the race is bounded by
      // the advisory lock, not by the network.
      120000
    );
  }
);
