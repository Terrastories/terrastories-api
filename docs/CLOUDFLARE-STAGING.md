# Cloudflare staging

## Current feasibility

The current main runtime is Fastify (`src/app.ts`, `src/server.ts`). The Hono
foundation is tracked in PR #132; see `PHASE-1-PLAN.md`. This revision has no Worker
entrypoint, Wrangler dependency/configuration, D1 binding adapter, or R2 storage
adapter. `src/db/index.ts` opens native better-sqlite3 or a PostgreSQL connection;
`src/services/storage/local-storage.adapter.ts` uses local filesystem storage.
Password hashing imports native Argon2. The Dockerfile packages a Node server,
not a Workers/D1/R2 application. No Cloudflare container deployment is configured.

Deploying a health-only placeholder or the existing Node container would not
prove the SPEC-V2 Section 5 hosted profile. Staging V2 therefore requires the
Hono foundation and runtime/database/storage/password/session adapters first.
No Cloudflare resources or DNS changes are required for this route restriction.

Development routes and the demo CLI seeder require exactly `NODE_ENV=development`
or `NODE_ENV=test`. Unset, staging, production, field-kit, offline and unknown
values do not enable them, even if configuration defaults select development.
Use `NODE_ENV=production` for staging; `staging` names the deployment environment,
not the application runtime mode. Never seed staging with demo credentials.

## Implementation and deployment plan

Issue #147 owns staging integration. Follow SPEC-V2 Sections 5, 7, 8, 12 and 13
and roadmap Phase 9; this document does not declare a release ready.

1. Land the Hono foundation and supply a Worker fetch entrypoint. Implement D1,
   R2, durable database sessions, and Workers-compatible password adapters. Prove
   login, protected media, revocation and Rails bcrypt verification on the real
   platform while retaining PostgreSQL and offline SQLite support.
2. Pin Wrangler locally and commit a reviewed `wrangler.jsonc` with an isolated
   `staging` environment: dedicated Worker name, D1 `DB` and R2 `MEDIA` bindings,
   compatibility date/flags, and `NODE_ENV=production`. These binding names are
   proposed until the adapters define their contract. Do not bind production
   data. Use a workers.dev URL; do not change DNS. Confirm the intended account
   and resource costs before creating anything; paid resources need approval.
3. Supply `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` through the operator
   environment. Supply application secrets through Wrangler secrets; never
   commit their values. Production Node startup now rejects missing `JWT_SECRET`
   and `SESSION_SECRET` (minimum 32 characters each). Supply unique values and
   verify secret presence without printing them; review the final Worker adapter
   for its exact secret requirements. D1/R2 use bindings rather than `DATABASE_URL` or
   local upload-directory variables.
4. After those prerequisites exist, use the following command outline from the
   repo root. It is a future procedure, not runnable deployment support shipped
   by this revision. Validate commands against the pinned CLI before execution.

   ```bash
   cf auth whoami
   npx wrangler whoami
   npx wrangler deploy --env staging --dry-run
   npx wrangler secret put JWT_SECRET --env staging
   npx wrangler secret put SESSION_SECRET --env staging
   npx wrangler d1 migrations apply terrastories-staging --remote --env staging
   npx wrangler deploy --env staging
   ```

   Review the dry-run output and account before remote mutations. Provision the
   isolated D1 database and R2 bucket and configure their bindings before applying
   migrations. Secrets are entered interactively or supplied from an approved
   environment-backed secret source. Seed only synthetic data through authorized
   V2 bootstrap/import tooling, not the development endpoint or demo seeder.

5. Record exact Git SHA, Worker version/deployment identity, migration version,
   bindings and test results. With `STAGING_URL` set to the deployed workers.dev
   URL, verify health and absent development routes (including automatic HEAD):

   ```bash
   test "$(curl -sS -o /dev/null -w '%{http_code}' "$STAGING_URL/health")" = 200
   test "$(curl -sS -o /dev/null -w '%{http_code}' "$STAGING_URL/dev/seed")" = 404
   test "$(curl -sS -I -o /dev/null -w '%{http_code}' "$STAGING_URL/dev/seed")" = 404
   ```

   Run the canonical auth, sovereignty, media, migration, and failure tests on
   that deployment. A health check alone is insufficient release evidence.

## Teardown and rollback

Preserve the prior Worker version and database backup before upgrades. Rehearse
Worker rollback separately from D1 restore/forward-fix; code rollback does not
undo database writes. Before destructive teardown, confirm account, environment,
resource names and retention approval. Delete only the dedicated staging Worker
(`npx wrangler delete --env staging`), then its dedicated D1 database and R2 bucket
using the pinned CLI's help after any required export/backup. Never delete shared
resources. No teardown has been performed by this change.

## Primary references

- [Wrangler environments](https://developers.cloudflare.com/workers/wrangler/environments/)
- [Node.js compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)
- [Wrangler commands](https://developers.cloudflare.com/workers/wrangler/commands/)
- [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
