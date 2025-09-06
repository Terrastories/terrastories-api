// Minimal debug script to reproduce the 500 error
import { buildApp } from './dist/app.js';
import { TestDatabaseManager } from './dist/tests/helpers/database.js';

async function debugTest() {
  console.log('Starting cultural sovereignty debug...');

  const db = new TestDatabaseManager();
  await db.setup();
  await db.clearData();

  const fixtures = await db.seedTestData();
  const testDatabase = await db.getDb();

  // Get fastify app
  process.env.NODE_ENV = 'test';
  const app = await buildApp({ database: testDatabase });
  await app.ready();

  try {
    // Test the failing scenario: Community A user accessing Community B story
    const communityA = fixtures.communities[1];
    const communityB = fixtures.communities[2];

    console.log('Community A:', communityA.id);
    console.log('Community B:', communityB.id);

    // Create a story in Community B
    const { storiesSqlite } = await import('./dist/db/schema/index.js');
    const storyB = await testDatabase
      .insert(storiesSqlite)
      .values({
        title: 'Story from Community B',
        slug: `story-b-${Date.now()}`,
        communityId: communityB.id,
        description: 'Test story',
        isRestricted: false,
        language: 'en',
        tags: [],
        mediaUrls: [],
        createdBy: fixtures.users[0].id,
      })
      .returning({
        id: storiesSqlite.id,
        communityId: storiesSqlite.communityId,
      });

    console.log('Created story in Community B:', storyB[0]);

    // Register and login a user for Community A
    const userA = {
      email: `admin-${communityA.id}@example.com`,
      password: 'TestPassword123@',
      firstName: 'Admin',
      lastName: 'User',
      role: 'admin',
      communityId: communityA.id,
    };

    // Register user
    const registerResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: userA,
    });
    console.log('Register status:', registerResponse.statusCode);

    // Login to get session cookie
    const loginResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        email: userA.email,
        password: userA.password,
        communityId: userA.communityId,
      },
    });
    console.log('Login status:', loginResponse.statusCode);

    // Extract session cookie
    const setCookieHeader = loginResponse.headers['set-cookie'];
    let sessionCookie = '';
    if (Array.isArray(setCookieHeader)) {
      const sessionCookies = setCookieHeader.filter((cookie) =>
        cookie.startsWith('sessionId=')
      );
      sessionCookie = sessionCookies[0] || '';
    }
    console.log('Session cookie extracted:', !!sessionCookie);

    // Now attempt cross-community access - this should return 404, not 500
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/member/stories/${storyB[0].id}`,
      headers: { cookie: sessionCookie },
    });

    console.log('Cross-community access status:', response.statusCode);
    console.log('Response:', response.json());
  } catch (error) {
    console.error('Debug error:', error);
  } finally {
    await app.close();
    await db.teardown();
  }
}

debugTest().catch(console.error);
