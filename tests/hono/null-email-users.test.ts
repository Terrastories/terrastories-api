/**
 * Migrated Rails accounts may have no email (users.email is nullable). The
 * identity helper, admin user management and login-by-username must all work
 * for them, on SQLite and on PostgreSQL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Sqlite from 'better-sqlite3';
import { sql, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js';
import { migrate as migratePostgres } from 'drizzle-orm/postgres-js/migrator';
import { createPostgresClient, type Database } from '../../src/db/index.js';
import { tablesFor } from '../../src/db/dialect.js';
import { createHonoApp } from '../../src/hono-app.js';
import { HonoFoundationRepository } from '../../src/repositories/hono-foundation.repository.js';
import { deriveUserIdentityColumns } from '../../src/shared/utils/derived-columns.js';
import { resolvePostgresQaTarget } from '../../scripts/qa/qa-database.js';
import {
  argon2Seed,
  makeDerivedKey,
  makeServerSecret,
} from './auth-test-utils.js';

const API_ORIGIN = 'https://api.example.test';
const T0 = new Date('2026-06-01T12:00:00.000Z');
const DERIVED_KEY = makeDerivedKey();

const pgDecision = resolvePostgresQaTarget(
  process.env.QA_POSTGRES_URL,
  process.env.ALLOW_POSTGRES_TEST_RESET
);

describe('deriveUserIdentityColumns', () => {
  it('is null-safe for a null email', () => {
    expect(deriveUserIdentityColumns({ email: null })).toEqual({
      emailNormalized: null,
    });
    expect(deriveUserIdentityColumns({ email: null, username: 'Ana' })).toEqual(
      {
        emailNormalized: null,
        usernameNormalized: 'ana',
      }
    );
    expect(deriveUserIdentityColumns({})).toEqual({});
  });
});

function registerSuite(getDb: () => Database) {
  const ids: Record<string, number> = {};
  let app: ReturnType<typeof createHonoApp>;
  let adminCookie = '';

  const request = async (
    method: string,
    path: string,
    body?: unknown,
    cookie?: string
  ) => {
    const res = await app.request(API_ORIGIN + path, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(cookie ? { cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return {
      status: res.status,
      headers: res.headers,
      json: text ? (JSON.parse(text) as any) : null,
    };
  };
  const login = async (identifier: string, communitySlug?: string) =>
    request('POST', '/v2/auth/login', {
      identifier,
      derivedKey: DERIVED_KEY,
      ...(communitySlug ? { communitySlug } : {}),
    });

  beforeAll(async () => {
    const db = getDb();
    const tables = tablesFor(db);
    const seed = await argon2Seed(DERIVED_KEY);
    const [community] = await (db as any)
      .insert(tables.communities)
      .values({
        name: 'Null Email Nation',
        slug: 'null-email-nation',
        locale: 'en',
        publicStories: false,
        isActive: true,
        createdAt: T0,
        updatedAt: T0,
      })
      .returning({ id: tables.communities.id });
    ids.community = community.id;
    const insertUser = async (
      email: string | null,
      username: string,
      role: string
    ) => {
      const [row] = await (db as any)
        .insert(tables.users)
        .values({
          email,
          username,
          ...deriveUserIdentityColumns({ email, username }),
          firstName: role,
          lastName: 'Tester',
          ...seed,
          role,
          communityId: ids.community,
          isActive: true,
          createdAt: T0,
          updatedAt: T0,
        })
        .returning({ id: tables.users.id });
      return row.id as number;
    };
    ids.admin = await insertUser(
      'admin@null-email.example.test',
      'ne_admin',
      'admin'
    );
    ids.nullUser = await insertUser(null, 'ne_member', 'member');
    app = createHonoApp({
      repository: new HonoFoundationRepository(db),
      secureCookies: false,
      publicOrigin: API_ORIGIN,
      corsOrigins: ['https://app.example.test'],
      storage: { read: async () => null },
      serverSecret: makeServerSecret(),
    });
    const res = await login(
      'admin@null-email.example.test',
      'null-email-nation'
    );
    expect(res.status).toBe(200);
    adminCookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  });

  it('logs a null-email user in by username', async () => {
    const res = await login('ne_member');
    expect(res.status).toBe(200);
    expect(res.json.user.email).toBeNull();
    expect(res.json.user.username).toBe('ne_member');
  });

  it('lists null-email users with email: null', async () => {
    const res = await request('GET', '/v2/users', undefined, adminCookie);
    expect(res.status).toBe(200);
    const row = res.json.data.find(
      (u: { id: number }) => u.id === ids.nullUser
    );
    expect(row).toBeDefined();
    expect(row.email).toBeNull();
  });

  it('lets an admin edit a null-email user without supplying an email', async () => {
    const edited = await request(
      'PATCH',
      '/v2/users/' + ids.nullUser,
      { displayName: 'Edited', role: 'editor' },
      adminCookie
    );
    expect(edited.status).toBe(200);
    expect(edited.json.data.displayName).toBe('Edited');
    expect(edited.json.data.role).toBe('editor');
    expect(edited.json.data.email).toBeNull();
    const tables = tablesFor(getDb());
    const [stored] = await (getDb() as any)
      .select()
      .from(tables.users)
      .where(eq(tables.users.id, ids.nullUser));
    expect(stored.email).toBeNull();
    expect(stored.emailNormalized).toBeNull();
  });

  it('lets an admin give a null-email user an email later', async () => {
    const res = await request(
      'PATCH',
      '/v2/users/' + ids.nullUser,
      { email: 'now-has@null-email.example.test' },
      adminCookie
    );
    expect(res.status).toBe(200);
    expect(res.json.data.email).toBe('now-has@null-email.example.test');
  });
}

describe('null-email users (SQLite)', () => {
  const sqlite = new Sqlite(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite) as unknown as Database;
  beforeAll(() => {
    migrate(db as any, { migrationsFolder: 'src/db/migrations' });
  });
  afterAll(() => sqlite.close());
  registerSuite(() => db);
});

describe.skipIf(pgDecision.status !== 'ready')(
  'null-email users (PostgreSQL)',
  () => {
    let client: ReturnType<typeof createPostgresClient> | null = null;
    let pgDb: Database | null = null;
    beforeAll(async () => {
      client = createPostgresClient(pgDecision.url!, {
        max: 5,
        onnotice: () => undefined,
      });
      await client`DROP SCHEMA IF EXISTS drizzle CASCADE`;
      await client`DROP SCHEMA IF EXISTS public CASCADE`;
      await client`CREATE SCHEMA public`;
      pgDb = drizzlePostgres(client) as unknown as Database;
      await migratePostgres(pgDb as any, {
        migrationsFolder: 'src/db/migrations/postgres',
      });
      await (pgDb as any).execute(sql.raw('SELECT 1'));
    });
    afterAll(async () => {
      await client?.end();
    });
    registerSuite(() => pgDb!);
  }
);
