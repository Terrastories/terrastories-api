/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'node:assert/strict';
import { and, asc, eq, inArray, like, sql } from 'drizzle-orm';
import { hash } from 'bcrypt';
import { serve } from '@hono/node-server';
import { once } from 'node:events';
import type { Database } from '../src/db/index.js';
import { dialectOf, tablesFor } from '../src/db/dialect.js';
import {
  communityMediaPg,
  communityMediaSqlite,
  sessionsPg,
  sessionsSqlite,
} from '../src/db/schema/sessions.js';
import { HonoFoundationRepository } from '../src/repositories/hono-foundation.repository.js';
import { HonoAuthRepository } from '../src/repositories/hono-auth.repository.js';
import { createHonoApp } from '../src/hono-app.js';
import {
  ARGON2ID_ALGORITHM,
  ARGON2ID_PARAMS_JSON,
  AUTH_THROTTLE_MAX_FAILURES,
  authThrottleBackoffMs,
} from '../src/shared/auth-policy.js';
import { sha256Hex, toHex } from '../src/shared/auth-crypto.js';
import {
  sessionLifetime,
  sessionRenewalInterval,
} from '../src/shared/session-policy.js';
import { validateContentFreeAuditEntry } from '../src/shared/utils/audit-entry.js';
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
/** Fail fast instead of hanging a CI gate forever if the app stalls. */
const withDeadline = <T>(
  promise: Promise<T>,
  ms: number,
  label: string
): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} exceeded ${ms}ms deadline`)),
      ms
    );
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
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
  /**
   * Poll until at least `expected` backends are blocked behind this
   * transaction's open lock, then return the observed count (or that count at
   * the deadline). Deterministic: a backend blocked behind the uncommitted
   * change is what lets the racing write lose the authority gate against the
   * *committed* row, rather than fail for an unrelated reason.
   */
  /** Settle a promise so an unobserved rejection never crashes the process. */
  const ignore = (): void => undefined;
  const waitForBlocked = async (
    tx: any,
    expected: number,
    deadline: number
  ): Promise<number> => {
    for (;;) {
      const blocked = await tx.execute(
        sql`select pid from pg_stat_activity where pg_backend_pid() = any(pg_blocking_pids(pid))`
      );
      const rows = Array.isArray(blocked)
        ? blocked
        : ((blocked as { rows?: unknown[] }).rows ?? []);
      if (rows.length >= expected) return rows.length;
      if (Date.now() >= deadline) return rows.length;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  const tag = crypto.randomUUID();
  const slugA = `hono-${tag}-a`;
  const slugB = `hono-${tag}-b`;
  const password = 'Foundation-password-42!';
  // The legacy `password_hash` stays the Rails-era anchor the session write
  // re-reads; client-stretched auth verifies against the seeded verifier
  // instead (SPEC-V2 §7). Seed both so every seeded account can log in.
  const passwordHash = (await hash(password, 4)).replace('$2b$', '$2a$');
  const stretchedKey = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const wrongKey = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const wrappedKey = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const makeDerivedKey = () =>
    toHex(crypto.getRandomValues(new Uint8Array(32)));
  const stretchedVerifier = await sha256Hex(stretchedKey);
  const stretchedSalt = Buffer.from(
    crypto.getRandomValues(new Uint8Array(16))
  ).toString('base64');
  const serverSecret = toHex(crypto.getRandomValues(new Uint8Array(24)));
  const communityIds: number[] = [];
  const userIds: number[] = [];
  const fileIds: string[] = [];
  let instant = new Date('2026-11-11T12:00:00Z');
  let reads = 0;
  const repository = new HonoFoundationRepository(database);
  // Content-free record of every storage delete the media cleanup performs, so
  // the inline-delete race below can assert that live bytes survive.
  const deletedStorageKeys: string[] = [];
  const options = {
    repository,
    secureCookies: false,
    // The contract presents `x-forwarded-for` to isolate per-IP buckets.
    trustProxy: true,
    serverSecret,
    now: () => instant,
    storage: {
      read: async (_key: string) => {
        reads++;
        const body = new Uint8Array([1, 2, 3]);
        return { body, size: body.byteLength };
      },
      delete: async (key: string) => {
        deletedStorageKeys.push(key);
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
    identifier: string,
    communitySlug?: string,
    previous?: string
  ) => {
    // Successful logins use their own trusted-proxy address so the deliberate
    // failure cases (which share the `unknown` bucket) cannot throttle them.
    const response = await postLogin(
      app,
      {
        identifier,
        derivedKey: stretchedKey,
        ...(communitySlug === undefined ? {} : { communitySlug }),
      },
      {
        'x-forwarded-for': '198.51.100.200',
        ...(previous ? { cookie: previous } : {}),
      }
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
    const credentials = { identifier: viewerEmail, derivedKey: stretchedKey };
    const adminEmail = `admin-${tag}@example.test`;
    const editorEmail = `editor-${tag}@example.test`;
    const systemEmail = `system-${tag}@example.test`;
    const duplicateEmail = `duplicate-${tag}@example.test`;
    const userDefaults = {
      passwordHash,
      passwordAlgorithm: ARGON2ID_ALGORITHM,
      passwordSalt: stretchedSalt,
      passwordParams: ARGON2ID_PARAMS_JSON,
      passwordVerifier: stretchedVerifier,
      firstName: 'Hono',
      lastName: 'Contract',
    };
    for (const [email, role, communityId] of [
      [viewerEmail, 'viewer', communityA],
      [adminEmail, 'admin', communityA],
      [editorEmail, 'editor', communityA],
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
    // A dedicated account for the throttle-backoff case (finding 3), so the
    // failures never block an account another case logs in with.
    const backoffEmail = `backoff-${tag}@example.test`;
    const [backoffUser] = await db
      .insert(tables.users)
      .values({
        ...userDefaults,
        email: backoffEmail,
        role: 'viewer',
        communityId: communityA,
      })
      .returning();
    userIds.push(backoffUser.id);
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
      { identifier: viewerEmail, derivedKey: wrongKey },
      { identifier: `missing-${tag}@example.test`, derivedKey: stretchedKey },
      { identifier: duplicateEmail, derivedKey: stretchedKey },
      {
        identifier: viewerEmail,
        derivedKey: stretchedKey,
        communitySlug: slugB,
      },
      {
        identifier: viewerEmail,
        derivedKey: stretchedKey,
        communitySlug: 'no-such-community',
      },
    ])
      await status(postLogin(app, payload), 401);
    for (const payload of [
      {},
      { identifier: viewerEmail },
      { identifier: viewerEmail, derivedKey: 1 },
      { identifier: 'x'.repeat(255), derivedKey: stretchedKey },
      { identifier: viewerEmail, derivedKey: 'g'.repeat(64) },
      { identifier: viewerEmail, derivedKey: 'a'.repeat(63) },
      {
        identifier: viewerEmail,
        derivedKey: stretchedKey,
        communitySlug: 'slug'.repeat(80),
      },
      {
        identifier: viewerEmail,
        derivedKey: stretchedKey,
        upgrade: { algorithm: ARGON2ID_ALGORITHM },
      },
    ]) {
      await status(postLogin(app, payload), 400);
    }
    await status(postRaw(app, '{'), 400);
    await login(duplicateEmail, slugA);
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
    // #186: the composite (community_id, file_id) tenant FK makes a cross-tenant
    // media binding structurally impossible — the database itself must reject
    // the corrupt binding, and the still-valid same-community binding keeps
    // serving. (The repository-level `files.community_id = media.community_id`
    // guard remains as defense in depth for any pre-migration legacy rows.)
    await assert.rejects(
      bind(communityB),
      undefined,
      'the composite tenant FK must reject a cross-community community_media binding'
    );
    await status(readMedia(replacement), 200);
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
    // #188 round 3: the same-user rotation lookup only reuses an unexpired
    // row. Presenting the now-expired cookie must allocate a fresh row and
    // leave the expired row unrotated rather than resurrecting it by id.
    const staleRows = await db
      .select({ id: sessions.id, tokenHash: sessions.tokenHash })
      .from(sessions)
      .where(eq(sessions.userId, viewerId));
    assert.equal(staleRows.length, 1, 'one row before expired-rotation login');
    const afterBoundary = await login(viewerEmail, undefined, expired);
    const postRotation = await db
      .select({ id: sessions.id, tokenHash: sessions.tokenHash })
      .from(sessions)
      .where(eq(sessions.userId, viewerId));
    assert.equal(
      postRotation.length,
      2,
      'expired presented cookie forces a fresh session row'
    );
    const staleRow = postRotation.find((row) => row.id === staleRows[0].id);
    assert.ok(staleRow, 'expired row is neither deleted nor rotated by id');
    assert.equal(
      staleRow.tokenHash,
      staleRows[0].tokenHash,
      'expired row keeps its old digest'
    );
    await status(me(expired), 401, 'expired cookie stays revoked');
    await status(me(afterBoundary), 200);
    await updateUser(viewerId, { passwordVerifier: 'malformed' });
    await status(
      postLogin(app, {
        identifier: viewerEmail,
        derivedKey: stretchedKey,
      }),
      401
    );
    await updateUser(viewerId, { passwordVerifier: stretchedVerifier });
    // #137: the client-stretched verifier — not the legacy password_hash —
    // is the authentication factor. A tampered/malformed stored verifier
    // fails closed with the uniform 401 (SPEC-V2 §7 "Verifier registry").
    const currentCookie = await login(viewerEmail);
    for (const dependency of ['readiness', 'sessionContext'] as const) {
      const unavailable = new HonoFoundationRepository(database);
      unavailable[dependency] = storageOutage;
      const failing = createHonoApp({ ...options, repository: unavailable });
      const path = dependency === 'readiness' ? '/ready' : '/v2/auth/me';
      await failsClosed(
        send(failing, path, { headers: { cookie: currentCookie } }),
        'private detail'
      );
    }
    // (#137) The pre-slice barrier parked the login request inside the
    // credential check and reset the password mid-flight. Client-stretched
    // logins re-read authority in createSession's INSERT…SELECT (and the
    // wrapped-bcrypt upgrade in a password_hash-guarded UPDATE), so the
    // reset-wins property is pinned by the stale-anchor repository tests in
    // tests/hono/auth-login.test.ts and by the PostgreSQL concurrent-disable
    // case below — not by a black-box timing barrier.
    // #188 round 3: a cross-user login that fails the authority gate must
    // leave the presenting user's session intact — the revoking delete is
    // coupled to the verified session write and never runs when the login
    // itself loses the race. Deterministic form: the failing account is
    // deactivated before the attempt, so its login is rejected and the
    // presenting cookie still authenticates afterwards.
    const heldCookie = await login(viewerEmail);
    await updateUser(userIds[1], { isActive: false });
    await status(
      postLogin(
        app,
        { identifier: adminEmail, derivedKey: stretchedKey },
        { cookie: heldCookie }
      ),
      401,
      'authority-denied cross-user login must not authenticate'
    );
    await updateUser(userIds[1], { isActive: true });
    await status(
      me(heldCookie),
      200,
      'failed cross-user login keeps the presenting user session'
    );
    await status(action('logout', heldCookie), 204);
    // Fault-injection sessions are cleared before the shared-browser count,
    // mirroring the PostgreSQL lock-race block below.
    await db.delete(sessions).where(eq(sessions.userId, viewerId));
    // Shared-browser login (#188 review): user B signing in while user A's
    // valid cookie is present must get B's own fresh session row. A's
    // presented session is revoked, never rotated onto B's login.
    const sharedBrowserA = await login(viewerEmail);
    const viewerRows = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.userId, viewerId));
    assert.equal(
      viewerRows.length,
      1,
      'viewer holds exactly one fresh session row'
    );
    const viewerRow = viewerRows[0];
    const takeover = await postLogin(
      app,
      { identifier: adminEmail, derivedKey: stretchedKey },
      { cookie: sharedBrowserA }
    );
    assert.equal(takeover.status, 200);
    assert.equal((await takeover.json()).user.email, adminEmail);
    const sharedBrowserB = takeover.headers.get('set-cookie')!.split(';')[0];
    assert.notEqual(sharedBrowserB, sharedBrowserA);
    await status(
      me(sharedBrowserA),
      401,
      'previous user cookie revoked on cross-user login'
    );
    const adminIdentity = await me(sharedBrowserB);
    assert.equal(adminIdentity.status, 200);
    assert.equal((await adminIdentity.json()).user.email, adminEmail);
    const rotatedRow = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.id, viewerRow.id));
    assert.equal(
      rotatedRow.length,
      0,
      'previous user session row is deleted, not rotated onto the new user'
    );
    await status(action('logout', sharedBrowserB), 204);

    // Slice 3b (#137): null-community super_admin, disabled-community admin/viewer,
    // legacy elder rejection, ambiguous-email ordering, revocation triggers, and
    // PostgreSQL concurrent community-disable locking on both SQLite and PostgreSQL.
    const [disabledCommunity] = await db
      .insert(tables.communities)
      .values({
        name: 'Hono disabled',
        slug: `hono-${tag}-disabled`,
        isActive: false,
      })
      .returning();
    communityIds.push(disabledCommunity.id);
    const disabledFileId = crypto.randomUUID();
    await db.insert(tables.files).values({
      id: disabledFileId,
      filename: 'disabled-branding.png',
      originalName: 'disabled-branding.png',
      path: `communities/${disabledCommunity.id}/${disabledFileId}`,
      url: 'https://ignored.invalid/disabled',
      mimeType: 'image/png',
      size: 3,
      communityId: disabledCommunity.id,
      uploadedBy: viewerId,
      createdAt: instant,
      updatedAt: instant,
    });
    fileIds.push(disabledFileId);
    await db.insert(media).values({
      fileId: disabledFileId,
      communityId: disabledCommunity.id,
      kind: 'branding',
    });

    const nullSuperEmail = `null-super-${tag}@example.test`;
    const disabledAdminEmail = `disabled-admin-${tag}@example.test`;
    const disabledViewerEmail = `disabled-viewer-${tag}@example.test`;
    const elderEmail = `elder-${tag}@example.test`;
    const slice3bUsers: Record<string, number> = {};
    for (const [email, username, displayName, role, communityId] of [
      [nullSuperEmail, `super_${tag}`, 'Null Super', 'super_admin', null],
      [
        disabledAdminEmail,
        `dadmin_${tag}`,
        'Disabled Admin',
        'admin',
        disabledCommunity.id,
      ],
      [disabledViewerEmail, null, null, 'viewer', disabledCommunity.id],
      [elderEmail, null, null, 'elder', communityA],
    ] as const) {
      const [row] = await db
        .insert(tables.users)
        .values({
          ...userDefaults,
          email,
          username,
          displayName,
          role,
          communityId,
        })
        .returning();
      userIds.push(row.id);
      slice3bUsers[email] = row.id;
    }
    const nullSuperId = slice3bUsers[nullSuperEmail];
    const adminId = userIds[1];

    const nullSuperCookie = await login(nullSuperEmail);
    const nullSuperMe = await me(nullSuperCookie);
    assert.equal(nullSuperMe.status, 200);
    const nullSuperBody = (await nullSuperMe.json()) as {
      user: Record<string, unknown>;
    };
    assert.deepEqual(Object.keys(nullSuperBody.user).sort(), [
      'communityId',
      'displayName',
      'email',
      'id',
      'role',
      'username',
    ]);
    assert.equal(nullSuperBody.user.communityId, null);
    assert.equal(nullSuperBody.user.username, `super_${tag}`);
    assert.equal(nullSuperBody.user.displayName, 'Null Super');
    assert.equal(nullSuperBody.user.role, 'super_admin');
    await status(readMedia(nullSuperCookie, fileIds[0]), 404);
    const rotatedNullSuper = await login(
      nullSuperEmail,
      undefined,
      nullSuperCookie
    );
    await status(me(nullSuperCookie), 401);
    await status(me(rotatedNullSuper), 200);
    await status(action('logout', rotatedNullSuper), 204);

    // Role change and deactivation permanently revoke null-community super_admin sessions.
    for (const [change, restore] of [
      [{ role: 'admin' }, { role: 'super_admin' }],
      [{ isActive: false }, { isActive: true }],
    ]) {
      const superSessionCookie = await login(nullSuperEmail);
      await status(me(superSessionCookie), 200);
      await updateUser(nullSuperId, change);
      await status(me(superSessionCookie), 401);
      if ('isActive' in change) {
        await status(
          postLogin(app, {
            identifier: nullSuperEmail,
            derivedKey: stretchedKey,
          }),
          401
        );
      }
      await updateUser(nullSuperId, restore);
      await status(
        me(superSessionCookie),
        401,
        'restoring super_admin role/status must not revive revoked session'
      );
    }

    const disabledAdminCookie = await login(disabledAdminEmail);
    const disabledAdminMe = await me(disabledAdminCookie);
    assert.equal(disabledAdminMe.status, 200);
    assert.equal(
      (await disabledAdminMe.json()).user.communityId,
      disabledCommunity.id
    );
    await status(readMedia(disabledAdminCookie, disabledFileId), 404);
    await status(readMedia(disabledAdminCookie, fileIds[0]), 404);

    // Disabled-community admin session is revoked on community re-enable and
    // stays revoked on re-disable; an active-community admin's session is
    // revoked immediately when their community is disabled (before re-login).
    await updateCommunity(disabledCommunity.id, { isActive: true });
    await status(
      me(disabledAdminCookie),
      401,
      'disabled-admin session revoked on community re-enable'
    );
    const enabledAdminCookie = await login(disabledAdminEmail);
    await status(me(enabledAdminCookie), 200);
    await updateCommunity(disabledCommunity.id, { isActive: false });
    await status(
      me(disabledAdminCookie),
      401,
      're-disabling must not revive previously revoked disabled-admin session'
    );
    await status(
      me(enabledAdminCookie),
      401,
      'active-community admin session revoked on disable before re-login'
    );
    const reloginDisabledAdminCookie = await login(disabledAdminEmail);
    await status(me(reloginDisabledAdminCookie), 200);
    await status(action('logout', reloginDisabledAdminCookie), 204);

    const activeAdminCookie = await login(adminEmail);
    await status(me(activeAdminCookie), 200);
    await updateCommunity(communityA, { isActive: false });
    await status(
      me(activeAdminCookie),
      401,
      'active community admin cookie returns 401 after community disable'
    );
    const reauthedDisabledAdminCookie = await login(adminEmail);
    await status(me(reauthedDisabledAdminCookie), 200);
    await updateCommunity(communityA, { isActive: true });
    await status(me(activeAdminCookie), 401);
    await status(
      me(reauthedDisabledAdminCookie),
      401,
      'community re-enable revokes disabled-state admin session'
    );
    assert.ok(adminId > 0);

    await status(
      postLogin(app, {
        identifier: disabledViewerEmail,
        derivedKey: stretchedKey,
      }),
      401
    );
    await status(
      postLogin(app, { identifier: elderEmail, derivedKey: stretchedKey }),
      401
    );

    // Ambiguous email (SPEC-V2 §6.2): sharing an email with a disabled-community,
    // inactive, or legacy elder account must remain ambiguous (401 without
    // communityId) regardless of which row is inserted first.
    const ambiguousPairs: ReadonlyArray<
      readonly [string, ReadonlyArray<readonly [string, number, boolean]>]
    > = [
      [
        `ambig-active-first-disabled-${tag}@example.test`,
        [
          ['viewer', communityA, true],
          ['viewer', disabledCommunity.id, true],
        ],
      ],
      [
        `ambig-disabled-first-${tag}@example.test`,
        [
          ['viewer', disabledCommunity.id, true],
          ['viewer', communityA, true],
        ],
      ],
      [
        `ambig-active-first-inactive-${tag}@example.test`,
        [
          ['viewer', communityA, true],
          ['viewer', communityB, false],
        ],
      ],
      [
        `ambig-inactive-first-${tag}@example.test`,
        [
          ['viewer', communityB, false],
          ['viewer', communityA, true],
        ],
      ],
      [
        `ambig-active-first-elder-${tag}@example.test`,
        [
          ['viewer', communityA, true],
          ['elder', communityB, true],
        ],
      ],
      [
        `ambig-elder-first-${tag}@example.test`,
        [
          ['elder', communityB, true],
          ['viewer', communityA, true],
        ],
      ],
    ];
    for (const [sharedEmail, entries] of ambiguousPairs) {
      for (const [role, communityId, isActive] of entries) {
        const [row] = await db
          .insert(tables.users)
          .values({
            ...userDefaults,
            email: sharedEmail,
            role,
            communityId,
            isActive,
          })
          .returning();
        userIds.push(row.id);
      }
      const noLocator = await postLogin(app, {
        identifier: sharedEmail,
        derivedKey: stretchedKey,
      });
      assert.equal(
        noLocator.status,
        401,
        `ambiguous email ${sharedEmail} must return 401 without communityId`
      );
      assert.deepEqual(await noLocator.json(), {
        error: 'Invalid credentials',
      });
      const narrowedCookie = await login(sharedEmail, slugA);
      await status(me(narrowedCookie), 200);
      await status(action('logout', narrowedCookie), 204);
    }

    if (dialectOf(database) === 'postgresql') {
      // PostgreSQL lock race (#137): createSession must lock the communities row
      // (`INNER JOIN communities` + bare `FOR SHARE`) so a concurrent community
      // disable cannot leave a session that survives and revives on re-enable.
      await db.delete(sessions).where(eq(sessions.userId, viewerId));
      const preRaceCookie = await login(viewerEmail);
      let pendingRaceLogin!: Promise<Response>;
      await db.transaction(async (tx: any) => {
        await tx
          .update(tables.communities)
          .set({ isActive: false })
          .where(eq(tables.communities.id, communityA));
        pendingRaceLogin = postLogin(app, credentials, {
          'x-forwarded-for': '198.51.100.220',
        });
        void pendingRaceLogin.then(ignore, ignore);
        const blocked = await waitForBlocked(tx, 1, Date.now() + 4000);
        if (blocked < 1)
          throw new Error(
            'community-disable race never materialised: the login never blocked behind the disable'
          );
      });
      const raceResponse = await pendingRaceLogin;
      const raceCookie = raceResponse.headers.get('set-cookie')?.split(';')[0];
      assert.equal(
        raceResponse.status,
        401,
        'concurrent community disable must block and reject viewer login'
      );
      assert.equal(raceCookie, undefined);
      const remainingRows = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.userId, viewerId));
      assert.equal(
        remainingRows.length,
        0,
        'no session row may remain after concurrent community disable'
      );
      await updateCommunity(communityA, { isActive: true });
      await status(
        me(preRaceCookie),
        401,
        'pre-race cookie must stay rejected after re-enable'
      );
      if (raceCookie) {
        await status(
          me(raceCookie),
          401,
          'raced login cookie must be rejected after re-enable'
        );
      }
      const postReenableRows = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.userId, viewerId));
      assert.equal(
        postReenableRows.length,
        0,
        'no session row may revive after re-enable'
      );
    }

    // Slice 7 audit existence & content-freedom contract on both SQLite and PostgreSQL (#145)
    const slice7AdminCookie = await login(adminEmail);
    const patchCommunity = (
      body: unknown,
      extraHeaders: Record<string, string> = {}
    ) =>
      send(app, '/v2/community', {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          cookie: slice7AdminCookie,
          ...extraHeaders,
        },
        body: JSON.stringify(body),
      });
    await status(
      patchCommunity({ name: 'Hono Sensitive Name', visibility: 'public' }),
      200
    );
    await status(patchCommunity({ visibility: 'public' }), 200);
    await status(patchCommunity({ visibility: 'private' }), 200);

    const communityAudits = await db
      .select()
      .from(tables.auditEntries)
      .where(
        and(
          eq(tables.auditEntries.communityId, communityA),
          like(tables.auditEntries.action, 'community.%'),
          eq(tables.auditEntries.resourceType, 'community')
        )
      )
      .orderBy(asc(tables.auditEntries.id));
    assert.deepEqual(
      communityAudits.map((row: any) => row.action),
      ['community.visibility.public', 'community.visibility.private'],
      'effective visibility transitions must emit content-free audit rows without no-op duplicates'
    );
    for (const row of communityAudits) {
      const validated = validateContentFreeAuditEntry({
        communityId: row.communityId,
        actorId: row.actorId,
        action: row.action,
        resourceType: row.resourceType,
        resourceIds: row.resourceIds,
        outcome: row.outcome,
        ipAddress: row.ipAddress,
        userAgent: row.userAgent,
      });
      assert.equal(validated.communityId, communityA);
      assert.equal(validated.actorId, adminId);
      assert.equal(validated.resourceType, 'community');
      assert.deepEqual(validated.resourceIds, [communityA]);
      assert.equal(validated.outcome, 'success');
      assert.equal(validated.ipAddress, null);
      assert.equal(validated.userAgent, null);
      const serialized = JSON.stringify(row);
      assert.ok(!serialized.includes('Hono Sensitive Name'));
      assert.ok(!serialized.includes(adminEmail));
    }

    if (dialectOf(database) === 'postgresql') {
      // PostgreSQL SELECT ... FOR UPDATE race (#145): concurrent toggle waiting
      // on a committed visibility flip must observe the updated visibility and
      // emit zero duplicate audit entries.
      let pendingToggle!: Promise<Response>;
      await db.transaction(async (tx: any) => {
        await tx
          .update(tables.communities)
          .set({ publicStories: true })
          .where(eq(tables.communities.id, communityA));
        pendingToggle = patchCommunity(
          { visibility: 'public' },
          { 'x-forwarded-for': '198.51.100.221' }
        );
        void pendingToggle.then(ignore, ignore);
        const blocked = await waitForBlocked(tx, 1, Date.now() + 4000);
        if (blocked < 1)
          throw new Error(
            'community-toggle race never materialised: the toggle never blocked behind the flip'
          );
      });
      assert.equal((await pendingToggle).status, 200);
      const auditsAfterLock = await db
        .select()
        .from(tables.auditEntries)
        .where(
          and(
            eq(tables.auditEntries.communityId, communityA),
            like(tables.auditEntries.action, 'community.%'),
            eq(tables.auditEntries.resourceType, 'community')
          )
        )
        .orderBy(asc(tables.auditEntries.id));
      assert.equal(
        auditsAfterLock.length,
        2,
        'concurrent public toggle blocked behind FOR UPDATE must not emit duplicate audit'
      );

      // Two simultaneous private toggles: only the first effective change emits an audit
      const [t1, t2] = await Promise.all([
        patchCommunity({ visibility: 'private' }),
        patchCommunity({ visibility: 'private' }),
      ]);
      assert.equal(t1.status, 200);
      assert.equal(t2.status, 200);
      const auditsAfterBurst = await db
        .select()
        .from(tables.auditEntries)
        .where(
          and(
            eq(tables.auditEntries.communityId, communityA),
            like(tables.auditEntries.action, 'community.%'),
            eq(tables.auditEntries.resourceType, 'community')
          )
        )
        .orderBy(asc(tables.auditEntries.id));
      assert.deepEqual(
        auditsAfterBurst.map((row: any) => row.action),
        [
          'community.visibility.public',
          'community.visibility.private',
          'community.visibility.private',
        ]
      );

      // PostgreSQL concurrent story_places insert vs DELETE /v2/places/:id race:
      // must block behind the uncommitted FK lock, then return 409 without
      // cascading the link or deleting attachments.
      const [racePlace] = await db
        .insert(tables.places)
        .values({ communityId: communityA, name: 'PG Race Place' })
        .returning();
      const [raceStory] = await db
        .insert(tables.stories)
        .values({
          communityId: communityA,
          title: 'PG Race Story',
          slug: `pg-race-${tag}`,
          language: 'en',
          privacyLevel: 'editors',
          isRestricted: false,
        })
        .returning();
      const [raceAttachment] = await db
        .insert(tables.attachments)
        .values({
          communityId: communityA,
          fileId: fileIds[0],
          ownerType: 'place',
          ownerId: racePlace.id,
          role: 'place_photo',
          ordinal: 0,
          createdAt: instant,
        })
        .returning();

      let pendingDelete!: Promise<Response>;
      await db.transaction(async (tx: any) => {
        await tx.insert(tables.storyPlaces).values({
          communityId: communityA,
          storyId: raceStory.id,
          placeId: racePlace.id,
          sortOrder: 0,
        });
        pendingDelete = send(app, `/v2/places/${racePlace.id}`, {
          method: 'DELETE',
          headers: {
            cookie: slice7AdminCookie,
            'x-forwarded-for': '198.51.100.222',
          },
        });
        void pendingDelete.then(ignore, ignore);
        const blocked = await waitForBlocked(tx, 1, Date.now() + 4000);
        if (blocked < 1)
          throw new Error(
            'story_places race never materialised: the places delete never blocked behind the insert'
          );
      });
      assert.equal(
        (await pendingDelete).status,
        409,
        'concurrent story_places insert must cause DELETE /v2/places to return 409'
      );
      assert.equal(
        (
          await db
            .select()
            .from(tables.storyPlaces)
            .where(eq(tables.storyPlaces.placeId, racePlace.id))
        ).length,
        1
      );
      assert.equal(
        (
          await db
            .select()
            .from(tables.attachments)
            .where(eq(tables.attachments.id, raceAttachment.id))
        ).length,
        1
      );

      // Slice 10 (#137): concurrent failed logins on one account must not
      // lose a counter update. `recordLoginFailure` writes the per-account and
      // per-IP rows in one transaction; two simultaneous attempts must both
      // land, and the counter must equal the attempt count (no lost update).
      const authThrottle = tables.authThrottle;
      const accountKey = await new HonoAuthRepository(
        database as Database
      ).accountThrottleKey(viewerId, serverSecret);
      const ipKey = await new HonoAuthRepository(
        database as Database
      ).ipThrottleKey('203.0.113.250', serverSecret);
      await db
        .delete(authThrottle)
        .where(inArray(authThrottle.key, [accountKey, ipKey]));
      // The per-IP key is derived from the client IP header, so the burst must
      // present the same address the assertion below hashes (SPEC-V2 §6.8:
      // the per-IP counter is keyed on the client IP alone).
      const burst = await Promise.all(
        [0, 1, 2, 3].map(() =>
          postLogin(
            app,
            { identifier: viewerEmail, derivedKey: wrongKey },
            { 'x-forwarded-for': '203.0.113.250' }
          )
        )
      );
      assert.ok(
        burst.every((response) => response.status === 401),
        'every concurrent wrong-key attempt must answer the uniform 401'
      );
      const throttleRows = await db
        .select()
        .from(authThrottle)
        .where(eq(authThrottle.key, accountKey));
      assert.equal(
        throttleRows.length,
        1,
        'concurrent failures must update one per-account row, not fork it'
      );
      assert.equal(
        throttleRows[0].failures,
        4,
        'concurrent failed logins must not lose a counter update'
      );
      const ipRows = await db
        .select()
        .from(authThrottle)
        .where(eq(authThrottle.key, ipKey));
      assert.equal(ipRows[0].failures, 4);

      // Slice 10 (finding 3): the backoff branch must actually execute on
      // every backend. `AUTH_THROTTLE_MAX_FAILURES` failures block the account
      // for exactly `now + authThrottleBackoffMs(...)`, and the next attempt
      // with the *correct* key is still the uniform 401. On PostgreSQL this is
      // also what exercises the `bigint` cast on `blocked_until`: an inferred
      // int4 parameter would overflow on a millisecond value (22003), so a
      // green assertion here is the evidence the last commit's fix works.
      const throttleNow = new Date('2026-11-11T15:00:00Z');
      const previousInstant = instant;
      instant = throttleNow;
      const authRepository = new HonoAuthRepository(database as Database);
      const backoffAccountKey = await authRepository.accountThrottleKey(
        backoffUser.id,
        serverSecret
      );
      const unknownIp = '198.51.100.77';
      const unknownIpKey = await authRepository.ipThrottleKey(
        unknownIp,
        serverSecret
      );
      // The account failures use one address and the correct-key attempt a
      // different one, so only the per-account brake can reject it.
      const accountIp = '198.51.100.10';
      const freshIp = '198.51.100.11';
      const accountIpKey = await authRepository.ipThrottleKey(
        accountIp,
        serverSecret
      );
      await db
        .delete(authThrottle)
        .where(
          inArray(authThrottle.key, [
            backoffAccountKey,
            unknownIpKey,
            accountIpKey,
          ])
        );
      for (
        let attempt = 0;
        attempt < AUTH_THROTTLE_MAX_FAILURES;
        attempt += 1
      ) {
        await status(
          postLogin(
            app,
            { identifier: backoffEmail, derivedKey: wrongKey },
            { 'x-forwarded-for': accountIp }
          ),
          401,
          'a failed login must answer the uniform 401'
        );
      }
      const backoffState = await authRepository.throttleState(
        backoffAccountKey,
        throttleNow.getTime()
      );
      assert.equal(backoffState.failures, AUTH_THROTTLE_MAX_FAILURES);
      assert.equal(backoffState.blocked, true);
      assert.equal(
        backoffState.blockedUntil,
        throttleNow.getTime() +
          authThrottleBackoffMs(AUTH_THROTTLE_MAX_FAILURES),
        'blocked_until must be now + the policy backoff'
      );
      await status(
        postLogin(
          app,
          { identifier: backoffEmail, derivedKey: stretchedKey },
          { 'x-forwarded-for': freshIp }
        ),
        401,
        'the correct key must still be refused while the account is blocked'
      );
      // The same backoff on the per-IP counter, driven only by unresolved
      // identifiers (finding 2: the per-IP brake must bound guessing).
      for (
        let attempt = 0;
        attempt < AUTH_THROTTLE_MAX_FAILURES;
        attempt += 1
      ) {
        await status(
          postLogin(
            app,
            {
              identifier: `nobody-${tag}-${attempt}@example.test`,
              derivedKey: wrongKey,
            },
            { 'x-forwarded-for': unknownIp }
          ),
          401,
          'an unknown identifier must answer the uniform 401'
        );
      }
      const unknownIpState = await authRepository.throttleState(
        unknownIpKey,
        throttleNow.getTime()
      );
      assert.equal(unknownIpState.failures, AUTH_THROTTLE_MAX_FAILURES);
      assert.equal(
        unknownIpState.blockedUntil,
        throttleNow.getTime() +
          authThrottleBackoffMs(AUTH_THROTTLE_MAX_FAILURES),
        'the per-IP backoff must be enforced on unresolved attempts'
      );
      await status(
        postLogin(
          app,
          { identifier: backoffEmail, derivedKey: stretchedKey },
          { 'x-forwarded-for': unknownIp }
        ),
        401,
        'a blocked address must not authenticate even with the correct key'
      );
      await db
        .delete(authThrottle)
        .where(
          inArray(authThrottle.key, [
            backoffAccountKey,
            unknownIpKey,
            accountIpKey,
          ])
        );
      instant = previousInstant;

      // Slice 10: a wrapped-bcrypt upgrade is atomic — verifier, salt, params
      // and algorithm land together, guarded by the re-read `password_hash`.
      // A concurrent verifier change between the read and the write makes the
      // login fail closed with the row unchanged.
      const [wrappedAccount] = await db
        .insert(tables.users)
        .values({
          ...userDefaults,
          email: `wrapped-pg-${tag}@example.test`,
          username: `wrapped_pg_${tag}`,
          role: 'member',
          communityId: communityA,
          passwordAlgorithm: 'client-bcrypt-rails+sha256',
          passwordSalt: 'c2FsdA==',
          passwordParams: JSON.stringify({ cost: 12 }),
          passwordVerifier: await sha256Hex(wrappedKey),
        })
        .returning();
      userIds.push(wrappedAccount.id);
      // Slice 10 (#137): a login and a password change issued while a
      // concurrent reset holds the users row must both resolve to the
      // authority gate — the login to the uniform 401, the password change to
      // 409 — never a 5xx. The reset's uncommitted row is invisible to the
      // readers; only the coupled writes can see it, through the lock.
      const coupledEmail = `coupled-pg-${tag}@example.test`;
      const loginCoupledEmail = `coupled-pg-login-${tag}@example.test`;
      const [coupledAccount] = await db
        .insert(tables.users)
        .values({
          ...userDefaults,
          email: coupledEmail,
          username: `coupled_pg_${tag}`,
          role: 'viewer',
          communityId: communityA,
        })
        .returning();
      const [loginCoupledAccount] = await db
        .insert(tables.users)
        .values({
          ...userDefaults,
          email: loginCoupledEmail,
          username: `coupled_pg_login_${tag}`,
          role: 'viewer',
          communityId: communityA,
        })
        .returning();
      userIds.push(coupledAccount.id, loginCoupledAccount.id);
      const coupledCookie = await login(coupledEmail);
      const newSalt = Buffer.from(
        crypto.getRandomValues(new Uint8Array(16))
      ).toString('base64');
      // Case A — the password change loses the coupled write (409). The
      // reset's uncommitted row is invisible to the readers; the change's
      // coupled verifier update then blocks behind our row lock, and once
      // the reset commits it matches zero rows and rolls back — 401 at the
      // session gate or 5xx would not prove that, 409 proves the write was
      // the losing side.
      let pendingChange!: Promise<Response>;
      await db.transaction(async (tx: any) => {
        await tx
          .update(tables.users)
          .set({ passwordVerifier: 'reset-during-coupled-write' })
          .where(eq(tables.users.id, coupledAccount.id));
        pendingChange = send(app, '/v2/auth/password', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            cookie: coupledCookie,
            'x-forwarded-for': '198.51.100.211',
          },
          body: JSON.stringify({
            currentDerivedKey: stretchedKey,
            algorithm: ARGON2ID_ALGORITHM,
            salt: newSalt,
            params: { memoryKiB: 19 * 1024, iterations: 2, parallelism: 1 },
            derivedKey: toHex(crypto.getRandomValues(new Uint8Array(32))),
          }),
        });
        pendingChange.then(ignore, ignore);
        const observed = await waitForBlocked(tx, 1, Date.now() + 4000);
        if (observed < 1)
          throw new Error(
            'coupled-write race never materialised: the password change never blocked behind the reset'
          );
      });
      // Case B — a login racing the same reset loses the authority gate and
      // answers the uniform 401 without a session. Its authority-gated
      // INSERT ... SELECT FOR SHARE blocks behind our row lock; once the
      // reset commits it matches zero rows, so no session can be written.
      let pendingLogin!: Promise<Response>;
      await db.transaction(async (tx: any) => {
        await tx
          .update(tables.users)
          .set({ passwordVerifier: 'reset-during-coupled-write' })
          .where(eq(tables.users.id, loginCoupledAccount.id));
        pendingLogin = postLogin(
          app,
          { identifier: loginCoupledEmail, derivedKey: stretchedKey },
          { 'x-forwarded-for': '198.51.100.210' }
        );
        pendingLogin.then(ignore, ignore);
        const observed = await waitForBlocked(tx, 1, Date.now() + 4000);
        if (observed < 1)
          throw new Error(
            'reset race never materialised: the login never blocked behind the reset'
          );
      });
      const [changeResponse, loginResponse] = await Promise.all([
        pendingChange,
        pendingLogin,
      ]);
      assert.equal(
        loginResponse.status,
        401,
        'a login racing a coupled password change must answer the uniform 401, never a 5xx'
      );
      assert.equal(
        loginResponse.headers.get('set-cookie'),
        null,
        'the raced login must not issue a session cookie'
      );
      // The requests were observed blocked behind the reset, which then
      // committed — so the change loses the coupled write (409, not a 401 at
      // the session gate and not a 5xx) and the login loses the authority
      // gate (401, never a session cookie).
      assert.equal(
        changeResponse.status,
        409,
        `a password change racing a coupled password change must lose the coupled write and answer 409 (got ${changeResponse.status})`
      );
      const coupledAfter = await db
        .select()
        .from(tables.users)
        .where(eq(tables.users.id, coupledAccount.id));
      assert.equal(
        coupledAfter[0]!.passwordVerifier,
        'reset-during-coupled-write',
        'the concurrent reset must hold the verifier write'
      );
      const coupledSessions = await db
        .select({
          id: sessions.id,
          userId: sessions.userId,
          revokedAt: sessions.revokedAt,
          createdAt: sessions.createdAt,
        })
        .from(sessions)
        .where(
          inArray(sessions.userId, [coupledAccount.id, loginCoupledAccount.id])
        );
      // The concurrent verifier change revokes every earlier session, so after
      // a lost coupled write no live (unrevoked) session may exist: neither a
      // newly minted one nor a rotated copy of the presented one. Same for the
      // login account: its reset revokes the earlier sessions and the losing
      // login must not mint or rotate one.
      assert.equal(
        coupledSessions.filter(
          (row: { revokedAt: unknown }) => row.revokedAt == null
        ).length,
        0,
        'a lost coupled write must not mint or rotate a session'
      );
      // Slice 10 (#137): a password change racing a community deactivation
      // must never 5xx and must end consistent on both orderings of the
      // community row. The coupled password write takes the community lock
      // (FOR SHARE) before its verifier write and its session revoke; the
      // disable takes the same row (FOR UPDATE) first behind this open
      // transaction. Both paths order community → users → sessions, so PG
      // never aborts either side with a deadlock. The committed deactivation
      // wins: the coupled authority gate matches zero rows when it finally
      // runs, rolling the pair back and answering 409.
      if (dialectOf(database) === 'postgresql') {
        const deactivationEmail = `deactivation-pg-${tag}@example.test`;
        const [deactivationAccount] = await db
          .insert(tables.users)
          .values({
            ...userDefaults,
            email: deactivationEmail,
            username: `deactivation_pg_${tag}`,
            role: 'viewer',
            communityId: communityA,
          })
          .returning();
        userIds.push(deactivationAccount.id);
        const deactivationCookie = await login(deactivationEmail);
        const deactivationSalt = Buffer.from(
          crypto.getRandomValues(new Uint8Array(16))
        ).toString('base64');
        let pendingDeactivationChange!: Promise<Response>;
        await db.transaction(async (tx: any) => {
          await tx
            .update(tables.communities)
            .set({ isActive: false })
            .where(eq(tables.communities.id, communityA));
          pendingDeactivationChange = send(app, '/v2/auth/password', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              cookie: deactivationCookie,
              'x-forwarded-for': '198.51.100.212',
            },
            body: JSON.stringify({
              currentDerivedKey: stretchedKey,
              algorithm: ARGON2ID_ALGORITHM,
              salt: deactivationSalt,
              params: { memoryKiB: 19 * 1024, iterations: 2, parallelism: 1 },
              derivedKey: toHex(crypto.getRandomValues(new Uint8Array(32))),
            }),
          });
          pendingDeactivationChange.then(ignore, ignore);
          const observed = await waitForBlocked(tx, 1, Date.now() + 4000);
          if (observed < 1)
            throw new Error(
              'deactivation race never materialised: the password change never blocked behind the disable'
            );
        });
        const deactivationResponse = await pendingDeactivationChange;
        assert.equal(
          deactivationResponse.status,
          409,
          `a password change racing a community deactivation must lose the authority gate and answer 409, never a 5xx (got ${deactivationResponse.status})`
        );
        // The disable's committed authority revokes every session of the
        // account; the losing coupled write must not mint one either.
        const deactivationRows = await db
          .select({ id: sessions.id })
          .from(sessions)
          .where(eq(sessions.userId, deactivationAccount.id));
        assert.equal(
          deactivationRows.length,
          0,
          'a deactivation that wins the race must revoke every session and the coupled write must not mint one'
        );
        const deactivationPassword = await db
          .select({ passwordVerifier: tables.users.passwordVerifier })
          .from(tables.users)
          .where(eq(tables.users.id, deactivationAccount.id));
        assert.equal(
          deactivationPassword[0]!.passwordVerifier,
          stretchedVerifier,
          'the losing coupled write must roll back, leaving the stored verifier unchanged'
        );
        await updateCommunity(communityA, { isActive: true });
        await status(
          me(deactivationCookie),
          401,
          'the pre-race cookie must stay rejected after re-enable'
        );
      }
      const [wrappedBefore] = await db
        .select()
        .from(tables.users)
        .where(eq(tables.users.id, wrappedAccount.id));
      const upgradeSalt = Buffer.from(
        crypto.getRandomValues(new Uint8Array(16))
      ).toString('base64');
      let pendingUpgrade!: Promise<Response>;
      await db.transaction(async (tx: any) => {
        // The reset takes the row lock first, as in every other race case:
        // only then is the upgrade's coupled verifier write guaranteed to
        // block behind it (otherwise the upgrade may legally win).
        await tx
          .update(tables.users)
          .set({ passwordVerifier: 'reset-during-upgrade' })
          .where(eq(tables.users.id, wrappedAccount.id));
        pendingUpgrade = postLogin(
          app,
          {
            identifier: `wrapped-pg-${tag}@example.test`,
            derivedKey: wrappedKey,
            upgrade: {
              algorithm: 'client-argon2id+sha256',
              // A 16-byte base64 salt: anything less fails the verifier-salt
              // policy before any write, so the coupled verifier update would
              // never be reached and no race could ever form.
              salt: upgradeSalt,
              params: { memoryKiB: 19 * 1024, iterations: 2, parallelism: 1 },
              derivedKey: toHex(crypto.getRandomValues(new Uint8Array(32))),
            },
          },
          { 'x-forwarded-for': '198.51.100.212' }
        );
        void pendingUpgrade.then(ignore, ignore);
        // The verifier write is blocked behind the UPDATE lock while the
        // uncommitted reset changes the authority row.
        const blocked = await waitForBlocked(tx, 1, Date.now() + 4000);
        if (blocked < 1)
          throw new Error(
            'wrapped-upgrade race never materialised: the login never blocked behind the reset'
          );
      });
      const upgradeResponse = await pendingUpgrade;
      assert.equal(
        upgradeResponse.status,
        401,
        'a concurrent reset must win the upgrade race'
      );
      const [wrappedAfter] = await db
        .select()
        .from(tables.users)
        .where(eq(tables.users.id, wrappedAccount.id));
      assert.equal(
        wrappedAfter.passwordVerifier,
        'reset-during-upgrade',
        'a rejected upgrade must leave the verifier row unchanged'
      );
      void wrappedBefore;
      // PostgreSQL SELECT ... FOR UPDATE race (PR #246): concurrent story
      // visibility toggle waiting behind an uncommitted visibility change must
      // observe the committed visibility and emit zero duplicate audit entries.
      const patchRaceStory = (body: unknown) =>
        send(app, `/v2/stories/${raceStory.id}`, {
          method: 'PATCH',
          headers: {
            'content-type': 'application/json',
            cookie: slice7AdminCookie,
          },
          body: JSON.stringify(body),
        });
      let storyToggleDone = false;
      let pendingStoryToggle!: Promise<Response>;
      await db.transaction(async (tx: any) => {
        await tx
          .update(tables.stories)
          .set({ privacyLevel: 'public' })
          .where(eq(tables.stories.id, raceStory.id));
        pendingStoryToggle = patchRaceStory({ visibility: 'public' });
        void pendingStoryToggle.finally(() => {
          storyToggleDone = true;
        });
        const deadline = Date.now() + 2000;
        while (!storyToggleDone && Date.now() < deadline) {
          const blocked = await tx.execute(
            sql`select 1 from pg_stat_activity where pg_backend_pid() = any(pg_blocking_pids(pid)) limit 1`
          );
          const blockedRows = Array.isArray(blocked) ? blocked : blocked.rows;
          if (blockedRows.length > 0) break;
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      });
      assert.equal((await pendingStoryToggle).status, 200);
      const storyAuditsAfterLock = await db
        .select()
        .from(tables.auditEntries)
        .where(
          and(
            eq(tables.auditEntries.communityId, communityA),
            eq(tables.auditEntries.resourceType, 'story')
          )
        )
        .orderBy(asc(tables.auditEntries.id));
      assert.equal(
        storyAuditsAfterLock.length,
        0,
        'concurrent public story toggle blocked behind committed public transition must not emit duplicate audit'
      );

      const [st1, st2] = await Promise.all([
        patchRaceStory({ visibility: 'community' }),
        patchRaceStory({ visibility: 'community' }),
      ]);
      assert.equal(st1.status, 200);
      assert.equal(st2.status, 200);
      const storyAuditsAfterBurst = await db
        .select()
        .from(tables.auditEntries)
        .where(
          and(
            eq(tables.auditEntries.communityId, communityA),
            eq(tables.auditEntries.resourceType, 'story')
          )
        )
        .orderBy(asc(tables.auditEntries.id));
      assert.deepEqual(
        storyAuditsAfterBurst.map((row: any) => row.action),
        ['story.visibility.community']
      );

      // PostgreSQL FOR SHARE target lock race (PR #246): concurrent story
      // creation referencing a place that is being restricted in another
      // transaction must wait and fail closed with 400 invalid_reference.
      const [restrictRacePlace] = await db
        .insert(tables.places)
        .values({ communityId: communityA, name: 'PG Lock Share Place' })
        .returning();
      let createStoryDone = false;
      let pendingStoryCreate!: Promise<Response>;
      await db.transaction(async (tx: any) => {
        await tx
          .update(tables.places)
          .set({ isRestricted: true })
          .where(eq(tables.places.id, restrictRacePlace.id));
        pendingStoryCreate = send(app, '/v2/stories', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            cookie: slice7AdminCookie,
          },
          body: JSON.stringify({
            title: 'Blocked Target Story',
            placeIds: [restrictRacePlace.id],
          }),
        });
        void pendingStoryCreate.finally(() => {
          createStoryDone = true;
        });
        const deadline = Date.now() + 2000;
        while (!createStoryDone && Date.now() < deadline) {
          const blocked = await tx.execute(
            sql`select 1 from pg_stat_activity where pg_backend_pid() = any(pg_blocking_pids(pid)) limit 1`
          );
          const blockedRows = Array.isArray(blocked) ? blocked : blocked.rows;
          if (blockedRows.length > 0) break;
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      });
      assert.equal(
        (await pendingStoryCreate).status,
        400,
        'POST /v2/stories waiting behind FOR SHARE on a newly restricted place must reject with 400'
      );

      // PostgreSQL inline unreferenced-file delete vs concurrent attach (#140):
      // an attach that commits after the detach began must keep the files row
      // and its bytes; the detach may never cascade the new relation away.
      // The delete path takes FOR UPDATE on the candidate files row before
      // its guarded DELETE, which conflicts with the FOR KEY SHARE the attach
      // takes, so the two serialize.
      const waitForLockWaiter = async (tx: any, waitMs = 3000) => {
        const deadline = Date.now() + waitMs;
        while (Date.now() < deadline) {
          const blocked = await tx.execute(
            sql`select 1 from pg_stat_activity where pid <> pg_backend_pid() and wait_event_type = 'Lock' limit 1`
          );
          const blockedRows = Array.isArray(blocked) ? blocked : blocked.rows;
          if (blockedRows.length > 0) return;
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      };
      const [raceFile] = await db
        .select()
        .from(tables.files)
        .where(eq(tables.files.id, fileIds[2]));
      const raceFileKey = String(raceFile.storageKey ?? raceFile.path);
      const [detachOwner] = await db
        .insert(tables.places)
        .values({ communityId: communityA, name: 'PG File Detach Place' })
        .returning();
      const [attachOwner] = await db
        .insert(tables.places)
        .values({ communityId: communityA, name: 'PG File Attach Place' })
        .returning();
      const [detachAttachment] = await db
        .insert(tables.attachments)
        .values({
          communityId: communityA,
          fileId: fileIds[2],
          ownerType: 'place',
          ownerId: detachOwner.id,
          role: 'place_photo',
          ordinal: 0,
          createdAt: instant,
        })
        .returning();

      let fileDetachDone = false;
      let pendingFileDetach!: Promise<Response>;
      await db.transaction(async (tx: any) => {
        // Session B: an attach that has inserted its relation but not
        // committed, exactly as POST /v2/attachments leaves the row before
        // COMMIT.
        await tx.insert(tables.attachments).values({
          communityId: communityA,
          fileId: fileIds[2],
          ownerType: 'place',
          ownerId: attachOwner.id,
          role: 'place_photo',
          ordinal: 0,
          createdAt: instant,
        });
        pendingFileDetach = send(
          app,
          `/v2/attachments/${detachAttachment.id}`,
          {
            method: 'DELETE',
            headers: { cookie: slice7AdminCookie },
          }
        );
        void pendingFileDetach.finally(() => {
          fileDetachDone = true;
        });
        await waitForLockWaiter(tx);
      });
      assert.equal(
        fileDetachDone,
        false,
        'DELETE /v2/attachments must still be waiting while the racing attach holds its row lock'
      );
      assert.equal(
        (await pendingFileDetach).status,
        204,
        'DELETE /v2/attachments must complete once the racing attach commits'
      );
      assert.equal(
        (
          await db
            .select({ id: tables.files.id })
            .from(tables.files)
            .where(eq(tables.files.id, fileIds[2]))
        ).length,
        1,
        'the files row must survive because the racing attach committed first'
      );
      const survivingAttachments = await db
        .select()
        .from(tables.attachments)
        .where(eq(tables.attachments.fileId, fileIds[2]));
      assert.equal(
        survivingAttachments.length,
        1,
        'exactly the racing attach may remain; the detach may not cascade it'
      );
      assert.equal(survivingAttachments[0].ownerId, attachOwner.id);
      assert.ok(
        !deletedStorageKeys.includes(raceFileKey),
        'the bytes of a still-referenced file must never be deleted'
      );

      // Mirror order: an uncommitted file delete must make POST
      // /v2/attachments fail closed instead of inserting a relation that the
      // delete then cascades away.
      const vanishFileId = crypto.randomUUID();
      await db.insert(tables.files).values({
        id: vanishFileId,
        filename: 'vanish.png',
        originalName: 'vanish.png',
        path: `communities/${communityA}/${vanishFileId}`,
        url: `https://ignored.invalid/${vanishFileId}`,
        mimeType: 'image/png',
        size: 3,
        communityId: communityA,
        uploadedBy: null,
        createdAt: instant,
        updatedAt: instant,
      });
      fileIds.push(vanishFileId);
      const [attachOwnerAlone] = await db
        .insert(tables.places)
        .values({ communityId: communityA, name: 'PG File Vanish Place' })
        .returning();
      let attachDone = false;
      let pendingAttach!: Promise<Response>;
      await db.transaction(async (tx: any) => {
        await tx.delete(tables.files).where(eq(tables.files.id, vanishFileId));
        pendingAttach = send(app, '/v2/attachments', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            cookie: slice7AdminCookie,
          },
          body: JSON.stringify({
            fileId: vanishFileId,
            ownerType: 'place',
            ownerId: attachOwnerAlone.id,
            role: 'place_photo',
          }),
        });
        void pendingAttach.finally(() => {
          attachDone = true;
        });
        await waitForLockWaiter(tx);
      });
      assert.equal(
        attachDone,
        false,
        'POST /v2/attachments must still be waiting behind the uncommitted file delete'
      );
      assert.equal(
        (await pendingAttach).status,
        404,
        'POST /v2/attachments must fail closed with 404 once the file row is gone'
      );
      assert.equal(
        (
          await db
            .select()
            .from(tables.attachments)
            .where(eq(tables.attachments.fileId, vanishFileId))
        ).length,
        0,
        'a 404 attach must leave no relation behind'
      );

      // Cross-attach deadlock (#140): two attachments of the same file to
      // each other's owner must pass through the canonical-ordered owner
      // locks in an identical order, so neither can hold one owner while
      // waiting on the other's — the previous target-then-source ordering
      // could deadlock the pair (40P01 -> 500).
      const [crossStory] = await db
        .insert(tables.stories)
        .values({
          communityId: communityA,
          title: 'Cross Attach Story',
          slug: `cross-attach-story-${tag}`,
          language: 'en',
          privacyLevel: 'editors',
          isRestricted: false,
        })
        .returning();
      const [crossPlace] = await db
        .insert(tables.places)
        .values({ communityId: communityA, name: 'Cross Attach Place' })
        .returning();
      await db.insert(tables.attachments).values([
        {
          communityId: communityA,
          fileId: fileIds[0],
          ownerType: 'story',
          ownerId: crossStory.id,
          role: 'story_media',
          ordinal: 0,
          createdAt: instant,
        },
        {
          communityId: communityA,
          fileId: fileIds[0],
          ownerType: 'place',
          ownerId: crossPlace.id,
          role: 'place_photo',
          ordinal: 0,
          createdAt: instant,
        },
      ]);
      const crossAttach = (
        ownerType: 'story' | 'place',
        ownerId: number,
        role: 'story_media' | 'place_photo'
      ) =>
        send(app, '/v2/attachments', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            cookie: slice7AdminCookie,
          },
          body: JSON.stringify({
            fileId: fileIds[0],
            ownerType,
            ownerId,
            role,
          }),
        });
      // Fire both sides of the triangle at once: under the canonical owner
      // order the loser waits for the winner and then completes. Bounded by
      // a deadline so a regression fails fast instead of hanging the gate.
      const [placeSide, storySide] = await Promise.all([
        withDeadline(
          crossAttach('place', crossPlace.id, 'place_photo'),
          10_000,
          'cross-attach place-target'
        ),
        withDeadline(
          crossAttach('story', crossStory.id, 'story_media'),
          10_000,
          'cross-attach story-target'
        ),
      ]);
      for (const [label, response] of [
        ['place-target', placeSide],
        ['story-target', storySide],
      ] as const) {
        assert.equal(
          response.status,
          201,
          `cross-attach ${label} must succeed (${await response.text()})`
        );
      }

      // Interposed relation between the pre-lock read and the files lock
      // (#140): an attach blocked on the files FOR UPDATE but already
      // holding its owner locks must not acquire an owner lock after the
      // file lock when its post-lock re-check sees a relation commit in
      // between. Taking that lock after files could deadlock against a
      // concurrent attach that holds the new owner and waits on the file
      // (40P01 -> 500).
      const interposedFileId = crypto.randomUUID();
      await db.insert(tables.files).values({
        id: interposedFileId,
        filename: 'interposed.png',
        originalName: 'interposed.png',
        path: `communities/${communityA}/${interposedFileId}`,
        url: `https://ignored.invalid/${interposedFileId}`,
        mimeType: 'image/png',
        size: 3,
        communityId: communityA,
        uploadedBy: null,
        createdAt: instant,
        updatedAt: instant,
      });
      fileIds.push(interposedFileId);
      const [interposedExistingStory] = await db
        .insert(tables.stories)
        .values({
          communityId: communityA,
          title: 'Interposed Existing Story',
          slug: `interposed-existing-${tag}`,
          language: 'en',
          privacyLevel: 'editors',
          isRestricted: false,
          createdAt: instant,
          updatedAt: instant,
        })
        .returning();
      const [interposedNewStory] = await db
        .insert(tables.stories)
        .values({
          communityId: communityA,
          title: 'Interposed New Story',
          slug: `interposed-new-${tag}`,
          language: 'en',
          privacyLevel: 'editors',
          isRestricted: false,
          createdAt: instant,
          updatedAt: instant,
        })
        .returning();
      const [interposedPlace] = await db
        .insert(tables.places)
        .values({ communityId: communityA, name: 'Interposed Place' })
        .returning();
      await db.insert(tables.attachments).values({
        communityId: communityA,
        fileId: interposedFileId,
        ownerType: 'story',
        ownerId: interposedExistingStory.id,
        role: 'story_media',
        ordinal: 0,
        createdAt: instant,
      });
      const interposedAttach = (
        ownerType: 'story' | 'place',
        ownerId: number,
        role: 'story_media' | 'place_photo'
      ) =>
        send(app, '/v2/attachments', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            cookie: slice7AdminCookie,
          },
          body: JSON.stringify({
            fileId: interposedFileId,
            ownerType,
            ownerId,
            role,
          }),
        });
      let pendingPlace!: Promise<Response>;
      let pendingStory!: Promise<Response>;
      await db.transaction(async (tx: any) => {
        // Take the files row first: the place-target attach runs inside it,
        // reads the pre-seeded relation, takes owner locks, and then blocks
        // on the files lock — exactly the window where a relation may be
        // committed before its post-lock re-check.
        await tx
          .select({ id: tables.files.id })
          .from(tables.files)
          .where(eq(tables.files.id, interposedFileId))
          .for('update');
        pendingPlace = interposedAttach(
          'place',
          interposedPlace.id,
          'place_photo'
        );
        void pendingPlace.finally(() => {});
        await waitForLockWaiter(tx);
        // Interpose the new relation (committed only when this tx ends), and
        // race a story-target attach on the same file that holds that new
        // owner FOR UPDATE and waits on the files lock as well.
        await tx.insert(tables.attachments).values({
          communityId: communityA,
          fileId: interposedFileId,
          ownerType: 'story',
          ownerId: interposedNewStory.id,
          role: 'story_media',
          ordinal: 0,
          createdAt: instant,
        });
        pendingStory = interposedAttach(
          'story',
          interposedNewStory.id,
          'story_media'
        );
        void pendingStory.finally(() => {});
        await waitForLockWaiter(tx);
      });
      const [interposedPlaceRes, interposedStoryRes] = await Promise.all([
        withDeadline(pendingPlace, 10_000, 'interposed place-target attach'),
        withDeadline(pendingStory, 10_000, 'interposed story-target attach'),
      ]);
      for (const [label, response] of [
        ['place-target', interposedPlaceRes],
        ['story-target', interposedStoryRes],
      ] as const) {
        assert.ok(
          [201, 404].includes(response.status),
          `interposed ${label} attach must settle with 201 or 404, never 5xx (got ${
            response.status
          }: ${await response.text()})`
        );
      }

      // Deactivated community (#140): an existing-relation owner that
      // sorts before the target (place < story) must not collapse a
      // forbidden verdict into 404 — PG must answer 403 exactly as
      // D1/SQLite (and the target-first pre-fix order) do. Sessions
      // are revoked on disable, so log in fresh while disabled to reach
      // the repository.
      try {
        await updateCommunity(communityA, { isActive: false });
        const disabledAdminCookie = await login(adminEmail);
        const inactiveAttach = await send(app, '/v2/attachments', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            cookie: disabledAdminCookie,
          },
          body: JSON.stringify({
            fileId: fileIds[0],
            ownerType: 'story',
            ownerId: crossStory.id,
            role: 'story_media',
          }),
        });
        assert.equal(
          inactiveAttach.status,
          403,
          `a deactivated community must answer 403, uniformly with D1/SQLite (${await inactiveAttach.text()})`
        );
      } finally {
        await updateCommunity(communityA, { isActive: true });
      }

      // Non-target owner without authority over it (#140): a file already
      // attached as community branding or as another user's user_photo may
      // not be reused by an editor onto a story they can edit — the
      // non-target owner is not theirs to authorize, and 403 would disclose
      // the protected relation. D1/SQLite answers 404, so PG must as well.
      const editorCookie = await login(editorEmail);
      // The disabled-community case above revoked every community session, so
      // the admin signs in again before adopting the staging files.
      const reuseAdminCookie = await login(adminEmail);
      const nonTargetFiles = [crypto.randomUUID(), crypto.randomUUID()];
      for (const id of nonTargetFiles) fileIds.push(id);
      await db.insert(tables.files).values([
        {
          id: nonTargetFiles[0],
          filename: 'branding-reuse.png',
          originalName: 'branding-reuse.png',
          path: `communities/${communityA}/${nonTargetFiles[0]}`,
          url: `https://ignored.invalid/${nonTargetFiles[0]}`,
          mimeType: 'image/png',
          size: 3,
          communityId: communityA,
          uploadedBy: adminId,
          createdAt: instant,
          updatedAt: instant,
        },
        {
          id: nonTargetFiles[1],
          filename: 'user-photo-reuse.png',
          originalName: 'user-photo-reuse.png',
          path: `communities/${communityA}/${nonTargetFiles[1]}`,
          url: `https://ignored.invalid/${nonTargetFiles[1]}`,
          mimeType: 'image/png',
          size: 3,
          communityId: communityA,
          uploadedBy: adminId,
          createdAt: instant,
          updatedAt: instant,
        },
      ]);
      const brandingAttach = await send(app, '/v2/attachments', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: reuseAdminCookie,
        },
        body: JSON.stringify({
          fileId: nonTargetFiles[0],
          ownerType: 'community',
          ownerId: communityA,
          role: 'community_display_image',
        }),
      });
      assert.equal(
        brandingAttach.status,
        201,
        `the admin must be able to adopt the staging file as community branding (${await brandingAttach.text()})`
      );
      const userPhotoAttach = await send(app, '/v2/attachments', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: reuseAdminCookie,
        },
        body: JSON.stringify({
          fileId: nonTargetFiles[1],
          ownerType: 'user',
          ownerId: viewerId,
          role: 'user_photo',
        }),
      });
      assert.equal(
        userPhotoAttach.status,
        201,
        `the admin must be able to adopt the staging file as a user's user_photo (${await userPhotoAttach.text()})`
      );
      for (const [label, fileId] of [
        ['community-branding', nonTargetFiles[0]],
        ['user user_photo', nonTargetFiles[1]],
      ] as const) {
        const reuse = await send(app, '/v2/attachments', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            cookie: editorCookie,
          },
          body: JSON.stringify({
            fileId,
            ownerType: 'story',
            ownerId: crossStory.id,
            role: 'story_media',
          }),
        });
        assert.equal(
          reuse.status,
          404,
          `an editor reusing a ${label}-attached file onto a story they can edit must answer 404 (a 403 would disclose the protected relation), uniformly with D1/SQLite (${await reuse.text()})`
        );
      }
      // The target owner's verdict decides first on every dialect: a viewer
      // has no story authority, so the attach answers 403 even though the
      // file's non-target branding owner sorts before the story (#140).
      const viewerCookie = await login(viewerEmail);
      const viewerReuse = await send(app, '/v2/attachments', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: viewerCookie,
        },
        body: JSON.stringify({
          fileId: nonTargetFiles[0],
          ownerType: 'story',
          ownerId: crossStory.id,
          role: 'story_media',
        }),
      });
      assert.equal(
        viewerReuse.status,
        403,
        `a viewer attaching onto a story answers the target verdict 403 on PG as on D1/SQLite (${await viewerReuse.text()})`
      );
    }
  } finally {
    for (const id of communityIds) {
      await db
        .delete(tables.storyPlaces)
        .where(eq(tables.storyPlaces.communityId, id));
      await db
        .delete(tables.attachments)
        .where(eq(tables.attachments.communityId, id));
      await db.delete(tables.stories).where(eq(tables.stories.communityId, id));
      await db.delete(tables.places).where(eq(tables.places.communityId, id));
      await db
        .delete(tables.auditEntries)
        .where(eq(tables.auditEntries.communityId, id));
    }
    for (const id of fileIds) {
      await db.delete(media).where(eq(media.fileId, id));
      await db.delete(tables.files).where(eq(tables.files.id, id));
    }
    // Auth/security audit entries reference the seeded accounts (actorId)
    // and communities; delete them with their parents. Entries may also carry
    // null communityId (system-level auth events), so they cannot be removed
    // by community alone.
    await db
      .delete(tables.auditEntries)
      .where(inArray(tables.auditEntries.actorId, userIds));
    for (const id of userIds) {
      await db
        .delete(tables.auditEntries)
        .where(eq(tables.auditEntries.actorId, id));
      await db.delete(sessions).where(eq(sessions.userId, id));
      await db.delete(tables.users).where(eq(tables.users.id, id));
    }
    for (const id of communityIds)
      await db.delete(tables.communities).where(eq(tables.communities.id, id));
  }
}
