// Debug super admin authentication
const { createTestApp } = require('./tests/setup/test-database-manager.js');

async function debugSuperAdmin() {
  try {
    const testDatabase = {
      query: () => Promise.resolve({ rows: [] }),
      close: () => {},
    };
    const app = await createTestApp(testDatabase);

    console.log('=== Testing Super Admin Registration ===');

    const testUser = {
      email: 'super_admin-global@example.com',
      password: 'TestPassword123@',
      firstName: 'Super_admin',
      lastName: 'User',
      role: 'super_admin',
      communityId: null,
    };

    // Try to register super admin
    const registerResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: testUser,
    });

    console.log('Register response status:', registerResponse.statusCode);
    console.log('Register response body:', registerResponse.body);

    if (registerResponse.statusCode !== 201) {
      // User might already exist, try login
      console.log('\n=== Testing Super Admin Login ===');

      const loginResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          email: testUser.email,
          password: testUser.password,
          communityId: testUser.communityId,
        },
      });

      console.log('Login response status:', loginResponse.statusCode);
      console.log('Login response body:', loginResponse.body);
      console.log(
        'Login response headers:',
        JSON.stringify(loginResponse.headers, null, 2)
      );

      // Try to extract session cookie
      const setCookieHeader = loginResponse.headers['set-cookie'];
      console.log('Set-Cookie header:', setCookieHeader);

      if (Array.isArray(setCookieHeader)) {
        const sessionCookies = setCookieHeader.filter((cookie) =>
          cookie.startsWith('sessionId=')
        );
        console.log(
          'Session cookies found:',
          sessionCookies.length,
          sessionCookies
        );
      }
    }

    await app.close();
  } catch (error) {
    console.error('Debug error:', error);
  }
}

debugSuperAdmin();
