# Persona QA

Run the isolated SQLite acceptance wrapper with:

```sh
npm run qa:personas:sqlite
```

which is `vitest run tests/scripts/qa --maxWorkers=2`.

The CLI accepts an explicit fixture module so it never silently seeds a deployed
community:

```sh
npm run qa:personas -- --fixture ./scripts/qa/sqlite-fixture.ts
```

A second in-process fixture drives the Hono V2 app (foundation routes plus
the #198 Explore read adapter) the same way:

```sh
npm run qa:personas -- --fixture ./scripts/qa/hono-fixture.ts
```

`scripts/qa/hono-fixture.ts` calls the Hono app through `app.fetch` on an
isolated SQLite database with an in-memory storage adapter, and returns the
same shape (`routes`, `journeys`, `exclusions`, `handler`, `close`) plus
`sessionCookieName: 'ts_session'` — the runner tracks that cookie name for
the Hono stack instead of Fastify's `sessionId`. Its endpoint table is
derived from `app.routes` itself (only method-`ALL` middleware registrations
and `bodyLimit`'s duplicate login entry are dropped — a concrete-method
route stays in coverage even on a wildcard path), so registering a
new Hono route fails coverage until a journey reaches it or a reviewed
exclusion names it; today every Hono endpoint is reached and the fixture
excludes nothing. Journeys cover anonymous Explore browsing (ruling #162
option A), session lifecycle for viewer, member, editor and community admin
(own-user profile without secrets, community-scoped media, logout/revoke
replay), super-admin boundaries, identical 401 bodies for wrong-password and
unknown-user logins, and the #147-skipped field-kit persona. Each withheld
Explore fixture fails exactly one gate: the restricted story/place and media
carry no other withholding property, the unevidenced story is public but
edgeless (hidden from the stories list by the evidence rule alone; story
show has no join requirement and serves it with empty relations), the
unknown-privacy story carries full evidence, and the foreign story/place/
media live in a second public community — visible on their own community's
Explore surface and, for media, to a foreign-community viewer persona on
`/v2/media` — so their 404s on this community's surfaces are community
scoping alone. An unrestricted file in the private community isolates the
Explore community-publication gate. Editor, community admin and super_admin
also drive the Explore steps with a session cookie: the anonymous projection
never widens for an authenticated caller. The Vitest
wrapper `tests/scripts/qa/hono.test.ts` runs inside
`npm run qa:personas:sqlite` and, when `QA_REPORT_PATH` is set, writes a
sibling report ending in `-hono.json` so parallel wrappers never race on one
file.

The SQLite fixture requires the normal test environment configuration. Vitest
supplies it through the repository test setup. For a deployed target, supply
`--base-url https://your-staging-host.example` and a fixture module that exports
`createFixture({baseUrl})`. That module must provision isolated QA data and return
`routes`, `journeys`, optional reasoned `exclusions`, and an asynchronous `close`
cleanup function. The in-process form also returns a `handler(Request)`.
The SQLite fixture refuses HTTP mode because its database does not seed a remote
server. Never point a provisioning fixture at community production data.

Reports default to `qa-report.json`; use `--report PATH` to select another path.
Reports contain request paths and outcomes, without credentials or cookies.
Skipped personas do not count toward route coverage. Any failed assertion or
unreached route makes the command exit nonzero. A nonempty reason is required for
each explicitly excluded endpoint.

Disconnected field-kit acceptance remains owned by #147. SQLite results do
not establish PostgreSQL or Workers readiness.

## CI release gate

The `persona-qa-sqlite` job in `.github/workflows/ci.yml`, with check name
**Persona QA gate (SQLite)**, runs `npm run qa:personas:sqlite` on Node
20.19.0 with `QA_REPORT_PATH` set on every pull request and push to `main`.
The job uses no secrets and fails closed: any failed assertion or unreached
endpoint exits nonzero. The `qa-report.json` it produces is uploaded as the
`persona-qa-report` artifact on every run, including failed ones, and a
missing report fails the upload step.

A maintainer must add **Persona QA gate (SQLite)** to the repository's
required status checks for `main` (Settings → Branches → branch protection).
That branch-protection change cannot be made from a pull request, so the
gate is advisory in CI until it is applied.

## PostgreSQL 13

The same persona journeys — Fastify fixture and Hono fixture — also run
against PostgreSQL 13:

```sh
QA_POSTGRES_URL=postgresql://terrastories:...@localhost:5432/terrastories_test \
ALLOW_POSTGRES_TEST_RESET=true \
npm run qa:personas:postgres
```

The command runs only the two PostgreSQL wrappers
(`tests/scripts/qa/postgres-fastify.test.ts` and
`tests/scripts/qa/postgres-hono.test.ts`) serially (`--maxWorkers=1`),
because each wrapper resets and re-migrates the one shared test database
through `scripts/qa/qa-database.ts`. Journeys and expectations are identical
to SQLite; only the backend changes, so SQLite-only behaviour (collation,
timestamps, booleans, JSON) cannot hide a sovereignty leak.

The wrappers run only under the dedicated gate: `qa:personas:postgres` sets
`QA_PERSONAS_POSTGRES=1`, and without that marker they skip with a reason —
so `qa:personas:sqlite`, which shares their directory, never touches
PostgreSQL even when `QA_POSTGRES_URL` is exported. The gate's target is
selected by `QA_POSTGRES_URL` (a dedicated variable on purpose: the
repository Vitest test environment pins `DATABASE_URL` to `sqlite::memory:`
inside every worker, overriding any outer value) with the same
`ALLOW_POSTGRES_TEST_RESET=true` reset guard and the same
dedicated-test-database restriction as the PostgreSQL database gate — only
bare `test` and `*_test`-suffixed names such as `terrastories_test` may be
reset; a `test_*` prefix is not allowed. When the gate is active but its
target is not ready — including a PostgreSQL URL without the guard, an
explicit operator intent — the wrapper fails closed instead of skipping
green or silently downgrading to SQLite. Reports are written as `-postgres`
and `-postgres-hono` siblings of `QA_REPORT_PATH`, so parallel wrappers
never race on one file.

The `persona-qa-postgres` job in `.github/workflows/ci.yml`, with check name
**Persona QA gate (PostgreSQL 13)**, runs this command on Node 20.19.0
against a `postgres:13` service whose database, server and job time zones
are deliberately non-UTC (`America/Sao_Paulo`), mirroring the PostgreSQL
database gate. The job uses no secrets and fails closed: any failed
assertion or unreached endpoint exits nonzero. Both dialect reports are
uploaded as the `persona-qa-report-postgres` artifact on every run,
including failed ones, and a missing report fails the upload step. A
maintainer must add **Persona QA gate (PostgreSQL 13)** to the repository's
required status checks for `main` together with the SQLite gate.

Negative matrices cover each resource's actual schema. Stories have restricted
and unevidenced audience fixtures; places have a restricted flag; media has held
and unknown legacy restriction metadata. Speakers, themes and users have no
independent restricted/unknown audience field in this schema, so their matrix
checks community boundaries instead of inventing product fields. The
`restrictionApplicability` map in `personas/negative-matrix.ts` records this.
The restricted-holder logs in as a separately provisioned community admin;
there is no V2 elder role and this identity receives no extra read privilege.

The spec requires unavailable content to remain unavailable, without prescribing
one HTTP status for every authorization stage. Journeys expect 404 for a hidden
row when the route permits the actor to perform lookups, and 403 when a role is
refused access to the entire route family regardless of the requested ID.
Request-failure messages identify the failed operation (preparation, transport,
or response JSON) and never copy exception text that could contain credentials.
Use `QA_REPORT_PATH=/absolute/path/report.json` with the SQLite Vitest wrapper to
retain its report even when assertions fail.

Requests have a 30-second default deadline spanning preparation, transport and
body reads. Set `--request-timeout-ms 10000` (or `requestTimeoutMs` in-process)
to change it. Responses are consumed or cancelled, and stalled operations fail
with a sanitized stage diagnostic. Logout journeys explicitly replay the saved
pre-logout cookie, and a Set-Cookie that empties the session cookie (for
example `ts_session=`) clears the runner's tracked cookie instead of adopting
the empty value. Media isolation fixtures contain real owned PNG files and a
readable control; fixture cleanup removes only those created files.

Password reset token lookup remains disabled in the current API. The journey
checks a complete request with an invalid token **format**, at the handler,
without claiming successful recovery or valid-format token lookup coverage.
Restoring the full recovery flow is outside this phase-1 QA change.
