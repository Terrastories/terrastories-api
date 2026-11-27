/**
 * The real Workers entrypoint (src/worker.ts) on workerd in a production
 * configuration (#146, #137): no /dev routes, no deferred routes, and
 * sessions authorized by the D1 row alone — deleting the row denies a cookie
 * the same running worker accepted a moment earlier.
 */
import { it, expect } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import {
  applyD1Migrations,
  bundleWorkerModule,
  startWorkerRuntime,
} from '../helpers/worker-runtime.js';

it('serves no dev or deferred routes and authorizes sessions from D1 only (production config)', async () => {
  const mf = startWorkerRuntime(
    await bundleWorkerModule(
      `import worker from './src/worker.js'; export default {fetch:(r,e)=>worker.fetch(r,e)};`
    ),
    // No ENVIRONMENT: production.
    {
      PUBLIC_ORIGIN: 'https://api.terrastories.org',
      AUTH_SERVER_SECRET: randomBytes(24).toString('hex'),
      BOOTSTRAP_SECRET: randomBytes(24).toString('hex'),
    }
  );
  try {
    const db = await mf.getD1Database('DB');
    await applyD1Migrations(db);
    const token = 'b'.repeat(64);
    const digest = createHash('sha256').update(token).digest('hex');
    await db.batch([
      db.prepare(
        "INSERT INTO communities(id,name,slug,created_at,updated_at) VALUES(1,'Own','own',0,0)"
      ),
      db.prepare(
        "INSERT INTO users(id,email,password_hash,first_name,last_name,role,community_id,created_at,updated_at) VALUES(1,'editor@example.org','source-hash','Test','Editor','editor',1,0,0)"
      ),
      db
        .prepare(
          'INSERT INTO sessions(id,token_hash,user_id,expires_at) VALUES(?,?,1,?)'
        )
        .bind('surface', digest, Date.now() + 60_000),
    ]);
    const request = (path: string, method = 'GET') =>
      mf.dispatchFetch(`https://worker.test${path}`, {
        method,
        headers: {
          Cookie: `ts_session=${token}`,
          'Content-Type': 'application/json',
        },
        body: method === 'GET' || method === 'HEAD' ? undefined : '{}',
      });
    expect((await request('/v2/auth/me')).status).toBe(200);
    for (const method of ['GET', 'HEAD', 'POST']) {
      for (const path of ['/dev/seed', '/dev/']) {
        expect((await request(path, method)).status, `${method} ${path}`).toBe(
          404
        );
      }
    }
    for (const [method, path] of [
      ['GET', '/v2/community/themes'],
      ['POST', '/v2/media/1/copy'],
    ] as const) {
      expect((await request(path, method)).status, `${method} ${path}`).toBe(
        404
      );
    }
    // Same running worker: the cookie dies the moment the D1 row is gone.
    expect((await request('/v2/auth/me')).status).toBe(200);
    await db.prepare('DELETE FROM sessions').run();
    expect((await request('/v2/auth/me')).status).toBe(401);
  } finally {
    await mf.dispose();
  }
}, 120_000);
