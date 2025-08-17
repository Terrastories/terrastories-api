# Terrastories API - Project Overview

## Purpose

TypeScript backend migration of Rails geostorytelling platform for Indigenous communities. Multi-tenant, offline-capable, geographic data management system.

## Tech Stack

- **Runtime**: Node.js 20+ with TypeScript 5.7+
- **HTTP Framework**: Fastify 5.x
- **Database**: PostgreSQL (production), SQLite (dev/test)
- **ORM**: Drizzle ORM with drizzle-kit
- **Validation**: Zod schemas
- **Testing**: Vitest with coverage
- **Build**: tsx (dev), tsc (prod)

## Architecture Pattern

- Repository Pattern for data access
- Service Layer for business logic
- Schema-first API with Zod → OpenAPI
- Multi-tenant community isolation
- Error handling middleware

## Key Models

- Community (tenant root)
- User (roles: super_admin, admin, editor, viewer)
- Story (content with media)
- Place (geographic locations)
- Speaker (storytellers)
- Relations: story_places, story_speakers

## Critical Constraints

- Data sovereignty (super admins cannot access community data)
- Offline support with sync capabilities
- Role-based access per community
- Geographic query optimization
