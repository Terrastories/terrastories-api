# GEMINI.md

## Project: Terrastories API

TypeScript backend migration of Rails geostorytelling platform for Indigenous communities. Multi-tenant, offline-capable, geographic data management.

## 📚 Documentation Reference

**⚠️ REQUIRED READING**: Before starting any work, review relevant docs:

- **🏗️ Project Setup**: `@docs/SETUP.md` - Environment, dependencies, troubleshooting
- **🌍 Terrastories Context**: `@docs/TERRASTORIES_CONTEXT.md` - Rails architecture, domain models, business logic
- **🔄 Migration Guide**: `@docs/MIGRATION.md` - Rails→TypeScript migration strategy and challenges
- **🗺️ Migration Strategy**: `@ROADMAP.md` - High-level migration phases and current status
- **📋 Issue Roadmap**: `@docs/ISSUES_ROADMAP.md` - Detailed 60-issue backend migration plan
- **🎨 Frontend Guide**: `@docs/FRONTEND_MIGRATION_GUIDE.md` - Future React migration details
- **⚡ Autonomous Workflow**: `@docs/WORKFLOW.md` - Advanced development workflow with checkpoints
- **💡 Code Examples**: `@docs/examples/` - Repository, route, service, and test patterns

**When to consult each**:

- **Setup issues** → SETUP.md
- **Domain questions** → TERRASTORIES_CONTEXT.md
- **Architecture decisions** → MIGRATION.md
- **Migration overview** → ROADMAP.md
- **Next feature priority** → ISSUES_ROADMAP.md
- **Future frontend work** → FRONTEND_MIGRATION_GUIDE.md
- **Complex workflows** → WORKFLOW.md
- **Implementation patterns** → examples/

## Core Stack

- **Fastify 5** + Swagger UI
- **Drizzle ORM** + PostgreSQL/SQLite
- **Zod** validation
- **Vitest** testing
- **TypeScript 5.7** strict mode

## Architecture

```
src/
├── server.ts          # Fastify setup + plugins
├── routes/            # Route handlers with Zod schemas
├── services/          # Business logic
├── repositories/      # Data access layer
├── db/
│   ├── schema/        # Drizzle tables
│   └── migrations/
└── shared/
    ├── types/         # Shared TypeScript types
    └── middleware/    # Auth, multi-tenancy
```

## Key Patterns

- **Repository Pattern**: All DB queries through repositories
- **Service Layer**: Business logic isolated from routes
- **Schema Validation**: Zod schemas → TypeScript types → OpenAPI docs
- **Multi-tenancy**: Community-scoped data isolation via middleware
- **Error Handling**: Centralized error handler with proper status codes

## Database Models (Enhanced with Cultural & Offline Support)

- **Community**: Tenant root with cultural protocols (id, name, locale, culturalSettings, offlineConfig)
- **User**: Auth + roles with cultural access (super_admin, admin, editor, viewer, elder)
- **Story**: Content with cultural protocols (title, desc, communityId, privacyLevel, culturalRestrictions, syncMetadata)
- **Place**: PostGIS geographic locations (name, geometry, geography, region, culturalSignificance, offlineCache)
- **Speaker**: Storytellers with cultural sensitivity (name, bio, photoUrl, communityId, culturalRole, elderStatus)
- **Relations**: story_places, story_speakers with cultural metadata (culturalContext, accessRestrictions, syncStatus)

## Development Workflow

### MANDATORY: For Each Task

```
1. VERIFY ISSUE REQUIREMENTS (CRITICAL)
   - Read GitHub issue completely: `gh issue view [number]`
   - Cross-reference with ROADMAP.md if mentioned
   - Ensure EXACT alignment between issue and roadmap
   - Verify acceptance criteria are clear and complete
   - ❗ STOP if any mismatch between issue/roadmap
   - ❓ ASK for clarification if requirements unclear

2. ANALYZE
   - Read requirements completely
   - Check existing code/patterns
   - Identify dependencies
   - ❓ ASK if anything unclear

3. PLAN
   - Break into subtasks (max 30 min each)
   - Write acceptance criteria
   - Identify test scenarios
   - Choose appropriate patterns

4. TEST FIRST
   - Write failing test
   - Run: `npm test [filename]`
   - Verify test fails correctly
   - Never skip this step

5. CODE
   - Implement minimum to pass test
   - Add types (no 'any')
   - Handle errors properly
   - Follow existing patterns

6. VERIFY (ALL must pass)
   □ npm test [file]       # Test passes
   □ npm run type-check    # No TS errors
   □ npm run lint          # No lint errors
   □ npm run dev           # Server runs
   □ Manual test           # Feature works

7. REFACTOR
   - Improve code quality
   - Add comments for "why"
   - Ensure tests still pass

8. VALIDATE ISSUE COMPLETION (CRITICAL)
   - Re-read original GitHub issue requirements
   - Verify ALL acceptance criteria are met
   - Ensure implementation matches issue scope exactly
   - ❗ STOP if any requirements not met
   - Update issue with completion status

9. BRANCH & COMMIT
   - Create feature branch: `git checkout -b feature/issue-[number]`
   - Stage files: `git add [files]`
   - Commit: `git commit -m "type(scope): message"`
   - Types: feat|fix|docs|test|chore|refactor
   - Message: present tense, lowercase
   - Push branch: `git push -u origin feature/issue-[number]`

10. PULL REQUEST
    - Create PR: `gh pr create --title "Closes #[number]: [title]" --body "[description]" --base main --head feature/issue-[number]`
    - Reference correct issue number: "Closes #[number]"
    - Verify PR solves the referenced issue
    - NEVER commit directly to main branch

11. TRACK
    - Update issue checkboxes
    - Comment any blockers
    - Note decisions made

12. NEXT
    - Only proceed if current task complete
    - Return to step 1
```

### ⚠️ CRITICAL: Issue vs Roadmap Alignment & Cultural Sensitivity

**MANDATORY CHECK** before starting any work:

1. **GitHub Issue**: Read complete issue with `gh issue view [number]`
2. **Roadmap Cross-Reference**: If issue mentions ROADMAP.md, verify alignment with enhanced roadmap
3. **Scope Verification**: Ensure GitHub issue and roadmap item have identical scope
4. **Acceptance Criteria**: Verify criteria are clear, complete, and achievable
5. **Cultural Considerations**: Ensure Indigenous community sensitivity is addressed
6. **Offline-First Check**: Verify offline operation is considered from start
7. **Data Sovereignty**: Confirm community data isolation requirements

**If Mismatch Found**:

- ❗ **STOP** immediately - do not start work
- Document the mismatch clearly
- Ask for clarification on which requirements to follow
- Suggest creating aligned issues or updating existing ones

**Red Flags**:

- Issue title doesn't match implementation scope
- Roadmap item number doesn't align with GitHub issue content
- Acceptance criteria are vague or missing
- Dependencies don't match between issue and roadmap
- **NEW**: PostGIS requirements not considered for geographic features
- **NEW**: Cultural protocol considerations missing
- **NEW**: Offline-first design not addressed
- **NEW**: Data sovereignty validation not included

### STOP Conditions

STOP and ask for help if:

- Test won't pass after 3 attempts
- TypeScript errors unclear
- Unsure about architectural decision
- Breaking existing functionality
- Need to deviate from plan

### Commands

```bash
npm run dev        # Start with hot-reload
npm test          # Run tests with coverage
npm run lint      # ESLint check
npm run format    # Prettier format
npm run type-check # TypeScript validation
npm run db:generate  # Generate migration
npm run db:migrate   # Run migrations
npm run build     # Production build
npm run validate  # Run ALL checks
```

### Quick Validation Script

Add to package.json:

```json
"scripts": {
  "validate": "npm run type-check && npm run lint && npm test"
}
```

Run before EVERY commit!

## Testing Strategy

- **Unit**: Services, utilities (mock dependencies)
- **Integration**: Routes with test database
- **E2E**: Critical user flows
- **Coverage**: Minimum 80% all metrics

## API Conventions

- **Routes**: `/api/v1/[resource]`
- **Auth**: Bearer token in Authorization header
- **Pagination**: `?page=1&limit=20`
- **Filtering**: `?community=123&restricted=false`
- **Responses**: `{ data: T, meta?: {}, error?: {} }`

## Environment Variables

```env
NODE_ENV=development
PORT=3000
DATABASE_URL=postgresql://...
JWT_SECRET=...
LOG_LEVEL=debug
```

## Git Conventions

- **Branches**: `feature/`, `fix/`, `chore/`
- **Commits**: `type(scope): message`
  - feat, fix, docs, style, refactor, test, chore
- **PRs**: Link issue, describe changes, check tests pass

## Critical Constraints

- **Data Sovereignty**: Super admins cannot access community data (MUST be validated, not assumed)
- **Offline-First**: All design decisions must consider offline operation from start
- **PostGIS Foundation**: Geographic data is core to Terrastories identity, not optional
- **Cultural Protocols**: Indigenous community cultural sensitivity is foundational
- **ActiveStorage Complexity**: Media migration requires careful relationship preservation
- **Field Kit Deployment**: Unique offline-only deployment model for remote areas
- **Media Storage**: Support large files (video/audio) with offline caching
- **Performance**: Geographic queries must be optimized from Phase 1
- **Security**: Role-based access per community with cultural protocol enforcement

## Common Patterns (DO)

✅ Route → Service → Repository → Database
✅ Validate input with Zod at route level (including cultural protocol validation)
✅ Return typed responses with proper status codes
✅ Use transactions for multi-table operations (especially for cultural data)
✅ Log errors with context (but never log sensitive cultural information)
✅ Test edge cases and error paths (including cultural protocol edge cases)
✅ **NEW**: Design with offline-first from start (sync metadata, conflict resolution)
✅ **NEW**: Include PostGIS spatial considerations for all geographic features
✅ **NEW**: Implement community data isolation at query level
✅ **NEW**: Consider cultural protocols in all user-facing features
✅ **NEW**: Plan for Field Kit deployment scenarios

## Anti-Patterns (DON'T)

❌ Direct database queries in routes
❌ Business logic in controllers
❌ Using 'any' type
❌ Catching errors without handling
❌ Skipping tests "for now"
❌ Committing without validation
❌ **NEW**: Ignoring offline-first design considerations
❌ **NEW**: Treating PostGIS as optional for geographic features
❌ **NEW**: Assuming data sovereignty works without testing
❌ **NEW**: Designing features without cultural protocol considerations
❌ **NEW**: Adding geographic features without spatial indexing
❌ **NEW**: Creating community features without isolation validation

## Quick Reference

- Drizzle Docs: https://orm.drizzle.team
- Fastify: https://fastify.dev
- Zod: https://zod.dev
- Original Rails: https://github.com/Terrastories/terrastories

## Success Indicators

You're on track if:

- ✅ Each commit passes `npm run validate`
- ✅ Tests written before code
- ✅ No TypeScript 'any' types
- ✅ Coverage stays above 80%
- ✅ PR checks are green
- ✅ Code follows existing patterns

## Red Flags (Stop and ask for help)

- 🚨 Tests failing after implementation
- 🚨 TypeScript compilation errors
- 🚨 Can't start server
- 🚨 Database connection issues
- 🚨 Unclear requirements
- 🚨 Need to use 'any' type

## 🧭 Documentation Navigation Guide

### Before Starting Work

1. **New to project?** → Read `@docs/TERRASTORIES_CONTEXT.md` for domain understanding
2. **Setting up environment?** → Follow `@docs/SETUP.md` step-by-step
3. **Understanding migration?** → Review `@docs/MIGRATION.md` for context

### During Development

1. **Need code patterns?** → Check `@docs/examples/` for templates
2. **Stuck on architecture?** → Consult `@docs/MIGRATION.md` section on your domain
3. **Planning next feature?** → Reference `@docs/ISSUES_ROADMAP.md` for priorities
4. **Complex multi-session work?** → Use `@docs/WORKFLOW.md` autonomous patterns

### Specific Domains

- **Authentication/Authorization** → TERRASTORIES_CONTEXT.md (sections: Auth & Multi-tenancy)
- **Geographic/Spatial Data** → TERRASTORIES_CONTEXT.md (sections: PostGIS & Mapping)
- **Media Handling** → TERRASTORIES_CONTEXT.md (section: Media Handling Architecture)
- **Offline/Sync** → TERRASTORIES_CONTEXT.md (section: Offline Synchronization)
- **API Design** → TERRASTORIES_CONTEXT.md (section: API Architecture) + examples/route-example.ts
- **Database Schema** → TERRASTORIES_CONTEXT.md (section: Database Models) + examples/repository-example.ts

- Never use "git add ." or "git add -A", always stage per file relevant to the current implementation.
