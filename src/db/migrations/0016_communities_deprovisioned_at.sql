-- PR #257 / Slice 14: logical deprovision tombstone timestamp (ms epoch) on
-- communities so DELETE /v2/admin/communities/:id never physically deletes
-- communities or mutates/deletes append-only audit_entries (SPEC-V2 §6.8, §7).
-- Purely additive nullable column; D1-safe (no PRAGMA).

ALTER TABLE `communities` ADD `deprovisioned_at` integer;
