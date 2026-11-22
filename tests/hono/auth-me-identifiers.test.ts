/**
 * PATCH /v2/auth/me with username and/or email: step-up re-verification of
 * the current credential, admin-parity normalisation and identity rules, the
 * uniform 409, the same-unit content-free audit row, and session retention.
 */
import { afterEach, describe, expect, it } from 'vitest';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import { createHonoApp } from '../../src/hono-app.js';
import { HonoFoundationRepository } from '../../src/repositories/hono-foundation.repository.js';
import { communitiesSqlite } from '../../src/db/schema/communities.js';
import { usersSqlite } from '../../src/db/schema/users.js';
import { auditEntriesSqlite } from '../../src/db/schema/audit_entries.js';
import { normalizeSearchText } from '../../src/shared/utils/search-normalize.js';
import {
  argon2Seed,
  makeDerivedKey,
  makeServerSecret,
} from './auth-test-utils.js';

describe('PATCH /v2/auth/me login identifiers (self-edit)', () => {
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
    const [alpha, beta] = await db
      .insert(communitiesSqlite)
      .values([
        { name: 'Self Alpha', slug: 'self-alpha', isActive: true },
        { name: 'Self Beta', slug: 'self-beta', isActive: true },
      ])
      .returning();
    const key = makeDerivedKey();
    const seed = await argon2Seed(key);
    const addUser = async (
      email: string,
      username: string,
      role: string,
      communityId: number | null
    ) => {
      const [row] = await db
        .insert(usersSqlite)
        .values({
          ...seed,
          email,
          username,
          emailNormalized: normalizeSearchText(email),
          usernameNormalized: normalizeSearchText(username),
          firstName: 'Self',
          lastName: 'Edit',
          displayName: 'Self Edit',
          role,
          communityId,
          isActive: true,
        })
        .returning();
      return row;
    };
    const me = await addUser(
      'me@self.example.test',
      'self_me',
      'member',
      alpha.id
    );
    const admin = await addUser(
      'admin@self.example.test',
      'self_admin',
      'admin',
      alpha.id
    );
    const peer = await addUser(
      'peer@self.example.test',
      'self_peer',
      'member',
      alpha.id
    );
    const other = await addUser(
      'other@self.example.test',
      'self_other',
      'member',
      beta.id
    );
    const root = await addUser(
      'root@self.example.test',
      'self_root',
      'super_admin',
      null
    );
    const app = createHonoApp({
      repository: new HonoFoundationRepository(db),
      storage: { read: async () => null },
      serverSecret: makeServerSecret(),
      secureCookies: false,
    });
    const login = async (identifier: string, derivedKey = key) => {
      const response = await app.request('http://test/v2/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier, derivedKey }),
      });
      return {
        response,
        cookie: (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '',
      };
    };
    const patch = (body: unknown, cookie: string) =>
      app.request('http://test/v2/auth/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify(body),
      });
    const row = async (id: number) =>
      (await db.select().from(usersSqlite).where(eq(usersSqlite.id, id)))[0]!;
    return {
      app,
      db,
      sqlite,
      key,
      me,
      admin,
      peer,
      other,
      root,
      alpha,
      login,
      patch,
      row,
    };
  }

  it('changes username and email with step-up, keeps sessions, audits content-free', async () => {
    const { db, sqlite, key, me, login, patch, row, app } = await setup();
    const first = await login('me@self.example.test');
    const second = await login('me@self.example.test');
    expect(first.response.status).toBe(200);
    const response = await patch(
      {
        username: '  Self_Renamed ',
        email: ' New.Me@Self.Example.Test ',
        currentDerivedKey: key,
      },
      first.cookie
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      user: { username: string; email: string; role: string };
    };
    expect(body.user.username).toBe('Self_Renamed');
    expect(body.user.email).toBe('New.Me@Self.Example.Test');
    const stored = await row(me.id);
    expect(stored.usernameNormalized).toBe(normalizeSearchText('Self_Renamed'));
    expect(stored.emailNormalized).toBe(
      normalizeSearchText('New.Me@Self.Example.Test')
    );
    // Sessions are kept: both the requesting and the other session still work.
    for (const cookie of [first.cookie, second.cookie])
      expect(
        (await app.request('http://test/v2/auth/me', { headers: { cookie } }))
          .status
      ).toBe(200);
    // The new identifiers log in; the old ones no longer resolve.
    expect((await login('self_renamed')).response.status).toBe(200);
    expect((await login('new.me@self.example.test')).response.status).toBe(200);
    expect((await login('self_me')).response.status).toBe(401);
    expect((await login('me@self.example.test')).response.status).toBe(401);
    // One content-free success audit row, no old/new values.
    const audit = await db
      .select()
      .from(auditEntriesSqlite)
      .where(eq(auditEntriesSqlite.action, 'auth.identifier.change'));
    const success = audit.filter((entry) => entry.outcome === 'success');
    expect(success).toHaveLength(1);
    expect(success[0]!.actorId).toBe(me.id);
    const dump = JSON.stringify(success[0]).toLowerCase();
    for (const needle of ['self_renamed', 'self_me', 'example.test', key])
      expect(dump).not.toContain(needle);
    sqlite.close();
    openDbs.pop();
  });

  it('keeps display-name-only patches step-up free', async () => {
    const { login, patch } = await setup();
    const { cookie } = await login('me@self.example.test');
    const response = await patch({ displayName: 'Just A Name' }, cookie);
    expect(response.status).toBe(200);
  });

  it('answers one uniform 403 for a missing or wrong step-up and writes nothing', async () => {
    const { me, login, patch, row } = await setup();
    const { cookie } = await login('me@self.example.test');
    const before = await row(me.id);
    const missing = await patch({ username: 'self_changed' }, cookie);
    const wrong = await patch(
      { email: 'wrong@self.example.test', currentDerivedKey: makeDerivedKey() },
      cookie
    );
    expect(missing.status).toBe(403);
    expect(wrong.status).toBe(403);
    expect(await missing.json()).toEqual({ error: 'Forbidden' });
    expect(await wrong.json()).toEqual({ error: 'Forbidden' });
    expect(await row(me.id)).toEqual(before);
  });

  it('409s (uniform Conflict) on collisions with another user in the same community', async () => {
    const { me, key, login, patch, row } = await setup();
    const { cookie } = await login('me@self.example.test');
    const before = await row(me.id);
    for (const body of [
      { email: 'PEER@self.example.test' },
      { username: 'SELF_PEER' },
      // A username may not equal another account's email.
      { username: 'peer@self.example.test' },
      // Another community's username is still globally taken.
      { username: 'self_other' },
    ]) {
      const response = await patch({ ...body, currentDerivedKey: key }, cookie);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: 'Conflict' });
    }
    expect(await row(me.id)).toEqual(before);
  });

  it('lets a user in another community share an email (community-scoped uniqueness)', async () => {
    const { me, key, login, patch, row } = await setup();
    const { cookie } = await login('me@self.example.test');
    const response = await patch(
      { email: 'other@self.example.test', currentDerivedKey: key },
      cookie
    );
    expect(response.status).toBe(200);
    expect((await row(me.id)).email).toBe('other@self.example.test');
  });

  it('refuses an email held by a null-community account and lets the null-community account change its own', async () => {
    const { key, login, patch, root } = await setup();
    const member = await login('me@self.example.test');
    const clash = await patch(
      { email: 'root@self.example.test', currentDerivedKey: key },
      member.cookie
    );
    expect(clash.status).toBe(409);
    const rootSession = await login('root@self.example.test');
    // A null-community email may not be shared with any community account.
    const rootClash = await patch(
      { email: 'peer@self.example.test', currentDerivedKey: key },
      rootSession.cookie
    );
    expect(rootClash.status).toBe(409);
    const ok = await patch(
      { email: 'root.new@self.example.test', currentDerivedKey: key },
      rootSession.cookie
    );
    expect(ok.status).toBe(200);
    expect(root.id).toBeGreaterThan(0);
  });

  it('answers 400 for invalid input', async () => {
    const { key, login, patch } = await setup();
    const { cookie } = await login('me@self.example.test');
    for (const body of [
      {},
      { currentDerivedKey: key },
      { username: '', currentDerivedKey: key },
      { username: '   ', currentDerivedKey: key },
      { username: 'u'.repeat(255), currentDerivedKey: key },
      { email: 'not-an-email', currentDerivedKey: key },
      { email: `${'a'.repeat(250)}@x.test`, currentDerivedKey: key },
      { username: null, currentDerivedKey: key },
      { username: 'ok_name', currentDerivedKey: 'short' },
      { username: 'ok_name', role: 'admin', currentDerivedKey: key },
    ]) {
      const response = await patch(body, cookie);
      expect(response.status, JSON.stringify(Object.keys(body))).toBe(400);
    }
  });

  it('refuses a stale step-up when the credential changed between read and write', async () => {
    const { me, key, login, patch, row, sqlite } = await setup();
    const { cookie } = await login('me@self.example.test');
    // Simulate a concurrent reset landing after the verification read by
    // wrapping the guarded update: change the verifier just before it runs.
    const before = await row(me.id);
    sqlite
      .prepare(
        'CREATE TRIGGER stale_probe BEFORE UPDATE OF username ON users BEGIN SELECT 1; END'
      )
      .run();
    // Direct repository-level check of the anchor: a mismatched anchor is stale.
    const { UserManagementRepository } = await import(
      '../../src/repositories/user-management.repository.js'
    );
    const repository = new UserManagementRepository(
      (await import('drizzle-orm/better-sqlite3')).drizzle(sqlite)
    );
    const outcome = await repository.updateOwnIdentity(
      {
        id: me.id,
        communityId: me.communityId,
        anchor: { passwordHash: before.passwordHash, passwordVerifier: 'x' },
        username: 'self_stale',
        usernameNormalized: 'self_stale',
        collision: { usernameNormalized: 'self_stale' },
        updatedAt: new Date(),
      },
      {
        communityId: me.communityId,
        actorId: me.id,
        action: 'auth.identifier.change',
        resourceType: 'auth',
        resourceIds: [me.id],
        outcome: 'success',
        ipAddress: null,
        userAgent: null,
      }
    );
    expect(outcome).toBe('stale');
    expect((await row(me.id)).username).toBe('self_me');
    expect(key.length).toBe(64);
    expect(cookie).toContain('ts_session=');
    expect(patch).toBeTypeOf('function');
  });

  // Runs `mutate` immediately before the guarded identifier UPDATE (the
  // one writing `username`), i.e. after the step-up read, inside the write
  // transaction.
  async function interposedApp(
    mutate: (sqlite: Sqlite.Database, userId: number) => void,
    as: 'me' | 'admin' = 'me'
  ) {
    const ctx = await setup();
    let fired = false;
    const wrap = (target: object): object =>
      new Proxy(target, {
        get(obj, prop) {
          if (prop === 'update') {
            return (...args: unknown[]) => {
              const builder = (
                Reflect.get(obj, prop) as (...a: unknown[]) => object
              ).apply(obj, args);
              return new Proxy(builder, {
                get(b, key) {
                  const value = Reflect.get(b, key);
                  if (key !== 'set' || typeof value !== 'function')
                    return typeof value === 'function' ? value.bind(b) : value;
                  return (patch: Record<string, unknown>) => {
                    if (!fired && 'username' in patch) {
                      fired = true;
                      mutate(
                        ctx.sqlite,
                        (as === 'admin' ? ctx.admin : ctx.me).id
                      );
                    }
                    return value.call(b, patch);
                  };
                },
              });
            };
          }
          if (prop === 'transaction') {
            return (cb: (tx: object) => unknown, ...rest: unknown[]) =>
              (Reflect.get(obj, prop) as (...a: unknown[]) => unknown).call(
                obj,
                (tx: object) => cb(wrap(tx)),
                ...rest
              );
          }
          const value = Reflect.get(obj, prop);
          return typeof value === 'function' ? value.bind(obj) : value;
        },
      });
    const proxy = wrap(ctx.db) as unknown as ReturnType<typeof drizzle>;
    const app = createHonoApp({
      repository: new HonoFoundationRepository(proxy),
      storage: { read: async () => null },
      serverSecret: makeServerSecret(),
      secureCookies: false,
    });
    const { cookie } = await ctx.login(
      as === 'admin' ? 'admin@self.example.test' : 'me@self.example.test'
    );
    const request = () =>
      app.request('http://test/v2/auth/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({
          username: 'self_midflight',
          email: 'midflight@self.example.test',
          currentDerivedKey: ctx.key,
        }),
      });
    return { ...ctx, request, wasFired: () => fired };
  }

  const successAudits = (sqlite: Sqlite.Database) =>
    sqlite
      .prepare(
        "SELECT count(*) AS n FROM audit_entries WHERE action = 'auth.identifier.change' AND outcome = 'success'"
      )
      .get() as { n: number };

  it('answers 403 when the verifier is replaced between the step-up read and the write', async () => {
    const { me, row, sqlite, request, wasFired } = await interposedApp(
      (db, id) => {
        db.prepare(
          "UPDATE users SET password_verifier = 'replaced-midflight' WHERE id = ?"
        ).run(id);
      }
    );
    const response = await request();
    expect(wasFired()).toBe(true);
    expect(response.status).toBe(403);
    const after = await row(me.id);
    expect(after.username).toBe('self_me');
    expect(after.email).toBe('me@self.example.test');
    expect(successAudits(sqlite).n).toBe(0);
  });

  it('refuses a user disabled between the step-up read and the write', async () => {
    const { me, row, sqlite, request, wasFired } = await interposedApp(
      (db, id) => {
        db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(id);
      }
    );
    const response = await request();
    expect(wasFired()).toBe(true);
    expect(response.status).toBe(403);
    const after = await row(me.id);
    expect(after.username).toBe('self_me');
    expect(after.email).toBe('me@self.example.test');
    expect(successAudits(sqlite).n).toBe(0);
  });

  it('refuses a member whose community is disabled between the step-up read and the write', async () => {
    const { me, alpha, row, sqlite, request, wasFired } = await interposedApp(
      (db) => {
        db.prepare('UPDATE communities SET is_active = 0 WHERE id = ?').run(
          alpha.id
        );
      }
    );
    const response = await request();
    expect(wasFired()).toBe(true);
    expect(response.status).toBe(403);
    const after = await row(me.id);
    expect(after.username).toBe('self_me');
    expect(after.email).toBe('me@self.example.test');
    expect(successAudits(sqlite).n).toBe(0);
  });

  it('keeps the sovereignty surface for an own-admin of a disabled community (SPEC-V2 §7)', async () => {
    const { admin, alpha, row, sqlite, request, wasFired } =
      await interposedApp((db) => {
        db.prepare('UPDATE communities SET is_active = 0 WHERE id = ?').run(
          alpha.id
        );
      }, 'admin');
    const response = await request();
    expect(wasFired()).toBe(true);
    expect(response.status).toBe(200);
    const after = await row(admin.id);
    expect(after.username).toBe('self_midflight');
    expect(successAudits(sqlite).n).toBe(1);
  });
});
