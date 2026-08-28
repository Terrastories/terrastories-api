# Terrastories API V2 — Technical Specification

| Field | Value |
| --- | --- |
| **Status** | Canonical — proposed product/architecture source of truth |
| **Created** | 2026-06-07 |
| **Updated** | 2026-08-28 |
| **Authors** | Terrastories Team |
| **Repo** | `terrastories-api` |

---

## 1. Product intent

Terrastories V2 is a deliberate rebuild of the Terrastories backend for long-term maintainability, Indigenous data sovereignty, offline use, and simple deployment.

The legacy Rails application and the Fastify V1 API are **evidence**, not compatibility contracts. V2 does not aim for wire compatibility, identical database schemas, identical endpoint names, or internal architectural parity. Instead, V2 preserves the user-visible Terrastories experience and all community data while intentionally improving the underlying domain model, API, security boundaries, deployment model, and implementation stack.

The governing rule is:

> Preserve the mission, user-visible capabilities, community data, and sovereignty guarantees. Redesign implementation details when the V2 design is simpler, safer, more portable, or easier to maintain. Every material legacy/V1 divergence must be intentional and documented.

## 2. Goals and non-goals

### Goals

| ID | Goal |
| --- | --- |
| G-1 | Run one product across Cloudflare Workers + D1 + R2, Node.js + PostgreSQL + self-hosted storage, and Node.js + SQLite + local filesystem field kits. |
| G-2 | Preserve the user-visible Terrastories experience: public storytelling/map discovery, community content management, visibility rules, media, map configuration, branding, imports, onboarding, profile/auth flows, and system administration needed to operate communities. |
| G-3 | Migrate legacy Rails deployments with **zero unintended data loss**. Every source row, relation, attachment, and field must be mapped, transformed, or preserved in a migration archive with a machine-readable disposition. |
| G-4 | Make D1/SQLite and PostgreSQL equal first-class database targets for shared product semantics. |
| G-5 | Keep field-kit deployments fully usable without runtime cloud dependencies. |
| G-6 | Enforce community isolation and Indigenous data sovereignty structurally and with negative tests. |
| G-7 | Provide a small, explicit, versioned V2 API contract that is easier to maintain and evolve than Rails or Fastify V1. |
| G-8 | Remove accidental V1 scope and duplicated domain concepts rather than carrying them forward indefinitely. |

### Non-goals

- Wire compatibility with legacy Rails endpoints or Fastify V1.
- Reproducing Rails/Fastify response shapes solely for compatibility.
- Preserving obsolete internal models when their user-visible outcome can be represented more simply.
- Continuous synchronization between legacy and V2 after cutover.
- PostGIS or any database-specific spatial product semantics.
- Elder role/elder-only restrictions, elder speaker status, cultural-significance metadata, community cultural-settings blobs, story-place cultural-context fields, or the removed cultural-restriction schema.
- Rebuilding Rails-only tables that have no current user-visible product role. Their data must still be preserved by migration when present.

## 3. Authority and intentional-evolution policy

When V2 work encounters behavior or data from Rails/Fastify that is not already represented here, classify it before implementation:

- **RETAIN** — the behavior/data remains valuable and is kept substantially unchanged.
- **IMPROVE** — the same user need is preserved with a deliberately better V2 model or API.
- **ARCHIVE** — not part of the V2 runtime product, but source data is retained losslessly by migration.
- **DROP** — only permitted for non-data-bearing implementation artifacts with no current product value. Data-bearing source fields are never silently dropped.
- **DEFER** — potentially useful product work that is not required for V2 launch; existing source data is archived if applicable.

An implementation, old test, issue, or existing Fastify behavior cannot silently redefine V2. Material changes to this specification require explicit review and approval.

## 4. User-experience continuity contract

V2 may use new APIs and a new frontend integration, but the migration/cutover must not remove established user-facing capabilities without an explicit product decision.

### Public experience

V2 must support:

- public/private community discoverability;
- public place-based story browsing and map presentation;
- story detail with speakers, places, interview metadata, uploaded media, and external media links;
- filtering/search by place, region, place type, topic, language, speaker, and speaker affiliation where data exists;
- community map style/view configuration and community branding assets.

### Community member experience

V2 must support:

- login/logout, profile, and password-management flows;
- community-scoped story, place, speaker, user, and map-configuration management according to role;
- uploaded story media, place/speaker/user/community images, place-name audio, and external story links;
- CSV preview/import capability for places, speakers, and stories, with validation before commit;
- onboarding required to create/configure a community and its initial administrator.

### System administration

V2 must support system-level community/user lifecycle operations required to operate hosted deployments. System privilege must not imply access to protected community content.

### Compatibility boundary

The experience contract is normative; Rails routes, Jbuilder payloads, Fastify routes, CSS/layout, and database column names are not. Frontends may require an intentional adapter/migration to consume V2.

## 5. Deployment architecture

| Mode | Runtime | Database | Storage | Runtime cloud dependency |
| --- | --- | --- | --- | --- |
| **Hosted** | Cloudflare Workers | D1 / SQLite semantics | R2 | Cloudflare only |
| **Self-hosted** | Node.js | PostgreSQL | pluggable self-hosted/object/local storage | none required beyond configured deployment dependencies |
| **Field kit** | Node.js | SQLite | local filesystem | none |

All modes share domain/service behavior. Runtime, database, storage, hashing, and session implementations live behind explicit adapters where platform differences require them.

### Portability invariant

There is one canonical **logical relational schema and behavior contract**. Dialect-specific Drizzle definitions or migration files are allowed when tooling requires them, but SQLite/D1 and PostgreSQL may not expose different product semantics.

Shared behavior must remain SQLite-compatible. PostgreSQL-only extensions may not become product requirements.

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
- Slugs are stable and unique. V2 may generate them automatically.
- Rails `beta` and Fastify `culturalSettings` are not canonical community domain fields. Legacy values are archived during migration where present.

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

- `viewer` — may view public content only; authenticated account features do not expand community-content visibility.
- `member` — may view public and community-visible content for their community.
- `editor` — member access plus content creation/editing.
- `admin` — editor access plus community/user administration.
- `super_admin` — system-level administration only; does not gain protected community-content access through privilege.

`communityId` is required for community roles and nullable for `super_admin`.

V2 keeps the meaningful Rails `member` versus `viewer` distinction because it affects the user-visible privacy model. The duplicated Rails `super_admin` boolean is normalized into the role enum.

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

Do not combine `privacyLevel`, `isRestricted`, elder-only flags, or other overlapping privacy mechanisms with this field.

`createdBy` is nullable in storage so imported/historical records can be represented truthfully; new application-created stories must record the actor when known.

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
  birthdate?
  birthplaceId?
  affiliation?
  createdAt
  updatedAt
```

`affiliation` is the V2 name for the user-facing concept previously stored as Rails `speaker_community`.

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
  createdAt
  updatedAt
```

- One configuration per community.
- Provider credentials/tokens are deployment secrets, not domain data.
- Map configuration is provider-neutral; Mapbox/Protomaps-specific naming must not leak into the canonical model unless required by an adapter.
- Legacy provider credentials are preserved in the restricted migration archive/report and require explicit operator handling during cutover rather than being copied into ordinary V2 rows.

### 6.7 Files and media

File identity must be independent of storage URLs and deployment providers.

```text
File
  id
  communityId
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
- community display image, background image, and ordered sponsor logos.

Do not duplicate media identity in `mediaUrls`, `imageUrl`, `audioUrl`, `photoUrl`, or similar resource columns.

`uploadedBy` is nullable so imported ActiveStorage objects can be represented without inventing provenance.

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
- super-admin attempts to read protected community content.

## 8. Database and storage rules

- D1/SQLite and PostgreSQL are equal required CI/release targets for shared behavior.
- No PostGIS or database-specific spatial extension in shared V2 semantics.
- Use Drizzle/parameterized query APIs for application data access by default.
- Raw SQL is allowed only when necessary behind repository/migration boundaries; it must be parameterized and either portable or explicitly dialect-scoped with equivalent behavior tests.
- JSON fields are storage containers unless a capability is explicitly proven portable; shared product behavior must not depend on PostgreSQL JSONB-only operators.
- Risky schema changes use expand/contract or a tested backup/restore/forward-fix strategy.
- Media storage keys are community-scoped and server-generated; user filenames are metadata only.

## 9. API contract

V2 owns its own API contract. Rails/Fastify are not normative transports.

Preferred namespaces:

```text
/v2/public/*   unauthenticated public projections
/v2/*          authenticated community API
/v2/admin/*    system administration
```

Do not duplicate resource CRUD merely because a user is a "member"; authorization belongs in policy/service boundaries.

Requirements:

- consistent typed success/error contracts;
- Zod/OpenAPI generated from the same source where practical;
- stable pagination and filtering semantics;
- community identity derived from authenticated context where possible rather than caller-selected tenant IDs;
- intentional breaking changes after V2 release require versioning/deprecation/migration notes and CI detection.

During Fastify/Hono coexistence, contract tests may execute both transports to detect accidental regressions, but Fastify output is not the V2 oracle. The canonical V2 contract is.

## 10. Legacy Rails migration contract

Migration is a one-time deterministic ETL from a real Rails deployment into V2. It is not a raw PostgreSQL-to-SQLite conversion.

### 10.1 Source of truth for migration

The migration reader must be validated against the legacy Rails repository's actual schema and ActiveStorage model, including:

- communities;
- users and integer roles;
- stories and permission levels;
- places, including nullable coordinates;
- speakers;
- themes/map settings;
- story-place and story-speaker relations;
- story media and `media_links`;
- ActiveStorage blobs, attachments, and variant records;
- user/place/speaker/community ActiveStorage attachments;
- curriculums/curriculum-stories and other data-bearing legacy tables even when not part of the V2 runtime product.

Legacy FactoryBot factories are useful for representative values but are not sufficient as the migration schema contract.

### 10.2 Preservation rules

- Preserve legacy primary IDs for canonical domain records when doing so is safe; record any remap explicitly.
- Never invent required foreign keys/provenance merely to satisfy a stricter V2 schema.
- Preserve nulls when absence is meaningful; application creation rules may be stricter than import/storage rules.
- Map Rails story permission values deterministically to V2 visibility.
- Preserve user role semantics, including `viewer` versus `member`.
- Preserve every relationship edge and relationship multiplicity.
- Copy media bytes, MIME type, filename, byte size, checksum, and attachment role; verify checksums after write.
- Preserve legacy external media links.
- Preserve legacy bcrypt hashes with algorithm metadata for lazy upgrade.
- Never silently discard a source field. Fields intentionally absent from canonical V2 go to a machine-readable legacy archive.

### 10.3 Migration artifacts

Each run must produce:

1. the V2 database;
2. migrated media/storage objects;
3. a machine-readable migration manifest with source/target counts, ID mappings, field dispositions, warnings, and checksums;
4. a restricted **legacy archive** containing every data-bearing source row/field not represented canonically in V2;
5. a human-readable validation summary that fails the run on unexplained differences.

The legacy archive is not queried by the runtime application and must not become a backdoor around community authorization. It exists solely to make intentional model simplification compatible with zero unintended data loss.

### 10.4 Validation gates

A migration is successful only when automated checks prove:

- source and target/archive account for every source table, row, and data-bearing column;
- canonical entity counts and IDs match the migration manifest;
- all foreign keys and many-to-many edges are accounted for;
- nullable/edge states survive correctly;
- every ActiveStorage attachment is accounted for and migrated bytes match source checksums;
- external media links are preserved;
- role and visibility behavior matches the experience contract;
- public/private community behavior is preserved;
- public map/filter data remains representable;
- migration is deterministic and safe to re-run against a fresh destination;
- failure is atomic or leaves an explicitly disposable incomplete destination, never a falsely successful partial migration.

The same canonical migrated fixture must validate on SQLite/D1-compatible and PostgreSQL V2 targets. SQLite export is additionally required for field-kit migration.

## 11. Legacy disposition at V2 launch

| Legacy/V1 concept | V2 disposition | Rationale |
| --- | --- | --- |
| Communities, stories, places, speakers | RETAIN/IMPROVE | Core Terrastories domain |
| Rails story permission levels | IMPROVE | One `visibility` enum preserves the same audience distinctions |
| Rails `viewer` and `member` distinction | RETAIN | User-visible access difference must survive |
| Story/place/speaker relationships | RETAIN | Core narrative/map data |
| Uploaded media and external media links | IMPROVE | Normalize around `File` + explicit relations; preserve every item |
| Community/user/place/speaker attachments | IMPROVE | Normalize into the same media system |
| Rails Theme | IMPROVE | Replace provider-specific singleton theme with `CommunityMapConfig` |
| Map provider credentials in DB | IMPROVE/ARCHIVE | Move secrets out of domain rows; preserve source value in restricted migration artifact |
| CSV imports | RETAIN/IMPROVE | Preserve user workflow with a typed/validated V2 implementation |
| Rails `curriculums` | ARCHIVE by default | Schema exists but no current Rails route exposes it; do not rebuild runtime product without evidence of active user need |
| Rails Flipper tables | ARCHIVE/replace operationally | Feature-toggle implementation detail, not community domain data |
| Fastify elder role/restrictions | DROP | Explicit V1 scope creep; not a Rails user requirement |
| Cultural-significance/settings/context V1 fields | DROP from canonical runtime; archive if source data exists | Avoid unreviewed cultural-protocol semantics |
| PostGIS behavior | DROP | Portability and offline operation are higher-value requirements |
| Persisted resource media URLs | DROP | URLs are deployment-specific derived values |

## 12. Testing and release gates

### Canonical contract tests

Build a fail-closed V2 behavior contract suite. It defines approved V2 behavior and must cover public, authenticated community, admin, auth/session, media, import, spatial, validation/error, and sovereignty paths.

Legacy/Fastify comparison tests may help discover omissions, but an old behavior becomes normative only after it is classified under Section 3 and represented in this spec/contract.

### Database tests

Required CI must exercise shared schema/repository/migration behavior against both:

- SQLite/D1-compatible execution; and
- PostgreSQL.

Both paths must cover fresh schema creation, supported upgrades, constraints, indexes, timestamps, booleans, null/unique behavior, transactions, JSON serialization, ordering/pagination, and portable spatial behavior.

### Deployment tests

Required release evidence covers Workers+D1+R2, Node+PostgreSQL, and offline Node+SQLite profiles. Field-kit tests must fail if a required runtime path reaches an external cloud dependency.

### Security tests

Auth, sessions, files/media, imports, migration, community isolation, public/private visibility, exports, and super-admin boundaries require negative/adversarial coverage.

## 13. Phased path

1. **Contract correction** — approve this V2 source-of-truth model and update dependent issues/plans.
2. **Transport foundation** — finish Hono coexistence while treating canonical V2 behavior, not Fastify parity, as destination truth.
3. **Domain/schema normalization** — remove V1 scope creep and duplicated privacy/media/provider concepts; establish the canonical logical schema on both DB targets.
4. **Production adapters** — D1/PostgreSQL/SQLite, R2/local storage, durable sessions, password hashing, deployment hardening.
5. **Rails migration tooling** — deterministic ETL + real Rails-shaped fixtures + media/archive/checksum validation.
6. **Frontend/cutover validation** — prove established user workflows against migrated representative data before production cutover.
7. **Release** — exact-revision production-readiness gate across hosted, self-hosted, and field-kit profiles.

## 14. Resolved architectural decisions

| Question | Decision |
| --- | --- |
| Legacy compatibility target? | Preserve user experience and data; do not preserve Rails/Fastify wire/internal compatibility. |
| HTTP framework? | Hono. |
| Database targets? | D1/SQLite and PostgreSQL equal first-class. |
| Physical schema? | One logical schema/behavior contract; dialect-specific definitions/migrations allowed when required. |
| Spatial behavior? | Plain lat/lng + application-level portable logic; no PostGIS. |
| Story privacy? | One `public | community | editors` visibility field. |
| User roles? | `viewer`, `member`, `editor`, `admin`, `super_admin`; no elder role. |
| Sessions? | Durable database-backed authoritative sessions; memory dev/test only. |
| Media? | One `File` identity model + explicit typed relations; URLs derived by storage adapter. |
| Map configuration? | One provider-neutral `CommunityMapConfig` per community; provider credentials are secrets. |
| Legacy removed data? | Preserve in migration archive; never silently discard. |
| Password migration? | Verify legacy bcrypt on login, then rehash with current V2 hasher. |
| Migration strategy? | Deterministic one-time ETL from real Rails schema/ActiveStorage with checksummed validation. |
| API compatibility after V2 release? | Protect released V2 contracts with OpenAPI/contract CI and explicit versioning/deprecation policy. |

## 15. Change log

| Date | Changes |
| --- | --- |
| 2026-06-07 | Initial V2 Cloudflare/Hono specification. |
| 2026-08-17 | Reaffirmed Hono, equal D1/SQLite + PostgreSQL targets, field-kit support, no PostGIS, and sovereignty constraints. |
| 2026-08-28 | Reframed V2 from legacy wire/feature parity to intentional evolution: preserve user experience and all source data while simplifying the domain. Added canonical visibility/role/media/map/session models, real Rails migration contract, archive requirement for intentionally removed data, and V2-native contract testing. |
