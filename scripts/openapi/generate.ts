import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import * as prettier from 'prettier';
import {
  isMountedStatus,
  readRegistry,
  routeKey,
  type RegistryRow,
} from './registry.js';
import { mountedRouteKeys } from './route-table.js';
import { SCHEMA_MAP } from './schema-map.js';
import { V2ErrorResponseSchema } from '../../src/shared/schemas/public-communities.js';

/**
 * V2 OpenAPI 3.1 generator (#148). Operations come from the routes the Hono
 * app actually mounts; method, path, purpose, caller and auth requirement come
 * from docs/V2-ROUTE-REGISTRY.md; bodies come from the zod schemas named in
 * schema-map.ts (partial by design: a route without an entry still appears
 * with its status codes and auth requirement).
 */
export const OPENAPI_PATH = 'docs/openapi/v2.json';

/** Routes served without the `ts_session` gate (registry "Who may call"). */
const UNAUTHENTICATED_V2 = new Set([
  'POST /v2/auth/prelogin',
  'POST /v2/auth/login',
  'POST /v2/auth/recovery/redeem',
  'GET /v2/bootstrap',
  'POST /v2/bootstrap',
  'POST /v2/bootstrap/claim',
]);

/** Success status of routes that do not answer 200 (DELETE defaults to 204). */
const SUCCESS_OVERRIDES: Record<string, number> = {
  'POST /v2/auth/logout': 204,
  'POST /v2/auth/revoke': 204,
  'POST /v2/bootstrap': 201,
  'POST /v2/bootstrap/claim': 201,
  'POST /v2/auth/recovery-codes': 201,
  'POST /v2/stories': 201,
  'POST /v2/stories/:id/external-links': 201,
  'POST /v2/places': 201,
  'POST /v2/speakers': 201,
  'POST /v2/users': 201,
  'POST /v2/users/:id/login-codes': 201,
  'POST /v2/media': 201,
  'POST /v2/media/uploads': 201,
  'POST /v2/attachments': 201,
  'POST /v2/imports/preview': 201,
  'POST /v2/community/export': 201,
  'POST /v2/admin/communities': 201,
  'POST /v2/admin/communities/:id/claim-tokens': 201,
};

const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  413: 'Payload Too Large',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
};

export function isAuthenticated(method: string, path: string): boolean {
  if (!path.startsWith('/v2/')) return false;
  if (path.startsWith('/v2/public/')) return false;
  return !UNAUTHENTICATED_V2.has(routeKey(method, path));
}

/** Status codes the registry text calls out in backticks (e.g. `404`). */
function statusCodesIn(text: string): number[] {
  const codes = new Set<number>();
  for (const match of text.matchAll(/`([1-5]\d\d)\b/g))
    codes.add(Number(match[1]));
  return [...codes];
}

function successStatus(row: RegistryRow): number {
  const key = routeKey(row.method, row.path);
  const override = SUCCESS_OVERRIDES[key];
  if (override) return override;
  return row.method === 'DELETE' ? 204 : 200;
}

export function statusCodesFor(row: RegistryRow): number[] {
  const codes = new Set<number>([successStatus(row)]);
  for (const code of statusCodesIn(row.purpose)) {
    if (code >= 400) codes.add(code);
  }
  if (isAuthenticated(row.method, row.path)) {
    codes.add(401);
    if (!/^any authenticated/i.test(row.who)) codes.add(403);
  }
  return [...codes].sort((a, b) => a - b);
}

function jsonSchemaOf(schema: z.ZodType, io: 'input' | 'output') {
  const out = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io,
    unrepresentable: 'any',
  }) as Record<string, unknown>;
  delete out['$schema'];
  return out;
}

const toOpenApiPath = (path: string): string =>
  path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');

const pathParams = (path: string): string[] =>
  [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1] as string);

function summaryOf(purpose: string): string {
  const plain = purpose.replace(/`/g, '');
  const cut = plain.split(/[;:(]|\. /)[0]?.trim() ?? plain;
  return cut.length > 100 ? `${cut.slice(0, 97).trimEnd()}...` : cut;
}

function operationIdOf(method: string, path: string): string {
  const slug = path
    .replace(/:([A-Za-z0-9_]+)/g, 'By_$1')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `${method.toLowerCase()}_${slug}`;
}

type Json = Record<string, unknown>;

export function buildOpenApiDocument(): Json {
  const rows = readRegistry().filter((row) => isMountedStatus(row.status));
  const mounted = new Set(mountedRouteKeys());
  const paths: Record<string, Record<string, Json>> = {};
  const sorted = [...rows].sort(
    (a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method)
  );
  for (const row of sorted) {
    const key = routeKey(row.method, row.path);
    if (!mounted.has(key))
      throw new Error(`Registry route is not mounted: ${key}`);
    const secured = isAuthenticated(row.method, row.path);
    const mapped = SCHEMA_MAP[key];
    const success = successStatus(row);
    const responses: Record<string, Json> = {};
    for (const code of statusCodesFor(row)) {
      const response: Json = {
        description: STATUS_TEXT[code] ?? `HTTP ${code}`,
      };
      if (code === success && mapped?.response) {
        response['content'] = {
          'application/json': {
            schema: jsonSchemaOf(mapped.response, 'output'),
          },
        };
      } else if (code >= 400) {
        response['content'] = {
          'application/json': {
            schema: { $ref: '#/components/schemas/V2Error' },
          },
        };
      }
      responses[String(code)] = response;
    }
    const operation: Json = {
      operationId: operationIdOf(row.method, row.path),
      summary: summaryOf(row.purpose),
      description: row.purpose.replace(/\s+/g, ' ').trim(),
      tags: [tagOf(row.path)],
      security: secured ? [{ cookieAuth: [] }] : [],
      'x-registry-caller': row.who.replace(/\s+/g, ' ').trim(),
      responses,
    };
    const params = pathParams(row.path).map((name) => ({
      name,
      in: 'path',
      required: true,
      schema: { type: 'string' },
    }));
    if (params.length) operation['parameters'] = params;
    if (mapped?.request) {
      operation['requestBody'] = {
        required: true,
        content: {
          'application/json': { schema: jsonSchemaOf(mapped.request, 'input') },
        },
      };
    }
    const openApiPath = toOpenApiPath(row.path);
    (paths[openApiPath] ??= {})[row.method.toLowerCase()] = operation;
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Terrastories API V2',
      version: 'v2',
      description:
        'Generated by scripts/openapi/generate.ts from docs/V2-ROUTE-REGISTRY.md, the mounted Hono routes and the zod schemas in src/shared/schemas. Do not edit by hand; run npm run openapi:generate. Request and response bodies are partial: routes without a schema mapping document method, path, auth and status codes only.',
    },
    paths,
    components: {
      securitySchemes: {
        cookieAuth: { type: 'apiKey', in: 'cookie', name: 'ts_session' },
      },
      schemas: { V2Error: jsonSchemaOf(V2ErrorResponseSchema, 'output') },
    },
  };
}

function tagOf(path: string): string {
  const parts = path.split('/').filter(Boolean);
  if (parts[0] === 'v2')
    return parts[1] === 'public' ? 'public' : (parts[1] ?? 'v2');
  return parts[0] ?? 'root';
}

export async function renderOpenApiDocument(): Promise<string> {
  const raw = JSON.stringify(buildOpenApiDocument(), null, 2);
  const config = (await prettier.resolveConfig(OPENAPI_PATH)) ?? {};
  return prettier.format(raw, { ...config, parser: 'json' });
}

const entry = process.argv[1];
if (entry && fileURLToPath(import.meta.url) === entry) {
  const text = await renderOpenApiDocument();
  if (process.argv.includes('--check')) {
    const current = readFileSync(OPENAPI_PATH, 'utf8');
    if (current !== text) {
      console.error(`${OPENAPI_PATH} is stale; run npm run openapi:generate`);
      process.exit(1);
    }
  } else {
    mkdirSync(dirname(OPENAPI_PATH), { recursive: true });
    writeFileSync(OPENAPI_PATH, text);
  }
}
