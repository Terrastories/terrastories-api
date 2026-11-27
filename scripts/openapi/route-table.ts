import { createHonoApp } from '../../src/hono-app.js';
import type { HonoFoundationRepository } from '../../src/repositories/hono-foundation.repository.js';
import { routeKey } from './registry.js';

export interface MountedRoute {
  key: string;
  method: string;
  path: string;
  /** True when the route is registered behind the `/v2/*` session gate. */
  secured: boolean;
}

/**
 * Concrete (method + path) routes the Hono app mounts, with the session
 * requirement derived from registration order: Hono runs middleware and
 * handlers in registration order, so a `/v2/*` route registered after the
 * `app.use('/v2/*')` session gate is behind it (anonymous callers get 401),
 * and one registered before it bypasses it. Registration in createHonoApp is
 * unconditional, so stub collaborators cannot change the table (same
 * approach as honoPersonaRouteTable in scripts/qa/hono-fixture.ts).
 * `app.all` middleware entries are not API operations and are skipped.
 */
export function mountedRoutes(): MountedRoute[] {
  const app = createHonoApp({
    repository: { connection: null } as unknown as HonoFoundationRepository,
    storage: {
      async read() {
        return null;
      },
    },
  });
  const gate = app.routes.findIndex(
    (route) => route.method === 'ALL' && route.path === '/v2/*'
  );
  if (gate < 0) throw new Error('The /v2/* session gate is not registered');
  const seen = new Map<string, MountedRoute>();
  app.routes.forEach((route, index) => {
    if (route.method === 'ALL') return;
    const key = routeKey(route.method, route.path);
    if (seen.has(key)) return;
    seen.set(key, {
      key,
      method: route.method,
      path: route.path,
      secured: route.path.startsWith('/v2/') && index > gate,
    });
  });
  return [...seen.values()].sort((a, b) => compareCodeUnits(a.key, b.key));
}

export const compareCodeUnits = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

export function mountedRouteKeys(): string[] {
  return mountedRoutes().map((route) => route.key);
}
