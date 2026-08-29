import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { filesSqlite, usersSqlite } from '../../src/db/schema/index.js';
import { FileRepository } from '../../src/repositories/file.repository.js';
import { loadConfig } from '../../src/shared/config/index.js';
import { hashPassword } from '../../src/services/password.service.js';
import { createTestApp } from '../helpers/api-client.js';
import {
  TestDataFactory,
  testDb,
  type TestDatabase,
} from '../helpers/database.js';
import { extractSignedSessionCookie } from '../helpers/session-cookie.js';
import { TEST_PASSWORD } from '../constants/field-kit-test-constants.js';

describe('field-kit file sovereignty', () => {
  let app: FastifyInstance;
  let db: TestDatabase;
  let uploadDir: string;
  let originalNodeEnv: string | undefined;
  let originalUploadDir: string | undefined;
  let originalDatabaseUrl: string | undefined;

  beforeAll(async () => {
    originalNodeEnv = process.env.NODE_ENV;
    originalUploadDir = process.env.UPLOAD_DIR;
    originalDatabaseUrl = process.env.DATABASE_URL;

    uploadDir = join(process.cwd(), 'test-uploads-field-kit-sovereignty');
    await mkdir(uploadDir, { recursive: true });

    process.env.NODE_ENV = 'field-kit';
    process.env.UPLOAD_DIR = uploadDir;
    process.env.DATABASE_URL = './field-kit-sovereignty-test.db';
    const fieldKitConfig = loadConfig(true, true);
    expect(fieldKitConfig.environment).toBe('field-kit');
    expect(fieldKitConfig.fileUpload.uploadDir).toBe(uploadDir);

    db = await testDb.setup();
    app = await createTestApp(db);
  });

  afterAll(async () => {
    if (app) await app.close();
    await testDb.clearData();
    await testDb.teardown();
    await rm(uploadDir, { recursive: true, force: true });

    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalUploadDir === undefined) delete process.env.UPLOAD_DIR;
    else process.env.UPLOAD_DIR = originalUploadDir;
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    loadConfig(true, true);
  });

  it('streams only to the file owning community in field-kit mode', async () => {
    const fixtures = await testDb.seedTestData();
    const communityA = fixtures.communities[0];
    const communityB = fixtures.communities[1];

    const passwordHash = await hashPassword(TEST_PASSWORD);
    const [communityAUser] = await db
      .insert(usersSqlite)
      .values(
        TestDataFactory.createUser(communityA.id, {
          email: 'field-kit-a@example.test',
          passwordHash,
          role: 'viewer',
          isActive: true,
        })
      )
      .returning();
    const [communityBUser] = await db
      .insert(usersSqlite)
      .values(
        TestDataFactory.createUser(communityB.id, {
          email: 'field-kit-b@example.test',
          passwordHash,
          role: 'viewer',
          isActive: true,
        })
      )
      .returning();

    const communityBFilePath = `community-${communityB.id}/images/${randomUUID()}.txt`;
    const fullPath = join(uploadDir, communityBFilePath);
    await mkdir(join(uploadDir, `community-${communityB.id}`, 'images'), {
      recursive: true,
    });
    await writeFile(fullPath, 'community B protected file', 'utf8');

    await db.insert(filesSqlite).values({
      id: randomUUID(),
      filename: 'protected.txt',
      originalName: 'protected.txt',
      path: communityBFilePath,
      url: `/api/v1/files/uploads/${communityBFilePath}`,
      mimeType: 'text/plain',
      size: Buffer.byteLength('community B protected file'),
      communityId: communityB.id,
      uploadedBy: communityBUser.id,
      isActive: true,
    });

    const persistedFile = await new FileRepository(db).findByPath(
      communityBFilePath,
      communityB.id
    );
    expect(persistedFile).toMatchObject({
      path: communityBFilePath,
      communityId: communityB.id,
      isActive: true,
    });

    const communityALogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        email: communityAUser.email,
        password: TEST_PASSWORD,
        communityId: communityA.id,
      },
    });
    expect(communityALogin.statusCode).toBe(200);
    const communityACookie = extractSignedSessionCookie(
      communityALogin.headers['set-cookie']
    );

    const communityBLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        email: communityBUser.email,
        password: TEST_PASSWORD,
        communityId: communityB.id,
      },
    });
    expect(communityBLogin.statusCode).toBe(200);
    const communityBCookie = extractSignedSessionCookie(
      communityBLogin.headers['set-cookie']
    );

    const ownerResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/files/uploads/${communityBFilePath}`,
      headers: { cookie: communityBCookie },
    });
    expect(ownerResponse.statusCode, ownerResponse.body).toBe(200);
    expect(ownerResponse.body).toBe('community B protected file');

    const foreignResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/files/uploads/${communityBFilePath}`,
      headers: { cookie: communityACookie },
    });
    expect(foreignResponse.statusCode).toBe(404);
    expect(foreignResponse.json()).toEqual({
      error: 'File not found',
      statusCode: 404,
    });
    expect(foreignResponse.body).not.toContain('community B protected file');
  });
});
