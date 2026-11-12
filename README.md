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

Field-kit Compose does not provide a synchronization service or a `sync-enabled`
profile. Hosted/field-kit synchronization is outside launch requirements
([SPEC-V2 §5](docs/SPEC-V2.md#offline-profile)); its protocol and community authorization
remain undefined ([tracking issue #182](https://github.com/Terrastories/terrastories-api/issues/182)).
The former nonfunctional service and unused queue declaration were removed; existing
Docker volumes are not deleted by this configuration change.

When upgrading a deployment that previously enabled sync, remove its orphaned
`sync-service` container while starting the supported services:

```bash
docker compose -f docker-compose.yml -f docker-compose.field-kit.yml up -d --remove-orphans
```

This also removes other orphaned containers in the same Compose project; named
volumes remain intact.

## Current migration state

`main` currently runs Fastify V1. Hono is the target framework, re-landed as a thin slice off `main` (health, login, durable session, revocation, one protected media read); PR #132 was closed on 2026-11-11 and superseded (#193). Production readiness must be proven by the active roadmap; historical “production ready” reports are intentionally not retained in this repository.

The production-readiness backlog is organized in GitHub with:

- `priority:p0`, `priority:p1`, `priority:p2`;
- `lane:A-ci` through `lane:I-release`;
- `status:ready`, `status:blocked`, `status:needs-decision`.

## Development

Requirements are Node.js 20.9+ and npm 9+.

```bash
npm install
npm run dev
```

Common terminating validation commands:

```bash
npm run validate:ci
npm run test:coverage
npm run test:compatibility
```

Database commands:

```bash
npm run db:generate
npm run db:migrate
npm run db:seed
```

See `package.json` for the exact current scripts. Issue #133 landed in PR #152: `validate:ci` is the canonical terminating aggregate gate, with the deterministic bounded full suite in `test:ci`; coverage and compatibility remain separate explicit gates. A configured command is not evidence until it successfully runs on the revision being reviewed.

## Core architecture

```text
src/
├── routes/          current Fastify V1 transport handlers on main
├── services/        business logic
├── repositories/    data access
├── db/              Drizzle schema/migrations/adapters
├── shared/          config, middleware, sessions, schemas, types
└── server.ts        current Fastify runtime entrypoint on main
```

The thin Hono slice off `main` introduces the Phase 1 Hono application builder and the first Hono transport routes; PR #132 was closed and superseded (#193).

The intended dependency direction is Route → Service → Repository → Database.

## Security and data sovereignty

Community isolation is a product invariant, not an optional hardening layer. Protected community content must not leak across communities or become accessible to super admins through privileged system administration. High-risk auth, session, file, export, migration, and community-boundary changes require explicit negative/adversarial tests.

V2 intentionally removes V1 scope creep such as the elder role/elder-only content rules and cultural-significance metadata. Those concepts must not be reintroduced by compatibility or security work without an explicit spec change.

## Contributing

Read [`CONTRIBUTING.md`](CONTRIBUTING.md), [`AGENTS.md`](AGENTS.md), and the governing spec sections before changing code. Repository-local agent workflows live in `.agents/skills/`.
