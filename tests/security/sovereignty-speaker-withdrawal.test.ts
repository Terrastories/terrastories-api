import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { speakersSqlite, usersSqlite } from '../../src/db/schema/index.js';
import { hashPassword } from '../../src/services/password.service.js';
import { createTestApp } from '../helpers/api-client.js';
import {
  TestDataFactory,
  testDb,
  type TestDatabase,
} from '../helpers/database.js';
import { extractSignedSessionCookie } from '../helpers/session-cookie.js';
import { TEST_PASSWORD } from '../constants/field-kit-test-constants.js';

/**
 * SPEC-V2 §6.5: withdrawn (inactive) speakers are absent from viewer/member
 * direct reads, lists, search, and filters. Only canonical V2 editors/admins
 * of the same community may see them; a Fastify viewer (V2 member),
 * super_admin, the legacy `elder` role, and unknown roles never do. A denied
 * direct read is indistinguishable from a missing speaker (404, no existence
 * signal), and `activeOnly` never widens a caller's reach by coercion.
 */
describe('V2 sovereignty speaker withdrawal', () => {
  let app: FastifyInstance;
  let db: TestDatabase;
  let communityId: number;
  let viewerCookie: string;
  let editorCookie: string;
  let adminCookie: string;
  let activeSpeakerId: number;
  let inactiveSpeakerId: number;

  async function loginAs(user: { email: string }, communityId: number) {
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        email: user.email,
        password: TEST_PASSWORD,
        communityId,
      },
    });
    expect(login.statusCode).toBe(200);
    return extractSignedSessionCookie(login.headers['set-cookie']);
  }

  beforeEach(async () => {
    db = await testDb.setup();
    await testDb.clearData();
    const fixtures = await testDb.seedTestData();
    communityId = fixtures.communities[1].id;

    const passwordHash = await hashPassword(TEST_PASSWORD);
    const timestamp = Date.now();
    const [viewer] = await db
      .insert(usersSqlite)
      .values(
        TestDataFactory.createUser(communityId, {
          email: `withdrawal-viewer-${timestamp}@example.test`,
          role: 'viewer',
          passwordHash,
        })
      )
      .returning();
    const [editor] = await db
      .insert(usersSqlite)
      .values(
        TestDataFactory.createUser(communityId, {
          email: `withdrawal-editor-${timestamp}@example.test`,
          role: 'editor',
          passwordHash,
        })
      )
      .returning();
    const [admin] = await db
      .insert(usersSqlite)
      .values(
        TestDataFactory.createUser(communityId, {
          email: `withdrawal-admin-${timestamp}@example.test`,
          role: 'admin',
          passwordHash,
        })
      )
      .returning();

    const [activeSpeaker] = await db
      .insert(speakersSqlite)
      .values({
        name: 'Active Speaker',
        communityId,
        isActive: true,
        elderStatus: false,
      })
      .returning();
    const [inactiveSpeaker] = await db
      .insert(speakersSqlite)
      .values({
        name: 'Withdrawn Speaker',
        bio: 'WITHDRAWN-BIO',
        communityId,
        isActive: false,
        elderStatus: false,
      })
      .returning();
    activeSpeakerId = activeSpeaker.id;
    inactiveSpeakerId = inactiveSpeaker.id;

    app = await createTestApp(db);
    viewerCookie = await loginAs(viewer, communityId);
    editorCookie = await loginAs(editor, communityId);
    adminCookie = await loginAs(admin, communityId);
  });

  afterEach(async () => {
    await app.close();
    await testDb.teardown();
  });

  it('returns 404 for a withdrawn speaker on the speaker detail route for a viewer', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/speakers/${inactiveSpeakerId}`,
      headers: { cookie: viewerCookie },
    });

    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('WITHDRAWN-BIO');
  });

  it('returns 404 for a withdrawn speaker on the member speaker route for a viewer', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/member/speakers/${inactiveSpeakerId}`,
      headers: { cookie: viewerCookie },
    });

    // Same error/route mapping as "speaker not found": indistinguishable
    // from a missing speaker, no existence signal.
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('WITHDRAWN-BIO');
  });

  it('keeps active speaker reads working for a viewer', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/speakers/${activeSpeakerId}`,
      headers: { cookie: viewerCookie },
    });

    expect(response.statusCode).toBe(200);
  });

  it('returns the withdrawn speaker to an editor and an admin', async () => {
    for (const cookie of [editorCookie, adminCookie]) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/speakers/${inactiveSpeakerId}`,
        headers: { cookie },
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('WITHDRAWN-BIO');
    }
  });

  it('excludes the withdrawn speaker from search for a viewer', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/speakers/search?q=Withdrawn',
      headers: { cookie: viewerCookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.meta.total).toBe(0);
    expect(body.data).toHaveLength(0);
    expect(response.body).not.toContain('WITHDRAWN-BIO');
    expect(response.body).not.toContain('Withdrawn Speaker');
  });

  it('includes the withdrawn speaker in search for an editor', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/speakers/search?q=Withdrawn',
      headers: { cookie: editorCookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.meta.total).toBe(1);
    expect(
      body.data.some((s: { name: string }) => s.name === 'Withdrawn Speaker')
    ).toBe(true);
  });

  it('excludes the withdrawn speaker from the list for a viewer regardless of activeOnly', async () => {
    for (const query of ['', '?activeOnly=', '?activeOnly=false']) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/speakers${query}`,
        headers: { cookie: viewerCookie },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(
        body.data.some((s: { name: string }) => s.name === 'Withdrawn Speaker')
      ).toBe(false);
      expect(response.body).not.toContain('WITHDRAWN-BIO');
    }
  });

  it('rejects a non-boolean activeOnly value with 400 instead of coercing it', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/speakers?activeOnly=maybe',
      headers: { cookie: viewerCookie },
    });

    // `z.coerce.boolean('maybe')` is true today; only 'true'/'false' (and
    // real booleans) may parse. Anything else fails validation.
    expect(response.statusCode).toBe(400);
  });

  it('never treats activeOnly= (empty) as false for an editor', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/speakers?activeOnly=',
      headers: { cookie: editorCookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    // Empty string is ignored-as-default, never coerced to false: the editor
    // gets the default active-only list, not the withdrawn speaker.
    expect(
      body.data.some((s: { name: string }) => s.name === 'Withdrawn Speaker')
    ).toBe(false);
  });

  it('includes the withdrawn speaker for an editor and an admin with activeOnly=false', async () => {
    for (const cookie of [editorCookie, adminCookie]) {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/speakers?activeOnly=false',
        headers: { cookie },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(
        body.data.some((s: { name: string }) => s.name === 'Withdrawn Speaker')
      ).toBe(true);
    }
  });

  it('keeps activeOnly=true filtering for an editor', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/speakers?activeOnly=true',
      headers: { cookie: editorCookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(
      body.data.some((s: { name: string }) => s.name === 'Withdrawn Speaker')
    ).toBe(false);
  });

  it('excludes the withdrawn speaker from the member list for a viewer', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/member/speakers',
      headers: { cookie: viewerCookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(
      body.data.some((s: { name: string }) => s.name === 'Withdrawn Speaker')
    ).toBe(false);
    expect(response.body).not.toContain('WITHDRAWN-BIO');
  });
});
