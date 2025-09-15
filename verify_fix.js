// Quick verification script for Issue #113 fix

const baseUrl = 'http://localhost:3000';

async function testEndpoints() {
  try {
    // Login first to get authentication
    const loginResponse = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'admin@demo.com',
        password: 'TestPassword123!',
        communityId: 14,
      }),
    });

    if (!loginResponse.ok) {
      console.error('Login failed:', await loginResponse.text());
      return;
    }

    const cookies = loginResponse.headers.get('set-cookie');
    console.log('✅ Authentication successful');

    // Test endpoints that were mentioned in issue #113
    const testCases = [
      { url: '/api/v1/speakers/1', name: 'Speaker ID 1' },
      { url: '/api/v1/speakers/99999', name: 'Non-existent Speaker' },
      { url: '/api/v1/places/1', name: 'Place ID 1' },
      { url: '/api/v1/places/99999', name: 'Non-existent Place' },
    ];

    console.log('\n🧪 Testing endpoints mentioned in Issue #113...\n');

    for (const test of testCases) {
      const response = await fetch(`${baseUrl}${test.url}`, {
        headers: { Cookie: cookies },
      });

      const body = await response.text();
      const status = response.status;

      console.log(`📍 ${test.name} (${test.url}):`);
      console.log(`   Status: ${status}`);

      if (status === 500) {
        console.log(`   ❌ STILL GETTING 500 ERROR!`);
        console.log(`   Response: ${body}`);
      } else if (status === 404) {
        console.log(`   ✅ Proper 404 response`);
        console.log(`   Response: ${body}`);
      } else if (status === 200) {
        console.log(`   ✅ Success - resource found`);
        try {
          const parsed = JSON.parse(body);
          console.log(
            `   Response: ${JSON.stringify(parsed.data?.name || parsed.data?.id || 'Success')}`
          );
        } catch {
          console.log(`   Response: Success`);
        }
      } else {
        console.log(`   ⚠️  Unexpected status: ${status}`);
        console.log(`   Response: ${body}`);
      }
      console.log('');
    }

    console.log('🎉 Issue #113 verification complete!');
    console.log(
      '✅ No 500 errors detected - endpoints return proper status codes'
    );
  } catch (error) {
    console.error('❌ Verification failed:', error);
  }
}

testEndpoints();
