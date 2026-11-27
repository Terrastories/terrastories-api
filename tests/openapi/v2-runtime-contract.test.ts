import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
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
} from '../hono/auth-test-utils.js';

/**
 * #148: the generated OpenAPI document must describe what the real Hono app
 * answers. Representative calls assert the observed status is listed for the
 * operation and, where a response schema is mapped, that the body validates
 * against it; an anonymous sweep proves the `security` flag of every
 * operation against the live session gate.
 */
const ORIGIN = 'https://api.example.test';

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
    const app = createHonoApp({
      repository: new HonoFoundationRepository(db),
      storage: {
        fenceCommunity: async () => {},
        read: async () => null,
        delete: async () => {},
        put: async (
          _key: string,
          body: Uint8Array | ReadableStream<Uint8Array>
        ) => ({
          size:
            body instanceof Uint8Array
              ? body.byteLength
              : (await new Response(body).arrayBuffer()).byteLength,
        }),
        list: async () => ({ entries: [], truncated: false }),
      },
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
    return { call, derivedKey, login, addMember };
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
