/**
 * Emergency global session revocation (#137): scripts/ops/revoke-all-sessions.ts
 * and the equivalent D1/SQLite SQL documented in OPERATIONS-GOVERNANCE.md R1a.
 */
import { afterEach, describe, expect, it } from 'vitest';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { createHonoApp } from '../../src/hono-app.js';
import { HonoFoundationRepository } from '../../src/repositories/hono-foundation.repository.js';
import { sessionsSqlite } from '../../src/db/schema/sessions.js';
import { auditEntriesSqlite } from '../../src/db/schema/audit_entries.js';
import { communitiesSqlite } from '../../src/db/schema/communities.js';
import { usersSqlite } from '../../src/db/schema/users.js';
import { normalizeSearchText } from '../../src/shared/utils/search-normalize.js';
import { argon2Seed, makeDerivedKey } from './auth-test-utils.js';
import {
  REVOKE_ALL_AUDIT_ACTION,
  countSessions,
  revokeAllSessions,
} from '../../scripts/ops/revoke-all-sessions.js';
import { readFileSync } from 'node:fs';

describe('emergency global session revocation (#137)', () => {
  const openDbs: Sqlite.Database[] = [];
  afterEach(() => {
    while (openDbs.length > 0) openDbs.pop()?.close();
  });

  async function setup() {
    const sqlite = new Sqlite(':memory:');
    sqlite.pragma('foreign_keys = ON');
    openDbs.push(sqlite);
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: 'src/db/migrations' });
    const [alpha] = await db
      .insert(communitiesSqlite)
      .values({ name: 'Rev Alpha', slug: 'rev-alpha', isActive: true })
      .returning();
    const [beta] = await db
      .insert(communitiesSqlite)
      .values({ name: 'Rev Beta', slug: 'rev-beta', isActive: true })
      .returning();
    const key = makeDerivedKey();
    const seed = await argon2Seed(key);
    const emails = ['one@rev.example.test', 'two@rev.example.test'];
    await db.insert(usersSqlite).values(
      emails.map((email, i) => ({
        ...seed,
        passwordHash: 'legacy-hash',
        firstName: 'Rev',
        lastName: 'User',
        isActive: true as const,
        role: 'member' as const,
        email,
        emailNormalized: normalizeSearchText(email),
        username: `rev_${i}`,
        usernameNormalized: `rev_${i}`,
        communityId: i === 0 ? alpha.id : beta.id,
      }))
    );
    const app = createHonoApp({
      repository: new HonoFoundationRepository(db),
      storage: { read: async () => null },
      serverSecret: makeDerivedKey(),
      secureCookies: false,
      trustProxy: true,
    });
    const login = async (identifier: string) => {
      const response = await app.request('http://test/v2/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier, derivedKey: key }),
      });
      expect(response.status).toBe(200);
      return (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    };
    const me = (cookie: string) =>
      app.request('http://test/v2/auth/me', { headers: { cookie } });
    return { db, emails, login, me };
  }

  it('revokes every session: old cookies get 401, new logins work, data is untouched', async () => {
    const { db, emails, login, me } = await setup();
    const cookies = await Promise.all(emails.map(login));
    const device = await login(emails[0] as string);
    for (const cookie of [...cookies, device]) {
      expect((await me(cookie)).status).toBe(200);
    }
    const usersBefore = await db.select().from(usersSqlite);
    expect(await countSessions(db)).toBe(3);

    const result = await revokeAllSessions(db);
    expect(result).toEqual({ revoked: 3 });

    for (const cookie of [...cookies, device]) {
      const denied = await me(cookie);
      expect(denied.status).toBe(401);
      expect(JSON.stringify(await denied.json())).not.toContain('rev.example');
    }
    expect(await db.select().from(sessionsSqlite)).toHaveLength(0);
    // Accounts are unchanged: revocation touches sessions only.
    expect(await db.select().from(usersSqlite)).toEqual(usersBefore);

    const audit = (await db.select().from(auditEntriesSqlite)).filter(
      (row) => row.action === REVOKE_ALL_AUDIT_ACTION
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      outcome: 'success',
      communityId: null,
      actorId: null,
    });

    // Fresh logins work; the revoked cookies stay dead.
    const fresh = await login(emails[1] as string);
    expect((await me(fresh)).status).toBe(200);
    expect(fresh).not.toBe(cookies[1]);
    for (const cookie of cookies) expect((await me(cookie)).status).toBe(401);
  });

  it('is idempotent with no sessions and still audits the run', async () => {
    const { db } = await setup();
    expect(await revokeAllSessions(db)).toEqual({ revoked: 0 });
    expect(await revokeAllSessions(db)).toEqual({ revoked: 0 });
    const audit = (await db.select().from(auditEntriesSqlite)).filter(
      (row) => row.action === REVOKE_ALL_AUDIT_ACTION
    );
    expect(audit).toHaveLength(2);
  });

  it('the documented D1/SQLite SQL has the same effect', async () => {
    const doc = readFileSync('docs/OPERATIONS-GOVERNANCE.md', 'utf8');
    const block = /```sql\n(DELETE FROM sessions;[\s\S]*?)```/.exec(doc)?.[1];
    expect(block, 'R1a SQL block present').toBeTruthy();
    const { db, emails, login, me } = await setup();
    const cookie = await login(emails[0] as string);
    expect((await me(cookie)).status).toBe(200);
    openDbs[0]?.exec(block as string);
    expect((await me(cookie)).status).toBe(401);
    expect(await db.select().from(sessionsSqlite)).toHaveLength(0);
    const audit = (await db.select().from(auditEntriesSqlite)).filter(
      (row) => row.action === REVOKE_ALL_AUDIT_ACTION
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]?.createdAt).toBeInstanceOf(Date);
    const fresh = await login(emails[0] as string);
    expect((await me(fresh)).status).toBe(200);
  });
});
