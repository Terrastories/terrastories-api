import { createHonoApp } from '../../src/hono-app.js';
import type { HonoFoundationRepository } from '../../src/repositories/hono-foundation.repository.js';
import { routeKey } from './registry.js';

/**
 * Concrete (method + path) routes the Hono app mounts. Registration in
 * createHonoApp is unconditional, so stub collaborators cannot change the
 * table (same approach as honoPersonaRouteTable in scripts/qa/hono-fixture.ts).
 * `app.all` middleware entries are not API operations and are skipped.
 */
export function mountedRouteKeys(): string[] {
  const app = createHonoApp({
    repository: { connection: null } as unknown as HonoFoundationRepository,
    storage: {
      async read() {
        return null;
      },
    },
  });
  const keys = new Set<string>();
  for (const route of app.routes) {
    if (route.method === 'ALL') continue;
    keys.add(routeKey(route.method, route.path));
  }
  return [...keys].sort();
}
