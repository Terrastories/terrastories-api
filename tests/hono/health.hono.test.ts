/**
 * Hono V2 Health Endpoint Test
 *
 * Verifies the basic Hono app setup works correctly.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createHonoTestApp,
  honoRequest,
  type HonoTestApp,
} from '../helpers/hono-client';
import { testDb } from '../helpers/database';

describe('Hono V2: GET /v2/health', () => {
  let app: HonoTestApp;

  beforeAll(async () => {
    const db = await testDb.setup();
    app = await createHonoTestApp(db);
  });

  afterAll(async () => {
    await testDb.teardown();
  });

  it('should return 200 OK', async () => {
    const response = await honoRequest(app, 'GET', '/v2/health');
    expect(response.status).toBe(200);
  });

  it('should return JSON content-type', async () => {
    const response = await honoRequest(app, 'GET', '/v2/health');
    expect(response.headers['content-type']).toContain('application/json');
  });

  it('should have required fields: status, timestamp, version, environment, config, database', async () => {
    const response = await honoRequest(app, 'GET', '/v2/health');
    const body = response.body as Record<string, unknown>;
    expect(body).toHaveProperty('status');
    expect(body).toHaveProperty('timestamp');
    expect(body).toHaveProperty('version');
    expect(body).toHaveProperty('environment');
    expect(body).toHaveProperty('config');
    expect(body).toHaveProperty('database');
  });

  it('should report status "ok"', async () => {
    const response = await honoRequest(app, 'GET', '/v2/health');
    const body = response.body as Record<string, unknown>;
    expect(body.status).toBe('ok');
  });

  it('should have a valid ISO timestamp', async () => {
    const response = await honoRequest(app, 'GET', '/v2/health');
    const body = response.body as Record<string, unknown>;
    expect(() => new Date(body.timestamp as string)).not.toThrow();
    expect(new Date(body.timestamp as string).toISOString()).toBe(
      body.timestamp
    );
  });

  it('should have config validation object', async () => {
    const response = await honoRequest(app, 'GET', '/v2/health');
    const body = response.body as Record<string, unknown>;
    const config = body.config as Record<string, unknown>;
    expect(config).toHaveProperty('valid');
    expect(typeof config.valid).toBe('boolean');
  });

  it('should have database health object', async () => {
    const response = await honoRequest(app, 'GET', '/v2/health');
    const body = response.body as Record<string, unknown>;
    const database = body.database as Record<string, unknown>;
    expect(database).toHaveProperty('connected');
  });
});
