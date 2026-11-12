# Persona QA

Run the isolated SQLite acceptance wrapper with:

```sh
npx vitest run tests/scripts/qa --maxWorkers=2
```

The CLI accepts an explicit fixture module so it never silently seeds a deployed
community:

```sh
npm run qa:personas -- --fixture ./scripts/qa/sqlite-fixture.ts
```

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

CI release-gate integration and disconnected field-kit acceptance remain owned
by #147. SQLite results do not establish PostgreSQL or Workers readiness.

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
