# Rails migration operator runbook

This document is the operational companion to the migration contract in `docs/SPEC-V2.md`. It explains how to create and handle a **Stage-1 lossless source bundle** from a legacy Terrastories Rails deployment.

Stage 1 preserves the source. It does **not** yet produce the final canonical V2 runtime database. The later Stage-2 transform consumes a verified bundle and writes the approved V2 SQLite/D1-compatible or PostgreSQL schema.

## Safety boundary

A migration bundle contains sensitive community data. Treat it as a database backup, not as a normal build artifact.

- Run capture only on a trusted migration host.
- Prefer a dedicated PostgreSQL account with the minimum privileges needed to read the complete Rails database.
- The capture transaction is `READ ONLY` and `REPEATABLE READ`; the tool never writes to the source database.
- The PostgreSQL account must be able to see **all** source rows. Capture disables row-security filtering inside the read-only transaction so PostgreSQL fails rather than silently producing a partial bundle when RLS prevents a complete read.
- Never use production/community data in CI, issue attachments, PR comments, public Actions artifacts, or third-party review services.
- Bundle files are created with owner-only permissions on POSIX systems. Encrypt the bundle whenever it leaves the trusted migration host or is retained as a backup.
- Keep retention and deletion under the community/operator's control.

## Supported source contract

Stage 1 supports two pinned `Terrastories/terrastories` revisions selected automatically from the observed `max(schema_migrations.version)` in the source database, and fails closed on any other migration version:

1. **`2024_04_10_210545`** (`schema_migrations.version = '20240410210545'`)
   - Legacy repository: `Terrastories/terrastories`
   - Commit: `f6f033a17bd4a4c600ffea8bc2e773d243f88f72`
   - Contract profile: `rails-2024_04_10_210545`
2. **`2025_11_20_170000`** (`schema_migrations.version = '20251120170000'`)
   - Legacy repository: `Terrastories/terrastories`
   - Commit: `3983848d9ba483e8bf14dcb38d9bafda68685870`
   - Contract profile: `rails-2025_11_20_170000`
   - Schema delta: adds `themes.expose_mapbox_credentials boolean NOT NULL DEFAULT false`

The capture tool records the selected contract profile, observed `schema_migrations` version, and a digest of the **actually discovered** PostgreSQL schema. It validates that the required pinned Rails tables and columns exist (by name and type regardless of column ordinal order), and does not use that allowlist as the universe of preserved data: unknown or community-specific public tables are captured too.

If the source predates, postdates, or has unreviewed schema versions beyond the two supported pins, capture fails closed rather than silently accepting an unreviewed source. Extend and review the source contract before capturing that deployment. If application tables exist outside PostgreSQL's `public` schema, Stage 1 likewise fails closed rather than silently skipping them.

## ActiveStorage blob source

Database rows alone are not a complete Terrastories migration. Every selected ActiveStorage blob is verified by byte size, Rails base64-MD5 checksum (when present), and SHA-256 before the bundle is accepted. Missing, truncated, changed, or corrupt media fails the entire capture.

Stage 1 supports two `--blob-source` modes:

1. **`disk` (default)** — reads from `--blob-root`, which may use either a flat export (`<blob-root>/<key>`) or Rails DiskService layout (`<blob-root>/<first 2 chars>/<next 2 chars>/<key>`).
2. **`s3`** — streams objects directly over AWS Signature Version 4 (`GET`) from `--s3-bucket` and `--s3-region` (with optional `--s3-prefix` and `--blob-concurrency`, default `4`, with bounded retries and exponential backoff). By default, ActiveStorage keys are fetched directly at `<key>` (or `<prefix>/<key>` if `--s3-prefix` is provided).

For `--blob-source s3`, credentials are read **exclusively from environment variables**:

- `AWS_ACCESS_KEY_ID` (required)
- `AWS_SECRET_ACCESS_KEY` (required)
- `AWS_SESSION_TOKEN` (optional, for temporary STS credentials)

Never pass AWS credentials on the command line or store them in `manifest.json` or `validation-summary.txt`.

## Community allowlist (`--community`)

By default, Stage 1 downloads every row in `active_storage_blobs`. When staging or migrating a subset of communities (for example, capturing a single pilot community from a large production S3 bucket), pass `--community <id|slug>` one or more times:

- **All relational source rows are still captured losslessly** in `legacy.sqlite` across every table and community.
- **Only blobs reachable from the selected communities are downloaded**: attachments on `Community`, `Place`, `Speaker`, `Theme`, `User`, and `Media` (via `stories.community_id`) belonging to those communities, plus transitive `ActiveStorage::VariantRecord` and `ActiveStorage::Blob` `preview_image` blobs derived from them.
- **Every other blob is recorded in `manifest.json` with `disposition: "not_selected"`** (preserving `key`, `byteSize`, and `railsChecksum`, with `sha256: null` and no bytes written under `blobs/`), and `validation-summary.txt` reports both `Blobs selected` and `Blobs not_selected` counts.

**A `--community` bundle is partial.** `manifest.json` records `complete: false` (it is `true` only for a full capture with no allowlist) and `validation-summary.txt` says `Status: PARTIAL CAPTURE (community_allowlist) — NOT A COMPLETE SOURCE CAPTURE`. Allowlist bundles are for staging and rehearsal only. Stage 2 must refuse a partial bundle unless the transform is also community-scoped to a subset of the selected communities, and a partial bundle never qualifies for cutover.

Allowlist capture fails closed if `active_storage_attachments` contains any `record_type` outside the known set (`Community`, `Place`, `Speaker`, `Theme`, `User`, `Media`, `ActiveStorage::Blob`, `ActiveStorage::VariantRecord`); the error lists the unknown type names with attachment counts only. Capture without `--community`, or extend the resolver.

## Database credentials

Do **not** put a production database password directly in `--source`; shell history and process listings can expose command-line arguments.

Prefer PostgreSQL's password-file mechanism on the trusted migration host. Create a dedicated `pgpass` file outside the repository, restrict it to the operator, and point libpq-compatible clients at it:

```bash
chmod 600 /trusted/path/terrastories.pgpass
export PGPASSFILE=/trusted/path/terrastories.pgpass
```

Use a source URL that contains the host/user/database identity but not the password. Keep the password file and any environment configuration outside the repository and remove/rotate temporary migration credentials after the operation.

## Capture commands

Local disk export (full):

```bash
npm run migrate:rails:capture -- \
  --source 'postgresql://USER@HOST:PORT/DATABASE' \
  --blob-root /trusted/path/to/active-storage-export \
  --output /trusted/path/to/terrastories-rails-bundle
```

S3 single-community staging capture (credentials from environment only):

```bash
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
npm run migrate:rails:capture -- \
  --source 'postgresql://USER@HOST:PORT/DATABASE' \
  --blob-source s3 \
  --s3-bucket BUCKET_NAME \
  --s3-region us-east-2 \
  --community my-community-slug \
  --output /trusted/path/to/terrastories-rails-bundle
```

(Equivalently: `npx tsx scripts/migrate-rails.ts ...`.)

Do not reuse an output directory. The tool refuses to overwrite an existing destination. It writes to an owner-only temporary directory and only renames that directory to the requested final path after database capture, media verification, SQLite archive self-verification, manifest creation, validation-summary creation, and source-transaction completion all succeed.

If the run fails, there must be no final bundle that could be mistaken for success.

## Bundle contents

A successful Stage-1 directory contains:

```text
terrastories-rails-bundle/
  legacy.sqlite
  manifest.json
  validation-summary.txt
  blobs/
    <active-storage-key>
```

`legacy.sqlite` is a portable source archive. It stores:

- every discovered public source table and row;
- ordered source column metadata including PostgreSQL formatted types, precision/scale/length/default/generation/collation information;
- primary keys, constraints, indexes, and row-security state;
- source values using PostgreSQL text representation to avoid JavaScript bigint/decimal/timestamp precision coercion;
- deterministic per-row and per-table SHA-256 digests.

Before the bundle is accepted, Stage 1 closes and reopens the SQLite archive read-only, runs SQLite integrity/foreign-key checks, re-verifies persisted schema metadata, re-hashes every persisted row and table, and confirms total counts. The final archive byte size and SHA-256 are then recorded in `manifest.json`.

`manifest.json` records the source profile, selected contract profile, pinned legacy commit, observed schema version, actual schema digest, archive size/SHA-256, table/row counts, schema metadata, ActiveStorage metadata, Rails checksums, and blob SHA-256 values. It intentionally does not reproduce full source rows.

`validation-summary.txt` is a human-readable, owner-only acceptance aid. It reports source provenance, archive digest, total/table row counts, and blob count while intentionally excluding source row contents, password hashes, provider/database credentials, reset/session tokens, and media names. It is evidence for Stage-1 source preservation only; it does not declare V2 cutover complete.

## Required verification before accepting Stage 1

A successful process exit is necessary but not sufficient for a real migration. Before accepting a production bundle:

1. Keep the original Rails database backup and original media export unchanged.
2. Confirm the manifest's observed schema version and contract profile, and investigate any unexpected source schema/custom tables rather than deleting them.
3. Confirm all discovered tables have recorded row counts and hashes and that `validation-summary.txt` reports the same aggregate/table counts.
4. Confirm the manifest records `legacy.sqlite` size/SHA-256 and accounts for every ActiveStorage blob, with no missing/checksum failures.
5. Store the bundle encrypted if retained or transferred.
6. Record who performed the capture, the source backup/snapshot identity, capture date, tool commit, and destination custody outside the public repository.
7. Do not delete or alter the legacy deployment solely because Stage 1 succeeded. Cutover requires the later Stage-2 transform plus end-to-end user/data validation from `SPEC-V2.md`.

If custody or transfer could have modified the bundle after capture, recompute and compare the archive/blob SHA-256 values before Stage 2. A hash mismatch invalidates that copy; recreate or restore it from the trusted capture rather than editing the manifest.

## Failure and rerun rules

- Fix the source/export/precondition that caused the failure; do not weaken validation to make the run pass.
- Rerun into a **new empty output path**.
- An unpinned `schema_migrations` version, missing required Rails table/column/type, unreadable source row, row-security visibility problem, unsupported non-public application table, SQLite archive integrity/hash mismatch, missing/corrupt blob, changed row count, or destination collision is a hard failure.
- Do not hand-edit `legacy.sqlite`, `manifest.json`, or `validation-summary.txt` and then treat the result as a valid capture. Recreate the bundle from the authoritative source.

## Stage-2 boundary

Stage 2 consumes the verified Stage-1 bundle rather than querying Rails directly, and maps it into the canonical V2 SQLite/D1-compatible and PostgreSQL schemas:

- map canonical records and preserve/remap IDs explicitly;
- preserve Rails viewer/member/editor/admin/super-admin semantics;
- preserve username-or-email login identifiers and legacy bcrypt hashes as wrapped client-bcrypt verifiers;
- map story audience levels without weakening private/disabled-community publication boundaries;
- migrate every attachment role and external media link;
- retain intentionally non-runtime data (including `themes.expose_mapbox_credentials`, provider credentials, raw timestamps, and operational tables) in the restricted legacy archive;
- fail/manual-disposition contradictory or unmappable source states rather than guessing;
- validate the same canonical fixture against both SQLite/D1-compatible and PostgreSQL targets.

## Stage-2 transform (SQLite target)

```bash
npm run migrate:rails:transform -- \
  --bundle /trusted/path/terrastories-rails-bundle \
  --output /trusted/path/terrastories-v2-out \
  [--community <id|slug> ...] [--include-system-users] [--allow-manual]
```

The bundle is verified first (manifest, archive size/SHA-256, row and table digests, every captured blob's size and SHA-256); any mismatch fails closed. The output directory must not exist. It is written to an owner-only temp directory and renamed on success, so a failed run leaves nothing behind:

- `v2.sqlite` - V2 SQLite migrations applied, canonical rows inserted with legacy primary keys preserved (`idRemaps` in the manifest records any remap; currently none). Foreign-key and integrity checks run before it is accepted.
- `legacy-archive.sqlite` - restricted. Every source row not represented canonically (`archived_rows`) and every archive-only field (`archived_fields`: raw bcrypt hashes, reset tokens, sign-in IPs, theme credentials, raw role/super_admin values, changed descriptions, raw birthdates, sub-millisecond timestamps).
- `v2-media/` and `archive-media/` - verified media objects (see Media below).
- `manifest.json` - input digests, selection, source counts, per-table dispositions, canonical counts, per-field disposition registry, warnings, MANUAL items, the media blob ledger, flipper classification, and checksums of the canonical rows. No timestamps: the same bundle gives a byte-identical manifest.
- `manual-review.json` - ids and codes only (written only with `--allow-manual` when MANUAL items exist).
- `validation-summary.txt` - counts only; no contents or secrets.

### Dispositions

Every source row gets exactly one status per table: `imported`, `not_selected`, `manual`, `excluded_dependency`, `archived` or `pending_media_slice`. Every pinned Rails column has an entry in `src/migration/v2/dispositions.ts` (a test fails if one is missing). Key rules:

- Roles `0/1/2/3/100` map to member/editor/admin/viewer/super_admin. Contradictory `(role, super_admin)` pairs, an unknown role, a super_admin with a community, or a community role without one are MANUAL.
- Blank `username` becomes NULL (never synthesized); `email` may be NULL (migration `users.email` nullable). Same-community normalized email collisions, username collisions, and a username equal to another user's email are MANUAL.
- Story `permission_level` 0/1/2 maps to public/members_only/editors; NULL or unknown is MANUAL (never defaults to public). A public story in a private community stays physically `public`; the community's private flag gates it.
- Defaults recorded as `TRANSFORM_DEFAULT` events plus warnings: community locale NULL to `en`; story title/language and place/speaker name NULL to an empty string.
- Descriptions are sanitized with the migration sanitizer; changed values keep the raw original in the archive.
- Media (`media`, `active_storage_*`) is resolved by the media stage (see below): every row ends `imported` or `archived` (or the status the earlier stages gave it); `pending_media_slice` is an intermediate state that is always 0 in the final manifest. Theme Mapbox/Protomaps settings are imported into `community_map_configs` using the same validators as the API (`src/shared/utils/map-config.ts`): only a public `pk.` token and a valid style URL are imported, and only as a pair (if either half is missing or invalid, neither is imported and a warning is recorded); `sk.`/malformed tokens and invalid style URLs stay in the restricted archive (warning codes `mapbox_token_not_public`, `mapbox_style_url_invalid`, `mapbox_pair_incomplete`; values are never logged). `expose_mapbox_credentials` is reset to false for a private community (`expose_mapbox_credentials_reset_private`), matching Rails.
- Unknown tables are archived whole with a warning; unknown enabled flipper flags are MANUAL.

### Wrapped bcrypt verifiers

A valid Rails hash (`$2a$`/`$2b$`/`$2y$`, cost 4-14) becomes `password_algorithm = client-bcrypt-rails+sha256`, `password_salt` = the 22-character salt, `password_params` = `{"cost":N}` and `password_verifier` = SHA-256 of the hash **normalized to the `$2b$` prefix**. Prelogin does not carry a prefix and the client always recomputes with `$2b$`; for valid input the three prefixes yield an identical hash body, so normalizing preserves every working password (recorded as the `prefix_normalized` field event). Empty hashes become code-only accounts (no verifier); malformed hashes are MANUAL. The raw hash lives only in `legacy-archive.sqlite`. The first successful login upgrades the account to Argon2id through the existing login flow.

### MANUAL handling

By default any MANUAL item fails the run and the error lists `table#id code` lines (no values). Resolve the source data, or pass `--allow-manual` to exclude those rows (and rows depending on them, status `excluded_dependency`) and list them in `manual-review.json`. Excluded rows are archived. MANUAL never guesses a value.

### Scoped runs (`--community`)

`--community <id|slug>` (repeatable) imports only the selected communities; all other rows are `not_selected` and are recorded in the manifest, never silently dropped. Use the same selection for the Stage-1 capture so the media counts reconcile. Null-community super_admins are imported only with `--include-system-users`.

Orphan rows (a join row or media row whose story, place or speaker has no source row):

- full run: MANUAL (`story_missing`, `place_missing`, `speaker_missing`, `orphan_edge`, `media_story_missing`, `attachment_unattributable`);
- scoped run: MANUAL only when the surviving endpoint belongs to a selected community; otherwise `not_selected`.

The media stage handles only media rows, attachments and variant records reachable from a selected community (Media via story, Place, Speaker, Community, Theme, User, and variants/previews via their blob), matching the Stage-1 allowlist. The number of pending blobs equals Stage 1's `blobsSelected`.

### Media: blobs -> files + attachments

Every captured ActiveStorage blob gets exactly one disposition in `manifest.json` `media.blobs` (hard gate: a missing or duplicated blob fails the run):

- **canonical** - one `files` row per destination community (a blob attached in two communities becomes two files with two tenant-scoped storage keys and two verified copies; a file is never shared across tenants; several relations inside one community share one file). The file id is deterministic (derived from blob id and tenant scope) so reruns are byte-identical. Storage key is `communities/<id>/media/<file-id>` (runtime scheme); the null-community super_admin profile photo uses the account namespace `users/<id>/media/<file-id>` with `community_id` NULL and `uploaded_by` NULL. `files` rows are active, `original_name`/`mime_type`/`size`/`metadata` come from the blob, `checksum` is the SHA-256 hex of the bytes.
- **archive** - one protected object under `archive-media/<source-key>` (orphan blobs, `ActiveStorage::VariantRecord` images, `ActiveStorage::Blob` preview images, blobs with no accepted attachment). V2 regenerates variants; the rows and the reason (`orphan`, `derived_variant`, `derived_preview`, `no_accepted_attachment`) are in `legacy-archive.sqlite`.
- **not_selected** - outside a `--community` selection; no bytes were captured.

Roles: Community `display_image` / `background_img` / `sponsor_logos`, User `photo`, Place `photo` / `name_audio`, Speaker `photo`, Media `media` (owner = `media.story_id`), Theme `static_map` (owner = the community's map config, also written to `community_map_configs.static_map_file_id`). An unknown (record_type, name) pair on a reachable attachment is MANUAL (`attachment_role_unknown`). Attachment ids are preserved; `sqlite_sequence` is raised above the highest source attachment id.

Ordering (`attachments.ordinal`) is a 0-based rank inside (destination, owner, role): sponsor logos by attachment id, story media by (`media.id`, attachment id), everything else by attachment id (more than one attachment in a single-slot role raises `multiple_single_slot_attachments`). A `media` row without an attachment is archived with a warning (`media_without_attachment_archived`); its `created_at`/`updated_at` otherwise go to the archive.

Bytes are written into `v2-media/` and `archive-media/` (owner-only, fsynced) inside the same temporary directory as the database, streamed with SHA-256 checked while writing and again after an fsync read-back. Any mismatch aborts the whole run and leaves no output. The output holds a second copy of every selected blob; budget disk for bundle plus output (and fan-out copies).

## Stage-3 load (`migrate:rails:load`)

```bash
npm run migrate:rails:load -- --transform-output <dir> --target <node-sqlite|d1|r2> [--dry-run] ...
```

Every target first re-verifies the output (files table, manifest ledger, size and SHA-256 of every object) and fails closed. `--dry-run` prints counts only.

- **node-sqlite** (`--data-dir`, `--storage-root`): objects are copied first (each verified; an identical existing object is kept, a different one aborts before anything is written), then `v2.sqlite`. An existing database is never overwritten. The storage root is the directory the Node server uses for media.
- **d1** (`--sql-out <new-dir>`): writes a data-only SQL dump (foreign-key ordered, `PRAGMA defer_foreign_keys`, statements below the 100 KB D1 limit, files chunked by `--max-file-bytes`), a `...-sqlite-sequence.sql` file, `d1-import.json` and `r2-upload-manifest.json`. Apply the V2 migrations to D1 first, then `wrangler d1 execute <db> --remote --file <file>` for each file in order. The sequence file is optional if D1 rejects `sqlite_sequence` writes.
- **r2** (`--bucket`, optional `--endpoint`, `--concurrency`): uploads each canonical object over the S3-compatible API (SigV4) with `x-amz-checksum-sha256`, then verifies by HEAD (size and SHA-256 metadata); reruns skip objects that already verify. Credentials come only from the environment: `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID`. Nothing credential-shaped is accepted on the command line, written to a file or printed. Archive objects are never uploaded; they stay in the restricted local archive.

The PostgreSQL target and the validation gates (S4) are not part of this stage, so a Stage-2/3 result is not a cutover; a Stage-1 bundle remains **migration-ready source preservation**, not a completed Terrastories V2 migration.
