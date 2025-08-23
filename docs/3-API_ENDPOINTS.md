# **3. API Endpoints**

The API is divided into three main namespaces, based on access level.

## **3.1. Public API (/api)**

This is a **read-only JSON API** that does not require authentication. All resources are nested under a community.

- GET /api/communities - Lists all communities.
- GET /api/communities/:id - Shows a single community.
- GET /api/communities/:community_id/stories - Lists all public stories for a community.
- GET /api/communities/:community_id/stories/:id - Shows a single public story.
- GET /api/communities/:community_id/places/:id - Shows a single place.

## **3.2. Member Dashboard API (/member)**

These endpoints require authentication and are for community members to manage content. They provide full CRUD functionality.

- **Stories**:
  - GET /member/stories
  - POST /member/stories
  - GET /member/stories/:id
  - PUT/PATCH /member/stories/:id
  - DELETE /member/stories/:id
- **Places**:
  - GET /member/places
  - POST /member/places
  - PUT/PATCH /member/places/:id
  - DELETE /member/places/:id
- **Speakers**:
  - GET /member/speakers - List all speakers in community (with pagination)
  - GET /member/speakers/:id - Get a single speaker
  - POST /member/speakers - Create a new speaker
  - PUT /member/speakers/:id - Update an existing speaker
  - DELETE /member/speakers/:id - Delete a speaker
  - GET /member/speakers/search - Search speakers by name
  - GET /member/speakers/stats - Get community speaker statistics

### **3.2.1. Speakers API Detailed Reference**

#### **POST /api/v1/speakers** - Create Speaker

Creates a new speaker with Indigenous cultural protocol considerations.

**Authentication:** Required (Admin or Editor role)
**Cultural Protocol:** Elder creation requires admin permissions

**Request Body:**

```json
{
  "name": "string (required, 1-200 chars)",
  "bio": "string (optional, max 2000 chars)",
  "photoUrl": "string (optional, valid URL)",
  "birthYear": "number (optional, 1900-current year)",
  "elderStatus": "boolean (optional, default: false)",
  "culturalRole": "string (optional, max 100 chars)",
  "isActive": "boolean (optional, default: true)"
}
```

**Response (201 Created):**

```json
{
  "data": {
    "id": 1,
    "name": "Maria Santos",
    "bio": "Community elder and storyteller",
    "photoUrl": "https://example.com/photo.jpg",
    "birthYear": 1950,
    "elderStatus": true,
    "culturalRole": "Traditional Knowledge Keeper",
    "isActive": true,
    "communityId": 1,
    "createdAt": "2024-01-15T10:30:00Z",
    "updatedAt": "2024-01-15T10:30:00Z"
  },
  "meta": {
    "auditLog": "Elder speaker created with cultural protocol compliance"
  }
}
```

#### **GET /api/v1/speakers** - List Speakers

Lists speakers with pagination, filtering, and community isolation.

**Authentication:** Required
**Query Parameters:**

- `page` (number, default: 1) - Page number
- `limit` (number, 1-100, default: 20) - Items per page
- `elderStatus` (boolean, optional) - Filter by elder status
- `culturalRole` (string, optional) - Filter by cultural role
- `isActive` (boolean, optional) - Filter by active status (admin only sees inactive)
- `sort` (string, optional: 'name' | 'created_at' | 'birth_year')

**Response (200 OK):**

```json
{
  "data": [
    {
      "id": 1,
      "name": "Maria Santos",
      "elderStatus": true,
      "culturalRole": "Traditional Knowledge Keeper",
      "isActive": true,
      "communityId": 1
    }
  ],
  "meta": {
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 45,
      "pages": 3
    }
  }
}
```

#### **GET /api/v1/speakers/:id** - Get Single Speaker

Retrieves a specific speaker with community isolation enforcement.

**Authentication:** Required
**Cultural Protocol:** Community data sovereignty enforced

**Response (200 OK):**

```json
{
  "data": {
    "id": 1,
    "name": "Maria Santos",
    "bio": "Community elder and storyteller with 40 years of traditional knowledge",
    "photoUrl": "https://example.com/photo.jpg",
    "birthYear": 1950,
    "elderStatus": true,
    "culturalRole": "Traditional Knowledge Keeper",
    "isActive": true,
    "communityId": 1,
    "createdAt": "2024-01-15T10:30:00Z",
    "updatedAt": "2024-01-15T10:30:00Z"
  }
}
```

#### **PUT /api/v1/speakers/:id** - Update Speaker

Updates speaker information with cultural protocol validation.

**Authentication:** Required (Admin or Editor role)
**Cultural Protocol:** Elder status changes require admin permissions

**Request Body:** Same as CREATE, all fields optional

**Response (200 OK):** Same structure as GET single speaker

#### **DELETE /api/v1/speakers/:id** - Delete Speaker

Soft deletes a speaker with enhanced cultural protocols for elders.

**Authentication:** Required (Admin role)
**Cultural Protocol:** Elder deletion requires additional validation

**Response (200 OK):**

```json
{
  "data": {
    "message": "Speaker deleted successfully",
    "id": 1
  },
  "meta": {
    "auditLog": "Speaker deletion completed with cultural protocol compliance"
  }
}
```

#### **GET /api/v1/speakers/search** - Search Speakers

Case-insensitive search across speaker names with community isolation.

**Authentication:** Required
**Query Parameters:**

- `q` (string, required, min 2 chars) - Search query
- `page` (number, default: 1) - Page number
- `limit` (number, 1-100, default: 20) - Items per page

**Response (200 OK):** Same structure as list speakers

#### **GET /api/v1/speakers/stats** - Community Statistics

Provides community speaker statistics for dashboards and reporting.

**Authentication:** Required

**Response (200 OK):**

```json
{
  "data": {
    "total": 45,
    "active": 42,
    "inactive": 3,
    "elders": 12,
    "byRole": {
      "Traditional Knowledge Keeper": 8,
      "Storyteller": 15,
      "Community Leader": 5
    }
  }
}
```

#### **Error Responses**

All endpoints return consistent error formats:

**400 Bad Request:**

```json
{
  "error": {
    "type": "ValidationError",
    "message": "Search query must be at least 2 characters long",
    "details": {
      "field": "query",
      "received": "a",
      "expected": "min 2 characters"
    }
  }
}
```

**403 Forbidden:**

```json
{
  "error": {
    "type": "CulturalProtocolViolationError",
    "message": "Elder creation requires admin permissions for cultural protocol compliance"
  }
}
```

**404 Not Found:**

```json
{
  "error": {
    "type": "SpeakerNotFoundError",
    "message": "Speaker with ID 123 not found"
  }
}
```

## **3.3. Super Admin API (/super_admin)**

These endpoints are for super administrators to manage communities and users across the entire application.

- **Communities**:
  - GET /super_admin/communities
  - POST /super_admin/communities
  - PUT/PATCH /super_admin/communities/:id
- **Users**:
  - GET /super_admin/users
  - POST /super_admin/users
  - PUT/PATCH /super_admin/users/:id
- **Themes**:
  - GET /super_admin/themes
  - POST /super_admin/themes
