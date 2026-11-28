import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  isMountedStatus,
  parseRegistry,
  readRegistry,
  routeKey,
} from '../../scripts/openapi/registry.js';
import { mountedRouteKeys } from '../../scripts/openapi/route-table.js';
import {
  OPENAPI_PATH,
  renderOpenApiDocument,
} from '../../scripts/openapi/generate.js';

/**
 * #148 contract governance. Changing a mounted V2 route means updating
 * docs/V2-ROUTE-REGISTRY.md and regenerating docs/openapi/v2.json
 * (npm run openapi:generate) in the same PR; see "Contract change policy" in
 * the registry.
 */
describe('V2 route registry drift', () => {
  it('parses the registry tables', () => {
    const rows = parseRegistry(
      [
        '| Method | Path | Purpose | Who | Tenant | SPEC | Status |',
        '| --- | --- | --- | --- | --- | --- | --- |',
        '| `GET` | `/v2/x/:id` | a \\| b | Anyone | none | §1 | `on main` |',
      ].join('\n')
    );
    expect(rows).toEqual([
      {
        method: 'GET',
        path: '/v2/x/:id',
        purpose: 'a | b',
        who: 'Anyone',
        status: '`on main`',
      },
    ]);
    expect(isMountedStatus('`deferred per Appendix A`')).toBe(false);
    expect(isMountedStatus('optional adapter (§7)')).toBe(false);
    expect(isMountedStatus('`on main` (#286)')).toBe(true);
  });

  it('mounts exactly the routes the registry lists', () => {
    const documented = readRegistry()
      .filter((row) => isMountedStatus(row.status))
      .map((row) => routeKey(row.method, row.path));
    expect(new Set(documented).size).toBe(documented.length);
    const mounted = mountedRouteKeys();
    expect(
      mounted.filter((key) => !documented.includes(key)),
      'mounted but missing from docs/V2-ROUTE-REGISTRY.md'
    ).toEqual([]);
    expect(
      documented.filter((key) => !mounted.includes(key)),
      'listed in docs/V2-ROUTE-REGISTRY.md but not mounted'
    ).toEqual([]);
  });
});

describe('V2 OpenAPI document', () => {
  it('is up to date with the registry, routes and schemas', async () => {
    const generated = await renderOpenApiDocument();
    expect(
      readFileSync(OPENAPI_PATH, 'utf8') === generated,
      `${OPENAPI_PATH} is stale; run npm run openapi:generate`
    ).toBe(true);
  });

  it('documents method, path, auth and status codes for every route', () => {
    const doc = JSON.parse(readFileSync(OPENAPI_PATH, 'utf8')) as {
      openapi: string;
      paths: Record<
        string,
        Record<
          string,
          { security: unknown[]; responses: Record<string, unknown> }
        >
      >;
    };
    expect(doc.openapi).toBe('3.1.0');
    const operations = Object.entries(doc.paths).flatMap(([path, methods]) =>
      Object.entries(methods).map(([method, op]) => ({ path, method, op }))
    );
    expect(operations.length).toBe(mountedRouteKeys().length);
    for (const { path, method, op } of operations) {
      expect(Array.isArray(op.security), `${method} ${path} security`).toBe(
        true
      );
      expect(
        Object.keys(op.responses).length,
        `${method} ${path} responses`
      ).toBeGreaterThan(0);
    }
    const me = doc.paths['/v2/auth/me']?.get;
    expect(me?.security).toEqual([{ cookieAuth: [] }]);
    expect(doc.paths['/v2/public/communities']?.get?.security).toEqual([]);
  });
});
