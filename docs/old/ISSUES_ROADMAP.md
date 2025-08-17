# Terrastories TypeScript Backend API Migration Roadmap

> **Scope**: This roadmap focuses exclusively on backend API migration from Rails to TypeScript, maintaining exact feature parity with the existing Rails implementation.
>
> **Principle**: No new features beyond what exists in the current Rails API. Exact 1:1 migration only.

## Scope & Approach

- ✅ **Backend API** (this document) - Rails → TypeScript/Fastify
- ✅ **Database preservation** - Same PostgreSQL/PostGIS, migrate ORM only
- ✅ **Authentication** - Match existing session-based auth
- ✅ **Media handling** - ActiveStorage → compatible file system
- ✅ **Maintain existing features** - No additions, exact parity only
- ❌ **Frontend changes** - Separate future phase
- ❌ **New features** - No features not in current Rails API

## Phase 1: Foundation & Infrastructure ✅ COMPLETED

### Issue #1: Initialize TypeScript API project with Docker configuration ✅

Setup base TypeScript project with Fastify, Docker Compose, and development environment matching current Rails structure.

**Status**: ✅ **COMPLETED** in PR #2 (Issue #1)

- TypeScript 5.7+ foundation with Fastify 5.x server
- Drizzle ORM with SQLite/PostgreSQL support
- Comprehensive testing setup with Vitest (80%+ coverage)
- Code quality tools: ESLint 9 flat config + Prettier
- Pre-commit hooks with Husky + lint-staged
- GitHub Actions CI/CD pipeline with matrix testing
- Complete project structure and documentation

### Issue #5: Setup multi-environment configuration system ✅

Create environment-based configuration for development, production, field-kit, and offline deployments.

**Status**: ✅ **COMPLETED** in PR #4 (Issue #5)

- Multi-environment configuration system with Zod validation
- 5 environments: development, production, field-kit, offline, test
- Centralized config replacing scattered process.env usage
- Health endpoint integration and comprehensive testing

### Issue #6: Configure PostgreSQL with PostGIS and Drizzle ORM ✅

Implement database connection with PostGIS support, configure Drizzle ORM for spatial data types.

**Status**: ✅ **COMPLETED** in PR #8 (Issue #6)

- Enable PostGIS extension in PostgreSQL
- Configure Drizzle for geometry/geography types with SRID 4326 (WGS84)
- Setup spatial indexes (GiST) for performance
- Create spatial query helpers and type definitions
- Implement coordinate validation and transformation utilities

### Issue #7: Implement core testing infrastructure ✅

Setup Vitest with database fixtures, integration test patterns, and coverage requirements.

**Status**: ✅ **COMPLETED** in PR #8 (Issue #7)

- Database fixtures with PostGIS spatial data
- Integration test patterns
- Test helpers for multi-tenant isolation
- 80%+ coverage requirements

## Phase 2: Authentication & Authorization (Cycle 4)

### Issue #8: Implement session-based authentication system

Port Rails custom authentication (not Devise) with login/logout endpoints.

**Requirements**:

- Match Rails session-based authentication
- Implement `/login`, `/logout`, `/profile`, `/change_password` endpoints
- Session management with cookies
- Password hashing compatible with Rails

### Issue #9: Create role-based authorization middleware

Implement RoleRoutingConstraint equivalent for route-level restrictions.

**Requirements**:

- Three roles: super_admin, admin, member (no editor role)
- Route-level access control
- `/admin` routes for super admins
- `/member` routes for community members

### Issue #10: Build multi-tenant community isolation

Create middleware ensuring all queries are community-scoped.

**Requirements**:

- Application-level multi-tenancy (not database-level)
- Community-scoped queries using community_id
- Nested routing for community resources
- Prevent cross-community data access

## Phase 3: Core Domain Models (Cycle 5)

### Issue #11: Implement Community model and repository

Create Community entity matching Rails model.

**Requirements**:

- Fields: name, description, country, locale, slug
- Relationships: has_many users, stories, places, speakers
- Theme/customization settings

### Issue #12: Build Story model with restrictions

Implement Story entity with privacy controls.

**Requirements**:

- Fields: title, description, language, restricted (boolean)
- Belongs to community
- Many-to-many with places and speakers
- Has many media attachments

### Issue #13: Create Place model with PostGIS

Build Place entity with spatial data.

**Requirements**:

- Fields: name, description, latitude, longitude, region, type_of_place
- PostGIS spatial columns (point geometry)
- Belongs to community
- Has photo and name_audio attachments

### Issue #14: Implement Speaker model

Create Speaker entity with story associations.

**Requirements**:

- Fields: name, birthdate, birthplace, biography
- Belongs to community
- Many-to-many with stories
- Has photo attachment

### Issue #15: Build junction tables

Implement StoryPlaces and StorySpeakers join tables.

**Requirements**:

- StoryPlaces: story_id, place_id
- StorySpeakers: story_id, speaker_id
- Support for many-to-many queries

## Phase 4: Media System Migration (Cycle 6)

### Issue #16: Create media attachments table

Replace ActiveStorage with custom attachment system.

**Requirements**:

- Polymorphic attachments (attachable_type, attachable_id)
- Support story media, place photos/audio, speaker photos
- Fields: filename, content_type, byte_size, key

### Issue #17: Implement file upload endpoints

Build file upload handling matching Rails ActiveStorage.

**Requirements**:

- Multipart upload support
- File validation (block 3gp, allow MP3/WAV for audio)
- Local disk storage with configurable backends
- Generate unique storage keys

### Issue #18: Create media serving endpoints

Implement file download/streaming.

**Requirements**:

- Blob redirect endpoints
- Support for image variants (if used)
- Proper content-type headers
- Community-scoped access control

## Phase 5: Public API Endpoints (Cycle 7)

### Issue #19: Implement Communities API

Create public read-only community endpoints.

**Requirements**:

- `GET /api/communities` - list all communities
- `GET /api/communities/:id` - show community details
- JSON response format matching Rails

### Issue #20: Build Stories API

Implement community-scoped story endpoints.

**Requirements**:

- `GET /api/communities/:community_id/stories` - list stories
- `GET /api/communities/:community_id/stories/:id` - show story
- Filter restricted stories based on authentication
- Include media attachments in response

### Issue #21: Create Places API

Build place endpoint with spatial data.

**Requirements**:

- `GET /api/communities/:community_id/places/:id` - show place
- Include coordinates and metadata
- Include photo/audio attachments

## Phase 6: Member Dashboard APIs (Cycle 8)

### Issue #22: Implement Story CRUD

Create story management endpoints for members.

**Requirements**:

- Full CRUD at `/member/stories/*`
- Media attachment management
- Community-scoped operations
- Validation matching Rails

### Issue #23: Build Place CRUD

Implement place management endpoints.

**Requirements**:

- Full CRUD at `/member/places/*`
- Photo and name_audio upload/delete
- Coordinate validation
- PostGIS spatial data handling

### Issue #24: Create Speaker CRUD

Build speaker management endpoints.

**Requirements**:

- Full CRUD at `/member/speakers/*`
- Photo upload/delete
- Community-scoped operations

### Issue #25: Implement User management

Create user endpoints for community admins.

**Requirements**:

- CRUD at `/member/users/*`
- Role assignment within community
- Password management
- Photo handling

## Phase 7: Community Administration (Cycle 9)

### Issue #26: Build Community settings endpoints

Implement community customization APIs.

**Requirements**:

- `GET/PATCH /member/community`
- Theme settings management
- Background image upload/delete
- Sponsor logos management

### Issue #27: Create Search endpoint

Build search functionality.

**Requirements**:

- `GET /member/search`
- Search stories, places, speakers
- Community-scoped results
- Text search matching Rails implementation

### Issue #28: Implement Import functionality

Create data import endpoints.

**Requirements**:

- `POST /member/import`
- `POST /member/import/preview`
- CSV/JSON import support
- Validation and error handling

## Phase 8: Super Admin Features (Cycle 10)

### Issue #29: Build Super Admin metrics

Create system-level metrics endpoint.

**Requirements**:

- `GET /admin/metrics`
- Global statistics without community data access
- System health metrics
- Usage analytics

### Issue #30: Implement Community management

Build community CRUD for super admins.

**Requirements**:

- Full CRUD at `/admin/communities/*`
- Cannot access community stories/data
- System-level operations only

## Phase 9: Spatial Features (Cycle 11)

### Issue #31: Implement spatial queries

Create PostGIS-based geographic queries.

**Requirements**:

- Distance-based searches (ST_DWithin)
- Bounding box queries
- Spatial joins between stories and places
- Coordinate system transformations

### Issue #32: Build map data endpoints

Create map-specific data aggregation.

**Requirements**:

- Clustered place data for zoom levels
- Story counts by region
- Viewport-based filtering
- GeoJSON response format

## Phase 10: Performance & Optimization (Cycle 12)

### Issue #33: Implement caching layer

Add caching for frequently accessed data.

**Requirements**:

- Query result caching
- Community-scoped cache keys
- Cache invalidation on updates
- Media file caching headers

### Issue #34: Optimize database queries

Improve query performance.

**Requirements**:

- N+1 query prevention
- Eager loading for associations
- Index optimization
- Connection pooling

## Phase 11: Rails Compatibility Layer (Cycle 13)

### Issue #35: Create response format adapters

Ensure exact Rails JSON format compatibility.

**Requirements**:

- Match Rails serialization format
- Snake_case to camelCase handling
- Date format compatibility
- Null vs undefined handling

### Issue #36: Implement session compatibility

Support existing Rails sessions during migration.

**Requirements**:

- Read Rails session cookies
- Gradual session migration
- Backward compatibility
- Shared session store

### Issue #37: Build URL compatibility layer

Maintain Rails URL patterns.

**Requirements**:

- ActiveStorage URL compatibility
- Route aliases for Rails paths
- Redirect handling
- Media URL preservation

## Phase 12: Migration & Testing (Cycle 14)

### Issue #38: Create data validation suite

Verify data integrity between systems.

**Requirements**:

- Compare Rails vs TypeScript responses
- Validate all endpoints
- Performance benchmarks
- Load testing

### Issue #39: Build migration scripts

Create database migration helpers.

**Requirements**:

- ActiveStorage to new media system
- Session migration
- Data integrity checks
- Rollback procedures

### Issue #40: Implement monitoring

Setup production monitoring.

**Requirements**:

- Health check endpoints
- Error tracking
- Performance monitoring
- Audit logging

## Phase 13: Documentation & Deployment (Cycle 15)

### Issue #41: Create API documentation

Generate comprehensive API docs.

**Requirements**:

- OpenAPI/Swagger specification
- Match Rails API surface
- Authentication documentation
- Media handling guides

### Issue #42: Build deployment configuration

Setup production deployment.

**Requirements**:

- Docker configuration matching Rails
- Environment variables
- Database migrations
- Asset handling

### Issue #43: Create migration guide

Document migration process.

**Requirements**:

- Step-by-step migration plan
- Rollback procedures
- Testing checklist
- Troubleshooting guide

---

## Timeline Summary

- **Cycles 1-3**: Foundation (COMPLETED ✅)
- **Cycle 4**: Authentication & Authorization
- **Cycle 5**: Core Models
- **Cycle 6**: Media System
- **Cycle 7**: Public APIs
- **Cycle 8**: Member APIs
- **Cycle 9**: Admin Features
- **Cycle 10**: Super Admin
- **Cycle 11**: Spatial Features
- **Cycle 12**: Performance
- **Cycle 13**: Compatibility
- **Cycle 14**: Migration & Testing
- **Cycle 15**: Documentation & Deployment

## Key Principles

1. **No New Features**: Exact Rails API parity only
2. **Preserve Behavior**: Match Rails responses exactly
3. **Maintain Compatibility**: Support gradual migration
4. **Test Everything**: Comprehensive comparison testing
5. **Document Thoroughly**: Clear migration path

## Success Criteria

- ✅ All Rails endpoints implemented
- ✅ Response formats match exactly
- ✅ Performance equal or better
- ✅ All tests passing
- ✅ Zero data loss during migration
- ✅ Seamless rollback capability

## Usage with Workflow

```bash
/create-next-issue
```

Each issue is:

- **Self-contained** with clear scope
- **Testable** with Rails comparison
- **Focused** on feature parity only
