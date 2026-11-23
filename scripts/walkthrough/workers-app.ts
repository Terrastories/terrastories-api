/**
 * The walkthrough's stand-in migrated community on the real Workers build:
 * src/worker.ts bundled by esbuild and running in workerd through Miniflare
 * with D1 `DB` and R2 `MEDIA` (the same runtime as qa:personas:workers).
 * Used by the Workers walkthrough test and for local rehearsals. Credentials
 * are generated at runtime and returned in memory only. Pass `--d1` to the
 * walkthrough against it: D1 allows one committed import per UTC day.
 */
import { randomBytes } from 'node:crypto';
import { drizzle } from 'drizzle-orm/d1';
import { eq, sql } from 'drizzle-orm';
import { tablesFor } from '../../src/db/dialect.js';
import {
  applyD1Migrations,
  bundleWorkerModule,
  startWorkerRuntime,
} from '../../tests/helpers/worker-runtime.js';
import { WORKER_GATEWAY } from '../qa/workers-fixture.js';
import { seedStandIn } from './local-app.js';

export interface WorkersApp {
  baseUrl: string;
  community: string;
  bootstrapSecret: string;
  admin: { identifier: string; password: string };
  superAdmin: { identifier: string; password: string };
  env: Record<string, string>;
  close: () => Promise<void>;
}

export async function startWorkersApp(
  options: {
    /**
     * Give the stand-in community admin an active recovery code so the
     * recovery-code gate (SPEC-V2 §7) lets a --login-real-admin run through.
     * Default false: the admin is gated, as an untouched migrated admin is.
     */
    adminRecoveryCode?: boolean;
  } = {}
): Promise<WorkersApp> {
  const serverSecret = randomBytes(24).toString('hex');
  const bootstrapSecret = randomBytes(24).toString('hex');
  const script = await bundleWorkerModule(WORKER_GATEWAY);
  const mf = startWorkerRuntime(script, {
    ENVIRONMENT: 'test',
    AUTH_SERVER_SECRET: serverSecret,
    BOOTSTRAP_SECRET: bootstrapSecret,
  });
  try {
    const d1 = await mf.getD1Database('DB');
    await applyD1Migrations(d1);
    const db = drizzle(d1);
    const seeded = await seedStandIn(db);
    if (options.adminRecoveryCode)
      await db.run(
        sql`INSERT INTO login_codes (community_id, user_id, purpose, code_hash, created_by, created_at)
            SELECT community_id, id, 'recovery', 'seeded-recovery-' || id, id, 0
            FROM users WHERE role = 'admin' AND community_id IS NOT NULL`
      );
    // A migrated file: a story with a PNG whose D1 row and R2 object exist, so
    // the check can serve it publicly and, as the admin, through /v2/media/:id.
    const { communities, users, stories, files, attachments } = tablesFor(db);
    const [community] = await db
      .select()
      .from(communities)
      .where(eq(communities.slug, seeded.slug));
    const [adminRow] = await db
      .select()
      .from(users)
      .where(eq(users.username, seeded.admin.identifier));
    const [story] = await db
      .insert(stories)
      .values({
        title: 'Migrated story with media',
        slug: 'migrated-story-with-media',
        communityId: community.id,
        createdBy: adminRow.id,
      })
      .returning();
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const fileId = crypto.randomUUID();
    const key = `communities/${community.id}/${fileId}.png`;
    await db.insert(files).values({
      id: fileId,
      filename: `${fileId}.png`,
      originalName: 'migrated.png',
      path: key,
      storageKey: key,
      url: `/v2/media/${fileId}`,
      mimeType: 'image/png',
      size: png.length,
      byteSize: png.length,
      uploadedBy: adminRow.id,
      communityId: community.id,
      culturalRestrictions: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(attachments).values({
      communityId: community.id,
      fileId,
      ownerType: 'story',
      ownerId: story.id,
      role: 'story_media',
      ordinal: 0,
      createdAt: new Date(),
    });
    await (
      await mf.getR2Bucket('MEDIA')
    ).put(key, png, {
      httpMetadata: { contentType: 'image/png' },
    });
    const url = await mf.ready;
    return {
      baseUrl: url.origin,
      community: seeded.slug,
      bootstrapSecret,
      admin: seeded.admin,
      superAdmin: seeded.superAdmin,
      env: {
        WT_ADMIN_IDENTIFIER: seeded.admin.identifier,
        WT_ADMIN_PASSWORD: seeded.admin.password,
        WT_SUPER_IDENTIFIER: seeded.superAdmin.identifier,
        WT_SUPER_PASSWORD: seeded.superAdmin.password,
        WT_BOOTSTRAP_SECRET: bootstrapSecret,
        WT_D1: '1',
      },
      close: () => mf.dispose(),
    };
  } catch (error) {
    await mf.dispose().catch(() => undefined);
    throw error;
  }
}
