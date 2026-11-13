import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { runRuntimeSmoke } from '../../scripts/runtime-smoke.mjs';

const packageJson = { engines: { node: '>=20.19.0' } };
const fastifyUrl = pathToFileURL(
  createRequire(import.meta.url).resolve('fastify')
).href;
const tempDirs = [];

// Writes a stand-in for dist/app.js. `body` runs inside buildApp() with a
// Fastify instance named `app`; `prelude` runs at module load.
function stubAppModule({ prelude = '', body = '' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'terrastories-smoke-stub-'));
  tempDirs.push(dir);
  const file = join(dir, 'app.mjs');
  writeFileSync(
    file,
    `import Fastify from ${JSON.stringify(fastifyUrl)};
${prelude}
export async function buildApp() {
  const app = Fastify();
  ${body}
  return app;
}
`
  );
  return pathToFileURL(file).href;
}

const healthy = `
  app.get('/health', async () => ({ status: 'ok', database: { connected: true } }));
  app.get('/docs/static/index.html', async () => 'ok');
`;

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('runtime smoke', () => {
  it('passes when the app loads, is healthy and serves Swagger UI assets', async () => {
    const env = {};
    await expect(
      runRuntimeSmoke({
        packageJson,
        appModuleUrl: stubAppModule({ body: healthy }),
        runningNode: '20.19.0',
        requireEngineMinimum: true,
        env,
      })
    ).resolves.toBe(
      'Runtime smoke passed on Node 20.19.0 (declared minimum 20.19.0)'
    );
    expect(env.NODE_ENV).toBe('production');
    expect(env.JWT_SECRET).toMatch(/^[0-9a-f]{64}$/);
  });

  it('fails when a dependency cannot be loaded (ERR_REQUIRE_ESM class)', async () => {
    const appModuleUrl = stubAppModule({
      prelude: `throw Object.assign(new Error('require() of ES Module not supported'), { code: 'ERR_REQUIRE_ESM' });`,
    });
    await expect(
      runRuntimeSmoke({ packageJson, appModuleUrl, env: {} })
    ).rejects.toMatchObject({ code: 'ERR_REQUIRE_ESM' });
  });

  it('fails on an unhealthy /health response', async () => {
    const appModuleUrl = stubAppModule({
      body: `app.get('/health', async () => ({ status: 'ok', database: { connected: false } }));`,
    });
    await expect(
      runRuntimeSmoke({ packageJson, appModuleUrl, env: {} })
    ).rejects.toThrow('Unhealthy API response');
  });

  it('fails when the Swagger UI static assets are missing', async () => {
    const appModuleUrl = stubAppModule({
      body: `app.get('/health', async () => ({ status: 'ok', database: { connected: true } }));`,
    });
    await expect(
      runRuntimeSmoke({ packageJson, appModuleUrl, env: {} })
    ).rejects.toThrow('Swagger UI static assets returned HTTP 404');
  });

  it('fails on a Node version other than the declared minimum when required', async () => {
    await expect(
      runRuntimeSmoke({
        packageJson,
        appModuleUrl: stubAppModule({ body: healthy }),
        runningNode: '20.19.1',
        requireEngineMinimum: true,
        env: {},
      })
    ).rejects.toThrow(
      'Expected exactly the declared minimum Node 20.19.0; running 20.19.1'
    );
  });
});
