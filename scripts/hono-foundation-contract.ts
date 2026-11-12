/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'node:assert/strict';
import { eq, sql } from 'drizzle-orm';
import { hash } from 'bcrypt';
import { serve } from '@hono/node-server';
import { EventEmitter, once } from 'node:events';
import type { Database } from '../src/db/index.js';
import { dialectOf, tablesFor } from '../src/db/dialect.js';
import {
  communityMediaPg,
  communityMediaSqlite,
  sessionsPg,
  sessionsSqlite,
} from '../src/db/schema/sessions.js';
import { HonoFoundationRepository } from '../src/repositories/hono-foundation.repository.js';
import { createHonoApp } from '../src/hono-app.js';
import { nodePasswordVerifier } from '../src/node-password.js';
import {
  sessionLifetime,
  sessionRenewalInterval,
} from '../src/shared/session-policy.js';
const status = async (
  response: Promise<Response>,
  expected: number,
  message?: string
) => assert.equal((await response).status, expected, message);
type App = ReturnType<typeof createHonoApp>;
const send = (app: App, path: string, init?: RequestInit) =>
  Promise.resolve(app.request(new Request('http://localhost' + path, init)));
const failsClosed = async (response: Promise<Response>, detail: string) => {
  const result = await response;
  assert.equal(result.status, 503);
  assert.ok(!(await result.text()).includes(detail));
};
export async function runHonoFoundationContract(
  database: Database
): Promise<void> {
  const db = database as any;
  const tables = tablesFor(database);
  const media =
    dialectOf(database) === 'postgresql'
      ? communityMediaPg
      : communityMediaSqlite;
  const sessions =
    dialectOf(database) === 'postgresql' ? sessionsPg : sessionsSqlite;
  const tag = crypto.randomUUID();
  const password = 'Foundation-password-42!';
  // bcrypt emits $2b$; Rails/Devise preserves the compatible $2a$ encoding.
  const passwordHash = (await hash(password, 4)).replace('$2b$', '$2a$');
  const communityIds: number[] = [];
  const userIds: number[] = [];
  const fileIds: string[] = [];
  let instant = new Date('2026-11-11T12:00:00Z');
  let reads = 0;
  const repository = new HonoFoundationRepository(database);
  const options = {
    repository,
    verifier: nodePasswordVerifier,
    secureCookies: false,
    now: () => instant,
    storage: {
      read: async (_key: string) => {
        reads++;
        return new Uint8Array([1, 2, 3]);
      },
    },
  };
  const app = createHonoApp(options);
  type Transport = (req: Request) => Promise<Response>;
  const transport: Transport = async (req) => app.request(req);
  const get = (path: string, cookie = '') =>
    send(app, path, { headers: { cookie } });
  const postRaw = (target: typeof app, body: string, headers = {}) =>
    send(target, '/v2/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    });
  const postLogin = (target: typeof app, body: unknown, headers = {}) =>
    postRaw(target, JSON.stringify(body), headers);
  const me = (cookie?: string) => get('/v2/auth/me', cookie);
  const readMedia = (cookie?: string, id = fileIds[0]) =>
    get('/v2/media/' + id, cookie);
  const action = (name: string, cookie: string) =>
    send(app, '/v2/auth/' + name, { method: 'POST', headers: { cookie } });
  const updateFile = (values: Record<string, unknown>) =>
    db.update(tables.files).set(values).where(eq(tables.files.id, fileIds[0]));
  const bind = (communityId: number) =>
    db.update(media).set({ communityId }).where(eq(media.fileId, fileIds[0]));
  const login = async (
    email: string,
    communityId?: number,
    previous?: string
  ) => {
    const response = await postLogin(
      app,
      { email, password, communityId },
      previous ? { cookie: previous } : {}
    );
    const body = await response.text();
    assert.equal(response.status, 200, `login failed: ${body}`);
    const header = response.headers.get('set-cookie');
    assert.ok(header?.includes('HttpOnly'));
    assert.ok(header?.includes('SameSite=Strict'));
    const cookie = header!.split(';')[0];
    assert.ok(cookie.startsWith('ts_session='));
    assert.ok(
      !body.includes(passwordHash) && !body.includes(password),
      'credentials must not enter response'
    );
    return cookie;
  };
  const updateUser = async (id: number, values: Record<string, unknown>) =>
    db.update(tables.users).set(values).where(eq(tables.users.id, id));
  const updateCommunity = async (id: number, values: Record<string, unknown>) =>
    db
      .update(tables.communities)
      .set(values)
      .where(eq(tables.communities.id, id));
  try {
    for (const suffix of ['a', 'b']) {
      const [row] = await db
        .insert(tables.communities)
        .values({ name: `Hono ${suffix}`, slug: `hono-${tag}-${suffix}` })
        .returning();
      communityIds.push(row.id);
    }
    const [communityA, communityB] = communityIds;
    const viewerEmail = `viewer-${tag}@example.test`;
    const credentials = { email: viewerEmail, password };
    const adminEmail = `admin-${tag}@example.test`;
    const systemEmail = `system-${tag}@example.test`;
    const duplicateEmail = `duplicate-${tag}@example.test`;
    const userDefaults = {
      passwordHash,
      firstName: 'Hono',
      lastName: 'Contract',
    };
    for (const [email, role, communityId] of [
      [viewerEmail, 'viewer', communityA],
      [adminEmail, 'admin', communityA],
      [systemEmail, 'super_admin', communityA],
      [duplicateEmail, 'viewer', communityA],
      [duplicateEmail, 'viewer', communityB],
    ] as const) {
      const [row] = await db
        .insert(tables.users)
        .values({
          ...userDefaults,
          email,
          role,
          communityId,
        })
        .returning();
      userIds.push(row.id);
    }
    const viewerId = userIds[0];
    for (const communityId of [communityA, communityB, communityA]) {
      const id = crypto.randomUUID();
      await db.insert(tables.files).values({
        id,
        filename: 'branding.png',
        originalName: 'branding.png',
        path: `communities/${communityId}/${id}`,
        url: 'https://ignored.invalid/legacy',
        mimeType: 'image/png',
        size: 3,
        communityId,
        uploadedBy: viewerId,
        createdAt: instant,
        updatedAt: instant,
      });
      fileIds.push(id);
    }
    await db.insert(media).values([
      { fileId: fileIds[0], communityId: communityA, kind: 'branding' },
      { fileId: fileIds[1], communityId: communityB, kind: 'branding' },
    ]);
    await status(get('/health'), 200);
    await status(get('/ready'), 200);
    const apiOrigin = 'https://api.example.test';
    const clientOrigin = 'https://client.example.test';
    const foreignOrigin = 'https://foreign.invalid';
    const browserApp = createHonoApp({
      ...options,
      publicOrigin: apiOrigin,
      corsOrigins: [clientOrigin],
    });
    for (const [origin, expected] of [
      [apiOrigin, 400],
      [foreignOrigin, 403],
    ]) {
      const browserResponse = await postLogin(
        browserApp,
        {},
        { Origin: String(origin) }
      );
      assert.equal(browserResponse.status, expected, 'HTTPS proxy origin');
    }
    for (const origin of [clientOrigin, foreignOrigin]) {
      const preflight = await send(browserApp, '/v2/auth/login', {
        method: 'OPTIONS',
        headers: {
          Origin: origin,
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'Content-Type',
        },
      });
      assert.equal(preflight.status, 204);
      const allowedOrigin = preflight.headers.get(
        'access-control-allow-origin'
      );
      assert.equal(allowedOrigin, origin === clientOrigin ? origin : null);
      assert.ok(preflight.headers.get('vary')?.includes('Origin'));
      assert.notEqual(allowedOrigin, '*');
    }
    // Keep native Request identity: node-server's global override makes native
    // Request.clone() fail Hono's instanceof Request transport dispatch.
    const server = serve({
      fetch: app.fetch,
      hostname: '127.0.0.1',
      port: 0,
      overrideGlobalObjects: false,
    });
    try {
      if (!server.listening) await once(server, 'listening');
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      await status(fetch(`http://127.0.0.1:${address.port}/health`), 200);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
    await status(postLogin(app, credentials, { Origin: foreignOrigin }), 403);
    await status(me(), 401);
    for (const payload of [
      { email: viewerEmail, password: 'wrong' },
      { email: `missing-${tag}@example.test`, password },
      { email: duplicateEmail, password },
      { email: viewerEmail, password, communityId: communityB },
      { email: viewerEmail, password, communityId: 2147483647 },
    ])
      await status(postLogin(app, payload), 401);
    for (const payload of [
      {},
      { email: viewerEmail, password, communityId: '1junk' },
      { email: viewerEmail, password: 1 },
      ...[0, -1, 1.5, 2147483648, 3000000000, Number.MAX_SAFE_INTEGER].map(
        (communityId) => ({ email: viewerEmail, password, communityId })
      ),
    ]) {
      await status(postLogin(app, payload), 400);
    }
    await status(postRaw(app, '{'), 400);
    await login(duplicateEmail, communityA);
    const attackerCookie = `ts_session=${'a'.repeat(64)}`;
    const cookie = await login(viewerEmail, undefined, attackerCookie);
    assert.notEqual(cookie, attackerCookie, 'fixation rejected');
    await status(me(attackerCookie), 401);
    await status(me(cookie), 200);
    const restarted = createHonoApp({
      ...options,
      repository: new HonoFoundationRepository(database),
    });
    await status(
      send(restarted, '/v2/auth/me', { headers: { cookie } }),
      200,
      'durable session survives app reconstruction'
    );
    const tampered = `${cookie.slice(0, -1)}${cookie.endsWith('a') ? 'b' : 'a'}`;
    await status(me(tampered), 401);
    const replacement = await login(viewerEmail, undefined, cookie);
    assert.notEqual(replacement, cookie, 'login rotates opaque identifier');
    await status(me(cookie), 401, 'rotated token is revoked');
    const own = await readMedia(replacement);
    assert.equal(own.status, 200);
    assert.deepEqual(
      new Uint8Array(await own.arrayBuffer()),
      new Uint8Array([1, 2, 3])
    );
    assert.equal(own.headers.get('cache-control'), 'no-store');
    const adminCookie = await login(adminEmail);
    await status(readMedia(adminCookie), 200);
    const crossSiteLogout = await transport(
      new Request('http://localhost/v2/auth/logout', {
        method: 'POST',
        headers: { cookie: replacement, 'Sec-Fetch-Site': 'cross-site' },
      })
    );
    assert.equal(crossSiteLogout.status, 403);
    await status(me(replacement), 200);
    const mediaRequest = new Request(
      `http://localhost/v2/media/${fileIds[0]}`,
      { headers: { cookie: replacement } }
    );
    const storageOutage = async () => {
      throw new Error('private detail');
    };
    for (const read of [async () => null, storageOutage]) {
      const variant = createHonoApp({ ...options, storage: { read } });
      const response = await variant.request(mediaRequest.clone());
      assert.equal(response.status, read === storageOutage ? 503 : 404);
      assert.ok(!(await response.text()).includes('private detail'));
    }
    await updateFile({ path: `communities/${communityA}/../secret` });
    const beforeTraversal = reads;
    await status(readMedia(replacement), 404);
    assert.equal(reads, beforeTraversal, 'traversal precedes read');
    await updateFile({ path: `communities/${communityA}/${fileIds[0]}` });
    const systemCookie = await login(systemEmail);
    const beforeDenied = reads;
    for (const [id, token] of [
      [fileIds[1], replacement],
      [fileIds[2], replacement],
      [fileIds[0], systemCookie],
      [fileIds[0], undefined],
    ]) {
      const response = await readMedia(token, id);
      assert.ok([401, 404].includes(response.status));
      assert.ok(!(await response.text()).includes('ignored.invalid'));
    }
    assert.equal(
      reads,
      beforeDenied,
      'forbidden requests never touch stored bytes'
    );
    await updateFile({
      culturalRestrictions: dialectOf(database) === 'postgresql' ? {} : '{}',
    });
    await status(readMedia(replacement), 404);
    await updateFile({ culturalRestrictions: sql`NULL` });
    // A valid FK on each side still must not authorize a cross-tenant binding.
    await bind(communityB);
    await status(readMedia(replacement), 404);
    await bind(communityA);
    await status(action('logout', replacement), 204);
    await status(me(replacement), 401);
    const first = await login(viewerEmail);
    const second = await login(viewerEmail);
    await status(action('revoke', second), 204);
    for (const token of [first, second]) await status(me(token), 401);
    for (const [change, restore] of [
      [{ isActive: false }, { isActive: true }],
      [{ role: 'admin' }, { role: 'viewer' }],
      [{ communityId: communityB }, { communityId: communityA }],
      [{ passwordHash: 'tampered' }, { passwordHash }],
    ]) {
      const active = await login(viewerEmail);
      await updateUser(viewerId, change);
      if ('isActive' in change) await status(postLogin(app, credentials), 401);
      await status(me(active), 401);
      await updateUser(viewerId, restore);
      await status(me(active), 401, 'restored account cannot revive token');
    }
    const disabledCookie = await login(viewerEmail);
    await updateCommunity(communityA, { isActive: false });
    await status(me(disabledCookie), 401);
    await updateCommunity(communityA, { isActive: true });
    await status(me(disabledCookie), 401, 'reactivation cannot revive token');
    const expired = await login(viewerEmail);
    const expiry = async (): Promise<number> =>
      (
        await db
          .select({ value: sessions.expiresAt })
          .from(sessions)
          .where(eq(sessions.userId, viewerId))
      )[0].value;
    const firstExpiry = await expiry();
    instant = new Date(instant.getTime() + sessionRenewalInterval - 1);
    await status(me(expired), 200);
    assert.equal(await expiry(), firstExpiry, 'no renewal before 15 minutes');
    instant = new Date(instant.getTime() + 1);
    await status(me(expired), 200);
    const renewedExpiry = await expiry();
    assert.equal(renewedExpiry, instant.getTime() + sessionLifetime);
    instant = new Date(instant.getTime() + 1);
    await status(me(expired), 200);
    assert.equal(await expiry(), renewedExpiry, 'renewals are bounded');
    instant = new Date(firstExpiry);
    const activeAfterInitialExpiry = await me(expired);
    assert.equal(activeAfterInitialExpiry.status, 200, 'active session slides');
    const renewedCookie = activeAfterInitialExpiry.headers.get('set-cookie');
    assert.ok(renewedCookie?.includes('Max-Age=43200'));
    instant = new Date(await expiry());
    await status(me(expired), 401, 'exact 12-hour idle boundary');
    await updateUser(viewerId, { passwordHash: 'malformed' });
    await status(
      postLogin(app, {
        ...credentials,
      }),
      401
    );
    await updateUser(viewerId, { passwordHash });
    const currentCookie = await login(viewerEmail);
    for (const dependency of ['readiness', 'session'] as const) {
      const unavailable = new HonoFoundationRepository(database);
      unavailable[dependency] = storageOutage;
      const failing = createHonoApp({ ...options, repository: unavailable });
      const path = dependency === 'readiness' ? '/ready' : '/v2/auth/me';
      await failsClosed(
        send(failing, path, { headers: { cookie: currentCookie } }),
        'private detail'
      );
    }
    const barrier = new EventEmitter();
    const reached = once(barrier, 'entered');
    const racing = createHonoApp({
      ...options,
      verifier: {
        verify: async () => {
          barrier.emit('entered');
          await once(barrier, 'resume');
          return true;
        },
      },
    });
    const pending = postLogin(racing, credentials);
    await reached;
    await updateUser(viewerId, { passwordHash: 'reset-during-verification' });
    barrier.emit('resume');
    const rejected = await pending;
    assert.equal(rejected.status, 401, 'password reset wins verifier race');
    assert.equal(rejected.headers.get('set-cookie'), null);
    await updateUser(viewerId, { passwordHash });
  } finally {
    for (const id of fileIds) {
      await db.delete(media).where(eq(media.fileId, id));
      await db.delete(tables.files).where(eq(tables.files.id, id));
    }
    for (const id of userIds) {
      await db.delete(sessions).where(eq(sessions.userId, id));
      await db.delete(tables.users).where(eq(tables.users.id, id));
    }
    for (const id of communityIds)
      await db.delete(tables.communities).where(eq(tables.communities.id, id));
  }
}
