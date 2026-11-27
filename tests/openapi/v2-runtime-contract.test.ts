import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  ARGON2ID_ALGORITHM,
  ARGON2ID_PARAMS_JSON,
} from '../../src/shared/auth-policy.js';
import { createHash } from 'node:crypto';
import { MediaCleanupCoordinator } from '../../src/services/media-cleanup.service.js';
import {
  StorageChecksumMismatchError,
  type FoundationStorage,
} from '../../src/services/hono-foundation.service.js';
import { DirectUploadSessionResponseSchema } from '../../src/shared/schemas/media-uploads-v2.js';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { createHonoApp } from '../../src/hono-app.js';
import { HonoFoundationRepository } from '../../src/repositories/hono-foundation.repository.js';
import { communitiesSqlite } from '../../src/db/schema/communities.js';
import { usersSqlite } from '../../src/db/schema/users.js';
import { normalizeSearchText } from '../../src/shared/utils/search-normalize.js';
import { SCHEMA_MAP } from '../../scripts/openapi/schema-map.js';
import { OPENAPI_PATH, OPTIONAL_BODY } from '../../scripts/openapi/generate.js';
import { mountedRouteKeys } from '../../scripts/openapi/route-table.js';
import {
  argon2Seed,
  makeDerivedKey,
  makeServerSecret,
  makeVerifierSalt,
} from '../hono/auth-test-utils.js';

/**
 * #148: the generated OpenAPI document must describe what the real Hono app
 * answers. Representative calls assert the observed status is listed for the
 * operation and, where a response schema is mapped, that the body validates
 * against it; an anonymous sweep proves the `security` flag of every
 * operation against the live session gate.
 */
const ORIGIN = 'https://api.example.test';
const sha256Of = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

interface Operation {
  security: unknown[];
  responses: Record<string, { content?: Record<string, { schema?: unknown }> }>;
}
const doc = JSON.parse(readFileSync(OPENAPI_PATH, 'utf8')) as {
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, unknown> };
};

/** Inline `#/components/schemas/*` references of an emitted JSON Schema. */
function inlineRefs(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(inlineRefs);
  if (node && typeof node === 'object') {
    const record = node as Record<string, unknown>;
    const ref = record['$ref'];
    if (typeof ref === 'string' && ref.startsWith('#/components/schemas/'))
      return inlineRefs(doc.components.schemas[ref.split('/').pop()!]);
    return Object.fromEntries(
      Object.entries(record).map(([k, v]) => [k, inlineRefs(v)])
    );
  }
  return node;
}
const operationFor = (method: string, template: string): Operation => {
  const op =
    doc.paths[template.replace(/:([A-Za-z0-9_]+)/g, '{$1}')]?.[
      method.toLowerCase()
    ];
  if (!op)
    throw new Error(`${method} ${template} missing from ${OPENAPI_PATH}`);
  return op;
};

describe('V2 OpenAPI runtime contract', () => {
  const openDbs: Sqlite.Database[] = [];
  afterEach(() => {
    while (openDbs.length > 0) openDbs.pop()?.close();
  });

  async function setup() {
    const sqlite = new Sqlite(':memory:');
    sqlite.pragma('foreign_keys = ON');
    openDbs.push(sqlite);
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: 'src/db/migrations' });
    const [community] = await db
      .insert(communitiesSqlite)
      .values({
        name: 'Contract Alpha',
        slug: 'contract-alpha',
        locale: 'en',
        publicStories: true,
        isActive: true,
      })
      .returning();
    const derivedKey = makeDerivedKey();
    await db.insert(usersSqlite).values({
      email: 'admin@contract.test',
      username: 'contract_admin',
      emailNormalized: normalizeSearchText('admin@contract.test'),
      usernameNormalized: normalizeSearchText('contract_admin'),
      firstName: 'Contract',
      lastName: 'Admin',
      ...(await argon2Seed(derivedKey)),
      role: 'admin',
      communityId: community!.id,
      isActive: true,
    });
    const objects = new Map<string, Uint8Array>();
    const storage: FoundationStorage = {
      fenceCommunity: async () => {},
      read: async (key, range) => {
        const bytes = objects.get(key);
        if (!bytes) return null;
        return {
          size: bytes.byteLength,
          body: range ? bytes.subarray(range.start, range.end + 1) : bytes,
        };
      },
      delete: async (key) => {
        objects.delete(key);
      },
      put: async (key, body, options) => {
        const bytes =
          body instanceof Uint8Array
            ? body
            : new Uint8Array(await new Response(body).arrayBuffer());
        if (options?.sha256 && sha256Of(bytes) !== options.sha256)
          throw new StorageChecksumMismatchError();
        objects.set(key, bytes);
        return { size: bytes.byteLength };
      },
      list: async () => ({ entries: [], truncated: false }),
    };
    const app = createHonoApp({
      repository: new HonoFoundationRepository(db),
      storage,
      mediaCleanup: new MediaCleanupCoordinator(db, storage),
      erasureStore: { list: async () => [], write: async () => {} },
      serverSecret: makeServerSecret(),
      secureCookies: false,
      publicOrigin: ORIGIN,
      trustProxy: true,
    });
    const call = (
      method: string,
      path: string,
      opts: { cookie?: string; body?: unknown } = {}
    ) =>
      app.request(`${ORIGIN}${path}`, {
        method,
        headers: {
          'x-forwarded-for': '198.51.100.20',
          ...(opts.cookie ? { Cookie: opts.cookie } : {}),
          ...(opts.body !== undefined
            ? { 'Content-Type': 'application/json' }
            : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
    const login = async () => {
      const res = await call('POST', '/v2/auth/login', {
        body: { identifier: 'contract_admin', derivedKey },
      });
      expect(res.status).toBe(200);
      const token = /ts_session=([^;]+)/.exec(
        res.headers.get('set-cookie') ?? ''
      );
      return `ts_session=${token![1]}`;
    };
    const addMember = async () => {
      const memberKey = makeDerivedKey();
      const [member] = await db
        .insert(usersSqlite)
        .values({
          email: 'member@contract.test',
          username: 'contract_member',
          emailNormalized: normalizeSearchText('member@contract.test'),
          usernameNormalized: normalizeSearchText('contract_member'),
          firstName: 'Contract',
          lastName: 'Member',
          ...(await argon2Seed(memberKey)),
          role: 'member',
          communityId: community!.id,
          isActive: true,
        })
        .returning();
      const res = await call('POST', '/v2/auth/login', {
        body: { identifier: 'contract_member', derivedKey: memberKey },
      });
      const token = /ts_session=([^;]+)/.exec(
        res.headers.get('set-cookie') ?? ''
      );
      return {
        id: member!.id,
        derivedKey: memberKey,
        cookie: `ts_session=${token![1]}`,
      };
    };
    return { app, call, derivedKey, login, addMember };
  }

  /** Assert the status is documented and a mapped schema accepts the body. */
  async function check(
    res: Response,
    method: string,
    template: string,
    expected: number
  ) {
    expect(res.status).toBe(expected);
    const op = operationFor(method, template);
    expect(Object.keys(op.responses), `${method} ${template}`).toContain(
      String(res.status)
    );
    // The emitted document, not only the source zod schema, must accept the
    // live body (success and error alike) and name the real content type.
    const emitted =
      op.responses[String(res.status)]?.content?.['application/json']?.schema;
    if (res.status === 204) {
      // Bodyless success: no content documented, none sent.
      expect(
        emitted,
        `${method} ${template} 204 has no content`
      ).toBeUndefined();
      expect(await res.text()).toBe('');
      return;
    }
    expect(
      emitted,
      `${method} ${template} ${res.status} must document a JSON schema`
    ).toBeDefined();
    {
      expect(
        res.headers.get('content-type') ?? '',
        `${method} ${template}`
      ).toContain('application/json');
      const body: unknown = await res.clone().json();
      const parsed = z
        .fromJSONSchema(inlineRefs(emitted) as never)
        .safeParse(body);
      expect(
        parsed.success ? 'valid' : JSON.stringify(parsed.error.issues),
        `${method} ${template} ${res.status} emitted schema`
      ).toBe('valid');
    }
    const schema = SCHEMA_MAP[`${method} ${template}`]?.response;
    if (schema && res.status >= 200 && res.status < 300) {
      const parsed = schema.safeParse(await res.json());
      expect(
        parsed.success ? 'valid' : JSON.stringify(parsed.error.issues),
        `${method} ${template} body`
      ).toBe('valid');
    }
  }

  it('login answers 200, 400 and 401 as documented', async () => {
    const { call, derivedKey } = await setup();
    const t = '/v2/auth/login';
    const good = { identifier: 'contract_admin', derivedKey };
    await check(await call('POST', t, { body: good }), 'POST', t, 200);
    await check(await call('POST', t, { body: {} }), 'POST', t, 400);
    const bad = { ...good, derivedKey: makeDerivedKey() };
    await check(await call('POST', t, { body: bad }), 'POST', t, 401);
  });

  it('public and protected reads, 404 and a 201 write', async () => {
    const { call, login } = await setup();
    const list = '/v2/public/communities';
    await check(await call('GET', list), 'GET', list, 200);
    await check(await call('GET', '/v2/stories'), 'GET', '/v2/stories', 401);
    const cookie = await login();
    await check(
      await call('GET', '/v2/stories', { cookie }),
      'GET',
      '/v2/stories',
      200
    );
    await check(
      await call('GET', '/v2/stories/999999', { cookie }),
      'GET',
      '/v2/stories/:id',
      404
    );
    const place = { cookie, body: { name: 'Contract Place' } };
    await check(
      await call('POST', '/v2/places', place),
      'POST',
      '/v2/places',
      201
    );
    await check(
      await call('POST', '/v2/places', { cookie, body: {} }),
      'POST',
      '/v2/places',
      400
    );
  });

  it('erasure is accepted with 202', async () => {
    const { call, login, derivedKey } = await setup();
    const cookie = await login();
    const t = '/v2/community/erasure';
    const body = { confirmFinality: true, currentDerivedKey: derivedKey };
    await check(await call('POST', t, { cookie, body }), 'POST', t, 202);
  });

  it('withdrawal is 200 for an admin and 202 for a steward member', async () => {
    const t = '/v2/community/withdrawal';
    const admin = await setup();
    const adminCookie = await admin.login();
    await check(
      await admin.call('POST', t, {
        cookie: adminCookie,
        body: { currentDerivedKey: admin.derivedKey },
      }),
      'POST',
      t,
      200
    );
    const { call, login, derivedKey, addMember } = await setup();
    const cookie = await login();
    const member = await addMember();
    const designated = await call('PUT', '/v2/community/steward', {
      cookie,
      body: { stewardUserId: member.id, currentDerivedKey: derivedKey },
    });
    expect(designated.status).toBe(200);
    await check(
      await call('POST', t, {
        cookie: member.cookie,
        body: { currentDerivedKey: member.derivedKey },
      }),
      'POST',
      t,
      202
    );
  });

  it('export is rate limited with 429', async () => {
    const { call, login } = await setup();
    const cookie = await login();
    const t = '/v2/community/export';
    const statuses: number[] = [];
    for (let i = 0; i < 8 && !statuses.includes(429); i += 1) {
      const res = await call('POST', t, { cookie });
      statuses.push(res.status);
      expect(Object.keys(operationFor('POST', t).responses)).toContain(
        String(res.status)
      );
    }
    expect(statuses).toContain(429);
  });

  it('password reset answers 204 and import discard 200, as documented', async () => {
    const { app, call, login, addMember } = await setup();
    const cookie = await login();
    const member = await addMember();
    const reset = '/v2/users/:id/password-reset';
    await check(
      await call('POST', `/v2/users/${member.id}/password-reset`, {
        cookie,
        body: {
          algorithm: ARGON2ID_ALGORITHM,
          salt: makeVerifierSalt(),
          params: JSON.parse(ARGON2ID_PARAMS_JSON),
          derivedKey: makeDerivedKey(),
        },
      }),
      'POST',
      reset,
      204
    );
    const form = new FormData();
    form.set('kind', 'places');
    form.set(
      'file',
      new File(['name,region\nContract Place,North\n'], 'places.csv', {
        type: 'text/csv',
      })
    );
    const preview = await app.request(`${ORIGIN}/v2/imports/preview`, {
      method: 'POST',
      headers: { cookie, 'x-forwarded-for': '198.51.100.20' },
      body: form,
    });
    await check(preview.clone(), 'POST', '/v2/imports/preview', 201);
    const manifest = (await preview.json()) as {
      data: { id: number | string };
    };
    await check(
      await call('DELETE', `/v2/imports/${manifest.data.id}`, { cookie }),
      'DELETE',
      '/v2/imports/:id',
      200
    );
  });

  it('Explore 404 carries message and validates against ExploreError', async () => {
    const { call } = await setup();
    const t = '/explore/media/:fileId';
    const res = await call('GET', '/explore/media/1');
    const body = (await res.clone().json()) as Record<string, unknown>;
    expect(body).toHaveProperty('message');
    await check(res, 'GET', t, 404);
    const ref = operationFor('GET', t).responses['404']?.content?.[
      'application/json'
    ]?.schema;
    expect(ref).toEqual({ $ref: '#/components/schemas/ExploreError' });
  });

  it('direct upload completion answers 201 as documented', async () => {
    const { app, call, login } = await setup();
    const cookie = await login();
    const bytes = new Uint8Array(1024);
    bytes.set(
      [0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d],
      0
    );
    const sha256 = sha256Of(bytes);
    const created = await call('POST', '/v2/media/uploads', {
      cookie,
      body: {
        filename: 'clip.mp4',
        contentType: 'video/mp4',
        size: bytes.byteLength,
        sha256,
        partSha256: [sha256],
      },
    });
    await check(created.clone(), 'POST', '/v2/media/uploads', 201);
    const session = DirectUploadSessionResponseSchema.parse(
      await created.json()
    ).data;
    const target = session.parts[0]!;
    const put = await app.request(target.url, {
      method: 'PUT',
      headers: {
        ...target.headers,
        cookie,
        'content-length': String(bytes.byteLength),
      },
      body: bytes,
    });
    expect(put.status).toBe(200);
    const etag = put.headers.get('etag')!.replace(/"/g, '');
    const t = '/v2/media/uploads/:id/complete';
    const done = await call(
      'POST',
      `/v2/media/uploads/${session.id}/complete`,
      {
        cookie,
        body: { parts: [{ partNumber: 1, etag }] },
      }
    );
    await check(done.clone(), 'POST', t, 201);
    const mediaId = ((await done.json()) as { data: { id: string } }).data.id;
    const media = await call('GET', `/v2/media/${mediaId}`, { cookie });
    expect(media.status).toBe(200);
    const mediaOp = operationFor('GET', '/v2/media/:id');
    expect(Object.keys(mediaOp.responses['200']?.content ?? {})).toEqual([
      '*/*',
    ]);
    expect(media.headers.get('content-type')).not.toContain('application/json');
    expect(new Uint8Array(await media.arrayBuffer())).toEqual(bytes);
  });

  it('documents request body requirement and 206 ranges', () => {
    const body = (method: string, template: string) =>
      (
        operationFor(method, template) as unknown as {
          requestBody?: { required: boolean };
        }
      ).requestBody;
    expect(body('POST', '/v2/community/export')?.required).toBe(false);
    expect(body('PUT', '/v2/community/map-config')?.required).toBe(true);
    expect(
      Object.keys(operationFor('GET', '/v2/media/:id').responses)
    ).toContain('206');
    // Range failures (media-stream-response.ts, community-export.service.ts)
    // carry no body, so no content is documented for 416.
    for (const route of [
      '/v2/media/:id',
      '/v2/community/export/download/:token',
    ]) {
      const responses = operationFor('GET', route).responses;
      expect(responses['416'], route).toBeDefined();
      expect(responses['416']?.content, route).toBeUndefined();
      expect(responses['206']?.content, route).toBeDefined();
      expect(responses['200']?.content, route).toBeDefined();
    }
    const binary = { schema: { type: 'string', format: 'binary' } };
    const exact = (route: string, status: string) =>
      operationFor('GET', route).responses[status]?.content;
    for (const route of [
      '/v2/media/:id',
      '/v2/public/communities/:slug/media/:fileId',
      '/explore/media/:fileId',
    ]) {
      expect(exact(route, '200'), route).toEqual({ '*/*': binary });
      expect(exact(route, '206'), route).toEqual({ '*/*': binary });
    }
    const download = '/v2/community/export/download/:token';
    expect(exact(download, '200')).toEqual({
      'application/zip': binary,
      'application/json': { schema: { type: 'object' } },
    });
    // A range of the JSON manifest is a byte fragment, not a JSON document.
    expect(exact(download, '206')).toEqual({
      'application/zip': binary,
      'application/json': binary,
    });
    const mounted = new Set(mountedRouteKeys());
    for (const key of OPTIONAL_BODY)
      expect(mounted.has(key), `${key} is not mounted`).toBe(true);
  });

  it('security flags and statuses hold for every operation anonymously', async () => {
    const { call } = await setup();
    let checked = 0;
    for (const [template, methods] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        const path = template.replace(/\{[^}]+\}/g, '1');
        const res = await call(method.toUpperCase(), path);
        const label = `${method.toUpperCase()} ${template}`;
        if (op.security.length > 0) expect(res.status, label).toBe(401);
        else expect(res.status, `${label} needs no session`).not.toBe(401);
        expect(res.status, `${label} must not crash`).not.toBe(500);
        expect(Object.keys(op.responses), label).toContain(String(res.status));
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(80);
  });
});
