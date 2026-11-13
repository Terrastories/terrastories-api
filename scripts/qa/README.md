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
derived from `app.routes` itself (middleware `ALL`/wildcard registrations
and `bodyLimit`'s duplicate login entry are not endpoints), so registering a
new Hono route fails coverage until a journey reaches it or a reviewed
exclusion names it; today every Hono endpoint is reached and the fixture
excludes nothing. Journeys cover anonymous Explore browsing (ruling #162
option A: restricted and unevidenced rows are hidden from every role),
session lifecycle for viewer, member, editor and community admin (own-user
profile without secrets, community-scoped media, logout/revoke replay),
super-admin boundaries, identical 401 bodies for wrong-password and
unknown-user logins, and the #147-skipped field-kit persona. The Vitest
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
pre-logout cookie. Media isolation fixtures contain real owned PNG files and a
readable control; fixture cleanup removes only those created files.

Password reset token lookup remains disabled in the current API. The journey
checks a complete request with an invalid token **format**, at the handler,
without claiming successful recovery or valid-format token lookup coverage.
Restoring the full recovery flow is outside this phase-1 QA change.
