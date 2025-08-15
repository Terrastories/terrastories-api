# Testing Infrastructure Documentation

Comprehensive testing infrastructure for the Terrastories API backend migration.

## 🎯 Overview

This testing infrastructure provides:

- **Database Fixtures**: In-memory SQLite with complete isolation
- **API Testing**: HTTP endpoint testing with authentication
- **Performance Testing**: Benchmarking and performance monitoring
- **Mock Utilities**: External service mocking and test data generation
- **80% Coverage**: Enforced coverage requirements with quality gates

## 📁 Structure

```
tests/
├── helpers/
│   ├── database.ts      # Database fixtures and test data management
│   ├── api-client.ts    # HTTP testing utilities with auth
│   ├── mocks.ts         # Mock utilities for external services
│   └── performance.ts   # Performance testing and benchmarking
├── integration/
│   ├── database.test.ts # Database integration test examples
│   └── api.test.ts      # API integration test examples
├── setup.ts             # Global test setup and teardown
└── README.md           # This documentation
```

## 🚀 Quick Start

### Running Tests

```bash
# Run all tests
npm test

# Run with coverage
npm run test:coverage

# Run specific test file
npm test tests/integration/database.test.ts

# Run tests in watch mode
vitest --watch
```

### Writing Tests

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { testDb, TestDataFactory } from '../helpers/database.js';
import { createApiClient } from '../helpers/api-client.js';

describe('Your Feature', () => {
  beforeEach(async () => {
    await testDb.reset(); // Clean state for each test
  });

  it('should work correctly', async () => {
    const database = await testDb.getDb();
    // Your test logic here
  });
});
```

## 🗄️ Database Testing

### Test Database Manager

The `TestDatabaseManager` provides isolated in-memory SQLite databases:

```typescript
import { testDb, TestFixtures } from './helpers/database.js';

// Setup with migrations and test data
const fixtures = await testDb.seedTestData();

// Get database instance
const database = await testDb.getDb();

// Clear data while preserving structure
await testDb.clearData();

// Complete reset with fresh test data
await testDb.reset();

// Cleanup
await testDb.teardown();
```

### Test Data Factory

Generate consistent test data:

```typescript
import { TestDataFactory } from './helpers/database.js';

// Create community data
const communityData = TestDataFactory.createCommunity({
  name: 'Custom Name',
  slug: 'custom-slug',
});

// Create place data with spatial information
const placeData = TestDataFactory.createPlace(communityId, {
  location: JSON.stringify({
    type: 'Point',
    coordinates: [-123.1234, 49.2827],
  }),
});

// Generate spatial test data
const spatialData = TestDataFactory.createSpatialTestData(communityId);
```

### Fixtures Structure

Test fixtures provide consistent data:

```typescript
interface TestFixtures {
  communities: Community[]; // 3 test communities
  places: Place[]; // 3 test places with spatial data
}

// Predefined test communities:
// - ID 1: "Test Community" (public stories)
// - ID 2: "Demo Community" (private stories)
// - ID 999: "Isolated Test Community" (for isolation tests)
```

## 🌐 API Testing

### API Test Client

Simplified HTTP testing with authentication:

```typescript
import { createApiClient } from './helpers/api-client.js';

const apiClient = createApiClient(app);

// Basic requests
const response = await apiClient.get('/api/v1/communities');
const response = await apiClient.post('/api/v1/communities', data);

// Authenticated requests
const tokens = await apiClient.getTokens();
const response = await apiClient.post(
  '/api/v1/communities',
  data,
  tokens.admin
);

// Response assertions
apiClient.assertSuccess(response, 200);
apiClient.assertError(response, 400);
apiClient.assertUnauthorized(response);
apiClient.assertNotFound(response);

// Parse and validate responses
const parsed = apiClient.parseResponse(response);
const paginated = apiClient.assertPaginatedResponse(response);
const structured = apiClient.assertResponseStructure(response, [
  'data',
  'meta',
]);
```

### Authentication Tokens

Pre-configured test tokens for different roles:

```typescript
const tokens = await apiClient.getTokens();

tokens.admin; // Community admin
tokens.editor; // Content editor
tokens.viewer; // Read-only viewer
tokens.superAdmin; // System super admin
tokens.anotherCommunity; // User from different community
```

### Mock Data Generators

Generate consistent API test data:

```typescript
import { MockDataGenerator } from './helpers/api-client.js';

const community = MockDataGenerator.community();
const place = MockDataGenerator.place(communityId);
const point = MockDataGenerator.spatialPoint(lat, lng);
const polygon = MockDataGenerator.spatialPolygon(coordinates);
```

## 🎭 Mocking

### External Service Mocks

Mock external dependencies for isolated testing:

```typescript
import {
  FileSystemMock,
  HttpMock,
  EmailMock,
  StorageMock,
  GeoMock,
  ExternalApiMock,
} from './helpers/mocks.js';

// File system operations
const mockRead = FileSystemMock.mockFileRead('file content');
const mockWrite = FileSystemMock.mockFileWrite();

// HTTP requests
const mockSuccess = HttpMock.mockSuccessResponse(data, 200);
const mockError = HttpMock.mockErrorResponse(500, 'Server Error');

// Email service
const emailService = EmailMock.createEmailService();
const mockSend = EmailMock.mockSendSuccess();

// File storage
const storageService = StorageMock.createStorageService();
const mockUpload = StorageMock.mockUploadSuccess('test.jpg');

// Geolocation
const geoService = GeoMock.createGeocodingService();
const mockGeocode = GeoMock.mockGeocodeSuccess(49.2827, -123.1207);

// External APIs
const apiClient = ExternalApiMock.createApiClient('https://api.example.com');
const mockApi = ExternalApiMock.mockApiSuccess(responseData);
```

### Test Data Generation

Generate random test data:

```typescript
import { TestDataGenerator } from './helpers/mocks.js';

const email = TestDataGenerator.randomEmail();
const url = TestDataGenerator.randomUrl();
const coords = TestDataGenerator.randomLatLng();
const date = TestDataGenerator.randomDate();
const phone = TestDataGenerator.randomPhoneNumber();
```

### Common Mock Patterns

Utilities for common mocking scenarios:

```typescript
import { CommonMocks } from './helpers/mocks.js';

// Mock console methods
const consoleMock = CommonMocks.mockConsole();

// Mock environment variables
const restoreEnv = CommonMocks.mockEnv({
  NODE_ENV: 'test',
  DATABASE_URL: 'sqlite::memory:',
});

// Mock timers
const timerMock = CommonMocks.mockTimers();
timerMock.advanceTime(1000);
timerMock.restore();
```

## ⚡ Performance Testing

### Performance Tester

Benchmark database operations:

```typescript
import {
  PerformanceTester,
  PerformanceTestUtils,
} from './helpers/performance.js';

const tester = PerformanceTestUtils.createTester(testDb);

// Measure single operation
const { result, metrics } = await tester.measureOperation(
  'insert_community',
  async () => database.insert(communities).values(data)
);

// Benchmark with multiple iterations
const benchmark = await tester.benchmark(
  'query_communities',
  async () => database.select().from(communities),
  100 // iterations
);

// Run comprehensive test suite
const { results, summary } = await tester.runPerformanceTestSuite();
```

### Performance Assertions

Validate performance within acceptable limits:

```typescript
import {
  PerformanceAssertions,
  PerformanceTestUtils,
} from './helpers/performance.js';

// Assert operation duration
PerformanceAssertions.assertDuration(metrics, 100); // max 100ms

// Assert memory usage
PerformanceAssertions.assertMemoryUsage(metrics, 5); // max 5MB

// Assert benchmark results
PerformanceAssertions.assertBenchmark(benchmark, {
  maxAverageDuration: 50, // max 50ms average
  maxMemoryUsage: 10, // max 10MB
  minSuccessRate: 0.95, // min 95% success rate
});

// Quick performance check
const result = await PerformanceTestUtils.quickCheck(
  async () => operation(),
  1000 // max 1000ms
);
```

### Performance Limits

Predefined performance limits for common operations:

```typescript
const limits = PerformanceTestUtils.PERFORMANCE_LIMITS;

limits.FAST_QUERY; // 50ms
limits.NORMAL_QUERY; // 200ms
limits.SLOW_QUERY; // 1000ms
limits.BULK_INSERT; // 500ms per 100 records
limits.SPATIAL_QUERY; // 300ms
limits.JOIN_QUERY; // 400ms
limits.MEMORY_LIMIT; // 10MB per operation
```

## 📊 Coverage and Quality

### Coverage Configuration

80% coverage enforced across all metrics:

- **Lines**: 80%
- **Functions**: 80%
- **Branches**: 80%
- **Statements**: 80%

### Coverage Commands

```bash
# Run tests with coverage
npm run test:coverage

# View coverage report
open coverage/index.html

# Check coverage thresholds
npm test -- --coverage --reporter=verbose
```

### Quality Gates

Tests must pass these quality gates:

1. **Coverage**: ≥80% on all metrics
2. **Performance**: Operations within defined limits
3. **Isolation**: Tests run independently without interference
4. **Consistency**: Deterministic results across runs

## 🔧 Configuration

### Vitest Configuration

Enhanced configuration in `vitest.config.ts`:

- **Test isolation**: Fork pool for database isolation
- **Timeouts**: 30s for integration tests
- **Performance monitoring**: Heap usage tracking
- **Parallel execution**: Limited concurrency for stability
- **Environment**: Automatic test environment setup

### Environment Variables

Test-specific environment:

```env
NODE_ENV=test
DATABASE_URL=sqlite::memory:
LOG_LEVEL=warn
```

## 📝 Best Practices

### Test Organization

1. **Unit Tests**: Test individual functions/classes in isolation
2. **Integration Tests**: Test components working together
3. **API Tests**: Test HTTP endpoints with database operations
4. **Performance Tests**: Benchmark critical operations

### Test Isolation

- Use `beforeEach` to reset database state
- Avoid shared state between tests
- Use in-memory SQLite for complete isolation
- Clean up resources in `afterEach`

### Test Data

- Use test factories for consistent data generation
- Prefer fixtures over hardcoded data
- Use meaningful test data that reflects real scenarios
- Avoid test data pollution between tests

### Performance Testing

- Benchmark critical database operations
- Set realistic performance limits
- Monitor memory usage for resource leaks
- Test under concurrent load

### Mocking

- Mock external dependencies for isolation
- Use realistic mock data
- Verify mock interactions when needed
- Restore mocks after tests

## 🚨 Troubleshooting

### Common Issues

**Tests failing randomly**

- Check for shared state between tests
- Ensure proper cleanup in `afterEach`
- Verify database isolation

**Performance tests flaky**

- Run on dedicated testing environment
- Account for system load variations
- Use relative performance metrics

**Coverage not meeting threshold**

- Identify uncovered code with coverage report
- Add tests for missing coverage
- Exclude non-testable code from coverage

**Database connection issues**

- Verify migrations run successfully
- Check test database setup in `beforeAll`
- Ensure proper cleanup in `afterAll`

### Debug Commands

```bash
# Run tests with debug output
DEBUG=* npm test

# Run single test file with verbose output
npm test tests/integration/database.test.ts -- --reporter=verbose

# Run tests with coverage and detailed output
npm test -- --coverage --reporter=verbose --ui
```

## 📚 Examples

See the example test files for comprehensive patterns:

- **`tests/integration/database.test.ts`**: Database testing patterns
- **`tests/integration/api.test.ts`**: API testing patterns
- **`tests/helpers/`**: Utility usage examples

## 🔄 Continuous Integration

The testing infrastructure is designed for CI/CD:

- Deterministic test results
- No external dependencies
- Comprehensive coverage reporting
- Performance regression detection
- Parallel test execution support

### CI Configuration Example

```yaml
test:
  script:
    - npm ci
    - npm run validate # type-check, lint, test
    - npm run test:coverage
  coverage: 80%
  artifacts:
    reports:
      coverage_report:
        coverage_format: cobertura
        path: coverage/cobertura-coverage.xml
```
