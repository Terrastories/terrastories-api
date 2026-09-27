# Terrastories API V2 — Technical Specification

| Field       | Value                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------- |
| **Status**  | Canonical — product/architecture source of truth; approval completes on merge of PR #163 |
| **Created** | 2026-06-07                                                                               |
| **Updated** | 2026-09-27                                                                               |
| **Authors** | Terrastories Team                                                                        |
| **Repo**    | `terrastories-api`                                                                       |

---

## 1. Product intent

Terrastories V2 is a deliberate rebuild of the Terrastories backend for long-term maintainability, Indigenous data sovereignty, offline use, and simple deployment.

The legacy Rails application and the Fastify V1 API are **evidence**, not compatibility contracts. V2 does not aim for wire compatibility, identical database schemas, identical endpoint names, or internal architectural parity. Instead, V2 preserves the user-visible Terrastories experience and all community data while intentionally improving the underlying domain model, API, security boundaries, deployment model, and implementation stack.

The governing rule is:

> Preserve the mission, user-visible capabilities, community data, and sovereignty guarantees. Redesign implementation details when the V2 design is simpler, safer, more portable, or easier to maintain. Every material legacy/V1 divergence must be intentional and documented.

## 2. Goals and non-goals

### Goals

| ID  | Goal                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G-1 | Run one product across Cloudflare Workers + D1 + R2, Node.js + PostgreSQL + self-hosted storage, and Node.js + SQLite + local filesystem field kits.                                                                                                                                                                                                                                                       |
| G-2 | Preserve the user-visible Terrastories experience: public storytelling/map discovery, community content management, visibility rules, media, map configuration, branding, imports, onboarding, profile/auth flows, and system administration needed to operate communities.                                                                                                                                |
| G-3 | Migrate legacy Rails installations with **zero unintended data loss**. Every source row, relation, attachment, field, and stored byte payload must be mapped, transformed, or preserved in a migration archive with a machine-readable disposition. A deployed Fastify V1 installation, if one is later identified, migrates under the same rule; the Fastify source profile itself is DEFER (Section 10). |
| G-4 | Make D1/SQLite and PostgreSQL equal first-class database targets for shared product semantics.                                                                                                                                                                                                                                                                                                             |
| G-5 | Keep field-kit deployments fully usable without runtime cloud dependencies.                                                                                                                                                                                                                                                                                                                                |
| G-6 | Enforce community isolation and Indigenous data sovereignty structurally and with negative tests.                                                                                                                                                                                                                                                                                                          |
| G-7 | Provide a small, explicit, versioned V2 API contract that is easier to maintain and evolve than Rails or Fastify V1.                                                                                                                                                                                                                                                                                       |
| G-8 | Remove accidental V1 scope and duplicated domain concepts rather than carrying them forward indefinitely.                                                                                                                                                                                                                                                                                                  |

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

API contracts alone do not prove user-experience continuity. Issue #147 owns integration evidence and must name the concrete community-management/map frontend and Explore/public client revisions, their responsible maintainers, and the pilot community approver before cutover. Frontend implementation can live in separate repositories; it remains a dependency of product release. Issue #134 owns the reusable contract harness, #145/#146 the domain cases, and #139 the shared authorization matrix. A community's cutover is blocked until a named client revision passes the Section 4 scenarios for that community's deployment profile.

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

For the hosted profile, data placement and jurisdiction are the community's decision; communities that cannot accept a given hosting jurisdiction use the self-hosted or field-kit profiles.

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
  username?
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

Community publication and story audience are separate axes. For authenticated own-community access, an active community's `private` status does not block the role's permitted story audience. `member` adds the `community` audience; `editor`/`admin` add `editors`. Anonymous and other-community access use the public intersection in Section 4; no role grants protected access across communities. A disabled community denies community-content access for every role; authorized system lifecycle operations may still restore service without reading protected content. A super admin may consume public projections only on the same terms as any public caller. Public and story-derived place/speaker/media projections and filter/count metadata must expose only readable stories and approved public assets — a non-story asset (place, speaker, media, branding) is approved only when its owning resource's visibility/lifecycle status and every publication gate on the projection path admit the caller; a relationship to an unreadable story must not expose that story or its protected metadata. Unassociated records are not automatically public. Authenticated own-profile photos and private community branding/map assets follow their resource-specific same-community policy, not a requirement to be attached to a public story. Editors/admins retain authorized same-community management of standalone records.

V2 keeps the meaningful Rails `member` versus `viewer` distinction because it affects the user-visible privacy model. The duplicated Rails `super_admin` boolean is normalized into the role enum for canonical V2 rows, but migration must first preserve both raw values. Contradictory source combinations must fail/manual-disposition canonical mapping rather than being guessed.

The mapping is explicit for both source profiles (the Fastify V1 rows specify the deferred Fastify source profile; see Section 10):

```text
Source profile and state                                         | Canonical V2 mapping
Rails: any role, super_admin = false, community_id present       | same role; communityId preserved
Rails: any role, super_admin = true, community_id absent         | super_admin; communityId null
Rails: any community role, super_admin = true, community_id set  | manual disposition; both privileges preserved in evidence
Rails: super_admin = false, community_id null                    | manual disposition (orphan); preserved in evidence
Rails: null or unknown/out-of-range role                          | manual disposition; preserved in evidence
Fastify V1: super_admin (source community_id is NOT NULL)        | super_admin; communityId null; source communityId archived
Fastify V1: admin                                                 | admin
Fastify V1: editor                                                | editor
Fastify V1: viewer                                                | member
Fastify V1: elder                                                 | community-approved disposition; never defaults silently
```

A canonical V2 `super_admin` row never carries a `communityId`. A source row that combines `super_admin = true` with a community role and a non-null community holds two privileges with no canonical single-row representation: migration preserves both raw values in the evidence and requires explicit manual disposition; neither privilege is dropped silently or resolved by a default rule.

A Fastify V1 `super_admin` maps to a canonical `super_admin` with a null `communityId`; the source `communityId` is retained in migration evidence as provenance, never as a canonical membership. A Fastify `viewer` maps to V2 `member`, not `viewer`: the pinned Fastify story reads for non-`elder`/`admin` users filter only on `isRestricted = false` and never enforce `privacyLevel`, so a Fastify `viewer` effectively reads `members_only` stories — the audience V2 grants to `member`. Mapping to V2 `viewer` would silently narrow that user's effective access, which Section 4 forbids without an explicit product decision. The Fastify `elder` role has no canonical equivalent: each such user requires a community-approved disposition under Section 3 and never defaults silently to a broader or narrower audience.

`username` is required for new V2 accounts and for an imported account whose source provides one. It remains a stable globally unique login identifier when present. It is nullable only so a Fastify V1 account, whose source schema has no username, can migrate without inventing identity data. A Rails source username of `""` (the pinned column default) imports as null — no username — never as a globally unique empty string. Migration must never synthesize a username from a name, email, or source ID. An authorized community account-management flow may later assign a unique username. Username uniqueness and lookup use an application-maintained `usernameNormalized` column with a global unique index, following the same no-database-case-folding rule; login lookup and username-versus-email collision checks compare on it. Email may identify different accounts in different communities, and email uniqueness is enforced on application-normalized values: the schema stores an `emailNormalized` column maintained by the application, and every unique index and identity filter uses it — the community-scoped unique index on `(communityId, emailNormalized)` and a portable partial unique index on `emailNormalized` `WHERE communityId IS NULL` for null-community (`super_admin`) accounts. SQLite/D1 and PostgreSQL both support partial unique indexes; a plain `UNIQUE(communityId, email)` on the raw column treats NULLs as distinct on both backends and does not block case collisions within a community, so it is not a substitute. Database case-folding functions (`lower()`, `NOCASE`, `COLLATE`, `ILIKE`) are never used for identity comparison: SQLite folds ASCII only while PostgreSQL folds Unicode, so they diverge on multilingual data. Migration validation must detect collisions before cutover rather than rewriting identifiers silently.

Login resolution must be unambiguous across username and email together. A username match identifies one account. An email match identifies one account only when it is globally unambiguous or when an explicit community locator narrows it to one account; otherwise login requires community context and returns the same non-enumerating failure as any invalid credential. Never select the first of multiple matching accounts. One application-defined normalization/case-comparison contract runs identically on SQLite/D1 and PostgreSQL (never database case-folding), is enforced on new/updated identities through the normalized columns, and validation covers duplicate emails within a community, cross-community email ambiguity, case collisions, and a username matching another account's email. Preserve raw identifiers and require explicit operator resolution before cutover when they conflict. Do not invent a community membership for an orphan historical account.

### 6.3 Story

```text
Story
  id
  communityId
  title
  description?
  visibility: public | community | editors
  tags: string[]
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

Fastify V1 collapses its overlapping story controls during migration. When `isRestricted = false`, `privacyLevel = public` maps to `public` and `members_only` maps to `community`; `privacyLevel = restricted` may map to `editors` only when source evidence confirms the row was not subject to the narrower elder/admin path. `isRestricted = true` was limited to elder/admin audiences that have no exact canonical equivalent, so it remains unavailable in V2 runtime and blocks cutover until the community explicitly approves a canonical audience or an archive-only disposition. `editors` is the closest retained runtime audience, but migration cannot select it silently. Any other value or contradictory source state follows the same explicit community-approved disposition path and never defaults to public.

`createdBy` is nullable in storage so imported/historical records can be represented truthfully; new application-created stories must record the actor when known.

`tags` is the canonical portable story taxonomy and filter list. A nonblank Rails `topic` maps to a one-element list with its exact source value; a blank/null topic maps to an empty list. Fastify V1 `tags` retain every ordered source value and may not be collapsed into one topic. Canonical storage is a portable relational form — logical `StoryTag(storyId, ordinal, value, valueNormalized)` with `ordinal` preserving source order and `valueNormalized` maintained by the application — or an equivalent portable structure; every tag filter uses `valueNormalized`, never JSON or array containment operators (Section 8) and never database case-folding (`lower()`, `NOCASE`, `COLLATE`, `ILIKE` fold differently across SQLite/D1 and PostgreSQL), so public and member filters "match any requested tag" identically on SQLite/D1 and PostgreSQL under one application-defined case-comparison contract. Migration retains the raw source field/value in its evidence so canonical validation or future normalization never invents, silently deduplicates, or loses taxonomy data.

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
  visibility: public | community | editors
  latitude?
  longitude?
  createdAt
  updatedAt
```

`visibility` controls whether a place may appear in direct, map, search, count, story-derived, and media projections. Visibility is necessary but not sufficient: a place appears in a projection only when every publication gate on that projection path (Sections 4, 6.2, and 6.7) also admits the caller. A readable story does not widen a related place's audience; callers see the intersection of story and place access. Authorized same-community editors/admins can manage every canonical place. Rails places default to `public` because the pinned Rails source has no place restriction. Fastify `isRestricted = false` maps to `public`. A restricted Fastify place had elder-specific read access with no exact canonical equivalent, so it stays unavailable in V2 runtime and blocks cutover until the community explicitly approves a canonical audience or archive-only disposition; `editors` is the closest runtime audience but is never selected implicitly. Raw `isRestricted` and removed cultural-significance values remain in migration evidence/archive.

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
- Fastify V1 permits multiple theme rows and multiple active themes per community. Exactly one active row maps to the canonical configuration. Zero or multiple active rows require an explicit same-community administrator selection accepted under the community cutover process; migration must never choose the first, newest, or otherwise guessed row. Every source theme row and its disposition remains in the archive/manifest. A community that actively relies on switching among multiple configurations requires a product/spec decision before its cutover rather than silent feature loss.

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

Story external media links are canonical link records, distinct from `File`: they retain the owning story/community, exact validated URL, and deterministic source order. They do not claim ownership of remote bytes and do not grant access to any local object. Offline clients may display retained metadata but must not fetch remote links automatically.

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

Every community-owned relation must target a resource whose `communityId` equals the File's `communityId`; the null-community system-profile exception may relate only to its owning `super_admin` account. A file may have multiple relations within that one tenant. An authorized relation permits its bytes but never disclosure of other protected relations/metadata. Adding/reusing a relation that broadens the bytes' audience requires publishing authority over every affected owner, otherwise reject it. Cross-community copy-for-publication is **DEFER**: it is not a launch capability. At launch, attempts to attach one community's file bytes to another community's resource are rejected fail-closed and covered by negative tests. The deferred design, available only to a future explicit product decision, would create a distinct destination-tenant File identity and storage object after authorization by both communities, record source/checksum provenance, and never reuse the source tenant's File row or storage key. Removing an attachment requires authority over that owner; deleting shared bytes requires authority over all remaining owners or prior authorized removal of all references. Orphan cleanup must not remove still-referenced bytes. Imported cross-tenant relations remain losslessly captured and require explicit manual disposition before cutover rather than becoming runtime links. Tests must cover multiply related within one tenant, rejected cross-tenant relations, unattached, historical-without-uploader, and private-profile/branding files as well as story media. Public/signed serving and caches must honor current policy after publication changes or revocation; possession of a historical URL is not a bypass.

When one legacy source blob is attached to resources in more than one community, Stage 2 creates a separate File identity, tenant-scoped storage key, and checksum-verified object for each destination community whose attachment is accepted for cutover. The manifest accounts for the source payload once and lists every destination copy plus each source attachment disposition. It never reuses one tenant's File/storage identity across communities; an attachment that cannot be accepted remains archived for explicit community/operator disposition.

## 7. Authentication, sessions, and sovereignty

### Passwords

Password hashing is behind a `PasswordHasher` abstraction. The domain contract stores the encoded hash and algorithm/version metadata rather than coupling the product to one library.

- New-password hashing must use a modern approved password KDF with parameters benchmarked on the supported Workers and Node runtimes before release.
- The verifier registry must recognize exact preserved source encodings and metadata for Rails bcrypt and Fastify V1 Argon2id PHC strings, including algorithm/version and encoded parameters. Unsupported, malformed, or tampered hashes fail closed without exposing which check failed.
- After successful verification of a source hash, V2 re-hashes with the current V2 policy and clears the source marker when the algorithm or parameters are obsolete. A Fastify Argon2id hash already satisfying the current V2 policy remains valid without an unnecessary rewrite.
- Every release profile, including Workers and the offline field kit, must support these source verifiers until the documented password-upgrade window closes; migration cannot make a valid source account unusable on a supported target.
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

### Audit logging

Security-relevant authentication, authorization, and administrative actions — login and logout, failed verification, session revocation, recovery, membership/role/publication changes, bootstrap and claim-token use, and file-authorization decisions — are audited. Audit entries carry actor ID, community ID, action, resource IDs, and outcome only. IP address and user-agent are permitted only on authentication and security-event entries, never on content-resource entries, and are retained at most 90 days with a configurable shorter retention.

Audit entries must never contain story/place/speaker content, media bytes or URLs, credentials, session tokens, or other protected content. The same content-free rule applies to failed and attacked actions. Audit logs obey the same community-isolation read rules as the content they reference.

### Bootstrap and account lifecycle

Preserve community and initial-administrator setup while replacing unsafe Rails setup mechanics. Bootstrap authority must be explicitly established for the intended fresh installation/community, work offline, and be invalidated after completion. Setup replay must not create privileged accounts or reset credentials. No production profile may depend on shipped privileged passwords. Provisioning an additional hosted community requires authorized system lifecycle action; it is not permission to reopen installation bootstrap. The first administrator of a newly provisioned hosted community receives access through a single-use, audited community-claim token with a maximum lifetime of 72 hours, configurable shorter per deployment. A claim token may be issued only for a community that has never had any administrator account — claimed, bootstrapped, or migrated — and that holds no community content; issuance closes permanently once any administrator exists. Issuing again before a claim invalidates the earlier token; after the first successful claim, account recovery follows only the community-authorized path in this section. The token is stored only as a hash and shown exactly once; it can never authenticate an existing account and can never authenticate as, or escalate into, a super-admin session. The claimant sets their own credentials at claim time. The claim record, including the issuer, is visible to the community's administrators. A super admin redeeming a token before the community handoff is an operator-trust residual; it is detectable because the legitimate claim then fails. The remedy for a legitimate claim that fails because the token was already redeemed is an operator deprovisioning and reprovisioning the still-empty community, which is itself an audited action.

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

## 10. Legacy source migration contract

Migration is a one-time deterministic ETL from a real supported legacy source into V2. The launch source profile is Rails PostgreSQL + ActiveStorage: production is the Rails application (`our.terrastories.app` on Heroku), and no deployed Fastify V1 installation holding community data is known. The Fastify V1 PostgreSQL-or-SQLite source profile (issue #168) is therefore **DEFER**: it is re-activated only when a named real Fastify V1 deployment with community data is identified. All Fastify mapping and fixture contracts in this specification remain the specification for that deferred profile and are not deleted. Migration is not a raw database conversion and does not read a live source directly into today's mutable V2 tables.

Migration is explicitly **two-stage**:

1. **Lossless source capture** — a source-profile adapter reads a consistent source database snapshot plus every referenced or discovered stored byte payload into one versioned portable migration-bundle format containing the discovered source schema/types, every source row, every stored object, provenance, and checksums. This stage is independent of the V2 physical schema.
2. **Canonical target transform** — read the verified bundle and map it into the approved canonical V2 logical schema for SQLite/D1-compatible and PostgreSQL targets, while producing field/table dispositions and validation evidence.

This separation lets Terrastories prove source preservation before target schema normalization is finished and prevents migration code from inheriting transient Fastify/V1 schema drift.

Cutover requires one enforced, auditable source-write boundary that includes relational writes, background jobs, attachments, and stored-object uploads. The default path is a community-approved maintenance window: disable and drain every source writer, place the legacy application in read-only mode, take the final consistent Stage-1 capture from that quiescent source, transform/validate it, switch traffic, and keep the legacy source read-only until target acceptance completes. A lower-downtime path is permitted only when an ordered durable change journal captures and checksum-accounts for every row, relation, attachment, and stored object after the initial snapshot; replay is idempotent, a final high-water mark is reconciled under a short write freeze, and no untracked dual-write window exists. A migration cannot be declared successful from an earlier snapshot while the source remains writable.

### 10.1 Source of truth for migration

The source-capture contract is pinned to the audited legacy repository revision and schema version used by fixtures. Every migration manifest records:

- source profile (`rails-postgresql` at launch; `fastify-postgresql` and `fastify-sqlite` only for the deferred Fastify profile under this section) and legacy repository commit/reference used by the migration contract;
- pinned Rails `schema.rb`/`schema_migrations` version for Rails, or pinned Fastify Drizzle schema/migration revision and configured storage profile for Fastify V1;
- observed source migration version when available;
- a digest of the actually discovered source schema;
- every discovered source table/column/type, including unknown/custom tables.

The Rails source-profile baseline includes:

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

The Fastify V1 source-profile baseline (deferred; it applies when the profile is re-activated under this section) includes every table/column represented by the pinned Drizzle schema and applied migration metadata, including communities, users/auth state, stories, places, speakers, relationship tables, files/media metadata, imports, sessions/operational state, and all configured local/object-storage bytes. Capture must run against the installation's actual PostgreSQL or SQLite dialect and actual storage layout; converting through the other dialect first is not source evidence. Unknown/custom tables and unrecognized stored objects follow the same dynamic-capture and explicit-disposition rules.

Legacy FactoryBot factories are useful for representative Rails values but are not sufficient as a migration schema contract. Integration fixtures must combine the exact/pinned Rails schema with production-valid edge states not represented by FactoryBot, and must separately exercise the exact pinned Fastify V1 PostgreSQL and SQLite schemas plus configured storage semantics.

Unknown/community-specific source tables must be captured automatically. A hand-maintained allowlist may make known-schema regressions fail closed, but it may not define the universe of data that is preserved.

### 10.2 Preservation rules

- Preserve legacy primary IDs for canonical domain records when doing so is safe; record any remap explicitly.
- Never invent required foreign keys/provenance merely to satisfy a stricter V2 schema.
- Preserve nulls and source precision when absence or granularity is meaningful; application creation rules may be stricter than import/storage rules. Rails speaker dates map to full canonical partial dates, while Fastify year-only values remain year-only and never gain invented month/day values.
- Map Rails story permission values and unrestricted Fastify story/place states deterministically to V2 visibility. Fastify elder/admin-restricted content requires explicit community-approved audience/archive disposition and never defaults to a broader audience.
- Preserve user role semantics, including `viewer` versus `member`.
- Preserve both legacy `role` and `super_admin` source values before normalization. Contradictory combinations require explicit/manual disposition and may not be guessed.
- Preserve every source username and email value so username-or-email login can survive cutover. Fastify accounts retain a null username until an authorized user assigns one; never synthesize an identifier. Duplicate or cross-kind ambiguous identifiers require community context or explicit operator resolution under Section 6.2 and may never use first-match behavior.
- Preserve every relationship edge and relationship multiplicity.
- Copy media bytes, MIME type, filename, byte size, checksum, attachment role, and a deterministic ordering signal for multi-attachments; verify checksums after write.
- Preserve legacy external media links.
- Classify every source V1 `mediaUrls`, `imageUrl`, `audioUrl`, or `photoUrl` value independently before removing those resource columns from the canonical runtime. A URL proven to reference source-owned media is recovered into `File` plus the correct typed relation with checksum evidence. A Story URL that represents externally hosted content is retained as a canonical external-media-link record with exact URL and source order. A redundant deployment-generated serving/signed URL is omitted from runtime only after its underlying media has been accounted for, while its raw value remains in the restricted legacy archive. Ambiguous, unsafe, unreachable, or unsupported values remain archived and require explicit community/operator disposition before the migration can succeed; the transform must not guess from filename or URL shape alone. The migration manifest records the classification and destination/archive reference for every value.
- Preserve exact Rails bcrypt and Fastify Argon2id PHC hashes with algorithm/version/parameter provenance for verification and policy-aware lazy upgrade.
- Never silently discard a source field. Fields intentionally absent from canonical V2 go to the machine-readable legacy archive.
- Structurally inconsistent or unmappable source rows remain losslessly present in the bundle/archive and fail or require explicit manual disposition before a migration run can be declared successful.

### 10.3 Source-capture bundle

Stage 1 produces a self-contained migration bundle. At minimum it contains:

1. a portable SQLite archive containing discovered source schema/type metadata and every relational source row;
2. every source stored-object byte payload, keyed by immutable source blob/File/storage identity;
3. a machine-readable manifest containing source-profile/revision/storage provenance, table/row counts, schema digest, per-table deterministic row digest, stored-object byte size, source checksum when present, and SHA-256;
4. a human-readable validation summary that contains counts/dispositions but not source row contents, password hashes, provider credentials, session/reset tokens, or other secrets.

Source values must be serialized without JavaScript precision loss. Numeric/decimal/bigint/timestamp values therefore use a source-database canonical representation plus explicit source column types, or an equivalently lossless encoding.

The bundle is sensitive community data:

- create it with owner-only permissions by default where the platform supports POSIX permissions;
- never log source rows, password hashes, reset tokens, provider credentials, database URLs, or protected media;
- encrypt it at rest whenever it leaves a trusted migration host or is retained as a backup/artifact;
- never upload a real community migration bundle to CI, public Actions artifacts, or third-party review services;
- keep retention/deletion under community/operator control.

Stage 1 must fail closed on a missing/mismatched required source-profile schema or migration revision, unsupported storage profile, source read inconsistency, missing stored-object bytes, byte-size mismatch, checksum mismatch, destination overwrite, or unexplained capture-count changes. Failure must not leave a destination that can be mistaken for a successful bundle.

### 10.4 Canonical target artifacts

Stage 2 produces:

1. the V2 database for the chosen target;
2. migrated media/storage objects;
3. a machine-readable migration manifest with source/bundle/target counts, ID mappings, field dispositions, warnings, and checksums;
4. a restricted **legacy archive** containing every data-bearing source row/field not represented canonically in V2 and every discovered stored-object payload not copied to canonical storage, normally sourced directly from the verified Stage-1 bundle rather than reconstructed after transformation;
5. a human-readable validation summary that fails the run on unexplained differences.

The legacy archive is not queried by the runtime application and must not become a backdoor around community authorization. It exists solely to make intentional model simplification compatible with zero unintended data loss.

The Stage-2 legacy archive and any retained copies inherit every concrete bundle protection in Section 10.3: owner-only creation where supported, encryption when leaving the trusted migration host or retained as backup/artifact, no real data in CI/public/third-party artifacts, no secret/source-row logging, and community/operator-controlled retention/deletion. Restricted manifests and machine-readable dispositions containing sensitive data receive the same controls; human-readable summaries contain counts/disposition references only. Validation must reject unsafe archive permissions/transfer destinations, secret-bearing summaries, and unprotected retained artifacts rather than treating the word "restricted" as sufficient evidence.

Archived stored-object payloads use immutable source keys plus byte size and checksum metadata. The verified Stage-1 bundle may be deleted only after every discovered payload has exactly one manifest disposition whose complete destination set is checksum-verified: one or more tenant-scoped canonical objects when accepted attachments require fan-out, or one protected archive object when no canonical copy exists.

### 10.5 Validation gates

A migration is successful only when automated checks prove:

- source capture accounts for every discovered source table, row, column/type, and stored-object payload;
- source and target/archive account for every source table, row, and data-bearing column;
- canonical entity counts and IDs match the migration manifest;
- all foreign keys and many-to-many edges are accounted for;
- nullable/edge states survive correctly;
- every source stored-object payload, including unattached/orphan ActiveStorage blobs and unrecognized Fastify storage objects, is checksum-accounted in canonical storage or the protected Stage-2 archive, and every attachment/File reference is mapped to its payload and canonical/archive disposition;
- Theme static-map and community/user/place/speaker/story attachment roles are represented;
- multi-attachment ordering is deterministic and explicitly mapped;
- external media links are preserved;
- username/email login identities, including null Fastify usernames and cross-community duplicate emails, match the unambiguous experience contract;
- Rails bcrypt and Fastify Argon2id accounts authenticate on every release profile, reject malformed/tampered hashes, and upgrade only when the source algorithm/parameters are outside current policy;
- contradictory role/super-admin state cannot be silently normalized;
- public/private/disabled community behavior is preserved, including private-community override of public stories;
- Fastify restricted stories and places remain unavailable until their explicit community-approved audience/archive disposition, and never widen through canonical mapping or direct/list/search/map/count/media/story-derived projections;
- every Fastify theme row is archived/dispositioned, and zero/multiple active-theme states require explicit community selection rather than implicit ordering;
- Rails story topics and Fastify V1 story tags retain their complete values and filtering behavior through the canonical tags list;
- known Rails beta/Flipper-gated outcomes map to canonical V2 capabilities, and every unknown/custom active source flag has an explicit RETAIN/IMPROVE/ARCHIVE disposition;
- public map/filter data remains representable;
- migration is deterministic and safe to re-run against a fresh destination;
- failure is atomic or leaves an explicitly disposable incomplete destination, never a falsely successful partial migration.

The same canonical migrated fixture must validate on SQLite/D1-compatible and PostgreSQL V2 targets. SQLite export is additionally required for field-kit migration.

## 11. Legacy disposition at V2 launch

| Legacy/V1 concept                                | V2 disposition                                             | Rationale                                                                                                                                                                                               |
| ------------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Communities, stories, places, speakers           | RETAIN/IMPROVE                                             | Core Terrastories domain                                                                                                                                                                                |
| Rails story permission levels                    | IMPROVE                                                    | One `visibility` enum preserves the same audience distinctions                                                                                                                                          |
| Rails story topic / Fastify V1 story tags        | IMPROVE                                                    | One portable ordered tags list preserves singular and multi-value taxonomy/filter behavior                                                                                                              |
| Rails `viewer` and `member` distinction          | RETAIN                                                     | User-visible access difference must survive                                                                                                                                                             |
| Username-or-email login                          | RETAIN                                                     | Established login experience; both identifiers migrate                                                                                                                                                  |
| Story/place/speaker relationships                | RETAIN                                                     | Core narrative/map data                                                                                                                                                                                 |
| Uploaded media and external media links          | IMPROVE                                                    | Normalize around `File` + explicit relations; preserve every item                                                                                                                                       |
| Community/user/place/speaker attachments         | IMPROVE                                                    | Normalize into the same media system                                                                                                                                                                    |
| Theme `static_map` attachment                    | IMPROVE                                                    | Preserve through canonical File/map configuration relation                                                                                                                                              |
| Rails Theme                                      | IMPROVE                                                    | Replace provider-specific singleton theme with `CommunityMapConfig`                                                                                                                                     |
| Fastify multiple themes per community            | IMPROVE/ARCHIVE                                            | Community selects one canonical configuration; every source row remains accounted for                                                                                                                   |
| Map provider credentials in DB                   | IMPROVE/ARCHIVE                                            | Move secrets out of domain rows; preserve source value in restricted migration artifact                                                                                                                 |
| CSV imports                                      | RETAIN/IMPROVE                                             | Preserve user workflow with a typed/validated V2 implementation                                                                                                                                         |
| Rails `curriculums`                              | ARCHIVE by default                                         | Schema exists but no current Rails route exposes it; do not rebuild runtime product without evidence of active user need                                                                                |
| Rails `beta` / known Flipper state               | IMPROVE/ARCHIVE                                            | Preserve publication/settings outcomes as canonical V2 capabilities; archive legacy gating state; classify custom keys                                                                                  |
| Fastify elder role/elder-only policy             | DROP                                                       | Remove scope creep; persisted restricted rows require community-approved canonical audience or archive-only disposition                                                                                 |
| Cultural-significance/settings/context V1 fields | DROP from canonical runtime; archive if source data exists | Avoid unreviewed cultural-protocol semantics                                                                                                                                                            |
| PostGIS behavior                                 | DROP                                                       | Portability and offline operation are higher-value requirements                                                                                                                                         |
| Persisted V1 resource media URL fields           | IMPROVE/ARCHIVE                                            | Classify each value; retain external story links or recover owned media, while archiving redundant/unsupported raw values                                                                               |
| Cross-community file copy-for-publication        | DEFER                                                      | Not a launch capability; launch rejects cross-tenant attachment fail-closed; deferred design recorded in Section 6.7                                                                                    |
| Fastify V1 source capture (#168)                 | DEFER                                                      | No deployed Fastify V1 installation holding community data is known; production is Rails (`our.terrastories.app`). Re-activate on a named real deployment; mapping contracts retained in Sections 6/10. |

## 12. Testing and release gates

### Canonical contract tests

Build a fail-closed V2 behavior contract suite. It defines approved V2 behavior and must cover public, authenticated community, admin, auth/session, media, import, spatial, validation/error, and sovereignty paths.

Legacy/Fastify comparison tests may help discover omissions, but an old behavior becomes normative only after it is classified under Section 3 and represented in this spec/contract.

Public contract tests must specifically prove that community publication/lifecycle gates override story-level public visibility across list/detail/search/map/media paths.

Authentication contract tests must cover username and email login identifiers for migrated and new V2 users according to the approved uniqueness rules, including imported accounts without usernames, duplicate emails across communities, required community disambiguation, identifier case/cross-kind collisions, and non-enumerating failures.

### Database tests

Required CI must exercise shared schema/repository/migration behavior against both:

- SQLite/D1-compatible execution; and
- PostgreSQL.

Both paths must cover fresh schema creation, supported upgrades, constraints, indexes, timestamps, booleans, null/unique behavior, transactions, JSON serialization, ordering/pagination, and portable spatial behavior.

### Migration tests

Migration CI uses synthetic fixtures only; never real community data. It must include:

- the pinned Rails `schema.rb` and an executable PostgreSQL equivalent;
- the pinned Fastify V1 schema/migration state executed against both PostgreSQL and SQLite, with representative File/local/object-storage records and bytes;
- every Rails role and story permission value, plus blank/nonblank Rails topics and ordered multi-value Fastify V1 tags;
- Fastify users without usernames, duplicate emails across communities, same-community/case/cross-kind collisions, valid Rails bcrypt and Fastify Argon2id parameter variants, and malformed/tampered hashes;
- every recognized Fastify story `privacyLevel` combined with both `isRestricted` states, unknown/contradictory values, and restricted/unrestricted places linked to stories with every canonical audience;
- Fastify communities with zero, one, and multiple active themes plus inactive alternatives, proving explicit selection and complete row disposition;
- nullable and edge states such as missing place coordinates and system users without community IDs;
- all relationship tables, external media links, and persisted resource media URL fields, including source-owned, externally hosted, redundant derived, ambiguous, and URL-only media cases;
- curriculums and operational tables;
- every relevant ActiveStorage attachment role, including Theme `static_map`;
- deterministic attached and unattached/orphan blob payloads with known size/checksum, proving each byte payload reaches canonical storage or the protected Stage-2 archive before Stage-1 deletion;
- one source blob attached within multiple communities, proving checksum-verified tenant-scoped fan-out and complete attachment disposition without cross-tenant File reuse;
- writes attempted during cutover, proving the enforced read-only boundary or journal/high-water reconciliation includes relational, attachment, and stored-object changes for each source profile;
- at least one unexpected/custom source table proving dynamic capture;
- corruption/missing-media and destination-overwrite negative tests.
  Rails Stage-1 capture tests run against real PostgreSQL/ActiveStorage semantics. Fastify V1 Stage-1 capture tests run against real PostgreSQL and SQLite semantics plus the supported configured storage profiles; the Fastify fixture requirements above apply when that deferred profile is re-activated (Section 10), while Rails is the launch requirement. Stage-2 mapping tests run each source-profile bundle into both SQLite/D1-compatible and PostgreSQL V2 targets.

### Deployment tests

Release evidence is per profile — Workers+D1+R2, Node+PostgreSQL, and offline Node+SQLite — matching `docs/SOURCE-OF-TRUTH.md`: readiness for one profile never waits on another. Field-kit tests must fail if a required runtime path reaches an external cloud dependency.

### Security tests

Auth, sessions, files/media, imports, migration, community isolation, public/private visibility, exports, and super-admin boundaries require negative/adversarial coverage.

Audit-log tests must prove that entries for successful, failed, and attacked actions carry only actor/community/action/resource IDs and outcome — never story/place/speaker content, media, credentials, or tokens (Section 7). Authentication and security-event entries may additionally carry IP address and user-agent under the Section 7 network-metadata rule; entries for content-resource actions never carry them.

Community-claim-token tests must prove: issuance is refused for a community that has, or has ever had, any administrator account — in particular for a migrated community and for a bootstrapped community — and for a community that holds community content; reissuance invalidates the earlier token; issuance is permanently closed once any administrator exists; a consumed, expired, or superseded token cannot claim or authenticate any existing account; only the token hash is stored and the raw token is shown exactly once; the claimant sets their own credentials; and the claim record, including the issuer, is visible to the community's administrators while the raw token never is.

## 13. Phased path

1. **Contract correction** — approve this V2 source-of-truth model and update dependent issues/plans.
2. **Migration source preservation** — land the independently reviewable Stage-1 Rails (#164) source adapter that emits the portable bundle contract, pinned to the real Rails schema/storage semantics; it cannot establish canonical target mappings before this spec is accepted. The Fastify V1 adapter (#168) is DEFER (Section 10).
3. **Transport foundation** — finish Hono coexistence while treating canonical V2 behavior, not Fastify parity, as destination truth.
4. **Three-profile feasibility gate** — before broad domain/schema normalization, prove login, protected media serving, session revocation, legacy password verification (Rails bcrypt), and import transaction limits on real Cloudflare Workers/D1/R2 and both Node profiles (PostgreSQL and offline SQLite). This gate mirrors the roadmap's early deployment proof. A failure requires an explicit scope or platform decision; a profile is never silently dropped, and one profile's readiness never waits on another.
5. **Domain/schema normalization** — remove V1 scope creep and duplicated privacy/media/provider concepts; establish the canonical logical schema on both DB targets.
6. **Production adapters** — D1/PostgreSQL/SQLite, R2/local storage, durable sessions, password hashing, deployment hardening.
7. **Canonical migration transform** — consume each verified source-profile bundle (Rails at launch; Fastify V1 when its deferred profile is re-activated) into the finalized V2 SQLite/PostgreSQL schemas with field dispositions, media migration, and archive validation.
8. **Frontend/cutover validation** — prove established user workflows against migrated representative data before production cutover.
9. **Release** — exact-revision production-readiness gate, declared per profile across hosted, self-hosted, and field-kit deployments.

## 14. Resolved architectural decisions

| Question                            | Decision                                                                                                                                                                                                                            |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Legacy compatibility target?        | Preserve user experience and data; do not preserve Rails/Fastify wire/internal compatibility.                                                                                                                                       |
| HTTP framework?                     | Hono.                                                                                                                                                                                                                               |
| Database targets?                   | D1/SQLite and PostgreSQL equal first-class.                                                                                                                                                                                         |
| Physical schema?                    | One logical schema/behavior contract; dialect-specific definitions/migrations allowed when required.                                                                                                                                |
| Spatial behavior?                   | Plain lat/lng + application-level portable logic; no PostGIS.                                                                                                                                                                       |
| Story privacy?                      | One `public / community / editors` audience field; public requests also require a public active community, while authenticated own-community access follows Section 6.2.                                                            |
| Place privacy?                      | One `public / community / editors` audience field; story relationships cannot widen it, and Fastify restrictions require community disposition because elder access has no equivalent.                                              |
| User roles?                         | `viewer`, `member`, `editor`, `admin`, `super_admin`; no elder role.                                                                                                                                                                |
| Login identity?                     | Preserve username-or-email login; Fastify imports may have no username, and ambiguous cross-community email matches require community context rather than first-match lookup.                                                       |
| Sessions?                           | Durable database-backed authoritative sessions; memory dev/test only.                                                                                                                                                               |
| Media?                              | One `File` identity model + explicit typed relations; URLs derived by storage adapter; Theme static map included.                                                                                                                   |
| Map configuration?                  | One provider-neutral `CommunityMapConfig` per community; ambiguous Fastify multi-theme state requires community selection; provider credentials are secrets.                                                                        |
| Legacy removed data?                | Preserve in migration archive; never silently discard.                                                                                                                                                                              |
| Rails beta/Flipper?                 | Known `public_communities` and `split_settings` outcomes become normal V2 publication/settings capabilities; archive gating state. Custom active keys require migration disposition.                                                |
| Password migration?                 | Verify preserved Rails bcrypt and Fastify Argon2id on every profile; rehash after login only when the source hash falls outside current V2 policy.                                                                                  |
| Migration strategy?                 | Two-stage: lossless Rails PostgreSQL/ActiveStorage source capture, then deterministic bundle-to-canonical-V2 transform; the Fastify V1 source profile is DEFER (Section 10) and uses the same two-stage contract when re-activated. |
| API compatibility after V2 release? | Protect released V2 contracts with OpenAPI/contract CI and explicit versioning/deprecation policy.                                                                                                                                  |

## 15. Change log

| Date       | Changes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-27 | Direction review round (PR #163, both frontier reviews "endorse with changes"): Fastify V1 source capture (#168) deferred — production is Rails (`our.terrastories.app` on Heroku) and no deployed Fastify V1 installation holding community data is known; Rails capture is the launch requirement and Fastify mapping contracts are retained for the future profile. Added the three-profile feasibility gate before domain/schema normalization (login, protected media, revocation, legacy password verification, import transaction limits on real Workers/D1/R2 and both Node profiles). Per-profile release readiness; hosted data placement/jurisdiction is the community's decision; community cutover blocked until a named client revision passes Section 4. |
| 2026-09-27 | Third review round (PR #163): claim-token issuance restricted to communities that never had any administrator and hold no content, with migrated/bootstrapped refusal tests and a 72-hour maximum lifetime; deprovision/reprovision remedy for stolen first claims; complete Fastify role mapping (viewer to member preserving the source's effective audience, admin/editor identity, null/unknown Rails roles to manual disposition); `usernameNormalized` global-unique identity column; Rails empty-string username imports as null.                                                                                                                                                                                                                                |
| 2026-09-27 | Re-review amendments (PR #163): bounded community-claim token lifecycle with matching security tests; Fastify V1 rows in the role/super_admin mapping (communityId-free super admins, elder disposition, Rails orphan row); application-normalized `emailNormalized`/`StoryTag.valueNormalized` columns with all unique indexes and filters on them and no database case-folding; audit network-metadata rule (authentication/security events only, ≤90-day configurable retention); speaker lifecycle wording in approved public assets.                                                                                                                                                                                                                               |
| 2026-09-27 | Independent review amendments (PR #163): content-free audit-log contract with negative tests; single-use community-claim token for hosted-community first administrators; explicit Rails role/super_admin mapping with communityId-free super admins; portable null-community email partial unique index; place visibility necessary-but-not-sufficient with defined approved public assets; cross-community copy-for-publication deferred to launch rejection; portable relational story-tag storage.                                                                                                                                                                                                                                                                  |
| 2026-09-10 | Added the Fastify V1 account, password, restriction, and theme transform contracts: nullable imported usernames with unambiguous community-aware email login; Argon2id preservation and policy-aware upgrade; fail-closed story/place audiences; and community selection for ambiguous multi-theme state.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 2026-09-08 | Pinned legacy behavior evidence; separated publication from authenticated story audiences; specified safe setup, community-admin stewardship, unambiguous identities, local recovery, import fidelity, disconnected browser acceptance, and named continuity/release owners.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 2026-08-28 | Reframed V2 from legacy wire/feature parity to intentional evolution: preserve user experience and all source data while simplifying the domain. Added canonical visibility/role/media/map/session models, real Rails migration contract, archive requirement for intentionally removed data, and V2-native contract testing.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 2026-08-28 | Addressed independent architecture review: made private/disabled community precedence explicit, preserved username-or-email login, added Theme static-map migration, required active beta/Flipper disposition, split migration into lossless source capture plus canonical target transform, and strengthened archive fidelity/security and contradictory-role handling.                                                                                                                                                                                                                                                                                                                                                                                                |
| 2026-08-28 | Audited the pinned Rails feature flags and resolved known `public_communities`/`split_settings` outcomes as unconditional canonical V2 publication/settings capabilities while retaining legacy beta/Flipper state in migration artifacts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 2026-08-17 | Reaffirmed Hono, equal D1/SQLite + PostgreSQL targets, field-kit support, no PostGIS, and sovereignty constraints.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 2026-06-07 | Initial V2 Cloudflare/Hono specification.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
