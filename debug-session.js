/**
 * Debug session cookie handling
 */
import { createTestApp } from './tests/helpers/api-client.js';
import { testDb } from './tests/helpers/database.js';

async function debugSession() {
  console.log('🔍 Debugging session cookie handling...\n');

  try {
    await testDb.setup();
    await testDb.clearData();
    const fixtures = await testDb.seedTestData();
    const testCommunityId = fixtures.communities[1].id;

    const app = await createTestApp(testDb.db);

    // 1. Register user
    console.log('1️⃣ Registering user...');
    const adminUser = {
      email: 'admin@example.com',
      password: 'StrongPassword123@',
      firstName: 'Admin',
      lastName: 'User',
      role: 'admin',
      communityId: testCommunityId,
    };

    const registerRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: adminUser,
    });
    console.log(`   Register Status: ${registerRes.statusCode}`);

    // 2. Login user
    console.log('\n2️⃣ Logging in user...');
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        email: adminUser.email,
        password: adminUser.password,
        communityId: adminUser.communityId,
      },
    });

    console.log(`   Login Status: ${loginRes.statusCode}`);
    console.log(`   Login Body: ${loginRes.body}`);

    // 3. Analyze cookies
    console.log('\n3️⃣ Analyzing Set-Cookie headers...');
    const setCookieHeader = loginRes.headers['set-cookie'];
    console.log(
      `   Set-Cookie Type: ${Array.isArray(setCookieHeader) ? 'Array' : typeof setCookieHeader}`
    );
    console.log(
      `   Set-Cookie Content:`,
      JSON.stringify(setCookieHeader, null, 2)
    );

    // 4. Extract session cookie like the test does
    console.log('\n4️⃣ Extracting session cookie (current method)...');
    let sessionCookie = '';
    if (Array.isArray(setCookieHeader)) {
      const cookie = setCookieHeader.find((cookie) =>
        cookie.startsWith('sessionId=')
      );
      sessionCookie = cookie || '';
    } else if (setCookieHeader && typeof setCookieHeader === 'string') {
      sessionCookie = setCookieHeader.startsWith('sessionId=')
        ? setCookieHeader
        : '';
    }

    console.log(`   Extracted Cookie: "${sessionCookie}"`);
    console.log(`   Cookie Length: ${sessionCookie.length}`);

    // 5. Test authenticated request with extracted cookie
    console.log('\n5️⃣ Testing authenticated request...');
    const authRes = await app.inject({
      method: 'POST',
      url: '/api/v1/speakers',
      payload: {
        name: 'Test Speaker',
      },
      headers: {
        cookie: sessionCookie,
      },
    });

    console.log(`   Authenticated Request Status: ${authRes.statusCode}`);
    console.log(`   Response Body: ${authRes.body}`);

    // 6. Try different cookie formats
    console.log('\n6️⃣ Testing different cookie formats...');

    // Try with just the sessionId value
    if (setCookieHeader && Array.isArray(setCookieHeader)) {
      const sessionIdCookie = setCookieHeader.find((c) =>
        c.includes('sessionId=')
      );
      if (sessionIdCookie) {
        const sessionIdValue = sessionIdCookie
          .split('sessionId=')[1]
          .split(';')[0];
        console.log(`   Trying sessionId value only: "${sessionIdValue}"`);

        const testRes = await app.inject({
          method: 'POST',
          url: '/api/v1/speakers',
          payload: { name: 'Test Speaker 2' },
          headers: {
            cookie: `sessionId=${sessionIdValue}`,
          },
        });
        console.log(`   Status with sessionId=value: ${testRes.statusCode}`);
      }
    }

    await app.close();
    await testDb.teardown();
  } catch (error) {
    console.error('❌ Debug failed:', error.message);
    console.error(error.stack);
  }
}

debugSession();
