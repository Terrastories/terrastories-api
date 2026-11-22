# Legacy Rails migration fixtures

Synthetic fixtures for the Rails-to-V2 Stage-1 capture contract and safety tests. Never place real community data or production credentials in this directory.

## Pinned Rails schema references

Stage-1 capture accepts exactly two pinned Rails revisions selected from observed `max(schema_migrations.version)` and fails closed on any other version:

1. **`2024_04_10_210545`** (`schema_migrations.version = '20240410210545'`)
   - Legacy repository: `Terrastories/terrastories`
   - Pinned commit: `f6f033a17bd4a4c600ffea8bc2e773d243f88f72`
   - Provenance file: `schema.rb`
   - Executable SQL: `schema.sql`
2. **`2025_11_20_170000`** (`schema_migrations.version = '20251120170000'`)
   - Legacy repository: `Terrastories/terrastories`
   - Pinned commit: `3983848d9ba483e8bf14dcb38d9bafda68685870`
   - Provenance file: `schema-2025_11_20.rb`
   - Executable delta SQL: `schema-2025_11_20.delta.sql` (adds `themes.expose_mapbox_credentials boolean DEFAULT false NOT NULL` and inserts `20251120170000`)

## Synthetic fixture data (`data.sql` and `edge-data.sql`)

Generated deterministically by `scripts/fixtures/gen-rails-fixture.ts` and committed as static SQL + DiskService blobs:

- Communities: public/private communities with multilingual names (Portuguese, Spanish, Cyrillic), plus a community with `locale = NULL` and `slug = NULL`.
- Users: every role (`0`, `1`, `2`, `3`, `100`), contradictory `(role, super_admin)` pairs `(2, true)` and `(100, false)`, null-community `super_admin`, blank `username = ''`, `email = NULL`, cross-community duplicate email, same-community case collision, cross-kind username/email collision, empty `encrypted_password`, valid `$2a$10$` / `$2a$12$` / `$2b$10$` bcrypt hashes, and malformed hashes (truncated, `$2x$`, cost 15).
- Obviously-fake fixture passwords used to generate the static bcrypt hashes (for Stage-2/rehearsal auth tests only):
  - user `20` (`viewer_rio`): `fixture-pass-viewer-2026` (`$2a$10$`)
  - user `21` (`member_rio`): `fixture-pass-member-2026` (`$2a$12$`)
  - user `22` (`editor_rio`): `fixture-pass-editor-2026` (`$2b$10$`)
  - user `23` (`admin_rio`): `fixture-pass-admin-2026` (`$2a$12$`)
  - user `24` (`superadmin`): `fixture-pass-super-2026` (`$2a$12$`)
  - user `25` (`member_sierra`): `fixture-pass-sierra-2026` (`$2a$10$`)
  - user `27` (`nullemail_user`): `fixture-pass-nullemail-2026` (`$2a$10$`)
  - user `28` (`viewer_dup_case`): `fixture-pass-dupcase-2026` (`$2a$10$`)
  - user `29` (`editor@example.org`): `fixture-pass-crosskind-2026` (`$2a$10$`)
  - user `203` (`cost15_user`, malformed over-max cost): `fixture-pass-cost15-2026` (`$2a$15$`)
- Stories, places, speakers, themes, relations, operational & custom tables: permission `0`/`1`/`2`/`NULL`, blank/non-blank/null topics, null language, cross-community interviewer, duplicate `places_stories` edge, null & 6-dp boundary coordinates, midnight-UTC boundary speaker birthdates, projection `7` (`globe`) theme with placeholder tokens, `media_links` including `url = NULL`, `curriculums`/`curriculum_stories`, Flipper `public_communities` / `split_settings` / `custom_pilot_flag`, plus `community_notes` and wide `community_extension_wide`.

## ActiveStorage DiskService blobs (`blobs/<k[0:2]>/<k[2:4]>/<key>`)

14 deterministic blobs covering every attachment role (`Media:media`, `Place:photo`, `Place:name_audio`, `Speaker:photo`, `User:photo`, `Community:display_image`, `Community:background_img`, ordered `Community:sponsor_logos` trio, `Theme:static_map`), a cross-community `sharedblob01`, an unattached `orphanblob01`, and `variantblob1` attached to `ActiveStorage::VariantRecord` (`blob_id = 101`). Negative corrupt-checksum and missing-file cases are constructed in test temp dirs from these payloads.

Regenerate deterministically with:

```bash
npx tsx scripts/fixtures/gen-rails-fixture.ts
```
