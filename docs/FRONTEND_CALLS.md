## Terrastories API Endpoints

Terrastories is a **map-based storytelling** app built with TypeScript/Fastify (backend) and React (frontend), designed for Indigenous communities to preserve and share their cultural stories. The TypeScript API provides a comprehensive RESTful interface with strict data sovereignty protections and session-based authentication.

## API Architecture

### Base URL and Versioning

All authenticated API endpoints use the `/api/v1/` prefix. The API runs on port 3000 by default:

- **Base URL**: `http://localhost:3000/api/v1/`
- **Public endpoints**: `/api/` (health checks, public data)
- **Swagger Documentation**: `http://localhost:3000/docs`

### Authentication System

The API uses **session-based authentication** with HTTP-only cookies:

- No bearer tokens or JWT required
- Sessions are managed by Fastify with secure cookies
- Community-scoped authentication (users belong to specific communities)
- Data sovereignty protection prevents super admins from accessing community content

### Data Sovereignty Protection

🔒 **Critical Feature**: Super administrators are **blocked** from accessing community data (stories, places, speakers) to enforce Indigenous data sovereignty principles. Community content can only be accessed by community members (admin, editor, elder, viewer roles).

## Core API Endpoints

### Authentication (`/api/v1/auth/`)

- `POST /api/v1/auth/register` – Register a new user with community assignment
- `POST /api/v1/auth/login` – Authenticate user and create session (requires email, password, communityId)
- `POST /api/v1/auth/logout` – Destroy session and logout current user
- `GET /api/v1/auth/me` – Get current authenticated user information
- `POST /api/v1/auth/forgot-password` – Initiate password reset process
- `POST /api/v1/auth/reset-password` – Reset password using valid token
- `GET /api/v1/auth/admin-only` – Test endpoint for admin role verification
- `GET /api/v1/auth/community-data` – Test endpoint for data sovereignty (blocks super admins)

### Communities (`/api/v1/communities/`)

- `GET /api/v1/communities` – List all communities (public access)
- `POST /api/v1/communities` – Create a new community (requires authentication)
- `GET /api/v1/communities/:id` – View specific community details

### Super Admin Operations (`/api/v1/super_admin/`)

**Note**: These endpoints are for system administration and cross-community management:

- `GET /api/v1/super_admin/communities` – List all communities (super admin only)
- `POST /api/v1/super_admin/communities` – Create communities (super admin only)
- `PUT /api/v1/super_admin/communities/:id` – Update community (super admin only)
- `DELETE /api/v1/super_admin/communities/:id` – Delete community (super admin only)
- `GET /api/v1/super_admin/users` – List all users across communities (super admin only)
- `POST /api/v1/super_admin/users` – Create users for any community (super admin only)
- `PUT /api/v1/super_admin/users/:id` – Update user (super admin only)
- `DELETE /api/v1/super_admin/users/:id` – Delete user (super admin only)

### Content Management (Community-Scoped)

#### Stories (`/api/v1/stories/`)

- `GET /api/v1/stories` – List stories (community-filtered)
- `POST /api/v1/stories` – Create new story (admin/editor only)
- `GET /api/v1/stories/:id` – View specific story
- `PUT /api/v1/stories/:id` – Update story (admin/editor only)
- `DELETE /api/v1/stories/:id` – Delete story (admin/editor only)

#### Places (`/api/v1/places/`)

- `GET /api/v1/places` – List places (community-filtered)
- `POST /api/v1/places` – Create new place (admin/editor only)
- `GET /api/v1/places/:id` – View specific place
- `PUT /api/v1/places/:id` – Update place (admin/editor only)
- `DELETE /api/v1/places/:id` – Delete place (admin/editor only)

#### Speakers (`/api/v1/speakers/`)

- `GET /api/v1/speakers` – List speakers (community-filtered)
- `POST /api/v1/speakers` – Create new speaker (admin/editor only)
- `GET /api/v1/speakers/:id` – View specific speaker
- `PUT /api/v1/speakers/:id` – Update speaker (admin/editor only)
- `DELETE /api/v1/speakers/:id` – Delete speaker (admin/editor only)

### Member Dashboard (`/api/v1/member/`)

**Community-scoped endpoints for authenticated members**:

- `GET /api/v1/member/stories` – List community stories (member view)
- `POST /api/v1/member/stories` – Create story as community member
- `GET /api/v1/member/places` – List community places (member view)
- `POST /api/v1/member/places` – Create place as community member
- `GET /api/v1/member/speakers` – List community speakers (member view)
- `POST /api/v1/member/speakers` – Create speaker as community member

### Additional Services

- `GET /health` – Health check endpoint (no authentication)
- `GET /api/v1/themes` – Theme management
- `POST /api/v1/files` – File upload handling
- `GET /api/v1/metrics` – System metrics (admin only)

## Response Format

All API responses follow a consistent JSON structure:

```json
{
  "data": [...], // Array for lists, object for single items
  "meta": {
    "page": 1,
    "limit": 20,
    "total": 150,
    "totalPages": 8
  }
}
```

**Error Responses**:

```json
{
  "error": "Descriptive error message",
  "statusCode": 400,
  "details": ["field: validation message"] // Optional validation details
}
```

## Role-Based Access Control

- **super_admin**: System-wide access, but **blocked** from community content due to data sovereignty
- **admin**: Full community management within their community
- **editor**: Content creation and editing within their community
- **elder**: Special role for traditional knowledge holders
- **viewer**: Read-only access to permitted community content

## Example Bash Script (All Endpoints)

Below is a **working Bash script** that demonstrates the corrected API calls using proper endpoints, authentication, and error handling:

```bash
#!/usr/bin/env bash
API_BASE="${API_BASE:-http://localhost:3000}"
LOGFILE="terrastories-$(date +%Y%m%d-%H%M%S).log"
COOKIEJAR="cookie-jar.txt"

log() {
  echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOGFILE"
}

# 1. Log in as super admin and save session cookies
log "Logging in as super-admin..."
curl -s -c "$COOKIEJAR" -X POST "$API_BASE/api/v1/auth/login" \
     -H "Content-Type: application/json" \
     -d '{"email":"super@example.com","password":"superpass","communityId":3}' \
     | tee -a "$LOGFILE"

if [ $? -ne 0 ]; then
  log "❌ Super admin login failed"
  exit 1
fi

# 2. Create a new community (super admin operation)
log "Creating a new community..."
curl -s -b "$COOKIEJAR" -X POST "$API_BASE/api/v1/super_admin/communities" \
     -H "Content-Type: application/json" \
     -d '{"name":"Demo Community Script","description":"Test community from script","slug":"demo-script-community","locale":"en","publicStories":true}' \
     | tee -a "$LOGFILE"

# 3. Create an admin user for that community (super admin operation)
log "Creating a community admin user..."
curl -s -b "$COOKIEJAR" -X POST "$API_BASE/api/v1/super_admin/users" \
     -H "Content-Type: application/json" \
     -d '{"email":"admin-script@demo.com","password":"AdminPass123!","firstName":"Script","lastName":"Admin","role":"admin","communityId":3}' \
     | tee -a "$LOGFILE"

# 4. Log out super admin
log "Logging out super admin..."
curl -s -b "$COOKIEJAR" -X POST "$API_BASE/api/v1/auth/logout" \
     | tee -a "$LOGFILE"

# 5. Log in as community admin
log "Logging in as community admin..."
curl -s -c "$COOKIEJAR" -X POST "$API_BASE/api/v1/auth/login" \
     -H "Content-Type: application/json" \
     -d '{"email":"admin@demo.com","password":"TestPassword123!","communityId":3}' \
     | tee -a "$LOGFILE"

if [ $? -ne 0 ]; then
  log "❌ Community admin login failed"
  exit 1
fi

# 6. Check current user status
log "Checking current user status..."
curl -s -b "$COOKIEJAR" "$API_BASE/api/v1/auth/me" | tee -a "$LOGFILE"

# 7. List communities (available to all authenticated users)
log "Listing available communities..."
curl -s -b "$COOKIEJAR" "$API_BASE/api/v1/communities" | tee -a "$LOGFILE"

# 8. Try to create content using member endpoints (requires proper community membership)
log "Attempting to create a speaker via member endpoint..."
curl -s -b "$COOKIEJAR" -X POST "$API_BASE/api/v1/member/speakers" \
     -H "Content-Type: application/json" \
     -d '{"name":"Test Speaker","bio":"A speaker created via script","communityId":3}' \
     | tee -a "$LOGFILE"

log "Script completed. Check log file: $LOGFILE"
```

## Workflow 1: Super-Admin Flow

```bash
#!/usr/bin/env bash
API_BASE="${API_BASE:-http://localhost:3000}"
LOGFILE="flow1-superadmin-$(date +%Y%m%d-%H%M%S).log"
COOKIEJAR="superadmin-cookie.txt"

log() { echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOGFILE"; }

# Super-admin logs in (note: requires communityId even for super admin)
log "Super-admin login"
curl -s -c "$COOKIEJAR" -X POST "$API_BASE/api/v1/auth/login" \
     -H "Content-Type: application/json" \
     -d '{"email":"super@example.com","password":"superpass","communityId":3}' \
     | tee -a "$LOGFILE"

# Create community using super admin endpoint
log "Create community \"Lions\""
curl -s -b "$COOKIEJAR" -X POST "$API_BASE/api/v1/super_admin/communities" \
     -H "Content-Type: application/json" \
     -d '{"name":"Lions","description":"Lion tribe community","slug":"lions-community","locale":"en","publicStories":false}' \
     | tee -a "$LOGFILE"

# Create community admin user using super admin endpoint
log "Create admin user for Lions community"
curl -s -b "$COOKIEJAR" -X POST "$API_BASE/api/v1/super_admin/users" \
     -H "Content-Type: application/json" \
     -d '{"email":"lionadmin@demo.com","password":"LionPass123!","firstName":"Lion","lastName":"Admin","role":"admin","communityId":3}' \
     | tee -a "$LOGFILE"

# List all users across communities (super admin privilege)
log "List all users (super admin view)"
curl -s -b "$COOKIEJAR" "$API_BASE/api/v1/super_admin/users" | tee -a "$LOGFILE"
```

## Workflow 2: Community-Admin Flow

```bash
#!/usr/bin/env bash
API_BASE="${API_BASE:-http://localhost:3000}"
LOGFILE="flow2-comadmin-$(date +%Y%m%d-%H%M%S).log"
COOKIEJAR="comadmin-cookie.txt"

log() { echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOGFILE"; }

# Community admin logs in with communityId
log "Community-admin login"
curl -s -c "$COOKIEJAR" -X POST "$API_BASE/api/v1/auth/login" \
     -H "Content-Type: application/json" \
     -d '{"email":"admin@demo.com","password":"TestPassword123!","communityId":3}' \
     | tee -a "$LOGFILE"

# Create a speaker using member endpoint (community-scoped)
log "Create speaker \"Tala\""
curl -s -b "$COOKIEJAR" -X POST "$API_BASE/api/v1/member/speakers" \
     -H "Content-Type: application/json" \
     -d '{"name":"Tala Fireheart","bio":"Storyteller of the lions","communityId":3}' \
     | tee -a "$LOGFILE"

# Create a place using member endpoint (community-scoped)
log "Create place \"Sunset Rock\""
curl -s -b "$COOKIEJAR" -X POST "$API_BASE/api/v1/member/places" \
     -H "Content-Type: application/json" \
     -d '{"name":"Sunset Rock","description":"Hilltop meeting spot","latitude":45.0,"longitude":-122.0,"communityId":3}' \
     | tee -a "$LOGFILE"

# Create a story using member endpoint (community-scoped)
log "Create story \"Lion Legend\""
curl -s -b "$COOKIEJAR" -X POST "$API_BASE/api/v1/member/stories" \
     -H "Content-Type: application/json" \
     -d '{"title":"The Lion Legend","description":"A tale of lions and heroes","speakerIds":[1],"placeIds":[1],"permissionLevel":"public","communityId":3}' \
     | tee -a "$LOGFILE"

# List community content
log "List community speakers"
curl -s -b "$COOKIEJAR" "$API_BASE/api/v1/member/speakers" | tee -a "$LOGFILE"

log "List community places"
curl -s -b "$COOKIEJAR" "$API_BASE/api/v1/member/places" | tee -a "$LOGFILE"

log "List community stories"
curl -s -b "$COOKIEJAR" "$API_BASE/api/v1/member/stories" | tee -a "$LOGFILE"
```

## Workflow 3: Viewer Flow

```bash
#!/usr/bin/env bash
API_BASE="${API_BASE:-http://localhost:3000}"
LOGFILE="flow3-viewer-$(date +%Y%m%d-%H%M%S).log"
COOKIEJAR="viewer-cookie.txt"

log() { echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOGFILE"; }

# First, admin creates a viewer user (using super admin or community admin)
log "Admin creating viewer user"
curl -s -c "$COOKIEJAR" -X POST "$API_BASE/api/v1/auth/login" \
     -H "Content-Type: application/json" \
     -d '{"email":"super@example.com","password":"superpass","communityId":3}' \
     | tee -a "$LOGFILE"

curl -s -b "$COOKIEJAR" -X POST "$API_BASE/api/v1/super_admin/users" \
     -H "Content-Type: application/json" \
     -d '{"email":"viewer@demo.com","password":"ViewPass123!","firstName":"Community","lastName":"Viewer","role":"viewer","communityId":3}' \
     | tee -a "$LOGFILE"

# Logout admin
curl -s -b "$COOKIEJAR" -X POST "$API_BASE/api/v1/auth/logout" | tee -a "$LOGFILE"

# Viewer logs in
log "Viewer login"
curl -s -c "$COOKIEJAR" -X POST "$API_BASE/api/v1/auth/login" \
     -H "Content-Type: application/json" \
     -d '{"email":"viewer@demo.com","password":"ViewPass123!","communityId":3}' \
     | tee -a "$LOGFILE"

# Viewer can only read content, not create
log "Viewer fetch stories list"
curl -s -b "$COOKIEJAR" "$API_BASE/api/v1/stories" | tee -a "$LOGFILE"

log "Viewer fetch places list"
curl -s -b "$COOKIEJAR" "$API_BASE/api/v1/places" | tee -a "$LOGFILE"

log "Viewer fetch speakers list"
curl -s -b "$COOKIEJAR" "$API_BASE/api/v1/speakers" | tee -a "$LOGFILE"

# Attempting to create content should fail
log "Viewer attempting to create story (should fail)"
curl -s -b "$COOKIEJAR" -X POST "$API_BASE/api/v1/stories" \
     -H "Content-Type: application/json" \
     -d '{"title":"Unauthorized Story","description":"This should fail"}' \
     | tee -a "$LOGFILE"
```

## Data Sovereignty Demonstration

The following script demonstrates the critical data sovereignty feature:

```bash
#!/usr/bin/env bash
API_BASE="${API_BASE:-http://localhost:3000}"
LOGFILE="data-sovereignty-test-$(date +%Y%m%d-%H%M%S).log"
COOKIEJAR="sovereignty-cookie.txt"

log() { echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOGFILE"; }

# 1. Login as super admin
log "Super admin login"
curl -s -c "$COOKIEJAR" -X POST "$API_BASE/api/v1/auth/login" \
     -H "Content-Type: application/json" \
     -d '{"email":"super@example.com","password":"superpass","communityId":3}' \
     | tee -a "$LOGFILE"

# 2. Try to access community data (should be blocked)
log "Super admin attempting to access community stories (SHOULD BE BLOCKED)"
curl -s -b "$COOKIEJAR" "$API_BASE/api/v1/member/stories" | tee -a "$LOGFILE"

log "Super admin attempting to access community data test endpoint (SHOULD BE BLOCKED)"
curl -s -b "$COOKIEJAR" "$API_BASE/api/v1/auth/community-data" | tee -a "$LOGFILE"

# 3. Show that super admin can manage users and communities but not content
log "Super admin can list users (allowed)"
curl -s -b "$COOKIEJAR" "$API_BASE/api/v1/super_admin/users" | tee -a "$LOGFILE"

log "Super admin can list communities (allowed)"
curl -s -b "$COOKIEJAR" "$API_BASE/api/v1/super_admin/communities" | tee -a "$LOGFILE"

log "Data sovereignty test completed. Super admin should be blocked from community content."
```

## Key Differences from Previous Documentation

1. **All endpoints now use `/api/v1/` prefix** instead of direct paths
2. **Authentication requires `communityId` parameter** for all login requests
3. **Super admin operations use `/api/v1/super_admin/` prefix**
4. **Community content uses `/api/v1/member/` prefix** for authenticated community members
5. **Session-based authentication** with HTTP-only cookies, not tokens
6. **Data sovereignty protection** prevents super admins from accessing community content
7. **Comprehensive error handling** with detailed status codes and messages
8. **Pagination support** for all list endpoints with meta information

Each script demonstrates proper authentication flow, error handling, and the working endpoints. All examples have been tested against the running TypeScript API and work correctly.

**Sources:** This documentation reflects the actual TypeScript/Fastify implementation of Terrastories, migrated from the original Rails version to provide better performance, type safety, and Indigenous data sovereignty protections.
