# PostgreSQL/PostGIS production gate

Terrastories uses SQLite for fast local development and many unit tests, but production database behavior must be validated against PostgreSQL with PostGIS. SQLite success is not evidence that PostgreSQL migrations, constraints, data types, spatial queries, or indexes are safe.

The `PostgreSQL / PostGIS` GitHub Actions workflow runs for every pull request targeting `main` and every push to `main`. It uses the same PostgreSQL major/image family as the production Compose configuration: `postgis/postgis:13-master`.

## What the gate validates

`npm run test:postgres` is destructive and runs only against a database whose name contains `test` and when `ALLOW_POSTGRES_TEST_RESET=true` is explicitly set. The gate covers four production-relevant paths:

1. **Fresh install** — resets an empty PostgreSQL database, enables PostGIS, runs the production migration history, validates schema catalogs, and reruns migrations to prove startup idempotency.
2. **Fail-closed migration** — loads the previous-release schema and a sanitized production-like fixture, deliberately introduces an invalid coordinate, and verifies the migration fails and is not recorded as applied.
3. **Previous-release upgrade** — migrates the previous-release schema plus representative data and checks that ownership, restricted/elder flags, file metadata and cultural restrictions, story-place/story-speaker joins, and authentication state survive unchanged.
4. **Application repository behavior** — exercises community and place repositories against PostgreSQL, including restricted-place filtering and radius search using real PostGIS.

The catalog checks verify representative production requirements including foreign keys, uniqueness, coordinate and role constraints, defaults, Rails-compatible timestamp columns, Rails compatibility/authentication fields, the generated `geometry(Point, 4326)` location column, and both geometry and geography GiST indexes.

The spatial check executes `ST_DWithin` against real PostGIS and inspects `EXPLAIN` with sequential scans disabled to prove the geography GiST index can serve the production radius predicate.

## Local reproduction

Start an ephemeral PostgreSQL/PostGIS service. This uses trust authentication only for the disposable local test container; never use it for a deployed database.

```sh
docker run --rm --name terrastories-postgres-test \
  -e POSTGRES_DB=terrastories_test \
  -e POSTGRES_USER=terrastories \
  -e POSTGRES_HOST_AUTH_METHOD=trust \
  -p 55432:5432 \
  postgis/postgis:13-master
```

In another terminal:

```sh
DATABASE_URL=postgresql://terrastories@127.0.0.1:55432/terrastories_test \
ALLOW_POSTGRES_TEST_RESET=true \
npm run test:postgres
```

The test runner drops and recreates the `public` and `drizzle` schemas. It refuses to run unless the database name contains `test` and the reset acknowledgement is present.

## Migration layout

SQLite and PostgreSQL have separate runtime migration histories because SQL emitted for one dialect is not safely executable by the other:

- `src/db/migrations/` contains the existing SQLite migration history used by the local/test SQLite path.
- `src/db/migrations/postgres/` contains reviewed PostgreSQL/PostGIS production migrations and its own Drizzle migration journal.

`src/db/migrate.ts` chooses the migration history from `DATABASE_URL`. PostgreSQL migration startup is fail-closed: if PostGIS cannot be enabled or verified, the migration command exits non-zero rather than silently degrading spatial behavior.

The production image copies the reviewed SQL migration assets into `dist/db/migrations`, next to the compiled migrator. `docker-compose.prod.yml` runs `node dist/db/migrate.js` before `npm start`, so production does not depend on the development-only `tsx` runner or on source files that are absent from the runtime image.

Production migration changes must include a matching PostgreSQL gate update whenever they alter tables, relationships, defaults, indexes, spatial behavior, or migration invariants.

## Sanitized migration fixtures

Files under `tests/fixtures/postgres/` are synthetic and must remain free of real community, user, territorial, authentication, or cultural data. Add only the minimum representative fields needed to prove migration invariants.

When a migration changes data semantics, update the previous-release schema fixture and production-like fixture so CI demonstrates both the old state and the expected post-migration state. Sensitive-looking fields must use explicit redacted placeholders.

## Expand-contract policy

Production schema changes should be deployable without requiring an unsafe all-at-once cutover.

1. **Expand**: add compatible columns, indexes, or relationships first. Prefer nullable columns or safe defaults when existing rows need a backfill. Preserve old reads/writes while both schemas can coexist.
2. **Backfill and validate**: migrate existing rows in bounded, observable steps. Validate invariants before adding constraints that could reject legacy data. For large tables, choose PostgreSQL techniques that avoid unnecessarily long locks.
3. **Switch application behavior**: deploy code that reads/writes the expanded schema only after the backfill and validation are complete.
4. **Contract later**: remove obsolete columns, indexes, compatibility writes, or legacy semantics in a later deployment after rollback no longer depends on them.

Treat destructive operations as separate migrations with an explicit recovery plan. Do not combine column/table drops, incompatible type narrowing, irreversible data rewrites, or new `NOT NULL`/foreign-key assumptions with the first deployment that depends on them. A migration that discovers invalid production-like data must fail before being recorded as applied.

For changes that can affect community ownership, access restrictions, cultural protocols, authentication state, file relationships, or story associations, add explicit data-invariant assertions to the PostgreSQL gate before merge.

## CI troubleshooting

A passing SQLite suite does not waive a PostgreSQL failure. Reproduce the PostgreSQL job locally with the commands above and fix the production path. Do not weaken the gate by skipping PostGIS checks, swallowing migration errors, changing assertions to warnings, or replacing production fixtures with mocks.
