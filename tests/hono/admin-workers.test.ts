import { expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/d1';
import { AdminRepository } from '../../src/repositories/admin.repository.js';
import {
  applyD1Migrations,
  startWorkerRuntime,
} from '../helpers/worker-runtime.js';

it('deprovisions on D1 through all 100 slug candidates and refuses reactivation', async () => {
  const runtime = startWorkerRuntime(
    'export default { fetch() { return new Response("ok"); } };'
  );
  try {
    const d1 = await runtime.getD1Database('DB');
    await applyD1Migrations(d1);
    await d1
      .prepare(
        "INSERT INTO users (id, email, password_hash, first_name, last_name, role, community_id, is_active, created_at, updated_at) VALUES (1, 'operator@example.test', 'unused', 'System', 'Operator', 'super_admin', NULL, 1, 0, 0)"
      )
      .run();
    await d1
      .prepare(
        "INSERT INTO communities (id, name, slug, locale, created_at, updated_at) VALUES (1, 'empty', 'empty', 'en', 0, 0)"
      )
      .run();
    // Occupy every candidate except the final one: D1 must prepare the
    // complete candidate query and still choose the first available slug.
    const collisions = Array.from({ length: 99 }, (_, index) => {
      const slug = `deprovisioned-1${index === 0 ? '' : `-${index + 1}`}`;
      return d1
        .prepare(
          'INSERT INTO communities (name, slug, created_at, updated_at) VALUES (?, ?, 0, 0)'
        )
        .bind(slug, slug);
    });
    for (let offset = 0; offset < collisions.length; offset += 50)
      await d1.batch(collisions.slice(offset, offset + 50));

    const repository = new AdminRepository(drizzle(d1));
    const now = new Date();
    expect(
      await repository.deprovisionCommunityAtomically({
        actorId: 1,
        communityId: 1,
        now,
      })
    ).toEqual({ outcome: 'deprovisioned' });
    expect(
      await d1
        .prepare('SELECT slug, deprovisioned_at FROM communities WHERE id = 1')
        .first()
    ).toEqual({ slug: 'deprovisioned-1-100', deprovisioned_at: now.getTime() });
    expect(
      await repository.setCommunityStatusAtomically({
        actorId: 1,
        communityId: 1,
        status: 'active',
        now,
      })
    ).toEqual({ outcome: 'conflict' });
    expect(
      await d1
        .prepare(
          "SELECT count(*) AS total FROM audit_entries WHERE action = 'system.community.deprovision' AND outcome = 'success'"
        )
        .first('total')
    ).toBe(1);
  } finally {
    await runtime.dispose();
  }
}, 30_000);
