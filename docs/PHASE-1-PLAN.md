# Phase 1: Fastify → Hono Migration Plan (Codex-Reviewed)

## Goal

Migrate the Terrastories API from Fastify 5 to Hono while keeping PostgreSQL + local filesystem.
The API must remain functionally identical — the V1 compatibility suite (195 tests across 12 domains) must pass against the new Hono implementation.

## Constraints

- **Dual coexistence**: V1 (Fastify) routes stay at `/api/v1/` while V2 (Hono) routes go to `/v2/`. Both work during migration.
- **No source behavior changes**: Rewriting the transport layer, not business logic. Services, repositories, schemas stay as-is.
- **Compatibility suite is the gate**: The existing 195-test suite must pass against Hono, not just Fastify.
- **Node.js first**: Hono runs on `@hono/node-server`. No Workers code yet (Phase 3).

## Architecture Decisions

### 1. Coexistence Strategy
Both apps coexist during migration. Fastify `/api/v1` stays running. Hono `/v2` routes built incrementally. Final gate: Hono passes the same compatibility suite.

### 2. App Structure
```
src/
  app.ts              → re-exports active app (Fastify during migration, Hono after cutover)
  fastify-app.ts      → existing Fastify buildApp(), renamed
  hono-app.ts         → new: Hono app builder
  server.ts           → serves active app
  routes/
    index.ts          → existing Fastify route registration (unchanged)
    hono/             → Hono route files
      index.ts
      ...
  shared/
    middleware/
      hono-auth.middleware.ts  → Hono-compatible auth middleware
      auth.middleware.ts       → existing Fastify middleware (unchanged)
```

### 3. Hono Auth Middleware (Codex-corrected)
Use Hono `Variables` for typed context state:
```ts
type AppVariables = {
  user: SessionUser;
  sessionId: string;
};
const app = new Hono<{ Variables: AppVariables }>();
// c.set('user', user) — NOT request mutation
```

### 4. Session Management (Codex-corrected)
- Opaque signed session ID cookie (HMAC with existing session secret)
- Server-side session store: in-memory for dev/test, interface ready for KV later
- `HttpOnly`, `SameSite`, `Secure` per current config
- Multiple concurrent sessions per user supported
- Logout deletes only current session ID
- NOT a full user object in a cookie

### 5. OpenAPI (Codex-corrected — deferred)
Use plain Hono routes with manual `schema.safeParse()` first. Add `@hono/zod-openapi` after 2-3 domains are stable and behavior is proven.

### 6. Parameterized Tests (Codex-corrected)
Do NOT fork into `tests/comparison-v2/`. Parameterize existing suite so same assertions run against both Fastify and Hono with different app factories/prefixes.

## Implementation Steps (Codex-corrected order)

### Step 1: Install Dependencies + Setup
- `npm install hono @hono/node-server`
- Create `src/hono-app.ts` skeleton

### Step 2: Health + Error Handling + Test Harness
- Health route (trivial, no auth)
- `app.onError()` + `app.notFound()`
- Hono test helper (createHonoTestApp)
- Parameterized compatibility harness

### Step 3: Session Store + Auth Routes + Auth Middleware
- SessionStore interface + MemoryStore implementation
- Signed cookie helper
- Hono auth middleware: requireAuth, requireRole, requireAdmin, requireSuperAdmin
- requireCommunityAccess, enforceDataSovereignty
- Auth routes: register, login, logout, me

### Step 4: One Protected CRUD Domain (Themes)
- Establishes the CRUD pattern for all remaining routes
- Tests validate against V1 behavior

### Step 5: Public API
### Step 6: Places (CRUD + spatial)
### Step 7: Stories (CRUD + complex relations)
### Step 8: Speakers (CRUD + search)
### Step 9: Communities
### Step 10: Users + role management
### Step 11: Files (upload/serve/delete — multipart)
### Step 12: Member routes
### Step 13: Super Admin
### Step 14: Dev routes (gated/test-only)

## Hono-Specific Gotchas (from Codex)

1. **Route order**: Register static routes (`/search`, `/stats`, `/near`) before `/:id`
2. **`c.req.json()` consumed once**: Parse once, validate once
3. **Cookie signing not automatic**: Need explicit HMAC compatibility code
4. **File responses**: Web `Request`/`Response` differ from Fastify reply streams
5. **`c.req.parseBody()` buffers multipart**: Acceptable for Phase 1 with limits enforced
6. **Middleware via route groups**: `app.use('/v2/*', middleware)` or route groups, not per-route

## Success Criteria (Codex-corrected)

1. Same compatibility suite runs against both Fastify and Hono
2. Hono passes all 195 compatibility tests
3. Auth/session tests cover login, logout, invalid cookie, concurrent sessions, role gates, data sovereignty
4. Multipart upload/download/delete tests pass on Hono
5. `npm test`, `npm run build`, `npm run lint`, and `npm run test:coverage` pass
6. Hono Node server smoke test passes through real HTTP
7. `/api/v1` behavior remains available during migration
8. `/v2` namespace matches spec: `/v2/api`, `/v2/member`, `/v2/admin`
