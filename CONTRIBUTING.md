# Contributing to Terrastories API

Before changing code, read [`AGENTS.md`](AGENTS.md) and [`docs/SOURCE-OF-TRUTH.md`](docs/SOURCE-OF-TRUTH.md). Product and architecture intent lives in [`docs/SPEC-V2.md`](docs/SPEC-V2.md); issues and current code do not override it.

## Development setup

Requirements: Node.js 20+ and npm 9+.

```bash
npm install
npm run dev
```

Useful validation commands:

```bash
npm run type-check
npm run lint
npm run format:check
npm run build
npm test -- --run
npm run test:coverage
```

Database commands:

```bash
npm run db:generate
npm run db:migrate
npm run db:seed
```

## Before implementing an issue

- Read the complete issue and its labels/dependencies.
- Identify the governing `SPEC-V2.md` sections.
- Confirm the correct base branch/worktree.
- Confirm the change preserves D1/SQLite, PostgreSQL, and field-kit requirements where applicable.
- Confirm it is approved parity/hardening work rather than an unapproved new product feature.
- Define the tests that will prove completion before coding.

Use the repository `spec-guard` skill when scope or architecture could drift.

## Code and tests

- Prefer strict TypeScript and avoid `any`.
- Keep Route → Service → Repository → Database separation.
- Use Zod at input boundaries and Drizzle for database access.
- Use TDD for non-trivial behavior where practical.
- Run Vitest in terminating mode for autonomous/CI work.
- Do not weaken tests to make a build green.
- Shared database behavior needs evidence on D1/SQLite-compatible and PostgreSQL paths.
- PostGIS is not part of the V2 product contract.
- Auth, files, migrations, exports, and community boundaries require negative/adversarial tests.

## Pull requests

Prefer Conventional Commits. PRs should state:

- governing spec sections;
- linked issue(s);
- behavior changed and explicit non-goals;
- tests/gates run and their results;
- migration/rollback impact when relevant;
- security/data-sovereignty impact when relevant.

For the full review/fix/CI lifecycle, follow `.agents/skills/pr-cycle/SKILL.md`. Merge requires explicit user authorization.

## Documentation

Keep permanent documentation intentionally small. Do not add completion reports, duplicate roadmaps, agent session diaries, historical PR summaries, or provider-specific copies of repository instructions. Put durable information in its single canonical owner as defined by `AGENTS.md` and `docs/SOURCE-OF-TRUTH.md`.
