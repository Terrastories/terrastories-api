# Legacy Rails migration fixtures

These fixtures are the source contract for the Rails-to-V2 migration safety tests.

- Legacy repository: `Terrastories/terrastories`
- Pinned legacy commit: `f6f033a17bd4a4c600ffea8bc2e773d243f88f72`
- Rails schema version: `2024_04_10_210545`
- Canonical source file: `rails/db/schema.rb`

`schema.rb` is copied verbatim from that pinned commit for review provenance. `schema.sql` is the executable PostgreSQL equivalent used by integration tests. It intentionally includes Rails runtime metadata tables (`schema_migrations` and `ar_internal_metadata`) so the capture test proves that tables outside the hand-maintained domain allowlist are still archived.

`data.sql` combines representative Rails values with edge cases that FactoryBot does not cover: every user role, a system user with no community, all story permission levels, private/public communities, nullable coordinates, interview relations, many-to-many joins, full map configuration, external media links, curriculums, Flipper state, and ActiveStorage attachment roles.

`blobs/fixtureblob` is a deterministic ActiveStorage payload. Its Rails checksum is `VMUF7/0JWAABfjohpyP8FQ==` (base64 MD5), its SHA-256 is `0ec70a2413d61dfe7639d725d34f3781ece06b44f6b41c386a5605700c00c4e1`, and its size is 47 bytes.

These fixtures are intentionally not the only protection against data loss. The capture implementation discovers and archives every source table and column at runtime, then fails if the required pinned Rails tables/columns are missing. Unknown/custom tables are preserved rather than ignored.
