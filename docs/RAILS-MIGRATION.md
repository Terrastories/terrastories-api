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

## ActiveStorage prerequisite

Database rows alone are not a complete Terrastories migration. Export the bytes for every `active_storage_blobs.key` before capture.

The `--blob-root` directory may use either:

1. a flat object-store export where each object is stored as `<blob-root>/<key>`; or
2. Rails DiskService layout `<blob-root>/<first 2 chars>/<next 2 chars>/<key>`.

The tool rejects unsafe keys, requires bytes for every ActiveStorage blob, checks the source byte size, verifies the Rails base64-MD5 checksum when present, copies the file, then re-checks the written destination bytes and records SHA-256. Missing, truncated, changed, or corrupt media fails the entire capture.

For S3-backed legacy installations, make a complete trusted local export of the object keys before invoking the tool. Do not put S3 credentials into the bundle or command output.

## Database credentials

Do **not** put a production database password directly in `--source`; shell history and process listings can expose command-line arguments.

Prefer PostgreSQL's password-file mechanism on the trusted migration host. Create a dedicated `pgpass` file outside the repository, restrict it to the operator, and point libpq-compatible clients at it:

```bash
chmod 600 /trusted/path/terrastories.pgpass
export PGPASSFILE=/trusted/path/terrastories.pgpass
```

Use a source URL that contains the host/user/database identity but not the password. Keep the password file and any environment configuration outside the repository and remove/rotate temporary migration credentials after the operation.

## Capture command

```bash
npm run migrate:rails:capture -- \
  --source 'postgresql://USER@HOST:PORT/DATABASE' \
  --blob-root /trusted/path/to/active-storage-export \
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

Until Stage 2 exists and passes those gates, a Stage-1 bundle is **migration-ready source preservation**, not a completed Terrastories V2 migration.
