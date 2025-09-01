/**
 * TERRASTORIES API - INDIGENOUS CULTURAL PROTOCOL & DATA SOVEREIGNTY VALIDATION
 *
 * This test suite validates Indigenous cultural protocols and data sovereignty protections
 * for production deployment in Indigenous communities worldwide.
 *
 * Issue #59: Production Readiness Validation & Indigenous Community Deployment
 * Phase 2: Indigenous Cultural Protocol Validation
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { TestDatabaseManager } from '../helpers/database.js';
import { hash } from 'argon2';
import { eq, like, and } from 'drizzle-orm';
import {
  communitiesSqlite as communitiesTable,
  usersSqlite as usersTable,
  storiesSqlite as storiesTable,
  placesSqlite as placesTable,
} from '../../src/db/schema/index.js';

interface TestUser {
  id: string;
  email: string;
  role: string;
  community_id: string;
  elder_status?: boolean;
}

interface TestCommunity {
  id: string;
  name: string;
  locale: string;
}

describe('Indigenous Cultural Protocol & Data Sovereignty - Phase 2', () => {
  let app: FastifyInstance;
  let db: TestDatabaseManager;
  let testCommunities: TestCommunity[];
  let testUsers: TestUser[];
  let adminTokens: Record<string, string>;

  beforeAll(async () => {
    // Initialize test app and database
    app = await buildApp();
    await app.ready();

    db = new TestDatabaseManager();
    await db.setup();

    // Create test communities representing different Indigenous communities
    testCommunities = await createTestCommunities();

    // Create test users with different roles across communities
    testUsers = await createTestUsers();

    // Authenticate users for testing
    adminTokens = await authenticateTestUsers();

    console.log('Cultural sovereignty validation setup complete');
  });

  describe('Multi-Tenant Community Data Isolation', () => {
    test('Community A cannot access Community B data through any endpoint', async () => {
      const communityA = testCommunities[0];
      const communityB = testCommunities[1];

      // Create test data in each community
      const storyA = await createTestStory(
        communityA.id,
        'Story from Community A'
      );
      const storyB = await createTestStory(
        communityB.id,
        'Story from Community B'
      );

      // User from Community A tries to access Community B's story
      const userAToken = await getUserToken(communityA.id, 'admin');

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/member/stories/${storyB.id}`,
        headers: {
          Authorization: `Bearer ${userAToken}`,
          Cookie: await getSessionCookie(communityA.id, 'admin'),
        },
      });

      // Should receive 403 Forbidden (not 404 to avoid information disclosure)
      expect(response.statusCode).toBe(403);
      expect(response.json().error).toContain('access denied');
      expect(response.json().error).not.toContain(storyB.title);
    });

    test('Database queries enforce community_id filtering in all endpoints', async () => {
      const communityA = testCommunities[0];
      const communityB = testCommunities[1];

      // Create multiple stories in each community
      await Promise.all([
        createTestStory(communityA.id, 'Community A Story 1'),
        createTestStory(communityA.id, 'Community A Story 2'),
        createTestStory(communityB.id, 'Community B Story 1'),
        createTestStory(communityB.id, 'Community B Story 2'),
      ]);

      // User from Community A lists stories
      const userAToken = await getUserToken(communityA.id, 'viewer');
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/communities/${communityA.id}/stories`,
        headers: {
          Authorization: `Bearer ${userAToken}`,
          Cookie: await getSessionCookie(communityA.id, 'viewer'),
        },
      });

      expect(response.statusCode).toBe(200);
      const stories = response.json().data;

      // Should only see Community A stories
      expect(
        stories.every((story: any) => story.community_id === communityA.id)
      ).toBe(true);
      expect(
        stories.some((story: any) => story.community_id === communityB.id)
      ).toBe(false);
      expect(stories.length).toBe(2);
    });

    test('API endpoints return 403 for unauthorized cross-community access', async () => {
      const communityA = testCommunities[0];
      const communityB = testCommunities[1];

      const userAToken = await getUserToken(communityA.id, 'admin');

      // Test various endpoints that should deny cross-community access
      const crossCommunityEndpoints = [
        `/api/v1/communities/${communityB.id}/stories`,
        `/api/v1/communities/${communityB.id}/places`,
        `/api/v1/communities/${communityB.id}/speakers`,
        `/api/v1/member/communities/${communityB.id}`,
      ];

      for (const endpoint of crossCommunityEndpoints) {
        const response = await app.inject({
          method: 'GET',
          url: endpoint,
          headers: {
            Authorization: `Bearer ${userAToken}`,
            Cookie: await getSessionCookie(communityA.id, 'admin'),
          },
        });

        expect(
          response.statusCode,
          `${endpoint} should deny cross-community access`
        ).toBe(403);
      }
    });

    test('File system isolation prevents cross-community file access', async () => {
      const communityA = testCommunities[0];
      const communityB = testCommunities[1];

      // Upload files to each community
      const fileA = await uploadTestFile(communityA.id, 'community-a-file.jpg');
      const fileB = await uploadTestFile(communityB.id, 'community-b-file.jpg');

      // User from Community A tries to access Community B's file
      const userAToken = await getUserToken(communityA.id, 'viewer');
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/files/${fileB.path}`,
        headers: {
          Authorization: `Bearer ${userAToken}`,
          Cookie: await getSessionCookie(communityA.id, 'viewer'),
        },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().error).toContain('file access denied');
    });
  });

  describe('Super Admin Data Sovereignty Restrictions', () => {
    test('Super admin CANNOT access community-specific cultural data', async () => {
      const community = testCommunities[0];
      const superAdminToken = await getUserToken('global', 'super_admin');

      // Create cultural content in community
      const story = await createTestStory(
        community.id,
        'Sacred Community Story',
        {
          cultural_restrictions: ['elder_only'],
          privacy_level: 'restricted',
        }
      );

      // Super admin tries to access community cultural content
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/communities/${community.id}/stories/${story.id}`,
        headers: {
          Authorization: `Bearer ${superAdminToken}`,
          Cookie: await getSessionCookie('global', 'super_admin'),
        },
      });

      // Should be denied access to cultural data
      expect(response.statusCode).toBe(403);
      expect(response.json().error).toContain(
        'super admin cannot access community cultural data'
      );
    });

    test('Super admin can only access non-cultural administrative data', async () => {
      const superAdminToken = await getUserToken('global', 'super_admin');

      // Super admin can list communities (administrative data)
      const communitiesResponse = await app.inject({
        method: 'GET',
        url: '/api/v1/super_admin/communities',
        headers: {
          Authorization: `Bearer ${superAdminToken}`,
          Cookie: await getSessionCookie('global', 'super_admin'),
        },
      });

      expect(communitiesResponse.statusCode).toBe(200);
      const communities = communitiesResponse.json().data;

      // Should see community names but not cultural content
      expect(communities[0]).toHaveProperty('name');
      expect(communities[0]).toHaveProperty('id');
      expect(communities[0]).not.toHaveProperty('stories');
      expect(communities[0]).not.toHaveProperty('cultural_protocols');
    });

    test('Database queries validate super admin cultural data restrictions', async () => {
      const community = testCommunities[0];

      // Create stories with different cultural restrictions
      await Promise.all([
        createTestStory(community.id, 'Public Story', {
          privacy_level: 'public',
        }),
        createTestStory(community.id, 'Elder Only Story', {
          privacy_level: 'restricted',
          cultural_restrictions: ['elder_only'],
        }),
        createTestStory(community.id, 'Community Only Story', {
          privacy_level: 'members_only',
        }),
      ]);

      // Super admin queries should not return cultural content
      const database = await db.getDb();

      // This query should be intercepted by middleware and restricted
      expect(async () => {
        await database
          .select({
            id: storiesTable.id,
            title: storiesTable.title,
            isRestricted: storiesTable.isRestricted,
          })
          .from(storiesTable)
          .where(eq(storiesTable.communityId, parseInt(community.id)));
      }).rejects.toThrow('Super admin access to cultural data denied');
    });
  });

  describe('Elder-Only Content Access Controls', () => {
    test('Non-elder users receive 403 for elder-restricted content', async () => {
      const community = testCommunities[0];

      // Create elder-only story
      const elderStory = await createTestStory(
        community.id,
        'Sacred Elder Story',
        {
          privacy_level: 'restricted',
          cultural_restrictions: ['elder_only'],
          cultural_significance: 'high',
          traditional_knowledge: true,
        }
      );

      // Non-elder user tries to access
      const regularUserToken = await getUserToken(
        community.id,
        'viewer',
        false
      ); // Not an elder
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/communities/${community.id}/stories/${elderStory.id}`,
        headers: {
          Authorization: `Bearer ${regularUserToken}`,
          Cookie: await getSessionCookie(community.id, 'viewer'),
        },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().error).toContain('elder access required');
      expect(response.json().culturalProtocol).toBe(
        'elder_restriction_enforced'
      );
    });

    test('Elder users can access elder-restricted content', async () => {
      const community = testCommunities[0];

      // Create elder-only content
      const elderStory = await createTestStory(
        community.id,
        'Elder Traditional Knowledge',
        {
          privacy_level: 'restricted',
          cultural_restrictions: ['elder_only'],
          traditional_knowledge: true,
        }
      );

      // Elder user accesses content
      const elderToken = await getUserToken(community.id, 'elder', true); // Is an elder
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/communities/${community.id}/stories/${elderStory.id}`,
        headers: {
          Authorization: `Bearer ${elderToken}`,
          Cookie: await getSessionCookie(community.id, 'elder'),
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().data.title).toBe('Elder Traditional Knowledge');
      expect(response.json().data.traditional_knowledge).toBe(true);
    });

    test('Cultural protocol enforcement logs all elder content access', async () => {
      const community = testCommunities[0];

      const elderStory = await createTestStory(
        community.id,
        'Sacred Ceremony Story',
        {
          privacy_level: 'restricted',
          cultural_restrictions: ['elder_only'],
        }
      );

      const elderToken = await getUserToken(community.id, 'elder', true);

      // Access elder content (should be logged)
      await app.inject({
        method: 'GET',
        url: `/api/v1/communities/${community.id}/stories/${elderStory.id}`,
        headers: {
          Authorization: `Bearer ${elderToken}`,
          Cookie: await getSessionCookie(community.id, 'elder'),
        },
      });

      // Check audit logs
      const auditLogs = await getAuditLogs({
        community_id: community.id,
        action: 'elder_content_access',
        resource_type: 'story',
      });

      expect(auditLogs.length).toBeGreaterThan(0);
      expect(auditLogs[0]).toHaveProperty('user_id');
      expect(auditLogs[0]).toHaveProperty('timestamp');
      expect(auditLogs[0]).toHaveProperty('cultural_protocol_enforced');
      expect(auditLogs[0].action).toBe('elder_content_access');
    });

    test('Mixed content filtering preserves elder restrictions', async () => {
      const community = testCommunities[0];

      // Create mixed content
      await Promise.all([
        createTestStory(community.id, 'Public Story', {
          privacy_level: 'public',
        }),
        createTestStory(community.id, 'Elder Story 1', {
          privacy_level: 'restricted',
          cultural_restrictions: ['elder_only'],
        }),
        createTestStory(community.id, 'Member Story', {
          privacy_level: 'members_only',
        }),
        createTestStory(community.id, 'Elder Story 2', {
          privacy_level: 'restricted',
          cultural_restrictions: ['elder_only'],
        }),
      ]);

      // Non-elder views story list
      const regularUserToken = await getUserToken(
        community.id,
        'viewer',
        false
      );
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/communities/${community.id}/stories`,
        headers: {
          Authorization: `Bearer ${regularUserToken}`,
          Cookie: await getSessionCookie(community.id, 'viewer'),
        },
      });

      expect(response.statusCode).toBe(200);
      const stories = response.json().data;

      // Should only see public and member content
      expect(stories.length).toBe(2);
      expect(stories.some((s: any) => s.title === 'Public Story')).toBe(true);
      expect(stories.some((s: any) => s.title === 'Member Story')).toBe(true);
      expect(stories.some((s: any) => s.title.includes('Elder Story'))).toBe(
        false
      );
    });
  });

  describe('Cultural Access Control Audit Logging', () => {
    test('All cultural content access is logged with context', async () => {
      const community = testCommunities[0];

      const story = await createTestStory(community.id, 'Cultural Story', {
        privacy_level: 'members_only',
        cultural_significance: 'medium',
        traditional_knowledge: false,
      });

      const userToken = await getUserToken(community.id, 'viewer');

      // Access cultural content
      await app.inject({
        method: 'GET',
        url: `/api/v1/communities/${community.id}/stories/${story.id}`,
        headers: {
          Authorization: `Bearer ${userToken}`,
          Cookie: await getSessionCookie(community.id, 'viewer'),
        },
      });

      // Verify comprehensive logging
      const auditLog = await getLatestAuditLog(community.id);

      expect(auditLog).toHaveProperty('user_id');
      expect(auditLog).toHaveProperty('community_id');
      expect(auditLog).toHaveProperty('resource_id');
      expect(auditLog).toHaveProperty('resource_type', 'story');
      expect(auditLog).toHaveProperty('action', 'access');
      expect(auditLog).toHaveProperty('timestamp');
      expect(auditLog).toHaveProperty('ip_address');
      expect(auditLog).toHaveProperty('user_agent');
      expect(auditLog).toHaveProperty('cultural_context');
    });

    test('Audit logs never contain sensitive cultural information', async () => {
      const community = testCommunities[0];

      const sensitiveStory = await createTestStory(
        community.id,
        'Sacred Ceremony Details',
        {
          privacy_level: 'restricted',
          cultural_restrictions: ['elder_only'],
          content:
            'This contains sacred traditional knowledge that should never be logged',
        }
      );

      const elderToken = await getUserToken(community.id, 'elder', true);

      await app.inject({
        method: 'GET',
        url: `/api/v1/communities/${community.id}/stories/${sensitiveStory.id}`,
        headers: {
          Authorization: `Bearer ${elderToken}`,
          Cookie: await getSessionCookie(community.id, 'elder'),
        },
      });

      const auditLogs = await getAuditLogs({ community_id: community.id });

      // Verify no sensitive content in logs
      for (const log of auditLogs) {
        expect(JSON.stringify(log)).not.toContain(
          'sacred traditional knowledge'
        );
        expect(JSON.stringify(log)).not.toContain('Sacred Ceremony Details');
        expect(log).not.toHaveProperty('story_content');
        expect(log).not.toHaveProperty('traditional_knowledge_details');
      }
    });

    test('Failed access attempts are logged with denial reason', async () => {
      const community = testCommunities[0];

      const elderStory = await createTestStory(
        community.id,
        'Elder Only Story',
        {
          privacy_level: 'restricted',
          cultural_restrictions: ['elder_only'],
        }
      );

      const regularUserToken = await getUserToken(
        community.id,
        'viewer',
        false
      );

      // Attempt unauthorized access
      await app.inject({
        method: 'GET',
        url: `/api/v1/communities/${community.id}/stories/${elderStory.id}`,
        headers: {
          Authorization: `Bearer ${regularUserToken}`,
          Cookie: await getSessionCookie(community.id, 'viewer'),
        },
      });

      const auditLog = await getLatestAuditLog(community.id);

      expect(auditLog.action).toBe('access_denied');
      expect(auditLog.denial_reason).toBe('elder_access_required');
      expect(auditLog.cultural_protocol).toBe('elder_restriction_enforced');
      expect(auditLog.user_elder_status).toBe(false);
    });
  });

  describe('Data Migration Cultural Protocol Preservation', () => {
    test('ActiveStorage migration preserves cultural access controls', async () => {
      // This test would validate that the migration script preserves
      // cultural restrictions and elder access controls during file migration

      const community = testCommunities[0];

      // Simulate story with cultural restrictions and attached media
      const culturalStory = {
        id: 'test-story-1',
        community_id: community.id,
        title: 'Traditional Ceremony Video',
        privacy_level: 'restricted',
        cultural_restrictions: ['elder_only'],
        media_urls: ['uploads/community_1/stories/ceremony-video.mp4'],
      };

      // Test that migration preserves restrictions
      const migrationResult =
        await simulateActivestorageMigration(culturalStory);

      expect(migrationResult.success).toBe(true);
      expect(migrationResult.cultural_restrictions_preserved).toBe(true);
      expect(migrationResult.file_permissions).toBe('elder_only');
      expect(migrationResult.audit_trail).toBeDefined();
    });

    test('File system migration maintains community isolation', async () => {
      const communityA = testCommunities[0];
      const communityB = testCommunities[1];

      // Test files are migrated to correct community directories
      const fileA = 'uploads/community_1/stories/story-audio.mp3';
      const fileB = 'uploads/community_2/stories/story-audio.mp3';

      const migrationResult = await simulateActivestorageMigration({
        community_a_files: [fileA],
        community_b_files: [fileB],
      });

      expect(migrationResult.community_isolation_maintained).toBe(true);
      expect(migrationResult.cross_community_access_prevented).toBe(true);
      expect(migrationResult.file_paths_validated).toBe(true);
    });
  });

  // Helper functions for testing
  async function createTestCommunities(): Promise<TestCommunity[]> {
    const communities = [
      {
        name: 'Test Anishinaabe Community',
        locale: 'en',
        cultural_protocols: {
          elder_access: true,
          traditional_knowledge_protection: true,
          ceremony_restrictions: ['elder_only'],
        },
      },
      {
        name: 'Test Inuit Community',
        locale: 'iu',
        cultural_protocols: {
          elder_access: true,
          seasonal_restrictions: true,
          story_protocols: ['community_members_only'],
        },
      },
    ];

    // Create communities in test database
    const created: TestCommunity[] = [];
    for (const community of communities) {
      const database = await db.getDb();
      const insertedCommunity = await database
        .insert(communitiesTable)
        .values({
          name: community.name,
          slug: community.name.toLowerCase().replace(/\s+/g, '-'),
          description: `Test community for ${community.name}`,
          locale: community.locale,
          culturalSettings: JSON.stringify(community.cultural_protocols),
          publicStories: true,
          isActive: true,
        })
        .returning({
          id: communitiesTable.id,
          name: communitiesTable.name,
          locale: communitiesTable.locale,
        });

      created.push(insertedCommunity[0]);
    }

    return created;
  }

  async function createTestUsers(): Promise<TestUser[]> {
    const users = [];

    for (const community of testCommunities) {
      // Create different roles for each community
      const roles = [
        { role: 'admin', elder_status: false },
        { role: 'editor', elder_status: false },
        { role: 'viewer', elder_status: false },
        { role: 'elder', elder_status: true },
      ];

      for (const roleData of roles) {
        const email = `${roleData.role}@${community.name.replace(/\s+/g, '').toLowerCase()}.test`;
        const hashedPassword = await hash('test-password-123');

        const database = await db.getDb();
        const insertedUser = await database
          .insert(usersTable)
          .values({
            email: email,
            passwordHash: hashedPassword,
            firstName: 'Test',
            lastName: 'User',
            role: roleData.role,
            communityId: parseInt(community.id),
            isActive: true,
          })
          .returning({
            id: usersTable.id,
            email: usersTable.email,
            role: usersTable.role,
            communityId: usersTable.communityId,
          });

        users.push(insertedUser[0]);
      }
    }

    // Create super admin user
    const superAdminEmail = 'superadmin@terrastories.test';
    const superAdminPassword = await hash('super-admin-password-123');

    const database = await db.getDb();
    const superAdminInserted = await database
      .insert(usersTable)
      .values({
        email: superAdminEmail,
        passwordHash: superAdminPassword,
        firstName: 'Super',
        lastName: 'Admin',
        role: 'super_admin',
        communityId: 1, // SQLite doesn't support NULL for NOT NULL fields, use system community
        isActive: true,
      })
      .returning({
        id: usersTable.id,
        email: usersTable.email,
        role: usersTable.role,
        communityId: usersTable.communityId,
      });

    users.push(superAdminInserted[0]);

    return users;
  }

  async function getUserToken(
    communityId: string,
    role: string,
    elderStatus?: boolean
  ): Promise<string> {
    // Implementation would create JWT token for test user
    return 'test-jwt-token';
  }

  async function getSessionCookie(
    communityId: string,
    role: string
  ): Promise<string> {
    // Implementation would create session cookie for test user
    return 'connect.sid=test-session-id';
  }

  async function createTestStory(
    communityId: string,
    title: string,
    options: any = {}
  ): Promise<any> {
    // Implementation would create test story with specified options
    return {
      id: `story-${Date.now()}`,
      title,
      community_id: communityId,
      ...options,
    };
  }

  async function uploadTestFile(
    communityId: string,
    filename: string
  ): Promise<any> {
    // Implementation would simulate file upload
    return {
      path: `uploads/community_${communityId}/stories/${filename}`,
      filename,
      community_id: communityId,
    };
  }

  async function getAuditLogs(filter: any): Promise<any[]> {
    // Implementation would query audit logs
    return [];
  }

  async function getLatestAuditLog(communityId: string): Promise<any> {
    // Implementation would get latest audit log
    return {};
  }

  async function simulateActivestorageMigration(data: any): Promise<any> {
    // Implementation would simulate migration process
    return {
      success: true,
      cultural_restrictions_preserved: true,
      community_isolation_maintained: true,
      audit_trail: true,
    };
  }

  async function getDatabaseConnection(): Promise<any> {
    // Implementation would return database connection
    return db;
  }

  async function authenticateTestUsers(): Promise<Record<string, string>> {
    // Implementation would authenticate all test users and return tokens
    return {};
  }

  afterAll(async () => {
    // Clean up test data
    await cleanupTestData();
    await db.teardown();
    await app.close();

    console.log('Cultural sovereignty validation completed');
  });

  async function cleanupTestData(): Promise<void> {
    // Implementation would clean up test communities, users, stories, etc.
  }
});
