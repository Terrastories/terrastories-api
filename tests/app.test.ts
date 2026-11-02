import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildApp } from '../src/app.js';
import { FastifyInstance } from 'fastify';

describe('App', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('should start the application', async () => {
    expect(app).toBeDefined();
    expect(app.server).toBeDefined();
  });

  it('should have swagger documentation available', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/docs',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
  });

  it('should have swagger.json endpoint available', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/docs/json',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');

    const swagger = JSON.parse(response.payload);
    expect(swagger.openapi).toBeDefined();
    expect(swagger.info.title).toBe('Terrastories API');
  });

  it('should handle 404 for unknown routes', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/unknown-route',
    });

    expect(response.statusCode).toBe(404);
  });

  it('should have CORS enabled', async () => {
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/health',
      headers: {
        Origin: 'http://localhost:3000',
        'Access-Control-Request-Method': 'GET',
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('*');
  });

  it('should have security headers from helmet', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.headers['x-frame-options']).toBeDefined();
    expect(response.headers['x-content-type-options']).toBeDefined();
  });

  it('should serve swagger-ui stylesheet from /docs/static', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/docs/static/swagger-ui.css',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/css');
    expect(response.payload.length).toBeGreaterThan(0);
  });

  it('should serve swagger-ui bundle from /docs/static', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/docs/static/swagger-ui-bundle.js',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('javascript');
    expect(response.payload.length).toBeGreaterThan(0);
  });

  it('should return 404 for missing static assets under /docs/static', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/docs/static/does-not-exist.css',
    });

    expect(response.statusCode).toBe(404);
  });

  it('should reject encoded path traversal outside the static root', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/docs/static/%2e%2e%2f%2e%2e%2fpackage.json',
    });

    expect([403, 404]).toContain(response.statusCode);
    expect(response.payload).not.toContain('"dependencies"');
    expect(response.payload).not.toContain('"devDependencies"');
  });
});
