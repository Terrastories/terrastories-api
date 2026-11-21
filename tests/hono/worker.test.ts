import { it, expect } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import {
  applyD1Migrations,
  bundleWorkerModule,
  startWorkerRuntime,
} from '../helpers/worker-runtime.js';
import {
  ORPHAN_SWEEP_REFERENCE_CHUNK,
  WORKER_SWEEP_SUBREQUEST_BUDGET,
} from '../../src/services/media-cleanup.service.js';
import { parseDeterministicZip } from '../../src/shared/utils/deterministic-zip.js';
import { CreateCommunityExportResponseSchema } from '../../src/shared/schemas/community-export.js';
import {
  MAX_PUBLIC_FILTER_VALUES,
  MAX_PUBLIC_TOTAL_FILTER_VALUES,
} from '../../src/shared/schemas/public-content.js';
import { AUTH_THROTTLE_WINDOW_MS } from '../../src/shared/auth-policy.js';
import { validateContentFreeAuditEntry } from '../../src/shared/utils/audit-entry.js';
it('serves the foundation through workerd D1/R2 without Node compatibility', async () => {
  // bundleWorkerModule fails the test when the bundle keeps any runtime import.
  // AUTH_SERVER_SECRET and both persona stretched keys are runtime values.
  const authSecret = randomBytes(24).toString('hex');
  const viewerKey = randomBytes(32).toString('hex');
  const pubAdminKey = randomBytes(32).toString('hex');
  const sha256 = (value) => createHash('sha256').update(value).digest('hex');
  const personaSalt = randomBytes(16).toString('base64');
  const personaParams = JSON.stringify({
    memoryKiB: 19 * 1024,
    iterations: 2,
    parallelism: 1,
  });
  const mf = startWorkerRuntime(
    await bundleWorkerModule(
      `import worker from './src/worker.js';
       export default worker;`
    ),
    { ENVIRONMENT: 'test', AUTH_SERVER_SECRET: authSecret }
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
      db
        .prepare(
          "INSERT INTO users(id,email,password_hash,first_name,last_name,role,community_id,created_at,updated_at,password_algorithm,password_salt,password_params,password_verifier) VALUES(1,'viewer@example.org','source-hash','Test','Viewer','viewer',1,0,0,?,?,?,?)"
        )
        .bind(
          'client-argon2id+sha256',
          personaSalt,
          personaParams,
          sha256(viewerKey)
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
    const rejectedLogin = await mf.dispatchFetch(
      'https://worker.test/v2/auth/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier: 'viewer@example.org',
          derivedKey: randomBytes(32).toString('hex'),
        }),
      }
    );
    expect(rejectedLogin.status).toBe(401);
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
          ...(cookie === '' ? {} : { cookie }),
        },
        body: JSON.stringify({
          identifier: 'viewer@example.org',
          derivedKey: viewerKey,
        }),
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

    // Slice 7 real workerd D1 atomic audit & race-safe delete assertions (#145)
    await db
      .prepare(
        "INSERT INTO users(id,email,password_hash,first_name,last_name,role,community_id,is_active,created_at,updated_at,password_algorithm,password_salt,password_params,password_verifier) VALUES(2,'pub-admin@example.org','source-hash','Pub','Admin','admin',3,1,0,0,?,?,?,?)"
      )
      .bind(
        'client-argon2id+sha256',
        personaSalt,
        personaParams,
        sha256(pubAdminKey)
      )
      .run();
    const pubAdminLogin = await mf.dispatchFetch(
      'https://worker.test/v2/auth/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier: 'pub-admin@example.org',
          derivedKey: pubAdminKey,
        }),
      }
    );
    expect(pubAdminLogin.status).toBe(200);
    const pubAdminCookie = pubAdminLogin.headers
      .get('set-cookie')!
      .split(';')[0]!;

    const patchJson = (path: string, body: unknown, method = 'PATCH') =>
      mf.dispatchFetch(`https://worker.test${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          cookie: pubAdminCookie,
        },
        body: JSON.stringify(body),
      });

    expect(
      (
        await patchJson('/v2/community', {
          name: 'Pub Sensitive Title',
          visibility: 'private',
        })
      ).status
    ).toBe(200);
    // No-op private -> private must not emit a second audit entry
    expect(
      (await patchJson('/v2/community', { visibility: 'private' })).status
    ).toBe(200);
    expect(
      (await patchJson('/v2/community', { visibility: 'public' })).status
    ).toBe(200);

    const d1Audits = (
      await db
        .prepare(
          "SELECT community_id, actor_id, action, resource_type, resource_ids, outcome, ip_address, user_agent FROM audit_entries WHERE community_id = 3 AND action LIKE 'community.%' ORDER BY id ASC"
        )
        .all<{
          community_id: number | null;
          actor_id: number | null;
          action: string;
          resource_type: string | null;
          resource_ids: string;
          outcome: string;
          ip_address: string | null;
          user_agent: string | null;
        }>()
    ).results;
    expect(d1Audits).toHaveLength(2);
    expect(d1Audits.map((row) => row.action)).toEqual([
      'community.visibility.private',
      'community.visibility.public',
    ]);
    for (const row of d1Audits) {
      const validated = validateContentFreeAuditEntry({
        communityId: row.community_id,
        actorId: row.actor_id,
        action: row.action,
        resourceType: row.resource_type,
        resourceIds: JSON.parse(row.resource_ids) as number[],
        outcome: row.outcome,
        ipAddress: row.ip_address,
        userAgent: row.user_agent,
      });
      expect(validated).toMatchObject({
        communityId: 3,
        actorId: 2,
        resourceType: 'community',
        resourceIds: [3],
        outcome: 'success',
        ipAddress: null,
        userAgent: null,
      });
      const serialized = JSON.stringify(row);
      expect(serialized).not.toContain('Pub Sensitive Title');
      expect(serialized).not.toContain('pub-admin@example.org');
    }

    // Referenced place & speaker retain attachments on 409; unreferenced lose them on 204
    await db.batch([
      db
        .prepare(
          "INSERT INTO attachments(community_id,owner_type,owner_id,file_id,role,ordinal,created_at) VALUES(3,'place',10,?,'place_photo',0,0)"
        )
        .bind(pubMedia),
      db
        .prepare(
          "INSERT INTO attachments(community_id,owner_type,owner_id,file_id,role,ordinal,created_at) VALUES(3,'speaker',20,?,'speaker_photo',0,0)"
        )
        .bind(pubMedia),
    ]);
    expect(
      (await asCookie('/v2/places/10', pubAdminCookie, 'DELETE')).status
    ).toBe(409);
    expect(
      (await asCookie('/v2/speakers/20', pubAdminCookie, 'DELETE')).status
    ).toBe(409);
    const preservedAttachments = (
      await db
        .prepare(
          "SELECT owner_type, owner_id FROM attachments WHERE community_id = 3 AND owner_type IN ('place', 'speaker')"
        )
        .all()
    ).results;
    expect(preservedAttachments).toHaveLength(2);

    const createdPlaceRes = await patchJson(
      '/v2/places',
      { name: 'Temp D1 Place' },
      'POST'
    );
    expect(createdPlaceRes.status).toBe(201);
    const createdPlaceId = (
      (await createdPlaceRes.json()) as { data: { id: number } }
    ).data.id;
    await db
      .prepare(
        "INSERT INTO attachments(community_id,owner_type,owner_id,file_id,role,ordinal,created_at) VALUES(3,'place',?,?,'place_photo',0,0)"
      )
      .bind(createdPlaceId, pubMedia)
      .run();
    expect(
      (await asCookie(`/v2/places/${createdPlaceId}`, pubAdminCookie, 'DELETE'))
        .status
    ).toBe(204);
    const deletedPlaceAttachments = (
      await db
        .prepare(
          "SELECT id FROM attachments WHERE community_id = 3 AND owner_type = 'place' AND owner_id = ?"
        )
        .bind(createdPlaceId)
        .all()
    ).results;
    expect(deletedPlaceAttachments).toHaveLength(0);
    expect(
      (await asCookie(`/v2/places/${createdPlaceId}`, pubAdminCookie, 'DELETE'))
        .status
    ).toBe(404);

    // Slice 8 story + edges + external links lifecycle on real D1 workerd
    const createdStoryRes = await patchJson(
      '/v2/stories',
      {
        title: 'D1 Worker Story',
        description: '<p>Worker <strong>river</strong></p>',
        visibility: 'public',
        topic: '  Worker Tradition  ',
        interviewLocationId: 10,
        interviewerId: 20,
        placeIds: [10, 10],
        speakerIds: [20, 20],
      },
      'POST'
    );
    expect(createdStoryRes.status).toBe(201);
    const createdStoryBody = (await createdStoryRes.json()) as {
      data: {
        id: number;
        places: Array<{ id: number }>;
        speakers: Array<{ id: number }>;
      };
    };
    const d1StoryId = createdStoryBody.data.id;
    expect(createdStoryBody.data.places.map((p) => p.id)).toEqual([10, 10]);
    expect(createdStoryBody.data.speakers.map((s) => s.id)).toEqual([20, 20]);

    expect(
      (
        await mf.dispatchFetch(
          `https://worker.test/v2/public/communities/pub/stories/${d1StoryId}`
        )
      ).status
    ).toBe(200);

    expect(
      (
        await patchJson(`/v2/stories/${d1StoryId}`, {
          visibility: 'editors',
        })
      ).status
    ).toBe(200);
    expect(
      (
        await mf.dispatchFetch(
          `https://worker.test/v2/public/communities/pub/stories/${d1StoryId}`
        )
      ).status
    ).toBe(404);

    const d1StoryAudits = (
      await db
        .prepare(
          "SELECT action FROM audit_entries WHERE community_id = 3 AND resource_type = 'story' ORDER BY id ASC"
        )
        .all<{ action: string }>()
    ).results;
    expect(d1StoryAudits.map((a) => a.action)).toEqual([
      'story.visibility.public',
      'story.visibility.editors',
    ]);

    expect(
      (
        await patchJson(
          `/v2/stories/${d1StoryId}/places`,
          { placeIds: [10] },
          'PUT'
        )
      ).status
    ).toBe(200);
    expect(
      (
        await patchJson(
          `/v2/stories/${d1StoryId}/speakers`,
          { speakerIds: [] },
          'PUT'
        )
      ).status
    ).toBe(200);

    expect(
      (
        await patchJson(
          `/v2/stories/${d1StoryId}/external-links`,
          { url: 'javascript:alert(1)' },
          'POST'
        )
      ).status
    ).toBe(400);
    const linkARes = await patchJson(
      `/v2/stories/${d1StoryId}/external-links`,
      { url: 'https://worker-media.example.test/1' },
      'POST'
    );
    expect(linkARes.status).toBe(201);
    const linkABody = (await linkARes.json()) as {
      data: { id: number; ordinal: number };
    };
    const linkAId = linkABody.data.id;
    expect(linkABody.data.ordinal).toBe(0);
    const linkBRes = await patchJson(
      `/v2/stories/${d1StoryId}/external-links`,
      { url: 'https://worker-media.example.test/2' },
      'POST'
    );
    expect(linkBRes.status).toBe(201);
    const linkBBody = (await linkBRes.json()) as {
      data: { id: number; ordinal: number };
    };
    const linkBId = linkBBody.data.id;
    expect(linkBBody.data.ordinal).toBe(1);

    const reorderRes = await patchJson(
      `/v2/stories/${d1StoryId}/external-links/reorder`,
      { linkIds: [linkBId, linkAId] }
    );
    expect(reorderRes.status).toBe(200);
    const reorderedLinks = (
      (await reorderRes.json()) as {
        data: Array<{ id: number; ordinal: number }>;
      }
    ).data;
    expect(reorderedLinks.map((l) => [l.id, l.ordinal])).toEqual([
      [linkBId, 0],
      [linkAId, 1],
    ]);

    expect(
      (
        await asCookie(
          `/v2/stories/${d1StoryId}/external-links/${linkAId}`,
          pubAdminCookie,
          'DELETE'
        )
      ).status
    ).toBe(204);
    expect(
      (await asCookie(`/v2/stories/${d1StoryId}`, pubAdminCookie, 'DELETE'))
        .status
    ).toBe(204);
    const leftoverLinks = (
      await db
        .prepare('SELECT id FROM external_media_links WHERE story_id = ?')
        .bind(d1StoryId)
        .all()
    ).results;
    expect(leftoverLinks).toHaveLength(0);

    // Slice 9 R2 + D1 streaming multipart upload, metadata, Range download, and delete
    const pngBytes = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
    ]);
    const boundary = 'r2WorkerUploadBoundary';
    const enc = new TextEncoder();
    const mpHead = enc.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="r2-smoke.png"\r\nContent-Type: image/png\r\n\r\n`
    );
    const mpTail = enc.encode(`\r\n--${boundary}--\r\n`);
    const mpBody = new Uint8Array(
      mpHead.byteLength + pngBytes.byteLength + mpTail.byteLength
    );
    mpBody.set(mpHead, 0);
    mpBody.set(pngBytes, mpHead.byteLength);
    mpBody.set(mpTail, mpHead.byteLength + pngBytes.byteLength);

    const r2UpRes = await mf.dispatchFetch('https://worker.test/v2/media', {
      method: 'POST',
      headers: {
        cookie: pubAdminCookie,
        origin: 'https://worker.test',
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      body: mpBody,
    });
    expect(r2UpRes.status).toBe(201);
    const r2UpBody = (await r2UpRes.json()) as {
      data: { id: string; checksum: string; byteSize: number };
    };
    const r2FileId = r2UpBody.data.id;
    expect(r2UpBody.data.checksum).toBe(
      createHash('sha256').update(pngBytes).digest('hex')
    );
    expect(r2UpBody.data.byteSize).toBe(pngBytes.byteLength);

    const r2MetaRes = await asCookie(
      `/v2/media/${r2FileId}/metadata`,
      pubAdminCookie
    );
    expect(r2MetaRes.status).toBe(200);

    const r2RangeRes = await mf.dispatchFetch(
      `https://worker.test/v2/media/${r2FileId}`,
      {
        headers: {
          cookie: pubAdminCookie,
          range: 'bytes=0-3',
        },
      }
    );
    expect(r2RangeRes.status).toBe(206);
    expect(new Uint8Array(await r2RangeRes.arrayBuffer())).toEqual(
      pngBytes.subarray(0, 4)
    );

    const storedR2 = await bucket.get(`communities/3/media/${r2FileId}`);
    expect(storedR2).not.toBeNull();

    const r2DelRes = await mf.dispatchFetch(
      `https://worker.test/v2/media/${r2FileId}`,
      {
        method: 'DELETE',
        headers: {
          cookie: pubAdminCookie,
          origin: 'https://worker.test',
        },
      }
    );
    expect(r2DelRes.status).toBe(204);
    expect(await bucket.get(`communities/3/media/${r2FileId}`)).toBeNull();
  } finally {
    await mf.dispose();
  }
});

it('runs the orphan sweep from the scheduled() cron handler', async () => {
  // The scheduled handler is only triggerable when Miniflare's
  // unsafeTriggerHandlers is enabled; the sweep itself must delete an object
  // whose files row is gone and keep a still-referenced object.
  const mf = startWorkerRuntime(
    await bundleWorkerModule(
      `import worker from './src/worker.js'; export default worker;`
    ),
    { ENVIRONMENT: 'test' },
    { unsafeTriggerHandlers: true }
  );
  try {
    const db = await mf.getD1Database('DB');
    const bucket = await mf.getR2Bucket('MEDIA');
    await applyD1Migrations(db);
    await db.batch([
      db.prepare(
        "INSERT INTO communities(id,name,slug,created_at,updated_at) VALUES(1,'Sweep','sweep',0,0)"
      ),
      db.prepare(
        "INSERT INTO files(id,filename,original_name,path,storage_key,url,mime_type,size,community_id,uploaded_by,created_at,updated_at) VALUES('11111111-1111-4111-8111-111111111111','keep','keep','communities/1/keep','communities/1/keep','https://ignored.invalid','image/png',3,1,NULL,0,0)"
      ),
    ]);
    // Referenced object (has a files row) and orphan object (no files row).
    await bucket.put('communities/1/keep', 'abc');
    await bucket.put('communities/1/orphan', 'xyz');

    // Dispatch with a scheduled time 48 h in the future: the freshly-put
    // objects (uploaded "now") are then older than the 24 h grace window, so
    // the orphan is swept and the referenced object is kept.
    const scheduledTime = Date.now() + 48 * 60 * 60 * 1000;
    const res = await mf.dispatchFetch(
      `http://localhost/cdn-cgi/handler/scheduled?cron=0+*+*+*+*&time=${scheduledTime}`,
      { method: 'POST' }
    );
    expect(res.status).toBe(200);

    // The orphan (no files row) is removed.
    expect(await bucket.get('communities/1/orphan')).toBeNull();
    // The referenced object survives because its files row still exists.
    expect(await bucket.get('communities/1/keep')).not.toBeNull();
  } finally {
    await mf.dispose();
  }
});
it('runs the maintenance sweeps from the scheduled() cron handler', async () => {
  // The scheduled handler must also run the byte-free maintenance sweeps:
  // past-90-day audit entries lose ip/user_agent, expired session rows are
  // deleted, and spent non-blocking throttle rows are deleted. Live rows
  // survive; ORPHAN_SWEEP_PAUSED does not pause these jobs.
  const mf = startWorkerRuntime(
    await bundleWorkerModule(
      `import worker from './src/worker.js'; export default worker;`
    ),
    { ENVIRONMENT: 'test', ORPHAN_SWEEP_PAUSED: 'true' },
    { unsafeTriggerHandlers: true }
  );
  try {
    const db = await mf.getD1Database('DB');
    await applyD1Migrations(db);
    const nowMs = Date.now();
    await db.batch([
      db.prepare(
        "INSERT INTO communities(id,name,slug,created_at,updated_at) VALUES(1,'Maintenance','maintenance',0,0)"
      ),
      db.prepare(
        "INSERT INTO users(id,email,password_hash,first_name,last_name,role,community_id,created_at,updated_at) VALUES(1,'maintenance@example.org','anchor-hash','Maint','User','member',1,0,0)"
      ),
      db
        .prepare(
          `INSERT INTO sessions(id,token_hash,user_id,expires_at,kind,created_at,last_seen_at,idle_expires_at,absolute_expires_at)
         VALUES('sess-worker-expired','hash-expired',1,?, 'standard',?,?,?,?)`
        )
        .bind(
          nowMs - 1000,
          nowMs - 2000,
          nowMs - 2000,
          nowMs - 1000,
          nowMs + 30 * 24 * 3600 * 1000
        ),
      db
        .prepare(
          `INSERT INTO sessions(id,token_hash,user_id,expires_at,kind,created_at,last_seen_at,idle_expires_at,absolute_expires_at)
         VALUES('sess-worker-live','hash-live',1,?, 'standard',?,?,?,?)`
        )
        .bind(
          nowMs + 5 * 24 * 3600 * 1000,
          nowMs,
          nowMs,
          nowMs + 5 * 24 * 3600 * 1000,
          nowMs + 30 * 24 * 3600 * 1000
        ),
      db
        .prepare(
          "INSERT INTO auth_throttle(key,kind,community_id,failures,window_started_at,blocked_until) VALUES('worker-throttle-spent','ip',NULL,3,?,NULL)"
        )
        .bind(nowMs - 2 * AUTH_THROTTLE_WINDOW_MS),
      db
        .prepare(
          "INSERT INTO auth_throttle(key,kind,community_id,failures,window_started_at,blocked_until) VALUES('worker-throttle-blocked','ip',NULL,3,?,?)"
        )
        .bind(nowMs - 2 * AUTH_THROTTLE_WINDOW_MS, nowMs + 3600 * 1000),
      db
        .prepare(
          `INSERT INTO audit_entries(community_id,actor_id,action,resource_type,resource_ids,outcome,ip_address,user_agent,created_at)
         VALUES(1,1,'auth.login','auth','[]','success','203.0.113.9','sweep-agent/1.0',?)`
        )
        .bind(nowMs - 100 * 24 * 3600 * 1000),
      db
        .prepare(
          `INSERT INTO audit_entries(community_id,actor_id,action,resource_type,resource_ids,outcome,ip_address,user_agent,created_at)
         VALUES(1,1,'auth.logout','auth','[]','success','203.0.113.10','sweep-agent/1.0',?)`
        )
        .bind(nowMs - 10 * 24 * 3600 * 1000),
    ]);

    const res = await mf.dispatchFetch(
      `http://localhost/cdn-cgi/handler/scheduled?cron=0+*+*+*+*&time=${nowMs}`,
      { method: 'POST' }
    );
    expect(res.status).toBe(200);

    const audits = await db
      .prepare(
        'SELECT action, ip_address, user_agent FROM audit_entries ORDER BY action'
      )
      .all();
    expect(audits.results).toHaveLength(2);
    expect(audits.results[0]).toMatchObject({
      action: 'auth.login',
      ip_address: null,
      user_agent: null,
    });
    expect(audits.results[1]).toMatchObject({
      action: 'auth.logout',
      ip_address: '203.0.113.10',
      user_agent: 'sweep-agent/1.0',
    });

    const sessionRows = await db
      .prepare('SELECT id FROM sessions ORDER BY id')
      .all();
    expect(sessionRows.results).toEqual([{ id: 'sess-worker-live' }]);

    const throttleRows = await db
      .prepare('SELECT key FROM auth_throttle ORDER BY key')
      .all();
    expect(throttleRows.results).toEqual([{ key: 'worker-throttle-blocked' }]);
  } finally {
    await mf.dispose();
  }
});

it('resumes the scheduled R2 sweep past live objects across multiple runs', async () => {
  // More live (files-row-backed) objects sort before the orphan than the
  // per-run Worker budget, so a single run cannot reach it. The sweep
  // persists its key-based resume position in R2 and later runs finish the
  // job; a referenced object is never deleted.
  const mf = startWorkerRuntime(
    await bundleWorkerModule(
      `import worker from './src/worker.js'; export default worker;`
    ),
    { ENVIRONMENT: 'test' },
    { unsafeTriggerHandlers: true }
  );
  try {
    const db = await mf.getD1Database('DB');
    const bucket = await mf.getR2Bucket('MEDIA');
    await applyD1Migrations(db);
    await db
      .prepare(
        "INSERT INTO communities(id,name,slug,created_at,updated_at) VALUES(1,'Live','live',0,0)"
      )
      .run();

    // More live (files-row-backed) objects than one scheduled run's
    // subrequest budget can scan. The sweep pages 200 keys at a time; each
    // full live page costs 1 list + ceil(200/45) reference queries. The
    // bound below is derived from the budget constants, so it stays valid if
    // either constant changes — the orphan must be reached within it.
    const pageSize = 200;
    const refQueriesPerFullPage = Math.ceil(
      pageSize / ORPHAN_SWEEP_REFERENCE_CHUNK
    ); // ≤ 45 keys per query
    const subrequestsPerFullLivePage = 1 + refQueriesPerFullPage;
    const livePagesPerRun = Math.floor(
      WORKER_SWEEP_SUBREQUEST_BUDGET / subrequestsPerFullLivePage
    );
    // One full page more than a single run can walk, so the orphan (sorted
    // after every live key) is unreachable in run 1 whatever the budget is.
    const liveCount = (livePagesPerRun + 1) * pageSize;
    const computedBound =
      Math.ceil(Math.ceil(liveCount / pageSize) / livePagesPerRun) + 1;
    const inserts: ReturnType<typeof db.prepare>[] = [];
    for (let i = 0; i < liveCount; i += 1) {
      const suffix = String(i).padStart(4, '0');
      const key = `communities/1/media/live-${suffix}`;
      inserts.push(
        db.prepare(
          `INSERT INTO files(id,filename,original_name,path,storage_key,url,mime_type,size,community_id,uploaded_by,created_at,updated_at) VALUES('live-${suffix}','live-${suffix}','live-${suffix}','${key}','${key}','https://ignored.invalid','image/png',3,1,NULL,0,0)`
        )
      );
    }
    for (let i = 0; i < inserts.length; i += 500) {
      await db.batch(inserts.slice(i, i + 500));
    }
    for (let i = 0; i < liveCount; i += 1) {
      const suffix = String(i).padStart(4, '0');
      await bucket.put(`communities/1/media/live-${suffix}`, 'live');
    }
    await bucket.put('communities/1/media/zz-orphan', 'orphan');

    // Schedule 48 h in the future so everything is older than the 24 h grace.
    const scheduledTime = Date.now() + 48 * 60 * 60 * 1000;
    const dispatch = () =>
      mf.dispatchFetch(
        `http://localhost/cdn-cgi/handler/scheduled?cron=0+*+*+*+*&time=${scheduledTime}`,
        { method: 'POST' }
      );

    // Dispatch until the orphan is reached, within the computed bound.
    // The first run must stop inside communities/ (liveCount exceeds one
    // run's scan capacity), so reaching the orphan proves the cursor
    // resume mechanism rather than a lucky single run.
    let runs = 0;
    let orphanDeleted = false;
    while (runs < computedBound && !orphanDeleted) {
      const res = await dispatch();
      expect(res.status).toBe(200);
      runs += 1;
      orphanDeleted =
        (await bucket.get('communities/1/media/zz-orphan')) === null;
      if (runs === 1 && !orphanDeleted) {
        // The first run stopped on budget; the resume position is stored.
        const resumed = await bucket.get('system/orphan-sweep-cursor.json');
        expect(resumed).not.toBeNull();
      }
    }
    expect(
      orphanDeleted,
      `orphan must be reached within ${computedBound} run(s) derived from the budget constants`
    ).toBe(true);
    expect(
      runs,
      'a single run cannot scan this many live objects'
    ).toBeGreaterThanOrEqual(2);
    // Every live object survived every run.
    for (let i = 0; i < liveCount; i += 1) {
      const suffix = String(i).padStart(4, '0');
      expect(
        await bucket.get(`communities/1/media/live-${suffix}`)
      ).not.toBeNull();
    }
  } finally {
    await mf.dispose();
  }
});

it('streams community export via R2 multipart upload, serves authenticated downloads, and cleans up expired objects', async () => {
  const authSecret = randomBytes(24).toString('hex');
  const adminKey = randomBytes(32).toString('hex');
  const sha256 = (value: string) =>
    createHash('sha256').update(value).digest('hex');
  const salt = randomBytes(16).toString('base64');
  const params = JSON.stringify({
    memoryKiB: 19 * 1024,
    iterations: 2,
    parallelism: 1,
  });
  const mf = startWorkerRuntime(
    await bundleWorkerModule(
      `import worker from './src/worker.js'; export default worker;`
    ),
    { ENVIRONMENT: 'test', AUTH_SERVER_SECRET: authSecret },
    { unsafeTriggerHandlers: true }
  );
  try {
    const db = await mf.getD1Database('DB');
    const bucket = await mf.getR2Bucket('MEDIA');
    await applyD1Migrations(db);
    const fileId = '00000000-0000-4000-8000-000000000099';
    const mediaBytes = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const mediaChecksum = createHash('sha256').update(mediaBytes).digest('hex');
    const storageKey = `communities/1/${fileId}.bin`;
    await db.batch([
      db.prepare(
        "INSERT INTO communities(id,name,slug,public_stories,is_active,created_at,updated_at) VALUES(1,'Worker Export','worker-export',0,1,1000,1000)"
      ),
      db
        .prepare(
          "INSERT INTO users(id,email,password_hash,first_name,last_name,role,community_id,created_at,updated_at,password_algorithm,password_salt,password_params,password_verifier) VALUES(1,'wadmin@example.org','source-hash','Worker','Admin','admin',1,1000,1000,?,?,?,?)"
        )
        .bind('client-argon2id+sha256', salt, params, sha256(adminKey)),
      db
        .prepare(
          "INSERT INTO files(id,filename,original_name,path,storage_key,url,mime_type,size,byte_size,checksum,community_id,uploaded_by,created_at,updated_at) VALUES(?,'sample.bin','sample.bin',?,?,'https://ignored.invalid','application/octet-stream',6,6,?,1,1,1000,1000)"
        )
        .bind(fileId, storageKey, storageKey, mediaChecksum),
    ]);
    await bucket.put(storageKey, mediaBytes);

    const loginRes = await mf.dispatchFetch(
      'https://worker.test/v2/auth/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier: 'wadmin@example.org',
          derivedKey: adminKey,
        }),
      }
    );
    expect(loginRes.status).toBe(200);
    const cookie = loginRes.headers.get('set-cookie')!.split(';')[0]!;

    const exportRes = await mf.dispatchFetch(
      'https://worker.test/v2/community/export',
      {
        method: 'POST',
        headers: { cookie, 'Content-Type': 'application/json' },
        body: '{}',
      }
    );
    expect(exportRes.status).toBe(201);
    const exportPayload = CreateCommunityExportResponseSchema.parse(
      await exportRes.json()
    );

    const manifestRes = await mf.dispatchFetch(
      `https://worker.test${exportPayload.data.artifacts.manifest.downloadPath}`,
      { headers: { cookie } }
    );
    expect(manifestRes.status).toBe(200);
    expect(manifestRes.headers.get('cache-control')).toBe('no-store');
    expect(manifestRes.headers.get('content-disposition')).toContain(
      'attachment'
    );
    const manifestBytes = new Uint8Array(await manifestRes.arrayBuffer());
    expect(createHash('sha256').update(manifestBytes).digest('hex')).toBe(
      exportPayload.data.artifacts.manifest.checksum
    );

    const zipRes = await mf.dispatchFetch(
      `https://worker.test${exportPayload.data.artifacts.mediaZip.downloadPath}`,
      { headers: { cookie } }
    );
    expect(zipRes.status).toBe(200);
    const zipBytes = new Uint8Array(await zipRes.arrayBuffer());
    expect(createHash('sha256').update(zipBytes).digest('hex')).toBe(
      exportPayload.data.artifacts.mediaZip.checksum
    );
    const parsedEntries = parseDeterministicZip(zipBytes);
    expect(parsedEntries).toHaveLength(1);
    expect(parsedEntries[0]!.path).toBe(`media/${fileId}`);
    expect(Array.from(parsedEntries[0]!.data)).toEqual(Array.from(mediaBytes));

    // Advance scheduled cron past token TTL so scheduled cleanup deletes objects.
    const futureMs = new Date(exportPayload.data.expiresAt).getTime() + 60_000;
    const schedRes = await mf.dispatchFetch(
      `http://localhost/cdn-cgi/handler/scheduled?cron=0+*+*+*+*&time=${futureMs}`,
      { method: 'POST' }
    );
    expect(schedRes.status).toBe(200);

    expect(
      await bucket.get(
        `communities/1/exports/${exportPayload.data.exportId}/manifest.json`
      )
    ).toBeNull();
    expect(
      await bucket.get(
        `communities/1/exports/${exportPayload.data.exportId}/media.zip`
      )
    ).toBeNull();
  } finally {
    await mf.dispose();
  }
});
