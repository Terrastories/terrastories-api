# Repository Guidelines

## Project Structure & Module Organization

- `src/`: application code
  - `routes/`: Fastify routes (e.g., `auth.ts`, `communities.ts`)
  - `services/`: business logic (e.g., `user.service.ts`)
  - `repositories/`: data access (e.g., `story.repository.ts`)
  - `db/`: Drizzle setup, migrations, and seeds
  - `shared/`: types, helpers, middleware
- `tests/`: unit, integration, and helpers (Vitest)
- `dist/`: compiled output (build)
- `docs/`: architecture, setup, and roadmap

## Build, Test, and Development Commands

- `npm run dev`: start Fastify server with hot reload.
- `npm run build`: compile TypeScript to `dist/`.
- `npm start`: run production build.
- `npm test`: run tests; `npm run test:coverage` enforces 80% coverage.
- `npm run lint` / `npm run format`: lint and format sources.
- Database: `npm run db:generate` (migrations), `npm run db:migrate` (apply), `npm run db:seed` (sample data).

Examples:

```
cp .env.example .env && npm run db:migrate && npm run dev
```

## Coding Style & Naming Conventions

- Language: TypeScript (ESM). Prefer strict types; avoid `any` (enforced in src).
- Formatting: Prettier (2 spaces, semicolons, single quotes, width 80).
- Linting: ESLint with `typescript-eslint`. Key rules: `no-var`, `prefer-const`, no unused vars (prefix `_` to ignore).
- File naming: kebab-case with role suffixes, e.g. `user.service.ts`, `story.repository.ts`.
- Imports: use aliases `@` for `src` and `~tests` for `tests`.

```ts
import { UserService } from '@/services/user.service';
```

## Testing Guidelines

- Framework: Vitest with Node env and global setup (`tests/setup.ts`).
- Location/patterns: `tests/**/*.{test,spec}.ts` or colocated in `src/**`.
- Coverage: global 80% min; coverage reports in `coverage/`.
- Database tests use isolated in-memory SQLite helpers (`tests/helpers/database.ts`).

Run specific tests:

```
npm test tests/routes/health.test.ts
```

## Commit & Pull Request Guidelines

- Commits: follow Conventional Commits where possible:
  - `feat: add community slug validation`
  - `fix: handle invalid JWT in auth route`
- Pre-commit runs lint-staged (ESLint + Prettier). Ensure `npm run validate` passes.
- PRs: include description, linked issues, test coverage (new/changed code), and any API examples (e.g., cURL) when relevant. Screenshots optional for docs.

## Security & Configuration Tips

- Never commit secrets; start from `.env.example`.
- Required vars: `DATABASE_URL`, `JWT_SECRET`. PostgreSQL + PostGIS in production; tests default to in-memory SQLite.
- Prefer parameterized queries via Drizzle and validate inputs with Zod.
