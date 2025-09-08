# Terrastories TypeScript API Setup Guide

**✅ Migration Complete**: The Rails-to-TypeScript backend migration is now complete! This guide covers the **production-ready TypeScript API** setup.

## Prerequisites

### Required Software

- **Node.js 20.x or 22.x** (verified in CI)
- **npm 9+** or **yarn 3+**
- **Git 2.30+**
- **Docker & Docker Compose** (recommended for production)

### Optional for Development

- **PostgreSQL 14+** with **PostGIS 3.2+** (or use Docker)
- **Redis 6+** (for session storage in production)

## Quick Start

1. **Clone and install**

   ```bash
   git clone <repository-url>
   cd terrastories-api
   npm install
   ```

2. **Environment setup**

   ```bash
   cp .env.example .env
   # Edit .env with your database settings
   ```

3. **Database setup**

   ```bash
   npm run db:generate  # Generate migrations
   npm run db:migrate   # Run migrations
   npm run db:seed      # Seed test data (optional)
   ```

4. **Development**

   ```bash
   npm run dev          # Start development server
   ```

5. **Verify setup**
   - Server: http://localhost:3000
   - Health check: http://localhost:3000/health
   - API docs: http://localhost:3000/docs

## Development Workflow

### Before committing

```bash
npm run validate     # Run all checks
```

This runs:

- TypeScript compilation
- ESLint
- Tests with coverage
- Build verification

### Pre-commit hooks

Husky automatically runs lint-staged on commit, which:

- Fixes ESLint issues
- Formats code with Prettier
- Runs type checking

### Testing

```bash
npm test             # Run tests
npm run test:coverage # Run with coverage report
```

### Database operations

```bash
npm run db:generate  # Generate new migration
npm run db:migrate   # Apply migrations
npm run db:seed      # Seed database
```

## Project Structure

```
src/
├── server.ts          # Application entry point
├── app.ts            # Fastify app configuration
├── routes/           # API route handlers
│   ├── health.ts     # Health check endpoint
│   └── index.ts      # Route registration
├── db/              # Database layer
│   ├── schema/      # Drizzle table definitions
│   ├── migrations/  # Database migrations
│   └── index.ts     # Database connection
├── services/        # Business logic
├── repositories/    # Data access layer
└── shared/         # Shared utilities
    ├── types/      # TypeScript type definitions
    ├── middleware/ # Express middleware
    └── utils/      # Helper functions
```

## Environment Variables

Required variables (see `.env.example`):

```env
NODE_ENV=development
PORT=3000
DATABASE_URL=./data.db
JWT_SECRET=your-secret-key
LOG_LEVEL=debug
```

## Troubleshooting

### Common Issues

**TypeScript errors**: Ensure you're using Node.js 18+ and run `npm run type-check`

**Database connection**: Check `DATABASE_URL` in `.env` file

**Port already in use**: Change `PORT` in `.env` or stop other processes

**Pre-commit hook fails**: Run `npm run validate` to see specific failures

### Getting Help

1. Check this documentation
2. Review error logs: `npm run dev` shows detailed errors
3. Verify environment: `node --version` and `npm --version`
4. Clear cache: `rm -rf node_modules package-lock.json && npm install`

## Architecture Decisions

- **Fastify**: High-performance HTTP framework
- **Drizzle ORM**: Type-safe SQL with great TypeScript integration
- **SQLite**: Development database (PostgreSQL for production)
- **Zod**: Runtime validation with TypeScript integration
- **Vitest**: Fast testing framework
- **ESLint + Prettier**: Code quality and formatting

## Contributing

1. Follow conventional commit format: `type(scope): description`
2. All tests must pass: `npm run validate`
3. Maintain 80%+ test coverage
4. Update documentation for new features
