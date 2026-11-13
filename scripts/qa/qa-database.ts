/**
 * Dialect-aware database bootstrap for the in-process persona QA fixtures.
 *
 * SQLite is the default: the fixtures keep using the repository's in-memory
 * `TestDatabaseManager` unchanged. When `DATABASE_URL` points at PostgreSQL
 * and the destructive-reset guard (`ALLOW_POSTGRES_TEST_RESET`) is set — the
 * same opt-in the PostgreSQL database gate uses — the same journeys instead
 * provision a freshly migrated PostgreSQL schema, so SQLite-only behaviour
 * (collation, timestamps, booleans, JSON) cannot hide a sovereignty leak.
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js';
import { migrate as migratePostgres } from 'drizzle-orm/postgres-js/migrator';
import { tablesFor } from '../../src/db/dialect.js';
import { createPostgresClient } from '../../src/db/index.js';
import { TestDatabaseManager } from '../../tests/helpers/database.js';
import type { TestFixtures } from '../../tests/helpers/database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const postgresMigrations = join(
  __dirname,
  '..',
  '..',
  'src',
  'db',
  'migrations',
  'postgres'
);

/**
 * Both Drizzle dialects expose the same insert/select surface over
 * `tablesFor`-selected tables, but their TypeScript overloads are
 * incompatible (see `HonoFoundationRepository.database`); widen the handle so
 * fixture code stays byte-identical across dialects.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WidenedQaDatabase = any;

export interface PersonaQaDatabase {
  dialect: 'sqlite' | 'postgresql';
  db: WidenedQaDatabase;
  /** Seed the shared baseline fixtures (system + three communities + places). */
  seed: () => Promise<TestFixtures>;
  close: () => Promise<void>;
}

export type PostgresQaTarget =
  | { status: 'ready'; url: string }
  | { status: 'unconfigured'; reason: string }
  | { status: 'refused'; reason: string };

/** The same dedicated-test-database name guard the PostgreSQL gate uses. */
const dedicatedTestDatabase = /^(?:test|[a-z0-9][a-z0-9_]*_test)$/i;

/**
 * Decide whether the environment selects the PostgreSQL persona QA target.
 * Pure so the Vitest wrappers can reuse it for skip reasons and fail-closed
 * checks without opening a connection.
 */
export function resolvePostgresQaTarget(
  databaseUrl: string | undefined,
  allowReset: string | undefined
): PostgresQaTarget {
  if (!databaseUrl || !/^(?:postgres|postgresql):\/\//.test(databaseUrl))
    return {
      status: 'unconfigured',
      reason:
        'DATABASE_URL does not point at PostgreSQL; the in-process SQLite fixtures own this run',
    };
  if (allowReset !== 'true')
    return {
      status: 'refused',
      reason:
        'ALLOW_POSTGRES_TEST_RESET is not "true"; the PostgreSQL journeys reset their schema and refuse to run without the guard',
    };
  const databaseName = decodeURIComponent(
    new URL(databaseUrl).pathname.replace(/^\//, '')
  );
  if (!dedicatedTestDatabase.test(databaseName))
    return {
      status: 'refused',
      reason: `refusing destructive PostgreSQL persona QA against non-test database ${databaseName}`,
    };
  return { status: 'ready', url: databaseUrl };
}

/** Drop and recreate both schemas, exactly like the PostgreSQL gate's reset. */
async function resetPostgresSchema(
  client: ReturnType<typeof createPostgresClient>
): Promise<void> {
  await client.unsafe('DROP SCHEMA IF EXISTS drizzle CASCADE');
  await client.unsafe('DROP SCHEMA IF EXISTS public CASCADE');
  await client.unsafe('CREATE SCHEMA public');
}

/**
 * Seed the same baseline rows `TestDatabaseManager.seedTestData()` creates:
 * system community, two private + two public test communities, and the three
 * places the journeys reference. Values are mirrored one-for-one so
 * `fixtures.communities[0..2]`, `fixtures.places[0]` and the
 * `systemCommunity` line up on both dialects.
 */
async function seedPostgresFixtures(
  db: WidenedQaDatabase
): Promise<TestFixtures> {
  const { communities, places } = tablesFor(db);
  const timestamp = Date.now();
  const now = new Date();
  const [systemCommunity] = await db
    .insert(communities)
    .values({
      name: 'System Level',
      description: 'System-level community for super admin operations',
      slug: `system-${timestamp}`,
      publicStories: false,
      locale: 'en',
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  const testCommunities = await db
    .insert(communities)
    .values([
      {
        name: 'Test Community',
        description: 'A test community for unit tests',
        slug: `test-community-${timestamp}`,
        publicStories: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        name: 'Demo Community',
        description: 'A demo community for integration tests',
        slug: `demo-community-${timestamp}`,
        publicStories: false,
        createdAt: now,
        updatedAt: now,
      },
      {
        name: 'Isolated Test Community',
        description: 'Community for isolated test scenarios',
        slug: `isolated-test-${timestamp}`,
        publicStories: true,
        createdAt: now,
        updatedAt: now,
      },
    ])
    .returning();
  const testPlaces = await db
    .insert(places)
    .values([
      {
        name: 'Test Place 1',
        description: 'First test place with point location',
        latitude: 49.2827,
        longitude: -123.1234,
        region: 'Vancouver',
        mediaUrls: [],
        photoUrl: null,
        culturalSignificance: null,
        isRestricted: false,
        communityId: testCommunities[0].id,
        createdAt: now,
        updatedAt: now,
      },
      {
        name: 'Test Place 2',
        description: 'Second test place with coordinates',
        latitude: 43.6532,
        longitude: -79.3832,
        region: 'Toronto',
        mediaUrls: [],
        photoUrl: null,
        culturalSignificance: null,
        communityId: testCommunities[0].id,
        createdAt: now,
        updatedAt: now,
      },
      {
        name: 'Isolated Test Place',
        description: 'Place for isolated test scenarios',
        latitude: 40.7128,
        longitude: -74.006,
        region: 'New York',
        mediaUrls: [],
        photoUrl: null,
        culturalSignificance: null,
        isRestricted: false,
        communityId: testCommunities[2].id,
        createdAt: now,
        updatedAt: now,
      },
    ])
    .returning();
  return {
    systemCommunity,
    communities: testCommunities,
    places: testPlaces,
  };
}

/**
 * Open the persona QA database for this process. Unconfigured environments
 * keep today's isolated in-memory SQLite manager. A PostgreSQL URL without
 * the reset guard (or against a non-test database name) is an explicit
 * operator intent, so it throws instead of silently downgrading to SQLite.
 */
export async function openPersonaQaDatabase(): Promise<PersonaQaDatabase> {
  const target = resolvePostgresQaTarget(
    process.env.DATABASE_URL,
    process.env.ALLOW_POSTGRES_TEST_RESET
  );
  if (target.status === 'refused')
    throw new Error(`PostgreSQL persona QA refused: ${target.reason}`);
  if (target.status === 'unconfigured') {
    const manager = new TestDatabaseManager();
    const db = await manager.setup();
    return {
      dialect: 'sqlite',
      db,
      seed: () => manager.seedTestData(),
      close: () => manager.teardown(),
    };
  }
  const client = createPostgresClient(target.url, {
    max: 2,
    onnotice: () => undefined,
  });
  try {
    await resetPostgresSchema(client);
    const db = drizzlePostgres(client);
    await migratePostgres(db, { migrationsFolder: postgresMigrations });
    return {
      dialect: 'postgresql',
      db,
      seed: () => seedPostgresFixtures(db),
      close: () => client.end(),
    };
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }
}
