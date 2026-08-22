# Phase 1 — Fastify → Hono Migration

**Status:** Active foundation in PR #132  
**Authority:** Execution plan subordinate to `docs/SPEC-V2.md`  
**Last reviewed:** 2026-08-22

## Goal

Move the HTTP transport from Fastify to Hono on Node.js first, without changing the approved V2 product contract. Fastify V1 remains available during coexistence while Hono V2 proves behavioral parity for in-scope legacy Rails capabilities.

Phase 1 is a transport migration, not the Cloudflare deployment phase and not permission to preserve V1 scope that `SPEC-V2.md` explicitly removes.

## Constraints

- Fastify V1 remains under `/api/v1/` during coexistence.
- Hono V2 uses the `/v2/` namespaces defined by `SPEC-V2.md`.
- Existing service/repository/domain behavior should be reused rather than duplicated in transport handlers.
- Hono migration must not introduce PostgreSQL-only behavior; the V2 destination remains portable to D1/SQLite and PostgreSQL.
- No PostGIS dependency or removed elder/cultural-metadata scope may be preserved merely because old V1 code/tests contain it.
- Node.js + `@hono/node-server` is the Phase 1 runtime. Workers/D1/R2 adaptation follows after the Hono contract is proven.

## Architecture

The following is the Phase 1 coexistence layout implemented by PR #132, not the current tree on `main` while that PR remains open.

```text
src/
├── routes/              Fastify V1 routes
│   └── hono/            Hono V2 routes
├── services/            shared business logic
├── repositories/        shared data access
├── shared/              shared schemas/auth/session abstractions
├── hono-app.ts           Hono application builder
└── server.ts             coexistence runtime
```

Hono state uses typed context variables rather than request mutation. Session handling uses an abstraction: development/test may use memory, but production session backends are owned by the production-readiness auth work.

## Contract-testing rule

The decisive gate is a **transport-neutral contract suite**:

- the same normative behavioral assertions run against Fastify and Hono;
- intentional V1/V2 namespace/shape differences are explicitly mapped;
- V1 behavior removed by the canonical V2 spec is explicitly marked out of scope rather than copied into Hono;
- unexpected status/body/error/header/cookie/pagination/content-type differences fail the test;
- a real HTTP smoke test exercises the Hono Node server in addition to in-process requests.

Diagnostic comparison code that only prints mismatches is not parity evidence. Issue #134 owns turning this into a fail-closed shared harness; #145/#146 own domain-complete parity after that foundation.

## Migration domains

PR #132 establishes Hono routing patterns across the current route families, including:

- health/error handling;
- auth/session middleware and auth routes;
- themes;
- public API;
- places;
- stories;
- speakers;
- communities;
- users;
- files/media;
- member routes;
- super-admin routes;
- dev/test-only routes with production gating.

## Hono-specific invariants

- Register static routes such as `/search`, `/stats`, and `/near` before `/:id` routes.
- Parse a request body once and validate the parsed value once.
- Cookie signing/session semantics must be explicit and contract-tested.
- Web `Request`/`Response` and multipart behavior must not accidentally change V1-compatible semantics.
- Dev/test routes must be impossible to expose unintentionally in production.

## Phase 1 exit gate

Phase 1 is complete only when, on the exact merge candidate:

1. The deterministic baseline owned by #133 is trustworthy.
2. The fail-closed shared contract harness owned by #134 proves both transports.
3. All in-scope migrated domains have normative Hono parity; removed V1 scope is explicitly mapped rather than reproduced.
4. Auth/data-sovereignty and file negative paths are covered.
5. Hono real-HTTP startup/request behavior passes.
6. Required type, lint, format, test/coverage, and build gates are green without masked failures.
7. `/api/v1` remains intact for coexistence until an explicitly approved cutover.
8. The merge candidate remains consistent with `SPEC-V2.md` and the production-readiness roadmap.

After Phase 1 merges, Hono-specific production hardening proceeds through the dependency/readiness ordering in GitHub rather than growing this foundation PR into a production mega-PR.
