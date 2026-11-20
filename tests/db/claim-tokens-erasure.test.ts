import { describe, expect, it } from 'vitest';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import { tablesFor } from '../../src/db/dialect.js';

describe('claim_tokens consumed check survives claimant erasure', () => {
  it('keeps consumed_at when the claimant row is deleted (ON DELETE SET NULL)', async () => {
    const sqlite = new Sqlite(':memory:');
    sqlite.pragma('foreign_keys = ON');
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: 'src/db/migrations' });
    const t = tablesFor(db);
    const now = new Date('2026-06-01T12:00:00.000Z');
    const [community] = await db
      .insert(t.communities)
      .values({
        name: 'C',
        slug: 'c',
        locale: 'en',
        publicStories: false,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: t.communities.id });
    const [user] = await db
      .insert(t.users)
      .values({
        email: 'u@example.test',
        username: 'u1',
        emailNormalized: 'u@example.test',
        usernameNormalized: 'u1',
        firstName: 'U',
        lastName: 'One',
        passwordHash: 'x',
        role: 'admin',
        communityId: community.id,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: t.users.id });
    sqlite
      .prepare(
        'insert into claim_tokens (community_id, token_hash, created_at, expires_at, consumed_at, consumed_by) values (?, ?, 1, 2, 2, ?)'
      )
      .run(community.id, 'h1', user.id);

    await db.delete(t.users).where(eq(t.users.id, user.id));

    const row = sqlite
      .prepare('select consumed_at, consumed_by from claim_tokens')
      .get() as { consumed_at: number; consumed_by: number | null };
    expect(row.consumed_by).toBeNull();
    expect(row.consumed_at).toBe(2);
    sqlite.close();
  });
});
