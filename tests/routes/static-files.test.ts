import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SENTINEL_CONTENTS = 'sentinel outside static root must never be served';

describe('Static file routing (wildcard: false)', () => {
  let app: FastifyInstance | undefined;
  let parentDir: string | undefined;
  let rootDir: string | undefined;
  let sentinelPath: string | undefined;

  beforeEach(async () => {
    parentDir = await mkdtemp(join(tmpdir(), 'static-files-test-'));
    rootDir = join(parentDir, 'public');
    sentinelPath = join(parentDir, 'traversal-sentinel.txt');

    await mkdir(rootDir);
    await writeFile(join(rootDir, 'index.html'), '<html>index</html>');
    await mkdir(join(rootDir, 'nested'));
    await writeFile(join(rootDir, 'nested', 'visible.txt'), 'visible');
    await writeFile(
      join(rootDir, 'nested', 'ignored.txt'),
      'restricted fixture contents'
    );
    await writeFile(join(rootDir, '.hidden'), 'dotfile fixture contents');
    // Real sibling file outside the static root, used as the traversal target.
    await writeFile(sentinelPath, SENTINEL_CONTENTS);

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
    if (parentDir) {
      await rm(parentDir, { recursive: true, force: true });
      parentDir = undefined;
      rootDir = undefined;
      sentinelPath = undefined;
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

  it.each([false, true])(
    'rejects traversal of a real sibling with wildcard %s',
    async (wildcard) => {
      expect(await readFile(sentinelPath!, 'utf8')).toBe(SENTINEL_CONTENTS);
      const traversalApp = Fastify();
      try {
        await traversalApp.register(fastifyStatic, {
          root: rootDir!,
          prefix: '/assets/',
          wildcard,
        });
        const response = await traversalApp.inject({
          method: 'GET',
          url: '/assets/%2e%2e%2ftraversal-sentinel.txt',
        });
        // @fastify/static 8 answered 403 here with wildcard true; 10 resolves
        // the encoded path inside root and answers 404. Either way the
        // sibling file outside root must not be served.
        expect(response.statusCode).toBe(404);
        expect(response.payload).not.toContain(SENTINEL_CONTENTS);
      } finally {
        await traversalApp.close();
      }
    }
  );
});
