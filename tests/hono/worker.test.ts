import { it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  applyD1Migrations,
  bundleWorkerModule,
  startWorkerRuntime,
} from '../helpers/worker-runtime.js';
it('serves the foundation through workerd D1/R2 without Node compatibility', async () => {
  // bundleWorkerModule fails the test when the bundle keeps any runtime import.
  const mf = startWorkerRuntime(
    await bundleWorkerModule(`import worker, {createWorker} from './src/worker.js';
      const verified=createWorker({async verify(p,h){return p==='ok' && h==='source-hash'}});
      export default {fetch:(r,e)=>r.headers.has('x-test-verifier') ? verified.fetch(r,e) : worker.fetch(r,e)};`)
  );
  try {
    const db = await mf.getD1Database('DB');
    const bucket = await mf.getR2Bucket('MEDIA');
    await applyD1Migrations(db);
    const token = 'a'.repeat(64);
    const digest = createHash('sha256').update(token).digest('hex');
    const own = '00000000-0000-4000-8000-000000000001';
    const foreign = '00000000-0000-4000-8000-000000000002';
    const sessionSql =
      'INSERT INTO sessions(id,token_hash,user_id,expires_at) VALUES(?,?,1,?)';
    const insertSession = (id: string) =>
      db.prepare(sessionSql).bind(id, digest, Date.now() + 60_000);
    await db.batch([
      db.prepare(
        "INSERT INTO communities(id,name,slug,created_at,updated_at) VALUES(1,'Own','own',0,0),(2,'Other','other',0,0)"
      ),
      db.prepare(
        "INSERT INTO users(id,email,password_hash,first_name,last_name,role,community_id,created_at,updated_at) VALUES(1,'viewer@example.org','source-hash','Test','Viewer','viewer',1,0,0)"
      ),
      insertSession('initial'),
      ...[own, foreign].map((id, index) =>
        db
          .prepare(
            "INSERT INTO files(id,filename,original_name,path,url,mime_type,size,community_id,uploaded_by,created_at,updated_at) VALUES(?,'logo','logo',?,'https://ignored.invalid','image/png',5,?,1,0,0)"
          )
          .bind(id, `communities/${index + 1}/logo`, index + 1)
      ),
      db
        .prepare(
          "INSERT INTO community_media(file_id,community_id,kind) VALUES(?,1,'branding'),(?,2,'branding')"
        )
        .bind(own, foreign),
    ]);
    await bucket.put('communities/1/logo', 'bytes');
    await bucket.put('communities/2/logo', 'other');
    const request = (path: string, method = 'GET', authenticated = true) =>
      mf.dispatchFetch(`https://worker.test${path}`, {
        method,
        headers: authenticated ? { Cookie: `ts_session=${token}` } : {},
      });
    expect((await request('/health')).status).toBe(200);
    expect((await request('/ready')).status).toBe(200);
    expect((await request('/v2/auth/me')).status).toBe(200);
    const media = await request(`/v2/media/${own}`);
    expect(media.status).toBe(200);
    expect(await media.text()).toBe('bytes');
    expect((await request(`/v2/media/${foreign}`)).status).toBe(404);
    expect((await request(`/v2/media/${own}`, 'GET', false)).status).toBe(401);
    const login = await mf.dispatchFetch('https://worker.test/v2/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'viewer@example.org',
        password: 'password',
      }),
    });
    expect(login.status).toBe(503);
    expect((await request('/v2/auth/logout', 'POST')).status).toBe(204);
    expect((await request('/v2/auth/me')).status).toBe(401);
    await insertSession('replacement').run();
    expect((await request('/v2/auth/me')).status).toBe(200);
    await db.batch([
      db.prepare('UPDATE users SET is_active=0 WHERE id=1'),
      db.prepare('UPDATE users SET is_active=1 WHERE id=1'),
    ]);
    expect((await request('/v2/auth/me')).status).toBe(401);
    const verifyLogin = (cookie = '') =>
      mf.dispatchFetch('https://worker.test/v2/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-test-verifier': 'yes',
          cookie,
        },
        body: JSON.stringify({ email: 'viewer@example.org', password: 'ok' }),
      });
    const loggedIn = await verifyLogin();
    expect(loggedIn.status).toBe(200);
    const oldCookie = loggedIn.headers.get('set-cookie')!.split(';')[0];
    const rotated = await verifyLogin(oldCookie);
    expect(rotated.status).toBe(200);
    const newCookie = rotated.headers.get('set-cookie')!.split(';')[0];
    expect(newCookie).not.toBe(oldCookie);
    const asCookie = (path: string, cookie: string, method = 'GET') =>
      mf.dispatchFetch(`https://worker.test${path}`, {
        method,
        headers: { cookie },
      });
    expect((await asCookie('/v2/auth/me', oldCookie)).status).toBe(401);
    expect((await asCookie('/v2/auth/me', newCookie)).status).toBe(200);
    expect((await asCookie('/v2/auth/revoke', newCookie, 'POST')).status).toBe(
      204
    );
    expect((await asCookie('/v2/auth/me', newCookie)).status).toBe(401);
  } finally {
    await mf.dispose();
  }
});
