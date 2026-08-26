# Terrastories API — Agent Guidelines

This file is the repository-wide execution contract for coding agents. Provider-specific entrypoints such as `CLAUDE.md` must point here rather than duplicate these rules.

## 1. Read the source of truth first

Before planning, editing, reviewing, or implementing an issue:

1. Read `docs/SOURCE-OF-TRUTH.md`.
2. Read the governing sections of `docs/SPEC-V2.md`.
3. For Hono migration work, read the relevant part of `docs/PHASE-1-PLAN.md`.
4. For production-hardening/release work, read the relevant part of `docs/PRODUCTION-READINESS-ROADMAP-2026.md`.
5. Read the complete GitHub issue/PR and current code/tests.

The canonical product/architecture specification outranks roadmaps, issues, code, and tests. If they conflict, do not silently normalize the conflict: resolve the spec relationship before implementation.

### Non-negotiable V2 invariants

- Hono is the target HTTP framework for Cloudflare Workers and Node.js.
- The same application must support three first-class deployment modes:
  - Cloudflare Workers + D1 + R2;
  - Node.js + PostgreSQL + local/self-hosted storage;
  - Node.js + SQLite + local filesystem for offline field kits.
- D1/SQLite and PostgreSQL are equal first-class database targets for shared behavior.
- Shared schema/query behavior must remain SQLite-compatible. PostgreSQL-specific behavior must not become the product contract.
- PostGIS/database-specific spatial extensions are a V2 non-goal. Spatial behavior uses portable latitude/longitude logic unless the canonical spec is explicitly amended.
- V2 targets legacy Rails feature parity, with intentional URL/shape differences explicitly mapped.
- New product features beyond approved parity are out of scope unless separately approved.
- V1 scope creep removed by V2 must not be reintroduced indirectly: no elder role/elder-only restrictions, elder speaker status, cultural-significance metadata, community cultural settings, story-place cultural context, or removed cultural-restriction schema unless the spec is deliberately amended.
- Community data isolation and Indigenous data sovereignty are mandatory. Super admins may manage system-level users/communities but cannot gain access to protected community content merely because they are privileged administrators.
- Field-kit functionality must remain fully usable offline without runtime cloud dependencies.

## 2. Spec-drift preflight

For every non-trivial task, record:

1. Governing spec section(s).
2. Whether the issue/plan/code conflicts with them.
3. Impact on D1/SQLite, PostgreSQL, and field-kit portability.
4. Whether the task is parity/hardening or an unapproved new feature.
5. The observable tests/evidence required to prove completion.

Use `.agents/skills/spec-guard/SKILL.md` when the task touches architecture, deployment, database behavior, sovereignty, scope, or when any conflict is suspected.

Verdicts are:

- `ALIGNED — READY`
- `ALIGNED — BLOCKED`
- `SPEC DECISION REQUIRED`

Do not implement source changes under `SPEC DECISION REQUIRED`.

## 3. Repository structure

- `src/routes/`: current Fastify V1 routes on `main`; Phase 1 Hono V2 transport work is pending in PR #132.
- `src/server.ts`: current Fastify runtime entrypoint on `main`; Hono coexistence begins only when PR #132 lands.
- `src/services/`: business logic.
- `src/repositories/`: data access.
- `src/db/`: Drizzle database setup, schemas, migrations, seeds.
- `src/shared/`: middleware, schemas, session/config utilities, types.
- `tests/`: unit, integration, comparison/contract, security, production, and DB tests.
- `.agents/skills/`: repository-owned repeatable agent workflows.
- `docs/`: only canonical/current project context and active plans.

Keep Route → Service → Repository → Database separation. Avoid business logic in transport handlers and direct ad-hoc DB access from routes.

## 4. Work safely in a multi-agent repository

- Inspect the current branch/worktree and existing changes before editing.
- Never overwrite, reset, stash, clean, stage, commit, or delete unrelated user/agent work.
- Prefer an isolated worktree/branch for each implementation issue.
- Respect issue readiness labels:
  - `status:ready`: safe to start from its documented base;
  - `status:blocked`: prerequisite/base dependency must be satisfied first;
  - `status:needs-decision`: no implementation until the decision is resolved.
- Hono-specific follow-up work must not independently recreate PR #132 from `main`; follow the issue's documented base/stacking dependency.
- Stage intentional files explicitly. Do not use broad staging that captures unrelated work.

## 5. Development loop

For non-trivial code changes use TDD where practical:

1. Reproduce/encode the expected behavior in a focused failing test.
2. Implement the smallest correct change.
3. Run the focused test in terminating mode.
4. Refactor without changing behavior.
5. Run broader relevant gates.
6. Re-read the issue/spec acceptance criteria before declaring completion.

Do not weaken, skip, exclude, or convert a production-relevant failing test into retries just to obtain green CI. Temporary quarantine requires a tracked issue, owner, rationale, and expiry.

## 6. Validation commands

Autonomous/CI work must use terminating test commands, not Vitest watch mode.

Typical gates:

```bash
npm run validate:ci
npm run test:coverage
npm run test:compatibility
```

Run the smallest affected terminating test set first, then the broader required suite. Issue #133 landed in PR #152: `npm run validate:ci` is the canonical terminating aggregate gate, `npm run validate` is its alias, and `npm run test:ci` executes the bounded deterministic full-suite shards. Coverage and API compatibility remain separate gates so neither can hide full-suite failures. Do not treat a configured script as proof unless it actually completes successfully on the revision being reviewed.

### API migration/parity

- Hono smoke tests are necessary but not sufficient.
- Migrated behavior must run through the same transport-neutral contract assertions against Fastify V1 and Hono V2.
- Unexpected status/body/error/header/cookie/pagination/content-type differences must fail.
- Intentional V1/V2 differences and removed V1 scope must map explicitly to `SPEC-V2.md`; do not preserve stale behavior simply because an old test expects it.

### Database/schema/migrations

For shared DB behavior, evidence from only one backend is insufficient.

Require appropriate D1/SQLite-compatible **and** PostgreSQL evidence for:

- shared repository/query semantics;
- fresh/upgrade migrations;
- constraints, indexes, defaults, foreign keys, transactions, timestamps, ordering/pagination, null/unique behavior;
- data preservation;
- portable spatial behavior.

Never add PostGIS to satisfy an old test or historical document. Risky/destructive migrations require expand-contract or an explicit tested backup/restore/forward-fix strategy.

### High-risk surfaces

Auth, sessions, files/media, migrations, community isolation, public/private visibility, exports, and super-admin boundaries require negative/adversarial tests as well as success paths.

At minimum consider:

- unauthenticated/unauthorized requests;
- cross-community access and indirect leaks via lists/counts/metadata/files;
- session expiry/revocation/tampering/restart behavior;
- file MIME/size/path/content hazards and ownership;
- secrets/session IDs/protected content absent from logs/errors;
- dependency outage/failure behavior where relevant.

## 7. CI and PR evidence

Required gates fail closed. A check masked by `continue-on-error`, `|| true`, `|| echo`, retries-only behavior, or a diagnostic that merely prints mismatches is not green evidence.

Dependency-audit baselines are inventories of explicitly accepted debt, not a place to absorb newly published advisories for convenience. A new advisory must fail closed. Trace the exact dependency path and prefer, in order: removing an unused dependency, applying a compatible fixed version, or performing a justified upgrade. Do not widen the baseline for a fixable advisory merely to restore green CI.

For a full PR lifecycle use `.agents/skills/pr-cycle/SKILL.md`.

Merge readiness is bound to an exact PR head SHA and current base-tip SHA. Any new push or base movement invalidates prior review/readiness evidence.

Never merge unless the user explicitly authorizes merge. A request for a PR cycle authorizes fixes/reviews/pushes, not merge by itself.

An authorized merge is not the end of validation when the target branch runs post-merge checks. Verify the exact resulting target-branch commit and its required workflows. If `main` becomes red, pause the merge queue and repair the failure before advancing another PR; first determine whether the failure is a code regression or a newly changed external condition such as a dependency advisory.

## 8. Documentation/change control

Keep durable context small and single-owned:

- `docs/SPEC-V2.md`: canonical product/architecture contract.
- `docs/SOURCE-OF-TRUTH.md`: authority/navigation/change-control rules.
- `docs/PHASE-1-PLAN.md`: active Fastify → Hono migration plan.
- `docs/PRODUCTION-READINESS-ROADMAP-2026.md`: current hardening/release plan.
- `AGENTS.md`: repository execution rules.
- repository skills: narrow repeatable workflows.
- `README.md` / `CONTRIBUTING.md`: human-facing orientation only.

Do not add completion reports, session diaries, duplicate roadmaps, provider-specific instruction copies, or historical review summaries to the repository. Git history and GitHub issues/PRs already preserve that history.

If a canonical product decision changes, update `SPEC-V2.md` (or an explicitly accepted amendment/ADR) and downstream active plans/issues in the same change. An issue alone is not a spec amendment.

## 9. Learning capture

At the end of substantial implementation/PR work, run an explicit self-improvement checkpoint and capture only durable recurring lessons in the smallest appropriate owner:

- architecture/product intent → canonical spec/approved ADR;
- repository-wide execution invariant → `AGENTS.md`;
- repeatable workflow → narrow `.agents/skills/*` skill;
- deterministic mechanics → script/test/config;
- feature-specific context → issue/PR, not permanent project instructions.

Do not destabilize an already verified implementation PR merely to record meta-process learning. The exact reviewer-evidence, merge-state, follow-up-change, and cleanup mechanics are single-owned by `.agents/skills/pr-cycle/SKILL.md`; keep repository-wide guidance here at the invariant level. A checkpoint may legitimately produce no change when there is no reusable lesson.

Configured mechanisms prove only that they exist. Claim a guardrail is effective only when task-linked evidence shows it ran and passed.
