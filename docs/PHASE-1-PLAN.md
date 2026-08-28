# Phase 1 — Fastify → Hono Migration

**Status:** Active foundation in PR #132  
**Authority:** Execution plan subordinate to `docs/SPEC-V2.md`  
**Last reviewed:** 2026-08-28

## Goal

Move the HTTP transport from Fastify to Hono on Node.js first, without treating Fastify or legacy Rails as the final V2 contract. Fastify V1 remains available during coexistence so existing development can continue while Hono converges on the approved V2 behavior.

Phase 1 is a transport foundation, not the Cloudflare deployment phase and not permission to preserve V1 scope that `SPEC-V2.md` removes.

## Constraints

- Fastify V1 remains under `/api/v1/` during coexistence.
- Hono V2 follows the namespaces and behavior defined by `SPEC-V2.md`; if PR #132 currently exposes temporary/coexistence routes that conflict with the approved contract, follow-up work must deliberately converge them rather than freezing them as compatibility requirements.
- Existing service/repository/domain behavior may be reused when it is aligned with the canonical V2 contract; code that encodes removed or superseded V1 concepts must not become the V2 oracle.
- Hono migration must not introduce PostgreSQL-only behavior; the V2 destination remains portable to D1/SQLite and PostgreSQL.
- No PostGIS dependency or removed elder/cultural-metadata scope may be preserved merely because old V1 code/tests contain it.
- Node.js + `@hono/node-server` is the Phase 1 runtime. Workers/D1/R2 adaptation follows after the Hono foundation is stable.

## Architecture

The following is the Phase 1 coexistence layout implemented by PR #132, not the current tree on `main` while that PR remains open.

```text
src/
├── routes/              Fastify V1 routes
│   └── hono/            Hono V2 routes
├── services/            shared/aligned business logic
├── repositories/        shared/aligned data access
├── shared/              shared schemas/auth/session abstractions
├── hono-app.ts           Hono application builder
└── server.ts             coexistence runtime
```

Hono state uses typed context variables rather than request mutation. Production session/storage/database behavior is owned by the canonical V2 adapters and production-readiness work.

## Contract-testing rule

The decisive destination gate is a **canonical V2 contract suite**:

- approved V2 assertions fail closed against Hono;
- during coexistence, the same assertions may also execute against Fastify where meaningful to expose accidental regressions or unclassified legacy behavior;
- Fastify/Rails behavior does not become normative solely because a comparison detects a difference;
- every material legacy/V1 difference is classified as RETAIN, IMPROVE, ARCHIVE, DROP, or DEFER under `SPEC-V2.md`;
- unexpected mismatch against the approved V2 status/body/error/header/cookie/pagination/content-type contract fails;
- a real HTTP smoke test exercises the Hono Node server in addition to in-process requests.

Diagnostic comparison code that only prints mismatches is discovery evidence, not a release gate. Issue #134 must be revised from "Fastify/Hono parity" into the fail-closed canonical V2 contract foundation; #145/#146 must prove domain completeness against that contract.

## Migration domains

PR #132 establishes Hono routing patterns across current route families, including:

- health/error handling;
- auth/session middleware and auth routes;
- themes/map configuration;
- public API;
- places;
- stories;
- speakers;
- communities;
- users;
- files/media;
- community-member routes;
- super-admin routes;
- dev/test-only routes with production gating.

These route families are implementation scaffolding. Their final names/shapes must converge on `SPEC-V2.md` rather than becoming canonical through first implementation.

## Hono-specific invariants

- Register static routes such as `/search`, `/stats`, and `/near` before `/:id` routes.
- Parse a request body once and validate the parsed value once.
- Cookie signing/session semantics must be explicit and contract-tested.
- Web `Request`/`Response` and multipart behavior must satisfy the canonical V2 contract.
- Dev/test routes must be impossible to expose unintentionally in production.
- Community identity and authorization must come from explicit actor/tenant context where possible, not repeated caller-supplied tenant identifiers.

## Phase 1 exit gate

Phase 1 is complete only when, on the exact merge candidate:

1. The deterministic baseline owned by #133 is trustworthy.
2. The fail-closed contract harness owned by revised #134 proves canonical V2 behavior and detects deliberate test mismatches.
3. All in-scope Hono route families have a documented disposition against `SPEC-V2.md`; no route is accepted merely because it matches Fastify.
4. Removed V1 scope is absent from the V2 destination and any data-bearing legacy values are handled by the migration contract rather than runtime compatibility fields.
5. Auth/data-sovereignty and file negative paths are covered.
6. Hono real-HTTP startup/request behavior passes.
7. Required type, lint, format, test/coverage, and build gates are green without masked failures.
8. `/api/v1` remains intact for temporary coexistence until an explicitly approved cutover.
9. The merge candidate remains consistent with `SPEC-V2.md` and the production-readiness roadmap.

After Phase 1 merges, Hono-specific production hardening proceeds through the dependency/readiness ordering in GitHub rather than growing this foundation PR into a production mega-PR.
