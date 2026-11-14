# Terrastories API V2 — Technical Specification

| Field       | Value                                                                                  |
| ----------- | -------------------------------------------------------------------------------------- |
| **Status**  | Canonical — product/architecture source of truth (approved; PR #163 merged 2026-09-28) |
| **Created** | 2026-06-07                                                                             |
| **Updated** | 2026-11-12                                                                             |
| **Authors** | Terrastories Team                                                                      |
| **Repo**    | `terrastories-api`                                                                     |

---

## 1. Product intent

Terrastories V2 is a deliberate rebuild of the Terrastories backend for long-term maintainability, Indigenous data sovereignty, offline use, and simple deployment. Free hosting is a requirement: every launch profile must run at zero recurring hosting cost (#184).

The legacy Rails application and the Fastify V1 API are **evidence**, not compatibility contracts. V2 does not aim for wire compatibility, identical database schemas, identical endpoint names, or internal architectural parity. Instead, V2 preserves the user-visible Terrastories experience and all community data while intentionally improving the underlying domain model, API, security boundaries, deployment model, and implementation stack.

The governing rule is:

> Preserve the mission, user-visible capabilities, community data, and sovereignty guarantees. Redesign implementation details when the V2 design is simpler, safer, more portable, or easier to maintain. Every material legacy/V1 divergence must be intentional and documented.

## 2. Goals and non-goals

### Goals

| ID  | Goal                                                                                                                                                                                                                                                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| G-1 | Run one product across three launch profiles: Cloudflare Workers Free + D1 + R2 (hosted), Node.js with SQLite or PostgreSQL (self-hosted), and the offline Node.js + SQLite field kit (#195). SQLite and PostgreSQL both remain runtime targets (#196 closed).                                                     |
| G-2 | Preserve the user-visible Terrastories experience: public storytelling/map discovery, community content management, visibility rules, media, map configuration, branding, imports, onboarding, profile/auth flows, and system administration needed to operate communities.                                        |
| G-3 | Migrate legacy Rails installations with **zero unintended data loss**. Every source row, relation, attachment, field, and stored byte payload must be mapped, transformed, or preserved in a migration archive with a machine-readable disposition. Fastify-era source-profile details are deferred to Appendix A. |
| G-4 | Make D1/SQLite and PostgreSQL equal first-class database targets for shared product semantics.                                                                                                                                                                                                                     |
| G-5 | Keep field-kit deployments fully usable without runtime cloud dependencies.                                                                                                                                                                                                                                        |
| G-6 | Enforce community isolation and Indigenous data sovereignty structurally and with negative tests.                                                                                                                                                                                                                  |
| G-7 | Provide a small, explicit, versioned V2 API contract that is easier to maintain and evolve than Rails or Fastify V1.                                                                                                                                                                                               |
| G-8 | Remove accidental V1 scope and duplicated domain concepts rather than carrying them forward indefinitely.                                                                                                                                                                                                          |
| G-9 | Every launch profile runs at zero recurring hosting cost; Section 5 holds the cost envelope (#184).                                                                                                                                                                                                                |

### Non-goals

- Wire compatibility with legacy Rails endpoints or Fastify V1, with exactly one exception: the read-only, transitional Explore read adapter (#198), see Section 9.
- Reproducing Rails/Fastify response shapes solely for compatibility, except the Explore read adapter (#198, Section 9).
- Preserving obsolete internal models when their user-visible outcome can be represented more simply.
- Low-downtime cutover (change journal, dual-write reconciliation). Cutover uses a maintenance window only (#197).
- Fastify-era extras that legacy Rails lacks (Appendix A) are not launch scope (#189).
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
- filtering/search by place, region, place type, topic, language, speaker, and speaker affiliation where data exists; `topic` is the single Rails topic — no multi-value tags at launch (#189);
- community map style/view configuration and community branding assets.
- map-to-story and story-to-map selection, plus newest-first and title ascending/descending ordering with a stable tie-breaker;
- meaningful story description formatting through the sanitised-HTML allowlist in Section 6.9 (#188); migration preserves the original source and records any sanitisation/transformation.

Public story visibility is an intersection, never a story-only decision. A public request may expose a story only when **all** relevant publication gates allow it. At minimum:

```text
community.visibility == public
AND community.status == active
AND story.visibility == public
```

A private or disabled community therefore always overrides a story marked `public`. Public list, detail, search, filter, map-point, media, and metadata paths must test this rule fail-closed.

### Community member experience

V2 must support:

- login with the same login identifier concept as Rails: a user may authenticate with either their unique `username` or their `email`, plus password; the community slug is the community locator at login (#188);
- login/logout, profile, and password-management flows;
- recovery through community-admin password reset plus one-time recovery codes created at first-admin setup, or at a migrated administrator's first V2 login (#188);
- community-scoped story, place, speaker, user, and map-configuration management according to role;
- uploaded story media, place/speaker/user/community images, place-name audio, theme/static-map media, and external story links;
- CSV preview/import capability for places, speakers, and stories, with validation before commit;
- onboarding required to create/configure a community and its initial administrator.

Changing username-or-email login to email-only or username-only is a product change and requires explicit approval plus migration/UX handling.

CSV imports must preview explicit header/field mappings, audience values, related records, media references, duplicate handling, and row errors before committing. Unknown audience values or missing referenced media cannot silently become public content or disappear. Creation of related places/speakers must be included in the preview and use the same community authorization as direct creation.

The accepted preview is stored as an immutable normalized `ImportManifest` (Section 6.9): the accepted normalized rows, explicit mappings, row errors, and a reference to the immutable uploaded CSV. The commit applies exactly those rows. A commit is all-or-nothing for the whole manifest in one portable database transaction (a single batch on D1): all rows, related records, relations, File metadata, and import-result state commit together. Media bytes are staged and checksum-verified before commit and stay unreachable until the commit makes their attachments visible; the relational commit is the single visibility point. A failed validation or commit exposes no imported content, and cleanup of unreferenced staged bytes is restart-safe. Committing a manifest that is already committed returns its recorded result and never applies rows again; a manifest is committed at most once (#197). No failure may leave partially visible rows or media. On Workers the import must fit the D1 batch and daily write limits in Section 5; a preview whose commit would exceed them is rejected at preview with a clear error, never partially committed (#197). This is an improvement over Rails import coercion/partial-save behavior, distinct from the lossless Rails deployment migration in Section 10.

### System administration

V2 must support system-level community/user lifecycle operations required to operate hosted deployments. System privilege must not imply access to protected community content.

### Compatibility boundary

The experience contract is normative; Rails routes, Jbuilder payloads, Fastify routes, CSS/layout, and database column names are not. Frontends may require an intentional adapter/migration to consume V2.

### Launch continuity scenarios and ownership

API contracts alone do not prove user-experience continuity. Frontend work starts after the API is done (#185). Until then: (1) the Explore read adapter (#198) lets the existing Terrastories Explore client read V2 (Section 9); (2) the persona-based QA script (#199) emulates every frontend call per persona and is the gate that the API is ready for frontend work; it runs against each launch profile, fails closed, and becomes a #147 release gate. Issue #147 owns integration evidence and must name the frontend revisions, their responsible maintainers, and the pilot community approver before cutover; a community's cutover stays blocked until a named client revision passes the Section 4 scenarios for that community's deployment profile. Issue #134 owns the reusable contract harness, #145/#146 the domain cases, and #139 the shared authorization matrix. Frontend implementation can live in separate repositories; it remains a dependency of product release.

| Scenario                         | Required observable outcome                                                                                                                              | Implementation/evidence owner |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Public discovery and publication | Public active community exposes only approved stories, points, filters, related metadata, and media; privatizing/disabling closes every public path      | #139, #145, #146              |
| Private community and roles      | Own-community viewer/member/editor/admin receive their distinct story audiences; cross-community and system privilege do not expand protected access     | #139, #146                    |
| Accounts and setup               | Migrated username and email login, password change, authorized local recovery, restart/revocation, and safe initial community/admin setup                | #137, #126, #146              |
| Browse and manage                | Select map point/story in either direction; filter/sort; view interview/speaker/place data; authorized create/edit/delete and safe description rendering | #145, #147                    |
| Media and branding               | Play uploaded audio/video, display images, play place-name audio, render static maps and ordered branding assets after migration                         | #140, #145, #147              |
| Import and preservation          | Preview/commit related CSV data with explicit errors; verify migrated rows, relations, bytes, and runtime/archive dispositions separately                | #123, #135, #147              |
| Disconnected field kit           | Cold-start browser and server without internet; local login, map, media, editing/import, recovery, and restart remain usable                             | #137, #140, #142, #147        |
| Export and erasure               | Community admin exports JSON + media ZIP, including while disabled; erasure completes within 30 days incl. backups                                       | #187, #139                    |
| API readiness for frontend       | Persona QA script passes on each launch profile                                                                                                          | #199, #147                    |

Every row requires success and applicable negative cases using migrated synthetic representative data, including multilingual content. Each pilot additionally needs community-approved disposition of runtime capability removals: successful archival is data preservation, not proof that a lost workflow is acceptable. Uncovered required scenarios block cutover. Discovery of active custom features or curriculum use reopens the deployment's disposition decision rather than silently expanding or reducing launch scope.

## 5. Deployment architecture

Launch profiles (#195):

| Profile         | Runtime                        | Database             | Storage                                                     | Reference artifact                                                                                        | Runtime cloud dependency                       |
| --------------- | ------------------------------ | -------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| **Hosted**      | Cloudflare Workers (Free plan) | D1                   | R2                                                          | Worker deployment version                                                                                 | Cloudflare only                                |
| **Self-hosted** | Node.js                        | SQLite or PostgreSQL | local filesystem (or a configured self-hosted object store) | one small VM image, identical to the field kit; PostgreSQL is a supported configuration of the same build | none beyond configured deployment dependencies |
| **Field kit**   | Node.js                        | SQLite               | local filesystem                                            | the same VM image as self-hosted                                                                          | none                                           |

The self-hosted reference image is the field-kit image (Node + SQLite + local media + file backup), so one artifact carries both sets of release evidence (#197). PostgreSQL remains a first-class runtime target (#196 closed: both SQLite and PostgreSQL stay).

All profiles share domain/service behavior. Runtime, database, storage, hashing, and session implementations live behind explicit adapters where platform differences require them.

### Cost envelope (#184)

Free hosting is a requirement. Funding a paid plan is not an option for launch.

| Profile         | Named host                                                                            | Quotas that bound the profile                                                                                                                                                                  | Media cap                                                     | Expected monthly cost                     |
| --------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------- |
| **Hosted**      | Cloudflare Workers Free + D1 Free + R2 free tier                                      | 100,000 Worker requests/day; 10 ms CPU per invocation; D1 5 million rows read/day, 100,000 rows written/day, 500 MB per database; R2 1 million Class A and 10 million Class B operations/month | 10 GB-month R2 storage per account; 100 MB per upload request | USD 0                                     |
| **Self-hosted** | community-chosen free-tier VM or community-owned hardware running the reference image | host CPU, RAM and disk                                                                                                                                                                         | host disk                                                     | USD 0 on a free-tier VM or owned hardware |
| **Field kit**   | community-owned field-kit hardware                                                    | device CPU, RAM and disk                                                                                                                                                                       | device disk                                                   | USD 0 recurring                           |

Notes:

- Quotas are per Cloudflare account and shared by every community the account hosts.
- The D1 write quota is shared by logins, rate-limit counters and imports — one large community import used about 30% of a day's writes in #194, so the import tool must stay inside the daily quota.
- Media beyond 100 MB per request needs multipart or presigned direct-to-R2 upload.
- Communities whose media exceed the R2 free tier use the self-hosted or field-kit profile.
- Quota values are as measured or read at the time of the #194 spike; re-verify at release. Sources: https://developers.cloudflare.com/workers/platform/limits/ , https://developers.cloudflare.com/d1/platform/pricing/ , https://developers.cloudflare.com/d1/platform/limits/ , https://developers.cloudflare.com/r2/pricing/ .
- The 10 ms CPU limit rules out any server-side password KDF on Workers (Section 7).

For the hosted profile, data placement and jurisdiction are the community's decision; communities that cannot accept a given hosting jurisdiction use the self-hosted or field-kit profiles.

### Portability invariant

There is one canonical **logical relational schema and behavior contract**. Dialect-specific Drizzle definitions or migration files are allowed when tooling requires them, but SQLite/D1 and PostgreSQL may not expose different product semantics.

Shared behavior must remain SQLite-compatible. PostgreSQL-only extensions may not become product requirements.

### Offline profile

Field kits package the frontend, API, database, uploaded media, map styles/tiles and their glyph/sprite/font dependencies for local serving. Cloud URLs and provider credentials must not override offline configuration. A locally hosted map service is permitted; internet services are not required at runtime. Deployment acceptance includes cold-start browser tests with external network access blocked, not just SQLite or container configuration checks.

External media links remain preserved as links. Offline clients show a clear unavailable-offline state without automatic remote requests; an external link does not promise a local copy of the remote content. Downloading third-party content or adding hosted/field-kit synchronization is not a launch requirement. Locally imported/uploaded media remains fully usable offline. Account recovery follows the offline procedure in Section 7 (community-admin reset plus one-time recovery codes; no email and no cloud identity services).

## 6. Canonical domain model

The schema below describes V2 product concepts. Physical database details may vary by dialect while preserving these semantics.

The launch model is Rails parity plus only what sovereignty requires (#189). Fastify-era extras that Rails lacks — place visibility, speaker status, speaker biography, partial year-only birth dates, `storyRole`/`sortOrder` on story relations, multi-value story tags — move to Appendix A and are not launch scope. Nullable `username` stays only because a Rails row may hold the blank default username.

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
- Rails `beta` and the Fastify `culturalSettings` blob are not canonical community domain fields; `culturalSettings` is DROP (Section 11). The audited Rails beta/Flipper-gated outcomes are represented directly by canonical V2 capabilities; raw legacy values remain in migration artifacts, and unknown/custom active flags require explicit Stage-2 disposition.

### 6.2 User and roles

```text
User
  id
  email?
  username?
  displayName?
  passwordVerifier?      SHA-256 of the client-derived key; null for code-only accounts
  passwordAlgorithm?     client-argon2id+sha256 | client-bcrypt-rails+sha256
  passwordSalt?
  passwordParams?        KDF parameters (Argon2id m/t/p, or bcrypt cost)
  usernameNormalized?
  emailNormalized?
  role: viewer | member | editor | admin | super_admin
  communityId?
  status: active | disabled
  createdAt
  updatedAt
```

`passwordVerifier` is nullable so an account that signs in only with admin-issued codes needs no password (#184).

Role meanings:

- `viewer` — may view the `public` story audience within their own active community, including when that community is private; cannot view `community` or `editors` stories.
- `member` — may view public and community-visible content for their community.
- `editor` — member access plus content creation/editing.
- `admin` — editor access plus community/user administration.
- `super_admin` — system-level administration only; does not gain protected community-content access through privilege.

`communityId` is required for community roles and nullable for `super_admin`.

Community publication and story audience are separate axes. For authenticated own-community access, an active community's `private` status does not block the role's permitted story audience. `member` adds the `community` audience; `editor`/`admin` add `editors`. Anonymous and other-community access use the public intersection in Section 4; no role grants protected access across communities. A disabled community denies community-content access for every role, except that community administrators keep export (Section 7, #187); authorized system lifecycle operations may still restore service without reading protected content. A super admin may consume public projections only on the same terms as any public caller. Place, speaker and media visibility follows the decision table in Section 6.4a (#190). Authenticated own-profile photos and private community branding/map assets follow their resource-specific same-community policy, not a requirement to be attached to a public story.

V2 keeps the meaningful Rails `member` versus `viewer` distinction because it affects the user-visible privacy model. The duplicated Rails `super_admin` boolean is normalized into the role enum for canonical V2 rows, but migration must first preserve both raw values. Contradictory source combinations must fail/manual-disposition canonical mapping rather than being guessed.

The mapping is explicit for the Rails source profile (Fastify V1 role-mapping rows move to Appendix A):

```text
Source profile and state                                         | Canonical V2 mapping
Rails: any role, super_admin = false, community_id present       | same role; communityId preserved
Rails: any role, super_admin = true, community_id absent         | super_admin; communityId null
Rails: any community role, super_admin = true, community_id set  | manual disposition; both privileges preserved in evidence
Rails: super_admin = false, community_id null                    | manual disposition (orphan); preserved in evidence
Rails: null or unknown/out-of-range role                          | manual disposition; preserved in evidence
```

A canonical V2 `super_admin` row never carries a `communityId`. A source row that combines `super_admin = true` with a community role and a non-null community holds two privileges with no canonical single-row representation: migration preserves both raw values in the evidence and requires explicit manual disposition; neither privilege is dropped silently or resolved by a default rule.

`username` is required for new V2 accounts and for an imported Rails account whose source username is non-blank. A Rails `""` username (the column default) imports as null; never synthesize a username. When present it is a stable globally unique login identifier. An authorized community account-management flow may later assign a unique username. Username uniqueness and lookup use an application-maintained `usernameNormalized` column with a global unique index, following the same no-database-case-folding rule; login lookup and username-versus-email collision checks compare on it. Rails emails are not unique (a non-unique index), so email may identify different accounts in different communities, and email uniqueness is enforced on application-normalized values: the schema stores an `emailNormalized` column maintained by the application, and every unique index and identity filter uses it — the community-scoped unique index on `(communityId, emailNormalized)` and a portable partial unique index on `emailNormalized` `WHERE communityId IS NULL` for null-community (`super_admin`) accounts. SQLite/D1 and PostgreSQL both support partial unique indexes; a plain `UNIQUE(communityId, email)` on the raw column treats NULLs as distinct on both backends and does not block case collisions within a community, so it is not a substitute. Database case-folding functions (`lower()`, `NOCASE`, `COLLATE`, `ILIKE`) are never used for identity comparison: SQLite folds ASCII only while PostgreSQL folds Unicode, so they diverge on multilingual data. Migration validation must detect collisions before cutover rather than rewriting identifiers silently.

Login resolution must be unambiguous across username and email together. The explicit community locator is the community slug (#188). Login and prelogin requests carry `communitySlug` when the client knows the community (community login page); it is required when an email matches accounts in more than one community; `super_admin` accounts sign in without a slug. A username match identifies one account. An email match identifies one account only when it is globally unambiguous or when `communitySlug` narrows it to one account; otherwise login returns the same non-enumerating failure as any invalid credential. Never select the first of multiple matching accounts. One application-defined normalization/case-comparison contract runs identically on SQLite/D1 and PostgreSQL (never database case-folding), is enforced on new/updated identities through the normalized columns, and validation covers duplicate emails within a community, cross-community email ambiguity, case collisions, and a username matching another account's email. Preserve raw identifiers and require explicit operator resolution before cutover when they conflict. Do not invent a community membership for an orphan historical account.

### 6.3 Story

```text
Story
  id
  communityId
  title
  description?
  visibility: public | community | editors
  topic?
  topicNormalized?
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

Do not combine `privacyLevel`, `isRestricted`, elder-only flags, or other overlapping privacy mechanisms with this field. Fastify V1 story-control collapsing during migration moves to Appendix A.

`createdBy` is nullable in storage so imported/historical records can be represented truthfully; new application-created stories must record the actor when known. `description?` is sanitised HTML per Section 6.9 (#188).

`topic` is the canonical story taxonomy, mapped from the single Rails `topic` string (#189). A Rails `topic` maps to `topic` with its exact source value; a blank or null topic stays null. Topic filters use `topicNormalized`, an application-maintained column under the application-defined case-comparison contract — never database case folding (`lower()`, `NOCASE`, `COLLATE`, `ILIKE` fold differently across SQLite/D1 and PostgreSQL) — so public and member filters match identically on SQLite/D1 and PostgreSQL. Migration retains the raw source field/value in its evidence so canonical validation or future normalization never invents or loses taxonomy data. Multi-value tags are Appendix A.

Story relationships are explicit canonical records:

```text
StoryPlace: id, storyId, placeId
StorySpeaker: id, storyId, speakerId
```

Both endpoints of a relationship must belong to the same community. Retain every source edge and its multiplicity; do not silently deduplicate source relations to satisfy a target unique constraint. Rails `places_stories(story_id, place_id)` and `speaker_stories(speaker_id, story_id)` have no role or order columns, so do not invent historical roles or order: display order uses a documented stable ID-based tie-breaker. If identifiers must be generated for source edges, record their deterministic source-to-target mapping in the migration manifest. Removed story-place cultural context remains archive-only under Section 11. `storyRole`/`sortOrder` are Appendix A.

Every direct reference between community-scoped records has the same tenant invariant as the join records. `Story.interviewLocationId` must reference a Place in the story's community; `Story.interviewerId` must reference a Speaker in that community; `Story.createdBy` must reference a User in that community; and `Speaker.birthplaceId` must reference a Place in the speaker's community. The same rule applies to other canonical community-owned references unless this specification defines a narrower exception. Enforce equivalent fail-closed behavior on SQLite/D1 and PostgreSQL through portable constraints and atomic repository writes (one D1 batch on Workers, Section 8); do not rely on a read-time authorization filter to repair invalid ownership. Migration must preserve the raw inconsistent source values in the bundle/archive and require explicit manual disposition rather than linking across tenants or inventing ownership. Since #186 this invariant is structural on both backends: `StoryPlace`/`StorySpeaker` carry `communityId` (backfilled from the story on migration, written by repositories) and, with `Story.interviewLocationId`, `Story.interviewerId` and community media file bindings, are enforced by composite `(community_id, id)` foreign keys backed by `UNIQUE (community_id, id)` parent keys on stories, places, speakers and files. Actor-attribution references (`Story.createdBy`, `File.uploadedBy`) remain application/repository-validated rather than schema-enforced so cross-community operator actions stay representable.

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

A place has no audience field of its own at launch — Rails has none (#189); its visibility follows the decision table in Section 6.4a (#190). Fastify restricted-place handling is Appendix A.

Coordinates are nullable in storage. Map publication and spatial operations require a valid coordinate pair. Spatial operations use portable application-level latitude/longitude logic; no PostGIS dependency is permitted.

### 6.4a Place and speaker visibility (#190)

The table below is the one decision table for place and speaker visibility; it drives the #139 authorization matrix (PR #162). A place or speaker is _associated_ with a story through a `StoryPlace`/`StorySpeaker` edge, or as that story's `interviewLocationId`/`interviewerId`. A story is _readable_ by a caller per Sections 4 and 6.2. `Speaker.birthplaceId` does not make a place readable; a speaker projection shows its birthplace only when that place is itself readable.

| Resource and association                                                | Anonymous, other-community users, super_admin (public terms) | Own-community viewer                      | Own-community member                      | Own-community editor/admin |
| ----------------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------- | ----------------------------------------- | -------------------------- |
| Place or speaker associated with at least one story the caller can read | visible, only with those readable stories                    | visible, only with those readable stories | visible, only with those readable stories | visible                    |
| Place or speaker associated only with stories the caller cannot read    | hidden                                                       | hidden                                    | hidden                                    | visible                    |
| Place or speaker with no associated story                               | hidden; not on the public map                                | hidden                                    | hidden                                    | visible                    |
| Place photo, place-name audio, speaker photo                            | same cell as the owning place or speaker                     | same                                      | same                                      | same                       |

"Hidden" means absent from direct reads, lists, map points, search, filters, counts and story-derived projections, and no response reveals that the record exists. Visibility never exposes an unreadable story or its metadata. A disabled community hides every row from every role (export excepted, Section 7). Editors and admins manage every place and speaker in their own community.

### 6.5 Speaker

```text
Speaker
  id
  communityId
  name
  birthDate?
  birthplaceId?
  affiliation?
  createdAt
  updatedAt
```

`affiliation` is the V2 name for the user-facing concept previously stored as Rails `speaker_community`. Rails `birthdate` (a datetime) maps to `birthDate` as a calendar date; the raw source timestamp stays in the archive. Biography, partial year-only birth dates and a speaker lifecycle `status` move to Appendix A (#189).

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
- Map bounds order latitude southwest <= northeast; equal latitudes are allowed. Longitude bounds may wrap across the antimeridian (southwest > northeast). Missing coordinates remain absent rather than being replaced with zero.
- Provider credentials/tokens are deployment secrets, not domain data.
- Map configuration is provider-neutral; Mapbox/Protomaps-specific naming must not leak into the canonical model unless required by an adapter.
- Rails Theme `static_map` is a data-bearing ActiveStorage attachment and must migrate through the canonical File/media system.
- Legacy provider credentials are preserved only in the restricted migration archive and require explicit operator handling during cutover rather than being copied into ordinary V2 rows. Reports contain disposition references only, never credential values.
- Fastify V1 multiple-theme handling (multiple theme rows and multiple active themes per community) moves to Appendix A.

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

```text
Attachment
  id
  communityId?
  fileId
  ownerType: story | place | speaker | user | community | map_config
  ownerId
  role: story_media | place_photo | place_name_audio | speaker_photo | user_photo | community_display_image | community_background_image | sponsor_logo | static_map
  ordinal
  createdAt

ExternalMediaLink
  id
  communityId
  storyId
  url
  ordinal
  createdAt
```

`Attachment` is the typed relation that authorizes bytes; `role` must match `ownerType`; `ordinal` holds deterministic order (sponsor logos, story media). `communityId` is null only for the super_admin profile-photo exception. `ExternalMediaLink` is the canonical record for Rails `media_links` (`url`, `story_id`); `ordinal` preserves source order (Rails id order) (#188).

Media relations are explicit and typed. `Attachment.role` covers story uploaded media, place photo and place-name audio, speaker photo, user photo, community display image, background image and sponsor logos, and map-config static-map media; story external media links are `ExternalMediaLink` records, not attachments (#188).

Story external media links are canonical link records, distinct from `File`: they retain the owning story/community, exact validated URL, and deterministic source order. They do not claim ownership of remote bytes and do not grant access to any local object. Offline clients may display retained metadata but must not fetch remote links automatically.

Where legacy UI behavior depends on the order of a multi-attachment collection such as sponsor logos, migration must choose and document a deterministic source ordering (for example attachment creation/id order) and preserve that order explicitly in V2 rather than relying on database return order.

Do not duplicate media identity in `mediaUrls`, `imageUrl`, `audioUrl`, `photoUrl`, or similar resource columns.

`uploadedBy` is nullable so imported ActiveStorage objects can be represented without inventing provenance.

Community files require `communityId`. The only launch exception is an account-owned profile photo for a canonical `super_admin` without a community: its `communityId` is null and an explicit typed user-photo relation identifies the account owner before staging or serving. Null never means global/public ownership and cannot be used for stories, places, speakers, branding, maps, or cross-community sharing. Only that account owner can manage/read its system profile photo; null is not a shared community and system privilege does not authorize another account's photo. An orphan historical user/attachment that cannot map to a valid canonical account is retained together in the restricted archive with explicit manual disposition and community acceptance before cutover, never assigned an invented tenant or silently discarded.

File IDs, storage keys, and tenant membership alone never authorize serving. Resolve a typed attachment and its owning resource, then apply the same policy to metadata, download, byte-range requests, and transformed variants. Community files use community-scoped storage keys; the null-community profile exception uses an isolated account-scoped key namespace. The launch policy is:

| Owning resource                   | Read audience                                                                                                             | Attachment changes                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Story                             | Actors permitted to read that story under Sections 4/6.2, including community publication and lifecycle gates             | Same-community editor/admin permitted to edit the story  |
| Place/speaker                     | Per the Section 6.4a decision table                                                                                       | Same-community editor/admin permitted to edit the record |
| User profile                      | Account owner or same-community admin with user-management authority; never public merely because the community is public | Account owner or authorized same-community admin         |
| Community branding/map/static map | Same-community viewer/member/editor/admin while active; public projections only when the community is active and public   | Same-community admin with community-settings authority   |

For community-owned assets, disabled-community and system-privilege restrictions apply to every row. Unattached uploads are private staging objects accessible only to their authorized uploader or same-community admin for completion/cleanup; missing owner/policy information fails closed. Imported objects without uploader provenance gain runtime access only through a valid authorized relation.

Erasure: deleting an attachment's last relation, or erasing a community, schedules byte deletion; bytes are removed within 30 days, including from backups as they rotate (Section 7, #187).

Every community-owned relation must target a resource whose `communityId` equals the File's `communityId`; the null-community system-profile exception may relate only to its owning `super_admin` account. A file may have multiple relations within that one tenant. An authorized relation permits its bytes but never disclosure of other protected relations/metadata. Adding/reusing a relation that broadens the bytes' audience requires publishing authority over every affected owner, otherwise reject it. Cross-community copy-for-publication is **DEFER**: it is not a launch capability. At launch, attempts to attach one community's file bytes to another community's resource are rejected fail-closed and covered by negative tests. The deferred design, available only to a future explicit product decision, would create a distinct destination-tenant File identity and storage object after authorization by both communities, record source/checksum provenance, and never reuse the source tenant's File row or storage key. Removing an attachment requires authority over that owner; deleting shared bytes requires authority over all remaining owners or prior authorized removal of all references. Orphan cleanup must not remove still-referenced bytes. Imported cross-tenant relations remain losslessly captured and require explicit manual disposition before cutover rather than becoming runtime links. Tests must cover multiply related within one tenant, rejected cross-tenant relations, unattached, historical-without-uploader, and private-profile/branding files as well as story media. Public/signed serving and caches must honor current policy after publication changes or revocation; possession of a historical URL is not a bypass.

When one legacy source blob is attached to resources in more than one community, Stage 2 creates a separate File identity, tenant-scoped storage key, and checksum-verified object for each destination community whose attachment is accepted for cutover. The manifest accounts for the source payload once and lists every destination copy plus each source attachment disposition. It never reuses one tenant's File/storage identity across communities; an attachment that cannot be accepted remains archived for explicit community/operator disposition.

### 6.8 Accounts, sessions and security records (#184, #188)

```text
Session
  id
  tokenHash            SHA-256 of a 256-bit opaque token
  userId
  kind: standard | device
  createdAt
  lastSeenAt
  idleExpiresAt
  absoluteExpiresAt?
  revokedAt?
  revokedBy?

LoginCode
  id
  userId
  communityId?
  purpose: admin_issued | recovery
  codeHash             SHA-256
  issuedBy?
  expiresAt?
  usedAt?
  createdAt

ClaimToken
  id
  communityId
  tokenHash
  issuedBy
  expiresAt
  consumedAt?
  consumedBy?
  supersededAt?
  createdAt

AuthThrottle
  key                  keyed hash of account identifier or client IP
  failures
  windowStartedAt
  blockedUntil?

AuditEntry
  id
  communityId?
  actorId?
  action
  resourceType?
  resourceIds
  outcome
  ipAddress?           authentication/security events only
  userAgent?           authentication/security events only
  createdAt
```

Session lifetimes and the re-read rule are in Section 7. `admin_issued` codes expire in 72 hours or less; `recovery` codes are created at first-admin setup or at a migrated administrator's first V2 login, shown once, have no expiry and are invalidated when regenerated; every code is single-use and carries at least 100 bits. The ClaimToken lifecycle is in Section 7 (Bootstrap). `AuthThrottle` stores no raw IP. AuditEntry content rules are in Section 7 (Audit logging); IP/user-agent are retained at most 90 days.

### 6.9 Import manifests and safe descriptions (#188, #197)

```text
ImportManifest
  id
  communityId
  kind: places | speakers | stories
  status: previewed | committed | failed | discarded
  createdBy
  sourceFileName?
  sourceFileId          immutable stored copy of the uploaded CSV, with checksum
  mappings
  normalizedRows        the accepted, normalized row values shown in the preview
  rowCount
  rowErrors
  stagedFileIds
  resultSummary?
  committedAt?
  createdAt
```

Commit applies exactly `normalizedRows`, never a re-parse of the CSV; `sourceFileId` keeps the original upload for audit. A manifest is immutable after preview and commits at most once (Section 4). No idempotency key or digest (#197).

Safe description representation: story, place and community descriptions are stored and served as sanitised HTML with a small allowlist — bold (`strong`, `b`), italic (`em`, `i`), links (`a` with `href` limited to `http:`, `https:` and `mailto:`; the server adds `rel="noopener noreferrer nofollow"`), lists (`ul`, `ol`, `li`) and paragraph/line breaks (`p`, `br`). Everything else, including every attribute other than `href`, scripts, styles, event handlers and embedded media, is removed. Sanitisation runs on write and on migration; the raw Rails source stays in the archive and the manifest records each changed value (#188).

## 7. Authentication, sessions, and sovereignty

### Passwords (#184)

Workers Free allows about 10 ms CPU per invocation (Section 5). #194 measured that server-side bcrypt and Argon2id are killed (error 1102) and that PBKDF2 at 100,000 iterations fails under sustained load. Rejection above 100,000 iterations was observed once, not retained, and remains unverified — so no profile runs a password KDF on the server. The browser stretches the password; the server only hashes and compares. One wire protocol runs on all three profiles (portability invariant).

Protocol:

1. **Prelogin.** `POST` prelogin with `{identifier, communitySlug?}` returns `{algorithm, salt, params}`. Unknown identifiers get a deterministic fake derived from `HMAC(serverSecret, identifier)` in the same shape; fakes mimic the community's mix of migrated and upgraded accounts so the response does not reveal whether an account exists or was migrated.
2. **Client KDF.** New passwords use Argon2id in WebAssembly (m = 19 MiB, t = 2, p = 1). The client generates a random salt of at least 128 bits with `crypto.getRandomValues` for each new verifier; the KDF input is the password and that salt only. The origin is not an input: field-kit origins change (DHCP address, `localhost` versus LAN IP, hostname), and an origin change would make every verifier fail; the unique random per-account salt separates independent verifiers, so a key derived for one account does not verify for another; copying both salt and verifier to another deployment still accepts the same key — verifiers carry no deployment binding. The salt is unique per account and is the account binding: prelogin returns it (fakes return a deterministic `HMAC(serverSecret, identifier)`-derived salt), so a signed-out client on a new device needs only the identifier, and a key derived for one account does not verify on another. Login, upgrade and later logins all use this same binding; no internal account ID is sent to or derived by the client. WebAssembly, not WebCrypto, because field kits on plain-HTTP LANs under the trusted-LAN exception (below) may lack `crypto.subtle` (`getRandomValues` works in insecure contexts).
3. **Login.** `POST` login with `{identifier, communitySlug?, derivedKey}`. The server computes SHA-256 of `derivedKey` and compares it with `passwordVerifier` in constant time. The server never receives the plaintext password.
4. **Legacy Rails passwords.** Rails stores bcrypt `$2a$` hashes (`has_secure_password`, bcrypt gem; the column is `encrypted_password` because Devise used it earlier; Devise-era hashes verify under `has_secure_password`, so no pepper applies). Cost 10 (older rows) and cost 12 (rows since bcrypt-ruby 3.1.13) both occur; confirm from real hashes during capture (#164). The import stores `passwordVerifier = SHA-256(bcryptHashString)`, the bcrypt salt and cost, and `passwordAlgorithm = client-bcrypt-rails+sha256`. At login the browser recomputes bcrypt with that salt and cost (byte-exact with Rails, including 72-byte truncation) and sends the hash string as `derivedKey`. In the same request the client also sends `upgrade: {algorithm: client-argon2id+sha256, salt, params, derivedKey}` with a client-generated salt and the current policy parameters. Only after the bcrypt `derivedKey` verifies, the server rejects parameters below the current policy and then saves `passwordVerifier = SHA-256(upgrade.derivedKey)`, `passwordSalt`, `passwordParams` and `passwordAlgorithm` together in one atomic write; a rejected or failed upgrade leaves the bcrypt row unchanged. The next prelogin returns the new algorithm, salt and params. Password change and enrolment send the same `{algorithm, salt, params, derivedKey}` fields and follow the same atomic-write rule. Wrapping does not change the user's password; the original hash stays only in the source bundle and restricted archive.
5. **Admin-issued codes.** A community admin can issue a one-time login code for recovery, enrolment, or a device that cannot run the KDF (`LoginCode`, purpose `admin_issued`, Section 6.8).
6. **Online guessing.** Per-account and per-IP failure counters with exponential backoff are mandatory, stored durably (D1 on Workers, the profile database on Node; `AuthThrottle`). Because a guess costs the server almost nothing, the rate limiter is the only brake. A failed login updates its per-account and per-IP counters in one database round trip (one D1 batch on Workers), writing at most two rows; each failed login therefore costs up to two rows of the D1 daily write quota.

Verifier registry: unsupported, malformed or tampered verifier rows fail closed without revealing which check failed. Never reverse, decrypt or replace a legacy password with a generated one during migration. Migration cannot make a valid Rails account unusable on a supported profile.

Release thresholds. #194 measured the server-side rows as passing on 2026-11-11; the client-device rows remain release gates:

| Measurement                                                               | Pass                                                      |
| ------------------------------------------------------------------------- | --------------------------------------------------------- |
| Login request on Workers Free (D1 read, SHA-256, compare, session insert) | p99 CPU ≤ 5 ms; zero error-1102 responses in 1,000 logins |
| Session check added to each authenticated request                         | p99 CPU ≤ 2 ms                                            |
| Requests per login, including upgrade                                     | ≤ 2                                                       |
| Database round trips per failed login                                     | 1 (at most 2 rows written)                                |
| Argon2id WebAssembly on a reference low-end Android phone (2 GB RAM)      | p95 ≤ 3 s, no out-of-memory                               |
| Browser bcrypt at cost 12 on the same device                              | p95 ≤ 5 s                                                 |
| Both KDFs over `https://` (default) and `http://` (exception) on a LAN    | work                                                      |
| Byte-exact match with Rails hashes (`$2a$`, 72-byte truncation)           | 100% on a fixture set                                     |

Residual risks:

- the derived key is password-equivalent if TLS fails;
- until upgrade, a Rails bcrypt hash string is itself a valid `derivedKey`, so the source bundle and archive hold login-equivalent material and inherit Section 10.3 protections;
- the weakest supported device caps the KDF parameters (stored per account, no downgrade);
- old devices fall back to admin codes;
- served JavaScript from a compromised deployment can capture passwords;
- rate-limit writes consume the D1 daily write quota, so a login flood can exhaust it;
- non-browser clients must implement the KDF.

### Field-kit HTTPS and the plain-HTTP exception

Field kits serve HTTPS by default. The installer generates a local certificate authority and issues a certificate covering every configured host name and IP address; the certificate is reissued from that authority whenever the configured hosts or IPs change. Enrolled devices either trust that authority or pin the local CA fingerprint; the fingerprint is shown in the admin UI and on the printed recovery sheet, so it is available out of band. The client KDF stays origin-independent (Passwords, step 2): origin changes are absorbed by reissuing the certificate, never by rebinding verifiers.

The device-local CA private key is stored only on the kit, in a file owned by the service user with permissions `0600`; it is never exported or included in backups or exports, and is destroyed on deprovision. A leaked CA private key requires replacing the CA and re-keying all enrolled devices.

A plain-HTTP trusted-LAN exception exists. It is off by default and requires explicit admin opt-in; while enabled, the admin UI shows a persistent warning and the readiness report flags builds with it enabled. The exposure is explicit: a LAN observer can capture and replay the `derivedKey` and the session token.

### Sessions

Production sessions use an opaque cookie/session identifier backed by durable database state with equivalent semantics across D1, PostgreSQL, and SQLite. In-memory sessions are development/test-only. The token is 256-bit and stored only as SHA-256 (`Session`, Section 6.8). The user and their role/community/status are re-read from the database on every request (#137). The default `standard` session idle timeout is 12 hours; "remember this device" is opt-in, creates a `device` session lasting 60 days, and a community admin can revoke it.

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

### Export, erasure and archive custody (#187)

- Community admins can always export all of their community's data as JSON plus a media ZIP, including while the community is disabled. A super admin cannot export protected community content.
- Erasure (community withdrawal, or deletion of records/media) removes the data and media within 30 days, including from backups as they rotate; backup retention therefore never exceeds 30 days for erased data. Content-free audit entries recording the erasure itself may remain.
- The legacy Rails source bundle and Stage-2 archive for a community are held by that community or a steward it names, with a stated retention window: 30 days after the community accepts cutover unless the community sets another window. Custody and the window are recorded in the migration manifest (Section 10.4).

### Bootstrap and account lifecycle

Preserve community and initial-administrator setup while replacing unsafe Rails setup mechanics. Bootstrap authority must be explicitly established for the intended fresh installation/community, work offline, and be invalidated after completion. Setup replay must not create privileged accounts or reset credentials. No production profile may depend on shipped privileged passwords. Provisioning an additional hosted community requires authorized system lifecycle action; it is not permission to reopen installation bootstrap. The first administrator of a newly provisioned hosted community receives access through a single-use, audited community-claim token with a maximum lifetime of 72 hours, configurable shorter per deployment. A claim token may be issued only for a community that has never had any administrator account — claimed, bootstrapped, or migrated — and that holds no community content; issuance closes permanently once any administrator exists. Issuing again before a claim invalidates the earlier token; after the first successful claim, account recovery follows only the community-authorized path in this section. The token is stored only as a hash and shown exactly once; it can never authenticate an existing account and can never authenticate as, or escalate into, a super-admin session. The claimant sets their own credentials at claim time. The claim record, including the issuer, is visible to the community's administrators. A super admin redeeming a token before the community handoff is an operator-trust residual; it is detectable because the legitimate claim then fails. The remedy for a legitimate claim that fails because the token was already redeemed is an operator deprovisioning and reprovisioning the still-empty community, which is itself an audited action.

Preserve self-service password change and community-admin-assisted recovery, including accounts without email. The procedure (#188): a community admin resets a member's password (or issues an admin login code); at first-admin setup the system generates one-time recovery codes for that admin, shown once (stored as hashes, `LoginCode` purpose `recovery`, Section 6.8); the last/only admin recovers with one of these codes. A migrated Rails administrator never runs first-admin setup, so at their first successful V2 login they must generate and confirm recovery codes before any other administrative action; community cutover acceptance requires at least one administrator per migrated community to hold recovery codes. Recovery revokes existing sessions. Require verified recovery authority and no disclosure of passwords/tokens in logs or reports; system privilege alone is not recovery authority. Email-based recovery may be an optional adapter but cannot replace this offline path. Rails reset-token columns alone do not establish a working email-recovery product requirement.

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
- Writes that must be atomic (an import commit, a write that checks tenant invariants across rows) run as one D1 batch on Workers; interactive transactions are not assumed portable.

## 9. API contract

V2 owns its own API contract. Rails/Fastify are not normative transports.

The Explore read adapter (#198) is a read-only, transitional path set that serves the Rails-shaped JSON the existing Explore client requests. It is registered in the #134 route registry, applies the same sovereignty rules as the canonical API (public projections only for anonymous callers, Section 6.4a visibility), documents every mapped and every unserved legacy endpoint/field, and is removed once the V2 frontend uses the canonical API. It is not a second canonical namespace.

Canonical launch namespaces (normative):

```text
/v2/public/*   unauthenticated public projections
/v2/*          authenticated community API
/v2/admin/*    system administration
```

Login, prelogin, recovery, authorized bootstrap, and health/readiness are explicit non-community-authenticated exceptions within `/v2/`, with their own fail-closed contracts. Issue #134 owns their exact operation paths and the route registry before #145/#146 domain implementation. Temporary coexistence paths require a documented mapping; they cannot become a second released V2 namespace by accident.

Do not duplicate resource CRUD merely because a user is a "member"; authorization belongs in policy/service boundaries.

Requirements:

- consistent typed success/error contracts;
- Zod/OpenAPI generated from the same source where practical;
- stable pagination and filtering semantics;
- community identity derived from authenticated context where possible rather than caller-selected tenant IDs;
- public projections enforce community publication/lifecycle and story visibility together;
- intentional breaking changes after V2 release require versioning/deprecation/migration notes and CI detection.

After #162, #177 and #160 merge, no new Fastify-only route work is accepted (Fastify freeze). Hono is re-landed as a thin slice off `main` (health, login, durable session, revocation, one protected media read), superseding closed PR #132. Contract tests target Hono; Fastify output is not the V2 oracle.

The application is transport-neutral: one `(req: Request) => Promise<Response>` handler (Hono's `app.fetch`). Workers serves it directly; Node serves it through `@hono/node-server`. The #134 contract harness, the #162 authorization matrix and the #199 persona QA script drive this same interface — in process for CI runs and over HTTP for deployed runs.

## 10. Legacy source migration contract

Migration is a one-time deterministic ETL from a real supported legacy source into V2. The launch source profile is Rails PostgreSQL + ActiveStorage: production is the Rails application (`our.terrastories.app` on Heroku), and no deployed Fastify V1 installation holding community data is known. The Fastify V1 PostgreSQL-or-SQLite source profile (issue #168) is therefore **DEFER**, and its deferred profile details move to Appendix A; it is re-activated only when a named real Fastify V1 deployment with community data is identified. Migration is not a raw database conversion and does not read a live source directly into today's mutable V2 tables.

Migration is explicitly **two-stage**:

1. **Lossless source capture** — a source-profile adapter reads a consistent source database snapshot plus every referenced or discovered stored byte payload into one versioned portable migration-bundle format containing the discovered source schema/types, every source row, every stored object, provenance, and checksums. This stage is independent of the V2 physical schema.
2. **Canonical target transform** — read the verified bundle and map it into the approved canonical V2 logical schema for SQLite/D1-compatible and PostgreSQL targets, while producing field/table dispositions and validation evidence.

This separation lets Terrastories prove source preservation before target schema normalization is finished and prevents migration code from inheriting transient Fastify/V1 schema drift.

Cutover requires one enforced, auditable source-write boundary that includes relational writes, background jobs, attachments, and stored-object uploads. The path is a community-approved maintenance window: disable and drain every source writer, place the legacy application in read-only mode, take the final consistent Stage-1 capture from that quiescent source, transform/validate it, switch traffic, and keep the legacy source read-only until target acceptance completes (#197). A migration cannot be declared successful from an earlier snapshot while the source remains writable.

### 10.1 Source of truth for migration

The source-capture contract is pinned to the audited legacy repository revision and schema version used by fixtures. Every migration manifest records:

- source profile (`rails-postgresql` at launch; Fastify profiles are named in Appendix A) and legacy repository commit/reference used by the migration contract;
- pinned Rails `schema.rb`/`schema_migrations` version (Fastify Drizzle pinning: Appendix A);
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

The Fastify V1 source-profile baseline moves to Appendix A (deferred; it applies only when the profile is re-activated for a named real deployment).

Legacy FactoryBot factories are useful for representative Rails values but are not sufficient as a migration schema contract. Integration fixtures must combine the exact/pinned Rails schema with production-valid edge states not represented by FactoryBot, and must separately exercise the exact pinned Fastify V1 PostgreSQL and SQLite schemas plus configured storage semantics (Appendix A, when re-activated).

Unknown/community-specific source tables must be captured automatically. A hand-maintained allowlist may make known-schema regressions fail closed, but it may not define the universe of data that is preserved.

### 10.2 Preservation rules

- Preserve legacy primary IDs for canonical domain records when doing so is safe; record any remap explicitly.
- Never invent required foreign keys/provenance merely to satisfy a stricter V2 schema.
- Preserve nulls and source precision when absence or granularity is meaningful; application creation rules may be stricter than import/storage rules. Rails `birthdate` (a datetime) maps to `birthDate` as a calendar date; the raw source timestamp stays in the archive (partial year-only birth dates: Appendix A).
- Map Rails story permission values deterministically to V2 visibility. Fastify restricted story/place states move to Appendix A.
- Preserve user role semantics, including `viewer` versus `member`.
- Preserve both legacy `role` and `super_admin` source values before normalization. Contradictory combinations require explicit/manual disposition and may not be guessed.
- Preserve every source username and email value so username-or-email login can survive cutover. A Rails blank username imports as null; never synthesize an identifier. Duplicate or cross-kind ambiguous identifiers require community context or explicit operator resolution under Section 6.2 and may never use first-match behavior. (Fastify null usernames: Appendix A.)
- Preserve every relationship edge and relationship multiplicity.
- Copy media bytes, MIME type, filename, byte size, checksum, attachment role, and a deterministic ordering signal for multi-attachments; verify checksums after write.
- Preserve legacy external media links (`media_links(url, story_id)` becomes `ExternalMediaLink`, Section 6.7).
- Classification of persisted V1 `mediaUrls`/`imageUrl`/`audioUrl`/`photoUrl` resource columns moves to Appendix A.
- Preserve the exact Rails bcrypt hash in the bundle/archive and store the wrapped verifier (Section 7).
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
5. archive custody (custodian and retention window) per Section 7 (#187);
6. a human-readable validation summary that fails the run on unexplained differences.

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
- username/email login identities, including cross-community duplicate emails, match the unambiguous experience contract (null Fastify usernames: Appendix A, when re-activated);
- Rails bcrypt accounts authenticate through the wrapped client-bcrypt protocol on every release profile, reject malformed/tampered rows, and upgrade to Argon2id on first successful login (Section 7);
- contradictory role/super-admin state cannot be silently normalized;
- public/private/disabled community behavior is preserved, including private-community override of public stories;
- Fastify restricted stories and places (Appendix A, when re-activated) remain unavailable until their explicit community-approved audience/archive disposition, and never widen through canonical mapping or direct/list/search/map/count/media/story-derived projections;
- every Fastify theme row is archived/dispositioned, and zero/multiple active-theme states require explicit community selection rather than implicit ordering (Appendix A, when re-activated);
- Rails topics retain their exact values and filtering;
- known Rails beta/Flipper-gated outcomes map to canonical V2 capabilities, and every unknown/custom active source flag has an explicit RETAIN/IMPROVE/ARCHIVE disposition;
- public map/filter data remains representable;
- migration is deterministic and safe to re-run against a fresh destination;
- failure is atomic or leaves an explicitly disposable incomplete destination, never a falsely successful partial migration.

The same canonical migrated fixture must validate on SQLite/D1-compatible and PostgreSQL V2 targets. SQLite export is additionally required for field-kit migration.

## 11. Legacy disposition at V2 launch

| Legacy/V1 concept                                                                                                     | V2 disposition                                             | Rationale                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Communities, stories, places, speakers                                                                                | RETAIN/IMPROVE                                             | Core Terrastories domain                                                                                                                                                                             |
| Rails story permission levels                                                                                         | IMPROVE                                                    | One `visibility` enum preserves the same audience distinctions                                                                                                                                       |
| Rails story topic                                                                                                     | RETAIN                                                     | Single `topic` with normalized filter; multi-value tags are Appendix A (#189)                                                                                                                        |
| Rails `viewer` and `member` distinction                                                                               | RETAIN                                                     | User-visible access difference must survive                                                                                                                                                          |
| Username-or-email login                                                                                               | RETAIN                                                     | Established login experience; both identifiers migrate                                                                                                                                               |
| Story/place/speaker relationships                                                                                     | RETAIN                                                     | Core narrative/map data                                                                                                                                                                              |
| Uploaded media and external media links                                                                               | IMPROVE                                                    | Normalize around `File` + explicit relations; preserve every item                                                                                                                                    |
| Community/user/place/speaker attachments                                                                              | IMPROVE                                                    | Normalize into the same media system                                                                                                                                                                 |
| Theme `static_map` attachment                                                                                         | IMPROVE                                                    | Preserve through canonical File/map configuration relation                                                                                                                                           |
| Rails Theme                                                                                                           | IMPROVE                                                    | Replace provider-specific singleton theme with `CommunityMapConfig` (Fastify multiple themes: Appendix A)                                                                                            |
| Map provider credentials in DB                                                                                        | IMPROVE/ARCHIVE                                            | Move secrets out of domain rows; preserve source value in restricted migration artifact                                                                                                              |
| CSV imports                                                                                                           | RETAIN/IMPROVE                                             | Preserve user workflow with a typed/validated V2 implementation                                                                                                                                      |
| Rails `curriculums`                                                                                                   | ARCHIVE by default                                         | Schema exists but no current Rails route exposes it; do not rebuild runtime product without evidence of active user need                                                                             |
| Rails `beta` / known Flipper state                                                                                    | IMPROVE/ARCHIVE                                            | Preserve publication/settings outcomes as canonical V2 capabilities; archive legacy gating state; classify custom keys                                                                               |
| Fastify elder role/elder-only policy                                                                                  | DROP                                                       | Remove scope creep (Appendix A); persisted restricted rows require community-approved canonical audience or archive-only disposition                                                                 |
| Cultural-significance/settings/context V1 fields                                                                      | DROP from canonical runtime; archive if source data exists | Avoid unreviewed cultural-protocol semantics                                                                                                                                                         |
| PostGIS behavior                                                                                                      | DROP                                                       | Portability and offline operation are higher-value requirements                                                                                                                                      |
| Persisted V1 resource media URL fields                                                                                | IMPROVE/ARCHIVE                                            | Classify each value per Appendix A when re-activated; retain external story links or recover owned media, while archiving redundant/unsupported raw values                                           |
| Cross-community file copy-for-publication                                                                             | DEFER                                                      | Not a launch capability; launch rejects cross-tenant attachment fail-closed; deferred design recorded in Section 6.7                                                                                 |
| Low-downtime journal cutover                                                                                          | DROP                                                       | Maintenance-window cutover only (#197)                                                                                                                                                               |
| Import idempotency key/digest                                                                                         | DROP                                                       | Preview plus one-shot all-or-nothing commit (#197)                                                                                                                                                   |
| Fastify-era extras (place visibility, speaker status/biography, partial birth dates, storyRole/sortOrder, multi-tags) | DEFER                                                      | Rails parity at launch (#189, Appendix A)                                                                                                                                                            |
| Rails `has_secure_password` bcrypt hashes                                                                             | IMPROVE                                                    | Wrapped client-bcrypt verifier, upgraded to Argon2id on login (#184)                                                                                                                                 |
| Fastify V1 source capture (#168)                                                                                      | DEFER                                                      | No deployed Fastify V1 installation holding community data is known; production is Rails (`our.terrastories.app`). Re-activate on a named real deployment; mapping contracts retained in Appendix A. |

## 12. Testing and release gates

### Canonical contract tests

Build a fail-closed V2 behavior contract suite. It defines approved V2 behavior and must cover public, authenticated community, admin, auth/session, media, import, spatial, validation/error, and sovereignty paths.

Legacy/Fastify comparison tests may help discover omissions, but an old behavior becomes normative only after it is classified under Section 3 and represented in this spec/contract.

Public contract tests must specifically prove that community publication/lifecycle gates override story-level public visibility across list/detail/search/map/media paths.

Authentication contract tests must cover username and email login identifiers for migrated and new V2 users according to the approved uniqueness rules, including imported accounts without usernames, duplicate emails across communities, required community disambiguation (`communitySlug`), identifier case/cross-kind collisions, and non-enumerating failures. They must also cover prelogin fake responses, wrapped bcrypt login and upgrade, admin codes, recovery codes (including a migrated community whose only administrator generates codes at first V2 login and then recovers with one), rate limits, the Section 7 thresholds, 12-hour idle and 60-day device sessions, and re-read of user/role/community/status on every request (#184, #188).

### Database tests

Required CI must exercise shared schema/repository/migration behavior against both:

- SQLite/D1-compatible execution; and
- PostgreSQL.

Both paths must cover fresh schema creation, supported upgrades, constraints, indexes, timestamps, booleans, null/unique behavior, transactions, JSON serialization, ordering/pagination, and portable spatial behavior.

### Migration tests

Migration CI uses synthetic fixtures only; never real community data. It must include:

- the pinned Rails `schema.rb` and an executable PostgreSQL equivalent;
- the pinned Fastify V1 schema/migration state executed against both PostgreSQL and SQLite, with representative File/local/object-storage records and bytes (Appendix A, when re-activated);
- every Rails role and story permission value, plus Rails blank/nonblank topics;
- duplicate emails across communities, same-community/case/cross-kind collisions, valid Rails bcrypt and malformed/tampered hashes, plus Fastify users without usernames and Fastify Argon2id parameter variants (Appendix A, when re-activated);
- every recognized Fastify story `privacyLevel` combined with both `isRestricted` states, unknown/contradictory values, and restricted/unrestricted places linked to stories with every canonical audience (Appendix A, when re-activated);
- Fastify communities with zero, one, and multiple active themes plus inactive alternatives, proving explicit selection and complete row disposition (Appendix A, when re-activated);
- nullable and edge states such as missing place coordinates and system users without community IDs;
- all relationship tables and external media links, plus persisted resource media URL fields, including source-owned, externally hosted, redundant derived, ambiguous, and URL-only media cases (Appendix A, when re-activated);
- curriculums and operational tables;
- every relevant ActiveStorage attachment role, including Theme `static_map`;
- deterministic attached and unattached/orphan blob payloads with known size/checksum, proving each byte payload reaches canonical storage or the protected Stage-2 archive before Stage-1 deletion;
- one source blob attached within multiple communities, proving checksum-verified tenant-scoped fan-out and complete attachment disposition without cross-tenant File reuse;
- writes attempted during cutover, proving the enforced read-only boundary includes relational, attachment, and stored-object changes for each source profile;
- at least one unexpected/custom source table proving dynamic capture;
- corruption/missing-media and destination-overwrite negative tests.
  Rails Stage-1 capture tests run against real PostgreSQL/ActiveStorage semantics. Fastify V1 Stage-1 capture tests run against real PostgreSQL and SQLite semantics plus the supported configured storage profiles; the Fastify fixture requirements above apply when that deferred profile is re-activated (Appendix A, Section 10), while Rails is the launch requirement. Stage-2 mapping tests run each source-profile bundle into both SQLite/D1-compatible and PostgreSQL V2 targets.

### Deployment tests

Release evidence is per launch profile — Workers Free + D1 + R2, Node + SQLite or PostgreSQL (one VM image shared with the field kit), and offline Node + SQLite — matching `docs/SOURCE-OF-TRUTH.md`: readiness for one profile never waits on another. Field-kit tests must fail if a required runtime path reaches an external cloud dependency. The #199 persona QA script runs against each launch profile, fails closed, and is a #147 release gate; personas: anonymous visitor, community viewer, member, editor, admin (users, settings, import/export, erasure), super admin, and field-kit operator (disconnected, recovery codes); plus a case proving rows pending community disposition never appear to any role (#199).

### Security tests

Auth, sessions, files/media, imports, migration, community isolation, public/private visibility, exports, and super-admin boundaries require negative/adversarial coverage. Security tests must additionally cover export (admin while disabled; super admin denied), erasure within 30 days including backups, every Section 6.4a table cell positive and negative, and the sanitised-HTML allowlist (Section 6.9) (#187, #190, #188).

Audit-log tests must prove that entries for successful, failed, and attacked actions carry only actor/community/action/resource IDs and outcome — never story/place/speaker content, media, credentials, or tokens (Section 7). Authentication and security-event entries may additionally carry IP address and user-agent under the Section 7 network-metadata rule; entries for content-resource actions never carry them.

Community-claim-token tests must prove: issuance is refused for a community that has, or has ever had, any administrator account — in particular for a migrated community and for a bootstrapped community — and for a community that holds community content; reissuance invalidates the earlier token; issuance is permanently closed once any administrator exists; a consumed, expired, or superseded token cannot claim or authenticate any existing account; only the token hash is stored and the raw token is shown exactly once; the claimant sets their own credentials; and the claim record, including the issuer, is visible to the community's administrators while the raw token never is.

## 13. Phased path

1. **Contract correction** — done (PR #163 merged 2026-09-28); this amendment records the 2026-11-11 decisions.
2. **Transport foundation** — thin Hono slice off `main` (health, login, durable session, revocation, one protected media read), superseding closed PR #132. Fastify freeze after #162, #177 and #160 merge.
3. **Three-profile feasibility gate** — prove login, protected media, session revocation, legacy password verification and import limits on Workers Free + D1 + R2 and both Node profiles. Outcome for Workers Free: server-side KDFs fail; the client-stretching login passes (#194); launch profiles are Workers Free (hosted), Node with SQLite or PostgreSQL (self-hosted), and the offline field kit (#195). The client-device thresholds in Section 7 remain release gates.
4. **Domain/schema normalization** — Rails-parity launch model (Section 6, #189).
5. **Production adapters** — D1/PostgreSQL/SQLite, R2/local storage, durable sessions, client-stretching auth, rate limits.
6. **Migration source preservation** — Stage-1 Rails capture (#164). It is independent of the V2 schema and may land whenever ready, but it is not on the critical path ahead of steps 2-5.
7. **Canonical migration transform** — Rails bundle into the V2 SQLite/PostgreSQL schemas.
8. **API readiness for frontend** — persona QA script (#199) passes on every launch profile; Explore read adapter (#198) available. Frontend work starts after this (#185).
9. **Frontend/cutover validation** — maintenance-window cutover only (#197).
10. **Release** — per profile.

## 14. Resolved architectural decisions

| Question                            | Decision                                                                                                                                                                                                                                        |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Legacy compatibility target?        | Preserve user experience and data; do not preserve Rails/Fastify wire/internal compatibility.                                                                                                                                                   |
| HTTP framework?                     | Hono.                                                                                                                                                                                                                                           |
| Transport interface?                | One transport-neutral `(req: Request) => Promise<Response>` handler (Hono `app.fetch`) on every profile; tests drive it in process and over HTTP (#162, #134).                                                                                  |
| Database targets?                   | D1/SQLite and PostgreSQL equal first-class; dropping PostgreSQL was considered and rejected (#196).                                                                                                                                             |
| Physical schema?                    | One logical schema/behavior contract; dialect-specific definitions/migrations allowed when required.                                                                                                                                            |
| Spatial behavior?                   | Plain lat/lng + application-level portable logic; no PostGIS.                                                                                                                                                                                   |
| Story privacy?                      | One `public / community / editors` audience field; public requests also require a public active community, while authenticated own-community access follows Section 6.2.                                                                        |
| Place privacy?                      | A place has no audience field of its own at launch; place and speaker visibility follow the Section 6.4a decision table (#190, #189).                                                                                                           |
| User roles?                         | `viewer`, `member`, `editor`, `admin`, `super_admin`; no elder role.                                                                                                                                                                            |
| Login identity?                     | Preserve username-or-email login with the community slug as locator; ambiguous cross-community email matches require community context rather than first-match lookup (#188; Fastify null usernames: Appendix A).                               |
| Sessions?                           | Durable database-backed authoritative sessions; 12 h idle timeout, opt-in 60-day device sessions, re-read every request; memory dev/test only.                                                                                                  |
| Media?                              | One `File` identity model + explicit typed relations; URLs derived by storage adapter; Theme static map included.                                                                                                                               |
| Map configuration?                  | One provider-neutral `CommunityMapConfig` per community; ambiguous Fastify multi-theme state requires community selection (Appendix A); provider credentials are secrets.                                                                       |
| Legacy removed data?                | Preserve in migration archive; never silently discard.                                                                                                                                                                                          |
| Rails beta/Flipper?                 | Known `public_communities` and `split_settings` outcomes become normal V2 publication/settings capabilities; archive gating state. Custom active keys require migration disposition.                                                            |
| Password migration?                 | Rails bcrypt wrapped as a client-bcrypt verifier on every profile; upgraded to client Argon2id on first login; no server-side KDF (#184, #194).                                                                                                 |
| Migration strategy?                 | Two-stage: lossless Rails PostgreSQL/ActiveStorage source capture, then deterministic bundle-to-canonical-V2 transform; the Fastify V1 source profile is DEFER (Appendix A, Section 10) and uses the same two-stage contract when re-activated. |
| API compatibility after V2 release? | Protect released V2 contracts with OpenAPI/contract CI and explicit versioning/deprecation policy.                                                                                                                                              |
| Launch profiles?                    | Workers Free + D1 + R2 (hosted), Node + SQLite or PostgreSQL (self-hosted), offline Node + SQLite field kit (#195).                                                                                                                             |
| Hosting cost?                       | Free plans only; Section 5 cost envelope; USD 0 recurring on every profile (#184).                                                                                                                                                              |
| Login protocol?                     | Client-side stretching (Argon2id WASM, wrapped Rails bcrypt), server SHA-256 verify in constant time, mandatory rate limits; pending independent security review (#184, #194).                                                                  |
| Cutover?                            | Maintenance window only (#197).                                                                                                                                                                                                                 |
| Import?                             | Preview plus one-shot all-or-nothing commit; no idempotency key or digest (#197).                                                                                                                                                               |
| Self-hosted artifact?               | One VM image identical to the field kit (#197).                                                                                                                                                                                                 |
| Launch data model?                  | Rails parity; Fastify-era extras in Appendix A (#189).                                                                                                                                                                                          |
| Place/speaker visibility?           | Section 6.4a decision table drives the #139 matrix (#190).                                                                                                                                                                                      |
| Export/erasure?                     | Community-admin export (incl. while disabled; super admin denied); erasure within 30 days incl. backups (#187).                                                                                                                                 |
| Account recovery?                   | Community-admin reset plus one-time recovery codes created at first-admin setup or a migrated admin's first V2 login; email optional adapter only (#188).                                                                                       |
| Frontend?                           | Starts after the API is done; #198 Explore read adapter, #199 persona QA gate (#185).                                                                                                                                                           |

## 15. Change log

| Date       | Changes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-14 | #186 phase 1: story-place/story-speaker/join tenancy is now structural — `StoryPlace`/`StorySpeaker` carry `communityId` and, with `Story.interviewLocationId`, `Story.interviewerId` and community media file bindings, are enforced by composite `(community_id, id)` foreign keys (with `UNIQUE (community_id, id)` parent keys) identically on SQLite/D1 and PostgreSQL; actor-attribution references stay application-validated.                                                                                                                                                                                                                                                                                                                                   |
| 2026-11-12 | Review fixes (#200, #201): field kits serve HTTPS by default (installer-generated local CA, reissued on host/IP change; CA trust or fingerprint pinning via admin UI and printed recovery sheet; KDF not origin-bound); plain-HTTP trusted-LAN exception off by default, admin opt-in, persistent UI warning, readiness-report flag, documented LAN replay of derivedKey/session token; HTTP gate row aligned; salt separates verifiers but copied salt+verifier accepts the same key (no deployment binding); PBKDF2 >100k ceiling marked observed once, not retained and unverified.                                                                                                                                                                                  |
| 2026-11-12 | Recorded the 2026-11-11 maintainer decisions (#184, #185, #187, #188, #189, #190, #193, #195, #196, #197; measurements #194): free-hosting cost envelope and the three launch profiles; client-stretching password protocol (no server-side KDF); Rails-parity launch model with Fastify-era extras moved to Appendix A; Section 6.4a place/speaker visibility decision table; export and 30-day erasure; one-shot import commit without idempotency key/digest; maintenance-window cutover only; persona QA gate (#199) and Explore read adapter (#198); phased-path reordering.                                                                                                                                                                                       |
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

## Appendix A — Later: deferred Fastify-era profile and features

None of this is launch scope. It applies only when the Fastify V1 source profile is re-activated for a named real deployment (Section 10) or a product decision adopts a feature; the Fastify freeze (Section 9) stays.

### A.1 Role mapping (from Section 6.2)

```text
Fastify V1: super_admin (source community_id is NOT NULL)        | super_admin; communityId null; source communityId archived
Fastify V1: admin                                                 | admin
Fastify V1: editor                                                | editor
Fastify V1: viewer                                                | member
Fastify V1: elder                                                 | community-approved disposition; never defaults silently
```

A Fastify V1 `super_admin` maps to a canonical `super_admin` with a null `communityId`; the source `communityId` is retained in migration evidence as provenance, never as a canonical membership. A Fastify `viewer` maps to V2 `member`, not `viewer`: the pinned Fastify story reads for non-`elder`/`admin` users filter only on `isRestricted = false` and never enforce `privacyLevel`, so a Fastify `viewer` effectively reads `members_only` stories — the audience V2 grants to `member`. Mapping to V2 `viewer` would silently narrow that user's effective access, which Section 4 forbids without an explicit product decision. The Fastify `elder` role has no canonical equivalent: each such user requires a community-approved disposition under Section 3 and never defaults silently to a broader or narrower audience.

Fastify V1 accounts whose source schema has no username migrate with a null username until an authorized user assigns one; never synthesize an identifier.

### A.2 Story controls, tags and relation roles (from Section 6.3)

Fastify V1 collapses its overlapping story controls during migration. When `isRestricted = false`, `privacyLevel = public` maps to `public` and `members_only` maps to `community`; `privacyLevel = restricted` may map to `editors` only when source evidence confirms the row was not subject to the narrower elder/admin path. `isRestricted = true` was limited to elder/admin audiences that have no exact canonical equivalent, so it remains unavailable in V2 runtime and blocks cutover until the community explicitly approves a canonical audience or an archive-only disposition. `editors` is the closest retained runtime audience, but migration cannot select it silently. Any other value or contradictory source state follows the same explicit community-approved disposition path and never defaults to public.

Multi-value story tags: canonical storage is a portable relational form — logical `StoryTag(storyId, ordinal, value, valueNormalized)` with `ordinal` preserving source order and `valueNormalized` maintained by the application — or an equivalent portable structure; every tag filter uses `valueNormalized`, never JSON or array containment operators (Section 8) and never database case-folding. Fastify V1 `tags` retain every ordered source value and may not be collapsed into one topic.

`storyRole`/`sortOrder` on story relations: preserve an existing order or speaker's narrative role when supplied; `storyRole` is descriptive metadata, never an authorization or cultural-restriction role. These optional attributes exist in Fastify V1 and the preceding V2 contract; the pinned Rails tables do not contain them.

### A.3 Place visibility (from Section 6.4)

A place `visibility: public | community | editors` field, with Fastify `isRestricted = false` mapping to `public`. A restricted Fastify place had elder-specific read access with no exact canonical equivalent, so it stays unavailable in V2 runtime and blocks cutover until the community explicitly approves a canonical audience or archive-only disposition; `editors` is the closest runtime audience but is never selected implicitly. Raw `isRestricted` and removed cultural-significance values remain in migration evidence/archive.

### A.4 Speaker extras (from Section 6.5)

- `biography` — retains the editable `bio` capability exposed by Fastify V1 and the preceding V2 contract; nullable for Rails migrations because the pinned Rails Speaker table has no biography field.
- Partial `birth` — preserves source precision without inventing a date. A year-only Fastify value maps to `{ year }`; a Rails date maps to `{ year, month, day }`. `month` and `day` must either both be present or both absent, and all components must form a valid non-future value. Storage may use portable scalar columns, but every V2 API uses this one logical partial-date representation.
- `status: active | inactive` — retains the Fastify speaker withdrawal capability. Inactive speakers and their photos are absent from public and viewer/member projections, direct reads, filters, counts, and story-derived speaker relations even when a related story is otherwise readable. The record and its relationships remain intact and are visible to authorized same-community editors/admins for management or reactivation. Rails imports default to `active`; Fastify migration preserves `isActive` exactly.

### A.5 Multiple themes (from Section 6.6)

Fastify V1 permits multiple theme rows and multiple active themes per community. Exactly one active row maps to the canonical configuration. Zero or multiple active rows require an explicit same-community administrator selection accepted under the community cutover process; migration must never choose the first, newest, or otherwise guessed row. Every source theme row and its disposition remains in the archive/manifest. A community that actively relies on switching among multiple configurations requires a product/spec decision before its cutover rather than silent feature loss.

### A.6 Fastify V1 source-profile baseline (from Section 10.1)

The Fastify V1 source-profile baseline (deferred; it applies when the profile is re-activated under Section 10) includes every table/column represented by the pinned Drizzle schema and applied migration metadata, including communities, users/auth state, stories, places, speakers, relationship tables, files/media metadata, imports, sessions/operational state, and all configured local/object-storage bytes. Capture must run against the installation's actual PostgreSQL or SQLite dialect and actual storage layout; converting through the other dialect first is not source evidence. Unknown/custom tables and unrecognized stored objects follow the same dynamic-capture and explicit-disposition rules. Manifest source profiles: `fastify-postgresql` and `fastify-sqlite`, recorded with the pinned Fastify Drizzle schema/migration revision and configured storage profile.

### A.7 Fastify Argon2id verifier (from Sections 7 and 10.2)

When re-activated, the Fastify Argon2id PHC-string verifier is wrapped the same way as Rails bcrypt: the client recomputes Argon2id from the password and the stored parameters and sends the hash string as `derivedKey`; the server verifies SHA-256 in constant time. Unsupported, malformed, or tampered hashes fail closed without exposing which check failed. Never reverse, decrypt, or replace a legacy password with a generated password during migration.

### A.8 V1 media URL classification (from Section 10.2)

Classify every source V1 `mediaUrls`, `imageUrl`, `audioUrl`, or `photoUrl` value independently before removing those resource columns from the canonical runtime. A URL proven to reference source-owned media is recovered into `File` plus the correct typed relation with checksum evidence. A Story URL that represents externally hosted content is retained as a canonical external-media-link record with exact URL and source order. A redundant deployment-generated serving/signed URL is omitted from runtime only after its underlying media has been accounted for, while its raw value remains in the restricted legacy archive. Ambiguous, unsafe, unreachable, or unsupported values remain archived and require explicit community/operator disposition before the migration can succeed; the transform must not guess from filename or URL shape alone. The migration manifest records the classification and destination/archive reference for every value.

### A.9 Deferred disposition rows (from Section 11)

| Legacy/V1 concept                     | V2 disposition  | Rationale                                                                             |
| ------------------------------------- | --------------- | ------------------------------------------------------------------------------------- |
| Fastify multiple themes per community | IMPROVE/ARCHIVE | Community selects one canonical configuration; every source row remains accounted for |
