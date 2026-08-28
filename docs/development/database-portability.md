# Database portability

Terrastories V2 supports two equal database targets:

- SQLite-compatible SQL for D1, field kits, local development, and tests.
- PostgreSQL 13 for hosted deployments.

Neither backend defines product semantics for the other. Shared behavior is expressed through the repository and service layers. In particular, places use plain latitude/longitude columns and application-level Haversine and bounding-box logic; no spatial database extension is required.

During the current Fastify V1/Hono V2 coexistence phase, the database compatibility history still has to support the V1 surface on `main`. Legacy cultural/elder columns that the canonical V2 product contract removes are therefore compatibility-only and are not V2 migration invariants. Their final schema contraction belongs to the dedicated V1-to-V2 cutover after an expand-contract/data-migration path can preserve supported records without breaking `/api/v1` coexistence.

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

Both gates are mandatory pull-request CI jobs. The PostgreSQL gate deliberately uses plain `postgres:13-alpine`; passing it proves that application and migration behavior does not depend on PostGIS or another database-specific spatial extension.

## Docker persisted-volume compatibility

The base Compose file temporarily retains the historical `postgis/postgis:13-master` image **only as a storage compatibility bridge**. Existing `postgres_data` named volumes created by previous releases may contain PostGIS extension catalog objects whose server-side libraries must still be present when PostgreSQL opens that volume. Replacing the image in place before those volumes have a tested migration path can make an otherwise valid persisted deployment fail to start.

This compatibility image does **not** make PostGIS a V2 dependency:

- `scripts/init-db.sql` no longer creates or probes PostGIS extensions.
- New migrations, schemas, repositories, and spatial queries use portable PostgreSQL/SQLite semantics only.
- The required PostgreSQL CI and local reproduction gate run against plain PostgreSQL 13.
- New databases created by the Compose stack do not rely on PostGIS behavior even though the compatibility image contains the extension libraries.

Removing the compatibility image is a separate risky storage cutover. Before that change can ship, it needs an explicit, tested backup/restore or forward-migration procedure for existing named volumes, including representative legacy PostGIS-enabled data and a negative failure path. Do not silently swap an existing persisted volume from the PostGIS-capable image to plain PostgreSQL.

## What the gates prove

Each backend gate checks the same release contract:

1. Fresh migration from an empty database.
2. Upgrade from the supported previous-release schema with representative community, user, place, story, speaker, file, and join-table data.
3. Preservation of V2 ownership, auth, file, association, coordinate, timestamp, and representative payload invariants through upgrade. V1-only cultural/elder fields are not promoted into the V2 contract by this gate.
4. Shared repository behavior for create/filter/order/real pagination boundaries and application-level spatial queries.
5. Foreign-key and uniqueness enforcement, including nullable uniqueness semantics, transaction rollback, portable indexes, defaults, and timestamp decoding.
6. Dialect validation that rejects SQL from the other backend.
7. A deliberate failing migration that must fail and must not be recorded as applied.

The static dialect probes are intentional canaries: weakening them so cross-dialect SQL passes is a release-gate regression.

## Intentional mechanical dialect differences

The storage representation may differ where the databases require it, while decoded application behavior remains the same:

- SQLite booleans are integer-backed; PostgreSQL uses native booleans.
- SQLite timestamps are integer-backed; PostgreSQL uses timestamp columns. Repository results are `Date` values in both cases.
- SQLite stores JSON payloads as text; PostgreSQL may use `jsonb`. The application-level objects must be equivalent.
- Auto-increment and generated/default syntax differs by dialect.
- Migration DDL is kept in separate dialect-specific histories so SQL is never executed against the wrong backend.

These are implementation details, not permission to introduce backend-specific API, authorization, spatial, or data-sovereignty behavior.

## Expand-contract policy

Risky schema changes must use expand-contract rather than a one-step destructive migration:

1. **Expand:** add compatible nullable columns/tables/indexes on both backends. Keep old reads and writes working.
2. **Dual behavior:** when necessary, deploy dual-read/dual-write application code that understands both old and new representations.
3. **Backfill:** migrate existing data idempotently and verify counts, ownership, associations, restrictions, and representative payloads on both database targets.
4. **Verify:** require fresh and upgrade migration gates for SQLite/D1-compatible and PostgreSQL, plus rollback/failure-path tests. Do not mask migration failures with test-only schema repair.
5. **Contract:** only after all supported deployments can run the expanded form and rollback is no longer required, remove old columns/paths in a later migration on both dialects.

Never use a PostgreSQL-only feature to bypass this sequence. If a proposed schema change cannot be represented with equivalent V2 semantics on SQLite/D1-compatible storage, it requires a spec decision before implementation.