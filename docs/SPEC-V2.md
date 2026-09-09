# Terrastories API V2 — Technical Specification

| Field       | Value                                                     |
| ----------- | --------------------------------------------------------- |
| **Status**  | Canonical — proposed product/architecture source of truth |
| **Created** | 2026-06-07                                                |
| **Updated** | 2026-09-08                                                |
| **Authors** | Terrastories Team                                         |
| **Repo**    | `terrastories-api`                                        |

---

## 1. Product intent

Terrastories V2 is a deliberate rebuild of the Terrastories backend for long-term maintainability, Indigenous data sovereignty, offline use, and simple deployment.

The legacy Rails application and the Fastify V1 API are **evidence**, not compatibility contracts. V2 does not aim for wire compatibility, identical database schemas, identical endpoint names, or internal architectural parity. Instead, V2 preserves the user-visible Terrastories experience and all community data while intentionally improving the underlying domain model, API, security boundaries, deployment model, and implementation stack.

The governing rule is:

> Preserve the mission, user-visible capabilities, community data, and sovereignty guarantees. Redesign implementation details when the V2 design is simpler, safer, more portable, or easier to maintain. Every material legacy/V1 divergence must be intentional and documented.

## 2. Goals and non-goals

### Goals

| ID  | Goal                                                                                                                                                                                                                                                                        |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G-1 | Run one product across Cloudflare Workers + D1 + R2, Node.js + PostgreSQL + self-hosted storage, and Node.js + SQLite + local filesystem field kits.                                                                                                                        |
| G-2 | Preserve the user-visible Terrastories experience: public storytelling/map discovery, community content management, visibility rules, media, map configuration, branding, imports, onboarding, profile/auth flows, and system administration needed to operate communities. |
| G-3 | Migrate legacy Rails deployments with **zero unintended data loss**. Every source row, relation, attachment, and field must be mapped, transformed, or preserved in a migration archive with a machine-readable disposition.                                                |
| G-4 | Make D1/SQLite and PostgreSQL equal first-class database targets for shared product semantics.                                                                                                                                                                              |
| G-5 | Keep field-kit deployments fully usable without runtime cloud dependencies.                                                                                                                                                                                                 |
| G-6 | Enforce community isolation and Indigenous data sovereignty structurally and with negative tests.                                                                                                                                                                           |
| G-7 | Provide a small, explicit, versioned V2 API contract that is easier to maintain and evolve than Rails or Fastify V1.                                                                                                                                                        |
| G-8 | Remove accidental V1 scope and duplicated domain concepts rather than carrying them forward indefinitely.                                                                                                                                                                   |

### Non-goals

- Wire compatibility with legacy Rails endpoints or Fastify V1.
- Reproducing Rails/Fastify response shapes solely for compatibility.
- Preserving obsolete internal models when their user-visible outcome can be represented more simply.
- Continuous synchronization between legacy and V2 after cutover.
- PostGIS or any database-specific spatial product semantics.
- Elder role/elder-only restrictions, elder speaker status, cultural-significance metadata, community cultural-settings blobs, story-place cultural-context fields, or the removed cultural-restriction schema.
- Rebuilding Rails-only tables that have no current user-visible product role. Their data must still be preserved by migration when present.
- New product features are not automatically launch requirements because they would be useful. The continuity scenarios in Section 4 bound launch scope; additions require an explicit product decision and owner.

## 3. Authority and intentional-evolution policy

When V2 work encounters behavior or data from Rails/Fastify that is not already represented here, classify it before implementation:

- **RETAIN** — the behavior/data remains valuable and is kept substantially unchanged.
- **IMPROVE** — the same user need is preserved with a deliberately better V2 model or API.
- **ARCHIVE** — not part of the V2 runtime product, but source data is retained losslessly by migration.
- **DROP** — only permitted for non-data-bearing implementation artifacts with no current product value. Data-bearing source fields are never silently dropped.
- **DEFER** — potentially useful product work that is not required for V2 launch; existing source data is archived if applicable.

An implementation, old test, issue, or existing Fastify behavior cannot silently redefine V2. Material changes to this specification require explicit review and approval.

The pinned Rails revision has two product-facing Flipper gates: `public_communities` and `split_settings`. They gate access to community-publication/settings UI and whether branding settings are edited with Theme or Community settings. V2 retains those user outcomes directly: community publication/private visibility and administrator-managed branding/settings are canonical capabilities rather than feature-flagged experiments. The Rails `beta` field and known Flipper feature/gate rows are therefore archived as historical operational state, not recreated as V2 runtime requirements. If a real source deployment contains additional/custom active Flipper keys, Stage 2 must classify their user-visible effect before that migration can be declared successful.

### Audited legacy evidence

The behavior inventory below uses [`Terrastories/terrastories@f6f033a17bd4a4c600ffea8bc2e773d243f88f72`](https://github.com/Terrastories/terrastories/tree/f6f033a17bd4a4c600ffea8bc2e773d243f88f72), with Rails schema version `2024_04_10_210545`. Paths are relative to that immutable revision. This is source inspection, not proof that every deployment uses these workflows or that the legacy tests pass. Migration manifests must still pin their own actual source/fixture provenance under Section 10.

| Legacy evidence                                                                                                                                                       | Observed outcome                                                                                                                                             | V2 disposition                                                                                                                                             |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `README.md`; `rails/app/javascript/components/App.jsx`, `Sort.jsx`                                                                                                    | Map and story selection work in both directions; category filters and newest/title sorting; separate Explore public client                                   | RETAIN workflows; IMPROVE typed projections and deterministic pagination/sorting                                                                           |
| `rails/app/policies/story_policy.rb`; `rails/app/controllers/api/stories_controller.rb`; `rails/app/controllers/application_controller.rb`                            | Story audiences and community publication are separate; an authenticated viewer can browse own-community anonymous-level stories even in a private community | RETAIN audience distinction; IMPROVE consistent enforcement on every route and related resource                                                            |
| `rails/app/models/user.rb`; `rails/app/controllers/passwords_controller.rb`; `rails/app/controllers/dashboard/users_controller.rb`                                    | Username-or-email login, password change, and community-admin account management/reset                                                                       | RETAIN local account workflows; IMPROVE verification, session revocation, and community-controlled recovery; email delivery is not an offline prerequisite |
| `rails/app/controllers/dashboard/communities_controller.rb`; `rails/app/controllers/super_admin/communities_controller.rb`                                            | Community admins control publication/settings; system admins provision communities and initial admins                                                        | RETAIN stewardship; IMPROVE bootstrap and indirect-access controls under Section 7                                                                         |
| `rails/app/controllers/onboard_controller.rb`; `rails/app/controllers/onboard/account_controller.rb`                                                                  | Initial community/admin setup includes unauthenticated setup and a shipped privileged password                                                               | RETAIN setup outcome; DROP reusable default credentials; IMPROVE one-time bootstrap authorization                                                          |
| `rails/app/javascript/components/StoryMedia.jsx`; `rails/app/models/story.rb`, `place.rb`, `speaker.rb`, `theme.rb`; `rails/app/views/api/stories/show.json.jbuilder` | Uploaded audio/video/images, place-name audio, interview metadata, speaker/place relationships, static maps                                                  | RETAIN playback and relationships; IMPROVE normalized file identity and protected serving                                                                  |
| `rails/app/javascript/components/Story.jsx`                                                                                                                           | Story descriptions render HTML                                                                                                                               | RETAIN meaningful text/formatting; IMPROVE safe rendering, never preserve executable markup as runtime behavior; raw source stays archived                 |
| `rails/app/controllers/dashboard/imports_controller.rb`; `rails/app/models/concerns/importable.rb`                                                                    | Header mapping, related records/media, and row results; import can coerce permissions and omit missing media                                                 | RETAIN import workflow; IMPROVE explicit audience validation, missing-file errors, duplicate handling, and atomicity                                       |
| `rails/app/services/map.rb`; `rails/config/environments/offline.rb`; `tileserver/README.md`                                                                           | Local map packages, local storage/assets, cloud-provider override in offline mode                                                                            | RETAIN full local operation; IMPROVE packaging and disconnected browser verification                                                                       |
| `rails/config/routes.rb`; `rails/app/models/curriculum.rb`                                                                                                            | Curriculum data model exists without an exposed route                                                                                                        | ARCHIVE by default; validate real community use before approving removal from a deployment's runtime                                                       |

Source behavior is not permission to reproduce an authorization bypass, unsafe default, silent import loss, or implementation-specific credential storage. Those changes are explicit IMPROVE/DROP decisions, with source data preservation independently required.

## 4. User-experience continuity contract

V2 may use new APIs and a new frontend integration, but the migration/cutover must not remove established user-facing capabilities without an explicit product decision.

### Public experience

V2 must support:

- public/private community discoverability;
- public place-based story browsing and map presentation;
- story detail with speakers, places, interview metadata, uploaded media, and external media links;
- filtering/search by place, region, place type, topic, language, speaker, and speaker affiliation where data exists;
- community map style/view configuration and community branding assets.
- map-to-story and story-to-map selection, plus newest-first and title ascending/descending ordering with a stable tie-breaker;
- meaningful story description formatting through a documented safe representation; migration preserves the original source and records any sanitization/transformation.

Public story visibility is an intersection, never a story-only decision. A public request may expose a story only when **all** relevant publication gates allow it. At minimum:

```text
community.visibility == public
AND community.status == active
AND story.visibility == public
```

A private or disabled community therefore always overrides a story marked `public`. Public list, detail, search, filter, map-point, media, and metadata paths must test this rule fail-closed.

### Community member experience

V2 must support:

- login with the same login identifier concept as Rails: a user may authenticate with either their unique `username` or their `email`, plus password;
- login/logout, profile, and password-management flows;
- community-scoped story, place, speaker, user, and map-configuration management according to role;
- uploaded story media, place/speaker/user/community images, place-name audio, theme/static-map media, and external story links;
- CSV preview/import capability for places, speakers, and stories, with validation before commit;
- onboarding required to create/configure a community and its initial administrator.

Changing username-or-email login to email-only or username-only is a product change and requires explicit approval plus migration/UX handling.

CSV imports must preview explicit header/field mappings, audience values, related records, media references, duplicate handling, and row errors before committing. Unknown audience values or missing referenced media cannot silently become public content or disappear. Creation of related places/speakers must be included in the preview and use the same community authorization as direct creation.

The accepted preview produces an immutable normalized manifest with a community-scoped idempotency key and digest. A commit is all-or-nothing for the complete manifest: all rows, related records, relations, File metadata, and import-result state commit in one portable database transaction. Media bytes must be staged and checksum-verified at their final immutable content-addressed keys before that transaction, but remain unreachable through the application until committed File relations authorize access. The relational commit is the single visibility point; it requires no fallible post-commit media promotion. Failed validation or database commit exposes no imported content, and cleanup of unreferenced staged bytes must be restart-safe and idempotent. Retrying the same community/key/digest returns or resumes the same import result and cannot create duplicates. Reusing a key with a different digest fails. No failure may leave partially visible rows or media. This is an improvement over Rails import coercion/partial-save behavior, distinct from the lossless Rails deployment migration in Section 10.

### System administration

V2 must support system-level community/user lifecycle operations required to operate hosted deployments. System privilege must not imply access to protected community content.

### Compatibility boundary

The experience contract is normative; Rails routes, Jbuilder payloads, Fastify routes, CSS/layout, and database column names are not. Frontends may require an intentional adapter/migration to consume V2.

### Launch continuity scenarios and ownership

API contracts alone do not prove user-experience continuity. Issue #147 owns integration evidence and must name the concrete community-management/map frontend and Explore/public client revisions, their responsible maintainers, and the pilot community approver before cutover. Frontend implementation can live in separate repositories; it remains a dependency of product release. Issue #134 owns the reusable contract harness, #145/#146 the domain cases, and #139 the shared authorization matrix.

| Scenario                         | Required observable outcome                                                                                                                              | Implementation/evidence owner |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Public discovery and publication | Public active community exposes only approved stories, points, filters, related metadata, and media; privatizing/disabling closes every public path      | #139, #145, #146              |
| Private community and roles      | Own-community viewer/member/editor/admin receive their distinct story audiences; cross-community and system privilege do not expand protected access     | #139, #146                    |
| Accounts and setup               | Migrated username and email login, password change, authorized local recovery, restart/revocation, and safe initial community/admin setup                | #137, #126, #146              |
| Browse and manage                | Select map point/story in either direction; filter/sort; view interview/speaker/place data; authorized create/edit/delete and safe description rendering | #145, #147                    |
| Media and branding               | Play uploaded audio/video, display images, play place-name audio, render static maps and ordered branding assets after migration                         | #140, #145, #147              |
| Import and preservation          | Preview/commit related CSV data with explicit errors; verify migrated rows, relations, bytes, and runtime/archive dispositions separately                | #123, #135, #147              |
| Disconnected field kit           | Cold-start browser and server without internet; local login, map, media, editing/import, recovery, and restart remain usable                             | #137, #140, #142, #147        |

Every row requires success and applicable negative cases using migrated synthetic representative data, including multilingual content. Each pilot additionally needs community-approved disposition of runtime capability removals: successful archival is data preservation, not proof that a lost workflow is acceptable. Uncovered required scenarios block cutover. Discovery of active custom features or curriculum use reopens the deployment's disposition decision rather than silently expanding or reducing launch scope.

## 5. Deployment architecture

| Mode            | Runtime            | Database              | Storage                                    | Runtime cloud dependency                                |
| --------------- | ------------------ | --------------------- | ------------------------------------------ | ------------------------------------------------------- |
| **Hosted**      | Cloudflare Workers | D1 / SQLite semantics | R2                                         | Cloudflare only                                         |
| **Self-hosted** | Node.js            | PostgreSQL            | pluggable self-hosted/object/local storage | none required beyond configured deployment dependencies |
| **Field kit**   | Node.js            | SQLite                | local filesystem                           | none                                                    |

All modes share domain/service behavior. Runtime, database, storage, hashing, and session implementations live behind explicit adapters where platform differences require them.

### Portability invariant

There is one canonical **logical relational schema and behavior contract**. Dialect-specific Drizzle definitions or migration files are allowed when tooling requires them, but SQLite/D1 and PostgreSQL may not expose different product semantics.

Shared behavior must remain SQLite-compatible. PostgreSQL-only extensions may not become product requirements.

### Offline profile

Field kits package the frontend, API, database, uploaded media, map styles/tiles and their glyph/sprite/font dependencies for local serving. Cloud URLs and provider credentials must not override offline configuration. A locally hosted map service is permitted; internet services are not required at runtime. Deployment acceptance includes cold-start browser tests with external network access blocked, not just SQLite or container configuration checks.

External media links remain preserved as links. Offline clients show a clear unavailable-offline state without automatic remote requests; an external link does not promise a local copy of the remote content. Downloading third-party content or adding hosted/field-kit synchronization is not a launch requirement. Locally imported/uploaded media remains fully usable offline. Account recovery must have a community-authorized local path without email or cloud identity services.

## 6. Canonical domain model

The schema below describes V2 product concepts. Physical database details may vary by dialect while preserving these semantics.

### 6.1 Community

```text
Community
  id
  name
  description?
  slug
  locale?
  country?
  visibility: public | private
  status: active | disabled
  createdAt
  updatedAt
```

- `visibility` controls public discoverability.
- `status` is operational lifecycle state and is not a privacy flag.
- A community that is `private` or `disabled` cannot expose its stories/media through public projections even when an individual story is marked `public`.
- Slugs are stable and unique. V2 may generate them automatically.
- Rails `beta` and Fastify `culturalSettings` are not canonical community domain fields. The audited Rails beta/Flipper-gated outcomes are represented directly by canonical V2 capabilities; raw legacy values remain in migration artifacts, and unknown/custom active flags require explicit Stage-2 disposition.

### 6.2 User and roles

```text
User
  id
  email?
  username
  displayName?
  passwordHash
  passwordAlgorithm
  role: viewer | member | editor | admin | super_admin
  communityId?
  status: active | disabled
  createdAt
  updatedAt
```

Role meanings:

- `viewer` — may view the `public` story audience within their own active community, including when that community is private; cannot view `community` or `editors` stories.
- `member` — may view public and community-visible content for their community.
- `editor` — member access plus content creation/editing.
- `admin` — editor access plus community/user administration.
- `super_admin` — system-level administration only; does not gain protected community-content access through privilege.

`communityId` is required for community roles and nullable for `super_admin`.

Community publication and story audience are separate axes. For authenticated own-community access, an active community's `private` status does not block the role's permitted story audience. `member` adds the `community` audience; `editor`/`admin` add `editors`. Anonymous and other-community access use the public intersection in Section 4; no role grants protected access across communities. A disabled community denies community-content access for every role; authorized system lifecycle operations may still restore service without reading protected content. A super admin may consume public projections only on the same terms as any public caller. Public and story-derived place/speaker/media projections and filter/count metadata must expose only readable stories and approved public assets; a relationship to an unreadable story must not expose that story or its protected metadata. Unassociated records are not automatically public. Authenticated own-profile photos and private community branding/map assets follow their resource-specific same-community policy, not a requirement to be attached to a public story. Editors/admins retain authorized same-community management of standalone records.

V2 keeps the meaningful Rails `member` versus `viewer` distinction because it affects the user-visible privacy model. The duplicated Rails `super_admin` boolean is normalized into the role enum for canonical V2 rows, but migration must first preserve both raw values. Contradictory source combinations must fail/manual-disposition canonical mapping rather than being guessed.

`username` remains a stable unique login identifier. Email uniqueness rules must support the approved login behavior without losing any legacy account; migration validation must detect collisions before cutover rather than rewriting identifiers silently.

Login resolution must be unambiguous across username and email together. Never select the first of multiple matching accounts. Define one normalization/case-comparison contract shared by SQLite/D1 and PostgreSQL, enforce it on new/updated identities, and validate migrated duplicate emails, case collisions, and usernames matching another account's email. Preserve raw identifiers and require explicit operator resolution before cutover when they conflict. Do not invent a community membership for an orphan historical account.

### 6.3 Story

```text
Story
  id
  communityId
  title
  description?
  visibility: public | community | editors
  topic?
  language?
  dateInterviewed?
  interviewLocationId?
  interviewerId?
  createdBy?
  createdAt
  updatedAt
```

`visibility` is the single story privacy concept:

- `public` maps the user need previously represented by Rails `anonymous`;
- `community` maps the user need previously represented by Rails `user_only`;
- `editors` maps the user need previously represented by Rails `editor_only`.

Story visibility never overrides the owning community's publication gate for public requests or its disabled lifecycle state. Authenticated access to an active private community follows Section 6.2.

Do not combine `privacyLevel`, `isRestricted`, elder-only flags, or other overlapping privacy mechanisms with this field.

`createdBy` is nullable in storage so imported/historical records can be represented truthfully; new application-created stories must record the actor when known.

Story relationships are explicit canonical records:

```text
StoryPlace: id, storyId, placeId, sortOrder?
StorySpeaker: id, storyId, speakerId, storyRole?, sortOrder?
```

Both endpoints of a relationship must belong to the same community. Retain every source edge and its multiplicity; do not silently deduplicate source relations to satisfy a target unique constraint. Preserve an existing order or speaker's narrative role when supplied; `storyRole` is descriptive metadata, never an authorization or cultural-restriction role. These optional attributes exist in Fastify V1 and the preceding V2 contract; the pinned Rails `places_stories`/`speaker_stories` tables do not contain them. Do not invent historical roles/order: leave absent values null and use a documented stable ID-based tie-breaker for display. If identifiers must be generated for source edges, record their deterministic source-to-target mapping in the migration manifest. Removed story-place cultural context remains archive-only under Section 11.

Every direct reference between community-scoped records has the same tenant invariant as the join records. `Story.interviewLocationId` must reference a Place in the story's community; `Story.interviewerId` must reference a Speaker in that community; `Story.createdBy` must reference a User in that community; and `Speaker.birthplaceId` must reference a Place in the speaker's community. The same rule applies to other canonical community-owned references unless this specification defines a narrower exception. Enforce equivalent fail-closed behavior on SQLite/D1 and PostgreSQL through portable constraints and repository transactions; do not rely on a read-time authorization filter to repair invalid ownership. Migration must preserve the raw inconsistent source values in the bundle/archive and require explicit manual disposition rather than linking across tenants or inventing ownership.

### 6.4 Place

```text
Place
  id
  communityId
  name
  description?
  typeOfPlace?
  region?
  latitude?
  longitude?
  createdAt
  updatedAt
```

Coordinates are nullable in storage. Map publication and spatial operations require a valid coordinate pair. Spatial operations use portable application-level latitude/longitude logic; no PostGIS dependency is permitted.

### 6.5 Speaker

```text
Speaker
  id
  communityId
  name
  biography?
  birth?
    year
    month?
    day?
  birthplaceId?
  affiliation?
  status: active | inactive
  createdAt
  updatedAt
```

`biography` retains the editable `bio` capability already exposed by Fastify V1 and present in the preceding V2 contract. It is nullable for Rails migrations because the pinned Rails Speaker table has no biography field. `affiliation` is the V2 name for the user-facing concept previously stored as Rails `speaker_community`.

`birth` preserves source precision without inventing a date. A year-only Fastify value maps to `{ year }`; a Rails date maps to `{ year, month, day }`. `month` and `day` must either both be present or both absent, and all components must form a valid non-future value. Storage may use portable scalar columns, but every V2 API uses this one logical partial-date representation.

`status` retains the Fastify speaker withdrawal capability. Inactive speakers and their photos are absent from public and viewer/member projections, direct reads, filters, counts, and story-derived speaker relations even when a related story is otherwise readable. The record and its relationships remain intact and are visible to authorized same-community editors/admins for management or reactivation. Rails imports default to `active` because the pinned Rails Speaker table has no lifecycle field; Fastify migration preserves `isActive` exactly.

`birthplaceId` retains the pinned Rails `Speaker.belongs_to :birthplace` relationship to a Place; Rails stores `birthplace_id`, not a free-text birthplace column. The historical `scripts/terrastories-api-test.sh` free-text `birthplace` request does not match the current Fastify speaker route/schema and is classified **DROP** as an unimplemented wire-only probe, with no source-data loss. Any different source installation that contains a data-bearing free-text birthplace still falls under the unknown-field capture and explicit-disposition rules in Section 10; it must not be silently converted into an invented Place or cross-tenant link.

Do not add elder status or cultural-role fields as launch requirements. New speaker metadata requires a separate product decision.

### 6.6 Map configuration

Rails exposes a single theme per community. V2 models the actual product concept directly:

```text
CommunityMapConfig
  communityId
  styleUrl?
  basemapStyle?
  centerLatitude?
  centerLongitude?
  southWestLatitude?
  southWestLongitude?
  northEastLatitude?
  northEastLongitude?
  zoom?
  pitch?
  bearing?
  threeDimensional?
  projection?
  staticMapFileId?
  createdAt
  updatedAt
```

- One configuration per community.
- Provider credentials/tokens are deployment secrets, not domain data.
- Map configuration is provider-neutral; Mapbox/Protomaps-specific naming must not leak into the canonical model unless required by an adapter.
- Rails Theme `static_map` is a data-bearing ActiveStorage attachment and must migrate through the canonical File/media system.
- Legacy provider credentials are preserved only in the restricted migration archive and require explicit operator handling during cutover rather than being copied into ordinary V2 rows. Reports contain disposition references only, never credential values.

### 6.7 Files and media

File identity must be independent of storage URLs and deployment providers.

```text
File
  id
  communityId?
  storageKey
  originalName?
  mimeType
  byteSize
  checksum
  uploadedBy?
  metadata?
  createdAt
```

Persist `storageKey`, not public/signed URLs. `StorageAdapter` resolves serving/upload/download behavior for R2 and local storage.

Media relations are explicit and typed. At minimum V2 must represent:

- story uploaded media;
- story external media links;
- place photo and place-name audio;
- speaker photo;
- user photo;
- community display image, background image, and sponsor logos;
- theme/community map static-map media.

Where legacy UI behavior depends on the order of a multi-attachment collection such as sponsor logos, migration must choose and document a deterministic source ordering (for example attachment creation/id order) and preserve that order explicitly in V2 rather than relying on database return order.

Do not duplicate media identity in `mediaUrls`, `imageUrl`, `audioUrl`, `photoUrl`, or similar resource columns.

`uploadedBy` is nullable so imported ActiveStorage objects can be represented without inventing provenance.

Community files require `communityId`. The only launch exception is an account-owned profile photo for a canonical `super_admin` without a community: its `communityId` is null and an explicit typed user-photo relation identifies the account owner before staging or serving. Null never means global/public ownership and cannot be used for stories, places, speakers, branding, maps, or cross-community sharing. Only that account owner can manage/read its system profile photo; null is not a shared community and system privilege does not authorize another account's photo. An orphan historical user/attachment that cannot map to a valid canonical account is retained together in the restricted archive with explicit manual disposition and community acceptance before cutover, never assigned an invented tenant or silently discarded.

File IDs, storage keys, and tenant membership alone never authorize serving. Resolve a typed attachment and its owning resource, then apply the same policy to metadata, download, byte-range requests, and transformed variants. Community files use community-scoped storage keys; the null-community profile exception uses an isolated account-scoped key namespace. The launch policy is:

| Owning resource                   | Read audience                                                                                                             | Attachment changes                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Story                             | Actors permitted to read that story under Sections 4/6.2, including community publication and lifecycle gates             | Same-community editor/admin permitted to edit the story  |
| Place/speaker                     | Approved projection through a readable story, or same-community editor/admin managing the standalone record               | Same-community editor/admin permitted to edit the record |
| User profile                      | Account owner or same-community admin with user-management authority; never public merely because the community is public | Account owner or authorized same-community admin         |
| Community branding/map/static map | Same-community viewer/member/editor/admin while active; public projections only when the community is active and public   | Same-community admin with community-settings authority   |

For community-owned assets, disabled-community and system-privilege restrictions apply to every row. Unattached uploads are private staging objects accessible only to their authorized uploader or same-community admin for completion/cleanup; missing owner/policy information fails closed. Imported objects without uploader provenance gain runtime access only through a valid authorized relation.

Every community-owned relation must target a resource whose `communityId` equals the File's `communityId`; the null-community system-profile exception may relate only to its owning `super_admin` account. A file may have multiple relations within that one tenant. An authorized relation permits its bytes but never disclosure of other protected relations/metadata. Adding/reusing a relation that broadens the bytes' audience requires publishing authority over every affected owner, otherwise reject it. Deliberate cross-community publication creates a distinct destination-tenant File identity and storage object after authorization by both communities and records source/checksum provenance; it never reuses a source tenant's File row or storage key. Removing an attachment requires authority over that owner; deleting shared bytes requires authority over all remaining owners or prior authorized removal of all references. Orphan cleanup must not remove still-referenced bytes. Imported cross-tenant relations remain losslessly captured and require explicit manual disposition before cutover rather than becoming runtime links. Tests must cover multiply related within one tenant, rejected cross-tenant relations, authorized copy-for-publication, unattached, historical-without-uploader, and private-profile/branding files as well as story media. Public/signed serving and caches must honor current policy after publication changes or revocation; possession of a historical URL is not a bypass.

## 7. Authentication, sessions, and sovereignty

### Passwords

Password hashing is behind a `PasswordHasher` abstraction. The domain contract stores the encoded hash and algorithm/version metadata rather than coupling the product to one library.

- New-password hashing must use a modern approved password KDF with parameters benchmarked on the supported Workers and Node runtimes before release.
- Legacy Rails bcrypt hashes are accepted only for migration/login upgrade. After a successful legacy-hash verification, V2 re-hashes with the current V2 algorithm and clears the legacy marker.
- Never reverse, decrypt, or replace a legacy password with a generated password during migration.

### Sessions

Production sessions use an opaque cookie/session identifier backed by durable database state with equivalent semantics across D1, PostgreSQL, and SQLite. In-memory sessions are development/test-only.

The session contract must support expiry, logout/revocation, identifier rotation, disabled-user invalidation, role/community changes, restart safety, and fail-closed behavior when authoritative session state cannot be read.

Platform caches such as Workers KV may be optional accelerators but are not the authorization source of truth.

### Community isolation

Community content repositories must be scoped by a tenant/actor context rather than relying solely on developers remembering to add a `WHERE communityId = ?` clause.

Every content path requires positive and negative tests for:

- same-community authorized access;
- unauthenticated/unauthorized access;
- cross-community direct and indirect access;
- list/count/search/metadata leakage;
- file/media leakage;
- private/disabled-community public projection leakage;
- super-admin attempts to read protected community content.

### Bootstrap and account lifecycle

Preserve community and initial-administrator setup while replacing unsafe Rails setup mechanics. Bootstrap authority must be explicitly established for the intended fresh installation/community, work offline, and be invalidated after completion. Setup replay must not create privileged accounts or reset credentials. No production profile may depend on shipped privileged passwords. Provisioning an additional hosted community requires authorized system lifecycle action; it is not permission to reopen installation bootstrap.

Preserve self-service password change and community-admin-assisted recovery, including accounts without email. Require verified recovery authority, revocation of existing sessions on recovery, and no disclosure of passwords/tokens in logs or reports. The last/only community administrator needs a tested, community-authorized recovery procedure established during setup; system privilege alone is not recovery authority. Email-based recovery may be an optional adapter but cannot replace the offline path. Rails reset-token columns alone do not establish a working email-recovery product requirement.

Community administrators authorize membership, community roles, member recovery, and publication. System administrators may provision/manage system and community lifecycle records, but cannot unilaterally acquire protected access by issuing/resetting credentials, changing membership/roles, impersonating users, or changing publication. Initial administration and exceptional recovery require explicit community/bootstrap authority; do not require a new invitation or multi-community-account product merely to implement that boundary.

Test administrative sequences, not only direct content requests: credential recovery then login/read; role or membership change then read; private-to-public change then public read; bootstrap replay after setup. Each sequence must enforce the same community authority and current session policy. These are application authorization guarantees; infrastructure operators' access to database/storage backups is a separate operational trust boundary governed by community-controlled deployment, credentials, and retention.

## 8. Database and storage rules

- D1/SQLite and PostgreSQL are equal required CI/release targets for shared behavior.
- No PostGIS or database-specific spatial extension in shared V2 semantics.
- Use Drizzle/parameterized query APIs for application data access by default.
- Raw SQL is allowed only when necessary behind repository/migration boundaries; it must be parameterized and either portable or explicitly dialect-scoped with equivalent behavior tests.
- JSON fields are storage containers unless a capability is explicitly proven portable; shared product behavior must not depend on PostgreSQL JSONB-only operators.
- Risky schema changes use expand/contract or a tested backup/restore/forward-fix strategy.
- Media storage keys are server-generated and community-scoped, except the isolated account-scoped system-profile case in Section 6.7; user filenames are metadata only.

## 9. API contract

V2 owns its own API contract. Rails/Fastify are not normative transports.

Canonical launch namespaces (normative):

```text
/v2/public/*   unauthenticated public projections
/v2/*          authenticated community API
/v2/admin/*    system administration
```

Login, authorized bootstrap/recovery, and health/readiness are explicit non-community-authenticated exceptions within `/v2/`, with their own fail-closed contracts. Issue #134 owns their exact operation paths and the route registry before #145/#146 domain implementation. Temporary coexistence paths require a documented mapping; they cannot become a second released V2 namespace by accident.

Do not duplicate resource CRUD merely because a user is a "member"; authorization belongs in policy/service boundaries.

Requirements:

- consistent typed success/error contracts;
- Zod/OpenAPI generated from the same source where practical;
- stable pagination and filtering semantics;
- community identity derived from authenticated context where possible rather than caller-selected tenant IDs;
- public projections enforce community publication/lifecycle and story visibility together;
- intentional breaking changes after V2 release require versioning/deprecation/migration notes and CI detection.

During Fastify/Hono coexistence, contract tests may execute both transports to detect accidental regressions, but Fastify output is not the V2 oracle. The canonical V2 contract is.

## 10. Legacy Rails migration contract

Migration is a one-time deterministic ETL from a real Rails deployment into V2. It is not a raw PostgreSQL-to-SQLite conversion and it does not read Rails directly into today's mutable V2 tables.

Migration is explicitly **two-stage**:

1. **Lossless source capture** — read a consistent Rails PostgreSQL snapshot plus ActiveStorage bytes into a versioned portable migration bundle containing the discovered source schema/types, every source row, every blob, provenance, and checksums. This stage is independent of the V2 physical schema.
2. **Canonical target transform** — read the verified bundle and map it into the approved canonical V2 logical schema for SQLite/D1-compatible and PostgreSQL targets, while producing field/table dispositions and validation evidence.

This separation lets Terrastories prove source preservation before target schema normalization is finished and prevents migration code from inheriting transient Fastify/V1 schema drift.

### 10.1 Source of truth for migration

The source-capture contract is pinned to the audited legacy repository revision and schema version used by fixtures. Every migration manifest records:

- legacy repository commit/reference used by the migration contract;
- pinned Rails `schema.rb` version;
- observed source `schema_migrations` version when available;
- a digest of the actually discovered source schema;
- every discovered source table/column/type, including unknown/custom tables.

The required baseline includes:

- communities;
- users and integer roles plus historical `super_admin` boolean;
- stories and permission levels;
- places, including nullable coordinates;
- speakers;
- themes/map settings plus Theme `static_map` attachment;
- story-place and story-speaker relations;
- story media and `media_links`;
- ActiveStorage blobs, attachments, and variant records;
- user/place/speaker/community ActiveStorage attachments;
- curriculums/curriculum-stories and other data-bearing legacy tables even when not part of the V2 runtime product;
- Rails/Flipper operational tables where present, so active behavior can be dispositioned rather than lost.

Legacy FactoryBot factories are useful for representative values but are not sufficient as the migration schema contract. Integration fixtures must combine the exact/pinned Rails schema with production-valid edge states not represented by FactoryBot.

Unknown/community-specific source tables must be captured automatically. A hand-maintained allowlist may make known-schema regressions fail closed, but it may not define the universe of data that is preserved.

### 10.2 Preservation rules

- Preserve legacy primary IDs for canonical domain records when doing so is safe; record any remap explicitly.
- Never invent required foreign keys/provenance merely to satisfy a stricter V2 schema.
- Preserve nulls and source precision when absence or granularity is meaningful; application creation rules may be stricter than import/storage rules. Rails speaker dates map to full canonical partial dates, while Fastify year-only values remain year-only and never gain invented month/day values.
- Map Rails story permission values deterministically to V2 visibility.
- Preserve user role semantics, including `viewer` versus `member`.
- Preserve both legacy `role` and `super_admin` source values before normalization. Contradictory combinations require explicit/manual disposition and may not be guessed.
- Preserve username and email values so username-or-email login can survive cutover. Identifier collisions or invalid canonical uniqueness must fail validation for operator resolution; never silently rewrite identities.
- Preserve every relationship edge and relationship multiplicity.
- Copy media bytes, MIME type, filename, byte size, checksum, attachment role, and a deterministic ordering signal for multi-attachments; verify checksums after write.
- Preserve legacy external media links.
- When a source V1 resource stores deployment-derived media URL fields such as `mediaUrls`, `imageUrl`, `audioUrl`, or `photoUrl`, remove those fields from the canonical runtime model but preserve every raw source value in the restricted legacy archive. The migration manifest must account for each field/value disposition even when no durable media object can be recovered from the URL.
- Preserve legacy bcrypt hashes with algorithm metadata for lazy upgrade.
- Never silently discard a source field. Fields intentionally absent from canonical V2 go to the machine-readable legacy archive.
- Structurally inconsistent or unmappable source rows remain losslessly present in the bundle/archive and fail or require explicit manual disposition before a migration run can be declared successful.

### 10.3 Source-capture bundle

Stage 1 produces a self-contained migration bundle. At minimum it contains:

1. a portable SQLite archive containing discovered source schema/type metadata and every relational source row;
2. all ActiveStorage blob bytes, keyed by immutable source blob key;
3. a machine-readable manifest containing source provenance, table/row counts, schema digest, per-table deterministic row digest, blob byte size, Rails checksum when present, and SHA-256;
4. a human-readable validation summary that contains counts/dispositions but not source row contents, password hashes, provider credentials, session/reset tokens, or other secrets.

Source values must be serialized without JavaScript precision loss. Numeric/decimal/bigint/timestamp values therefore use a source-database canonical representation plus explicit source column types, or an equivalently lossless encoding.

The bundle is sensitive community data:

- create it with owner-only permissions by default where the platform supports POSIX permissions;
- never log source rows, password hashes, reset tokens, provider credentials, database URLs, or protected media;
- encrypt it at rest whenever it leaves a trusted migration host or is retained as a backup/artifact;
- never upload a real community migration bundle to CI, public Actions artifacts, or third-party review services;
- keep retention/deletion under community/operator control.

Stage 1 must fail closed on missing required Rails schema, source read inconsistency, missing blob bytes, byte-size mismatch, checksum mismatch, destination overwrite, or unexplained capture-count changes. Failure must not leave a destination that can be mistaken for a successful bundle.

### 10.4 Canonical target artifacts

Stage 2 produces:

1. the V2 database for the chosen target;
2. migrated media/storage objects;
3. a machine-readable migration manifest with source/bundle/target counts, ID mappings, field dispositions, warnings, and checksums;
4. a restricted **legacy archive** containing every data-bearing source row/field not represented canonically in V2, normally sourced directly from the verified Stage-1 bundle rather than reconstructed after transformation;
5. a human-readable validation summary that fails the run on unexplained differences.

The legacy archive is not queried by the runtime application and must not become a backdoor around community authorization. It exists solely to make intentional model simplification compatible with zero unintended data loss.

The Stage-2 legacy archive and any retained copies inherit every concrete bundle protection in Section 10.3: owner-only creation where supported, encryption when leaving the trusted migration host or retained as backup/artifact, no real data in CI/public/third-party artifacts, no secret/source-row logging, and community/operator-controlled retention/deletion. Restricted manifests and machine-readable dispositions containing sensitive data receive the same controls; human-readable summaries contain counts/disposition references only. Validation must reject unsafe archive permissions/transfer destinations, secret-bearing summaries, and unprotected retained artifacts rather than treating the word "restricted" as sufficient evidence.

### 10.5 Validation gates

A migration is successful only when automated checks prove:

- source capture accounts for every discovered source table, row, column/type, and ActiveStorage blob;
- source and target/archive account for every source table, row, and data-bearing column;
- canonical entity counts and IDs match the migration manifest;
- all foreign keys and many-to-many edges are accounted for;
- nullable/edge states survive correctly;
- every ActiveStorage attachment is accounted for and migrated bytes match source checksums;
- Theme static-map and community/user/place/speaker/story attachment roles are represented;
- multi-attachment ordering is deterministic and explicitly mapped;
- external media links are preserved;
- username/email login identities and role/visibility behavior match the experience contract;
- contradictory role/super-admin state cannot be silently normalized;
- public/private/disabled community behavior is preserved, including private-community override of public stories;
- known Rails beta/Flipper-gated outcomes map to canonical V2 capabilities, and every unknown/custom active source flag has an explicit RETAIN/IMPROVE/ARCHIVE disposition;
- public map/filter data remains representable;
- migration is deterministic and safe to re-run against a fresh destination;
- failure is atomic or leaves an explicitly disposable incomplete destination, never a falsely successful partial migration.

The same canonical migrated fixture must validate on SQLite/D1-compatible and PostgreSQL V2 targets. SQLite export is additionally required for field-kit migration.

## 11. Legacy disposition at V2 launch

| Legacy/V1 concept                                | V2 disposition                                             | Rationale                                                                                                                |
| ------------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Communities, stories, places, speakers           | RETAIN/IMPROVE                                             | Core Terrastories domain                                                                                                 |
| Rails story permission levels                    | IMPROVE                                                    | One `visibility` enum preserves the same audience distinctions                                                           |
| Rails `viewer` and `member` distinction          | RETAIN                                                     | User-visible access difference must survive                                                                              |
| Username-or-email login                          | RETAIN                                                     | Established login experience; both identifiers migrate                                                                   |
| Story/place/speaker relationships                | RETAIN                                                     | Core narrative/map data                                                                                                  |
| Uploaded media and external media links          | IMPROVE                                                    | Normalize around `File` + explicit relations; preserve every item                                                        |
| Community/user/place/speaker attachments         | IMPROVE                                                    | Normalize into the same media system                                                                                     |
| Theme `static_map` attachment                    | IMPROVE                                                    | Preserve through canonical File/map configuration relation                                                               |
| Rails Theme                                      | IMPROVE                                                    | Replace provider-specific singleton theme with `CommunityMapConfig`                                                      |
| Map provider credentials in DB                   | IMPROVE/ARCHIVE                                            | Move secrets out of domain rows; preserve source value in restricted migration artifact                                  |
| CSV imports                                      | RETAIN/IMPROVE                                             | Preserve user workflow with a typed/validated V2 implementation                                                          |
| Rails `curriculums`                              | ARCHIVE by default                                         | Schema exists but no current Rails route exposes it; do not rebuild runtime product without evidence of active user need |
| Rails `beta` / known Flipper state               | IMPROVE/ARCHIVE                                            | Preserve publication/settings outcomes as canonical V2 capabilities; archive legacy gating state; classify custom keys   |
| Fastify elder role/restrictions                  | DROP                                                       | Explicit V1 scope creep; not a Rails user requirement                                                                    |
| Cultural-significance/settings/context V1 fields | DROP from canonical runtime; archive if source data exists | Avoid unreviewed cultural-protocol semantics                                                                             |
| PostGIS behavior                                 | DROP                                                       | Portability and offline operation are higher-value requirements                                                          |
| Persisted resource media URL fields              | DROP from canonical runtime; ARCHIVE source values         | URLs are deployment-specific derived values, but persisted values remain data-bearing migration evidence                 |

## 12. Testing and release gates

### Canonical contract tests

Build a fail-closed V2 behavior contract suite. It defines approved V2 behavior and must cover public, authenticated community, admin, auth/session, media, import, spatial, validation/error, and sovereignty paths.

Legacy/Fastify comparison tests may help discover omissions, but an old behavior becomes normative only after it is classified under Section 3 and represented in this spec/contract.

Public contract tests must specifically prove that community publication/lifecycle gates override story-level public visibility across list/detail/search/map/media paths.

Authentication contract tests must cover username and email login identifiers for migrated and new V2 users according to the approved uniqueness rules.

### Database tests

Required CI must exercise shared schema/repository/migration behavior against both:

- SQLite/D1-compatible execution; and
- PostgreSQL.

Both paths must cover fresh schema creation, supported upgrades, constraints, indexes, timestamps, booleans, null/unique behavior, transactions, JSON serialization, ordering/pagination, and portable spatial behavior.

### Migration tests

Migration CI uses synthetic fixtures only; never real community data. It must include:

- the pinned Rails `schema.rb` and an executable PostgreSQL equivalent;
- every Rails role and story permission value;
- nullable and edge states such as missing place coordinates and system users without community IDs;
- all relationship tables, external media links, and persisted resource media URL fields, including a case where the URL is the only surviving media reference;
- curriculums and operational tables;
- every relevant ActiveStorage attachment role, including Theme `static_map`;
- deterministic blob payloads with known size/checksum;
- at least one unexpected/custom source table proving dynamic capture;
- corruption/missing-media and destination-overwrite negative tests.

Stage-1 capture tests run against real PostgreSQL semantics. Stage-2 mapping tests must run the same verified bundle into both SQLite/D1-compatible and PostgreSQL targets.

### Deployment tests

Required release evidence covers Workers+D1+R2, Node+PostgreSQL, and offline Node+SQLite profiles. Field-kit tests must fail if a required runtime path reaches an external cloud dependency.

### Security tests

Auth, sessions, files/media, imports, migration, community isolation, public/private visibility, exports, and super-admin boundaries require negative/adversarial coverage.

## 13. Phased path

1. **Contract correction** — approve this V2 source-of-truth model and update dependent issues/plans.
2. **Migration source preservation** — land an independently reviewable Stage-1 Rails capture/bundle contract pinned to the real Rails schema; it may be developed in parallel but cannot establish canonical target mappings before this spec is accepted.
3. **Transport foundation** — finish Hono coexistence while treating canonical V2 behavior, not Fastify parity, as destination truth.
4. **Domain/schema normalization** — remove V1 scope creep and duplicated privacy/media/provider concepts; establish the canonical logical schema on both DB targets.
5. **Production adapters** — D1/PostgreSQL/SQLite, R2/local storage, durable sessions, password hashing, deployment hardening.
6. **Canonical migration transform** — consume the verified Rails bundle into the finalized V2 SQLite/PostgreSQL schemas with field dispositions, media migration, and archive validation.
7. **Frontend/cutover validation** — prove established user workflows against migrated representative data before production cutover.
8. **Release** — exact-revision production-readiness gate across hosted, self-hosted, and field-kit profiles.

## 14. Resolved architectural decisions

| Question                            | Decision                                                                                                                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Legacy compatibility target?        | Preserve user experience and data; do not preserve Rails/Fastify wire/internal compatibility.                                                                                        |
| HTTP framework?                     | Hono.                                                                                                                                                                                |
| Database targets?                   | D1/SQLite and PostgreSQL equal first-class.                                                                                                                                          |
| Physical schema?                    | One logical schema/behavior contract; dialect-specific definitions/migrations allowed when required.                                                                                 |
| Spatial behavior?                   | Plain lat/lng + application-level portable logic; no PostGIS.                                                                                                                        |
| Story privacy?                      | One `public / community / editors` audience field; public requests also require a public active community, while authenticated own-community access follows Section 6.2.             |
| User roles?                         | `viewer`, `member`, `editor`, `admin`, `super_admin`; no elder role.                                                                                                                 |
| Login identity?                     | Preserve Rails username-or-email login behavior unless explicitly changed later.                                                                                                     |
| Sessions?                           | Durable database-backed authoritative sessions; memory dev/test only.                                                                                                                |
| Media?                              | One `File` identity model + explicit typed relations; URLs derived by storage adapter; Theme static map included.                                                                    |
| Map configuration?                  | One provider-neutral `CommunityMapConfig` per community; provider credentials are secrets.                                                                                           |
| Legacy removed data?                | Preserve in migration archive; never silently discard.                                                                                                                               |
| Rails beta/Flipper?                 | Known `public_communities` and `split_settings` outcomes become normal V2 publication/settings capabilities; archive gating state. Custom active keys require migration disposition. |
| Password migration?                 | Verify legacy bcrypt on login, then rehash with current V2 hasher.                                                                                                                   |
| Migration strategy?                 | Two-stage: lossless Rails PostgreSQL + ActiveStorage capture bundle, then deterministic bundle-to-canonical-V2 transform.                                                            |
| API compatibility after V2 release? | Protect released V2 contracts with OpenAPI/contract CI and explicit versioning/deprecation policy.                                                                                   |

## 15. Change log

| Date       | Changes                                                                                                                                                                                                                                                                                                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-09-08 | Pinned legacy behavior evidence; separated publication from authenticated story audiences; specified safe setup, community-admin stewardship, unambiguous identities, local recovery, import fidelity, disconnected browser acceptance, and named continuity/release owners.                                                                                             |
| 2026-06-07 | Initial V2 Cloudflare/Hono specification.                                                                                                                                                                                                                                                                                                                                |
| 2026-08-17 | Reaffirmed Hono, equal D1/SQLite + PostgreSQL targets, field-kit support, no PostGIS, and sovereignty constraints.                                                                                                                                                                                                                                                       |
| 2026-08-28 | Reframed V2 from legacy wire/feature parity to intentional evolution: preserve user experience and all source data while simplifying the domain. Added canonical visibility/role/media/map/session models, real Rails migration contract, archive requirement for intentionally removed data, and V2-native contract testing.                                            |
| 2026-08-28 | Addressed independent architecture review: made private/disabled community precedence explicit, preserved username-or-email login, added Theme static-map migration, required active beta/Flipper disposition, split migration into lossless source capture plus canonical target transform, and strengthened archive fidelity/security and contradictory-role handling. |
| 2026-08-28 | Audited the pinned Rails feature flags and resolved known `public_communities`/`split_settings` outcomes as unconditional canonical V2 publication/settings capabilities while retaining legacy beta/Flipper state in migration artifacts.                                                                                                                               |
