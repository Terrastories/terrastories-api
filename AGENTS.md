# Repository Guidelines

## Project Structure & Module Organization

- `src/`: application code
  - `routes/`: Fastify routes (e.g., `auth.ts`, `communities.ts`)
  - `services/`: business logic (e.g., `user.service.ts`)
  - `repositories/`: data access (e.g., `story.repository.ts`)
  - `db/`: Drizzle setup, migrations, and seeds
  - `shared/`: types, helpers, middleware
- `tests/`: unit, integration, and helpers (Vitest)
- `dist/`: compiled output (build)
- `docs/`: architecture, setup, and roadmap

## Build, Test, and Development Commands

- `npm run dev`: start Fastify server with hot reload.
- `npm run build`: compile TypeScript to `dist/`.
- `npm start`: run production build.
- `npm test`: run tests; `npm run test:coverage` enforces 80% coverage.
- `npm run lint` / `npm run format`: lint and format sources.
- Database: `npm run db:generate` (migrations), `npm run db:migrate` (apply), `npm run db:seed` (sample data).

Examples:

```
cp .env.example .env && npm run db:migrate && npm run dev
```

## Coding Style & Naming Conventions

- Language: TypeScript (ESM). Prefer strict types; avoid `any` (enforced in src).
- Formatting: Prettier (2 spaces, semicolons, single quotes, width 80).
- Linting: ESLint with `typescript-eslint`. Key rules: `no-var`, `prefer-const`, no unused vars (prefix `_` to ignore).
- File naming: kebab-case with role suffixes, e.g. `user.service.ts`, `story.repository.ts`.
- Imports: use aliases `@` for `src` and `~tests` for `tests`.

```ts
import { UserService } from '@/services/user.service';
```

## Testing Guidelines

- Framework: Vitest with Node env and global setup (`tests/setup.ts`).
- Location/patterns: `tests/**/*.{test,spec}.ts` or colocated in `src/**`.
- Coverage: global 80% min; coverage reports in `coverage/`.
- Database tests use isolated in-memory SQLite helpers (`tests/helpers/database.ts`).

Run specific tests:

```
npm test tests/routes/health.test.ts
```

## Commit & Pull Request Guidelines

- Commits: follow Conventional Commits where possible:
  - `feat: add community slug validation`
  - `fix: handle invalid JWT in auth route`
- Pre-commit runs lint-staged (ESLint + Prettier). Ensure `npm run validate` passes.
- PRs: include description, linked issues, test coverage (new/changed code), and any API examples (e.g., cURL) when relevant. Screenshots optional for docs.

## GitHub Workflow (gh CLI)

- Auth: `gh auth status` (login if needed: `gh auth login`).
- Find work: `gh issue list -L 20 --state open --label "good first issue"`.
- Inspect: `gh issue view <num> -w` and `gh pr view <num> -w`.
- Branch: `git checkout -b feat/<topic>`.
- Create PR: `gh pr create -f -t "feat: <title>" -b "<summary>\nCloses #<issue>" -B main`.
- Review PRs: `gh pr list -L 20`, checkout with `gh pr checkout <num>`.
- Leave feedback: `gh pr review <num> -c "<comment>"` | approve: `-a` | request changes: `-r`.
- Status and CI: `gh pr status` and `gh run watch`.

## Issue Review & Analysis Guidelines

When reviewing or revising GitHub issues, follow this systematic approach:

### Issue Information Gathering

```bash
# Fetch complete issue details
gh issue view <number> --json title,body,labels,assignees,milestone,comments

# Check related issues and dependencies
gh issue list --search "in:body #<number>"
```

### Issue Quality Assessment

**Required Sections to Validate:**

- **Overview**: Clear problem statement with context
- **Acceptance Criteria**: Specific, measurable, testable requirements
- **Technical Plan**: Implementation approach and constraints
- **Testing Strategy**: How to validate the solution
- **Estimation**: Size/complexity with reasoning

**Quality Checklist:**

- [ ] Title clearly describes the issue
- [ ] Problem statement is unambiguous
- [ ] Acceptance criteria are SMART (Specific, Measurable, Achievable, Relevant, Time-bound)
- [ ] Technical approach is feasible and documented
- [ ] Dependencies are identified
- [ ] Testing approach is defined
- [ ] Estimation reflects actual scope

### Issue Revision Process

When revising issues based on feedback:

1. **Analyze Current Structure**: Parse existing sections and identify gaps
2. **Apply Revision Instructions**: Implement specific feedback systematically
3. **Validate Consistency**: Ensure acceptance criteria align with technical plan
4. **Check Scope Alignment**: Warn if scope increases >50% (potential split needed)
5. **Update Estimation**: Recalculate based on scope changes

```bash
# Update issue after revision
gh issue edit <number> --title "New Title" --body "$(cat revised-issue.md)"

# Add revision comment
gh issue comment <number> --body "📝 Issue revised: [summary of changes]"
```

## Pull Request Review Guidelines

Comprehensive PR review process focusing on multi-source feedback aggregation:

### PR Information Gathering

```bash
# Complete PR context
gh pr view <number> --json title,body,author,files,additions,deletions,commits

# Get full diff with context
gh pr diff <number>

# Review existing feedback
gh pr view <number> --json comments,reviews

# Check CI/CD status
gh pr checks <number>

# List all PR files for focused review
gh pr view <number> --json files --jq '.files[].filename'
```

### Multi-Source Review Collection

**Review Sources to Aggregate:**

1. **GitHub Native Reviews**: Human reviewer feedback and approval status
2. **AI Reviewers**: CodeRabbit, Qodo, DeepCode comments and suggestions
3. **CI/CD Checks**: Test results, linting, security scans, build status
4. **Security Scanning**: Vulnerability assessments and compliance checks
5. **Performance Analysis**: Bundle size, load time, runtime performance

### Review Categorization Framework

**🔴 Blocking Issues** (Must Fix Before Merge):

- Security vulnerabilities or flaws
- Breaking changes without migration path
- Failing tests or critical functionality breaks
- TypeScript compilation errors
- Major architectural violations

**🟡 Important Issues** (Should Fix):

- Performance concerns or bottlenecks
- Poor error handling or edge case gaps
- Missing documentation or unclear code
- Accessibility violations
- Significant code quality issues

**🔵 Suggestions & Nitpicks** (Consider):

- Code style and formatting preferences
- Refactoring opportunities for clarity
- Naming convention improvements
- Comment clarity and documentation style
- Minor optimizations

### Review Analysis Process

```bash
# Automated quality checks
npm run validate  # runs lint + type-check + test

# Security scanning
npm audit --audit-level moderate

# Test coverage validation
npm run test:coverage

# Build verification
npm run build
```

### PR Review Output Format

Structure feedback using this template:

```markdown
## 📊 PR Review for #<number>

**Status:** [NEEDS WORK | READY FOR REVIEW | APPROVED]

### Summary

Brief assessment of changes and overall quality.

### 🔴 Blocking Issues

- `src/file.ts:42`: [Critical issue description with specific fix needed]

### 🟡 Important Issues

- `src/another.ts:15`: [Important issue with suggested improvement]

### 🔵 Suggestions

- `src/component.ts:28`: [Enhancement suggestion for consideration]

### ✅ Positive Feedback

- [Highlight what was implemented well]

### 📋 Checklist

- [ ] All tests passing
- [ ] TypeScript compilation clean
- [ ] Linting issues resolved
- [ ] Security scan clean
- [ ] Documentation updated
- [ ] Breaking changes documented
```

### Automated Fix Strategies

**Fixable Issues (Auto-apply when safe):**

- TypeScript type errors with clear solutions
- ESLint rule violations
- Import/export organization
- Simple test updates
- Documentation additions

**Manual Review Required:**

- Complex refactoring suggestions
- Architecture decisions
- Business logic changes
- Database schema modifications
- Security-sensitive code

### Final Validation Before Merge

```bash
# Comprehensive validation suite
gh pr checks <number>  # All CI green
npm run validate       # Local checks pass
npm test              # Full test suite
npm run build         # Production build success

# Verify no unresolved review threads
gh pr view <number> --json reviews --jq '.reviews[] | select(.state == "CHANGES_REQUESTED")'
```

### PR Comment Integration

```bash
# Post comprehensive review
gh pr comment <number> --body-file review-summary.md

# Request specific changes
gh pr review <number> --request-changes --body "Changes needed: [details]"

# Approve after fixes
gh pr review <number> --approve --body "All issues addressed. Ready to merge!"
```

## Security & Configuration Tips

- Never commit secrets; start from `.env.example`.
- Required vars: `DATABASE_URL`, `JWT_SECRET`. PostgreSQL + PostGIS in production; tests default to in-memory SQLite.
- Prefer parameterized queries via Drizzle and validate inputs with Zod.
