/**
 * Emergency global session revocation (#137): src/ops/revoke-all-sessions.ts
 * (also scripts/ops/revoke-all-sessions.ts) and the equivalent D1/SQLite SQL
 * documented in OPERATIONS-GOVERNANCE.md R1a.
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { createHonoApp } from '../../src/hono-app.js';
import { HonoFoundationRepository } from '../../src/repositories/hono-foundation.repository.js';
import { sessionsSqlite } from '../../src/db/schema/sessions.js';
import { auditEntriesSqlite } from '../../src/db/schema/audit_entries.js';
import { communitiesSqlite } from '../../src/db/schema/communities.js';
import { usersSqlite } from '../../src/db/schema/users.js';
import {
  claimTokensSqlite,
  loginCodesSqlite,
} from '../../src/db/schema/login_codes.js';
import {
  ADMIN_ISSUED_CODE_TTL_MS,
  ARGON2ID_ALGORITHM,
  ARGON2ID_PARAMS,
} from '../../src/shared/auth-policy.js';
import { sha256Hex, toBase64Url } from '../../src/shared/auth-crypto.js';
import { normalizeSearchText } from '../../src/shared/utils/search-normalize.js';
import {
  argon2Seed,
  makeDerivedKey,
  makeVerifierSalt,
} from './auth-test-utils.js';
import {
  REVOKE_ALL_AUDIT_ACTION,
  countAffected,
  main,
  revokeAllSessions,
  runCli,
} from '../../src/ops/revoke-all-sessions.js';

const execFileAsync = promisify(execFile);
const ORIGIN = 'https://api.example.test';
const rawToken = () => toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
const passwordPayload = () => ({
  algorithm: ARGON2ID_ALGORITHM,
  salt: makeVerifierSalt(),
  params: { ...ARGON2ID_PARAMS },
  derivedKey: makeDerivedKey(),
});

describe('emergency global session revocation (#137)', () => {
  const openDbs: Sqlite.Database[] = [];
  afterEach(() => {
    vi.unstubAllEnvs();
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
    const users = await db
      .insert(usersSqlite)
      .values(
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
      )
      .returning();
    const app = createHonoApp({
      repository: new HonoFoundationRepository(db),
      storage: { read: async () => null },
      serverSecret: makeDerivedKey(),
      secureCookies: false,
      publicOrigin: ORIGIN,
      trustProxy: true,
      isWorkers: true,
    });
    const post = (path: string, body: unknown) =>
      app.request(`${ORIGIN}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'cf-connecting-ip': '203.0.113.9',
        },
        body: JSON.stringify(body),
      });
    const login = async (identifier: string) => {
      const response = await post('/v2/auth/login', {
        identifier,
        derivedKey: key,
      });
      expect(response.status).toBe(200);
      return (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    };
    const me = (cookie: string) =>
      app.request(`${ORIGIN}/v2/auth/me`, { headers: { cookie } });
    const insertCode = async (
      userId: number,
      communityId: number,
      purpose: 'admin_issued' | 'recovery'
    ) => {
      const code = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
      const createdAt = Date.now();
      await db.insert(loginCodesSqlite).values({
        userId,
        communityId,
        purpose,
        codeHash: await sha256Hex(code),
        createdBy: userId,
        createdAt,
        expiresAt:
          purpose === 'admin_issued'
            ? createdAt + ADMIN_ISSUED_CODE_TTL_MS
            : null,
      });
      return code;
    };
    const insertClaim = async (communityId: number) => {
      const raw = rawToken();
      const createdAt = Date.now();
      await db.insert(claimTokensSqlite).values({
        communityId,
        tokenHash: await sha256Hex(raw),
        createdAt,
        expiresAt: createdAt + 3_600_000,
      });
      return raw;
    };
    const claim = (token: string, name: string) =>
      post('/v2/bootstrap/claim', {
        token,
        username: name,
        email: `${name}@claim.example.test`,
        password: passwordPayload(),
      });
    const emptyCommunity = async (slug: string) =>
      (
        await db
          .insert(communitiesSqlite)
          .values({ name: slug, slug, isActive: true })
          .returning()
      )[0] as { id: number };
    const audit = async () =>
      (await db.select().from(auditEntriesSqlite)).filter(
        (row) => row.action === REVOKE_ALL_AUDIT_ACTION
      );
    return {
      sqlite,
      db,
      users,
      emails,
      post,
      login,
      me,
      insertCode,
      insertClaim,
      claim,
      emptyCommunity,
      audit,
    };
  }

  it('revokes sessions, recovery/admin codes and claim tokens; new logins work', async () => {
    const s = await setup();
    const { db, users, emails } = s;
    const cookies = [await s.login(emails[0]!), await s.login(emails[1]!)];
    const extra = await s.login(emails[0]!);
    for (const cookie of [...cookies, extra]) {
      expect((await s.me(cookie)).status).toBe(200);
    }
    const recovery = await s.insertCode(
      users[0]!.id,
      users[0]!.communityId!,
      'recovery'
    );
    const issued = await s.insertCode(
      users[1]!.id,
      users[1]!.communityId!,
      'admin_issued'
    );
    const unclaimed = await s.emptyCommunity('rev-unclaimed');
    const oldClaim = await s.insertClaim(unclaimed.id);
    const usersBefore = await db.select().from(usersSqlite);

    expect(await countAffected(db)).toEqual({
      revoked: 3,
      loginCodesSuperseded: 2,
      claimTokensSuperseded: 1,
    });
    expect(await revokeAllSessions(db)).toEqual({
      revoked: 3,
      loginCodesSuperseded: 2,
      claimTokensSuperseded: 1,
    });

    for (const cookie of [...cookies, extra]) {
      const denied = await s.me(cookie);
      expect(denied.status).toBe(401);
      expect(JSON.stringify(await denied.json())).not.toContain('rev.example');
    }
    expect(await db.select().from(sessionsSqlite)).toHaveLength(0);
    // Pre-existing recovery and admin-issued codes no longer work.
    const redeemRecovery = await s.post('/v2/auth/recovery/redeem', {
      code: recovery,
      password: passwordPayload(),
    });
    const redeemIssued = await s.post('/v2/auth/recovery/redeem', {
      code: issued,
    });
    expect(redeemRecovery.status).toBe(401);
    expect(redeemIssued.status).toBe(401);
    expect(redeemRecovery.headers.get('set-cookie')).toBeNull();
    expect(redeemIssued.headers.get('set-cookie')).toBeNull();
    // The pre-existing claim token no longer works and the community stays unclaimed.
    const deniedClaim = await s.claim(oldClaim, 'old_claimer');
    expect(deniedClaim.status).toBeGreaterThanOrEqual(400);
    expect(deniedClaim.headers.get('set-cookie')).toBeNull();
    expect(
      (await db.select().from(usersSqlite)).filter(
        (u) => u.communityId === unclaimed.id
      )
    ).toEqual([]);
    for (const row of await db.select().from(loginCodesSqlite)) {
      expect(row.supersededAt).not.toBeNull();
      expect(row.usedAt).toBeNull();
    }
    for (const row of await db.select().from(claimTokensSqlite)) {
      expect(row.supersededAt).not.toBeNull();
    }
    // Accounts are unchanged.
    expect(await db.select().from(usersSqlite)).toEqual(usersBefore);
    expect(await s.audit()).toHaveLength(1);
    expect((await s.audit())[0]).toMatchObject({
      outcome: 'success',
      communityId: null,
      actorId: null,
    });

    // Fresh credentials issued after the run work: logins, codes and tokens.
    const fresh = await s.login(emails[1]!);
    expect((await s.me(fresh)).status).toBe(200);
    for (const cookie of cookies) expect((await s.me(cookie)).status).toBe(401);
    const freshIssued = await s.insertCode(
      users[1]!.id,
      users[1]!.communityId!,
      'admin_issued'
    );
    expect(
      (await s.post('/v2/auth/recovery/redeem', { code: freshIssued })).status
    ).toBe(200);
    const freshClaim = await s.insertClaim(unclaimed.id);
    expect((await s.claim(freshClaim, 'new_claimer')).status).toBe(201);
  });

  it('is atomic: an audit failure rolls back every revocation', async () => {
    const s = await setup();
    const cookie = await s.login(s.emails[0]!);
    await s.insertCode(s.users[0]!.id, s.users[0]!.communityId!, 'recovery');
    const community = await s.emptyCommunity('rev-atomic');
    await s.insertClaim(community.id);
    s.sqlite.exec(
      `CREATE TRIGGER fail_audit BEFORE INSERT ON audit_entries BEGIN SELECT RAISE(ABORT, 'secret-driver-detail'); END`
    );
    await expect(revokeAllSessions(s.db)).rejects.toThrow();
    expect((await s.me(cookie)).status).toBe(200);
    expect(await countAffected(s.db)).toEqual({
      revoked: 1,
      loginCodesSuperseded: 1,
      claimTokensSuperseded: 1,
    });
  });

  it('CLI: dry run changes nothing, --confirm is required, failures are sanitized', async () => {
    const s = await setup();
    const cookie = await s.login(s.emails[0]!);
    const out: string[] = [];
    const err: string[] = [];
    const io = {
      out: (l: string) => out.push(l),
      err: (l: string) => err.push(l),
    };

    expect(await runCli([], s.db, io)).toBe(0);
    expect(await runCli(['--other'], s.db, io)).toBe(0);
    expect(out.join('\n')).toContain('Dry run: would revoke 1 session(s)');
    expect((await s.me(cookie)).status).toBe(200);
    expect(await s.audit()).toHaveLength(0);

    s.sqlite.exec(
      `CREATE TRIGGER fail_audit BEFORE INSERT ON audit_entries BEGIN SELECT RAISE(ABORT, 'secret-driver-detail'); END`
    );
    expect(await runCli(['--confirm'], s.db, io)).toBe(1);
    expect(err.join('\n')).toContain('rolled back, nothing was changed');
    expect(err.join('\n')).not.toContain('secret-driver-detail');
    expect((await s.me(cookie)).status).toBe(200);

    s.sqlite.exec('DROP TRIGGER fail_audit');
    expect(await runCli(['--confirm'], s.db, io)).toBe(0);
    expect(out.join('\n')).toContain('Revoked 1 session(s)');
    expect((await s.me(cookie)).status).toBe(401);
  });

  it('refuses to run without an explicit DATABASE_URL, in :memory:, or under NODE_ENV=test', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      vi.stubEnv('NODE_ENV', 'test');
      vi.stubEnv('DATABASE_URL', '/tmp/does-not-matter.db');
      expect(await main(['--confirm'])).toBe(2);
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('DATABASE_URL', ':memory:');
      expect(await main(['--confirm'])).toBe(2);
      vi.stubEnv('DATABASE_URL', '');
      expect(await main(['--confirm'])).toBe(2);
    } finally {
      error.mockRestore();
    }
  });

  it('a restored pre-revocation backup is purged again before serving traffic', async () => {
    const s = await setup();
    const cookie = await s.login(s.emails[0]!);
    const backup = await s.db.select().from(sessionsSqlite);
    expect(backup).toHaveLength(1);
    await revokeAllSessions(s.db);
    expect((await s.me(cookie)).status).toBe(401);
    // Restoring the backup brings the old session digest back to life ...
    await s.db.insert(sessionsSqlite).values(backup);
    expect((await s.me(cookie)).status).toBe(200);
    // ... so the documented post-restore purge must deny it again.
    await revokeAllSessions(s.db);
    expect((await s.me(cookie)).status).toBe(401);
    const fresh = await s.login(s.emails[0]!);
    expect((await s.me(fresh)).status).toBe(200);
  });

  const sqlBlocks = () => {
    const doc = readFileSync('docs/OPERATIONS-GOVERNANCE.md', 'utf8');
    const blocks = [...doc.matchAll(/```sql\n([\s\S]*?)```/g)].map(
      (m) => m[1]!
    );
    const d1 = blocks.find((b) => b.startsWith('DELETE FROM sessions;'));
    const sqlite = blocks.find((b) => b.startsWith('BEGIN IMMEDIATE;'));
    expect(d1, 'D1 SQL block present').toBeTruthy();
    expect(sqlite, 'SQLite transaction block present').toBeTruthy();
    expect(d1).not.toMatch(/BEGIN|COMMIT/);
    return { d1: d1!, sqlite: sqlite! };
  };

  it.each(['d1', 'sqlite'] as const)(
    'the documented %s SQL has the same effect',
    async (which) => {
      const block = sqlBlocks()[which];
      expect(block).toContain('UPDATE login_codes');
      expect(block).toContain('UPDATE claim_tokens');
      const s = await setup();
      const cookie = await s.login(s.emails[0]!);
      const recovery = await s.insertCode(
        s.users[0]!.id,
        s.users[0]!.communityId!,
        'recovery'
      );
      const community = await s.emptyCommunity('rev-sql');
      const token = await s.insertClaim(community.id);
      s.sqlite.exec(block);
      expect((await s.me(cookie)).status).toBe(401);
      expect(await s.db.select().from(sessionsSqlite)).toHaveLength(0);
      expect(
        (
          await s.post('/v2/auth/recovery/redeem', {
            code: recovery,
            password: passwordPayload(),
          })
        ).status
      ).toBe(401);
      expect(
        (await s.claim(token, 'sql_claimer')).status
      ).toBeGreaterThanOrEqual(400);
      const audit = await s.audit();
      expect(audit).toHaveLength(1);
      expect(audit[0]?.createdAt).toBeInstanceOf(Date);
      expect((await s.me(await s.login(s.emails[0]!))).status).toBe(200);
    }
  );

  it('the documented SQLite transaction leaves nothing changed when the audit insert fails', async () => {
    const s = await setup();
    const cookie = await s.login(s.emails[0]!);
    await s.insertCode(s.users[0]!.id, s.users[0]!.communityId!, 'recovery');
    s.sqlite.exec(
      `CREATE TRIGGER fail_audit BEFORE INSERT ON audit_entries BEGIN SELECT RAISE(ABORT, 'x'); END`
    );
    // sqlite3 -bail stops at the failing statement and closes, discarding the open transaction.
    expect(() => s.sqlite.exec(sqlBlocks().sqlite)).toThrow();
    s.sqlite.exec('ROLLBACK');
    expect((await s.me(cookie)).status).toBe(200);
    expect(await countAffected(s.db)).toEqual({
      revoked: 1,
      loginCodesSuperseded: 1,
      claimTokensSuperseded: 0,
    });
  });

  it('the real process: dry run, --confirm and exit codes against a SQLite file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'revoke-cli-'));
    const path = join(dir, 'app.db');
    const file = new Sqlite(path);
    const fdb = drizzle(file);
    migrate(fdb, { migrationsFolder: 'src/db/migrations' });
    const [community] = await fdb
      .insert(communitiesSqlite)
      .values({ name: 'Cli', slug: 'cli', isActive: true })
      .returning();
    const [user] = await fdb
      .insert(usersSqlite)
      .values({
        ...(await argon2Seed(makeDerivedKey())),
        passwordHash: 'legacy-hash',
        firstName: 'Cli',
        lastName: 'User',
        isActive: true,
        role: 'member',
        email: 'cli@rev.example.test',
        emailNormalized: 'cli@rev.example.test',
        username: 'cli_user',
        usernameNormalized: 'cli_user',
        communityId: community!.id,
      })
      .returning();
    await fdb.insert(sessionsSqlite).values({
      id: 'cli-session',
      tokenHash: 'f'.repeat(64),
      userId: user!.id,
      expiresAt: Date.now() + 60_000,
    });
    file.close();
    const run = (args: string[], env: Record<string, string>) =>
      execFileAsync(
        process.execPath,
        [
          'node_modules/tsx/dist/cli.mjs',
          'scripts/ops/revoke-all-sessions.ts',
          ...args,
        ],
        { env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } }
      ).then(
        (r) => ({ code: 0, out: r.stdout + r.stderr }),
        (e: { code?: number; stdout?: string; stderr?: string }) => ({
          code: e.code ?? 1,
          out: (e.stdout ?? '') + (e.stderr ?? ''),
        })
      );
    const count = () => {
      const c = new Sqlite(path, { readonly: true });
      try {
        return (
          c.prepare('SELECT count(*) AS n FROM sessions').get() as { n: number }
        ).n;
      } finally {
        c.close();
      }
    };
    const env = { NODE_ENV: 'development', DATABASE_URL: path };
    const dry = await run([], env);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain('Dry run: would revoke 1 session(s)');
    expect(count()).toBe(1);
    // Refused under NODE_ENV=test even with a real file.
    const refused = await run(['--confirm'], { ...env, NODE_ENV: 'test' });
    expect(refused.code).toBe(2);
    expect(count()).toBe(1);
    const done = await run(['--confirm'], env);
    expect(done.code).toBe(0);
    expect(done.out).toContain('Revoked 1 session(s)');
    expect(count()).toBe(0);
  }, 60_000);
});
