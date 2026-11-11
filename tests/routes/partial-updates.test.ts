import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { placesSqlite } from '../../src/db/schema/places.js';
import { storiesSqlite } from '../../src/db/schema/stories.js';
import { createTestApp, ApiTestClient } from '../helpers/api-client.js';
import { createTestData, testDb } from '../helpers/database.js';

describe('partial updates through real route handlers', () => {
  let app: FastifyInstance;
  let cookie: string;
  let communityId: number;

  beforeEach(async () => {
    const db = await testDb.setup();
    const fixtures = await createTestData();
    communityId = fixtures.community.id;
    app = await createTestApp(db);
    cookie = await new ApiTestClient(app).getTestSessionId(
      1,
      communityId,
      'admin'
    );
  });

  afterEach(async () => {
    await app?.close();
    await testDb.teardown();
  });

  it('preserves a restricted place when PUT changes only its name', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/places',
      headers: { cookie },
      payload: {
        name: 'Restricted place before rename',
        latitude: 1,
        longitude: 2,
        isRestricted: true,
      },
    });
    expect(created.statusCode).toBe(201);
    const place = created.json().data;
    expect(place.isRestricted).toBe(true);

    const updated = await app.inject({
      method: 'PUT',
      url: `/api/v1/places/${place.id}`,
      headers: { cookie },
      payload: { name: 'Restricted place after rename' },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json().data).toMatchObject({
      name: 'Restricted place after rename',
      isRestricted: true,
    });

    const [saved] = await testDb.db
      .select()
      .from(placesSqlite)
      .where(eq(placesSqlite.id, place.id));
    expect(saved).toMatchObject({
      name: 'Restricted place after rename',
      isRestricted: true,
    });
  });

  it('preserves a non-English story when PATCH changes only its title', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/stories/',
      headers: { cookie },
      payload: {
        title: 'Story before retitle',
        communityId,
        language: 'pt',
      },
    });
    expect(created.statusCode).toBe(201);
    // The current create response serializes data as {}; locate the created row
    // without expanding this regression into a response-contract change.
    const [story] = await testDb.db
      .select()
      .from(storiesSqlite)
      .where(eq(storiesSqlite.title, 'Story before retitle'));
    expect(story.language).toBe('pt');

    const updated = await app.inject({
      method: 'PATCH',
      url: `/api/v1/stories/${story.id}`,
      headers: { cookie },
      payload: { title: 'Story after retitle' },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    const [saved] = await testDb.db
      .select()
      .from(storiesSqlite)
      .where(eq(storiesSqlite.id, story.id));
    expect(saved).toMatchObject({
      title: 'Story after retitle',
      language: 'pt',
    });
  });
});
