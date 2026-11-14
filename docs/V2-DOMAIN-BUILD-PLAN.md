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

| Slice  | Title                                                                             | Dependencies                           | SPEC §13 / §4 alignment                          |
| ------ | --------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------ |
| **0**  | Thin Hono foundation + Explore read adapter + QA gate                             | On `main` (merged)                     | §13 steps 2–3                                    |
| **1**  | Core domain schema normalization & text/HTML helpers                              | Slice 0                                | §13 step 4 (#189)                                |
| **2**  | Canonical `File`, `Attachment`, and `ExternalMediaLink` schema                    | Slice 1                                | §13 step 4 (#140)                                |
| **3**  | Public community & map-config reads                                               | Slice 1                                | §13 step 5; §4 Public discovery                  |
| **4**  | Public story, place, speaker & public media reads                                 | Slices 2, 3                            | §13 step 5; §4 Public discovery & Browse         |
| **5**  | Authenticated community reads (community, stories, places, speakers)              | Slice 4                                | §13 step 5; §4 Private community & roles         |
| **6**  | Community settings, map config, Place & Speaker CRUD                              | Slice 5                                | §13 step 5; §4 Browse and manage                 |
| **7**  | Story CRUD & relational edges (`StoryPlace`, `StorySpeaker`, `ExternalMediaLink`) | Slice 6                                | §13 step 5; §4 Browse and manage                 |
| **8**  | Media upload, metadata, deletion, & `Attachment` management                       | Slices 2, 7                            | §13 step 5; §4 Media and branding (#140)         |
| **9**  | Client-stretching auth, prelogin, `AuthThrottle`, `AuditEntry`, & device sessions | Slice 0 (parallelizable after Slice 2) | §13 step 5; §4 Accounts and setup (#137, #138)   |
| **10** | User management, recovery codes, `LoginCode`, bootstrap & `ClaimToken`            | Slice 9                                | §13 step 5; §4 Accounts & Field kit (#137, #188) |
| **11** | Bounded CSV import (`ImportManifest` preview / one-shot commit / discard)         | Slices 7, 8                            | §13 step 5; §4 Import (#123, #197)               |
| **12** | Community export, withdrawal, erasure, steward process & audit read               | Slices 8, 10, 11                       | §13 step 5; §4 Export and erasure (#187)         |
| **13** | System administration (`/v2/admin/*`)                                             | Slices 10, 12                          | §13 step 5; §4 Accounts & isolation              |
| **14** | Remove transitional Explore read adapter                                          | Slices 3–13 + #147 frontend cutover    | §13 steps 8–9 (#185, #198)                       |

---

### Slice 1 — Core domain schema normalization & text/HTML helpers

- **Scope:** Align core content schemas (`communities`, `community_map_configs`, `stories`, `places`, `speakers`) with the Rails-parity launch model (§6/#189) without altering existing `/v2/*` or `/explore/*` runtime behavior. Add shared pure TypeScript helpers for §6.9 HTML allowlist sanitisation (20,000-char cap, `http:`/`https:`/`mailto:` URL parsing, `rel="noopener noreferrer nofollow"`, plain-text projection) and §6.3 Unicode NFC + final-sigma normalization (`topicNormalized`, community search).
- **Schema changes (SQLite/D1 + PostgreSQL):**
  - `community_map_configs`: new 1-to-1 table (`communityId` PK/FK, provider-neutral bounds/style/projection fields, `staticMapFileId`, ms timestamps; `numeric(10,6)` on PG / `real` on SQLite for coordinates).
  - `stories`: add `topic`, `topic_normalized`, `description_plain`, canonical `visibility` (`public | community | editors` backfilled from `privacy_level`).
  - `places`: make `latitude` and `longitude` nullable (§6.4), add `type_of_place`, `description_plain`.
  - `speakers`: add `birth_date`, `birthplace_id` (nullable + composite `(community_id, birthplace_id)` FK to `places(community_id, id)`), `affiliation`.
- **Routes:** None (schema + shared helpers only).
- **Persona QA (`scripts/qa/hono-fixture.ts`):** Existing 13-route journeys stay green across SQLite, Node HTTP, PostgreSQL 13, and Workers D1; unit tests verify sanitiser allowlist, plain-text projection, Unicode normalization, and composite FK rejection for `Speaker.birthplaceId`.
- **Dependencies:** Slice 0 (`main`).

### Slice 2 — Canonical `File`, `Attachment`, and `ExternalMediaLink` schema

- **Scope:** Introduce canonical §6.7 media tables and backfill existing `community_media` rows so Slice 4+ and Slice 8 share one schema without breaking `on main` `/v2/media/:id` or `/explore/media/:fileId`.
- **Schema changes (SQLite/D1 + PostgreSQL):**
  - `files`: allow nullable `community_id` (solely for `super_admin` profile photo) and nullable `uploaded_by`, add `storage_key`, `checksum`, `byte_size`, preserve `UNIQUE(community_id, id)`, ms timestamps.
  - `attachments`: new canonical table (`id`, `community_id` nullable, `file_id` FK `-> files(id) ON DELETE CASCADE` for `MATCH SIMPLE` null-community protection + composite `(community_id, file_id) -> files(community_id, id) ON DELETE CASCADE`, `owner_type`, `owner_id`, `role`, `ordinal`, `created_at` ms). Backfill `community_media` branding rows into `attachments`.
  - `external_media_links`: new table (`id`, `community_id`, `story_id`, `url`, `ordinal`, `created_at` ms) with composite `(community_id, story_id) -> stories(community_id, id) ON DELETE CASCADE`.
  - `community_map_configs`: add composite `(community_id, static_map_file_id) -> files(community_id, id)` FK.
- **Routes:** None (existing `/v2/media/:id` and `/explore/media/:fileId` read compatibly).
- **Persona QA (`scripts/qa/hono-fixture.ts`):** Existing journeys stay green; DB constraint tests prove cross-tenant attachment FK rejection and null-community `super_admin` `fileId` FK cascade.
- **Dependencies:** Slice 1.

### Slice 3 — Public community & map-config reads

- **Scope:** First `/v2/public/*` endpoints before `/v2/*` auth middleware in `src/hono-app.ts`: public community discovery list with §6.3 Unicode search and public community detail with credential-free `CommunityMapConfig`, public `storiesCount`, map points, and filter options derived from publicly readable stories.
- **Schema changes:** None (uses Slice 1–2 tables).
- **Routes:** `GET /v2/public/communities`, `GET /v2/public/communities/:slug`.
- **Persona QA (`scripts/qa/hono-fixture.ts`):** Add steps for anonymous, member, editor, admin, other-community, and `super_admin` hitting both routes: verify private/disabled communities are excluded/`404`, Unicode NFC+final-sigma `?search=` matches identically on SQLite/PG/D1, `CommunityMapConfig` omits credentials, `#162` restricted/unevidenced/members-only stories do not inflate `storiesCount`/points/filters, and authenticated callers get identical anonymous projections.
- **Dependencies:** Slice 1.

### Slice 4 — Public story, place, speaker & public media reads

- **Scope:** Complete `/v2/public/communities/:slug/*` read surfaces driven by `src/policy/read-rules.ts` (§6.4a `anonymous-public` column). Includes deterministic sorting (`newest`, `title` asc/desc + ID tie-break), filters (`place`, `region`, `typeOfPlace`, `topicNormalized`, `language`, `speaker`, `affiliation`), sanitised description output, and public media streaming.
- **Schema changes:** None.
- **Routes:** `GET /v2/public/communities/:slug/stories`, `GET /v2/public/communities/:slug/stories/:storyId`, `GET /v2/public/communities/:slug/places`, `GET /v2/public/communities/:slug/places/:placeId`, `GET /v2/public/communities/:slug/speakers`, `GET /v2/public/communities/:slug/speakers/:speakerId`, `GET /v2/public/communities/:slug/media/:fileId`.
- **Persona QA (`scripts/qa/hono-fixture.ts`):** Exercise all 7 routes across anonymous, own-community member/admin (confirming no privilege widening), other-community, and `super_admin`: assert `with readable stories` gating for places/speakers/place-media, `404` for story-less or unreadable-story-only places/speakers, `404` for `#162` restricted/unevidenced/members-only rows, private/disabled community `404`s, and zero cultural strings in captured logs.
- **Dependencies:** Slices 2, 3.

### Slice 5 — Authenticated community reads

- **Scope:** Community-scoped read endpoints under `/v2/*` using `actor.communityId`, enforcing active community gate, `super_admin` denial (`403`), and §6.4a role differentiation (`viewer`: `public` stories; `member`: `public|community` stories; `editor`/`admin`: all own-community stories + story-less places/speakers).
- **Schema changes:** None.
- **Routes:** `GET /v2/community`, `GET /v2/community/map-config`, `GET /v2/stories`, `GET /v2/stories/:id`, `GET /v2/places`, `GET /v2/places/:id`, `GET /v2/speakers`, `GET /v2/speakers/:id`.
- **Persona QA (`scripts/qa/hono-fixture.ts`):** Add authenticated read journeys in both active public and active private communities for `viewer` vs `member` vs `editor` vs `admin`: prove private-community `viewer` reads `public` stories while `member` adds `community` stories, `viewer`/`member` get `404` on story-less or `editors`-only places/speakers while `editor`/`admin` see them, cross-community IDs return `404`, disabled community returns `403`, and `super_admin` gets `403`.
- **Dependencies:** Slice 4.

### Slice 6 — Community settings, map config, Place & Speaker CRUD

- **Scope:** Admin settings/map-config mutations and editor/admin CRUD for places and speakers. Enforces HTML sanitisation (≤20k chars), coordinate-pair validation, `CommunityMapConfig` lat/lng bounds validation, and `Speaker.birthplaceId` composite tenant FK checks.
- **Schema changes:** None.
- **Routes:** `PATCH /v2/community`, `PUT /v2/community/map-config`, `POST /v2/places`, `PATCH /v2/places/:id`, `DELETE /v2/places/:id`, `POST /v2/speakers`, `PATCH /v2/speakers/:id`, `DELETE /v2/speakers/:id`.
- **Persona QA (`scripts/qa/hono-fixture.ts`):** Test `admin` toggling `visibility` (`public`/`private`) and immediately observing `/v2/public/*` open/close; `admin` updating `CommunityMapConfig` (incl. antimeridian wrap & invalid lat reject `400`); `editor` CRUD on places/speakers (incl. nullable coords, cross-community `birthplaceId` rejection, invalid HTML `href` rejection); `viewer`/`member`/`super_admin` receiving `403`; `editor` receiving `403` on `/v2/community` and `/v2/community/map-config`.
- **Dependencies:** Slice 5.

### Slice 7 — Story CRUD & relational edges

- **Scope:** Editor/admin story lifecycle plus `StoryPlace`, `StorySpeaker`, and `ExternalMediaLink` endpoints. Atomic single-batch writes on D1 / transaction on Node; maintains `topicNormalized` and `descriptionPlain`; enforces composite tenant FKs on `interviewLocationId`, `interviewerId`, and edges; validates `ExternalMediaLink` absolute `http:`/`https:` URLs and deterministic `ordinal`.
- **Schema changes:** None (verify `story_places`/`story_speakers` multiplicity handling if source data permits duplicate edges per §6.3 — see migration check).
- **Routes:** `POST /v2/stories`, `PATCH /v2/stories/:id`, `DELETE /v2/stories/:id`, `PUT /v2/stories/:id/places`, `PUT /v2/stories/:id/speakers`, `POST /v2/stories/:id/external-links`, `PATCH /v2/stories/:id/external-links/reorder`, `DELETE /v2/stories/:id/external-links/:linkId`.
- **Persona QA (`scripts/qa/hono-fixture.ts`):** Test full story create/update/delete, `StoryPlace`/`StorySpeaker` edge attachment & cross-community target rejection, `ExternalMediaLink` add/reorder/delete + `javascript:` scheme rejection (`400`), `viewer`/`member`/`super_admin` `403`s, and immediate public-projection update when story visibility flips `editors -> public -> editors`.
- **Dependencies:** Slice 6.

### Slice 8 — Media upload, metadata, deletion, & `Attachment` management

- **Scope:** Expand `GET /v2/media/:id` beyond branding to all §6.4a/§6.7 attachment roles (`Range` support + `super_admin` own profile photo), and implement upload, metadata, deletion, and typed `Attachment` create/reorder/delete (#140). Enforce MIME sniffing, extension/content check, 100 MB request cap, SHA-256 checksum, server-generated tenant-scoped (or `super_admin` isolated) `storageKey`, and orphan-byte cleanup.
- **Schema changes:** None (uses Slice 2 tables).
- **Routes:** `GET /v2/media/:id` (expanded), `GET /v2/media/:id/metadata`, `POST /v2/media`, `DELETE /v2/media/:id`, `POST /v2/attachments`, `PATCH /v2/attachments/reorder`, `DELETE /v2/attachments/:id`.
- **Persona QA (`scripts/qa/hono-fixture.ts`):** Test multipart upload + attach/reorder/detach/delete for story, place (`place_photo`, `place_name_audio`), speaker, community branding/sponsor logos, user profile photo (own + `own-admin` + `super_admin` own photo), and unattached staging isolation. Adversarial cases: cross-community `fileId` attachment rejection, `super_admin` attaching community file rejection, SVG/HTML active-content sandbox headers, path-traversal filename neutralization, and `Range` byte requests respecting revocation.
- **Dependencies:** Slices 2, 7.

### Slice 9 — Client-stretching auth, prelogin, `AuthThrottle`, `AuditEntry`, & device sessions

- **Scope:** Replace transitional `POST /v2/auth/login` dev bridge with the §7 client-stretching protocol (`client-argon2id+sha256` and wrapped `client-bcrypt-rails+sha256` atomic upgrade), add `POST /v2/auth/prelogin` with deterministic HMAC fakes, username-or-email + `communitySlug` disambiguation, `AuthThrottle` durable rate limiting (≤2-row D1 batch), 60-day `device` sessions, self-service profile/password updates, and content-free `AuditEntry` logging + 90-day IP/UA scrub job.
- **Schema changes (SQLite/D1 + PostgreSQL):**
  - `users`: canonical `role` enum (remove `elder` from runtime enum), nullable `community_id`, `username` + global unique `username_normalized`, `email_normalized` + community-scoped unique `(community_id, email_normalized)` + partial unique `email_normalized WHERE community_id IS NULL`, `display_name`, `password_verifier`, `password_algorithm`, `password_salt`, `password_params`, `status`; update session-revocation DB triggers to fire on `password_verifier`/`role`/`community_id`/`status`.
  - `sessions`: add `kind` (`standard | device`), `created_at`, `last_seen_at`, `idle_expires_at`, `absolute_expires_at`, `revoked_at`, `revoked_by` (ms timestamps).
  - `auth_throttle` and `audit_entries`: new tables per §6.8.
- **Routes:** `POST /v2/auth/prelogin`, upgraded `POST /v2/auth/login`, `PATCH /v2/auth/me`, `POST /v2/auth/password`.
- **Persona QA (`scripts/qa/hono-fixture.ts`):** Update auth journeys to client-stretched Argon2id + wrapped Rails bcrypt login with atomic upgrade; test username login, duplicate email requiring `communitySlug`, uniform 401 across unknown slug / unknown identifier / ambiguous email / wrong key / throttled attempt, prelogin fake parity, `device` 60-day session persistence, `PATCH /v2/auth/me`, `POST /v2/auth/password` current-key verification + session revocation, and `AuditEntry` content-free check.
- **Dependencies:** Slice 0 (can develop in parallel after Slice 2; merges cleanly before Slice 10).

### Slice 10 — User management, recovery codes, `LoginCode`, bootstrap & `ClaimToken`

- **Scope:** Community-admin user lifecycle, assisted recovery (password reset + `admin_issued` `LoginCode`), 10-code `recovery` sheet generation/redemption (including migrated/code-enrolled admin first-login gate), device-session listing/revocation, fresh installation bootstrap, and hosted `ClaimToken` redemption.
- **Schema changes (SQLite/D1 + PostgreSQL):**
  - `login_codes` (`LoginCode`) and `claim_tokens` (`ClaimToken`) per §6.8 (ms timestamps, SHA-256 hashes, `superseded_at`, `used_at`/`consumed_at`).
- **Routes:** `GET /v2/users`, `GET /v2/users/:id`, `POST /v2/users`, `PATCH /v2/users/:id`, `POST /v2/users/:id/password-reset`, `POST /v2/users/:id/login-codes`, `GET /v2/users/:id/sessions`, `DELETE /v2/users/:id/sessions/:sessionId`, `POST /v2/auth/recovery-codes`, `POST /v2/auth/recovery/redeem`, `GET /v2/bootstrap`, `POST /v2/bootstrap`, `POST /v2/bootstrap/claim`.
- **Persona QA (`scripts/qa/hono-fixture.ts`):** Full user CRUD + collision rejection (`usernameNormalized`, same-community email, null-community email share); admin reset/code refusal on own account; recovery-code generation/regeneration superseding earlier codes; atomic code redemption setting new verifier + revoking old sessions; disabled-community admin assisted recovery; fresh bootstrap + replay `403`/`404`; `ClaimToken` redemption + replay/expired/superseded failure; offline field-kit persona un-skipped for local login + recovery code journey.
- **Dependencies:** Slice 9.

### Slice 11 — Bounded CSV import

- **Scope:** `ImportManifest` preview, listing/detail, one-shot all-or-nothing commit, and discard (#123, §4, §6.9). Enforces explicit header/audience mapping (no silent coercion to `public`), pre-commit media staging + checksums, D1 commit-plan budget validation (≤1,000 statements, ≤100 params, ≤100 KB, ≤50,000 estimated rows written, 1/day per D1 database), atomic transaction/D1 `batch()`, committed re-call returning recorded summary without re-apply, and restart-safe orphan staging cleanup.
- **Schema changes (SQLite/D1 + PostgreSQL):**
  - `import_manifests` (`ImportManifest`, §6.9) with composite `(community_id, source_file_id)` FK to `files`.
- **Routes:** `POST /v2/imports/preview`, `GET /v2/imports`, `GET /v2/imports/:id`, `POST /v2/imports/:id/commit`, `DELETE /v2/imports/:id`.
- **Persona QA (`scripts/qa/hono-fixture.ts`):** Preview + commit stories/places/speakers with related edges and staged media; re-commit returning recorded summary idempotently; discard cleaning staged bytes; negative tests for unknown audience, missing media, cross-community reference, malformed CSV, D1 budget rejection diagnostics, and `viewer`/`member`/`super_admin` `403`.
- **Dependencies:** Slices 7, 8.

### Slice 12 — Export, withdrawal, erasure, steward process, & community audit

- **Scope:** Full §7 sovereignty contract (#187): deterministic JSON manifest + streaming media ZIP export (via R2 multipart on Workers, streaming local archive on Node), short-lived single-artifact download tokens with per-object expiry cleanup, step-up verified withdrawal/erasure/steward designation, steward notice period + admin cancellation, immediate surface/cache invalidation, <24h restart-safe live deletion + multipart abort across community prefixes, out-of-band erasure record (excluded from backups/Time Travel) + restore verification hook, and community `AuditEntry` read.
- **Schema changes (SQLite/D1 + PostgreSQL + out-of-band store):**
  - `community_stewards` and `community_sovereignty_requests` (or equivalent community sovereignty state tables) + `export_jobs`/`export_tokens` metadata; out-of-band erasure record store outside restorable DB backups.
- **Routes:** `POST /v2/community/export`, `GET /v2/community/export/download/:token`, `GET /v2/community/sovereignty`, `PUT /v2/community/steward`, `POST /v2/community/withdrawal`, `POST /v2/community/erasure`, `POST /v2/community/sovereignty/cancel`, `GET /v2/community/audit-entries`.
- **Persona QA (`scripts/qa/hono-fixture.ts`):** Export active & disabled community (incl. `#162` rows), byte-identical re-export, token expiry & object cleanup, `super_admin` `403` on export; withdrawal + immediate public/member denial while sovereignty endpoints stay up; steward request notice + admin cancellation; erasure deleting DB rows, storage objects/versions, multipart uploads, sessions, throttles, manifests, and leaving out-of-band erasure record; community audit read without cultural content.
- **Dependencies:** Slices 8, 10, 11.

### Slice 13 — System administration (`/v2/admin/*`)

- **Scope:** `super_admin` operational lifecycle endpoints (§6.2, §6.8, §7): list operational community records, provision empty community, issue/reissue `ClaimToken` (blocked if any admin or content exists), toggle lifecycle `status` (never reading/writing descriptive fields or content), deprovision unclaimed empty community, read system-level `AuditEntry` (`communityId IS NULL`), and read out-of-band erasure records.
- **Schema changes:** None (uses Slice 9–12 tables).
- **Routes:** `GET /v2/admin/communities`, `POST /v2/admin/communities`, `POST /v2/admin/communities/:id/claim-tokens`, `PATCH /v2/admin/communities/:id/status`, `DELETE /v2/admin/communities/:id`, `GET /v2/admin/audit-entries`, `GET /v2/admin/erasures`.
- **Persona QA (`scripts/qa/hono-fixture.ts`):** `super_admin` provisioning community -> issuing claim token -> admin claiming -> subsequent claim-token issuance refused (`409`/`403`) -> status toggle (`disabled` purges community sessions, `active` restores) -> deprovision unclaimed community -> system audit/erasure reads; negative tests proving community roles get `403` on `/v2/admin/*` and `super_admin` gets `403`/`404` on every community content/export endpoint.
- **Dependencies:** Slices 10, 12.

### Slice 14 — Remove transitional Explore read adapter (post-frontend cutover)

- **Scope:** Delete `src/explore-adapter.ts`, `src/services/explore-adapter.service.ts`, `src/repositories/explore-adapter.repository.ts`, `HonoFoundationRepository.connection`, `docs/EXPLORE-ADAPTER.md`, and `/explore/*` QA journeys once the V2 frontend passes all §4 launch scenarios on `/v2/public/*` + `/v2/*` (#147, #185, #198).
- **Schema changes:** Drop transitional `community_media` / legacy V1 compatibility columns via expand-contract after cutover verification.
- **Routes:** Removes all 6 `/explore/*` routes.
- **Persona QA (`scripts/qa/hono-fixture.ts`):** Remove Explore journeys; verify `routeTableOf(app)` passes with canonical V2 routes only.
- **Dependencies:** Slices 3–13, #147 frontend cutover sign-off.
