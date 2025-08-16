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
  - GET /member/speakers
  - POST /member/speakers
  - PUT/PATCH /member/speakers/:id
  - DELETE /member/speakers/:id

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
