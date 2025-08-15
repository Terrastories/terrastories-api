# CLAUDE.md

## Project: Terrastories API

TypeScript backend migration of Rails geostorytelling platform for Indigenous communities. Multi-tenant, offline-capable, geographic data management.

## 📚 Documentation Reference

**⚠️ REQUIRED READING**: Before starting any work, review relevant docs:

- **🏗️ Project Setup**: `@docs/SETUP.md` - Environment, dependencies, troubleshooting
- **🌍 Terrastories Context**: `@docs/TERRASTORIES_CONTEXT.md` - Rails architecture, domain models, business logic
- **🔄 Migration Guide**: `@docs/MIGRATION.md` - Rails→TypeScript migration strategy and challenges
- **🗺️ Development Roadmap**: `@docs/ISSUES_ROADMAP.md` - 60-issue migration plan with phases
- **⚡ Autonomous Workflow**: `@docs/WORKFLOW.md` - Advanced development workflow with checkpoints
- **💡 Code Examples**: `@docs/examples/` - Repository, route, service, and test patterns

**When to consult each**:

- **Setup issues** → SETUP.md
- **Domain questions** → TERRASTORIES_CONTEXT.md
- **Architecture decisions** → MIGRATION.md
- **Next feature priority** → ISSUES_ROADMAP.md
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

## Database Models

- **Community**: Tenant root (id, name, locale)
- **User**: Auth + roles (super_admin, admin, editor, viewer)
- **Story**: Content with media (title, desc, communityId, isRestricted)
- **Place**: Geographic locations (name, lat, long, region)
- **Speaker**: Storytellers (name, bio, photoUrl, communityId)
- **Relations**: story_places, story_speakers (many-to-many)

## Development Workflow

### MANDATORY: For Each Task

```
1. ANALYZE
   - Read requirements completely
   - Check existing code/patterns
   - Identify dependencies
   - ❓ ASK if anything unclear

2. PLAN
   - Break into subtasks (max 30 min each)
   - Write acceptance criteria
   - Identify test scenarios
   - Choose appropriate patterns

3. TEST FIRST
   - Write failing test
   - Run: `npm test [filename]`
   - Verify test fails correctly
   - Never skip this step

4. CODE
   - Implement minimum to pass test
   - Add types (no 'any')
   - Handle errors properly
   - Follow existing patterns

5. VERIFY (ALL must pass)
   □ npm test [file]       # Test passes
   □ npm run type-check    # No TS errors
   □ npm run lint          # No lint errors
   □ npm run dev           # Server runs
   □ Manual test           # Feature works

6. REFACTOR
   - Improve code quality
   - Add comments for "why"
   - Ensure tests still pass

7. COMMIT
   - Stage files: `git add [files]`
   - Commit: `git commit -m "type(scope): message"`
   - Types: feat|fix|docs|test|chore|refactor
   - Message: present tense, lowercase

8. PULL REQUEST
   - Create PR if not exists
   - Update PR description
   - Link to issue
   - Mark ready for review

9. TRACK
   - Update issue checkboxes
   - Comment any blockers
   - Note decisions made

10. NEXT
    - Only proceed if current task complete
    - Return to step 1
```

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

- **Data Sovereignty**: Super admins cannot access community data
- **Offline Support**: API must handle sync conflicts
- **Media Storage**: Support large files (video/audio)
- **Performance**: Geographic queries must be optimized
- **Security**: Role-based access per community

## Common Patterns (DO)

✅ Route → Service → Repository → Database
✅ Validate input with Zod at route level
✅ Return typed responses with proper status codes
✅ Use transactions for multi-table operations
✅ Log errors with context
✅ Test edge cases and error paths

## Anti-Patterns (DON'T)

❌ Direct database queries in routes
❌ Business logic in controllers
❌ Using 'any' type
❌ Catching errors without handling
❌ Skipping tests "for now"
❌ Committing without validation

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
