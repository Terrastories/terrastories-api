import { afterEach, describe, expect, it } from 'vitest';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { createHonoApp } from '../../src/hono-app.js';
import { HonoFoundationRepository } from '../../src/repositories/hono-foundation.repository.js';
import { writeAuditEntry } from '../../src/repositories/audit-entry.repository.js';
import type { FoundationStorage } from '../../src/services/hono-foundation.service.js';
import { tablesFor } from '../../src/db/dialect.js';
import { deriveUserIdentityColumns } from '../../src/shared/utils/derived-columns.js';
import { CommunityAuditEntriesListResponseSchema } from '../../src/shared/schemas/community-audit.js';
import {
  argon2Seed,
  makeDerivedKey,
  makeServerSecret,
} from './auth-test-utils.js';

const API_ORIGIN = 'https://audit.example.test';
const T0 = new Date('2026-11-21T10:00:00.000Z');

const noopStorage: FoundationStorage = {
  async read() {
    return null;
  },
};

describe('Slice 13a community audit-entries read endpoint', () => {
  const openDbs: Sqlite.Database[] = [];

  afterEach(() => {
    while (openDbs.length > 0) {
      openDbs.pop()?.close();
    }
  });

  async function setupEnv() {
    const sqlite = new Sqlite(':memory:');
    sqlite.pragma('foreign_keys = ON');
    openDbs.push(sqlite);
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: 'src/db/migrations' });
    const tables = tablesFor(db);

    const app = createHonoApp({
      repository: new HonoFoundationRepository(db),
      storage: noopStorage,
      serverSecret: makeServerSecret(),
      now: () => T0,
      secureCookies: false,
    });

    db.insert(tables.communities)
      .values([
        {
          id: 1,
          name: 'Active Nation',
          slug: 'active-nation',
          publicStories: false,
          isActive: true,
          createdAt: T0,
          updatedAt: T0,
        },
        {
          id: 2,
          name: 'Foreign Nation',
          slug: 'foreign-nation',
          publicStories: true,
          isActive: true,
          createdAt: T0,
          updatedAt: T0,
        },
        {
          id: 3,
          name: 'Disabled Nation',
          slug: 'disabled-nation',
          publicStories: false,
          isActive: false,
          createdAt: T0,
          updatedAt: T0,
        },
      ])
      .run();

    const derivedKey = makeDerivedKey();
    const creds = await argon2Seed(derivedKey);

    const seedUser = (
      id: number,
      email: string,
      username: string,
      role: 'admin' | 'editor' | 'member' | 'viewer' | 'super_admin',
      communityId: number | null
    ) => {
      db.insert(tables.users)
        .values({
          id,
          email,
          username,
          ...deriveUserIdentityColumns({ email, username }),
          firstName: role,
          lastName: 'User',
          ...creds,
          role,
          communityId,
          isActive: true,
          createdAt: T0,
          updatedAt: T0,
        })
        .run();
    };

    seedUser(1, 'admin1@c1.test', 'c1_admin1', 'admin', 1);
    seedUser(2, 'editor@c1.test', 'c1_editor', 'editor', 1);
    seedUser(3, 'member@c1.test', 'c1_member', 'member', 1);
    seedUser(4, 'viewer@c1.test', 'c1_viewer', 'viewer', 1);
    seedUser(5, 'admin@c2.test', 'c2_admin', 'admin', 2);
    seedUser(6, 'admin@c3.test', 'c3_admin', 'admin', 3);
    seedUser(7, 'super@sys.test', 'sys_super', 'super_admin', null);

    // Seed community 1 audit entries across timestamps (including same-ms tie),
    // ClaimToken events, scrubbed and unscrubbed auth events, and export lifecycle events.
    const tClaim = new Date('2026-11-21T08:00:00.000Z');
    const tAuthScrubbed = new Date('2026-11-21T08:30:00.000Z');
    const tTie = new Date('2026-11-21T09:00:00.000Z');
    const tExport = new Date('2026-11-21T09:30:00.000Z');

    const c1ClaimIssue = await writeAuditEntry(
      db,
      {
        communityId: 1,
        actorId: 7,
        action: 'claim_token.issue',
        resourceType: 'claim_token',
        resourceIds: [11],
        outcome: 'success',
        ipAddress: null,
        userAgent: null,
      },
      tClaim
    );
    const c1ClaimConsume = await writeAuditEntry(
      db,
      {
        communityId: 1,
        actorId: 1,
        action: 'claim_token.consume',
        resourceType: 'claim_token',
        resourceIds: [11],
        outcome: 'success',
        ipAddress: '198.51.100.10',
        userAgent: 'ClaimAgent/1.0',
      },
      tAuthScrubbed
    );
    const c1StoryWrite = await writeAuditEntry(
      db,
      {
        communityId: 1,
        actorId: 2,
        action: 'story.create',
        resourceType: 'story',
        resourceIds: [101],
        outcome: 'success',
        ipAddress: null,
        userAgent: null,
      },
      tTie
    );
    const c1UserFail = await writeAuditEntry(
      db,
      {
        communityId: 1,
        actorId: 1,
        action: 'user.password_reset',
        resourceType: 'user',
        resourceIds: [3],
        outcome: 'failure',
        ipAddress: null,
        userAgent: null,
      },
      tTie
    );
    const c1ExportGen = await writeAuditEntry(
      db,
      {
        communityId: 1,
        actorId: 1,
        action: 'community.export.generate',
        resourceType: 'community_export',
        resourceIds: ['export-job-1'],
        outcome: 'success',
        ipAddress: null,
        userAgent: null,
      },
      tExport
    );

    // Seed foreign community (2) and system (null) rows that must NEVER leak.
    await writeAuditEntry(
      db,
      {
        communityId: 2,
        actorId: 5,
        action: 'community.update',
        resourceType: 'community',
        resourceIds: [2],
        outcome: 'success',
        ipAddress: null,
        userAgent: null,
      },
      tExport
    );
    await writeAuditEntry(
      db,
      {
        communityId: null,
        actorId: 7,
        action: 'bootstrap.complete',
        resourceType: 'system',
        resourceIds: [],
        outcome: 'success',
        ipAddress: '192.0.2.5',
        userAgent: 'SysAgent/1.0',
      },
      tExport
    );

    const loginAs = async (email: string) => {
      const res = await app.request(`${API_ORIGIN}/v2/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ identifier: email, derivedKey }),
      });
      expect(res.status).toBe(200);
      return res.headers.get('set-cookie')!.split(';')[0]!;
    };

    return {
      db,
      tables,
      app,
      loginAs,
      seededIds: {
        c1ClaimIssue: c1ClaimIssue.id,
        c1ClaimConsume: c1ClaimConsume.id,
        c1StoryWrite: c1StoryWrite.id,
        c1UserFail: c1UserFail.id,
        c1ExportGen: c1ExportGen.id,
      },
      timestamps: { tClaim, tAuthScrubbed, tTie, tExport },
    };
  }

  it('returns community-scoped content-free audit entries in descending order with ClaimToken, export, pagination, and filters', async () => {
    const env = await setupEnv();
    const adminCookie = await env.loginAs('admin1@c1.test');

    // Note: loginAs also wrote an `auth.login` entry at T0 for user 1.
    const page1Res = await env.app.request(
      `${API_ORIGIN}/v2/community/audit-entries?limit=3&offset=0`,
      { headers: { cookie: adminCookie } }
    );
    expect(page1Res.status).toBe(200);
    const page1 = CommunityAuditEntriesListResponseSchema.parse(
      await page1Res.json()
    );
    expect(page1.meta).toEqual({
      total: 6, // 5 seeded + 1 auth.login
      limit: 3,
      offset: 0,
      hasNextPage: true,
    });
    expect(page1.data).toHaveLength(3);
    // Strict community isolation: every row belongs to community 1.
    expect(page1.data.every((e) => e.communityId === 1)).toBe(true);
    // Ordering: auth.login (T0) -> c1ExportGen (tExport) -> c1UserFail (tTie, higher id)
    expect(page1.data.map((e) => e.action)).toEqual([
      'auth.login',
      'community.export.generate',
      'user.password_reset',
    ]);
    expect(page1.data[2]!.id).toBe(env.seededIds.c1UserFail);

    const page2Res = await env.app.request(
      `${API_ORIGIN}/v2/community/audit-entries?limit=3&offset=3`,
      { headers: { cookie: adminCookie } }
    );
    expect(page2Res.status).toBe(200);
    const page2 = CommunityAuditEntriesListResponseSchema.parse(
      await page2Res.json()
    );
    expect(page2.meta).toEqual({
      total: 6,
      limit: 3,
      offset: 3,
      hasNextPage: false,
    });
    expect(page2.data.map((e) => e.id)).toEqual([
      env.seededIds.c1StoryWrite,
      env.seededIds.c1ClaimConsume,
      env.seededIds.c1ClaimIssue,
    ]);
    expect(page2.data[1]!.ipAddress).toBe('198.51.100.10');
    expect(page2.data[1]!.userAgent).toBe('ClaimAgent/1.0');
    expect(page2.data[2]!.ipAddress).toBeNull();
    expect(page2.data[2]!.userAgent).toBeNull();

    // Past-end offset returns empty data with hasNextPage = false.
    const emptyPageRes = await env.app.request(
      `${API_ORIGIN}/v2/community/audit-entries?limit=10&offset=50`,
      { headers: { cookie: adminCookie } }
    );
    expect(emptyPageRes.status).toBe(200);
    const emptyPage = CommunityAuditEntriesListResponseSchema.parse(
      await emptyPageRes.json()
    );
    expect(emptyPage.data).toEqual([]);
    expect(emptyPage.meta.hasNextPage).toBe(false);

    // Filter by resourceType=claim_token includes both issue and consume events.
    const claimRes = await env.app.request(
      `${API_ORIGIN}/v2/community/audit-entries?resourceType=claim_token`,
      { headers: { cookie: adminCookie } }
    );
    expect(claimRes.status).toBe(200);
    const claimPayload = CommunityAuditEntriesListResponseSchema.parse(
      await claimRes.json()
    );
    expect(claimPayload.data.map((e) => e.action)).toEqual([
      'claim_token.consume',
      'claim_token.issue',
    ]);

    // Filter by action, outcome, actorId, and from/to window combined.
    const filteredRes = await env.app.request(
      `${API_ORIGIN}/v2/community/audit-entries?action=user.password_reset&outcome=failure&actorId=1&from=${encodeURIComponent(env.timestamps.tTie.toISOString())}&to=${encodeURIComponent(env.timestamps.tTie.toISOString())}`,
      { headers: { cookie: adminCookie } }
    );
    expect(filteredRes.status).toBe(200);
    const filtered = CommunityAuditEntriesListResponseSchema.parse(
      await filteredRes.json()
    );
    expect(filtered.meta.total).toBe(1);
    expect(filtered.data[0]!.id).toBe(env.seededIds.c1UserFail);
  });

  it('rejects unauthenticated, non-admin, super_admin, disabled-community admin, cross-community queries, and malformed filters', async () => {
    const env = await setupEnv();
    const adminCookie = await env.loginAs('admin1@c1.test');
    const editorCookie = await env.loginAs('editor@c1.test');
    const memberCookie = await env.loginAs('member@c1.test');
    const viewerCookie = await env.loginAs('viewer@c1.test');
    const foreignAdminCookie = await env.loginAs('admin@c2.test');
    const disabledAdminCookie = await env.loginAs('admin@c3.test');
    const superCookie = await env.loginAs('super@sys.test');

    // Unauthenticated -> 401
    expect(
      (await env.app.request(`${API_ORIGIN}/v2/community/audit-entries`)).status
    ).toBe(401);

    // Non-admins, super_admin, and disabled community admin -> 403
    for (const cookie of [
      editorCookie,
      memberCookie,
      viewerCookie,
      superCookie,
      disabledAdminCookie,
    ]) {
      const res = await env.app.request(
        `${API_ORIGIN}/v2/community/audit-entries`,
        { headers: { cookie } }
      );
      expect(res.status).toBe(403);
    }

    // Foreign admin sees ONLY community 2 rows (zero leakage of community 1 or system rows).
    const foreignRes = await env.app.request(
      `${API_ORIGIN}/v2/community/audit-entries`,
      { headers: { cookie: foreignAdminCookie } }
    );
    expect(foreignRes.status).toBe(200);
    const foreignBody = CommunityAuditEntriesListResponseSchema.parse(
      await foreignRes.json()
    );
    expect(foreignBody.data.every((e) => e.communityId === 2)).toBe(true);
    expect(
      foreignBody.data.some((e) => e.action === 'bootstrap.complete')
    ).toBe(false);

    // Malformed query inputs -> 400
    const badQueries = [
      '?communityId=2',
      '?limit=1&limit=2',
      '?limit=0',
      '?limit=101',
      '?offset=-1',
      '?actorId=0',
      '?actorId=abc',
      '?action=BAD_ACTION',
      '?resourceType=Invalid!',
      '?outcome=OK',
      '?from=not-a-date',
      '?to=2026-11-21',
      '?from=2026-11-21T10:00:00.000Z&to=2026-11-21T09:00:00.000Z',
    ];
    for (const qs of badQueries) {
      const res = await env.app.request(
        `${API_ORIGIN}/v2/community/audit-entries${qs}`,
        { headers: { cookie: adminCookie } }
      );
      expect(res.status, `expected 400 for ${qs}`).toBe(400);
    }
  });
});
