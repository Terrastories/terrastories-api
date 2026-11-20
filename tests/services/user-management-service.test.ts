/**
 * Unit tests for UserManagementService.patchUser against a stub repository —
 * the case the route tests cannot produce: the target row read at the start
 * of the request vanishes before the coupled write lands, and the guarded
 * write reports it (outcome 'not_found'). The service must answer 404, never
 * 200 with the pre-change row, and never audit a success.
 * SPEC-V2 §6.2, §6.8; route registry §6.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import { tablesFor } from '../../src/db/dialect.js';
import { UserManagementService } from '../../src/services/user-management.service.js';
import {
  UserManagementRepository,
  type ManagedUserRow,
} from '../../src/repositories/user-management.repository.js';
import type { FoundationUser } from '../../src/repositories/hono-foundation.repository.js';

const sqlite = new Sqlite(':memory:');
const db = drizzle(sqlite);
const tables = tablesFor(db);

const ACTOR: FoundationUser = {
  id: 0, // assigned in beforeAll
  email: 'admin@own.example.test',
  username: 'qa_admin',
  displayName: 'Admin',
  passwordHash: 'irrelevant-here',
  role: 'admin',
  communityId: 0, // assigned in beforeAll
};

const TARGET: ManagedUserRow = {
  id: 42,
  email: 'target@own.example.test',
  username: 'qa_target',
  displayName: 'Target',
  role: 'editor',
  isActive: true,
  createdAt: new Date('2026-06-01T12:00:00.000Z'),
  emailNormalized: 'target@own.example.test',
  usernameNormalized: 'qa_target',
};
const UPDATED: ManagedUserRow = { ...TARGET, displayName: 'After' };

type Outcome =
  | 'updated'
  | 'not_found'
  | 'authority_lost'
  | 'last_admin'
  | 'identity_conflict';

function makeStubRepository(outcome: Outcome) {
  const calls = { findCommunityUser: 0, updates: [] as unknown[] };
  const stub = {
    connection: db,
    communityIsActive: async () => true,
    findCommunityUser: async (_communityId: number, _id: number) => {
      calls.findCommunityUser += 1;
      return calls.findCommunityUser > 1 ? UPDATED : TARGET;
    },
    hasIdentityCollision: async () => false,
    updateCommunityUser: async (input: unknown) => {
      calls.updates.push(input);
      return outcome;
    },
    insertLoginCode: async () => ({ id: 1 }),
  };
  return {
    calls,
    repository: stub as unknown as UserManagementRepository,
  };
}

beforeAll(async () => {
  migrate(db, { migrationsFolder: 'src/db/migrations' });
  const now = new Date('2026-06-01T12:00:00.000Z');
  const [community] = await db
    .insert(tables.communities)
    .values({
      name: 'Own Nation',
      slug: 'own-nation',
      locale: 'en',
      publicStories: false,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: tables.communities.id });
  const [actor] = await db
    .insert(tables.users)
    .values({
      email: 'admin@own.example.test',
      username: 'qa_admin',
      ...{
        emailNormalized: 'admin@own.example.test',
        usernameNormalized: 'qa_admin',
      },
      firstName: 'Admin',
      lastName: 'Owner',
      passwordHash: 'irrelevant-here',
      role: 'admin',
      communityId: community.id,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: tables.users.id });
  ACTOR.id = actor.id;
  ACTOR.communityId = community.id;
});

afterAll(() => {
  sqlite.close();
});

async function auditRows(action: string) {
  return db
    .select()
    .from(tables.auditEntries)
    .where(eq(tables.auditEntries.action, action));
}

async function resetAudit() {
  await db.delete(tables.auditEntries);
}

describe('PATCH /v2/users/:id write-time identity guard', () => {
  it('passes unchanged supplied identifiers to the guarded write', async () => {
    const { repository, calls } = makeStubRepository('updated');
    const service = new UserManagementService(repository);
    await service.patchUser(ACTOR, '42', {
      email: TARGET.email,
      displayName: 'After',
    });
    const update = calls.updates[0] as {
      collision?: { emailNormalized?: string };
    };
    expect(update.collision?.emailNormalized).toBe(TARGET.emailNormalized);
  });
});

describe('PATCH /v2/users/:id when the guarded write refuses (Item 6)', () => {
  it('answers 404, never 200 with the pre-change row, and audits no success', async () => {
    await resetAudit();
    const { repository, calls } = makeStubRepository('not_found');
    const service = new UserManagementService(repository);
    const result = await service.patchUser(ACTOR, '42', {
      displayName: 'After',
    });
    expect(result.status).toBe(404);
    expect(result).toEqual({
      status: 404,
      body: { error: 'Not found' },
    });
    // The refusal is terminal: no post-write re-read, no success audit.
    expect(calls.findCommunityUser).toBe(1);
    expect(await auditRows('user.update')).toEqual([]);
  });

  it('answers 403 when the actor lost its admin authority mid-request', async () => {
    await resetAudit();
    const { repository } = makeStubRepository('authority_lost');
    const service = new UserManagementService(repository);
    const result = await service.patchUser(ACTOR, '42', {
      displayName: 'After',
    });
    expect(result.status).toBe(403);
    expect(await auditRows('user.update')).toEqual([]);
  });

  it('answers the uniform 409 on an identity conflict caught at write time', async () => {
    await resetAudit();
    const { repository } = makeStubRepository('identity_conflict');
    const service = new UserManagementService(repository);
    const result = await service.patchUser(ACTOR, '42', {
      displayName: 'After',
    });
    expect(result.status).toBe(409);
    expect(result).toEqual({ status: 409, body: { error: 'Conflict' } });
    const failures = (await auditRows('user.update')).filter(
      (row) => row.outcome === 'failure'
    );
    expect(failures.length).toBe(1);
    expect(failures[0]?.resourceIds).toEqual([42]);
  });

  it('answers 409 last_admin when the write would orphan the community', async () => {
    await resetAudit();
    const { repository } = makeStubRepository('last_admin');
    const service = new UserManagementService(repository);
    const result = await service.patchUser(ACTOR, '42', {
      role: 'editor',
    });
    expect(result.status).toBe(409);
    expect(result).toEqual({
      status: 409,
      body: { error: 'Conflict', code: 'last_admin' },
    });
    const failures = (await auditRows('user.update')).filter(
      (row) => row.outcome === 'failure'
    );
    expect(failures.length).toBe(1);
  });

  it('answers 200 and audits exactly one success when the write lands', async () => {
    await resetAudit();
    const { repository, calls } = makeStubRepository('updated');
    const service = new UserManagementService(repository);
    const result = await service.patchUser(ACTOR, '42', {
      displayName: 'After',
    });
    expect(result.status).toBe(200);
    expect(calls.findCommunityUser).toBe(2);
    const successes = (await auditRows('user.update')).filter(
      (row) => row.outcome === 'success'
    );
    expect(successes.length).toBe(1);
    expect(successes[0]?.resourceIds).toEqual([42]);
    expect(successes[0]?.communityId).toBe(ACTOR.communityId);
    expect(successes[0]?.actorId).toBe(ACTOR.id);
  });
});
