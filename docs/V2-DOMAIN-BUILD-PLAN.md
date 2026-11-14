# Terrastories API V2 — Domain Build Plan

**Status:** Execution plan for building [`docs/V2-ROUTE-REGISTRY.md`](V2-ROUTE-REGISTRY.md) on Hono (#134, #145, #146)  
**Date:** 2026-11-14  
**Authority:** Subordinate to [`docs/SPEC-V2.md`](SPEC-V2.md) and [`docs/V2-ROUTE-REGISTRY.md`](V2-ROUTE-REGISTRY.md).

## Ground rules for every slice

- **Equal dual-backend + Workers proof:** Every slice with schema or repository changes ships paired Drizzle definitions and migrations for SQLite/D1 and PostgreSQL (millisecond timestamps per §8; composite `(community_id, id)` tenant FKs per §6.3/#186) and passes `npm run test:db:sqlite` and `npm run test:db:postgres`.
- **Bounded review size:** Keep each PR under ~800 changed lines (excluding generated Drizzle snapshots if unavoidable, or split schema migrations from routes as structured below).
- **100% route coverage via Persona QA:** Every newly registered concrete Hono route must be reached with positive and negative assertions in [`scripts/qa/hono-fixture.ts`](../scripts/qa/hono-fixture.ts) (`routeTableOf(app)` fails closed on unreached endpoints across `qa:personas:sqlite`, `qa:personas:postgres`, and `qa:personas:workers`).
- **D1 / Workers Free constraints:** No Node-only imports on request paths; writes spanning multiple rows use a single bounded `db.batch()` on D1 (≤1,000 statements, ≤100 bound params/stmt, ≤100 KB/stmt); no interactive transactions assumed portable (§5, §8).
- **Content-free logging:** Maintain zero cultural strings (`HONO_PERSONA_CULTURAL_STRINGS`) or secrets in `console` / stdout / stderr / error envelopes (§7).

## Ordered build slices

| Slice  | Title                                                                             | Dependencies                        | SPEC §13 / §4 alignment                          |
| ------ | --------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------ |
| **0**  | Thin Hono foundation + Explore read adapter + QA gate                             | On `main` (merged)                  | §13 steps 2–3                                    |
| **1**  | Core domain schema normalization & text/HTML helpers                              | Slice 0                             | §13 step 4 (#189)                                |
| **2**  | Canonical `File`, `Attachment`, and `ExternalMediaLink` schema                    | Slice 1                             | §13 step 4 (#140)                                |
| **3**  | `User` normalization, `AuditEntry` schema, & session-context update               | Slice 0                             | §13 steps 4–5 (#137, #187)                       |
| **4**  | Public community & map-config reads                                               | Slice 1                             | §13 step 5; §4 Public discovery                  |
| **5**  | Public story, place, speaker & public media reads                                 | Slices 2, 4                         | §13 step 5; §4 Public discovery & Browse         |
| **6**  | Authenticated community reads (community, stories, places, speakers)              | Slices 3, 5                         | §13 step 5; §4 Private community & roles         |
| **7**  | Community settings, map config, Place & Speaker CRUD                              | Slices 3, 6                         | §13 step 5; §4 Browse and manage                 |
| **8**  | Story CRUD & relational edges (`StoryPlace`, `StorySpeaker`, `ExternalMediaLink`) | Slice 7                             | §13 step 5; §4 Browse and manage                 |
| **9**  | Media upload, metadata, deletion, & `Attachment` management                       | Slices 2, 3, 8                      | §13 step 5; §4 Media and branding (#140)         |
| **10** | Client-stretching auth, prelogin, `AuthThrottle`, & device sessions               | Slice 3                             | §13 step 5; §4 Accounts and setup (#137, #138)   |
| **11** | User management, recovery codes, `LoginCode`, bootstrap & `ClaimToken`            | Slice 10                            | §13 step 5; §4 Accounts & Field kit (#137, #188) |
| **12** | Bounded CSV import (`ImportManifest` preview / one-shot commit / discard)         | Slices 8, 9                         | §13 step 5; §4 Import (#123, #197)               |
| **13** | Community export, withdrawal, erasure, steward process & audit read               | Slices 9, 11, 12                    | §13 step 5; §4 Export and erasure (#187)         |
| **14** | System administration (`/v2/admin/*`)                                             | Slices 11, 13                       | §13 step 5; §4 Accounts & isolation              |
| **15** | Remove transitional Explore read adapter                                          | Slices 4–14 + #147 frontend cutover | §13 steps 8–9 (#185, #198)                       |

---

### Slice 1 — Core domain schema normalization & text/HTML helpers

- **Scope:** Align core content schemas (`communities`, `community_map_configs`, `stories`, `places`, `speakers`, `story_places`, `story_speakers`) with the Rails-parity launch model (§6/#189) without altering existing `/v2/*` or `/explore/*` runtime behavior. Add shared pure TypeScript helpers for §6.9 HTML allowlist sanitisation (20,000-char cap, `http:`/`https:`/`mailto:` URL parsing, `rel="noopener noreferrer nofollow"`, plain-text projection) and §6.3 Unicode NFC + final-sigma normalization (`topicNormalized`, community search).
- **Schema changes (SQLite/D1 + PostgreSQL):**
  - `communities`: add canonical `visibility` (`public | private`, backfilled from `public_stories`), `status` (`active | disabled`, backfilled from `is_active`), and `description_plain` (nullable plain-text projection per §6.9); retain legacy `public_stories`/`is_active`/`cultural_settings`/`beta` in expand-contract until post-cutover cleanup in Slice 15.
  - `community_map_configs`: new 1-to-1 table (`communityId` PK/FK, provider-neutral bounds/style/projection fields, `staticMapFileId`, ms timestamps; `doublePrecision` on PG / `real` on SQLite for coordinates, matching `places` per §5/§8 portability).
  - `stories`: make `created_by` nullable (§6.3) while preserving non-null `createdBy` validation in frozen V1 Zod schemas ([`stories.ts`](../src/db/schema/stories.ts)) during coexistence; add `topic`, `topic_normalized`, `description_plain`, canonical `visibility` (`public | community | editors` backfilled from `privacy_level`); retain legacy V1 columns (`slug`, `privacy_level`, `is_restricted`, `media_urls`, `image_url`, `audio_url`, `tags`) in expand-contract until post-cutover cleanup in Slice 15.
  - `places`: make `latitude` and `longitude` nullable (§6.4) while preserving non-null `latitude`/`longitude` validation in frozen V1 Zod schemas ([`places.ts`](../src/db/schema/places.ts)) during coexistence; add `type_of_place`, `description_plain`; retain legacy V1 columns (`media_urls`, `photo_url`, `cultural_significance`, `is_restricted`) in expand-contract until Slice 15.
  - `speakers`: add `birth_date`, `birthplace_id` (nullable + composite `(community_id, birthplace_id)` FK to `places(community_id, id)`), `affiliation`; retain legacy V1 columns (`bio`, `photo_url`, `bio_audio_url`, `birth_year`, `elder_status`, `cultural_role`, `is_active`) in expand-contract until Slice 15.
  - `story_places` and `story_speakers`: drop `story_place_unique` and `story_speaker_unique` because §6.3 requires edge multiplicity at launch (and Slice 8 exercises multiplicity prior to Slice 15); in this same slice, replace `.onConflictDoNothing()` in frozen V1 [`PlaceRepository.addStoryPlaceAssociation()`](../src/repositories/place.repository.ts) with an explicit existence guard and update the uniqueness regression gates ([`relationships-integration.test.ts`](../tests/db/relationships-integration.test.ts), [`test-postgres-migration-regressions.ts`](../scripts/test-postgres-migration-regressions.ts)) so V1 deduplication and DB gates remain green.
- **Routes:** None (schema + shared helpers only; V1 `PlaceRepository.addStoryPlaceAssociation()` updated with an explicit existence guard for coexistence).
- **Persona QA (`scripts/qa/hono-fixture.ts`):** Existing 13-route journeys stay green across SQLite, Node HTTP, PostgreSQL 13, and Workers D1; unit/DB tests verify sanitiser allowlist, plain-text projection, Unicode normalization, composite FK rejection for `Speaker.birthplaceId`, preserved non-null V1 Zod validation on `stories.createdBy` and `places.latitude`/`longitude`, idempotent V1 `PlaceRepository.addStoryPlaceAssociation()`, and duplicate-edge multiplicity on `story_places`/`story_speakers`.
- **Dependencies:** Slice 0 (`main`).

### Slice 2 — Canonical `File`, `Attachment`, and `ExternalMediaLink` schema

- **Scope:** Introduce canonical §6.7 media schema via expand-contract migration on existing V1 tables and backfill existing `community_media` rows so Slice 5+ and Slice 9 share one schema without breaking `on main` `/v2/media/:id`, `/explore/media/:fileId`, or frozen `/api/v1` coexistence (§8, `PHASE-1-PLAN.md`).
- **Schema changes (SQLite/D1 + PostgreSQL):**
  - `files`: allow nullable `community_id` (solely for `super_admin` profile photo) and nullable `uploaded_by` while preserving non-null `communityId`/`uploadedBy` validation in frozen V1 Zod schemas ([`files.ts`](../src/db/schema/files.ts)) during coexistence; add nullable/backfilled canonical columns (`storage_key` backfilled from `path`, `checksum` nullable during coexistence, `byte_size` backfilled from `size`); retain legacy V1 columns (`filename`, `original_name`, `path`, `url`, `size`, `cultural_restrictions`, `is_active`) and `UNIQUE(community_id, id)` in expand-contract until Slice 15 so frozen V1 repository writes ([`db-repository-contract.ts`](../scripts/db-repository-contract.ts)) remain intact; ms timestamps.
  - `attachments`: expand-contract migration of the existing legacy V1 `attachments` table (`attachable_id`, `attachable_type`, `url`, `filename`, `content_type`, `file_size`, `created_at`): add canonical columns (`community_id` nullable, `file_id` FK `-> files(id) ON DELETE CASCADE` for `MATCH SIMPLE` null-community protection + composite `(community_id, file_id) -> files(community_id, id) ON DELETE CASCADE`, `owner_type`, `owner_id`, `role`, `ordinal`), make legacy V1 columns nullable so frozen `/api/v1` coexistence remains intact, backfill `community_media` branding rows into canonical `attachments` rows, and defer dropping legacy V1 columns to Slice 15 post-cutover cleanup.
  - `external_media_links`: new table (`id`, `community_id`, `story_id`, `url`, `ordinal`, `created_at` ms) with composite `(community_id, story_id) -> stories(community_id, id) ON DELETE CASCADE`.
  - `community_map_configs`: add composite `(community_id, static_map_file_id) -> files(community_id, id)` FK.
- **Routes:** None (existing `/v2/media/:id` and `/explore/media/:fileId` read compatibly).
- **Persona QA (`scripts/qa/hono-fixture.ts`):** Existing journeys stay green; DB constraint tests prove cross-tenant attachment FK rejection, null-community `super_admin` `fileId` FK cascade, and V1 `attachments` coexistence.
- **Dependencies:** Slice 1.

### Slice 3 — `User` normalization, `AuditEntry` schema, & session-context update

- **Scope:** Expand-contract `users` toward §6.2 (add `member` to the physical `users.role` enum while retaining `elder` for frozen `/api/v1` coexistence until Slice 15 and enforcing the canonical 5-role V2 enum — rejecting `elder` fail-closed — at the V2 boundary; nullable `community_id` for `super_admin`; nullable/backfilled normalized identity and verifier columns), add `audit_entries` (§6.8) ahead of mutating/file-authz slices (§7), and update `HonoFoundationRepository.candidates()`, `createSession()`, and `session()` (`FoundationUser.communityId: number | null`), session middleware, and `GET /v2/auth/me` so null-community `super_admin` and disabled-community `own-admin` authenticate, establish sessions, and read `GET /v2/auth/me` while disabled-community `viewer`/`member`/`editor` still fail `401` and non-sovereignty community content routes still deny both (`403`/`404`).
- **Schema changes (SQLite/D1 + PostgreSQL):**
  - `users`: expand-contract migration keeping legacy V1 columns (`email`, `password_hash`, `first_name`, `last_name`, `is_active`, reset/sign-in columns), `users_email_community_unique` ([`test-postgres-migration-regressions.ts`](../scripts/test-postgres-migration-regressions.ts)), and frozen V1 non-null Zod validation ([`users.ts`](../src/db/schema/users.ts)) intact until Slice 15: add `member` to the physical `users.role` enum (`viewer | member | editor | elder | admin | super_admin`, retaining `elder` in the physical/V1 schema until Slice 15 while the V2 boundary enforces the canonical 5-role enum and rejects `elder` fail-closed); make `community_id` nullable for `super_admin`; add nullable `username` + global unique `username_normalized`, nullable/backfilled `email_normalized` (backfilled from `email`) + community-scoped unique `(community_id, email_normalized)` + partial unique `email_normalized WHERE community_id IS NULL`, nullable/backfilled `display_name` (backfilled from `first_name` + `last_name`), nullable `password_verifier`, `password_algorithm`, `password_salt`, `password_params`, and `status` (`active | disabled`, backfilled from `is_active`); update session-revocation DB triggers to fire on `password_verifier`/`role`/`community_id`/`status` alongside `password_hash`/`is_active` during transitional login coexistence.
  - `audit_entries`: new table per §6.8 (`id`, nullable `community_id`, nullable `actor_id`, `action`, `resource_type`, `resource_ids`, `outcome`, `ip_address`, `user_agent`, `created_at` ms) + 90-day IP/UA scrub helper.
- **Routes:** Updated `GET /v2/auth/me` + session middleware (`HonoFoundationRepository.candidates()`, `createSession()`, and `session()` switch from `innerJoin(communities)` + `eq(communities.isActive, true)` to `leftJoin(communities)` with explicit `communityId IS NULL` handling so null-community `super_admin` and disabled-community `own-admin` can authenticate, establish sessions, and hold valid sessions while disabled-community `viewer`/`member`/`editor` remain rejected `401`; `GET /v2/auth/me` adds `username` and `displayName`, with recovery-code confirmation flag added when `login_codes` lands in Slice 11).
- **Persona QA (`scripts/qa/hono-fixture.ts`):** Existing 13-route journeys stay green; verify `member` role row (while V2 rejects `elder`), null-community `super_admin` login + session + `GET /v2/auth/me` (and `403`/`404` on `/v2/media/:id` branding), disabled-community `own-admin` login + session + `GET /v2/auth/me` (while disabled-community `viewer` stays `401`), and `AuditEntry` content-free write tests.
- **Dependencies:** Slice 0 (parallelizable with Slices 1–2; merges before Slice 6).

### Slice 4 — Public community & map-config reads

- **Scope:** First `/v2/public/*` endpoints before `/v2/*` auth middleware in `src/hono-app.ts`: public community discovery list with §6.3 Unicode search and public community detail with credential-free `CommunityMapConfig`, public `storiesCount`, map points, and filter options derived from publicly readable stories.
- **Schema changes:** None (uses Slice 1–2 tables).
- **Routes:** `GET /v2/public/communities`, `GET /v2/public/communities/:slug`.
- **Persona QA (`scripts/qa/hono-fixture.ts`):** Add steps for anonymous, member, editor, admin, other-community, and `super_admin` hitting both routes: verify private/disabled communities are excluded/`404`, Unicode NFC+final-sigma `?search=` matches identically on SQLite/PG/D1, `CommunityMapConfig` omits credentials, `#162` restricted/unevidenced/members-only stories do not inflate `storiesCount`/points/filters, and authenticated callers get identical anonymous projections.
- **Dependencies:** Slice 1.

### Slice 5 — Public story, place, speaker & public media reads

- **Scope:** Complete `/v2/public/communities/:slug/*` read surfaces driven by `src/policy/read-rules.ts` (§6.4a `anonymous-public` column). Includes deterministic sorting (`newest`, `title` asc/desc + ID tie-break), filters (`place`, `region`, `typeOfPlace`, `topicNormalized`, `language`, `speaker`, `affiliation`), sanitised description output, and public media streaming.
- **Schema changes:** None.
- **Routes:** `GET /v2/public/communities/:slug/stories`, `GET /v2/public/communities/:slug/stories/:storyId`, `GET /v2/public/communities/:slug/places`, `GET /v2/public/communities/:slug/places/:placeId`, `GET /v2/public/communities/:slug/speakers`, `GET /v2/public/communities/:slug/speakers/:speakerId`, `GET /v2/public/communities/:slug/media/:fileId`.
- **Persona QA (`scripts/qa/hono-fixture.ts`):** Exercise all 7 routes across anonymous, own-community member/admin (confirming no privilege widening), other-community, and `super_admin`: assert `with readable stories` gating for places/speakers/place-media, `404` for story-less or unreadable-story-only places/speakers, `404` for `#162` restricted/unevidenced/members-only rows, private/disabled community `404`s, and zero cultural strings in captured logs.
- **Dependencies:** Slices 2, 4.

### Slice 6 — Authenticated community reads

- **Scope:** Community-scoped read endpoints under `/v2/*` using `actor.communityId`, enforcing active community gate, `super_admin` denial (`403`), §6.4a role differentiation (`viewer`: `public` stories; `member`: `public|community` stories; `editor`/`admin`: all readable own-community stories + story-less places/speakers), and `#162` option-A hiding of `isRestricted = true` / unknown-privacy rows for **all** roles including `editor`/`admin` (§6.4a, §12).
- **Schema changes:** None (uses Slice 1–3 tables).
- **Routes:** `GET /v2/community`, `GET /v2/community/map-config`, `GET /v2/stories`, `GET /v2/stories/:id`, `GET /v2/places`, `GET /v2/places/:id`, `GET /v2/speakers`, `GET /v2/speakers/:id`.
- **Persona QA (`scripts/qa/hono-fixture.ts`):** Add authenticated read journeys in both active public and active private communities for `viewer` vs `member` vs `editor` vs `admin`: prove private-community `viewer` reads `public` stories while `member` adds `community` stories, `viewer`/`member` get `404` on story-less or `editors`-only places/speakers while `editor`/`admin` see them, `#162` restricted/unevidenced stories, places, and speaker story-derived/`birthplace` projections return `404` and are excluded from lists/counts/points/filters across **all** roles (`own-viewer`, `own-member`, `own-editor`, and `own-admin`), cross-community IDs return `404`, disabled community (incl. disabled-community `own-admin`) returns `403`, and null-community `super_admin` gets `403`.
- **Dependencies:** Slices 3, 5.

### Slice 7 — Community settings, map config, Place & Speaker CRUD

- **Scope:** Admin settings/map-config mutations (emitting content-free `AuditEntry` rows on publication/`visibility` changes per §7) and editor/admin CRUD for places and speakers. Enforces HTML sanitisation (≤20k chars), coordinate-pair validation, `CommunityMapConfig` lat/lng bounds validation, and `Speaker.birthplaceId` composite tenant FK checks.
- **Schema changes:** None.
- **Routes:** `PATCH /v2/community`, `PUT /v2/community/map-config`, `POST /v2/places`, `PATCH /v2/places/:id`, `DELETE /v2/places/:id`, `POST /v2/speakers`, `PATCH /v2/speakers/:id`, `DELETE /v2/speakers/:id`.
- **Persona QA (`scripts/qa/hono-fixture.ts`):** Test `admin` toggling `visibility` (`public`/`private`), emitting content-free `AuditEntry`, and immediately observing `/v2/public/*` open/close; `admin` updating `CommunityMapConfig` (incl. antimeridian wrap & invalid lat reject `400`); `editor` CRUD on places/speakers (incl. nullable coords, cross-community `birthplaceId` rejection, invalid HTML `href` rejection); `viewer`/`member`/`super_admin` receiving `403`; `editor` receiving `403` on `/v2/community` and `/v2/community/map-config`.
- **Dependencies:** Slices 3, 6.

### Slice 8 — Story CRUD & relational edges

- **Scope:** Editor/admin story lifecycle plus `StoryPlace`, `StorySpeaker`, and `ExternalMediaLink` endpoints. Atomic single-batch writes on D1 / transaction on Node; maintains `topicNormalized` and `descriptionPlain`; enforces composite tenant FKs on `interviewLocationId`, `interviewerId`, and edges (with edge multiplicity preserved); validates `ExternalMediaLink` absolute `http:`/`https:` URLs and deterministic `ordinal`.
- **Schema changes:** None (`story_place_unique`/`story_speaker_unique` already dropped in Slice 1).
- **Routes:** `POST /v2/stories`, `PATCH /v2/stories/:id`, `DELETE /v2/stories/:id`, `PUT /v2/stories/:id/places`, `PUT /v2/stories/:id/speakers`, `POST /v2/stories/:id/external-links`, `PATCH /v2/stories/:id/external-links/reorder`, `DELETE /v2/stories/:id/external-links/:linkId`.
- **Persona QA (`scripts/qa/hono-fixture.ts`):** Test full story create/update/delete, `StoryPlace`/`StorySpeaker` edge attachment (incl. multiplicity) & cross-community target rejection, `ExternalMediaLink` add/reorder/delete + `javascript:` scheme rejection (`400`), `viewer`/`member`/`super_admin` `403`s, and immediate public-projection update when story visibility flips `editors -> public -> editors`.
- **Dependencies:** Slice 7.

### Slice 9 — Media upload, metadata, deletion, & `Attachment` management

- **Scope:** Expand `GET /v2/media/:id` beyond branding to all §6.4a/§6.7 attachment roles (`Range` support + `super_admin` own profile photo), and implement upload, metadata, deletion, and typed `Attachment` create/reorder/delete (#140), emitting content-free `AuditEntry` rows for file-authorization decisions (§7). Enforce MIME sniffing, extension/content check, 100 MB request cap, SHA-256 checksum, server-generated tenant-scoped (or `super_admin` isolated) `storageKey`, orphan-byte cleanup, and binding/identifying the typed `user_photo` relation for `actor.id` before/at staging on `POST /v2/media` for non-editor (`own-viewer`/`own-member`) and null-community `super_admin` uploads (§6.7).
- **Schema changes:** None (uses Slice 2–3 tables).
- **Routes:** `GET /v2/media/:id` (expanded), `GET /v2/media/:id/metadata`, `POST /v2/media`, `DELETE /v2/media/:id`, `POST /v2/attachments`, `PATCH /v2/attachments/reorder`, `DELETE /v2/attachments/:id`.
- **Persona QA (`scripts/qa/hono-fixture.ts`):** Test multipart upload + attach/reorder/detach/delete for story, place (`place_photo`, `place_name_audio`), speaker, community branding/sponsor logos, user profile photo (own + `own-admin` with `user-management` authority + `super_admin` own photo), and unattached staging isolation for `own-editor`/`own-admin`. Adversarial cases: `own-viewer`/`own-member` and `super_admin` blocked from untyped staging uploads, cross-community `fileId` attachment rejection, `super_admin` attaching community file rejection, SVG/HTML active-content sandbox headers, path-traversal filename neutralization, `Range` byte requests respecting revocation, and content-free `AuditEntry` records on file-authorization decisions.
- **Dependencies:** Slices 2, 3, 8.

### Slice 10 — Client-stretching auth, prelogin, `AuthThrottle`, & device sessions

- **Scope:** Replace transitional `POST /v2/auth/login` dev bridge with the §7 client-stretching protocol (`client-argon2id+sha256` and wrapped `client-bcrypt-rails+sha256` atomic upgrade), add `POST /v2/auth/prelogin` with deterministic HMAC fakes, username-or-email + `communitySlug` disambiguation, `AuthThrottle` durable rate limiting (≤2-row D1 batch), 60-day `device` sessions, self-service profile/password updates, full `GET /v2/auth/me` + session-middleware target behavior, and 90-day IP/UA scrub job on `audit_entries`.
- **Schema changes (SQLite/D1 + PostgreSQL):**
  - `sessions`: add `kind` (`standard | device`), `created_at`, `last_seen_at`, `idle_expires_at`, `absolute_expires_at`, `revoked_at`, `revoked_by` (ms timestamps).
  - `auth_throttle`: new table per §6.8 (`users` and `audit_entries` landed in Slice 3).
- **Routes:** `POST /v2/auth/prelogin`, upgraded `POST /v2/auth/login`, `PATCH /v2/auth/me`, `POST /v2/auth/password`. The `GET /v2/auth/me` shape and the null-community / disabled-community session context already land in Slice 3; this slice changes only how credentials are verified and stored.
- **Persona QA (`scripts/qa/hono-fixture.ts`):** Update auth journeys to client-stretched Argon2id + wrapped Rails bcrypt login with atomic upgrade; test username login, duplicate email requiring `communitySlug`, uniform 401 across unknown slug / unknown identifier / ambiguous email / wrong key / throttled attempt, prelogin fake parity, `device` 60-day session persistence, `GET /v2/auth/me` + `PATCH /v2/auth/me`, `POST /v2/auth/password` current-key verification + session revocation, and `AuditEntry` content-free check.
- **Dependencies:** Slice 3.

### Slice 11 — User management, recovery codes, `LoginCode`, bootstrap & `ClaimToken`

- **Scope:** Community-admin user lifecycle, assisted recovery (password reset + `admin_issued` `LoginCode`), 10-code `recovery` sheet generation/redemption (including migrated/code-enrolled admin first-login gate — migrated admins re-verify password via the step-up action; only fresh `admin_issued` sessions are verifier-free per §6.8; updates `GET /v2/auth/me` with recovery-code confirmation flag), device-session listing/revocation, fresh installation bootstrap, and hosted `ClaimToken` redemption.
- **Schema changes (SQLite/D1 + PostgreSQL):**
  - `login_codes` (`LoginCode`) and `claim_tokens` (`ClaimToken`) per §6.8 (ms timestamps, SHA-256 hashes, `superseded_at`, `used_at`/`consumed_at`).
- **Routes:** `GET /v2/users`, `GET /v2/users/:id`, `POST /v2/users`, `PATCH /v2/users/:id`, `POST /v2/users/:id/password-reset`, `POST /v2/users/:id/login-codes`, `GET /v2/users/:id/sessions`, `DELETE /v2/users/:id/sessions/:sessionId`, `POST /v2/auth/recovery-codes`, `POST /v2/auth/recovery/redeem`, `GET /v2/bootstrap`, `POST /v2/bootstrap`, `POST /v2/bootstrap/claim`.
- **Persona QA (`scripts/qa/hono-fixture.ts`):** Full user CRUD + collision rejection (`usernameNormalized`, same-community email, null-community email share); admin reset/code refusal on own account; recovery-code generation/regeneration requiring current-password step-up (incl. migrated-admin first login) and verifier-free only on fresh `admin_issued` session; atomic code redemption setting new verifier + revoking old sessions; disabled-community admin assisted recovery; fresh bootstrap + replay `403`/`404`; `ClaimToken` redemption + replay/expired/superseded failure; offline field-kit persona un-skipped for local login + recovery code journey.
- **Dependencies:** Slice 10.

### Slice 12 — Bounded CSV import

- **Scope:** `ImportManifest` preview, listing/detail, one-shot all-or-nothing commit, and discard (#123, §4, §6.9). Enforces explicit header/audience mapping (no silent coercion to `public`), pre-commit media staging + checksums, D1 commit-plan budget validation (≤1,000 statements, ≤100 params, ≤100 KB, ≤50,000 estimated rows written, 1/day per D1 database), atomic transaction/D1 `batch()`, committed re-call returning recorded summary without re-apply, and restart-safe orphan staging cleanup.
- **Schema changes (SQLite/D1 + PostgreSQL):**
  - `import_manifests` (`ImportManifest`, §6.9) with composite `(community_id, source_file_id)` FK to `files`.
- **Routes:** `POST /v2/imports/preview`, `GET /v2/imports`, `GET /v2/imports/:id`, `POST /v2/imports/:id/commit`, `DELETE /v2/imports/:id`.
- **Persona QA (`scripts/qa/hono-fixture.ts`):** Preview + commit stories/places/speakers with related edges and staged media; re-commit returning recorded summary idempotently; discard cleaning staged bytes; negative tests for unknown audience, missing media, cross-community reference, malformed CSV, D1 budget rejection diagnostics, and `viewer`/`member`/`super_admin` `403`.
- **Dependencies:** Slices 8, 9.

### Slice 13 — Export, withdrawal, erasure, steward process, & community audit

- **Scope:** Full §7 sovereignty contract (#187): deterministic JSON manifest + streaming media ZIP export (via R2 multipart on Workers, streaming local archive on Node), short-lived single-artifact download tokens with per-object expiry cleanup, step-up verified withdrawal/erasure/steward designation (incl. disabled-community `own-admin` fixed at disable time, fresh `admin_issued` step-up path for `own-admin`, and explicit `communitySlug`/`communityId` body locator verified against recorded steward designation for null-community `super_admin` stewards), steward notice period + admin cancellation, immediate surface/cache invalidation, <24h restart-safe live deletion + multipart abort across community prefixes, out-of-band erasure record (excluded from backups/Time Travel) + restore verification hook, and community `AuditEntry` read.
- **Schema changes (SQLite/D1 + PostgreSQL + out-of-band store):**
  - `community_stewards` and `community_sovereignty_requests` (or equivalent community sovereignty state tables) + `export_jobs`/`export_tokens` metadata; out-of-band erasure record store outside restorable DB backups.
- **Routes:** `POST /v2/community/export`, `GET /v2/community/export/download/:token`, `GET /v2/community/sovereignty`, `PUT /v2/community/steward`, `POST /v2/community/withdrawal`, `POST /v2/community/erasure`, `POST /v2/community/sovereignty/cancel`, `GET /v2/community/audit-entries`.
- **Persona QA (`scripts/qa/hono-fixture.ts`):** Export active & disabled community (incl. `#162` rows), byte-identical re-export, token expiry & object cleanup, `super_admin` `403` on export; withdrawal + immediate public/member denial while sovereignty endpoints stay up; steward designation/removal & notice-period requests (incl. null-community `super_admin` steward with explicit community locator + rejection when undesignated) + admin cancellation; erasure deleting DB rows, storage objects/versions, multipart uploads, sessions, throttles, manifests, and leaving out-of-band erasure record; community audit read without cultural content.
- **Dependencies:** Slices 9, 11, 12.

### Slice 14 — System administration (`/v2/admin/*`)

- **Scope:** `super_admin` operational lifecycle endpoints (§6.2, §6.8, §7): list operational community records, provision empty community, issue/reissue `ClaimToken` (blocked if any admin or content exists), toggle lifecycle `status` (never reading/writing descriptive fields or content), deprovision unclaimed empty community, read system-level `AuditEntry` (`communityId IS NULL`), and read out-of-band erasure records.
- **Schema changes:** None (uses Slice 3, 10–13 tables).
- **Routes:** `GET /v2/admin/communities`, `POST /v2/admin/communities`, `POST /v2/admin/communities/:id/claim-tokens`, `PATCH /v2/admin/communities/:id/status`, `DELETE /v2/admin/communities/:id`, `GET /v2/admin/audit-entries`, `GET /v2/admin/erasures`.
- **Persona QA (`scripts/qa/hono-fixture.ts`):** `super_admin` provisioning community -> issuing claim token -> admin claiming -> subsequent claim-token issuance refused (`409`/`403`) -> status toggle (`disabled` purges community sessions, `active` restores) -> deprovision unclaimed community -> system audit/erasure reads; negative tests proving community roles get `403` on `/v2/admin/*` and `super_admin` gets `403`/`404` on every community content/export endpoint.
- **Dependencies:** Slices 11, 13.

### Slice 15 — Remove transitional Explore read adapter (post-frontend cutover)

- **Scope:** Delete `src/explore-adapter.ts`, `src/services/explore-adapter.service.ts`, `src/repositories/explore-adapter.repository.ts`, `HonoFoundationRepository.connection`, `docs/EXPLORE-ADAPTER.md`, and `/explore/*` QA journeys once the V2 frontend passes all §4 launch scenarios on `/v2/public/*` + `/v2/*` (#147, #185, #198).
- **Schema changes:** Drop transitional `community_media` and legacy V1 compatibility columns (including legacy V1 `attachments`, `communities`, `users`, `stories`, `places`, `speakers` columns) via expand-contract after cutover verification.
- **Routes:** Removes all 6 `/explore/*` routes.
- **Persona QA (`scripts/qa/hono-fixture.ts`):** Remove Explore journeys; verify `routeTableOf(app)` passes with canonical V2 routes only.
- **Dependencies:** Slices 4–14, #147 frontend cutover sign-off.
