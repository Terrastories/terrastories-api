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
