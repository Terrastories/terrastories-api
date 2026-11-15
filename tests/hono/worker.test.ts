import { it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  applyD1Migrations,
  bundleWorkerModule,
  startWorkerRuntime,
} from '../helpers/worker-runtime.js';
import {
  MAX_PUBLIC_FILTER_VALUES,
  MAX_PUBLIC_TOTAL_FILTER_VALUES,
} from '../../src/shared/schemas/public-content.js';
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

    // Public D1 max-cap filters (<= 100 bound params) and R2 range streaming (#145 PR #243)
    const pubMedia = '00000000-0000-4000-8000-000000000003';
    await db.batch([
      db.prepare(
        "INSERT INTO communities(id,name,slug,public_stories,is_active,created_at,updated_at) VALUES(3,'Pub','pub',1,1,0,0)"
      ),
      db.prepare(
        "INSERT INTO places(id,name,region,type_of_place,community_id,latitude,longitude,is_restricted,created_at,updated_at) VALUES(10,'River','North','Water',3,10.5,-20.5,0,0,0)"
      ),
      db.prepare(
        "INSERT INTO speakers(id,name,affiliation,community_id,is_active,created_at,updated_at) VALUES(20,'Marina','Guild',3,1,0,0)"
      ),
      db.prepare(
        "INSERT INTO stories(id,title,slug,language,topic,topic_normalized,privacy_level,is_restricted,community_id,created_at,updated_at) VALUES(30,'Public Story','public-story','en','Water','water','public',0,3,0,0)"
      ),
      db.prepare(
        'INSERT INTO story_places(community_id,story_id,place_id,created_at,updated_at) VALUES(3,30,10,0,0)'
      ),
      db.prepare(
        'INSERT INTO story_speakers(community_id,story_id,speaker_id,created_at,updated_at) VALUES(3,30,20,0,0)'
      ),
      db
        .prepare(
          "INSERT INTO files(id,filename,original_name,path,storage_key,url,mime_type,size,byte_size,community_id,uploaded_by,is_active,created_at,updated_at) VALUES(?,'clip.mp3','clip.mp3','communities/3/clip.mp3','communities/3/clip.mp3','https://ignored.invalid','audio/mpeg',16,16,3,1,1,0,0)"
        )
        .bind(pubMedia),
      db
        .prepare(
          "INSERT INTO attachments(community_id,owner_type,owner_id,file_id,role,ordinal,created_at) VALUES(3,'story',30,?,'story_media',0,0)"
        )
        .bind(pubMedia),
    ]);
    await bucket.put('communities/3/clip.mp3', '0123456789ABCDEF');

    const capParams = new URLSearchParams();
    capParams.append('place', '10');
    for (let i = 1; i < MAX_PUBLIC_FILTER_VALUES; i++) {
      capParams.append('place', String(10000 + i));
    }
    capParams.append('speaker', '20');
    for (
      let i = 1;
      i < MAX_PUBLIC_TOTAL_FILTER_VALUES - MAX_PUBLIC_FILTER_VALUES;
      i++
    ) {
      capParams.append('speaker', String(20000 + i));
    }
    const maxCapRes = await request(
      `/v2/public/communities/pub/stories?${capParams.toString()}`,
      'GET',
      false
    );
    expect(maxCapRes.status).toBe(200);
    const maxCapJson = (await maxCapRes.json()) as {
      data: { stories: Array<{ id: number }>; points: Array<{ id: number }> };
      meta: { total: number };
    };
    expect(maxCapJson.meta.total).toBe(1);
    expect(maxCapJson.data.stories.map((s) => s.id)).toEqual([30]);
    expect(maxCapJson.data.points.map((p) => p.id)).toEqual([10]);

    const sevenCatParams = new URLSearchParams();
    for (let i = 0; i < 10; i++) {
      sevenCatParams.append('place', String(i === 0 ? 10 : 30000 + i));
      sevenCatParams.append('region', i === 0 ? 'North' : `Region${i}`);
      sevenCatParams.append('typeOfPlace', i === 0 ? 'Water' : `Type${i}`);
      sevenCatParams.append('topic', i === 0 ? 'Water' : `Topic${i}`);
      sevenCatParams.append('language', i === 0 ? 'en' : `lang${i}`);
    }
    for (let i = 0; i < 5; i++) {
      sevenCatParams.append('speaker', String(i === 0 ? 20 : 40000 + i));
      sevenCatParams.append(
        'affiliation',
        i === 0 ? 'Guild' : `Affiliation${i}`
      );
    }
    const sevenCatRes = await request(
      `/v2/public/communities/pub/stories?${sevenCatParams.toString()}`,
      'GET',
      false
    );
    expect(sevenCatRes.status).toBe(200);

    const mediaFull = await request(
      `/v2/public/communities/pub/media/${pubMedia}`,
      'GET',
      false
    );
    expect(mediaFull.status).toBe(200);
    expect(await mediaFull.text()).toBe('0123456789ABCDEF');

    const mediaRange = await mf.dispatchFetch(
      `https://worker.test/v2/public/communities/pub/media/${pubMedia}`,
      { headers: { Range: 'bytes=2-5' } }
    );
    expect(mediaRange.status).toBe(206);
    expect(mediaRange.headers.get('Content-Range')).toBe('bytes 2-5/16');
    expect(mediaRange.headers.get('Content-Length')).toBe('4');
    expect(await mediaRange.text()).toBe('2345');

    const mediaMulti = await mf.dispatchFetch(
      `https://worker.test/v2/public/communities/pub/media/${pubMedia}`,
      { headers: { Range: 'bytes=0-1,4-5' } }
    );
    expect(mediaMulti.status).toBe(200);
    expect(mediaMulti.headers.get('Content-Length')).toBe('16');
    expect(await mediaMulti.text()).toBe('0123456789ABCDEF');

    const media416 = await mf.dispatchFetch(
      `https://worker.test/v2/public/communities/pub/media/${pubMedia}`,
      { headers: { Range: 'bytes=99-' } }
    );
    expect(media416.status).toBe(416);
    expect(media416.headers.get('Content-Range')).toBe('bytes */16');
  } finally {
    await mf.dispose();
  }
});
