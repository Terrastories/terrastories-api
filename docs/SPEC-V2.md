# Terrastories API V2 -- Technical Specification

| Field        | Value                                                        |
|--------------|--------------------------------------------------------------|
| **Status**   | Final Draft                                                  |
| **Created**  | 2026-06-07                                                   |
| **Updated**  | 2026-06-08                                                   |
| **Authors**  | Terrastories Team                                            |
| **Reviewers**| DeepSeek (automated -- 9 risks identified and addressed)     |
| **Repo**     | `terrastories-api`                                           |
| **Epic**     | V2 Cloudflare Edge Migration                                 |

---

## 1. Problem Statement

Terrastories is an offline-first geostorytelling platform used by Indigenous and local communities to map, manage, and share place-based oral histories. The current V1 API (Node.js + Fastify + PostgreSQL) requires self-hosted servers or Docker -- a deployment model that is a barrier to adoption for communities lacking infrastructure or technical capacity.

**The solution**: Rebuild the API to run on Cloudflare's edge infrastructure (Workers, D1, R2) while preserving dual-backend support for existing self-hosted deployments. Migrate from Fastify to Hono for native Workers compatibility. Remove scope creep from V1 that was never part of the original Rails application.

---

## 2. Goals & Non-Goals

### Goals

| ID  | Goal                                                                                       |
|-----|--------------------------------------------------------------------------------------------|
| G-1 | API runs on Cloudflare Workers with D1 (SQLite) and R2 in production                       |
| G-2 | API continues to run on Node.js + PostgreSQL for self-hosted and field-kit deployments     |
| G-3 | All data and operations from the legacy Rails V1 are available in V2 (feature parity)      |
| G-4 | Existing V1 data migrates cleanly via a one-time CLI tool with zero data loss              |
| G-5 | Field-kit (offline) deployment on resource-constrained hardware remains supported          |
| G-6 | API surface may use improved URL patterns and response shapes; a mapping document ensures nothing is lost |
| G-7 | Scope creep from V1 (elder role, cultural metadata, etc.) is removed                       |

### Non-Goals

- Front-end migration (addressed separately)
- New features beyond legacy Rails parity
- Continuous sync between V1 and V2 (migration is one-time)
- PostGIS or database-specific spatial extensions
- Elder user role and elder-only content restrictions (scope creep)
- Cultural significance metadata on places/stories, cultural settings on communities, cultural context on story-place relations (scope creep)

---

## 3. Glossary

| Term                | Definition                                                                                          |
|---------------------|-----------------------------------------------------------------------------------------------------|
| **V1**              | Current TypeScript API (Fastify + Drizzle + PostgreSQL/SQLite), migrated from the original Rails app |
| **Legacy Rails**    | Original Terrastories Ruby on Rails backend. V2 targets feature parity with this system             |
| **D1**              | Cloudflare's managed SQLite database service                                                        |
| **R2**              | Cloudflare's S3-compatible object storage                                                           |
| **Workers**         | Cloudflare's serverless edge runtime                                                                |
| **KV**              | Cloudflare's key-value storage, used for session data                                               |
| **Field Kit**       | Offline deployment on local hardware (e.g. Raspberry Pi) for communities without internet           |
| **Data Sovereignty**| Principle that each community's data is isolated and inaccessible to other communities or super admins |

---

## 4. Background & Context

### 4.1 Current Architecture (V1)

- **HTTP**: Fastify 5, 18 route files, 580-line auth middleware, 50+ test files
- **Database**: PostgreSQL (production) / SQLite via better-sqlite3 (dev/test). Dual `pgTable` + `sqliteTable` schema definitions
- **Storage**: Local filesystem with community-scoped directories
- **Auth**: Session-based via `@fastify/session` with cookies. Roles: super_admin, admin, editor, viewer
- **Media**: Multipart upload through Fastify, Sharp for image processing, `file-type` for MIME detection
- **Passwords**: Argon2 hashing (native C++ addon)
- **Spatial**: Plain lat/lng columns, application-level Haversine math via `SpatialUtils`

### 4.2 Why Hono

Fastify depends on Node.js `http`, `stream`, and other built-in modules absent from the Workers runtime. No production-ready adapter exists. Hono is purpose-built for edge runtimes, runs natively on Workers, and has first-class TypeScript and Zod support at 13KB.

### 4.3 Why Single-Schema

V1 maintains parallel `pgTable` and `sqliteTable` definitions -- every schema change must be made twice. Since D1 (SQLite) is the constraining backend, V2 uses only SQLite-compatible Drizzle schema. PostgreSQL handles SQLite-compatible queries without issue.

---

## 5. Architecture

### 5.1 Deployment Targets

| Mode            | Runtime  | Database        | Storage          | Use Case          |
|-----------------|----------|-----------------|------------------|-------------------|
| **Cloudflare**  | Workers  | D1 (SQLite)     | R2               | Hosted production |
| **Self-hosted** | Node.js  | PostgreSQL      | Local filesystem | Existing deploys  |
| **Field Kit**   | Node.js  | SQLite          | Local filesystem | Offline / RPi     |

All three modes share the same codebase, distinguished by environment configuration.

### 5.2 Cloudflare Component Map

| Component          | Cloudflare Product                                          |
|--------------------|-------------------------------------------------------------|
| API server         | Workers (Paid/Standard -- 30s CPU, 128MB memory)           |
| Database           | D1 (SQLite)                                                 |
| File/media storage | R2                                                          |
| Image processing   | Cloudflare Image Resizing                                   |
| Session storage    | KV                                                          |
| Rate limiting      | WAF Rate Limiting (platform-level)                          |
| Logging / audit    | Logpush + structured JSON to external sink                  |
| CDN                | Built-in                                                    |

Workers pricing: **Paid (Standard)**. Free tier's 10ms CPU limit is insufficient for password hashing.

### 5.3 Technical Stack Comparison

| Component          | V1                          | V2                                                |
|--------------------|-----------------------------|---------------------------------------------------|
| HTTP framework     | Fastify 5                   | Hono                                              |
| Schema approach    | Dual `pgTable` + `sqliteTable` | Single SQLite-compatible schema                |
| Database (prod)    | PostgreSQL                  | PostgreSQL or D1 (SQLite)                         |
| File storage       | Local filesystem (`fs`)     | R2 (Cloudflare) / local filesystem (self-hosted)  |
| Image processing   | Sharp (native addon)        | Cloudflare Image Resizing + JS header parser       |
| Password hashing   | Argon2 (native addon)       | bcryptjs (pure JS)                                |
| File type detect   | `file-type` (native addon)  | Pure JS magic-number checks                        |
| Auth sessions      | @fastify/session (cookie)   | KV-backed sessions / cookie sessions               |
| API docs           | @fastify/swagger            | @hono/zod-openapi                                  |
| Dev server         | `tsx watch`                 | `wrangler dev` (Workers) / `tsx watch` (Node)      |

### 5.4 Native Dependency Replacements

| V1 Dependency    | Purpose          | V2 Replacement                                      |
|------------------|------------------|-----------------------------------------------------|
| `argon2`         | Password hashing | `bcryptjs` (pure JS)                                |
| `sharp`          | Image resize     | Cloudflare Image Resizing + JS header parser        |
| `file-type` v21  | MIME detection   | Pure JS magic-number checks                          |
| `fs` module      | File I/O         | R2 API (Cloudflare) / `fs` (self-hosted / field kit) |
| `better-sqlite3` | SQLite driver    | D1 via `wrangler dev` / `better-sqlite3` (Node)     |
| `crypto` (Node)  | UUID generation  | `crypto.randomUUID()` via Web Crypto API             |

---

## 6. Requirements

### 6.1 Functional Requirements

#### Database (Dual-Backend)

| ID     | Requirement                                                                                                                               | Priority |
|--------|-------------------------------------------------------------------------------------------------------------------------------------------|----------|
| FR-001 | All queries through Drizzle's query builder. No raw SQL.                                                                                  | High     |
| FR-002 | JSON columns for store/retrieve only -- no JSONB containment or path queries (`@>`, `->>`).                                               | High     |
| FR-003 | Single SQLite-compatible schema (no dual definitions).                                                                                    | High     |
| FR-004 | Spatial data as plain `latitude`/`longitude` numeric columns. Spatial operations via application-level `SpatialUtils`.                    | High     |
| FR-005 | D1 eventual consistency: wrap sensitive writes (permission changes, deletions) in a D1 transaction and perform subsequent reads within the same request to guarantee read-after-write consistency. | Medium   |
| FR-006 | D1 limit: 10 GB per database (monitor; CLI supports multi-database splitting if needed).                                                  | Low      |

#### File Upload

| ID     | Requirement                                                                                                                               | Priority |
|--------|-------------------------------------------------------------------------------------------------------------------------------------------|----------|
| FR-007 | Small files (<10MB): upload through Worker, buffer in memory, write to R2.                                                                 | High     |
| FR-008 | Large files (>=10MB): client requests presigned R2 URL from API, uploads directly to R2, API records metadata.                             | High     |
| FR-009 | An R2 presigned URL endpoint is provided.                                                                                                 | High     |

#### Authentication & Authorization

| ID     | Requirement                                                                                                                               | Priority |
|--------|-------------------------------------------------------------------------------------------------------------------------------------------|----------|
| FR-010 | Session-based auth: email + password produces session token stored in KV (Cloudflare) or cookie (self-hosted / field kit).                | High     |
| FR-011 | Roles: `super_admin`, `admin`, `editor`, `viewer`. Four roles only -- no elder role.                                                      | High     |
| FR-012 | Community-scoped data isolation (multi-tenancy). All queries filtered by `communityId`.                                                   | High     |
| FR-013 | Super admins manage communities and users but cannot access community content (data sovereignty).                                         | High     |

#### Data Sovereignty

| ID     | Requirement                                                                                                                               | Priority |
|--------|-------------------------------------------------------------------------------------------------------------------------------------------|----------|
| FR-014 | Community data isolation at query level (`WHERE communityId = ?` on every content query).                                                 | High     |
| FR-015 | R2 objects isolated per community via key prefix + access policy.                                                                         | High     |
| FR-016 | Audit trail via Cloudflare Logpush (Cloudflare) or structured logs (self-hosted).                                                         | Medium   |
| FR-017 | D1 session-consistent reads: reads within the same request context see prior writes for permission changes and sensitive deletions.        | Medium   |

#### API Surface

| ID     | Requirement                                                                                                                               | Priority |
|--------|-------------------------------------------------------------------------------------------------------------------------------------------|----------|
| FR-018 | Three namespaces under `/v2/` prefix: Public API (`/v2/api/`), Member API (`/v2/member/`), Super Admin API (`/v2/admin/`).               | High     |
| FR-019 | V2 endpoints use `/v2/` prefix. V1 endpoints may coexist temporarily during migration.                                                    | High     |
| FR-020 | All endpoints return errors in a consistent envelope (see Section 6.2).                                                                   | High     |

#### Field Kit (Offline)

| ID     | Requirement                                                                                                                               | Priority |
|--------|-------------------------------------------------------------------------------------------------------------------------------------------|----------|
| FR-021 | Runs on Node.js with local SQLite and local filesystem -- no Cloudflare dependencies.                                                     | High     |
| FR-022 | `StorageAdapter` interface supports both R2 and local filesystem backends.                                                                | High     |
| FR-023 | Database layer supports both D1 and better-sqlite3 drivers.                                                                               | High     |
| FR-024 | All functionality works offline. No calls to external services at runtime.                                                                | High     |
| FR-025 | One-time migration CLI supports exporting to a field-kit-compatible SQLite snapshot.                                                       | Medium   |

### 6.2 Error Response Format

All endpoints return errors in a consistent envelope:

```typescript
interface ApiError {
  error: {
    code: string;       // 'VALIDATION_ERROR', 'NOT_FOUND', 'FORBIDDEN', etc.
    message: string;    // Human-readable
    details?: unknown;  // Zod issues, field errors, etc.
  };
  statusCode: number;
}
```

### 6.3 Non-Functional Requirements

| ID      | Category     | Requirement                                                                                                          | Target                                      |
|---------|--------------|----------------------------------------------------------------------------------------------------------------------|---------------------------------------------|
| NFR-001 | Performance  | API response times at edge                                                                                           | p95 < 200ms at 100 RPS                      |
| NFR-002 | Performance  | Workers bundle size                                                                                                  | < 10MB (CI-enforced)                        |
| NFR-003 | Performance  | Password hashing on Workers                                                                                          | < 5s CPU time (bcryptjs)                    |
| NFR-004 | Reliability  | Zero data loss during migration                                                                                      | Record count validation post-migration      |
| NFR-005 | Security     | Community data isolation verified                                                                                    | 100% of content queries include communityId |
| NFR-006 | Security     | Session tokens expire                                                                                                | Configurable TTL in KV                       |
| NFR-007 | Scalability  | D1 database size monitored                                                                                           | Alert at 80% of 10GB limit                  |
| NFR-008 | Portability  | Same codebase runs on Workers, Node.js+PostgreSQL, and Node.js+SQLite                                                | All three modes tested in CI                |
| NFR-009 | Observability| Structured JSON logging on all requests                                                                              | Logpush (Cloudflare) / console (self-hosted) |

---

## 7. Feature Parity Checklist

V2 must replicate all capabilities from the legacy Rails application.

### Data Models

- [ ] **Communities** -- CRUD, slug, locale, country, public/private flag
- [ ] **Stories** -- CRUD, title, description, language, topic, permission level, privacy level, interview metadata (date interviewed, interviewer, interview location), media attachments
- [ ] **Places** -- CRUD, name, description, type of place, region, lat/lng, media attachments
- [ ] **Speakers** -- CRUD, name, bio, birthplace, birthdate/birth year, photo
- [ ] **Themes** -- CRUD, map style URL, map access token, map center and boundary coordinates
- [ ] **Users** -- CRUD, email, encrypted password, role (super_admin, admin, editor, viewer), community scoping
- [ ] **Story-Places** -- Many-to-many with sort order
- [ ] **Story-Speakers** -- Many-to-many with role and sort order
- [ ] **Media / Files** -- Upload, serve, delete; community-scoped; permission-based access

### Auth

- [ ] Session-based authentication (email + password -> session token)
- [ ] Role-based access control: super_admin, admin, editor, viewer
- [ ] Community-scoped data isolation
- [ ] Super admins cannot access community content

### Media

- [ ] Multipart file upload (<10MB through Worker)
- [ ] Presigned R2 upload for large files (>=10MB)
- [ ] File type validation (pure JS magic-number checks)
- [ ] File size validation
- [ ] Community-scoped storage paths
- [ ] Authenticated file serving
- [ ] Image resizing / thumbnails via Cloudflare Image Resizing
- [ ] Image metadata extraction via JS header parser

### Spatial

- [ ] Plain numeric lat/lng columns
- [ ] Application-level Haversine distance and bounding box via `SpatialUtils`
- [ ] No database spatial extensions

### Deployment

- [ ] Cloudflare Workers + D1 + R2 + KV
- [ ] Node.js + PostgreSQL + local filesystem (self-hosted)
- [ ] Node.js + SQLite + local filesystem (field kit / offline)

### Removed Scope Creep

The following were added to the V1 codebase beyond the legacy Rails app and are **not carried forward**:

- Elder user role and elder-only content restrictions
- Elder status field on speakers
- Cultural significance metadata on places and stories
- Cultural settings on communities
- Cultural context on story-place relations
- `CulturalRestrictionsSchema` (ceremonialUse, seasonalAccess, accessLevel)

These remain in V1. If needed in the future, they can be re-added as V2 enhancements with proper design review.

---

## 8. Data Migration

A one-time CLI tool migrates V1 data to V2:

| Step | Scope                          | Details                                                                                                              |
|------|--------------------------------|----------------------------------------------------------------------------------------------------------------------|
| 1    | Schema migration               | Transform V1 schema into V2 schema                                                                                   |
| 2    | Data migration                 | All records (communities, stories, places, speakers, users, themes, media references) transfer with full integrity   |
| 3    | Media migration                | Files from V1 filesystem or ActiveStorage imported into R2 (or local filesystem for field kit) with updated references |
| 4    | Password rehashing             | Set `requiresRehash` flag per user. On first V2 login, verify against argon2 (CLI runs on Node.js), re-hash with bcryptjs, clear flag |
| 5    | Field-kit export               | Export migrated data as a self-contained SQLite snapshot for offline deployment                                      |
| 6    | Validation                     | Post-migration scripts confirm record counts, file integrity, and feature parity                                     |

The CLI runs once during cutover. No continuous sync.

---

## 9. Phased Migration Plan

| Phase | Duration    | Scope                                                                                                      | Deliverable                                                       |
|-------|-------------|------------------------------------------------------------------------------------------------------------|-------------------------------------------------------------------|
| 1     | Weeks 1-3   | Migrate Fastify to Hono. Keep PostgreSQL + local filesystem. Rewrite routes, middleware, auth, swagger, tests. | API runs on Hono + Node.js, functionally identical to Fastify version |
| 2     | Weeks 3-4   | Build R2 `StorageAdapter`. Integrate D1 driver. Single-schema migration. Presigned upload endpoint. Password hash migration support. | API runs on Hono + D1 + R2 locally via `wrangler dev`            |
| 3     | Week 5      | Deploy to Cloudflare Workers. KV sessions. Image Resizing integration. Bundle size monitoring. Load testing. | API running on Workers in staging                                |
| 4     | Week 6      | One-time CLI tool. V1-to-V2 endpoint mapping doc. Frontend migration guide. Post-migration validation. Field-kit export. | V1 data migrated. Frontend can switch over. Field kits provisioned. |

Estimated total: **6 weeks** for a single developer. Phases 1-2 are highest risk (18 route files, 580-line auth middleware, 50+ test files to rewrite).

---

## 10. Testing Strategy

### Compatibility Test Suite

Create a V1 behavior test suite **before** V2 development begins:

- Every V1 endpoint covered: request shape, response shape, auth requirements, role permissions
- Tests run against the running V1 API to capture actual behaviour
- Same tests pointed at V2 to verify parity

### Ongoing Testing

- Unit tests via Vitest (existing framework)
- Integration tests against both D1 (via `wrangler dev`) and PostgreSQL
- Bundle size CI check (must stay under 10MB for Workers)
- Coverage target: 80%+

---

## 11. Risks & Mitigations

| ID  | Risk                                       | Severity | Mitigation                                                                           |
|-----|--------------------------------------------|----------|--------------------------------------------------------------------------------------|
| R-1 | Argon2 not portable to Workers             | High     | Migrate to bcryptjs. Rehash on first login via CLI.                                  |
| R-2 | Large file uploads exceed Workers memory   | High     | Presigned R2 uploads for files >=10MB.                                               |
| R-3 | Migration scope underestimated             | Medium   | Phased plan. Compatibility test suite before dev starts.                             |
| R-4 | D1 eventual consistency                    | Medium   | `withSessionBinding` for permission changes and deletions.                           |
| R-5 | Bundle size exceeds 10MB Workers limit     | Medium   | Monitor in CI. Tree-shake unused code.                                               |
| R-6 | Dual backend diverges in behaviour         | Medium   | Integration tests against both D1 and PostgreSQL. Single schema removes one class.   |
| R-7 | `better-sqlite3` type coupling in repos    | Low      | Refactor repository layer to use generic database type.                              |

---

## 12. Open Questions

All resolved. Summary:

| #  | Question              | Decision                                                      |
|----|-----------------------|---------------------------------------------------------------|
| 1  | HTTP framework?       | Hono                                                          |
| 2  | Session storage?      | KV (Cloudflare) / cookie (self-hosted / field kit)            |
| 3  | Image processing?     | Cloudflare Image Resizing + JS header parser                  |
| 4  | Spatial queries?      | Application-level via SpatialUtils                            |
| 5  | Migration tooling?    | One-time CLI                                                  |
| 6  | Password hashing?     | bcryptjs with rehash-on-first-login                           |
| 7  | Large file uploads?   | Presigned R2 URLs for >=10MB                                  |
| 8  | Schema approach?      | Single SQLite-compatible schema                               |
| 9  | Workers pricing?      | Paid (Standard) -- 30s CPU                                    |
| 10 | D1 consistency?       | D1 transactions + same-request session reads for sensitive operations                  |

### 12.1 Notes from Automated Review

Two low-priority items flagged in the automated review remain as notes for development:

- **D1 RETURNING support** (low risk): D1 supports `RETURNING` for basic cases but may not support all complex patterns used in the repository layer. To be validated during Phase 2 D1 integration testing.
- **CORS strategy** (low risk): CORS origin allowlist is deployment-specific and not prescribed in the spec. To be configured per environment (Workers env vars or deploy config) based on frontend domain(s).

---

## 13. Change Log

| Date       | Author            | Changes                                                                                                                    |
|------------|-------------------|----------------------------------------------------------------------------------------------------------------------------|
| 2026-06-07 | Terrastories Team | Initial draft -- fundamental requirements                                                                                  |
| 2026-06-07 | Terrastories Team | Resolved all open questions. Hono chosen. No PostGIS. API shapes may evolve.                                               |
| 2026-06-07 | Terrastories Team | Addressed DeepSeek review (9 risks). Added: native dep replacements, presigned R2 uploads, single-schema, D1 consistency, phased plan, error envelope, hash migration, field-kit support. Removed elder role and scope-creep features. |
| 2026-06-08 | Terrastories Team | Restructured per spec best practices. Added numbered requirement IDs (FR-001 through FR-025, NFR-001 through NFR-009). Added risk IDs (R-1 through R-7). Reorganized sections for clarity. Added stack comparison table. |
| 2026-06-23 | Terrastories Team | Fixed D1 consistency terminology: replaced non-existent `withSessionBinding` with D1 transactions + same-request session reads.                                                                                   |

---

*End of Specification*
