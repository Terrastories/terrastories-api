---
name: spec-guard
description: Guard Terrastories work against product/spec drift. Use before implementing or materially revising an issue, when a roadmap/PR/code path appears to conflict with project intent, when changing database/runtime/deployment architecture, when legacy/V1 behavior or data is involved, or when deciding whether a proposed behavior belongs in V2. Produces a short spec-alignment verdict and blocks implementation on unresolved conflicts.
---

# Terrastories Spec Guard

Use this skill as a narrow preflight, not as a generic planning workflow.

## Inputs

- task/issue/PR being considered;
- intended base branch or stacked-PR base;
- files/areas likely to change;
- legacy/V1 behavior or source data touched, when applicable.

## Procedure

1. Read repository `AGENTS.md`.
2. Read `docs/SOURCE-OF-TRUTH.md`.
3. Read only the relevant sections of `docs/SPEC-V2.md` plus any explicit amendment/ADR referenced by the source-of-truth index.
4. Read the task/issue/PR and the smallest relevant code/tests needed to identify current implementation state.
5. If legacy Rails/Fastify behavior or data is involved, use it as evidence and classify each material concept as **RETAIN, IMPROVE, ARCHIVE, DROP, or DEFER**. Rails/Fastify is not automatically normative.
6. Produce the five-question drift check from `docs/SOURCE-OF-TRUTH.md`:
   - governing spec sections;
   - conflict or no conflict;
   - SQLite/D1 + PostgreSQL portability impact;
   - legacy/V1 disposition and user/data-preservation impact where applicable;
   - validation evidence required.
7. Return one verdict:
   - **ALIGNED — READY:** implementation may proceed from the documented base;
   - **ALIGNED — BLOCKED:** product intent is clear, but another dependency/base/review gate must land first;
   - **SPEC DECISION REQUIRED:** task would change or contradict canonical intent; do not implement until the spec is amended/approved.

## Hard guards

- Never infer product intent from code, old tests, Fastify, or Rails when they conflict with the canonical spec.
- Never equate "preserve user experience/data" with wire/schema compatibility.
- Never silently drop a data-bearing legacy field. Canonical fields are mapped/transformed; intentionally non-runtime data is preserved in the restricted migration archive.
- Never make migration pass by inventing historical provenance, foreign keys, coordinates, uploader identities, or community ownership that the source does not contain.
- Never let a production-readiness/security task reintroduce product scope explicitly removed by V2.
- Treat SQLite/D1 and PostgreSQL as equal first-class targets for shared behavior.
- PostGIS/database-specific spatial extensions are not part of V2 unless the canonical spec is explicitly amended.
- Do not weaken community isolation/data-sovereignty guarantees in the name of compatibility, observability, administration, export, migration, or performance.
- A GitHub issue is not a spec amendment.

## Output contract

Keep the preflight compact:

```text
Spec guard: <ALIGNED — READY | ALIGNED — BLOCKED | SPEC DECISION REQUIRED>
Governing spec: <sections>
Base/dependencies: <branch/PR/issues/review gates>
Portability: <SQLite/D1 + PostgreSQL impact>
Legacy disposition: <RETAIN/IMPROVE/ARCHIVE/DROP/DEFER or n/a>
User/data impact: <experience continuity + migration preservation>
Required evidence: <tests/gates>
Conflict: <none or exact contradiction + proposed spec decision>
```

If the verdict is `SPEC DECISION REQUIRED`, stop before source-code implementation. A documentation-only correction that restores derived artifacts to the already-approved canonical spec may proceed when explicitly within the user's requested scope.
