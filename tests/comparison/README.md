# API comparison scope

This directory snapshots the current **V1 Fastify** behavior so issue #133 can keep the pre-Hono baseline deterministic. It is evidence about V1; it is **not** allowed to redefine the V2 contract.

`docs/SPEC-V2.md` is authoritative for V2. In particular, its removed-scope list excludes the elder role/restrictions and cultural-metadata behavior, and its database contract excludes PostGIS/database-specific spatial semantics.

## Classification rule

- Normal endpoint/status/shape/auth assertions in `*.comparison.test.ts` are legitimate V1 compatibility observations and may be promoted to V2 parity only when the same behavior is required by `SPEC-V2.md`.
- Assertions explicitly marked **V1-ONLY SCOPE CREEP** preserve a current V1 regression snapshot only. They must not be copied into, required by, or used to block the V2 implementation.
- Test setup may occasionally avoid a V1-only restriction (for example selecting a non-elder speaker so an unrelated delete test can exercise the normal path). Such setup must be marked as V1-only and is not a V2 requirement.

Currently known V1-only observations in this suite are the elder delete permission in `places.comparison.test.ts` and the cultural/traditional metadata fields in the enriched community-story response. Any newly discovered V1 behavior that conflicts with `SPEC-V2.md` must be classified the same way instead of changing V2 to satisfy the stale behavior.
