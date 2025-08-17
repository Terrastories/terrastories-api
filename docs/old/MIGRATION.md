# Terrastories Migration Analysis and Plan

**⚠️ Critical Status Warning:** According to official documentation, Terrastories cannot currently be self-hosted without developer assistance due to maintenance issues with dependencies. Feature development is on hold indefinitely.

## Current Architecture Assessment

### Tech Stack Overview

**Backend Framework:** Ruby on Rails application serving as both web server and API
**Frontend Architecture:** Hybrid Rails-React integration using react-rails gem and Webpacker
**Database:** PostgreSQL with Active Record ORM
**Authentication:** Devise gem with role-based access control
**Admin Interface:** Administrate gem for content management
**File Storage:** Rails ActiveStorage for media management
**Mapping:** Mapbox GL JS / MapLibre GL JS for interactive geospatial features
**Deployment:** Docker containerization with multi-service architecture

### Current Frontend Structure

The frontend uses a **hybrid Rails-React approach** rather than a standalone React application. React components are embedded within Rails ERB templates using the `react_component` helper method. This creates server-side rendered pages enhanced with interactive React components, particularly for mapping functionality.

**Key Components:**

- Rails views serve as page templates
- React components handle interactive map features
- Webpacker manages JavaScript bundling and asset compilation
- Server-side rendering provides SEO benefits and offline compatibility

### Database Architecture

**Current ORM:** Active Record (Rails' built-in ORM)
**Schema Features:**

- Multi-tenant community-based data isolation
- Complex relationships between User, Community, Story, Place, and Speaker models
- File attachment handling through ActiveStorage
- Geographic data storage for mapping features
- Role-based permission system with restricted content controls

**Core Models:**

- **Community** - Multi-tenant organization structure
- **Story** - Media-rich storytelling content with place-based associations
- **Place** - Geographic locations with coordinate data
- **User** - Authentication and role management (Super Admin, Community Admin, Members)
- **Speaker** - People who tell the stories

### API Structure

The Rails application provides RESTful JSON APIs under the `/api` namespace, supporting the separate "Explore Terrastories" React application. API endpoints follow standard Rails conventions with community-scoped resources.

### Authentication & Authorization

**Authentication:** Devise-based user management with session handling
**Authorization Levels:**

- Super Admin (cross-community access)
- Community Admin (community-specific management)
- Members (limited community access)
- Public access (for unrestricted stories)

## Migration Plan: Rails-React to Pure React + Drizzle ORM

### Phase 1: Frontend Migration Strategy (8-12 weeks)

#### Step 1: API Expansion and Stabilization (2-3 weeks)

**Expand Rails API Coverage:**

- Document all existing Rails controller actions and identify missing API endpoints
- Create comprehensive API endpoints for all admin functionality currently handled by Rails views
- Implement consistent JSON serialization across all endpoints
- Add API versioning to maintain compatibility during migration
- Strengthen API authentication and authorization middleware

**Critical API Endpoints to Add:**

```typescript
// Admin functionality APIs
POST /api/admin/stories
PUT /api/admin/stories/:id
DELETE /api/admin/stories/:id
GET /api/admin/communities/:id/analytics
POST /api/admin/users/:id/roles
```

#### Step 2: React Application Bootstrap (2-3 weeks)

**Create New React Application:**

- Initialize new React application with Vite or Create React App
- Set up TypeScript for type safety
- Implement state management (Redux Toolkit or Zustand)
- Configure routing with React Router
- Set up authentication context and protected routes

**Technology Stack Recommendations:**

```json
{
  "framework": "React 18+ with TypeScript",
  "bundler": "Vite (superior to Webpacker)",
  "state": "Redux Toolkit or Zustand",
  "routing": "React Router v6",
  "ui": "Chakra UI or Tailwind CSS + Headless UI",
  "mapping": "MapLibre GL JS (open-source Mapbox alternative)",
  "forms": "React Hook Form with Zod validation",
  "api": "React Query/TanStack Query for caching"
}
```

#### Step 3: Component Migration (4-5 weeks)

**Priority Migration Order:**

1. **Authentication components** (login, registration, password reset)
2. **Map components** (critical core functionality)
3. **Story browsing interface** (public-facing features)
4. **Admin dashboard** (content management)
5. **Story creation/editing forms** (complex form handling)

**Map Component Migration:**

```typescript
// Current: Rails + React hybrid
<%= react_component('MapComponent', { stories: @stories }) %>

// Target: Pure React with API integration
const MapComponent = () => {
  const { data: stories } = useQuery(['stories'], fetchStories);
  return <MapLibreGL stories={stories} />;
};
```

### Phase 2: Database Migration to Drizzle ORM (6-8 weeks)

#### Step 1: Schema Analysis and Drizzle Setup (1-2 weeks)

**Analyze Current Active Record Schema:**

- Export complete database schema from Rails migrations
- Document all model relationships and constraints
- Identify PostgreSQL-specific features in use
- Map data types from Rails to Drizzle equivalents

**Drizzle Schema Definition:**

```typescript
// Example schema migration
export const communities = pgTable('communities', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  slug: varchar('slug', { length: 255 }).unique(),
  description: text('description'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const stories = pgTable('stories', {
  id: serial('id').primaryKey(),
  title: varchar('title', { length: 255 }).notNull(),
  description: text('description'),
  communityId: integer('community_id').references(() => communities.id),
  placeId: integer('place_id').references(() => places.id),
  isRestricted: boolean('is_restricted').default(false),
});
```

#### Step 2: Node.js Backend Development (3-4 weeks)

**Backend Framework Selection:**

- **Express.js** for familiarity and ecosystem maturity
- **Fastify** for better performance and TypeScript support
- **tRPC** for end-to-end type safety with React frontend

**Authentication Migration:**

```typescript
// Migrate from Devise to modern Node.js auth
import { auth } from '@/lib/auth';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

// Replace Devise session management with JWT
const authenticateUser = async (email: string, password: string) => {
  const user = await db.select().from(users).where(eq(users.email, email));
  if (user && (await bcrypt.compare(password, user.passwordHash))) {
    return jwt.sign({ userId: user.id }, process.env.JWT_SECRET);
  }
};
```

#### Step 3: API Rebuilding with Drizzle (2-3 weeks)

**Replace Rails Controllers:**

```typescript
// Example: Stories API with Drizzle
export const storiesRouter = express.Router();

storiesRouter.get('/communities/:communityId/stories', async (req, res) => {
  const stories = await db
    .select()
    .from(storiesTable)
    .where(eq(storiesTable.communityId, req.params.communityId))
    .leftJoin(placesTable, eq(storiesTable.placeId, placesTable.id));

  res.json(stories);
});
```

### Phase 3: Data Migration and Integration (4-6 weeks)

#### Step 1: Data Migration Scripts (2-3 weeks)

**PostgreSQL to PostgreSQL Migration:**

```typescript
// Migration script using Drizzle
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

const migrationClient = postgres(DATABASE_URL);
const db = drizzle(migrationClient);

// Migrate existing data while preserving relationships
const migrateData = async () => {
  // Migrate communities first (no dependencies)
  const communities = await legacyDb.query('SELECT * FROM communities');
  await db.insert(communitiesTable).values(communities);

  // Migrate users with community relationships
  const users = await legacyDb.query('SELECT * FROM users');
  await db.insert(usersTable).values(users);

  // Continue with remaining tables in dependency order...
};
```

#### Step 2: File Storage Migration (1-2 weeks)

**ActiveStorage to Modern File Handling:**

- Migrate from Rails ActiveStorage to cloud storage (AWS S3, Cloudinary) or local file system
- Update file upload handling to use modern multipart upload APIs
- Preserve file associations and metadata

**Implementation:**

```typescript
// Replace ActiveStorage with modern file handling
import { S3Client } from '@aws-sdk/client-s3';
import multer from 'multer';

const storage = multer.memoryStorage();
const upload = multer({ storage });

app.post('/api/stories/:id/media', upload.single('file'), async (req, res) => {
  const fileUrl = await uploadToS3(req.file);
  await db.insert(mediaAttachments).values({
    storyId: req.params.id,
    fileUrl,
    fileName: req.file.originalname,
  });
});
```

### Phase 4: Deployment and Infrastructure Migration (3-4 weeks)

#### Step 1: Containerization Updates (1-2 weeks)

**New Docker Architecture:**

```dockerfile
# Node.js backend Dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 3000
CMD ["npm", "start"]
```

**Updated Docker Compose:**

```yaml
version: '3.8'
services:
  frontend:
    build: ./frontend
    ports:
      - '3000:3000'
    environment:
      - REACT_APP_API_URL=http://localhost:3001

  backend:
    build: ./backend
    ports:
      - '3001:3001'
    environment:
      - DATABASE_URL=postgresql://user:pass@db:5432/terrastories
      - JWT_SECRET=${JWT_SECRET}
    depends_on:
      - db

  db:
    image: postgres:15
    environment:
      - POSTGRES_DB=terrastories
      - POSTGRES_USER=user
      - POSTGRES_PASSWORD=pass
    volumes:
      - postgres_data:/var/lib/postgresql/data
```

#### Step 2: Offline Capability Preservation (1-2 weeks)

**Critical Offline Requirements:**

- Implement service workers for frontend caching
- Design offline-first data synchronization
- Preserve tile server functionality for mapping
- Create offline data backup and restore mechanisms

### Additional Technologies and Tools Needed

#### Frontend Technologies

- **Vite**: Superior build tool replacing Webpacker
- **React Query/TanStack Query**: API state management and caching
- **Zod**: Runtime type validation
- **React Hook Form**: Form handling
- **MapLibre GL JS**: Open-source mapping (replacing Mapbox)

#### Backend Technologies

- **Drizzle ORM**: Type-safe PostgreSQL ORM
- **Fastify or Express**: Node.js web framework
- **Zod**: Input validation
- **Node.js**: Runtime environment
- **PM2**: Process management for production

#### DevOps and Infrastructure

- **Docker**: Containerization (updated configurations)
- **Nginx**: Reverse proxy and static file serving
- **PostgreSQL 15+**: Database upgrade
- **Let's Encrypt**: SSL certificate management

### Migration Challenges and Solutions

#### Challenge 1: Complex Multi-tenancy

**Problem:** Rails' community-based data isolation needs careful preservation
**Solution:** Implement database-level row security policies and careful API scoping

#### Challenge 2: File Upload Migration

**Problem:** ActiveStorage integration with existing media files
**Solution:** Create migration scripts that preserve file associations and implement gradual migration

#### Challenge 3: Authentication Complexity

**Problem:** Devise's complex role system with multiple user types
**Solution:** Implement JWT-based authentication with role-based middleware

#### Challenge 4: Offline Functionality

**Problem:** Rails-based offline capabilities need preservation
**Solution:** Implement service workers, local caching, and data synchronization patterns

#### Challenge 5: Map Integration

**Problem:** Complex mapping functionality with offline tile support
**Solution:** Maintain tile server architecture and implement progressive web app patterns

### Timeline and Effort Estimation

**Total Estimated Timeline: 21-30 weeks (5-7 months)**

**Resource Requirements:**

- 2-3 Senior Full-stack Developers
- 1 DevOps Engineer
- 1 Project Manager
- Community involvement for testing and feedback

**Phase Breakdown:**

1. **API and React Setup:** 6-8 weeks
2. **Database Migration:** 6-8 weeks
3. **Data Migration:** 4-6 weeks
4. **Deployment and Testing:** 3-4 weeks
5. **Community Testing and Fixes:** 2-4 weeks

### Risk Mitigation Strategies

**Technical Risks:**

- Gradual migration approach with parallel system operation
- Extensive testing with community stakeholders
- Database backup and rollback procedures
- API versioning for compatibility

**Community Impact:**

- Maintain Rails system during migration for continuity
- Extensive user testing with Indigenous communities
- Documentation and training materials
- Phased rollout with feedback incorporation

### Conclusion

The migration from Rails-React hybrid to pure React + Drizzle ORM is technically feasible but represents a significant undertaking. The current architecture's complexity, particularly around multi-tenancy, offline capabilities, and file management, requires careful planning and execution.

**Key Success Factors:**

1. Community involvement throughout the process
2. Preservation of offline-first design principles
3. Gradual migration approach to minimize disruption
4. Comprehensive testing in real-world community environments

Given the current maintenance challenges with the existing codebase, this migration could resolve dependency issues while modernizing the technology stack. However, it requires substantial development resources and community cooperation to ensure the unique needs of Indigenous communities continue to be met.
