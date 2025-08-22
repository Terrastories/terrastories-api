# Command: /fix-tests

## Purpose

Diagnose and fix failing tests by correcting production code first. Only modify tests when they are demonstrably incorrect or outdated and cannot be satisfied by correct behavior. Preserve coverage and quality gates.

## Usage

```
/fix-tests
/fix-tests [--file tests/path/to.test.ts]
/fix-tests [--match "test name substring"]
/fix-tests [--since <git-ref>] [--only-changed]
/fix-tests [--max-iterations 3]
/fix-tests [--focus routes|services|repositories|db|schemas]
```

## Strict Guardrails

- Fix code first: prioritize changes in `src/**` over `tests/**`.
- Do not skip/disable tests: never use `.skip`, `.todo`, `.only`, or increase timeouts to mask issues.
- Only change tests when:
  - The test asserts an outdated API contract that was intentionally changed and documented, or
  - The test contains incorrect assumptions (bad fixtures, invalid types, inconsistent schema) and the correct behavior is clear from docs (`docs/**`) and current source, or
  - The test is flaky due to non-determinism and you make the underlying code deterministic.
- Preserve types: do not introduce `any` in `src/**`.
- Keep changes minimal, focused, and aligned with repository patterns.

## Execution Flow

### Phase 0: Preflight

```bash
set -e
mkdir -p .claude/temp
echo "NODE_ENV=test" > .claude/temp/env
cp -n .env.test .env 2>/dev/null || true
npm run type-check || true   # collect TS errors but continue
npm run lint || true         # collect lint errors but continue
```

Collect environment and initial signals without failing fast. Use findings to inform root-cause analysis.

### Phase 1: Detect Failures

```bash
# Full suite with machine-readable output
vitest run --reporter=json --passWithNoTests \
  > .claude/temp/vitest.results.json 2> .claude/temp/vitest.stderr.log || true

# Quick summary of failing tests
node -e '
  const fs = require("fs");
  const p = ".claude/temp/vitest.results.json";
  if (!fs.existsSync(p)) process.exit(0);
  const data = JSON.parse(fs.readFileSync(p, "utf8"));
  const failed = [];
  (data.testResults||[]).forEach(file => {
    (file.assertionResults||[]).forEach(t => {
      if (t.status === "failed") failed.push({file: file.name, title: t.title});
    });
  });
  fs.writeFileSync(".claude/temp/failing.json", JSON.stringify(failed, null, 2));
  console.log(`Found ${failed.length} failing tests`);
' || true
```

If a specific file or test is provided, run it first for faster feedback: `npm test tests/… -t "…"`.

### Phase 2: Triage & Prioritize

Categorize failures by symptom to target the right layer:

- Assertion mismatch → likely service/repository logic or schema shape.
- 4xx/5xx in route tests → route handler, validation (Zod), or middleware.
- Type errors at runtime → incorrect DTO/types/adapter mapping.
- DB errors (missing table/column/constraint) → schema or repository query; verify `tests/helpers/database.ts` setup before touching migrations.
- File/media tests → `file.service.ts` MIME detection and path handling.

Record a triage note per failing test:

```json
{
  "file": "tests/services/user.service.test.ts",
  "title": "creates user with hashed password",
  "suspectedLayer": "services",
  "hypothesis": "password not hashed on create",
  "evidence": ["plain text string compared against argon2 hash"],
  "fixScope": ["src/services/user.service.ts"],
  "avoid": ["modifying test assertions"]
}
```

### Phase 3: Reproduce Narrowly

For each failing test, reproduce in isolation:

```bash
npm test tests/path/to.test.ts -t "failing test name"
```

Use error stack to jump to source. Inspect adjacent patterns in the same layer (e.g., compare `place.service.ts` with `story.service.ts`).

### Phase 4: Fix Code (Preferred)

Apply minimal, correct changes in `src/**` that make behavior align with contracts defined in:

- Types and Zod schemas in `src/shared/schemas/**`
- Repositories in `src/repositories/**` (parameterized queries only)
- Services in `src/services/**` (business rules)
- Routes in `src/routes/**` (validation, status codes, payload shape)

Checklist for robust fixes:

- Validate inputs with Zod; return proper status codes.
- Maintain multi-tenancy boundaries and data sovereignty constraints.
- Keep strict types; propagate accurate return types to callers.
- Handle null/undefined and empty results explicitly.
- Avoid incidental API changes unless required; if changed, update OpenAPI swagger files in `src/shared/schemas/*.swagger.ts` and relevant docs.

### Phase 5: Verify Incrementally

```bash
# Targeted test
npm test tests/path/to.test.ts -t "specific"

# Layer test group (optional)
npm test tests/services/user.service.test.ts

# Full suite + coverage gate
npm run test:coverage

# Static checks
npm run type-check
npm run lint
```

All must pass before moving on to the next failing test.

### Phase 6: When Test Changes Are Justified

Modify tests only if one of the following is true and verifiable:

- The test’s expectation contradicts the documented contract in `docs/**` and the current code follows the documented contract.
- The test relies on outdated route paths, response shapes, or schema names after a completed and documented migration.
- The test uses invalid fixtures (e.g., violates Zod schema) not representative of real inputs.
- The test is flaky due to non-determinism; you fix the underlying code to be deterministic and then adjust the test accordingly.

Rules when changing tests:

- Update fixtures to valid shapes via `tests/helpers/**` rather than inline duplication.
- Never relax assertions to broad truths (e.g., removing key fields) just to pass.
- Add a short comment referencing the contract or doc that required the change.
- Re-run the suite and ensure coverage does not drop.

### Phase 7: Database/Schema Specifics

- Tests use isolated in-memory SQLite via `tests/helpers/database.ts`. Prefer fixing repository queries and schema types over altering global migrations.
- If a migration/schema mismatch is the cause, fix the corresponding model in `src/db/schema/**` and align repositories. Only add migrations if the domain model truly changed.

### Phase 8: Finalization

```bash
npm run test:coverage          # >= 80% global coverage
npm run type-check             # no TS errors
npm run lint && npm run format # clean style
```

Prepare a concise fix summary with before/after behavior, files touched, and rationale (especially if any test files changed).

## Automation Snippets

### List Only Failing Test Files

```bash
jq -r '([.testResults[] | select(.status=="failed") | .name] // [])[]' \
  .claude/temp/vitest.results.json | sort -u > .claude/temp/failing-files.txt
```

### Run Only Changed Tests Since Ref

```bash
CHANGED=$(git diff --name-only --diff-filter=AMR origin/main...HEAD | grep -E '^(src|tests)/.*\.ts$' || true)
echo "$CHANGED" | grep '^tests/' || true
```

### Map Failure To Layer Heuristics (TS)

```ts
type Layer = 'routes' | 'services' | 'repositories' | 'db' | 'schemas';
export function inferLayer(filePath: string, message: string): Layer {
  if (filePath.includes('/routes/')) return 'routes';
  if (filePath.includes('/services/')) return 'services';
  if (message.match(/no such table|no column|syntax error/i)) return 'db';
  if (message.match(/zod|validation|schema/i)) return 'schemas';
  return 'repositories';
}
```

## Acceptance Criteria

- All previously failing tests now pass; no tests disabled or watered down.
- Overall test suite passes locally with coverage ≥ 80% (`npm run test:coverage`).
- No TypeScript or ESLint errors.
- Production behavior is corrected and documented where necessary.
- Any test modifications include rationale and align with documented contracts.

## Links With Other Commands

- Can be run as a subphase within `/work` during the Verify step.
- Complements `/review-pr --focus tests` by auto-applying fixes pre-merge.
