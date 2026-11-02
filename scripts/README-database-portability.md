# Database portability gates

Operational instructions for running the dual-backend database gates (issue #135). The portability contract itself — D1/SQLite and PostgreSQL as equal required targets, no PostGIS or other database-specific spatial extension, JSON as storage container only, expand/contract for risky schema changes (`docs/SPEC-V2.md` Section 8), and application-maintained normalized identity/tag columns with no database case-folding (Sections 6.2/6.3) — lives in the canonical spec. This file does not restate that contract; it only documents how to run and validate the gates beside it.

## Required local gates

Run the SQLite/D1-compatible gate directly:

```sh
npm run test:db:sqlite
```

For PostgreSQL, start a disposable **plain PostgreSQL 13** database. One example is:

```sh
docker run --rm --name terrastories-postgres-test \
  -e POSTGRES_DB=terrastories_test \
  -e POSTGRES_USER=terrastories \
  -e POSTGRES_PASSWORD=terrastories-test \
  -p 5432:5432 postgres:13-alpine
```

Then, in another shell:

```sh
DATABASE_URL=postgresql://terrastories:terrastories-test@localhost:5432/terrastories_test \
ALLOW_POSTGRES_TEST_RESET=true \
npm run test:db:postgres
```

The PostgreSQL gate is destructive and refuses to run unless the database name follows the dedicated test-database convention (for example `terrastories_test`, ending in `_test`) and `ALLOW_POSTGRES_TEST_RESET=true` is set. A substring such as `latest` is never considered a test database.

Both gates are mandatory pull-request CI jobs (`.github/workflows/ci.yml`, jobs `database-sqlite` and `database-postgres`). The PostgreSQL gate deliberately uses plain `postgres:13-alpine`; passing it proves that application and migration behavior does not depend on PostGIS or another database-specific spatial extension. The CI job also sets a non-UTC `TZ`, so the gate must pass on any host time zone; run it locally without overriding `TZ`.

## Docker persisted-volume compatibility

The base Compose file temporarily retains the historical `postgis/postgis:13-master` image **only as a storage compatibility bridge**. Existing `postgres_data` named volumes created by previous releases may contain PostGIS extension catalog objects whose server-side libraries must still be present when PostgreSQL opens that volume. Replacing the image in place before those volumes have a tested migration path can make an otherwise valid persisted deployment fail to start.

This compatibility image does **not** make PostGIS a V2 dependency:

- `scripts/init-db.sql` no longer creates or probes PostGIS extensions.
- New migrations, schemas, repositories, and spatial queries use portable PostgreSQL/SQLite semantics only.
- The required PostgreSQL CI and local reproduction gate run against plain PostgreSQL 13.
- New databases created by the Compose stack do not rely on PostGIS behavior even though the compatibility image contains the extension libraries.

Removing the compatibility image is a separate risky storage cutover. Before that change can ship, it needs an explicit, tested backup/restore or forward-migration procedure for existing named volumes, including representative legacy PostGIS-enabled data and a negative failure path. Do not silently swap an existing persisted volume from the PostGIS-capable image to plain PostgreSQL.

## What the gates prove

During the current Fastify V1/Hono V2 coexistence phase the compatibility schema still serves the V1 surface on `main`, so the upgrade fixtures retain V1-only cultural/elder fields; they are compatibility surface, not V2 migration invariants.

Each backend gate checks the same release contract:

1. Fresh migration from an empty database.
2. Upgrade from the supported previous-release schema with representative community, user, place, story, speaker, file, and join-table data.
3. Preservation of V2 ownership, auth, file, association, coordinate, timestamp, and representative payload invariants through upgrade. V1-only cultural/elder fields are not promoted into the V2 contract by this gate.
4. Shared repository behavior for create/filter/order/real pagination boundaries and application-level spatial queries.
5. Foreign-key and uniqueness enforcement, including nullable uniqueness semantics, transaction rollback, portable indexes, defaults, and timestamp decoding.
6. Dialect validation that rejects SQL from the other backend.
7. A deliberate failing migration that must fail and must not be recorded as applied.

The static dialect probes are intentional canaries: weakening them so cross-dialect SQL passes is a release-gate regression.
