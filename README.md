# Terrastories API

Terrastories API is the backend for Terrastories, an offline-capable geostorytelling platform for Indigenous and local communities.

The current development goal is **API V2**: migrate the HTTP layer from Fastify to Hono while preserving legacy Rails feature parity, community data sovereignty, offline field-kit support, and one shared codebase across Cloudflare and self-hosted deployments.

## Canonical project context

For product and architecture decisions, the source of truth is:

1. [`docs/SOURCE-OF-TRUTH.md`](docs/SOURCE-OF-TRUTH.md) — authority, navigation, and change-control rules.
2. [`docs/SPEC-V2.md`](docs/SPEC-V2.md) — canonical V2 product/architecture specification.
3. [`docs/PHASE-1-PLAN.md`](docs/PHASE-1-PLAN.md) — active Fastify → Hono migration plan.
4. [`docs/PRODUCTION-READINESS-ROADMAP-2026.md`](docs/PRODUCTION-READINESS-ROADMAP-2026.md) — current production-hardening and release roadmap.
5. [`AGENTS.md`](AGENTS.md) — repository-wide development and agent execution rules.

Do not infer intended product behavior from historical code or old issues when it conflicts with `SPEC-V2.md`.

## V2 deployment targets

| Mode        | Runtime | Database    | Storage                   | Purpose                     |
| ----------- | ------- | ----------- | ------------------------- | --------------------------- |
| Cloudflare  | Workers | D1 (SQLite) | R2                        | Hosted production           |
| Self-hosted | Node.js | PostgreSQL  | Local/self-hosted storage | Existing/server deployments |
| Field kit   | Node.js | SQLite      | Local filesystem          | Fully offline deployments   |

Shared behavior must remain portable across these targets. **PostGIS is not a V2 dependency**; spatial behavior is application-level latitude/longitude logic.

## Current migration state

Fastify V1 and Hono V2 coexist during Phase 1. Hono is the target framework. Production readiness must be proven by the active roadmap; historical “production ready” reports are intentionally not retained in this repository.

The production-readiness backlog is organized in GitHub with:

- `priority:p0`, `priority:p1`, `priority:p2`;
- `lane:A-ci` through `lane:I-release`;
- `status:ready`, `status:blocked`, `status:needs-decision`.

## Development

Requirements are Node.js 20+ and npm 9+.

```bash
npm install
npm run dev
```

Common terminating validation commands:

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

See `package.json` for the exact current scripts. Issue #133 owns repairing stale aggregate/compatibility scripts and making the full validation signal deterministic; a configured command is not evidence until it successfully runs.

## Core architecture

```text
src/
├── routes/          Fastify V1 + Hono V2 transport handlers
├── services/        business logic
├── repositories/    data access
├── db/              Drizzle schema/migrations/adapters
├── shared/          config, middleware, sessions, schemas, types
├── hono-app.ts      Hono application builder
└── server.ts        runtime entrypoint during coexistence
```

The intended dependency direction is Route → Service → Repository → Database.

## Security and data sovereignty

Community isolation is a product invariant, not an optional hardening layer. Protected community content must not leak across communities or become accessible to super admins through privileged system administration. High-risk auth, session, file, export, migration, and community-boundary changes require explicit negative/adversarial tests.

V2 intentionally removes V1 scope creep such as the elder role/elder-only content rules and cultural-significance metadata. Those concepts must not be reintroduced by compatibility or security work without an explicit spec change.

## Contributing

Read [`CONTRIBUTING.md`](CONTRIBUTING.md), [`AGENTS.md`](AGENTS.md), and the governing spec sections before changing code. Repository-local agent workflows live in `.agents/skills/`.
