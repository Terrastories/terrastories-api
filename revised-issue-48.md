## 📋 Overview

Implement the complete suite of authenticated CRUD endpoints under the `/member` namespace for community members to manage their stories, places, and speakers. This follows completion of public read-only API endpoints (Issue #46) and represents the next phase in the TypeScript API migration.

Context: Phase 5, Issue #22 from `docs/ISSUES_ROADMAP.md` — implement authenticated member dashboard endpoints enabling community members to manage their content via protected API routes.

## 🎯 Acceptance Criteria

### Core CRUD Endpoints

- [ ] Stories: `GET/POST/GET/:id/PUT/:id/DELETE/:id` at `/api/v1/member/stories` with pagination and community scoping
- [ ] Places: `GET/POST/GET/:id/PUT/:id/DELETE/:id` at `/api/v1/member/places` with pagination and community scoping
- [ ] Speakers: `GET/POST/GET/:id/PUT/:id/DELETE/:id` at `/api/v1/member/speakers` with pagination and community scoping

### Security and Authorization

- [ ] Authentication: All routes protected by session-based auth (cookie sessions), not JWT
- [ ] RBAC: Enforce role-based permissions (viewer/editor/admin/elder) per permission matrix
- [ ] Ownership: Update/delete require ownership or elevated role as specified
- [ ] Community Isolation: All operations scoped to the user’s community
- [ ] Cultural Protocols: Preserve elder/restricted handling at service layer
- [ ] Rate Limiting: Apply reasonable rate-limits to `/api/v1/member/*` routes

### API Standards

- [ ] Response Envelope: `{ data, meta? }` (no internal fields in public responses)
- [ ] DTOs: Use explicit DTOs for outbound payloads to avoid leaking internals
- [ ] Validation: Zod schemas for params, query, and bodies with clear errors
- [ ] Errors: Consistent statuses (400/401/403/404/409/500) and error shape `{ error: { code, message, details? } }`
- [ ] Docs: Add/update OpenAPI for all endpoints with examples

### Testing and Quality

- [ ] Integration tests covering authentication, authorization, community isolation, cultural restrictions
- [ ] Coverage ≥ 80% (aligned with Vitest config thresholds)
- [ ] Negative tests for cross-community access and unauthorized modifications
- [ ] Performance sanity (pagination paths) and error-path tests

## 🔗 Context & Dependencies

- Roadmap Phase: Phase 5 — API Endpoint Implementation
- Depends on: Issue #46 (Public API) — completed
- Blocks: Issue #23 (Super Admin endpoints)
- Related Docs: `docs/3-API_ENDPOINTS.md`, `docs/authentication-enhancement.md`, `docs/examples/service-example.ts`

## 📊 Technical Plan

### Route Organization

Option B (recommended):

```
src/routes/member/
├─ stories.ts
├─ places.ts
└─ speakers.ts
```

Mounted under `/api/v1/member` in `src/routes/index.ts` after auth/health/public routes.

### Authentication & Authorization Flow

1. Session auth middleware validates cookie session and loads user context
2. Resolve user’s `communityId` and `role`
3. Enforce RBAC per operation (editor+/admin as needed)
4. Ownership checks for updates/deletes
5. Scope queries to `communityId`
6. Enforce cultural protocols at service layer; audit as applicable
7. Apply rate limiting to `/api/v1/member/*`

### Service Layer Integration

- Reuse `StoryService`, `PlaceService`, `SpeakerService` with community filtering
- Add/update service methods for ownership checks where needed
- Keep DTO mapping at route boundary for response safety

### Response Format & DTOs

- Map service results to DTOs that exclude internal fields (IDs of authors, internal flags, etc.)
- Maintain consistent envelope and pagination meta: `{ page, limit, total, totalPages, hasNextPage, hasPrevPage }`

### Endpoints (Spec Summary)

- Stories
  - `GET /api/v1/member/stories` — paginated list (query: `page`, `limit`, optional filters)
  - `POST /api/v1/member/stories` — editor+; Zod-validated body; returns created item
  - `GET /api/v1/member/stories/:id` — community+ownership validation
  - `PUT /api/v1/member/stories/:id` — editor+; ownership/admin
  - `DELETE /api/v1/member/stories/:id` — admin or owner per matrix
- Places — mirror CRUD semantics; ensure geo validation remains in place
- Speakers — mirror CRUD semantics; preserve elder status rules

### Permission Matrix (Summary)

| Operation               | Viewer | Editor        | Admin          | Elder                           |
| ----------------------- | ------ | ------------- | -------------- | ------------------------------- |
| List/Detail (community) | ✅     | ✅            | ✅             | ✅ (+ restricted where allowed) |
| Create                  | ❌     | ✅            | ✅             | ✅                              |
| Update (own)            | ❌     | ✅            | ✅             | ✅                              |
| Update (others)         | ❌     | ❌            | ✅ (community) | ✅ (cultural scope)             |
| Delete (own)            | ❌     | ❌ (escalate) | ✅             | ✅                              |
| Delete (others)         | ❌     | ❌            | ✅ (community) | ✅ (cultural authority)         |

### Error Handling

- 401: missing/invalid session
- 403: insufficient role or not owner
- 404: resource not in user’s community
- 400: validation failures
- 409: uniqueness/conflict
- 500: unhandled

## ✅ Definition of Done

Functional

- [ ] All member endpoints implemented and passing integration tests
- [ ] RBAC, ownership, community isolation, and cultural protocols enforced

Quality

- [ ] Coverage ≥ 80%, lint and type-check clean, build succeeds
- [ ] OpenAPI updated with accurate examples

Integration

- [ ] Registered in `src/routes/index.ts` with `/api/v1/member` prefix
- [ ] Rate limiting applied to `/api/v1/member/*`
- [ ] Scripts/workflows updated if needed

## ⏱️ Estimation

- Complexity: Medium
- Story points: 8
- Duration: 3–4 days including tests and docs
