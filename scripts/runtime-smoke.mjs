#!/usr/bin/env node
// Minimum-runtime smoke: load the built app (dist/app.js) and start and stop
// it. A module-loading failure on the running Node version, such as
// ERR_REQUIRE_ESM from a CommonJS dependency that requires an ESM-only
// package, fails here before the server can answer /health.
//
// Usage: npm run build && node scripts/runtime-smoke.mjs [--require-engine-minimum]
//
// --require-engine-minimum also fails unless the running Node version is
// exactly the minimum declared in package.json engines.node (">=X.Y.Z").
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

export function declaredMinimumNode(packageJson) {
  const range = packageJson?.engines?.node;
  const match = /^>=(\d+\.\d+\.\d+)$/.exec(range ?? '');
  if (!match) {
    throw new Error(
      `package.json engines.node must be ">=X.Y.Z"; found ${JSON.stringify(range)}`
    );
  }
  return match[1];
}

export async function runRuntimeSmoke({
  packageJson,
  appModuleUrl = pathToFileURL(join(repoRoot, 'dist', 'app.js')).href,
  requireEngineMinimum = false,
  runningNode = process.versions.node,
  env = process.env,
} = {}) {
  const minimum = declaredMinimumNode(packageJson);

  if (requireEngineMinimum && runningNode !== minimum) {
    throw new Error(
      `Expected exactly the declared minimum Node ${minimum}; running ${runningNode}`
    );
  }

  const dataDir = mkdtempSync(join(tmpdir(), 'terrastories-runtime-smoke-'));
  env.NODE_ENV ??= 'production';
  env.DATABASE_URL ??= join(dataDir, 'runtime-smoke.db');
  env.JWT_SECRET ??= randomBytes(32).toString('hex');
  env.SESSION_SECRET ??= randomBytes(32).toString('hex');
  env.LOG_LEVEL ??= 'warn';

  let app;
  try {
    const { buildApp } = await import(appModuleUrl);
    app = await buildApp();
    const address = await app.listen({ port: 0, host: '127.0.0.1' });

    const response = await fetch(`${address}/health`);
    const health = await response.json();
    if (
      response.status !== 200 ||
      health?.status !== 'ok' ||
      health?.database?.connected !== true
    ) {
      throw new Error(`Unhealthy API response: ${JSON.stringify(health)}`);
    }

    const docs = await fetch(`${address}/docs/static/index.html`);
    if (docs.status !== 200) {
      throw new Error(`Swagger UI static assets returned HTTP ${docs.status}`);
    }

    return `Runtime smoke passed on Node ${runningNode} (declared minimum ${minimum})`;
  } finally {
    if (app) await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const packageJson = JSON.parse(
    readFileSync(join(repoRoot, 'package.json'), 'utf8')
  );
  runRuntimeSmoke({
    packageJson,
    requireEngineMinimum: process.argv.includes('--require-engine-minimum'),
  }).then(
    (message) => process.stdout.write(`${message}\n`),
    (error) => {
      process.stderr.write(`Runtime smoke failed: ${error?.stack ?? error}\n`);
      process.exit(1);
    }
  );
}
