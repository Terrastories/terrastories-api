import { it, expect } from 'vitest';
import {
  applyD1Migrations,
  bundleWorkerModule,
  startWorkerRuntime,
} from '../helpers/worker-runtime.js';

it('cron aborts journaled non-export multipart bytes and removes rows before recording completion', async () => {
  const mf = startWorkerRuntime(
    await bundleWorkerModule(
      "import worker from './src/worker.js'; export default worker;"
    ),
    { ENVIRONMENT: 'test' },
    { unsafeTriggerHandlers: true }
  );
  try {
    const db = await mf.getD1Database('DB');
    await applyD1Migrations(db);
    const now = Date.now(),
      requestId = crypto.randomUUID();
    await db.batch([
      db.prepare(
        "INSERT INTO communities(id,name,slug,is_active,created_at,updated_at) VALUES(1,'Erased','erased',0,0,0),(2,'Retained','retained',1,0,0)"
      ),
      db
        .prepare(
          "INSERT INTO community_sovereignty_requests(id,community_id,kind,state,initiated_by_role,requested_at,effective_at,updated_at) VALUES(?,1,'erasure','requested','admin',?,?,?)"
        )
        .bind(requestId, now, now, now),
    ]);
    const bucket = await mf.getR2Bucket('MEDIA');
    const records = await mf.getR2Bucket('ERASURE_RECORDS');
    const key = 'communities/1/imports/interrupted';
    const upload = await bucket.createMultipartUpload(key);
    const part = await upload.uploadPart(1, new Uint8Array([1, 2, 3]));
    await bucket.put(
      `communities/1/.multipart/${crypto.randomUUID()}.json`,
      JSON.stringify({ key, uploadId: upload.uploadId })
    );
    await bucket.put('communities/1/media/object', new Uint8Array([4]));
    await bucket.put('communities/2/media/object', new Uint8Array([5]));
    for (let pass = 0; pass < 2; pass++) {
      const response = await mf.dispatchFetch(
        `http://localhost/cdn-cgi/handler/scheduled?cron=*/1+*+*+*+*&time=${now + pass * 60000}`,
        { method: 'POST' }
      );
      expect(response.status).toBe(200);
    }
    expect(
      (await bucket.list({ prefix: 'communities/1/' })).objects
    ).toHaveLength(0);
    expect(await bucket.head('communities/2/media/object')).not.toBeNull();
    await expect(
      upload.complete([{ partNumber: 1, etag: part.etag }])
    ).rejects.toThrow();
    expect(
      await db.prepare('SELECT id FROM communities WHERE id=1').first()
    ).toBeNull();
    const record = await records.get('erasures/1-completed.json');
    expect(await record?.json()).toMatchObject({
      communityId: 1,
      requestId,
      outcome: 'completed',
    });
  } finally {
    await mf.dispose();
  }
}, 30000);

it('R2 fencing aborts a paused writer and survives adapter restart', async () => {
  const mf = startWorkerRuntime(
    await bundleWorkerModule(`
    import { createR2Storage } from './src/worker.js';
    export default { async fetch(request, env) {
      const storage = createR2Storage(env.MEDIA);
      let controller;
      let started;
      let resume;
      let first = true;
      const ready = new Promise(resolve => { started = resolve; });
      const body = new ReadableStream({ pull(c) {
        if (first) { first = false; c.enqueue(new Uint8Array(5 * 1024 * 1024)); return; }
        controller = c;
        started();
        return new Promise(resolve => { resume = resolve; });
      } }, {highWaterMark: 0});
      const writing = storage.put('communities/1/media/paused', body).then(() => 'published', () => 'refused');
      await ready;
      await storage.fenceCommunity(1);
      const page = await storage.list({prefix:'communities/1/'});
      await storage.deleteMany(page.entries.map(entry => entry.key));
      const emptyBeforeResume = (await storage.list({prefix:'communities/1/'})).entries.length;
      controller.enqueue(new Uint8Array([1,2,3]));
      controller.close();
      resume();
      const outcome = await writing;
      const restarted = createR2Storage(env.MEDIA);
      const late = await restarted.put('communities/1/media/late', new Uint8Array([4])).then(() => 'published', () => 'refused');
      return Response.json({outcome, late, emptyBeforeResume, remaining:(await storage.list({prefix:'communities/1/'})).entries.length});
    }};
  `),
    { ENVIRONMENT: 'test' }
  );
  try {
    const response = await mf.dispatchFetch('http://localhost/fence');
    expect(await response.json()).toEqual({
      outcome: 'refused',
      late: 'refused',
      emptyBeforeResume: 0,
      remaining: 0,
    });
  } finally {
    await mf.dispose();
  }
}, 30000);
