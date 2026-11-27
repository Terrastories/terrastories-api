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
import { compareCodeUnits, mountedRoutes } from './route-table.js';
import { SCHEMA_MAP } from './schema-map.js';
import { V2ValidationErrorResponseSchema } from '../../src/shared/schemas/community-writes.js';

/**
 * V2 OpenAPI 3.1 generator (#148). Operations come from the routes the Hono
 * app actually mounts; method, path, purpose, caller and auth requirement come
 * from docs/V2-ROUTE-REGISTRY.md; bodies come from the zod schemas named in
 * schema-map.ts (partial by design: a route without an entry still appears
 * with its status codes and auth requirement).
 */
export const OPENAPI_PATH = 'docs/openapi/v2.json';

/** Routes whose request takes no body, query or path input. */
const NO_INPUT = new Set([
  'GET /health',
  'GET /ready',
  'GET /v2/auth/me',
  'POST /v2/auth/logout',
  'POST /v2/auth/revoke',
  'GET /v2/bootstrap',
]);

/** Byte payloads of 200 and 206 (media and export downloads, not JSON). */
const BINARY = { schema: { type: 'string', format: 'binary' } };
const MEDIA_BYTES = { '*/*': BINARY };
const BYTE_ROUTES: Record<string, Json> = {
  'GET /v2/media/:id': MEDIA_BYTES,
  'GET /v2/public/communities/:slug/media/:fileId': MEDIA_BYTES,
  'GET /explore/media/:fileId': MEDIA_BYTES,
  // community-export.service.ts serves the zip or the manifest by token.
  'GET /v2/community/export/download/:token': {
    'application/zip': BINARY,
    'application/json': { schema: { type: 'object' } },
  },
};

/** Error statuses answered without a body (range failures). */
const BODYLESS_STATUSES = new Set([416]);

/** Routes whose handler accepts an absent or empty JSON body. */
export const OPTIONAL_BODY = new Set([
  'POST /v2/admin/communities/:id/claim-tokens',
  'POST /v2/community/export',
  'POST /v2/auth/recovery-codes',
]);

/** Routes that never go through the JSON body parser (raw or multipart). */
const RAW_BODY = new Set([
  'POST /v2/media',
  'PUT /v2/media/uploads/:id/parts/:partNumber',
]);

/** Success statuses that differ from 200 (201 and 204 are listed per route). */
const SUCCESS_STATUSES: Record<string, number[]> = {
  'POST /v2/auth/logout': [204],
  'POST /v2/auth/revoke': [204],
  'POST /v2/bootstrap': [201],
  'POST /v2/bootstrap/claim': [201],
  'POST /v2/auth/recovery-codes': [201],
  'POST /v2/stories': [201],
  'POST /v2/stories/:id/external-links': [201],
  'POST /v2/places': [201],
  'POST /v2/speakers': [201],
  'POST /v2/users': [201],
  'POST /v2/users/:id/login-codes': [201],
  'POST /v2/media': [201],
  'POST /v2/media/uploads': [201],
  'POST /v2/media/uploads/:id/complete': [201],
  'POST /v2/attachments': [201],
  'POST /v2/imports/preview': [201],
  'POST /v2/community/export': [201],
  'POST /v2/admin/communities': [201],
  'POST /v2/admin/communities/:id/claim-tokens': [201],
  // community-sovereignty.service.ts: an admin withdraws at once (200); any
  // designated steward files a notice (202); erasure is always accepted (202).
  'POST /v2/community/withdrawal': [200, 202],
  'POST /v2/community/erasure': [202],
};

/** Hand-kept extras for routes whose codes the generic rules cannot see. */
const EXTRA_STATUSES: Record<string, number[]> = {
  'POST /v2/auth/login': [400, 401, 409, 413, 415, 503],
  // community-export.service.ts: quota exceeded; imports.service.ts: too many
  // open previews.
  'POST /v2/community/export': [429],
  'POST /v2/imports/preview': [429],
  'POST /v2/imports/:id/commit': [429],
  // direct-upload.service.ts and media-writes.service.ts.
  'POST /v2/media': [411, 413, 415, 422],
  'POST /v2/media/uploads': [410, 411, 413, 422, 501],
  'POST /v2/media/uploads/:id/parts/presign': [410, 411, 422, 501],
  'PUT /v2/media/uploads/:id/parts/:partNumber': [410, 411, 413, 422, 501],
  'POST /v2/media/uploads/:id/complete': [410, 422, 501],
  'DELETE /v2/media/uploads/:id': [410],
  // Range reads and expired download tokens.
  // (206 and 416: media-stream-response.ts and community-export.service.ts).
  'GET /v2/community/export/download/:token': [206, 416],
  'GET /v2/media/:id': [206, 416],
  'GET /v2/public/communities/:slug/media/:fileId': [206, 416],
  'GET /explore/media/:fileId': [206, 416],
  // Unauthenticated routes that still answer a uniform 401 on bad credentials.
  'POST /v2/bootstrap': [401],
  'POST /v2/bootstrap/claim': [401],
  'POST /v2/auth/recovery/redeem': [401],
};

const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  206: 'Partial Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  410: 'Gone',
  411: 'Length Required',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  416: 'Range Not Satisfiable',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  503: 'Service Unavailable',
};

/** Status codes the registry text calls out in backticks (e.g. `404`). */
function statusCodesIn(text: string): number[] {
  const codes = new Set<number>();
  for (const match of text.matchAll(/`([1-5]\d\d)\b/g))
    codes.add(Number(match[1]));
  return [...codes];
}

export function successStatuses(row: RegistryRow): number[] {
  return (
    SUCCESS_STATUSES[routeKey(row.method, row.path)] ?? [
      row.method === 'DELETE' ? 204 : 200,
    ]
  );
}

/**
 * Every status a route may answer: its success codes, the registry text, the
 * hand-kept EXTRA_STATUSES (codes returned by one service, e.g. 429), then a
 * deliberately generous set from the shared pipeline: CSRF 403 on writes,
 * session 401 and role 403, body parser 400/413/415, service 404/409/422,
 * 500 for persistence failures and 503 for outages. tests/openapi asserts
 * real responses stay inside this set, so an undocumented status fails.
 */
export function statusCodesFor(row: RegistryRow, secured: boolean): number[] {
  const key = routeKey(row.method, row.path);
  const codes = new Set<number>(successStatuses(row));
  for (const code of statusCodesIn(row.purpose))
    if (code >= 400) codes.add(code);
  for (const code of EXTRA_STATUSES[key] ?? []) codes.add(code);
  const writes = row.method !== 'GET';
  const body = writes && !NO_INPUT.has(key);
  if (key !== 'GET /health') codes.add(503);
  if (writes) codes.add(403);
  if (secured) {
    codes.add(401);
    if (!/^any authenticated/i.test(row.who)) codes.add(403);
  }
  if (!NO_INPUT.has(key)) codes.add(400);
  if (body && !RAW_BODY.has(key)) {
    codes.add(413);
    codes.add(415);
  }
  if (body) codes.add(409);
  if (body && secured) codes.add(422);
  if (key !== 'GET /health' && key !== 'GET /ready') codes.add(404);
  // Services map unexpected persistence failures to 500.
  if (row.path.startsWith('/v2/')) codes.add(500);
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
  const mounted = new Map(mountedRoutes().map((route) => [route.key, route]));
  const paths: Record<string, Record<string, Json>> = {};
  const sorted = [...rows].sort(
    (a, b) =>
      compareCodeUnits(a.path, b.path) || compareCodeUnits(a.method, b.method)
  );
  for (const row of sorted) {
    const key = routeKey(row.method, row.path);
    const route = mounted.get(key);
    if (!route) throw new Error(`Registry route is not mounted: ${key}`);
    const secured = route.secured;
    const mapped = SCHEMA_MAP[key];
    const success = successStatuses(row);
    const responses: Record<string, Json> = {};
    for (const code of statusCodesFor(row, secured)) {
      const response: Json = {
        description: STATUS_TEXT[code] ?? `HTTP ${code}`,
      };
      const bytes = BYTE_ROUTES[key];
      if (bytes && (code === 200 || code === 206)) {
        response['content'] = bytes;
      } else if (success.includes(code) && code !== 204 && mapped?.response) {
        response['content'] = {
          'application/json': {
            schema: jsonSchemaOf(mapped.response, 'output'),
          },
        };
      } else if (code >= 400 && !BODYLESS_STATUSES.has(code)) {
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
        required: !OPTIONAL_BODY.has(key),
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
      schemas: {
        V2Error: jsonSchemaOf(V2ValidationErrorResponseSchema, 'output'),
      },
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
