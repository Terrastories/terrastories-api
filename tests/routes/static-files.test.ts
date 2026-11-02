import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('Static file routing (wildcard: false)', () => {
  let app: FastifyInstance | undefined;
  let rootDir: string | undefined;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'static-files-test-'));
    await writeFile(join(rootDir, 'index.html'), '<html>index</html>');
    await mkdir(join(rootDir, 'nested'));
    await writeFile(join(rootDir, 'nested', 'visible.txt'), 'visible');
    await writeFile(
      join(rootDir, 'nested', 'ignored.txt'),
      'restricted fixture contents'
    );
    await writeFile(join(rootDir, '.hidden'), 'dotfile fixture contents');

    app = Fastify();
    await app.register(fastifyStatic, {
      root: rootDir,
      prefix: '/assets/',
      wildcard: false,
      globIgnore: ['**/ignored.txt'],
      serveDotFiles: false,
    });
    await app.ready();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
    if (rootDir) {
      await rm(rootDir, { recursive: true, force: true });
      rootDir = undefined;
    }
  });

  it('should serve visible nested files on GET', async () => {
    const response = await app!.inject({
      method: 'GET',
      url: '/assets/nested/visible.txt',
    });

    expect(response.statusCode).toBe(200);
    expect(response.payload).toBe('visible');
  });

  it('should serve visible nested files on HEAD', async () => {
    const response = await app!.inject({
      method: 'HEAD',
      url: '/assets/nested/visible.txt',
    });

    expect(response.statusCode).toBe(200);
  });

  it('should not serve files excluded by globIgnore', async () => {
    const response = await app!.inject({
      method: 'GET',
      url: '/assets/nested/ignored.txt',
    });

    expect(response.statusCode).toBe(404);
    expect(response.payload).not.toContain('restricted fixture contents');
  });

  it('should not serve dotfiles', async () => {
    const response = await app!.inject({
      method: 'GET',
      url: '/assets/.hidden',
    });

    expect(response.statusCode).toBe(404);
    expect(response.payload).not.toContain('dotfile fixture contents');
  });

  it('should return 404 for unknown files', async () => {
    const response = await app!.inject({
      method: 'GET',
      url: '/assets/unknown.txt',
    });

    expect(response.statusCode).toBe(404);
  });

  it('should reject encoded parent traversal outside the static root', async () => {
    const response = await app!.inject({
      method: 'GET',
      url: '/assets/%2e%2e%2f%2e%2e%2fpackage.json',
    });

    expect([403, 404]).toContain(response.statusCode);
    expect(response.payload).not.toContain('"dependencies"');
  });
});
