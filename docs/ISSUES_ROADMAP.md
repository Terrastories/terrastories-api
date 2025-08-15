# Terrastories TypeScript Backend API Migration Roadmap

> **Scope**: This roadmap focuses exclusively on backend API migration from Rails to TypeScript.  
> Frontend migration is documented separately in [FRONTEND_MIGRATION_GUIDE.md](./FRONTEND_MIGRATION_GUIDE.md)

## Scope & Approach

- ✅ **Backend API** (this document) - Rails → TypeScript/Fastify
- ✅ **Database migration** - ActiveRecord → Drizzle ORM
- ✅ **Authentication & authorization** - Session-based → JWT
- ✅ **Media handling** - ActiveStorage → modern file system
- ✅ **Offline sync capabilities** - Maintain existing patterns
- ❌ **Frontend React migration** (see [FRONTEND_MIGRATION_GUIDE.md](./FRONTEND_MIGRATION_GUIDE.md))
- ❌ **UI/UX changes** (future phase)

## Phase 1: Foundation with Spatial & Offline Design (Weeks 1-3)

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

### Issue #2: Configure PostgreSQL with PostGIS and Drizzle ORM 🚧

**PRIORITY: CRITICAL** - PostGIS is foundational to Terrastories, not optional.

Implement database connection with PostGIS support, configure Drizzle ORM for spatial data types.

**Enhanced Requirements**:

- Enable PostGIS extension in PostgreSQL
- Configure Drizzle for geometry/geography types with SRID 4326 (WGS84)
- Setup spatial indexes (GiST) for performance
- Create spatial query helpers and type definitions
- Implement coordinate validation and transformation utilities

### Issue #3: Setup multi-environment configuration system ✅

Create environment-based configuration for development, production, field-kit, and offline deployments.

**Status**: ✅ **COMPLETED** in PR #4 (Issue #5)

- Multi-environment configuration system with Zod validation
- 5 environments: development, production, field-kit, offline, test
- Centralized config replacing scattered process.env usage
- Health endpoint integration and comprehensive testing

### Issue #4: Implement core testing infrastructure 🚧

Setup Vitest with database fixtures, integration test patterns, spatial testing helpers, and coverage requirements (80%+).

**Enhanced Requirements**:

- Database fixtures with PostGIS spatial data
- Spatial query testing utilities
- Offline-first data structure test patterns
- Community isolation test helpers

### Issue #5: Design offline-first data structures

**NEW CRITICAL ISSUE** - Offline capability affects every design decision.

Design data structures for eventual consistency and conflict-free operation.

**Requirements**:

- Plan for conflict-free replicated data types (CRDTs)
- Setup sync metadata columns (version, lastModified, syncStatus, conflictResolution)
- Design operation queue storage for offline actions
- Plan for media caching and progressive download
- Create data structure for merge conflict resolution

### Issue #6: Create Field Kit environment configuration

**NEW CRITICAL ISSUE** - Unique deployment model needs explicit attention.

Setup configuration for offline-only Field Kit deployment.

**Requirements**:

- Configure for local network operation without internet
- Plan for WiFi hotspot deployment scenarios
- Design data export/import for sneakernet sync
- Setup bandwidth-conscious sync strategies
- Configure media compression for low-resource environments

## Phase 2: Core Multi-Tenant Architecture (Weeks 4-6)

### Issue #7: Implement session-based authentication system

Port Rails authentication with login/logout, matching current session management and security.

**Enhanced Requirements**:

- Maintain compatibility with existing Rails sessions during migration
- Support both JWT and session-based auth for gradual transition
- Implement secure session management with proper expiration
- Add authentication audit logging

### Issue #8: Create role-based authorization middleware

Implement super_admin, admin, editor, member roles with route-level restrictions.

**Enhanced Requirements**:

- Community-scoped role permissions
- Hierarchical permission inheritance
- Route-level middleware for automatic authorization
- Permission audit trail for compliance

### Issue #9: Build multi-tenant community isolation layer

**CRITICAL** - Create middleware ensuring all queries are community-scoped, enforce data sovereignty rules.

**Enhanced Requirements**:

- Automatic community context injection in all database queries
- Query-level validation to prevent cross-community data access
- Performance optimization for community-scoped indexes
- Comprehensive logging of all data access attempts

### Issue #10: Create data sovereignty test suite

**NEW CRITICAL ISSUE** - Cannot assume data sovereignty works, must validate.

Create automated tests verifying super admin restrictions and community isolation.

**Requirements**:

- Automated tests verifying super admin cannot access community data
- Test cross-community data access prevention across all endpoints
- Validate all query patterns respect community boundaries
- Performance testing with multiple communities
- Test data anonymization for analytics vs. sovereignty requirements

### Issue #11: Implement super admin restrictions with validation

Ensure super admins cannot access community data, with comprehensive testing and monitoring.

**Enhanced Requirements**:

- Global metrics and administration capabilities only
- Real-time monitoring of super admin actions
- Automated alerts for any sovereignty violations
- Audit logs for all administrative actions
- Community data anonymization for system-level analytics

### Issue #12: Create user management endpoints

Implement user CRUD operations with community assignment and role management.

**Enhanced Requirements**:

- Community-scoped user management
- Role assignment with sovereignty compliance
- User invitation and approval workflows
- Integration with offline user synchronization

## Phase 3: Domain Models with Spatial & Offline (Weeks 7-9)

### Issue #13: Implement Community model with offline sync

Create Community entity with all relationships, customization settings, and offline synchronization metadata.

**Enhanced Requirements**:

- Theme management and locale configuration
- Offline-first data structure with sync metadata
- Cultural protocol settings and restrictions
- Community-specific configuration management
- Integration with Field Kit deployment settings

### Issue #14: Build Story model with cultural protocols

Implement Story entity with multi-level privacy and cultural sensitivity controls.

**Enhanced Requirements**:

- Multi-level privacy (public, restricted, private, elder-only, ceremonial)
- Cultural protocol management (seasonal restrictions, gender-specific content)
- Offline sync metadata and conflict resolution
- Media attachment relationships with offline caching
- Story validation with cultural guidelines

### Issue #15: Create Place model with PostGIS and offline support

Build Place entity with comprehensive spatial data handling and offline capabilities.

**Enhanced Requirements**:

- PostGIS spatial columns from day one (geometry, geography)
- Coordinate storage with SRID 4326 (WGS84) validation
- GiST spatial indexing for performance
- Offline place data caching and synchronization
- Place type categorization and region management
- Integration with offline map tiles

### Issue #16: Implement Speaker model with cultural sensitivity

Create Speaker entity with biography data, story associations, and cultural protocols.

**Enhanced Requirements**:

- Cultural protocol compliance (elder knowledge, gender restrictions)
- Biography data with multimedia support
- Offline synchronization and media caching
- Community-scoped speaker management
- Integration with story privacy controls

### Issue #17: Build PlaceStory junction with spatial metadata

Implement many-to-many relationship between Stories and Places with spatial and cultural metadata.

**Enhanced Requirements**:

- Spatial relationship metadata (precise location vs. general area)
- Cultural significance levels and access restrictions
- Offline sync support for relationship changes
- Temporal relationships (seasonal, historical)
- Integration with mapping and story filtering

### Issue #18: Analyze ActiveStorage structure and migration

**NEW CRITICAL ISSUE** - ActiveStorage migration needs dedicated planning.

Document all attachment types and polymorphic relationships for migration strategy.

**Requirements**:

- Map all Rails polymorphic associations (stories, places, speakers)
- Document attachment types and file relationships
- Create migration data mapping for preservation
- Plan for multiple attachments per story
- Analyze place photos and name_audio file patterns
- Design metadata preservation strategy

## Phase 4: ActiveStorage Migration & Media System (Weeks 10-12)

### Issue #19: Create ActiveStorage migration scripts

**CRITICAL** - Migrate existing media with relationship preservation.

Create scripts to migrate existing Rails ActiveStorage data with full relationship preservation.

**Requirements**:

- Preserve file-record relationships across polymorphic associations
- Handle multiple attachments per story (media files, documents)
- Migrate place photos and name_audio files with metadata
- Maintain media metadata (file types, dimensions, duration)
- Create checksum verification for file integrity
- Design rollback capability for migration errors

### Issue #20: Implement backward-compatible storage URLs

**CRITICAL** - Ensure media access continuity during migration.

Support existing Rails URL patterns during transition period.

**Requirements**:

- Support existing Rails ActiveStorage URL patterns
- Create redirect layer for seamless transition
- Ensure offline media access works with new URLs
- Maintain signed URL security with community scoping
- Plan for gradual URL migration strategy

### Issue #21: Design file storage abstraction for offline

Create storage interface supporting local filesystem, cloud providers, and offline caching.

**Enhanced Requirements**:

- Storage abstraction for local filesystem and cloud providers (S3, Azure, GCS)
- Offline media caching and progressive download strategies
- Bandwidth-conscious sync for Field Kit deployments
- Media compression for low-resource environments
- Integration with offline tile server for map data

### Issue #22: Implement media upload with cultural protocols

Build file upload handling with cultural sensitivity and validation.

**Enhanced Requirements**:

- File upload for stories (multiple), places (photo, audio), speakers (photo)
- Cultural protocol validation (elder knowledge, sacred content)
- Media format validation (3gp blocking, MP3/WAV requirements)
- Automatic transcoding for compatibility
- Offline media queue and sync capabilities

### Issue #23: Create media security with community isolation

Implement secure file access with community-scoped permissions and cultural protocols.

**Enhanced Requirements**:

- Community-scoped media access controls
- Cultural protocol enforcement (restricted content)
- Signed URL generation with community context
- Offline media access authentication
- Media audit logging for cultural compliance

### Issue #24: Build media metadata and validation

Extract and store file metadata with cultural considerations.

**Enhanced Requirements**:

- Extract and store file metadata (type, size, duration, quality)
- Cultural metadata (language, speaker identity, content type)
- Automatic content validation and quality checks
- Integration with story and place metadata
- Support for Indigenous language audio files

## Phase 5: API Endpoints - Read Operations

### Issue #21: Implement Communities API endpoints

Create GET /api/communities and GET /api/communities/:id with proper filtering.

### Issue #22: Build Stories listing with privacy filtering

Implement GET /api/communities/:id/stories with privacy rules and pagination.

### Issue #23: Create Story detail endpoint with media

Build GET /api/communities/:id/stories/:story_id with full media and relationships.

### Issue #24: Implement Places API with spatial data

Create GET /api/communities/:id/places/:place_id with geographic information.

### Issue #25: Build search and filtering capabilities

Implement story search by title, speaker, place with proper community isolation.

## Phase 6: API Endpoints - Write Operations

### Issue #26: Create Story CRUD operations

Implement create, update, delete for stories with validation and media handling.

### Issue #27: Build Place management endpoints

Create CRUD operations for places with coordinate validation and spatial indexing.

### Issue #28: Implement Speaker management

Build endpoints for speaker creation, updates, and story associations.

### Issue #29: Create bulk import/export functionality

Implement data import/export for offline synchronization and backup.

### Issue #30: Build community settings management

Create endpoints for theme customization, map settings, and locale configuration.

## Phase 7: Geographic & Mapping Features with Offline Support

### Issue #31: Optimize spatial queries from start

**MOVED FROM PHASE 10** - Spatial performance is critical from day one.

Create optimized PostGIS spatial queries with proper indexing.

**Enhanced Requirements**:

- Implement spatial indexes on all geographic columns (GiST)
- Use ST_DWithin for proximity queries instead of buffer operations
- Implement viewport culling for map performance
- Add place clustering for map performance with large datasets
- Create distance calculations and bounding box queries
- Implement spatial joins with performance optimization

### Issue #32: Build map data aggregation with caching

Implement clustering, heatmaps, and viewport-based data loading with caching.

**Enhanced Requirements**:

- Viewport-based data loading with intelligent clustering
- Heatmap generation for story density visualization
- Caching strategy for map data aggregation
- Offline map data preparation and serving
- Integration with community-scoped filtering

### Issue #33: Implement offline tile server integration

**ENHANCED** - Setup comprehensive tile server integration for offline functionality.

Setup tile server endpoints for offline map functionality with TileServer-GL integration.

**Enhanced Requirements**:

- Configure TileServer-GL connection and setup
- Support MBTiles format for offline map storage
- Implement tile caching strategy for bandwidth efficiency
- Handle zoom levels 1-8 for offline Field Kit deployment
- Create tile download and sync management
- Integration with place data overlay

### Issue #34: Implement geographic search with cultural protocols

Build location-based search with cultural sensitivity and offline support.

**Enhanced Requirements**:

- Location-based search with radius queries and region filtering
- Cultural protocol filtering (restricted areas, sacred sites)
- Offline search capabilities with cached geographic data
- Integration with place type categorization
- Search result ranking based on cultural significance

### Issue #35: Create place type and region management

Implement comprehensive categorization system for geographic locations.

**Enhanced Requirements**:

- Place type categorization with cultural significance levels
- Region management with community-defined boundaries
- Integration with cultural protocols and access restrictions
- Offline synchronization of place categorization
- Support for seasonal and temporal place restrictions

## Phase 8: Internationalization & Cultural Protocols

### Issue #36: Implement comprehensive i18n system

**NEW CRITICAL ISSUE** - Missing from original roadmap, essential for Indigenous communities.

Implement internationalization support for 6 languages with cultural adaptation.

**Requirements**:

- Support 6 languages: Dutch, English, Japanese, Matawai, Portuguese, Spanish
- Locale-scoped routing with community preferences
- Cultural adaptation for content presentation
- Translation key management with community-specific overrides
- Support for right-to-left languages and cultural text formatting
- Indigenous language character set support

### Issue #37: Implement cultural protocol management

**NEW CRITICAL ISSUE** - Cultural sensitivity is foundational to Terrastories.

Create comprehensive cultural protocol management system.

**Requirements**:

- Restricted content management by cultural rules
- Elder knowledge protection with access controls
- Seasonal and ceremonial access restrictions
- Community-specific viewing permissions and protocols
- Sacred site and story protection mechanisms
- Cultural content flagging and approval workflows

### Issue #38: Create robust import/export for offline sync

**ENHANCED** - Critical for Field Kit and sovereignty.

Create comprehensive import/export system for offline synchronization and data sovereignty.

**Enhanced Requirements**:

- Support CSV, JSON, and custom formats for community data portability
- Handle large datasets with streaming for performance
- Implement validation and error recovery for data integrity
- Create checksum verification for sync reliability
- Support incremental sync and delta changes
- Community-controlled data export for sovereignty

## Phase 9: Administrative Dashboards with Cultural Compliance

### Issue #39: Build super admin dashboard with sovereignty compliance

Create metrics and administration endpoints with data sovereignty restrictions.

**Enhanced Requirements**:

- Global metrics and community management without accessing community data
- Data anonymization for system-level analytics
- Cultural compliance monitoring and alerts
- Audit trails for all administrative actions
- Performance metrics with privacy protection

### Issue #40: Implement community admin endpoints with cultural controls

Build user management and story moderation with cultural protocol integration.

**Enhanced Requirements**:

- Community-scoped user management and role assignment
- Story moderation with cultural protocol compliance
- Community settings with cultural customization
- Elder approval workflows for sensitive content
- Cultural protocol configuration and management

### Issue #41: Create activity logging with cultural audit

Implement audit trails with cultural sensitivity and compliance tracking.

**Enhanced Requirements**:

- Audit trails for administrative and cultural protocol actions
- Cultural compliance tracking and violation alerts
- Data access logging with community-specific requirements
- Privacy-compliant logging for sovereignty requirements
- Integration with elder approval and cultural workflow systems

### Issue #42: Build analytics with cultural privacy

Create usage statistics and metrics with cultural privacy protection.

**Enhanced Requirements**:

- Usage statistics with community data anonymization
- Story metrics with cultural sensitivity (no sacred content analytics)
- Community health indicators with privacy protection
- Cultural protocol compliance metrics
- Analytics export with sovereignty controls

### Issue #43: Implement backup and restore with sovereignty

Build system-level backup/restore with data sovereignty compliance.

**Enhanced Requirements**:

- Community-controlled backup with data sovereignty
- Selective restore capabilities for community autonomy
- Cultural protocol preservation in backup/restore
- Disaster recovery with community data isolation
- Encryption and security for cultural data protection

## Phase 10: Caching & Performance Optimization

### Issue #44: Implement caching strategy for offline

**MOVED FROM PHASE 10** - Caching is critical for offline performance.

Implement comprehensive caching strategy with offline considerations.

**Enhanced Requirements**:

- Design cache invalidation strategy for offline sync
- Implement query result caching with community isolation
- Plan media cache management with size limits for mobile
- Create cache size limits and cleanup strategies for Field Kit
- Redis integration for server-side caching
- In-memory caching for frequently accessed community data

### Issue #45: Optimize database connection pooling

Implement database connection pooling for concurrent request handling and performance.

**Enhanced Requirements**:

- Connection pooling with community-aware load balancing
- Performance optimization for community-scoped queries
- Connection management for offline sync operations
- Integration with spatial query optimization
- Resource management for Field Kit deployments

## Phase 11: Offline & Synchronization

### Issue #46: Design advanced offline data structures

Create comprehensive offline data management with conflict resolution.

**Enhanced Requirements**:

- IndexedDB schema with community isolation
- Local storage patterns for offline operation with cultural protocols
- Conflict-free replicated data types (CRDTs) for distributed sync
- Advanced sync metadata with version control and conflict tracking

### Issue #47: Implement comprehensive offline queue system

Build robust queue system for offline actions with cultural protocol support.

**Enhanced Requirements**:

- Queue for offline actions with retry logic and exponential backoff
- Conflict detection with cultural protocol preservation
- Operation prioritization based on cultural significance
- Integration with media sync and progressive download

### Issue #48: Create advanced sync conflict resolution

Implement sophisticated conflict resolution with cultural considerations.

**Enhanced Requirements**:

- Last-write-wins with cultural protocol override capabilities
- Manual conflict resolution with elder approval workflows
- Cultural protocol preservation during conflict resolution
- Community-specific conflict resolution strategies

### Issue #49: Build comprehensive Field Kit deployment

Create complete offline deployment package with all dependencies.

**Enhanced Requirements**:

- Docker setup for complete offline deployment
- All dependencies bundled for remote deployment
- WiFi hotspot configuration and network isolation
- Bandwidth optimization and resource management
- Integration with tile server and media caching

### Issue #50: Implement enhanced data portability

Build comprehensive data export with sovereignty and cultural controls.

**Enhanced Requirements**:

- Complete data export for community sovereignty and migration
- Cultural protocol preservation in export formats
- Data validation and integrity verification
- Support for partial exports and selective data sharing
- Integration with import capabilities for community autonomy

## Phase 12: Rails Compatibility Testing

### Issue #51: Create Rails API compatibility test suite

**NEW CRITICAL ISSUE** - Must validate compatibility during parallel operation.

Create comprehensive test suite comparing Rails and TypeScript API responses.

**Requirements**:

- Compare response formats between Rails and TypeScript APIs
- Validate media URL compatibility and accessibility
- Test authentication session handling compatibility
- Verify community isolation works identically
- Performance comparison and optimization
- Cultural protocol functionality verification

### Issue #52: Create offline sync test scenarios

**NEW CRITICAL ISSUE** - Offline sync is complex and must be thoroughly tested.

Create comprehensive test scenarios for offline synchronization and conflict resolution.

**Requirements**:

- Test conflict resolution with various data types
- Validate merge strategies for cultural content
- Test large dataset sync performance and reliability
- Verify checksum consistency and data integrity
- Test Field Kit deployment scenarios
- Cultural protocol preservation during sync

### Issue #53: Build parallel system operation testing

**NEW CRITICAL ISSUE** - Must validate parallel Rails/TypeScript operation.

Setup testing for gradual migration with parallel system operation.

**Requirements**:

- Configure load balancer routing rules for gradual migration
- Implement feature flags per community for controlled rollout
- Create fallback mechanisms for system failures
- Monitor performance metrics during parallel operation
- Test data consistency between Rails and TypeScript systems
- Validate cultural protocol enforcement across both systems

### Issue #54: Create Rails API compatibility layer

Build adapter endpoints matching exact Rails API responses for gradual migration.

**Enhanced Requirements**:

- Exact Rails API response format matching
- Session compatibility during transition
- Media URL compatibility preservation
- Cultural protocol consistency between systems

### Issue #55: Implement comprehensive data migration scripts

Create scripts to migrate existing Rails database with full validation.

**Enhanced Requirements**:

- Scripts to migrate existing Rails database to new schema
- Data integrity validation and verification
- Cultural protocol preservation during migration
- Rollback capability for each migration step

### Issue #56: Build gradual migration with load balancing

Enable safe parallel operation of Rails and TypeScript APIs.

**Enhanced Requirements**:

- Load balancer configuration for gradual migration
- Feature flags for community-specific rollout
- Real-time monitoring and automatic failover
- Data consistency validation between systems

### Issue #57: Create comprehensive rollback procedures

Implement safe rollback capability with data integrity protection.

**Enhanced Requirements**:

- Automated rollback scripts for each migration phase
- Data integrity validation after rollback
- Media file consistency verification
- Cultural protocol preservation during rollback
- Zero data loss guarantee

### Issue #58: Build migration testing with sovereignty validation

Create comprehensive test suite validating functionality and cultural compliance.

**Enhanced Requirements**:

- Data integrity and functionality parity validation
- Cultural protocol compliance testing
- Performance comparison between Rails and TypeScript
- Community data sovereignty verification
- Offline sync compatibility validation

## Phase 14: Community Validation & Production

### Issue #59: Indigenous community testing

**NEW CRITICAL ISSUE** - Real-world validation with community partners.

Conduct testing with actual Indigenous community partners.

**Requirements**:

- Test with actual community partners in real-world scenarios
- Validate cultural protocols work in practice
- Test offline scenarios in remote areas without reliable internet
- Gather feedback on data sovereignty implementation
- Validate cultural sensitivity and protocol enforcement
- Test Field Kit deployment in actual remote locations

### Issue #60: Production deployment with cultural compliance

**ENHANCED** - Production deployment with sovereignty monitoring.

Create production-ready deployment with comprehensive monitoring.

**Enhanced Requirements**:

- Cloud, on-premise, and Field Kit deployment guides
- Cultural compliance monitoring and alerting
- Performance monitoring with sovereignty protection
- Health check endpoints with privacy preservation
- Disaster recovery with community data isolation

### Issue #61: Create comprehensive documentation with cultural guidance

**ENHANCED** - Documentation including cultural considerations.

Generate complete documentation with cultural sensitivity guidance.

**Enhanced Requirements**:

- OpenAPI/Swagger documentation with cultural context
- Developer documentation with cultural protocol guidance
- Deployment guides for Indigenous community contexts
- Cultural sensitivity training materials
- Community autonomy and sovereignty documentation

### Issue #62: Build production CI/CD with sovereignty protection

**ENHANCED** - Production pipeline with cultural compliance validation.

Setup production deployment pipeline with cultural protocol validation.

**Enhanced Requirements**:

- CI/CD with automated cultural compliance testing
- Deployment workflows with sovereignty validation
- Performance monitoring with privacy protection
- Automated rollback with cultural data preservation
- Community-controlled deployment permissions

---

## Revised Roadmap Summary

### Enhanced Roadmap Structure (65+ Issues, 14 Phases)

**Phase 1-3**: Foundation with Spatial & Offline (6 weeks)

- PostGIS integration moved to Phase 1 (foundational)
- Offline-first design integrated from start
- Data sovereignty validation in Phase 2

**Phase 4**: ActiveStorage Migration (3 weeks)

- Dedicated phase for complex media migration
- Relationship preservation and URL compatibility

**Phase 5-7**: Core APIs with Cultural Protocols (6 weeks)

- Cultural sensitivity and internationalization
- Optimized spatial queries from start

**Phase 8-9**: Cultural Protocols & Admin (4 weeks)

- Internationalization for 6 languages
- Cultural protocol management system

**Phase 10-11**: Performance & Offline (4 weeks)

- Caching moved earlier for offline support
- Advanced offline synchronization

**Phase 12-13**: Rails Compatibility & Migration (4 weeks)

- Comprehensive testing and parallel operation
- Safe migration with rollback capabilities

**Phase 14**: Community Validation (2-4 weeks)

- Indigenous community testing
- Real-world validation and feedback

**Total Timeline**: 30-32 weeks (7-8 months)

### Critical Improvements Made

1. **PostGIS Priority**: Moved from Phase 3 to Phase 1 (foundational)
2. **Data Sovereignty Validation**: Added comprehensive testing in Phase 2
3. **ActiveStorage Complexity**: Dedicated migration phase with relationship preservation
4. **Cultural Sensitivity**: New phase for Indigenous community requirements
5. **Offline-First Design**: Integrated from Phase 1, not afterthought
6. **Internationalization**: Added 6-language support including Indigenous languages
7. **Community Validation**: Real-world testing with Indigenous partners
8. **Performance Optimization**: Spatial queries and caching moved earlier

### Usage with Workflow

Start the migration with:

```bash
/create-next-issue
```

Each issue is designed to be:

- **Self-contained** but building on previous work
- **Testable** with clear acceptance criteria including cultural compliance
- **Sized appropriately** for 1-3 day completion
- **Culturally sensitive** with Indigenous community considerations
- **Offline-first** with sync and Field Kit deployment support

### Enhanced Priority Tracks

**Track A**: Foundation & PostGIS (Issues #1-6)
**Track B**: Multi-tenant & Sovereignty (Issues #7-12) - after #6
**Track C**: Domain Models & Cultural (Issues #13-18) - after #9
**Track D**: Media & ActiveStorage (Issues #19-24) - after #15
**Track E**: Geographic & Offline (Issues #31-35) - after #15

This enhanced roadmap ensures complete feature parity while prioritizing Terrastories' core mission of Indigenous data sovereignty, cultural sensitivity, and offline-first operation in remote communities.
