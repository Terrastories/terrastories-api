# **Terrastories TypeScript Backend API Migration Roadmap**

**Scope**: This roadmap focuses exclusively on backend API migration from Rails to TypeScript, maintaining exact feature parity with the existing Rails implementation.
**Principle**: No new features beyond what exists in the current Rails API. Exact 1:1 migration only.

## **Scope & Approach**

- ✅ **Backend API Only**: Migrating the Rails backend to TypeScript/Fastify.
- ✅ **Database Preservation**: Using the existing PostgreSQL/PostGIS schema. ORM migration only.
- ✅ **Authentication Parity**: Replicating the existing session-based authentication.
- ✅ **Media Handling**: Replacing ActiveStorage with a direct file system approach.
- ❌ **No Frontend Changes**: The frontend is out of scope for this project.
- ❌ **No New Features**: The goal is a 1:1 feature match with the Rails API.

## **Phase 1: Foundation & Infrastructure ✅ COMPLETED**

### **Issue #1: Initialize TypeScript API project with Docker configuration ✅**

Setup base TypeScript project with Fastify, Docker Compose, and development environment matching current Rails structure.
**Status**: ✅ **COMPLETED** in PR #2 (Issue #1)

- TypeScript 5.7+ foundation with Fastify 5.x server
- Drizzle ORM with SQLite/PostgreSQL support
- Comprehensive testing setup with Vitest (80%+ coverage)
- Code quality tools: ESLint 9 flat config + Prettier
- Pre-commit hooks with Husky + lint-staged
- GitHub Actions CI/CD pipeline with matrix testing
- Complete project structure and documentation

### **Issue #5: Setup multi-environment configuration system ✅**

Create environment-based configuration for development, production, field-kit, and offline deployments.
**Status**: ✅ **COMPLETED** in PR #4 (Issue #5)

- Multi-environment configuration system with Zod validation
- 5 environments: development, production, field-kit, offline, test
- Centralized config replacing scattered process.env usage
- Health endpoint integration and comprehensive testing

### **Issue #6: Configure PostgreSQL with PostGIS and Drizzle ORM ✅**

Implement database connection with PostGIS support, configure Drizzle ORM for spatial data types.
**Status**: ✅ **COMPLETED** in PR #8 (Issue #6)

- Enable PostGIS extension in PostgreSQL
- Configure Drizzle for geometry/geography types with SRID 4326 (WGS84)
- Setup spatial indexes (GiST) for performance
- Create spatial query helpers and type definitions
- Implement coordinate validation and transformation utilities

### **Issue #7: Implement core testing infrastructure ✅**

Setup Vitest with database fixtures, integration test patterns, and coverage requirements.
**Status**: ✅ **COMPLETED** in PR #8 (Issue #7)

- Database fixtures with PostGIS spatial data
- Integration test patterns
- Test helpers for multi-tenant isolation
- 80%+ coverage requirements

## **Phase 2: Schema & Data Layer Definition**

### **Issue #10: Define User & Community Schemas ✅**

**Status**: ✅ **COMPLETED** in PR #11 (Issue #10)

- Complete user schema with PostgreSQL/SQLite compatibility
- Enhanced community schema with proper relations
- Comprehensive Zod validation schemas and TypeScript types
- 47 passing tests with 100% coverage (26 schema + 21 Swagger)
- Multi-tenant data isolation and role-based access control
- Complete Swagger/OpenAPI documentation
- Multi-database support following existing patterns

### **Issue #12: Define Story, Place, & Speaker Schemas**

**Status**: 🔄 **IN PROGRESS** - Created as GitHub Issue #12

- Story schema with media support and community scoping
- Place schema with PostGIS geometry fields and spatial indexing
- Speaker schema with cultural sensitivity and elder status
- Comprehensive Zod validation and TypeScript types
- Complete Swagger/OpenAPI documentation
- Multi-database support (PostgreSQL/SQLite)
- Spatial query helpers and media URL validation

**GitHub Issue**: [#12](https://github.com/Terrastories/terrastories-api/issues/12)

### **Issue #13: Define Many-to-Many Join Table Schemas** (Next)

Description: Define the Drizzle ORM schemas for the join tables that manage many-to-many relationships.
Context: docs/2-DATA_MODELS.md, docs/6-DATABASE_SCHEMA.md
Acceptance Criteria:

- story_places join table schema is created.
- story_speakers join table schema is created.
- Drizzle relations are correctly defined for all many-to-many relationships.

## **Phase 3: Authentication & Authorization**

### **Issue #11: Implement Password Hashing Service**

Description: Create a service to handle password hashing and comparison.
Context: docs/4-AUTHENTICATION.md
Acceptance Criteria:

- A password.service.ts is created.
- It exports a hashPassword function using a strong hashing algorithm (e.g., argon2 or bcrypt).
- It exports a comparePassword function.

### **Issue #12: Implement User Registration Service & Endpoint**

Description: Create the business logic and API endpoint for new user registration.
Context: docs/2-DATA_MODELS.md, docs/4-AUTHENTICATION.md
Example code: docs/examples/service-example.ts
Acceptance Criteria:

- A /register endpoint is created.
- The service uses the password hashing service.
- New users are saved to the database and correctly associated with a Community.

### **Issue #13: Implement Session-Based Login Endpoint**

Description: Create the /login endpoint to authenticate users and establish a session.
Context: docs/4-AUTHENTICATION.md
Acceptance Criteria:

- A /login endpoint accepts email and password.
- It uses the password service to verify credentials.
- On success, it creates a session and returns a connect.sid cookie.
- On failure, it returns a 401 Unauthorized status.

### **Issue #14: Implement Logout Endpoint**

Description: Create the /logout endpoint to destroy the user's session.
Context: docs/4-AUTHENTICATION.md
Acceptance Criteria:

- A /logout endpoint is created.
- It destroys the current session.
- It returns a success response.

### **Issue #15: Implement Role-Based Authorization Middleware**

Description: Create Fastify middleware to protect routes based on user roles.
Context: docs/4-AUTHENTICATION.md, docs/3-API_ENDPOINTS.md
Acceptance Criteria:

- A middleware function checks request.session.user.role.
- It can restrict access to one or more roles (e.g., \['super_admin', 'admin'\]).
- Unauthorized requests receive a 403 Forbidden response.

## **Phase 4: Core Services & Media Handling**

### **Issue #16: Implement File Upload Service**

Description: Create a service to handle multipart file uploads and save them to the filesystem.
Context: docs/5-MEDIA_HANDLING.md
Acceptance Criteria:

- A file.service.ts is created using fastify-multipart.
- The service saves uploaded files to a configurable directory.
- It returns the relative path of the saved file.

### **Issue #17: Implement CRUD Service for Stories**

Description: Create the business logic for all CRUD operations on the Story model.
Context: docs/2-DATA_MODELS.md, docs/5-MEDIA_HANDLING.md
Example code: docs/examples/service-example.ts
Acceptance Criteria:

- A story.service.ts is created.
- It contains functions for create, getById, update, and delete.
- Update/create functions correctly handle associations in story_places and story_speakers join tables.
- Update/create functions handle saving media file paths to the media_urls field.

### **Issue #18: Implement CRUD Service for Places**

Description: Create the business logic for all CRUD operations on the Place model.
Context: docs/2-DATA_MODELS.md, docs/5-MEDIA_HANDLING.md
Acceptance Criteria:

- A place.service.ts is created.
- It contains functions for create, getById, update, and delete.
- Update/create functions handle saving photo_url and name_audio_url.

### **Issue #19: Implement CRUD Service for Speakers & Communities**

Description: Create the business logic for CRUD operations on Speaker and Community models.
Context: docs/2-DATA_MODELS.md
Acceptance Criteria:

- A speaker.service.ts is created with full CRUD logic.
- A community.service.ts is created with full CRUD logic.

## **Phase 5: API Endpoint Implementation**

### **Issue #20: Implement Public Read-Only API Endpoints**

Description: Build all GET routes under the /api namespace.
Context: docs/3-API_ENDPOINTS.md
Example code: docs/examples/route-example.ts
Acceptance Criteria:

- GET /api/communities and GET /api/communities/:id are implemented.
- GET /api/communities/:community_id/stories and GET /api/communities/:community_id/stories/:id are implemented.
- GET /api/communities/:community_id/places/:id is implemented.
- Response structures exactly match the original Rails API.

### **Issue #21: Implement Member Dashboard Endpoints (/member)**

Description: Build all authenticated CRUD endpoints under the /member namespace.
Context: docs/3-API_ENDPOINTS.md, docs/4-AUTHENTICATION.md
Example code: docs/examples/route-example.ts
Acceptance Criteria:

- Full CRUD endpoints for /member/stories are implemented and protected.
- Full CRUD endpoints for /member/places are implemented and protected.
- Full CRUD endpoints for /member/speakers are implemented and protected.

### **Issue #22: Implement Super Admin Endpoints (/super_admin)**

Description: Build all authenticated CRUD endpoints under the /super_admin namespace.
Context: docs/3-API_ENDPOINTS.md, docs/4-AUTHENTICATION.md
Acceptance Criteria:

- Full CRUD endpoints for /super_admin/communities are implemented and protected by the super_admin role.
- Full CRUD endpoints for /super_admin/users are implemented and protected by the super_admin role.

## **Phase 6: Finalization & Deployment**

### **Issue #23: Finalize Docker Configuration & Environment Variables**

Description: Ensure the Docker Compose setup is production-ready and fully documented.
Context: docs/7-DEPLOYMENT.md
Acceptance Criteria:

- docker-compose.yml is complete with all services.
- An .env.example file is created listing all required environment variables.
- Database volume is correctly configured for data persistence.

### **Issue #24: Create API Comparison Test Suite**

Description: Create a suite of automated tests to validate that the new API responses match the old Rails API responses exactly.
Context: docs/3-API_ENDPOINTS.md
Example code: docs/examples/test-example.ts
Acceptance Criteria:

- A test script is created (e.g., using Vitest or Postman).
- The script makes identical requests to both the old and new APIs.
- It asserts that the JSON response bodies are identical.

### **Issue #25: Write Data Migration Guide & Script**

Description: Document the data migration process and create the script to migrate media files from ActiveStorage.
Context: docs/5-MEDIA_HANDLING.md, docs/7-DEPLOYMENT.md
Acceptance Criteria:

- A MIGRATION.md guide is written with step-by-step instructions.
- A standalone script (e.g., in TypeScript/Node.js) is created to perform the ActiveStorage data migration.

## **Key Principles**

1. **No New Features**: Exact Rails API parity only
2. **Preserve Behavior**: Match Rails responses exactly
3. **Maintain Compatibility**: Support gradual migration
4. **Test Everything**: Comprehensive comparison testing
5. **Document Thoroughly**: Clear migration path

## **Success Criteria**

- ✅ All Rails endpoints implemented
- ✅ Response formats match exactly
- ✅ Performance equal or better
- ✅ All tests passing
- ✅ Zero data loss during migration
- ✅ Seamless rollback capability

## **Usage with Workflow**

/create-next-issue

Each issue is:

- **Self-contained** with clear scope
- **Testable** with Rails comparison
- **Focused** on feature parity only
