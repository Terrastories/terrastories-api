# Contributing

Thanks for helping improve Terrastories API! This is a quick start. For full details, see AGENTS.md.

## Getting Set Up

- Prereqs: Node 18+, PostgreSQL 13+ (PostGIS), Git.
- Install: `npm install`
- Env: `cp .env.example .env` and update values (e.g., `DATABASE_URL`, `JWT_SECRET`).
- DB: `npm run db:migrate` (and `npm run db:seed` for sample data).

## Common Scripts

- Dev: `npm run dev`
- Tests: `npm test` | Coverage: `npm run test:coverage`
- Lint/Format: `npm run lint` | `npm run format` | `npm run format:check`
- Types: `npm run type-check`
- Validate all: `npm run validate`
- DB: `npm run db:generate` | `npm run db:migrate` | `npm run db:seed`
- Build/Start: `npm run build` | `npm start`

## Branches & Commits

- Branch names: `feat/<short-topic>`, `fix/<bug>`, `chore/<task>`.
- Conventional commits preferred, e.g.: `feat: add community slug validation`.
- Pre-commit runs lint-staged (ESLint + Prettier). Ensure `npm run validate` passes locally.

## Pull Requests

- Describe changes, motivation, and link related issues.
- Include tests for new/changed behavior; coverage target is 80%+.
- Note any DB migrations and API changes (with brief examples if relevant).
- Ensure local run works: `npm run dev` and health at `/health`.

## Guides & Docs

- Contributor guide: see AGENTS.md (structure, style, testing, security).
- Project overview and scripts: README.md.
- Architecture and roadmap: docs/.

## Community

Be respectful and prioritize data sovereignty and security. If unsure, open a draft PR or discussion before large changes.
