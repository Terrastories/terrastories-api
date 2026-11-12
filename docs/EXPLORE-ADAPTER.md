# Explore read adapter (#198)

Transitional, read-only path set that serves the Rails-shaped JSON the current
Explore client (`explore-terrastories`) requests, mapped from V2 data on the
Hono app. Registered under `/explore/*` (point the client's `VITE_API_BASE` at
`{origin}/explore`). It applies the same sovereignty rules as the canonical API
(docs/SPEC-V2.md §9) and is **removed once the V2 frontend uses the canonical
API**; it is not a second canonical namespace.

- Implementation: `src/explore-adapter.ts` (routes, mounted by
  `src/hono-app.ts`), `src/services/explore-adapter.service.ts` (Rails shapes),
  `src/repositories/explore-adapter.repository.ts` (read-only queries).
- Contract tests: `tests/hono/explore-adapter.test.ts` (SQLite), using request
  shapes recorded from the Explore client's `src/api/*`.
- Legacy evidence: `rails/config/routes.rb` namespace `:api`,
  `rails/app/controllers/api/*`, `rails/app/views/api/**/*.jbuilder`.

## Rules enforced on every route

| Rule | Enforcement |
| --- | --- |
| Public projections only | Anonymous caller semantics regardless of cookies; no session widens access |
| Community gate (§4/§6.1) | `communities.public_stories = true` AND `communities.is_active = true` in SQL before any projection |
| Story gate (§6.3, option A) | Only `privacy_level = 'public'` AND `is_restricted = false` rows (the SQL transcription of `fastifyStoryToAudience` → `public`). `is_restricted` rows, unknown privacy levels, and every other audience are **never** exposed |
| Same-404 (§6.4a) | Unknown, withheld, malformed, and out-of-range ids answer the identical 404 body as missing ids |
| Place/speaker visibility (§6.4a) | Places/speakers appear only through association (story edge or interview location/interviewer) with a publicly readable story; restricted places never; speakers with `is_active = false` (withdrawal) never |
| Map credentials (§6.6) | `mapboxAccessToken` is always `null`; `NEVER_EXPOSED_FIELDS_BY_FAMILY.themes` |
| Transport | `(req: Request) => Promise<Response>` via Hono `app.fetch`; GET only; no Node-only APIs in the request path (Workers-compatible, covered by `tests/hono/worker.test.ts` bundling); no interactive transactions |
| Logging | The adapter logs nothing and puts no cultural content in any response (`cultural_settings`, `cultural_significance`, `cultural_context`, `cultural_restrictions` are never projected) |

## Endpoints served

All responses use the Rails jbuilder envelopes. Withheld/unknown resources
answer Rails' exact error bodies.

| Adapter route | Rails route | Response |
| --- | --- | --- |
| `GET /explore/communities?search=` | `api/communities#index` | `{ data: [card] }` |
| `GET /explore/communities/:slug` | `api/communities#show` | `{ data: detail }` or 404 `{ error: "Community Not Found" }` |
| `GET /explore/communities/:slug/stories` | `api/stories#index` | `{ data: { points, stories }, meta }` or 404 base |
| `GET /explore/communities/:slug/stories/:storyId` | `api/stories#show` | `{ data: story }` or 404 base |
| `GET /explore/communities/:slug/places/:placeId` | `api/places#show` | `{ data: place }` or 404 base |
| `GET /explore/media/:fileId` | (ActiveStorage blob URLs) | branding bytes or 404 base |

The 404 base body is Rails' `Api::BaseController#not_found`:
`{ "error": "Not Found", "message": "The requested resource could not be found." }`.

### Communities index (`?search=`)

Rails field → V2 source:

| Rails field | V2 mapping |
| --- | --- |
| `name`, `description`, `slug` | `communities` columns |
| `createdAt`, `updatedAt` | `communities` timestamps, ISO 8601 |
| `displayImage` | canonical branding File (`community_media` kind `branding`) → `{origin}/explore/media/{fileId}`; omitted when none |
| `mapConfig.mapboxAccessToken` | always `null` (credentials are secrets, §6.6) |
| `mapConfig.mapboxStyle` | active theme `mapbox_style_url`, served only when it is an `http(s)` URL (usable without credentials, mirroring Rails' `use_maplibre?` gate); `mapbox://` styles → `null` |
| `mapConfig.mapbox3dEnabled` | `false` (no V2 column; Rails default) |
| `mapConfig.mapProjection` | `null` (no V2 column) |
| `mapConfig.center` | `[centerLong, centerLat]`, nulls preserved |
| `mapConfig.zoom` / `pitch` / `bearing` | `null` (no V2 columns) |
| `search` | case-insensitive name substring (`containsInsensitive`, portable across SQLite/D1 and PostgreSQL); ordering `updated_at DESC` with id tie-break |

### Community show (`:slug`)

| Rails field | V2 mapping |
| --- | --- |
| `name`, `slug`, `description`, `details.name`, `details.description` | `communities` |
| `details.sponsorLogos` | `[]` (no V2 sponsor-logo relation; see below) |
| `details.displayImage` | same branding File as above |
| `storiesCount` | count of publicly readable stories (no join requirement, matching Rails `.size`) |
| `points` | distinct publishable places of all publicly readable stories via `story_places` edges (Rails `public_points.uniq`): unrestricted, valid coordinate pair |
| `categories` | Rails `Community::FILTERABLE_ATTRIBUTES` verbatim: `places, region, type_of_place, speakers, topic, language, speaker_community` |
| `filters[].places` | unrestricted places with a `story_places` edge to a public story (`{label: name, value: id}`) |
| `filters[].region` | non-blank distinct regions of those places |
| `filters[].language` | distinct non-blank languages of publicly readable stories |
| `filters[].speakers` | active speakers with a `story_speakers` edge to a public story |
| `filters[].type_of_place` / `topic` / `speaker_community` | never populated (no V2 columns; see below) |
| `mapConfig.*` | index shape plus `centerLat`, `centerLong`, `swBoundaryLat/Long`, `neBoundaryLat/Long`, `maxBounds` (`[[swLong, swLat],[neLong, neLat]]` or `null`, exactly Rails `Theme#boundaries`) |

Point features are Rails `public_point_feature`: `{ type: "Feature", id, geometry: { coordinates: [long, lat] }, properties: { name, description, placenameAudio, photo, thumbnail, region, typeOfPlace } }`; media properties are `null` (no V2 place-photo/name-audio relation).

Multiple active themes (a V1 state) resolve deterministically to the lowest
theme id; zero active themes produce an all-null mapConfig.

### Stories index

Query (Rails `story_params`; arrays accepted as `key[]=` and `key=`):

| Param | Mapping |
| --- | --- |
| `limit` (default 10, 1–100), `offset` (default 0) | pagination |
| `sort_by` `created_at`\|`title` (default `created_at`), `sort_dir` `asc`\|`desc` (default `desc`) | ordering with stable id tie-break; `title` uses byte-order `textOrder` for identical SQLite/PostgreSQL results |
| `places` (ids), `region`, `language`, `speakers` (ids) | SQL filters; a story must have ≥1 place edge and ≥1 speaker edge (Rails `joins(:places, :speakers)`, `distinct`) |
| `topic`, `type_of_place`, `speaker_community` | accepted and echoed in `nextPageMeta`, but no story can match (no V2 representation) |

Response: `data.points` are the distinct places of the **whole filtered
relation** (not just the page — Rails comment: "all points in the data relation
should be returned"); `data.stories[]` carry `id`, `title`, `topic` (`null`),
`desc`, `language`, `createdAt`, `updatedAt`. `meta` is Rails `Page`:
`{ total, hasNextPage, nextPageMeta }` where `nextPageMeta` echoes received
filters plus `sort_by`, `sort_dir`, `limit`, and `offset` (next offset or
`null`).

### Story show

| Rails field | V2 mapping |
| --- | --- |
| `id`, `title`, `desc`, `language` | story columns (`description` → `desc`); `topic` → `null` |
| `media` | `[]` (no canonical public story-media relation; see below) |
| `interviewer.name` | active same-community speaker named by `interviewer_id`; key omitted when withdrawn/absent |
| `interviewLocation.name` | unrestricted same-community place named by `interview_location_id`; key omitted otherwise |
| `speakers[]` | active speakers with a `story_speakers` edge: `{ id, name, speakerCommunity: null, birthdate: null }` |
| `places[]` | publishable places with a `story_places` edge: `{ id, name, description, region, placenameAudio: null, photoUrl: null, typeOfPlace: null, center: <GeoJSON feature, properties null> }` |
| `points` | point features of those places |

### Place show

`{ id, name, description, region, placenameAudio: null, typeOfPlace: null, points: [pointFeature] }`.
Unlike Rails (which served **any** place of a public community), a place is
served only when SPEC §6.4a makes it visible to an anonymous caller: it must be
associated with a publicly readable story through a `story_places` edge or as
that story's `interview_location_id`. Otherwise the same 404 as a missing id.

### Media (`/explore/media/:fileId`)

The adapter's URL fields point here instead of Rails' ActiveStorage blob URLs.
Serves a canonical branding File's bytes (`files.path` storage key through the
storage adapter) only when: `community_media` kind `branding` binds it, the
file is active, `cultural_restrictions` is null, the file's community is the
binding community, that community is public **and** active, and the storage key
is well-formed and community-scoped. Everything else — including cross-tenant
bindings, private/disabled communities, and path traversal — answers 404 before
storage is touched. Response headers mirror `/v2/media/:id` (`attachment`,
`no-store`, `nosniff`, sandbox CSP).

## Deliberately not served

Fields/endpoints the V2 schema has no canonical public representation for.
They are emitted as Rails-shaped `null`/omitted/`[]` — never fabricated from
unclassified V1 media columns (SPEC Appendix A.8 defers their classification) —
and flip on once the canonical model (#145/#146) lands them:

| Legacy field | Treatment | Reason |
| --- | --- | --- |
| `story.topic` / `filters.topic` | `null` / no options | canonical `topic` (#189) not yet physical; V1 `tags` are multi-value and may not be collapsed (Appendix A.2) |
| `place.typeOfPlace` / `filters.type_of_place` | `null` / no options | no V2 column |
| `speaker.speakerCommunity` / `filters.speaker_community` | `null` / no options | no V2 column (canonical `affiliation` pending) |
| `speaker.birthdate`, `speaker.birthplace`, `speaker.photoUrl` | `null` / omitted | no V2 column/relation; V1 `birth_year` must not be inflated into a fabricated date (§10.2 source precision) |
| `story.media`, `mediaContentTypes`, `mediaPreviewUrl` | `[]` / omitted | V1 `attachments`/`media_urls` are unclassified legacy media (Appendix A.8); no canonical public story-media relation yet |
| `place.photoUrl`, `placenameAudio`, point `photo`/`thumbnail` | `null` | no canonical place-photo/name-audio relation yet |
| `community.staticMapUrl` | omitted | canonical `CommunityMapConfig.staticMapFileId` not yet physical |
| `details.sponsorLogos` | `[]` | no sponsor-logo attachment relation (`community_media` kind check constraint allows only `branding`) |
| `mapboxAccessToken`, `mapbox://` styles | `null` | provider credentials are deployment secrets (§6.6) |
| `mapConfig.zoom`, `pitch`, `bearing`, `mapProjection`, `mapbox3dEnabled` (real values) | `null` / `false` | columns exist only in Rails `themes`; V2 map config fields pending (#145/#146) |
| Rails routes outside `namespace :api` | none | member/super-admin/session routes are not public Explore surfaces |

## Intentional divergences from Rails (IMPROVE)

- Disabled/private communities are invisible everywhere (Rails `where(public:
  true)` only; V2 adds the lifecycle gate, §4).
- Restricted places and withdrawn speakers never appear in any projection
  (Rails had no such concepts).
- Place show requires a §6.4a story association (Rails served every place of a
  public community).
- Points require a valid coordinate pair (Rails only required non-null).
- Invalid query values answer 400 instead of Rails' coercion/500; `limit` is
  capped at 100.
- Ordering has a stable id tie-breaker on every sort (§4).
- Media is served from the V2 File model + storage adapter with tenant checks,
  not from ActiveStorage URLs.

## Removal

Delete `src/explore-adapter.ts`, the two adapter modules, the
`registerExploreAdapter` call in `src/hono-app.ts`, the `connection` getter on
`HonoFoundationRepository`, this document, and the contract test when the V2
frontend consumes the canonical API (#185). The route set is also registered in
the #134 route registry discussion as a transitional path set.
