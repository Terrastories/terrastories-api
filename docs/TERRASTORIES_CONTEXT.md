# Terrastories Context & Architecture

## Project Overview

Terrastories is a sophisticated **offline-first geostorytelling application** designed for Indigenous and local communities to map, manage, and share place-based oral histories. The core mission is to support data sovereignty through community-based data isolation. The application is built to operate completely offline in "Field Kit" deployments.

### High-Level Architecture

- **Original Stack**: Ruby on Rails (v5.2+) backend with a hybrid React frontend (react-rails gem)
- **Database**: PostgreSQL with PostGIS for spatial data
- **Storage**: Rails ActiveStorage for media files (audio, video, images)
- **Deployment**: Dockerized multi-service architecture (Rails, PostgreSQL, Nginx, Tileserver)
- **Key Feature**: Multi-tenant design where each "Community" is a distinct data silo

### Migration Goal

The primary goal is to perform a **1:1 migration of the backend API from Ruby on Rails to a modern TypeScript stack** (Fastify, Drizzle ORM).

- **No new features**: The new API must have exact feature parity with the existing Rails API
- **Database preservation**: The PostgreSQL/PostGIS database schema and data will be preserved
- **Frontend is out of scope**: The frontend will be addressed in a separate, future migration phase

## Core Data Models

Terrastories is built around five core models that have intricate relationships.

### Community

The central organizing entity and the basis for multi-tenancy. All other core data belongs to a Community.

- **Description**: Represents an Indigenous or local community. It controls data sovereignty boundaries, access, and customization (themes, map styles)
- **Key Fields**: name, slug, description, public_stories
- **Relationships**: has_many Stories, Places, Speakers, Users, and Themes

### Story

The primary content entity, representing oral histories and narratives.

- **Description**: Contains the narrative content, which can be linked to multiple places and speakers
- **Key Fields**: title, description, language, topic, permission_level, privacy_level
- **Relationships**:
  - belongs_to a Community
  - has_and_belongs_to_many Places
  - has_and_belongs_to_many Speakers
  - has_many_attached media files (via ActiveStorage in Rails)

### Place

A geographic location that is part of a story.

- **Description**: Represents a point or region on the map. Places can be associated with multiple stories
- **Key Fields**: name, description, type_of_place, region, lat, long
- **PostGIS Integration**: Uses geometry/geography types with SRID 4326 (WGS84)
- **Spatial Features**: GiST indexes for performance, coordinate validation and transformation

### Speaker

A person who tells stories, representing storytellers and knowledge holders.

- **Description**: Individuals associated with stories, often community elders or cultural knowledge holders
- **Key Fields**: name, bio, birthplace, photo_url
- **Cultural Sensitivity**: Elder status recognition and cultural role information

### User

Represents people who can access and manage content in the system.

- **Key Fields**: email, role, community_id, encrypted_password
- **Authentication**: Session-based authentication via Devise (Rails) / Fastify sessions (TypeScript)
- **Roles**: super_admin, admin, editor, viewer, elder

## Authentication & Authorization

### Authentication

- **Mechanism**: The original Rails application uses the **Devise gem** for session-based authentication
- **Migration Strategy**: The new TypeScript API replicates this behavior. A user authenticates with an email and password, and the server returns a session cookie (connect.sid) for subsequent authenticated requests

### Authorization (Roles)

Terrastories uses a role-based access control (RBAC) system. A user's role determines what actions they can perform:

- **Super Admin**: Has full control over all communities and users. Can create new communities and assign community admins. **CRITICAL**: Cannot access community content data due to data sovereignty requirements
- **Community Admin**: Has full control over a single community. Can manage users, stories, places, and speakers within that community
- **Editor**: Can create, edit, and delete content (stories, places, speakers) within their assigned community
- **Viewer**: Can view all content within their community, including restricted stories. Cannot create or edit content
- **Elder**: Special cultural role with enhanced permissions for culturally sensitive content

Access control is enforced at the controller/route level, ensuring that users can only access resources and perform actions permitted by their role.

## API Architecture

The Terrastories API is structured into three main namespaces:

### Public API (`/api`)

**Purpose**: Read-only access to community content for public consumption
**Authentication**: None required
**Scope**: Public stories and places only

Key endpoints:

- `GET /api/communities` - List all communities
- `GET /api/communities/:id` - Get community details
- `GET /api/communities/:community_id/stories` - Get public stories for a community
- `GET /api/communities/:community_id/places/:id` - Get place details

### Member Dashboard (`/member`)

**Purpose**: Authenticated content management for community members
**Authentication**: Session-based, community-scoped
**Scope**: Full CRUD operations on community content

Key endpoints:

- Full CRUD for `/member/stories`
- Full CRUD for `/member/places`
- Full CRUD for `/member/speakers`
- File upload endpoints with multipart support

### Super Admin (`/super_admin`)

**Purpose**: System administration and community management
**Authentication**: Session-based, super_admin role required
**Scope**: User and community management (NOT content data)

Key endpoints:

- Full CRUD for `/super_admin/communities`
- Full CRUD for `/super_admin/users`

## Media Handling Architecture

### Original Rails Implementation (ActiveStorage)

- **Polymorphic Associations**: Files can be attached to any model (Story, Place, Speaker)
- **Blob Storage**: File metadata stored in `active_storage_blobs` table
- **Attachments**: Relationship data in `active_storage_attachments` table
- **File Organization**: Files stored with UUID-based keys in Rails storage directory

### TypeScript Migration Strategy

- **Direct File System**: Replace ActiveStorage with direct file system storage
- **Community Isolation**: Organize files by community: `uploads/community_{id}/{stories|places|speakers}/`
- **Media URL Generation**: Direct file serving with access control
- **Migration Process**: ActiveStorage-to-filesystem migration script with integrity validation

### File Upload Implementation

- **Multipart Support**: Using `fastify-multipart` for file uploads
- **File Validation**: Type, size, and security validation
- **Access Control**: Community-scoped file access with authentication
- **Cultural Protocols**: Elder-only content restrictions

## PostGIS & Mapping

### Spatial Data Requirements

- **PostGIS Extension**: Essential for geographic operations
- **Coordinate System**: SRID 4326 (WGS84) standard
- **Data Types**: Both `geometry` and `geography` columns supported
- **Spatial Indexes**: GiST indexes for query performance

### Spatial Operations

- **Coordinate Validation**: Input validation for lat/lng coordinates
- **Spatial Queries**: Radius and bounding box searches
- **SQLite Fallback**: Development and offline support with basic spatial operations
- **Performance**: Optimized spatial queries for production deployment

### Mapping Integration

- **Tileserver**: Self-hosted map tiles for offline operation
- **Cultural Significance**: Place-based cultural metadata
- **Community Boundaries**: Geographic boundaries for data sovereignty

## Database Schema

### Enhanced Schema Features

- **Multi-tenancy**: Community-scoped data isolation
- **Cultural Protocols**: Privacy levels and elder content support
- **Offline Synchronization**: Sync metadata for conflict resolution
- **Audit Logging**: Cultural protocol compliance tracking

### Key Relationships

```
Community (1) -> (many) User
Community (1) -> (many) Story
Community (1) -> (many) Place
Community (1) -> (many) Speaker
Story (many) <-> (many) Place (through story_places)
Story (many) <-> (many) Speaker (through story_speakers)
```

### Migration Considerations

- **Schema Preservation**: Maintain existing PostgreSQL schema
- **Drizzle ORM**: Type-safe database operations
- **Migration Scripts**: Automated schema evolution
- **Data Integrity**: Foreign key constraints and validation

## Deployment Architecture

### Multi-Environment Support

- **Development**: Local SQLite with hot-reload
- **Production**: PostgreSQL with SSL, monitoring, resource limits
- **Field Kit**: Offline SQLite deployment for remote communities
- **Test**: Isolated test database with fixtures

### Indigenous Community Deployment

- **Data Sovereignty**: Community data cannot be accessed by super admins
- **Cultural Protocols**: Elder content restrictions and cultural significance levels
- **Offline-First**: Complete operation without internet connectivity
- **Field Kit**: Raspberry Pi deployment for remote areas
- **Backup & Sync**: Community-controlled data synchronization

### Docker Configuration

- **Multi-stage Build**: Development and production stages
- **Service Architecture**: API, database, tileserver, nginx services
- **SSL Termination**: Nginx reverse proxy with security headers
- **Health Checks**: Container monitoring and restart policies
- **Volume Management**: Persistent data storage

## Offline Synchronization

### Field Kit Deployment Model

- **Hardware**: Raspberry Pi or similar resource-constrained devices
- **Database**: SQLite for offline operation
- **Sync Strategy**: Periodic synchronization with main server
- **Conflict Resolution**: Community-prioritized conflict resolution
- **Cultural Data**: Complete offline access to culturally significant content

### Synchronization Metadata

- **Sync Status**: Track synchronization state per record
- **Conflict Markers**: Identify and resolve data conflicts
- **Timestamp Tracking**: Last modified and sync timestamps
- **Community Priority**: Community changes take precedence over external changes

### Technical Implementation

- **Background Sync**: Non-blocking synchronization processes
- **Incremental Updates**: Only sync changed records
- **Integrity Validation**: Checksums and validation during sync
- **Cultural Protocol Preservation**: Maintain access restrictions during sync
