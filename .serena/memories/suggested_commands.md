# Essential Commands

## Development

```bash
npm run dev          # Start with hot-reload
npm test            # Run tests with coverage
npm run lint        # ESLint check
npm run format      # Prettier format
npm run type-check  # TypeScript validation
npm run validate    # Run ALL checks (must pass before commit)
```

## Database

```bash
npm run db:generate  # Generate migration
npm run db:migrate   # Run migrations
npm run db:seed     # Seed test data
```

## Build & Deploy

```bash
npm run build       # Production build
npm start          # Run production server
```

## Quality Gates (ALL must pass)

1. `npm run type-check` - No TypeScript errors
2. `npm run lint` - No ESLint errors
3. `npm test` - All tests pass (80%+ coverage)
4. `npm run build` - Builds successfully
5. Server starts and `/health` returns 200

## Git Workflow

```bash
git add [files]
git commit -m "type(scope): message"  # Conventional commits
```

## System Commands (Linux)

- `ls`, `cd`, `grep`, `find`, `curl`
- `gh issue list`, `gh pr create`
