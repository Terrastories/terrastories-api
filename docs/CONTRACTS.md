# V2 API Contract Harness

This note explains how the persona contract harness separates approved V2 requirements from temporary V1 coexistence checks.

## Contract classes: `canonical-v2` vs `legacy-v1`

- **`canonical-v2`** — assertions derived from [`docs/SPEC-V2.md`](SPEC-V2.md) (the V2 product and architecture oracle). These run against the Hono V2 app on: in-process SQLite, real Node HTTP (`@hono/node-server`) over the selected in-process QA database (SQLite by default), in-process PostgreSQL 13, and Workers D1/R2 (in-process only).
- **`legacy-v1`** — assertions running against the frozen Fastify V1 coexistence fixtures (SQLite and PostgreSQL). Fastify V1 and legacy Rails are **evidence**, not the V2 oracle: `legacy-v1` pins frozen V1 behaviour during coexistence without making V1 routes or response shapes a V2 requirement.

Both classes fail closed on status mismatches, body-check failures, or uncovered endpoints (`report.pass === false`). The `contract` label on the report and each `Result`, along with the per-class pass/fail counts in `report.summary`, keeps the two classes distinguishable in CI reports.

## Adding a canonical contract case

1. **Seed and assert in [`scripts/qa/hono-fixture.ts`](../scripts/qa/hono-fixture.ts).** Add any isolated fixture data (one fixture per gate) and a `Step` with its `expected` status and exact `check` predicate to the relevant persona journey.
2. **Route coverage is enforced automatically.** For in-process and HTTP Hono runs, `routeTableOf(app)` derives the endpoint inventory directly from the served Hono app's `app.routes` (and `honoPersonaRouteTable()` reconstructs the same table for Workers). Any newly registered concrete-method Hono route fails the gate until a journey reaches it.
3. **Exclusions require a reviewed reason.** If an endpoint genuinely cannot be reached by a persona journey, add an entry to `exclusions` with a non-empty `reason` explaining why; stale or blank exclusions fail the runner immediately.

## Recording a breaking change to released V2 contracts

Once a V2 contract is released, accidental breaking changes are forbidden. Any intentional breaking change must:

1. Add a dated entry to [15. Change log](SPEC-V2.md#15-change-log) in [`docs/SPEC-V2.md`](SPEC-V2.md) recording the decision, rationale, and impact.
2. Update the canonical contract assertions in [`scripts/qa/hono-fixture.ts`](../scripts/qa/hono-fixture.ts) (and any affected contract tests) **in the same PR**.

## Where legacy differences get their disposition

When comparing legacy Rails or Fastify V1 behaviour against V2 reveals a difference, do **not** invent ad-hoc runtime workarounds or new disposition labels. Every material difference uses the `RETAIN` / `IMPROVE` / `ARCHIVE` / `DROP` / `DEFER` classifications governed by:

- [`docs/SPEC-V2.md`](SPEC-V2.md): [3. Authority and intentional-evolution policy](SPEC-V2.md#3-authority-and-intentional-evolution-policy) and [Audited legacy evidence](SPEC-V2.md#audited-legacy-evidence)
- [`docs/SPEC-V2.md`](SPEC-V2.md): [11. Legacy disposition at V2 launch](SPEC-V2.md#11-legacy-disposition-at-v2-launch)
- [`docs/SPEC-V2.md`](SPEC-V2.md): [Appendix A — Later: deferred Fastify-era profile and features](SPEC-V2.md#appendix-a--later-deferred-fastify-era-profile-and-features)
- [Issue #191](https://github.com/Terrastories/terrastories-api/issues/191) and [`scripts/qa/README.md`](../scripts/qa/README.md) ([#191 fail-closed cases](../scripts/qa/README.md#191-fail-closed-cases)) for V1 public-projection leaks turned into fail-closed canonical V2 cases.
