# Terrastories API Source of Truth

**Status:** Canonical navigation and change-control contract  
**Last reviewed:** 2026-08-17

Read this immediately after `AGENTS.md`. Its purpose is to stop issues, roadmaps, tests, or current implementation details from silently redefining API V2.

## Authority order

When artifacts disagree, use this order and stop rather than guessing:

1. **Explicit user-approved product decisions + `docs/SPEC-V2.md`** — canonical V2 product/architecture contract.
2. **Explicitly accepted amendments/ADRs referenced from this file** — deliberate changes to that contract. None are currently listed.
3. **`docs/PHASE-1-PLAN.md`** — active Fastify → Hono migration execution plan, subordinate to the spec.
4. **`docs/PRODUCTION-READINESS-ROADMAP-2026.md`** — testing/security/operations/release proof, subordinate to the spec.
5. **GitHub issues** — implementation units. Issues must cite and obey the governing spec.
6. **Current code/tests** — evidence of implementation state, not authority for intended product behavior when they conflict with the spec.

Historical completion reports, duplicate roadmaps, provider-specific workflow copies, and session/review diaries are intentionally not retained in the repository. Git history and GitHub preserve that history without making it active context.

## Canonical V2 invariants

These are summaries for navigation; `SPEC-V2.md` owns the full wording.

- Hono is the target HTTP framework for Cloudflare Workers and Node.js.
- One codebase supports three first-class modes:
  - Cloudflare Workers + D1 + R2;
  - Node.js + PostgreSQL + local/self-hosted storage;
  - Node.js + SQLite + local filesystem for fully offline field kits.
- D1/SQLite and PostgreSQL are equal first-class database targets for shared behavior.
- Shared database semantics remain SQLite-compatible; PostgreSQL-specific behavior does not define the product contract.
- Spatial behavior is portable application-level latitude/longitude logic. **PostGIS/database-specific spatial extensions are a V2 non-goal.**
- V2 targets legacy Rails feature parity with explicit mapping for intentional V1/V2 URL/shape differences.
- New product features beyond approved parity require a separate approved product decision.
- V1 scope creep removed by V2 is not a requirement: no elder role/elder-only restrictions, elder speaker status, cultural-significance metadata, community cultural settings, story-place cultural context, or removed cultural-restriction schema unless the spec is deliberately amended.
- Community isolation and Indigenous data sovereignty remain mandatory. Super-admin system privilege does not grant access to protected community content.
- Field-kit functionality must operate without runtime cloud dependencies.

## Surviving durable documentation

The permanent project-context surface is intentionally small:

- `AGENTS.md` — repository-wide execution rules for agents/developers.
- `CLAUDE.md` / `GEMINI.md` — thin provider entrypoints that only point to `AGENTS.md`.
- `README.md` — human orientation.
- `CONTRIBUTING.md` — human contribution workflow.
- `docs/SOURCE-OF-TRUTH.md` — this authority/navigation contract.
- `docs/SPEC-V2.md` — canonical V2 product/architecture specification.
- `docs/PHASE-1-PLAN.md` — current Hono migration plan; delete or replace when that phase is genuinely complete.
- `docs/PRODUCTION-READINESS-ROADMAP-2026.md` — current path to production; delete/replace after production readiness is proven and a new active plan exists.
- `.agents/skills/spec-guard/SKILL.md` — pre-implementation drift gate.
- `.agents/skills/pr-cycle/SKILL.md` — PR/review/CI lifecycle.

Do not add another general roadmap, architecture overview, completion report, test guide, setup guide, or provider-specific workflow file unless it owns information that cannot live cleanly in one of these canonical documents.

## Change control

If implementation evidence suggests `SPEC-V2.md` should change:

1. Do not silently implement the divergence.
2. Identify the affected spec requirement/section and concrete evidence.
3. Propose the smallest amendment/ADR with rationale, alternatives, compatibility, data-migration, sovereignty/security, offline, and deployment impact.
4. Obtain explicit approval for material product/architecture changes.
5. Update the canonical spec before or in the same change as implementation.
6. Update affected active plan(s) and GitHub issue(s) so downstream agents inherit the same truth.

An issue, PR, implementation, or test expectation alone is never a spec amendment.

## Issue readiness contract

An implementation-ready issue contains or links:

- governing spec sections;
- goal/problem and explicit non-goals;
- measurable acceptance criteria consistent with the spec;
- dependencies and required base/stacking relationship;
- D1/SQLite + PostgreSQL evidence where shared database behavior changes;
- offline/field-kit impact when applicable;
- security/data-sovereignty negative tests when applicable;
- migration/restore/rollback implications for data changes;
- concrete validation gates.

If an issue conflicts with the spec, mark it blocked and repair the issue/spec relationship before coding.

## Current execution sequence

- PR #132 is the Hono Phase 1 foundation. Hono-specific follow-up work must use the base/dependency relationship documented in each issue rather than independently recreating that work from `main`.
- Production-readiness issues use `priority:*`, `lane:*`, and `status:*` labels. `status:ready` means safe to start from the documented base; `status:blocked` means do not implement independently yet.
- Only the final release-integration gate may declare an exact revision/deployment profile production-ready.

## Drift check

Before changing code, answer:

1. Which `SPEC-V2.md` sections govern this work?
2. Does the issue/plan/current implementation conflict with them?
3. Does the change preserve D1/SQLite, PostgreSQL, and offline/field-kit requirements where applicable?
4. Is it approved parity/hardening, or an unapproved new feature?
5. What observable tests/evidence will prove the intended behavior without weakening portability or sovereignty?

If any answer is unresolved, use the `spec-guard` workflow and resolve it before implementation.
