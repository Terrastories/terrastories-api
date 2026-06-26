/**
 * Health Endpoint — V1 Compatibility Test
 *
 * Captures the exact response shape of GET /health from the TypeScript API
 * to establish V1 parity baseline for V2 migration.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DualApiClient } from './helpers/dual-client';
import { ResponseDiffer } from './helpers/response-differ';
import { createTestApp } from '../helpers/api-client';
import { testDb } from '../helpers/database';

describe('V1 Compatibility: GET /health', () => {
  let dualClient: DualApiClient;
  let differ: ResponseDiffer;

  beforeAll(async () => {
    const db = await testDb.setup();
    const app = await createTestApp(db);
    dualClient = new DualApiClient({
      typescriptBaseUrl: 'http://localhost:3000',
      railsBaseUrl: '',
      app,
    });
    differ = new ResponseDiffer();
  });

  afterAll(async () => {
    await testDb.teardown();
  });

  it('should return 200 OK', async () => {
    const comparison = await dualClient.compareEndpoint('GET', '/health');
    expect(comparison.typescript.statusCode).toBe(200);
  });

  it('should return JSON content-type', async () => {
    const comparison = await dualClient.compareEndpoint('GET', '/health');
    const headers = comparison.typescript.headers || {};
    const contentType =
      headers['content-type'] ||
      (Array.isArray(headers)
        ? (headers as string[]).find((h: string) =>
            h.toLowerCase().includes('content-type')
          )
        : '');
    expect(String(contentType)).toContain('application/json');
  });

  it('should have required fields: status, timestamp, version, environment, config, database', async () => {
    const comparison = await dualClient.compareEndpoint('GET', '/health');
    const body =
      typeof comparison.typescript.body === 'string'
        ? JSON.parse(comparison.typescript.body)
        : comparison.typescript.body;
    expect(body).toHaveProperty('status');
    expect(body).toHaveProperty('timestamp');
    expect(body).toHaveProperty('version');
    expect(body).toHaveProperty('environment');
    expect(body).toHaveProperty('config');
    expect(body).toHaveProperty('database');
  });

  it('should report status "ok"', async () => {
    const comparison = await dualClient.compareEndpoint('GET', '/health');
    const body =
      typeof comparison.typescript.body === 'string'
        ? JSON.parse(comparison.typescript.body)
        : comparison.typescript.body;
    expect(body.status).toBe('ok');
  });

  it('should have a valid ISO timestamp', async () => {
    const comparison = await dualClient.compareEndpoint('GET', '/health');
    const body =
      typeof comparison.typescript.body === 'string'
        ? JSON.parse(comparison.typescript.body)
        : comparison.typescript.body;
    expect(() => new Date(body.timestamp)).not.toThrow();
    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
  });

  it('should have config validation object', async () => {
    const comparison = await dualClient.compareEndpoint('GET', '/health');
    const body =
      typeof comparison.typescript.body === 'string'
        ? JSON.parse(comparison.typescript.body)
        : comparison.typescript.body;
    expect(body.config).toHaveProperty('valid');
    expect(typeof body.config.valid).toBe('boolean');
  });

  it('should have database health object', async () => {
    const comparison = await dualClient.compareEndpoint('GET', '/health');
    const body =
      typeof comparison.typescript.body === 'string'
        ? JSON.parse(comparison.typescript.body)
        : comparison.typescript.body;
    expect(body.database).toHaveProperty('connected');
    expect(typeof body.database.connected).toBe('boolean');
  });
});
