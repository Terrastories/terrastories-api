# Phase 1 — Fastify → Hono Migration

**Status:** Thin foundation replacing superseded PR #132
**Authority:** Execution plan subordinate to `docs/SPEC-V2.md`  
**Last reviewed:** 2026-11-11

## Goal

Move the HTTP transport from Fastify to Hono on Node.js and Workers, without treating Fastify or legacy Rails as the final V2 contract. Fastify V1 remains available during coexistence so existing development can continue while Hono converges on the approved V2 behavior.

Phase 1 is a transport foundation, not the production cutover phase and not permission to preserve V1 scope that `SPEC-V2.md` removes.

## Constraints

- Fastify V1 remains under `/api/v1/` during coexistence.
- Hono V2 follows the namespaces and behavior defined by `SPEC-V2.md`; if coexistence routes that conflict with the approved contract, follow-up work must deliberately converge them rather than freezing them as compatibility requirements.
- Existing service/repository/domain behavior may be reused when it is aligned with the canonical V2 contract; code that encodes removed or superseded V1 concepts must not become the V2 oracle.
- Hono migration must not introduce PostgreSQL-only behavior; the V2 destination remains portable to D1/SQLite and PostgreSQL.
- No PostGIS dependency or removed elder/cultural-metadata scope may be preserved merely because old V1 code/tests contain it.
- The foundation runs on Node.js and Workers with D1/R2 bindings. Hosted launch targets Workers Free; #194 measures the authentication method before release.

## Architecture

The thin foundation is opt-in and leaves `src/server.ts` and Fastify unchanged:

- `src/hono-app.ts`: Web Request/Response app factory and transport handlers.
- `src/services/hono-foundation.service.ts`: password/session/media policy.
- `src/repositories/hono-foundation.repository.ts`: shared dialect-aware persistence.
- `src/hono-server.ts`: loopback Node listener and filesystem adapter.

Run migrations with `npm run db:migrate`, create the configured storage directory,
then use `npm run dev:hono` (HTTP, loopback port 3001) or `npm run build` followed by
`npm run start:hono` (Secure cookies; place behind same-origin HTTPS). Set
`HONO_PORT` and `HONO_STORAGE_ROOT` as needed. Behind a TLS proxy, set
`HONO_PUBLIC_ORIGIN` to the exact browser origin (for example
`https://api.example.org`); forwarded headers are not trusted for CSRF policy.
`HONO_CORS_ORIGINS` is a comma-separated exact-origin allowlist, empty by default;
the Worker uses `PUBLIC_ORIGIN` and `CORS_ORIGINS` bindings with the same policy.
No wildcard origin is accepted. Fastify runs separately.
The request path uses Web APIs; Node filesystem/password/server dependencies
live behind injected adapters. `src/worker.ts` wires primary-current D1 sessions
and streams R2 media. Its default verifier fails closed with 503 pending the
Workers Free auth design and #194 measurements; this does not block foundation
integration or claim production login readiness.
The Node runner must not expose files through an unauthenticated static server.

Foundation routes: `/health`, `/ready`, `/v2/auth/login`, `/v2/auth/me`,
`/v2/auth/logout`, `/v2/auth/revoke` (all sessions of the current actor), and
`/v2/media/:id`. Login accepts JSON `{email, password, communityId?}`; ambiguous
cross-community matches fail. This transitional exact-email resolver does not
claim canonical username/normalized-email support (#137).

Opaque random session tokens are stored only as SHA-256 digests. Cookies are
HttpOnly, SameSite=Strict, Secure by default, with a fixed eight-hour lifetime.
Every request reads authoritative DB state. A role, community, or password change
permanently revokes affected sessions through DB triggers; logout deletes one session, revoke
all deletes the actor's sessions. DB errors fail closed with a content-free 503.
Login rotates the supplied identifier. Browser mutations require the configured public origin or explicit CORS allowlist.
No idle renewal, password reset, key rotation, cleanup scheduler, rate-limit
policy, or full identity resolver is claimed here; #137/#138 own those gates.
Node Rails bcrypt verification is RETAIN behind `PasswordVerifier`; Workers
verification awaits the auth design/#194. Current-policy upgrades remain #137.
Unsupported hash formats fail closed, including deferred Fastify Argon2id.

The only media case is active community branding through an explicit
`community_media` relation. Same-community canonical roles may download it;
system admins, mismatched tenants, unbound files, and unresolved legacy
restriction metadata fail closed. Storage keys must be under
`communities/<id>/`; existing files/URLs are not silently reclassified.
The relation is additive; no legacy rows, fields, or bytes are deleted.
All other media-owner policies remain #140 work. Responses prohibit caching.

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

PR #132 is superseded. This replacement is limited to health/readiness,
Rails-bcrypt login, durable sessions/revocation, and one protected media read.
The remaining domains follow in #134/#145/#146 after this foundation; do not
harvest all fourteen route families into this slice.

The shared `scripts/hono-foundation-contract.ts` drives a
`(request: Request) => Promise<Response>` boundary. Both database gates execute
it against migrated databases, including restart, tampering, authorization-state
changes, tenant isolation, and a real Node HTTP smoke request.

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

The thin replacement for superseded PR #132 may merge before the broader Phase 1 exit gate is complete; #134/#145/#146 follow on that base. Hono-specific production hardening proceeds through the dependency/readiness ordering in GitHub rather than growing this foundation PR into a production mega-PR.

## Portable persistence and runtime evidence

Session expiry uses integer Unix milliseconds on both backends, including exact
expiry-boundary comparisons. Sessions contain identifiers, a user reference,
and expiry only; current roles and community membership come from each DB read.
Login rotation is one bounded UPSERT, logout/revocation one DELETE. No shared
request path uses an interactive transaction or an unbounded multi-write loop;
future multi-row units must use a single bounded D1 batch.

The focused Workers test bundles without Node imports and runs in workerd with
real local D1/R2 bindings. It does not establish deployed Workers Free CPU limits.
The slice installs no content/request logger; errors contain no credential,
media, story-title, or other cultural payload.
