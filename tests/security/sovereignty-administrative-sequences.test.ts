import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import {
  communitiesSqlite,
  storiesSqlite,
  usersSqlite,
} from '../../src/db/schema/index.js';
import { hashPassword } from '../../src/services/password.service.js';
import { onAdministrativeAudit } from '../../src/shared/utils/audit-logger.js';
import type { AdministrativeAuditEvent } from '../../src/shared/authorization/administrative-policy.js';
import { createTestApp } from '../helpers/api-client.js';
import {
  TestDataFactory,
  testDb,
  type TestDatabase,
} from '../helpers/database.js';
import { extractSignedSessionCookie } from '../helpers/session-cookie.js';
import { TEST_PASSWORD } from '../constants/field-kit-test-constants.js';

/**
 * SPEC-V2 §7 "Test administrative sequences, not only direct content
 * requests": credential/membership issue then login/read, role or
 * membership change then read, private-to-public change then public read,
 * and bootstrap replay after setup. Each sequence runs end to end over HTTP
 * against a protected story that really belongs to the requested community,
 * so a cross-community denial cannot mask a broken authority check.
 *
 * Authority rules (SPEC-V2 §7 Bootstrap and account lifecycle):
 * - Community administrators authorize membership, community roles and
 *   publication. There is no anonymous signup path (§9 exceptions are login,
 *   authorized bootstrap/recovery and health only).
 * - System administrators manage lifecycle records but cannot acquire
 *   protected access by issuing credentials, changing membership/roles or
 *   changing publication. A first administrator may be provisioned only for
 *   a community that has never had a community account and holds no content.
 * - Membership, role and publication decisions are audited without content.
 */
describe('V2 sovereignty administrative sequences', () => {
  let app: FastifyInstance;
  let db: TestDatabase;
  let audit: AdministrativeAuditEvent[];
  let stopAudit: () => void;

  let privateCommunityId: number;
  let otherCommunityId: number;
  let emptyCommunityId: number;
  let contentOnlyCommunityId: number;
  let protectedStoryId: number;
  let unpublishedStoryId: number;
  let privateAdmin: { id: number; email: string };
  let privateViewer: { id: number; email: string };
  let otherAdmin: { id: number; email: string };
  let superAdmin: { id: number; email: string };

  const NEW_PASSWORD = 'SequenceProbe2026!Pass';
  const PROTECTED_TITLE = 'SEQUENCE-PROTECTED-TITLE';
  const UNPUBLISHED_TITLE = 'SEQUENCE-UNPUBLISHED-TITLE';

  async function login(
    email: string,
    communityId: number,
    password = TEST_PASSWORD
  ) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password, communityId },
    });
  }

  async function cookieFor(email: string, communityId: number) {
    const response = await login(email, communityId);
    expect(response.statusCode).toBe(200);
    return extractSignedSessionCookie(response.headers['set-cookie']);
  }

  async function readProtected(cookie?: string) {
    return app.inject({
      method: 'GET',
      url: `/api/v1/communities/${privateCommunityId}/stories/${protectedStoryId}`,
      headers: cookie ? { cookie } : {},
    });
  }

  async function readUnpublishedAnonymously() {
    return app.inject({
      method: 'GET',
      url: `/api/communities/${privateCommunityId}/stories/${unpublishedStoryId}`,
    });
  }

  function registerPayload(
    email: string,
    role: string,
    communityId = privateCommunityId
  ) {
    return {
      email,
      password: NEW_PASSWORD,
      firstName: 'Sequence',
      lastName: 'Probe',
      role,
      communityId,
    };
  }

  function expectContentFreeAudit(event: AdministrativeAuditEvent) {
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain(NEW_PASSWORD);
    expect(serialized).not.toContain('@example.test');
    expect(serialized).not.toContain(PROTECTED_TITLE);
    expect(serialized).not.toContain(UNPUBLISHED_TITLE);
    expect(Object.keys(event).sort()).toEqual(
      [
        'action',
        'actorCommunityId',
        'actorId',
        'allowed',
        'communityId',
        'event',
        'reason',
        'resourceId',
      ].sort()
    );
  }

  beforeEach(async () => {
    db = await testDb.setup();
    await testDb.clearData();
    audit = [];
    stopAudit = onAdministrativeAudit((event) => audit.push(event));

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const insertCommunity = async (name: string, publicStories: boolean) => {
      const [row] = await db
        .insert(communitiesSqlite)
        .values(
          TestDataFactory.createCommunity({
            name,
            slug: `${name.toLowerCase()}-${stamp}`,
            publicStories,
            isActive: true,
          })
        )
        .returning();
      return row.id;
    };

    privateCommunityId = await insertCommunity('SEQ-PRIVATE', false);
    otherCommunityId = await insertCommunity('SEQ-OTHER', true);
    emptyCommunityId = await insertCommunity('SEQ-EMPTY', false);
    contentOnlyCommunityId = await insertCommunity('SEQ-CONTENT-ONLY', false);

    const passwordHash = await hashPassword(TEST_PASSWORD);
    const insertUser = async (
      communityId: number,
      role: string,
      label: string
    ) => {
      const [row] = await db
        .insert(usersSqlite)
        .values(
          TestDataFactory.createUser(communityId, {
            email: `seq-${label}-${stamp}@example.test`,
            role: role as 'admin',
            passwordHash,
          })
        )
        .returning();
      return { id: row.id, email: row.email };
    };

    privateAdmin = await insertUser(privateCommunityId, 'admin', 'owner');
    privateViewer = await insertUser(privateCommunityId, 'viewer', 'viewer');
    otherAdmin = await insertUser(otherCommunityId, 'admin', 'other-admin');
    superAdmin = await insertUser(otherCommunityId, 'super_admin', 'system');

    const [protectedStory] = await db
      .insert(storiesSqlite)
      .values({
        title: PROTECTED_TITLE,
        slug: `seq-protected-${stamp}`,
        communityId: privateCommunityId,
        createdBy: privateAdmin.id,
        privacyLevel: 'members_only',
        isRestricted: false,
      })
      .returning();
    const [unpublishedStory] = await db
      .insert(storiesSqlite)
      .values({
        title: UNPUBLISHED_TITLE,
        slug: `seq-unpublished-${stamp}`,
        communityId: privateCommunityId,
        createdBy: privateAdmin.id,
        privacyLevel: 'public',
        isRestricted: false,
      })
      .returning();
    protectedStoryId = protectedStory.id;
    unpublishedStoryId = unpublishedStory.id;

    // A community with content but no community account: a first
    // administrator must not be provisioned into existing content.
    await db.insert(storiesSqlite).values({
      title: 'SEQ-ORPHAN-CONTENT',
      slug: `seq-orphan-${stamp}`,
      communityId: contentOnlyCommunityId,
      createdBy: privateAdmin.id,
      privacyLevel: 'members_only',
      isRestricted: false,
    });

    app = await createTestApp(db);
  });

  afterEach(async () => {
    stopAudit();
    await app.close();
    await testDb.teardown();
  });

  describe('registration then login then protected read', () => {
    it('rejects anonymous registration as admin into an existing private community', async () => {
      const email = `seq-anon-admin-${Date.now()}@example.test`;
      const register = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: registerPayload(email, 'admin'),
      });
      expect(register.statusCode).toBe(401);

      const loginAttempt = await login(email, privateCommunityId, NEW_PASSWORD);
      expect(loginAttempt.statusCode).toBe(401);

      const rows = await db
        .select()
        .from(usersSqlite)
        .where(eq(usersSqlite.email, email));
      expect(rows).toHaveLength(0);

      const denial = audit.find((event) => event.action === 'enrollment');
      expect(denial).toMatchObject({
        allowed: false,
        reason: 'anonymous',
        actorId: null,
        communityId: privateCommunityId,
      });
      expectContentFreeAudit(denial!);
    });

    it('rejects anonymous registration for every role and for an empty community (no public signup, no bootstrap replay)', async () => {
      for (const [role, communityId] of [
        ['viewer', privateCommunityId],
        ['editor', privateCommunityId],
        ['super_admin', privateCommunityId],
        ['admin', emptyCommunityId],
      ] as const) {
        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/auth/register',
          payload: registerPayload(
            `seq-anon-${role}-${communityId}@example.test`,
            role,
            communityId
          ),
        });
        expect(response.statusCode).toBe(401);
      }
      const created = await db
        .select()
        .from(usersSqlite)
        .where(eq(usersSqlite.firstName, 'Sequence'));
      expect(created).toHaveLength(0);
    });

    it('rejects registration by a same-community viewer, an other-community admin and a super admin', async () => {
      const callers = [
        { user: privateViewer, communityId: privateCommunityId },
        { user: otherAdmin, communityId: otherCommunityId },
        { user: superAdmin, communityId: otherCommunityId },
      ];
      for (const [index, caller] of callers.entries()) {
        const cookie = await cookieFor(caller.user.email, caller.communityId);
        const email = `seq-escalate-${index}@example.test`;
        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/auth/register',
          headers: { cookie },
          payload: registerPayload(email, 'admin'),
        });
        expect(response.statusCode).toBe(403);
        const loginAttempt = await login(
          email,
          privateCommunityId,
          NEW_PASSWORD
        );
        expect(loginAttempt.statusCode).toBe(401);
      }
      const reasons = audit
        .filter((event) => event.action === 'enrollment')
        .map((event) => event.reason);
      expect(reasons).toEqual([
        'not-community-admin',
        'cross-community',
        'system-privilege-is-not-community-authority',
      ]);
    });

    it('rejects a community admin minting a super_admin account', async () => {
      const cookie = await cookieFor(privateAdmin.email, privateCommunityId);
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        headers: { cookie },
        payload: registerPayload('seq-mint-system@example.test', 'super_admin'),
      });
      expect(response.statusCode).toBe(403);
    });

    it('lets a same-community admin enroll a member, who then reads the community audience', async () => {
      const cookie = await cookieFor(privateAdmin.email, privateCommunityId);
      const email = 'seq-enrolled-member@example.test';
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        headers: { cookie },
        payload: registerPayload(email, 'viewer'),
      });
      expect(response.statusCode).toBe(201);

      const memberCookie = extractSignedSessionCookie(
        (await login(email, privateCommunityId, NEW_PASSWORD)).headers[
          'set-cookie'
        ]
      );
      const read = await readProtected(memberCookie);
      expect(read.statusCode).toBe(200);
      expect(read.body).toContain(PROTECTED_TITLE);

      const grant = audit.find((event) => event.action === 'enrollment');
      expect(grant).toMatchObject({
        allowed: true,
        reason: 'community-admin',
        actorId: privateAdmin.id,
        communityId: privateCommunityId,
      });
      expectContentFreeAudit(grant!);
    });
  });

  describe('system account creation then login then protected read', () => {
    it('rejects a super admin creating an admin with chosen credentials in a community that has an administrator', async () => {
      const cookie = await cookieFor(superAdmin.email, otherCommunityId);
      const email = 'seq-system-minted-admin@example.test';
      const create = await app.inject({
        method: 'POST',
        url: '/api/v1/super_admin/users',
        headers: { cookie },
        payload: registerPayload(email, 'admin'),
      });
      expect(create.statusCode).toBe(403);
      expect(create.body).not.toContain(PROTECTED_TITLE);

      const loginAttempt = await login(email, privateCommunityId, NEW_PASSWORD);
      expect(loginAttempt.statusCode).toBe(401);
      expect((await readProtected()).statusCode).not.toBe(200);

      const denial = audit.find(
        (event) => event.action === 'system_account_create'
      );
      expect(denial).toMatchObject({
        allowed: false,
        reason: 'community-claimed-or-holds-content',
        actorId: superAdmin.id,
        communityId: privateCommunityId,
      });
      expectContentFreeAudit(denial!);
    });

    it('rejects a super admin creating a non-admin member account in any community', async () => {
      const cookie = await cookieFor(superAdmin.email, otherCommunityId);
      for (const [role, communityId] of [
        ['viewer', privateCommunityId],
        ['editor', privateCommunityId],
        ['viewer', emptyCommunityId],
      ] as const) {
        const create = await app.inject({
          method: 'POST',
          url: '/api/v1/super_admin/users',
          headers: { cookie },
          payload: registerPayload(
            `seq-system-${role}-${communityId}@example.test`,
            role,
            communityId
          ),
        });
        expect(create.statusCode).toBe(403);
      }
    });

    it('rejects a first administrator for a community that holds content', async () => {
      const cookie = await cookieFor(superAdmin.email, otherCommunityId);
      const create = await app.inject({
        method: 'POST',
        url: '/api/v1/super_admin/users',
        headers: { cookie },
        payload: registerPayload(
          'seq-content-claim@example.test',
          'admin',
          contentOnlyCommunityId
        ),
      });
      expect(create.statusCode).toBe(403);
    });

    it('provisions the first administrator of an empty community once, then refuses replay', async () => {
      const cookie = await cookieFor(superAdmin.email, otherCommunityId);
      const first = await app.inject({
        method: 'POST',
        url: '/api/v1/super_admin/users',
        headers: { cookie },
        payload: registerPayload(
          'seq-first-admin@example.test',
          'admin',
          emptyCommunityId
        ),
      });
      expect(first.statusCode).toBe(201);

      const replay = await app.inject({
        method: 'POST',
        url: '/api/v1/super_admin/users',
        headers: { cookie },
        payload: registerPayload(
          'seq-second-admin@example.test',
          'admin',
          emptyCommunityId
        ),
      });
      expect(replay.statusCode).toBe(403);

      const decisions = audit
        .filter((event) => event.action === 'system_account_create')
        .map((event) => [event.allowed, event.reason]);
      expect(decisions).toEqual([
        [true, 'unclaimed-empty-community'],
        [false, 'community-claimed-or-holds-content'],
      ]);
    });

    it('does not count a Fastify super_admin row as a community account', async () => {
      // Fastify V1 super_admin rows carry a NOT NULL communityId; SPEC-V2
      // maps them to communityId-free system accounts, so they never claim
      // the community they happen to sit in.
      await db.insert(usersSqlite).values(
        TestDataFactory.createUser(emptyCommunityId, {
          email: 'seq-resident-system@example.test',
          role: 'super_admin',
          passwordHash: await hashPassword(TEST_PASSWORD),
        })
      );
      const cookie = await cookieFor(superAdmin.email, otherCommunityId);
      const first = await app.inject({
        method: 'POST',
        url: '/api/v1/super_admin/users',
        headers: { cookie },
        payload: registerPayload(
          'seq-first-admin-beside-system@example.test',
          'admin',
          emptyCommunityId
        ),
      });
      expect(first.statusCode).toBe(201);
    });

    it('creates system accounts that still cannot read protected community content', async () => {
      const cookie = await cookieFor(superAdmin.email, otherCommunityId);
      const email = 'seq-new-system@example.test';
      const create = await app.inject({
        method: 'POST',
        url: '/api/v1/super_admin/users',
        headers: { cookie },
        payload: registerPayload(email, 'super_admin', privateCommunityId),
      });
      expect(create.statusCode).toBe(201);

      const systemLogin = await login(email, privateCommunityId, NEW_PASSWORD);
      expect(systemLogin.statusCode).toBe(200);
      const read = await readProtected(
        extractSignedSessionCookie(systemLogin.headers['set-cookie'])
      );
      expect(read.statusCode).not.toBe(200);
      expect(read.body).not.toContain(PROTECTED_TITLE);
    });
  });

  describe('role or membership change then read', () => {
    async function superAdminUpdate(userId: number, payload: object) {
      const cookie = await cookieFor(superAdmin.email, otherCommunityId);
      return app.inject({
        method: 'PUT',
        url: `/api/v1/super_admin/users/${userId}`,
        headers: { cookie },
        payload,
      });
    }

    it('rejects turning a system account into an admin of a protected community', async () => {
      const cookie = await cookieFor(superAdmin.email, otherCommunityId);
      const email = 'seq-system-to-admin@example.test';
      const create = await app.inject({
        method: 'POST',
        url: '/api/v1/super_admin/users',
        headers: { cookie },
        payload: registerPayload(email, 'super_admin', privateCommunityId),
      });
      expect(create.statusCode).toBe(201);
      const systemAccountId = JSON.parse(create.body).data.id as number;

      const update = await superAdminUpdate(systemAccountId, {
        role: 'admin',
        communityId: privateCommunityId,
      });
      expect(update.statusCode).toBe(403);

      const read = await readProtected(
        await cookieFor(email, privateCommunityId).catch(() => undefined)
      );
      expect(read.statusCode).not.toBe(200);
      expect(read.body).not.toContain(PROTECTED_TITLE);

      const [row] = await db
        .select()
        .from(usersSqlite)
        .where(eq(usersSqlite.id, systemAccountId));
      expect(row.role).toBe('super_admin');

      const denial = audit.find(
        (event) => event.action === 'system_account_update'
      );
      expect(denial).toMatchObject({
        allowed: false,
        reason: 'system-privilege-is-not-community-authority',
        resourceId: systemAccountId,
      });
      expectContentFreeAudit(denial!);
    });

    it('rejects a super admin promoting a member or moving an admin across communities', async () => {
      const promote = await superAdminUpdate(privateViewer.id, {
        role: 'admin',
      });
      expect(promote.statusCode).toBe(403);
      const move = await superAdminUpdate(otherAdmin.id, {
        communityId: privateCommunityId,
      });
      expect(move.statusCode).toBe(403);

      const moved = await login(otherAdmin.email, privateCommunityId);
      expect(moved.statusCode).toBe(401);

      const [viewerRow] = await db
        .select()
        .from(usersSqlite)
        .where(eq(usersSqlite.id, privateViewer.id));
      expect(viewerRow.role).toBe('viewer');
    });

    it('keeps profile and lifecycle updates available to a super admin', async () => {
      const rename = await superAdminUpdate(privateViewer.id, {
        firstName: 'Renamed',
      });
      expect(rename.statusCode).toBe(200);
      const deactivate = await superAdminUpdate(privateViewer.id, {
        isActive: false,
      });
      expect(deactivate.statusCode).toBe(200);
      const unchangedRole = await superAdminUpdate(privateViewer.id, {
        role: 'viewer',
        communityId: privateCommunityId,
      });
      expect(unchangedRole.statusCode).toBe(200);
    });
  });

  describe('private-to-public change then public read', () => {
    it('rejects a super admin publishing a private community', async () => {
      expect((await readUnpublishedAnonymously()).statusCode).toBe(404);

      const cookie = await cookieFor(superAdmin.email, otherCommunityId);
      const publish = await app.inject({
        method: 'PUT',
        url: `/api/v1/super_admin/communities/${privateCommunityId}`,
        headers: { cookie },
        payload: { publicStories: true },
      });
      expect(publish.statusCode).toBe(403);

      const after = await readUnpublishedAnonymously();
      expect(after.statusCode).toBe(404);
      expect(after.body).not.toContain(UNPUBLISHED_TITLE);

      const [community] = await db
        .select()
        .from(communitiesSqlite)
        .where(eq(communitiesSqlite.id, privateCommunityId));
      expect(community.publicStories).toBe(false);

      const denial = audit.find(
        (event) => event.action === 'publication_change'
      );
      expect(denial).toMatchObject({
        allowed: false,
        reason: 'system-privilege-is-not-community-authority',
        actorId: superAdmin.id,
        communityId: privateCommunityId,
      });
      expectContentFreeAudit(denial!);
    });

    it('rejects publication changes bundled with lifecycle fields', async () => {
      const cookie = await cookieFor(superAdmin.email, otherCommunityId);
      const publish = await app.inject({
        method: 'PUT',
        url: `/api/v1/super_admin/communities/${privateCommunityId}`,
        headers: { cookie },
        payload: { name: 'SEQ-RENAMED', publicStories: true },
      });
      expect(publish.statusCode).toBe(403);

      const [community] = await db
        .select()
        .from(communitiesSqlite)
        .where(eq(communitiesSqlite.id, privateCommunityId));
      expect(community.name).toBe('SEQ-PRIVATE');
      expect(community.publicStories).toBe(false);
    });

    it('rejects a super admin unpublishing a public community', async () => {
      const cookie = await cookieFor(superAdmin.email, otherCommunityId);
      const unpublish = await app.inject({
        method: 'PUT',
        url: `/api/v1/super_admin/communities/${otherCommunityId}`,
        headers: { cookie },
        payload: { publicStories: false },
      });
      expect(unpublish.statusCode).toBe(403);
    });

    it('keeps lifecycle community updates and unchanged publication available', async () => {
      const cookie = await cookieFor(superAdmin.email, otherCommunityId);
      const rename = await app.inject({
        method: 'PUT',
        url: `/api/v1/super_admin/communities/${privateCommunityId}`,
        headers: { cookie },
        payload: { name: 'SEQ-RENAMED', publicStories: false },
      });
      expect(rename.statusCode).toBe(200);
      expect((await readUnpublishedAnonymously()).statusCode).toBe(404);
    });
  });

  describe('reactivation then login then protected read', () => {
    it('rejects a super admin reactivating an account the community deactivated', async () => {
      // The community admin revokes a member; system privilege must not
      // undo that revocation (SPEC-V2 §7 "changing membership").
      const adminCookie = await cookieFor(
        privateAdmin.email,
        privateCommunityId
      );
      const deactivate = await app.inject({
        method: 'PATCH',
        url: `/api/v1/users/${privateViewer.id}`,
        headers: { cookie: adminCookie },
        payload: { isActive: false },
      });
      expect(deactivate.statusCode).toBe(200);
      expect(
        (await login(privateViewer.email, privateCommunityId)).statusCode
      ).toBe(401);

      const systemCookie = await cookieFor(superAdmin.email, otherCommunityId);
      const reactivate = await app.inject({
        method: 'PUT',
        url: `/api/v1/super_admin/users/${privateViewer.id}`,
        headers: { cookie: systemCookie },
        payload: { isActive: true },
      });
      expect(reactivate.statusCode).toBe(403);

      expect(
        (await login(privateViewer.email, privateCommunityId)).statusCode
      ).toBe(401);
      const [row] = await db
        .select()
        .from(usersSqlite)
        .where(eq(usersSqlite.id, privateViewer.id));
      expect(row.isActive).toBe(false);

      const denial = audit.find(
        (event) => event.action === 'system_account_update'
      );
      expect(denial).toMatchObject({
        allowed: false,
        reason: 'reactivation-requires-community-authority',
        resourceId: privateViewer.id,
      });
      expectContentFreeAudit(denial!);
    });

    it('lets a super admin reactivate a system account', async () => {
      const [system] = await db
        .insert(usersSqlite)
        .values(
          TestDataFactory.createUser(otherCommunityId, {
            email: 'seq-inactive-system@example.test',
            role: 'super_admin',
            isActive: false,
            passwordHash: await hashPassword(TEST_PASSWORD),
          })
        )
        .returning();
      const systemCookie = await cookieFor(superAdmin.email, otherCommunityId);
      const reactivate = await app.inject({
        method: 'PUT',
        url: `/api/v1/super_admin/users/${system.id}`,
        headers: { cookie: systemCookie },
        payload: { isActive: true },
      });
      expect(reactivate.statusCode).toBe(200);
    });
  });

  describe('concurrent first-administrator provisioning', () => {
    it('provisions exactly one administrator when requests race', async () => {
      const cookie = await cookieFor(superAdmin.email, otherCommunityId);
      const responses = await Promise.all(
        [0, 1, 2, 3, 4].map((index) =>
          app.inject({
            method: 'POST',
            url: '/api/v1/super_admin/users',
            headers: { cookie },
            payload: registerPayload(
              `seq-race-${index}@example.test`,
              'admin',
              emptyCommunityId
            ),
          })
        )
      );
      const statuses = responses.map((response) => response.statusCode).sort();
      expect(statuses).toEqual([201, 403, 403, 403, 403]);

      const admins = await db
        .select()
        .from(usersSqlite)
        .where(eq(usersSqlite.communityId, emptyCommunityId));
      expect(admins).toHaveLength(1);

      const decisions = audit.filter(
        (event) => event.action === 'system_account_create'
      );
      expect(decisions.filter((event) => event.allowed)).toHaveLength(1);
      expect(decisions.filter((event) => !event.allowed)).toHaveLength(4);
    });
  });

  describe('community-admin enrollment through /api/v1/users', () => {
    it('audits a community admin creating a member, who then reads the community audience', async () => {
      const cookie = await cookieFor(privateAdmin.email, privateCommunityId);
      const email = 'seq-users-route-member@example.test';
      const create = await app.inject({
        method: 'POST',
        url: '/api/v1/users',
        headers: { cookie },
        payload: {
          email,
          password: NEW_PASSWORD,
          firstName: 'Sequence',
          lastName: 'Probe',
          role: 'viewer',
        },
      });
      expect(create.statusCode).toBe(201);

      const grant = audit.find((event) => event.action === 'enrollment');
      expect(grant).toMatchObject({
        allowed: true,
        reason: 'community-admin',
        actorId: privateAdmin.id,
        communityId: privateCommunityId,
      });
      expectContentFreeAudit(grant!);

      const read = await readProtected(
        extractSignedSessionCookie(
          (await login(email, privateCommunityId, NEW_PASSWORD)).headers[
            'set-cookie'
          ]
        )
      );
      expect(read.statusCode).toBe(200);
    });

    it('audits role changes made by a community admin', async () => {
      const cookie = await cookieFor(privateAdmin.email, privateCommunityId);
      const promote = await app.inject({
        method: 'PATCH',
        url: `/api/v1/users/${privateViewer.id}`,
        headers: { cookie },
        payload: { role: 'editor' },
      });
      expect(promote.statusCode).toBe(200);
      const change = audit.find(
        (event) => event.action === 'membership_change'
      );
      expect(change).toMatchObject({
        allowed: true,
        reason: 'community-admin',
        actorId: privateAdmin.id,
        communityId: privateCommunityId,
        resourceId: privateViewer.id,
      });
      expectContentFreeAudit(change!);
    });
  });

  describe('community-admin publication then public read', () => {
    const publication = (
      cookie: string | undefined,
      publicStories: boolean,
      communityId = privateCommunityId
    ) =>
      app.inject({
        method: 'PUT',
        url: `/api/v1/communities/${communityId}/publication`,
        headers: cookie ? { cookie } : {},
        payload: { publicStories },
      });

    it('lets the community admin publish, after which anonymous callers read public stories', async () => {
      expect((await readUnpublishedAnonymously()).statusCode).toBe(404);

      const cookie = await cookieFor(privateAdmin.email, privateCommunityId);
      const publish = await publication(cookie, true);
      expect(publish.statusCode).toBe(200);
      expect(publish.json()).toMatchObject({
        data: { id: privateCommunityId, publicStories: true },
      });

      const after = await readUnpublishedAnonymously();
      expect(after.statusCode).toBe(200);
      expect(after.body).toContain(UNPUBLISHED_TITLE);
      // Publication never widens a story audience.
      expect((await readProtected()).statusCode).not.toBe(200);

      const grant = audit.find(
        (event) => event.action === 'publication_change'
      );
      expect(grant).toMatchObject({
        allowed: true,
        reason: 'community-admin',
        actorId: privateAdmin.id,
        communityId: privateCommunityId,
      });
      expectContentFreeAudit(grant!);

      const unpublish = await publication(cookie, false);
      expect(unpublish.statusCode).toBe(200);
      expect((await readUnpublishedAnonymously()).statusCode).toBe(404);
    });

    it('rejects publication by anonymous callers, members, other-community admins and super admins', async () => {
      expect((await publication(undefined, true)).statusCode).toBe(401);
      const callers = [
        { user: privateViewer, communityId: privateCommunityId },
        { user: otherAdmin, communityId: otherCommunityId },
        { user: superAdmin, communityId: otherCommunityId },
      ];
      for (const caller of callers) {
        const cookie = await cookieFor(caller.user.email, caller.communityId);
        expect((await publication(cookie, true)).statusCode).toBe(403);
      }
      expect((await readUnpublishedAnonymously()).statusCode).toBe(404);
      const [community] = await db
        .select()
        .from(communitiesSqlite)
        .where(eq(communitiesSqlite.id, privateCommunityId));
      expect(community.publicStories).toBe(false);
      const reasons = audit
        .filter((event) => event.action === 'publication_change')
        .map((event) => event.reason);
      expect(reasons).toEqual([
        'anonymous',
        'not-community-admin',
        'cross-community',
        'system-privilege-is-not-community-authority',
      ]);
    });
  });
});
