# Terrastories TypeScript Migration Context File

## Executive Summary

Terrastories is a sophisticated **offline-first geostorytelling application** built for Indigenous and local communities to map, manage, and share place-based oral histories. The application implements **strict data sovereignty principles** through community-based isolation and is designed to operate completely offline via "Field Kit" deployments. The current Rails/React architecture with PostGIS spatial capabilities and multi-tenant design provides a solid foundation for TypeScript migration while maintaining backward compatibility.

## Rails Architecture & Core Models

### Application Structure

Terrastories follows standard Rails conventions with a **Dockerized Rails 5.2+ backend** serving a **React frontend**. The application uses **PostgreSQL with PostGIS** for spatial data and **ActiveStorage** for comprehensive media management.

### Core Domain Models

**Community Model** - Central organizing entity

- Represents Indigenous/local communities using the application
- Controls all data sovereignty boundaries and access isolation
- Contains customization settings (themes, maps, taxonomies)
- **Relationships**: `has_many :stories, :places, :speakers, :users, :themes`

**Story Model** - Core content entity

- Contains oral histories and multimedia narratives
- Supports multiple privacy levels (public, restricted, private)
- **Fields**: title, description, date_interview, language, topic, privacy_level
- **Relationships**: `belongs_to :community`, `belongs_to :speaker`, `has_many :place_stories`, `has_many_attached :media`

**Place Model** - Geographic locations with spatial data

- Contains PostGIS coordinates and geographic metadata
- **Fields**: name, latitude, longitude, region, place_type
- **PostGIS Fields**: `st_point :coords` with GiST spatial indexing
- **Relationships**: `belongs_to :community`, `has_many :place_stories`, `has_one_attached :photo, :name_audio`

**Speaker Model** - Storytellers and community members

- Biographical information and attribution data
- **Fields**: name, speaker_community, birthdate, biography
- **Relationships**: `belongs_to :community`, `has_many :stories`, `has_one_attached :photo`

**User Model** - Authentication with role-based access

- **Roles**: super_admin, admin, editor, member
- **Fields**: email, role, encrypted_password, community_id
- **Relationships**: `belongs_to :community` (except super_admins)

**PlaceStory Model** - Many-to-many junction table

- Enables stories to be associated with multiple geographic locations
- Contains additional metadata about story-place relationships

### Database Schema Patterns

- **Multi-tenancy**: Community-scoped data isolation via foreign keys
- **PostGIS Integration**: Geographic coordinates stored as both `st_point` geometry and float fields
- **ActiveStorage Tables**: `active_storage_blobs` and `active_storage_attachments` for media
- **Standard Rails Conventions**: Timestamped migrations, pluralized table names, `id` primary keys

## API Architecture & Endpoints

### RESTful API Structure

```ruby
namespace :api, defaults: { format: :json } do
  resources :communities, only: [:index, :show] do
    resources :stories, only: [:index, :show]
    resources :places, only: [:show]
  end
end
```

### Core API Endpoints

**Communities API**

- `GET /api/communities` - List all public communities
- `GET /api/communities/:id` - Show specific community details

**Stories API**

- `GET /api/communities/:id/stories` - List community stories (filtered by privacy)
- `GET /api/communities/:id/stories/:story_id` - Show specific story with media

**Places API**

- `GET /api/communities/:id/places/:place_id` - Show geographic location details

### Administrative Dashboard Routes

```ruby
# Community member routes (non-super admin)
scope '/member', module: 'dashboard', constraints: RoleRoutingConstraint.new { |user| !user.super_admin }

# Super admin routes
scope '/admin', module: 'super_admin', constraints: RoleRoutingConstraint.new { |user| user.super_admin }
```

### Response Formats

All API endpoints return JSON with standardized structures:

```typescript
interface Story {
  id: number;
  title: string;
  description: string;
  media: MediaAttachment[];
  places: Place[];
  speakers: Speaker[];
  restricted: boolean;
  createdAt: string;
}
```

## Authentication & Authorization

### Authentication System

- **Session-based authentication** (not Devise-based)
- **Custom Rails authentication** with community-specific credentials
- **Default credentials**: Super Admin (`terrastories-super` / `terrastories`)
- **Login/logout routes**: `/login`, `/logout`, `/profile`, `/change_password`

### Three-Tier Role Structure

**Super Administrator**

- Server-level administration and community creation
- **Cannot access individual community data** (data sovereignty principle)
- Global metrics and system administration only

**Community Administrator**

- Full administrative access within specific community
- User management, story privacy controls, theme customization
- Community settings and configuration management

**Community Members/Users**

- Role-based access to community content
- Story visibility based on privacy levels and user permissions
- Profile management and basic interaction capabilities

### Authorization Patterns

```ruby
# Route-level constraints for role separation
constraints: RoleRoutingConstraint.new { |user| user.super_admin }
constraints: RoleRoutingConstraint.new { |user| !user.super_admin }
```

## Multi-Tenancy & Data Sovereignty

### Community Isolation Architecture

- **Database-level isolation** with community-scoped queries
- **Super admins cannot access community data** - critical privacy feature
- **Complete data sovereignty** - communities control all their content
- **Local deployment options** - communities can host their own instances

### Data Sovereignty Implementation

- **Community-owned data** with no cross-community visibility
- **Offline-first design** keeps data within physical community territory
- **Export capabilities** for complete data portability
- **Privacy controls** with multiple story restriction levels

### Community Management Features

- Custom themes and color schemes per community
- Configurable map settings and background images
- Language and locale settings (6 languages supported)
- Sponsor logo management and community branding

## Geographic & Spatial Features

### PostGIS Implementation

- **activerecord-postgis-adapter** for spatial database operations
- **Dual coordinate storage**: PostGIS `st_point` geometry + float lat/lng fields
- **Spatial indexing**: GiST indexes for efficient geographic queries
- **WGS84 coordinate system** with projection support

### Mapping Technology

- **MapLibre GL JS** (TypeScript-compatible) for map rendering
- **Custom Rails integration** via `maplibre-gl-rails` gem
- **Vector tile rendering** with WebGL performance
- **Offline tile serving** via TileServer-GL

### Offline Geographic Capabilities

- **Local tile server** for complete offline map functionality
- **MBTiles format** for offline vector and raster tiles
- **Custom tile generation** from QGIS, Shapefile, GeoJSON sources
- **Default open-license tiles** with global coverage to zoom level 8

### Spatial Data Operations

- **Distance calculations** using PostGIS functions
- **Spatial joins** between stories and places
- **Bounding box queries** for map viewport optimization
- **Geographic search** and filtering capabilities

## Media Handling Architecture

### Rails ActiveStorage Integration

- **Multi-file attachments** per story via `has_many_attached :media`
- **Single file attachments** for places (photo, name_audio) and speakers (photo)
- **Local storage backend** with cloud storage options (S3, Google Cloud, Azure)
- **Automatic metadata extraction** (filename, content_type, file_size)

### Supported Media Formats

- **Audio**: MP3, WAV, other common formats
- **Video**: MP4, WebM, various containers
- **Images**: JPEG, PNG, GIF, WebP
- **Processing**: Image variants, thumbnails, preview generation

### Media Security & Access Control

- **Signed URLs** for secure file access
- **Community-scoped permissions** for media visibility
- **Private/restricted media** designation matching story privacy levels
- **Direct file serving** for offline deployments

## Offline Synchronization & Field Kit Architecture

### Offline-First Design Principles

- **Local-first application** prioritizing offline functionality
- **Complete offline operation** without internet dependency
- **Docker containerization** for consistent deployment
- **Field Kit deployment** via WiFi hotspot from single computer

### Field Kit Implementation

```
[Host Computer] → [WiFi Hotspot] → [Connected Devices]
     ↓                               ↓
[Docker Containers]              [Browser Access]
- Rails App
- PostgreSQL DB
- TileServer-GL
- Local Media Storage
```

### Synchronization Capabilities

- **Import/export functionality** for batch data operations
- **Manual data transfer** between Field Kit instances
- **No automatic sync** - designed for independent operation
- **Local database persistence** with PostgreSQL containers

### Setup & Deployment

- **Automated setup script** (`./bin/setup`) for configuration
- **Multi-platform support** (Windows requires WSL 2.0)
- **Offline tile management** in `tileserver/data/` directory
- **Self-contained operation** with no external dependencies

## Data Relationships & Business Logic

### Core Entity Relationships

```
Community (1) ←→ (many) Stories, Places, Speakers, Users
Story (many) ←→ (many) Places (via PlaceStory junction table)
Story (many) ←→ (1) Speaker
Story (1) ←→ (many) Media Attachments (ActiveStorage)
```

### Story Privacy & Visibility Rules

**Privacy Levels**:

1. **Public** - viewable by anyone, included in API responses
2. **Restricted** - authentication required, community members only
3. **Private** - specific user/role access (planned enhancement)

### Data Validation Constraints

- **Stories** must belong to Community, have Place associations, Speaker attribution
- **Places** require geographic coordinates, community assignment, region classification
- **Users** can only belong to one Community (except super admins)
- **Media files** have format restrictions and size validation

### Business Logic Workflows

**Story Publication Process**:

1. Content creation with metadata
2. Place association (one or more locations)
3. Speaker attribution assignment
4. Privacy level designation
5. Media upload and validation
6. Publication based on privacy settings

## Dependencies & Infrastructure

### Critical Rails Gems & TypeScript Equivalents

- **maplibre-gl-rails** → Direct MapLibre GL JS with TypeScript definitions
- **pg (PostgreSQL adapter)** → node-postgres or Prisma ORM
- **webpacker** → Vite, Webpack, or modern bundlers
- **activerecord-postgis-adapter** → PostGIS support in chosen TypeScript ORM
- **administrate** → Custom admin interface or existing TypeScript admin libraries

### Frontend Dependencies

- **React** (JavaScript, not TypeScript currently)
- **MapLibre GL JS** (already TypeScript-compatible)
- **Rails Webpacker** for asset compilation
- **Internationalization** supporting 6 languages

### Docker Infrastructure

```yaml
services:
  db:
    image: postgres:11
    environment:
      POSTGRES_PASSWORD: ${DB_USER_PASSWORD}
  web:
    build: ./rails
    ports: ['3000:3000']
    depends_on: [db]
    volumes:
      - ./data/media:/media
```

### Environment Configuration

- **DEFAULT_MAPBOX_TOKEN** for map API access
- **DB_USER_PASSWORD** for database authentication
- **Multi-environment support** (development, production, field kit, mesh network)
- **Asset pipeline** with custom Webpacker configuration

## Testing & Development Patterns

### Current Testing Setup

- **Backend**: Rails RSpec (standard Rails testing framework)
- **Frontend**: Jest (partially configured, incomplete)
- **Database**: Rails migrations with seed data in `rails/db/seeds.rb`
- **Development**: Automated setup script with Docker hot reloading

### Migration Testing Requirements

- **Unit Testing**: Jest/Vitest for TypeScript backend, React Testing Library for UI
- **Integration Testing**: API testing with proper community isolation validation
- **E2E Testing**: Full application testing with offline scenario coverage
- **Database Testing**: Migration testing with PostGIS spatial operations

## Custom Rails Patterns & Middleware

### Role-Based Routing Constraints

```ruby
class RoleRoutingConstraint
  def self.new(&block)
    lambda { |request| block.call(request.env['warden']&.user) }
  end
end
```

### Community-Scoped Data Access

- **Automatic community filtering** in database queries
- **Session-based community context** for multi-tenant operations
- **Rails before_action callbacks** for community authorization
- **Custom admin interface** using Administrate gem with role restrictions

### ActiveStorage Customization

- **Multiple attachment types** per model (media, photos, audio files)
- **Custom file processing** for audio/video metadata extraction
- **Secure file serving** with community-based access controls
- **Media deletion endpoints** for file management

## Frontend-Backend Integration

### Current Integration Architecture

- **Server-side rendering** with Rails views containing embedded React components
- **API endpoints** for React component data fetching
- **Rails session management** with React UI authentication
- **Webpacker asset pipeline** managing React compilation

### Data Flow Patterns

- **RESTful API consumption** with JSON responses
- **Rails flash messages** for server-side error handling
- **React error boundaries** for client-side error containment
- **Offline state management** using local storage

### Internationalization Integration

- **Rails I18n backend** with frontend consumption
- **Dynamic language switching** based on user preferences
- **Community-specific language** settings and locale management

## TypeScript Migration Recommendations

### Immediate Migration Priorities

1. **Preserve Data Sovereignty Architecture**
   - Maintain strict community isolation in new system
   - Ensure super admin restrictions are preserved
   - Implement community-scoped authentication and authorization

2. **Database Schema Migration**
   - Use Prisma or TypeORM with existing PostgreSQL/PostGIS schema
   - Preserve all relationships and constraints
   - Maintain spatial data types and indexing

3. **API Compatibility Layer**
   - Create TypeScript interfaces matching current JSON responses
   - Maintain REST endpoint structure and community-scoped access
   - Preserve authentication and session management patterns

4. **Media Handling Strategy**
   - Replace ActiveStorage with Node.js file handling solution
   - Maintain multi-file attachment capabilities
   - Preserve file security and access control patterns

5. **Offline-First Preservation**
   - Implement Service Workers for PWA offline capabilities
   - Maintain local data persistence with IndexedDB or similar
   - Preserve Field Kit deployment architecture

### Advanced Enhancements for TypeScript Version

1. **Enhanced Synchronization**
   - Implement proper conflict resolution strategies
   - Add incremental sync protocols for Field Kit deployments
   - Create sync status indicators and user interfaces

2. **Real-Time Features**
   - Consider WebSocket implementation for collaborative editing
   - Add live updates for multi-user story creation
   - Implement real-time conflict detection

3. **Progressive Web App Features**
   - Enhanced offline indicators and sync status
   - Background sync capabilities for intermittent connectivity
   - Improved mobile experience with native-like features

4. **Type Safety Implementation**
   - Comprehensive TypeScript interfaces for all data models
   - Runtime type validation for API requests/responses
   - Strong typing for geographic coordinates and spatial operations

### Architecture Considerations

**Preserve Core Values**:

- **Data sovereignty** and community control
- **Offline-first** operation capabilities
- **Multi-tenant isolation** and security
- **Indigenous community focus** and cultural sensitivity

**Technical Improvements**:

- **Modern development tooling** with TypeScript
- **Improved testing coverage** and development experience
- **Enhanced performance** and maintainability
- **Scalable synchronization** for distributed deployments

This comprehensive context file provides the technical foundation necessary for maintaining full backward compatibility while migrating Terrastories from Rails to TypeScript, ensuring all critical functionality, business logic, and community sovereignty principles are preserved throughout the transition.
