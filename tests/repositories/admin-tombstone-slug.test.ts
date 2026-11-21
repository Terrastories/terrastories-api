import { expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { AdminRepository } from '../../src/repositories/admin.repository.js';
import {
  communitiesPg,
  usersPg,
  auditEntriesPg,
} from '../../src/db/schema/index.js';
import { deriveBootstrapSlug } from '../../src/services/bootstrap.service.js';
import { CommunitySlugSchema } from '../../src/shared/schemas/bootstrap.js';
import { createCommunitySchema } from '../../src/shared/schemas/communities.js';
import { createCommunitySchema as createPhysicalCommunitySchema } from '../../src/db/schema/communities.js';
import { createCommunitySchema as createSuperAdminCommunitySchema } from '../../src/shared/schemas/super-admin.js';

it('rejects the reserved prefix in community creation schemas', () => {
  expect(deriveBootstrapSlug('Deprovisioned 123')).toBe(
    'community-deprovisioned-123'
  );
  expect(CommunitySlugSchema.safeParse('deprovisioned-123').success).toBe(
    false
  );
  for (const schema of [
    createCommunitySchema,
    createPhysicalCommunitySchema,
    createSuperAdminCommunitySchema,
  ]) {
    expect(
      schema.safeParse({ name: 'Valid name', slug: 'valid-slug' }).success
    ).toBe(true);
    expect(
      schema.safeParse({ name: 'Valid name', slug: 'deprovisioned-123' })
        .success
    ).toBe(false);
  }
});

// Opt in with a migrated, dedicated PostgreSQL test database. All fixture writes
// run inside an outer transaction that is always rolled back.
it.skipIf(!process.env.SLUG_TEST_POSTGRES_URL)(
  'selects collision-free PostgreSQL tombstones and rolls back on bounded exhaustion',
  async () => {
    const url = process.env.SLUG_TEST_POSTGRES_URL!;
    if (
      !/^(test|[a-z0-9][a-z0-9_]*_test)$/i.test(new URL(url).pathname.slice(1))
    ) {
      throw new Error('A dedicated PostgreSQL test database is required');
    }
    const client = postgres(url, { max: 1 });
    const db = drizzle(client);
    const rollback = new Error('rollback test fixtures');
    try {
      await expect(
        db.transaction(async (tx) => {
          const now = new Date();
          const [actor] = await tx
            .insert(usersPg)
            .values({
              email: `slug-${crypto.randomUUID()}@example.test`,
              passwordHash: 'unused',
              firstName: '',
              lastName: '',
              role: 'super_admin',
              communityId: null,
            })
            .returning();
          const repo = new AdminRepository(
            tx as unknown as ConstructorParameters<typeof AdminRepository>[0]
          );
          for (const exhausted of [false, true]) {
            const targetSlug = `slug-${crypto.randomUUID()}`;
            const [target] = await tx
              .insert(communitiesPg)
              .values({
                name: targetSlug,
                slug: targetSlug,
              })
              .returning();
            await tx.insert(communitiesPg).values(
              Array.from({ length: exhausted ? 100 : 2 }, (_, index) => ({
                name: 'Legacy collision',
                slug: `deprovisioned-${target.id}${index ? `-${index + 1}` : ''}`,
              }))
            );
            const input = { actorId: actor.id, communityId: target.id, now };
            if (exhausted) {
              const before = await tx.select().from(auditEntriesPg);
              await expect(
                repo.deprovisionCommunityAtomically(input)
              ).rejects.toThrow();
              const [unchanged] = await tx
                .select()
                .from(communitiesPg)
                .where(eq(communitiesPg.id, target.id));
              expect(unchanged.slug).toBe(target.slug);
              expect(unchanged.deprovisionedAt).toBeNull();
              expect(await tx.select().from(auditEntriesPg)).toEqual(before);
            } else {
              expect(await repo.deprovisionCommunityAtomically(input)).toEqual({
                outcome: 'deprovisioned',
              });
              const [tombstone] = await tx
                .select()
                .from(communitiesPg)
                .where(eq(communitiesPg.id, target.id));
              expect(tombstone.slug).toBe(`deprovisioned-${target.id}-3`);
            }
          }
          throw rollback;
        })
      ).rejects.toBe(rollback);
    } finally {
      await client.end();
    }
  }
);
