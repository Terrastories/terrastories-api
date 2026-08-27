# Database portability

Terrastories V2 supports two equal database targets:

- SQLite-compatible SQL for D1, field kits, local development, and tests.
- PostgreSQL 13 for hosted deployments.

Neither backend defines product semantics for the other. Shared behavior is expressed through the repository and service layers. In particular, places use plain latitude/longitude columns and application-level Haversine and bounding-box logic; no spatial database extension is required.

## Required local gates

Run the SQLite/D1-compatible gate directly:

```sh
npm run test:db:sqlite
```

For PostgreSQL, start a disposable PostgreSQL 13 database. One example is:

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

The PostgreSQL gate is destructive and refuses to run unless the database name contains `test` and `ALLOW_POSTGRES_TEST_RESET=true` is set.

Both gates are mandatory pull-request CI jobs.

## What the gates prove

Each backend gate checks the same release contract:

1. Fresh migration from an empty database.
2. Upgrade from the supported previous-release schema with representative community, user, place, story, speaker, file, and join-table data.
3. Preservation of ownership, restrictions, auth data/defaults, JSON payloads, associations, and coordinates through upgrade.
4. Shared repository behavior for create/filter/order/pagination and application-level spatial queries.
5. Foreign-key and uniqueness enforcement, transaction rollback, portable indexes, defaults, and timestamp decoding.
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
