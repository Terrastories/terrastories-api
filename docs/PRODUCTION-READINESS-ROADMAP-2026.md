# Terrastories API Production Readiness Roadmap (2026)

## Status

**Current assessment: active migration / pre-production.**

Historical 2025 documents describe the Fastify TypeScript API as production-ready, but V2 introduces a Fastify-to-Hono migration and therefore needs a new production-readiness proof. Production readiness is a property of a specific revision and deployment configuration, not a permanent repository label.

Current baseline as of 2026-08-22:

- `main` still runs Fastify V1; the Phase 1 Hono foundation is pending in PR #132. Hono-specific audit evidence must therefore be bound to that PR's exact head rather than described as current `main` state.
- Issue #133 landed in PR #152 on 2026-08-21, restoring `validate:ci` as a terminating fail-closed aggregate gate, bounded deterministic test shards, zero-warning lint, separate source coverage, repaired compatibility scripts, and an expiring fail-closed dependency-audit baseline.
- PR #152's final candidate passed five consecutive complete CI workflows on one SHA without retries; the latest three satisfied #133's deterministic-baseline exit criterion. Its local evidence included 1,682/1,682 Vitest tests plus 18/18 workflow shell contracts.
- On that same candidate, API comparison passed 203/203 plus report generation, and Docker development/production builds, Compose base/dev/prod/field-kit validation, Docker integration, and user-workflow/data-sovereignty scenarios were green.
- PostgreSQL fresh/upgrade migration parity remains separately owned by #135. V2 does not depend on PostGIS, and SQLite migrations must not be run against PostgreSQL.
- Existing dependency debt remains tracked by #141; the audit baseline is explicitly expiring rather than silently accepting new advisories.
- Hono transport parity, production session storage, CORS, and other Hono-specific readiness claims must be re-audited against the exact PR #132 revision before Phase 1 can exit.

## Production definition of done

A Terrastories API revision is production-ready only when all of the following are simultaneously true:

1. The intended production transport is explicit and all public API contracts are tested against it.
2. All required tests are deterministic and green on the exact release revision.
3. Both first-class database targets — SQLite/D1-compatible behavior and PostgreSQL — prove shared schema, migration, repository, and portable spatial behavior. PostGIS is not a V2 dependency.
4. Authentication, authorization, community isolation, file isolation, and data sovereignty have comprehensive negative tests without reintroducing V1 scope that `SPEC-V2.md` explicitly removed.
5. Production sessions survive process restart and work correctly across multiple instances, or deployment is explicitly constrained to a single instance with a documented temporary risk acceptance.
6. CI fails closed: no security, startup, parity, migration, or required test failure can be hidden by `continue-on-error`, `|| true`, or equivalent logic.
7. Production images start, become ready, serve real requests, and shut down gracefully in an automated test.
8. Backups and restores are tested from production-like data; schema changes have an explicit rollback/restore or expand-contract strategy.
9. Logs, metrics, traces, and alerts are sufficient to diagnose failures without exposing secrets or sensitive cultural data.
10. A staged/canary deployment passes automated smoke, migration, security, and rollback checks before broad rollout.

## Phase 0 — Stabilize the deterministic validation baseline (P0) — complete

**Goal:** make the canonical format/type/lint/test/build validation signal trustworthy before adding more migration surface.

**Status:** Completed by issue #133 / PR #152 on 2026-08-21 for the canonical deterministic validation baseline. Other CI hardening remains owned by later phases; in particular, Phase 6 still owns removing soft-fail masking from production-container startup and other required deployment/security checks.

### Work

- Fix or explicitly quarantine with tracked issues every reproducible full-suite failure. Do not silently exclude failing production-relevant tests.
- Repair/remove stale package scripts (`test:ci`, `test:compatibility`, `compatibility:report`) so every advertised command is executable.
- Add a single terminating `validate:ci` command that runs format check, type-check, lint, required test shards, and build.
- Make lint warnings actionable: fail on new warnings immediately; drive existing warnings to zero before production cutover.
- Replace noisy/debug logging in tests and production paths with structured logger calls and safe redaction.
- Split the long suite into deterministic CI shards by domain so each job has bounded runtime and useful failure output.
- Add a flaky-test policy: no retries as a substitute for fixing nondeterminism; record and track any temporary quarantine with owner and expiry.

### Exit gate

- Three consecutive canonical validation workflow runs on the same revision are green without retries.
- No stale/broken validation scripts.
- No unowned quarantined production tests.

## Phase 1 — Make API compatibility executable (P0)

**Goal:** prove the Hono migration rather than infer it from smoke tests.

### Work

- Refactor the existing compatibility assertions into transport-neutral contract tests.
- Parameterize them over at least:
  - Fastify V1 app + V1 prefixes;
  - Hono V2 app + V2 prefixes.
- Create an explicit route/namespace mapping for intentional V1/V2 differences.
- Make unexpected status, response-body, error-envelope, pagination, header/cookie, and content-type differences fail tests.
- Convert the Rails/TypeScript response differ from an informational detector into a fail-closed parity gate for endpoints where Rails compatibility is still required.
- Add contract coverage for all Hono domains implemented by PR #132: health, auth, public API, themes, places, speakers, communities, stories, users, files, member, admin, and dev/test-only routes.
- Test route ordering for static routes vs `/:id` across every affected resource.
- Add real HTTP smoke tests against `@hono/node-server`, not only in-process `app.request()` calls.

### Exit gate

- The same contract suite passes against both Fastify and Hono for every migrated domain.
- No unexplained Rails/TypeScript mismatch remains for contracts declared compatible.
- Hono real-HTTP smoke tests pass.

## Phase 2 — Database and migration safety (P0)

**Goal:** prove production data can evolve without corruption or sovereignty violations.

### Work

- Add required PostgreSQL CI and a D1/SQLite-compatible CI path; shared database behavior must pass on both first-class targets.
- Run schema/repository/portable-spatial integration tests against both backends. Remove the legacy PostGIS bootstrap/verification/query branch and its dedicated test (`src/db/migrate.ts`, `src/db/index.ts`, `src/repositories/place.repository.ts`, `tests/db/postgis.test.ts`); V2 spatial behavior must remain portable application-level latitude/longitude logic.
- Converge the duplicated `pgTable`/`sqliteTable` schema definitions to the single portable schema required by FR-003, with backend-specific adapters only where the canonical spec permits them.
- Replace Worker-incompatible native dependencies used on shared V2 paths (including native `bcrypt`; `bcryptjs` is the canonical password-hashing dependency) and verify the resulting dependency graph on Workers and Node.
- Add migration tests for:
  - empty database -> latest;
  - previous release -> latest;
  - production-like fixture/snapshot -> latest;
  - idempotency where applicable;
  - constraints, indexes, foreign keys, defaults, timestamps, and portable latitude/longitude spatial behavior.
- Add data invariants for community IDs, ownership, file ownership, join tables, and Rails compatibility fields that remain in V2 scope.
- Require expand-contract migrations for risky changes: add/backfill/read-switch/remove rather than destructive one-step changes.
- Build automated backup + restore verification with checksums/counts and selected semantic invariants.
- Define RPO/RTO targets and prove them in a restoration drill.

### Exit gate

- PostgreSQL and D1/SQLite-compatible migration suites are mandatory and green for shared schema behavior.
- Restore drill succeeds from a production-like backup with documented timing and integrity checks.
- Every pending schema change has a reviewed migration and rollback/restore plan.

## Phase 3 — Authentication and session productionization (P0)

**Goal:** make auth safe across restarts, replicas, hostile inputs, and real browser behavior.

### Work

- Replace Hono `MemorySessionStore` with a production session backend appropriate to deployment (PostgreSQL/KV), with TTL and revocation semantics.
- Add tests for process restart, multi-instance access, concurrent sessions, logout-one-session, expiry, tampered cookies, key rotation, disabled users, and role/community changes during an active session.
- Define session-secret rotation with overlap and emergency revocation procedures.
- Review cookie flags for production (`Secure`, `HttpOnly`, `SameSite`, domain/path, lifetime).
- Replace wildcard CORS with an environment-validated allowlist. Never combine permissive wildcard behavior with credentialed production requests.
- Add rate limits to login, registration, password reset/recovery, uploads, and expensive spatial/search endpoints.
- Add CSRF protection or prove why the chosen cookie/API architecture does not require it for each state-changing browser flow.
- Ensure auth errors are consistent and do not leak user existence or sensitive internals.

### Exit gate

- Restart/multi-instance session tests pass.
- Security review has no open high/critical auth findings.
- Production CORS/cookie/CSRF/rate-limit configuration is explicit and tested.

## Phase 4 — Indigenous data sovereignty and cultural-protocol guardrails (P0)

**Goal:** make sovereignty protections invariants, not route-by-route conventions.

### Work

- Build a reusable authorization matrix covering the V2 roles defined by the canonical spec (anonymous/public behavior plus viewer, editor, admin, and super-admin as applicable) across communities.
- For every protected community-data endpoint, add cross-community negative tests and super-admin data-sovereignty restriction tests.
- Test list/search/stats/export/file endpoints for indirect leaks, not only direct `GET /:id` routes.
- Add property/invariant tests asserting a principal from community A cannot observe community B data unless the contract explicitly permits public data.
- Validate V2 public/private and community-ownership behavior consistently in nested relations, search, public API, files, and metadata; do not reintroduce elder-only/cultural-metadata scope removed by the V2 spec.
- Ensure audit logs capture security-relevant administrative actions while excluding cultural content bodies, credentials, tokens, and unnecessary PII.
- Add a release-blocking sovereignty suite independent from general unit coverage.

### Exit gate

- 100% of cultural-data route families are represented in the authorization matrix.
- No cross-community or super-admin cultural-data leak in automated adversarial tests.

## Phase 5 — File and media hardening (P0/P1)

**Goal:** safely handle the highest-risk untrusted input surface.

### Work

- Enforce upload size, MIME sniffing, extension/content agreement, allowed media types, filename normalization, and path traversal prevention.
- Add malformed multipart, oversized request, decompression/image-bomb, corrupted image, and unsupported media tests.
- Ensure community ownership is checked on metadata, download, transformed variants, and deletion.
- Test interrupted writes and cleanup of partial/orphan files.
- Define production storage durability, backup, retention, and migration semantics.
- If local filesystem remains supported, document single-host constraints and restore procedures; for multi-instance deployment, use shared/durable object storage or equivalent.

### Exit gate

- File security suite is mandatory and green.
- Production storage topology and backup/restore behavior are proven.

## Phase 6 — CI/CD and supply-chain guardrails (P0/P1)

**Goal:** ensure a green check really means a releasable revision.

### Work

- Remove soft-fail logic from required security and container startup checks.
- Make dependency audit blocking at an agreed severity; use an explicit reviewed allowlist with expiry for exceptions.
- Add secret scanning to CI and pre-commit/pre-push where practical.
- Add dependency review for PRs and automated update policy.
- Pin critical GitHub Actions to immutable commit SHAs where appropriate.
- Generate an SBOM and provenance/attestation for release images.
- Scan the built production image for known vulnerabilities.
- Make production container tests assert process liveness and `/health`/readiness rather than merely invoking `docker run`.
- Add branch protection requirements for the production gates.

### Exit gate

- No required check can pass after its underlying command failed.
- Release artifact has vulnerability scan, SBOM, and traceable source revision.

## Phase 7 — Runtime reliability and observability (P1)

**Goal:** make failures detectable, diagnosable, and recoverable in low-connectivity deployments.

### Work

- Separate liveness and readiness endpoints. Readiness must fail when required DB/storage dependencies are unavailable.
- Capture the Hono server handle and close it during graceful shutdown; test SIGTERM behavior and in-flight request draining.
- Add structured JSON logging with request IDs and redaction.
- Define metrics for request rate/error/latency, auth failures, DB pool, migration status, file operations, session store, and resource saturation.
- Add alert thresholds and runbooks for DB unavailable, storage unavailable, elevated 5xx, backup failure, disk pressure, and migration failure.
- Ensure monitoring can operate locally/offline for field-kit deployments and does not require exporting sensitive community data.
- Add disk-full, DB-restart, storage-error, and process-restart resilience tests.

### Exit gate

- Operators can identify and recover from defined failure scenarios using documented runbooks.
- Graceful shutdown and dependency-failure tests pass.

## Phase 8 — Performance, capacity, and abuse testing (P1)

**Goal:** replace historical performance claims with reproducible release benchmarks.

### Work

- Create versioned load scenarios for reads, writes, auth, search, spatial queries, and uploads.
- Benchmark both PostgreSQL and D1/SQLite-compatible paths with production-like indexes and data volume; spatial scenarios must use the portable V2 implementation.
- Track p50/p95/p99 latency, throughput, error rate, CPU, memory, DB connections, and disk/storage behavior.
- Add large-dataset tests for pagination and spatial bounding/near queries.
- Test rate-limit behavior and resource exhaustion under abusive patterns.
- Define separate capacity profiles for server deployments and constrained field kits.

### Exit gate

- SLOs and capacity limits are documented and reproducible from CI/staging scripts.
- No unbounded query/upload path can trivially exhaust the deployment.

## Phase 9 — Staging, canary, rollback, and release evidence (P0 for launch)

**Goal:** make production deployment reversible and evidence-based.

### Work

- Provision representative validation/staging for all supported deployment modes: Cloudflare Workers + D1 + R2, Node.js + PostgreSQL/self-hosted storage, and offline Node.js + SQLite field kit.
- Seed anonymized/representative data, including multilingual, public/private, and cross-community isolation cases within V2 scope.
- Run migration, contract, sovereignty, file-security, load-smoke, and backup/restore suites against each applicable profile.
- Deploy immutable, traceable artifacts: image digest for containerized Node deployments and an immutable Worker deployment/version identity for Cloudflare.
- Add canary/pilot rollout with health/error/latency gates and a documented abort threshold where the deployment platform supports it.
- Rehearse application rollback and database restore/forward-fix paths appropriate to D1, PostgreSQL, and field-kit SQLite.
- Generate a release evidence bundle: commit SHA, artifact/deployment identity, migration version, test results, security scan, SBOM/provenance where applicable, backup verification, reviewer sign-off, and known accepted risks.

### Exit gate

- Staging passes the complete production gate on the exact release artifact.
- Rollback/restore rehearsal succeeds.
- Pilot/community deployment has explicit human approval before wider rollout.

## Recommended execution order

1. **Baseline trust:** Phase 0.
2. **Hono correctness:** Phase 1.
3. **Data safety:** Phase 2.
4. **Auth/session + sovereignty:** Phases 3 and 4 in parallel where independent.
5. **Files + CI supply chain:** Phases 5 and 6.
6. **Operations + performance:** Phases 7 and 8.
7. **Release:** Phase 9.

Do not cut over production traffic from Fastify to Hono before Phases 0-4 and the relevant Phase 5/6 P0 items are complete.

## Suggested issue/PR slicing

Keep changes reviewable and independently verifiable. A practical sequence is:

1. CI truthfulness + broken scripts.
2. Full-suite stabilization/test isolation.
3. Shared Fastify/Hono contract harness.
4. Hono contract parity domain-by-domain.
5. Mandatory dual-backend CI for D1/SQLite-compatible behavior and PostgreSQL.
6. Migration/restore test harness.
7. Persistent Hono session store + restart/multi-instance tests.
8. CORS/cookie/CSRF/rate-limit hardening.
9. Sovereignty authorization matrix + adversarial tests.
10. File/media hardening.
11. Container/startup/shutdown/readiness hardening.
12. Supply-chain/SBOM/image scanning.
13. Observability/runbooks/failure injection.
14. Load/capacity suite.
15. Staging/canary/release-evidence automation.

Every PR should run the Terrastories `pr-cycle` skill and must leave the repository's production-readiness evidence stronger than it found it.
