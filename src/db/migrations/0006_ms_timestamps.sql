-- Issue #192 phase 1: one timestamp precision on every backend. Timestamp
-- columns move from Unix SECONDS (Drizzle integer mode 'timestamp') to Unix
-- MILLISECONDS (mode 'timestamp_ms'), matching PostgreSQL's new timestamp(3)
-- columns, so newest-first ordering cannot drift between backends.
--
-- This file is DATA-ONLY. Drizzle's SQLite snapshots do not record the
-- timestamp mode (both modes are plain `integer` columns), which is why
-- `drizzle-kit generate` reports no schema change and meta/0006_snapshot.json
-- is byte-identical to meta/0005_snapshot.json: the mode change lives in the
-- TypeScript schema and this migration converts the stored values. No table
-- rebuild is needed — column type, NOT NULL, defaults and constraints are
-- untouched. These columns have no SQL-level defaults on SQLite (defaults are
-- application-level $defaultFn), so no DEFAULT expressions change here.
-- sessions.expires_at already stores epoch milliseconds and is not touched.
--
-- ATOMICITY / CRASH SAFETY: each statement is independent and idempotent per
-- NULL handling, but the file as a whole is NOT re-entrant: it multiplies
-- whatever it finds, so a re-run would double-multiply already-converted
-- tables. The Drizzle better-sqlite3 migrator applies the whole file in one
-- transaction and a Miniflare D1 batch is atomic per batch, so those runners
-- either convert every table or none. `wrangler d1 migrations apply`
-- cross-statement atomicity is NOT verified in this repository (see the
-- 0005_composite_tenant_fks.sql header for the same caveat): a stepwise runner
-- dying mid-file leaves a partially converted database whose remaining tables
-- still hold seconds. Before applying with such a runner, prepare exactly as
-- 0005 documents (D1 export + Time Travel bookmark, version: production), and
-- on a partial failure restore to the bookmark and re-apply from the start —
-- never re-run this file on top of a partially converted database.
UPDATE `attachments` SET `created_at` = `created_at` * 1000 WHERE `created_at` IS NOT NULL;--> statement-breakpoint
UPDATE `communities` SET `created_at` = `created_at` * 1000 WHERE `created_at` IS NOT NULL;--> statement-breakpoint
UPDATE `communities` SET `updated_at` = `updated_at` * 1000 WHERE `updated_at` IS NOT NULL;--> statement-breakpoint
UPDATE `files` SET `created_at` = `created_at` * 1000 WHERE `created_at` IS NOT NULL;--> statement-breakpoint
UPDATE `files` SET `updated_at` = `updated_at` * 1000 WHERE `updated_at` IS NOT NULL;--> statement-breakpoint
UPDATE `places` SET `created_at` = `created_at` * 1000 WHERE `created_at` IS NOT NULL;--> statement-breakpoint
UPDATE `places` SET `updated_at` = `updated_at` * 1000 WHERE `updated_at` IS NOT NULL;--> statement-breakpoint
UPDATE `speakers` SET `created_at` = `created_at` * 1000 WHERE `created_at` IS NOT NULL;--> statement-breakpoint
UPDATE `speakers` SET `updated_at` = `updated_at` * 1000 WHERE `updated_at` IS NOT NULL;--> statement-breakpoint
UPDATE `stories` SET `date_interviewed` = `date_interviewed` * 1000 WHERE `date_interviewed` IS NOT NULL;--> statement-breakpoint
UPDATE `stories` SET `created_at` = `created_at` * 1000 WHERE `created_at` IS NOT NULL;--> statement-breakpoint
UPDATE `stories` SET `updated_at` = `updated_at` * 1000 WHERE `updated_at` IS NOT NULL;--> statement-breakpoint
UPDATE `story_places` SET `created_at` = `created_at` * 1000 WHERE `created_at` IS NOT NULL;--> statement-breakpoint
UPDATE `story_places` SET `updated_at` = `updated_at` * 1000 WHERE `updated_at` IS NOT NULL;--> statement-breakpoint
UPDATE `story_speakers` SET `created_at` = `created_at` * 1000 WHERE `created_at` IS NOT NULL;--> statement-breakpoint
UPDATE `story_speakers` SET `updated_at` = `updated_at` * 1000 WHERE `updated_at` IS NOT NULL;--> statement-breakpoint
UPDATE `themes` SET `created_at` = `created_at` * 1000 WHERE `created_at` IS NOT NULL;--> statement-breakpoint
UPDATE `themes` SET `updated_at` = `updated_at` * 1000 WHERE `updated_at` IS NOT NULL;--> statement-breakpoint
UPDATE `users` SET `last_login_at` = `last_login_at` * 1000 WHERE `last_login_at` IS NOT NULL;--> statement-breakpoint
UPDATE `users` SET `reset_password_sent_at` = `reset_password_sent_at` * 1000 WHERE `reset_password_sent_at` IS NOT NULL;--> statement-breakpoint
UPDATE `users` SET `remember_created_at` = `remember_created_at` * 1000 WHERE `remember_created_at` IS NOT NULL;--> statement-breakpoint
UPDATE `users` SET `last_sign_in_at` = `last_sign_in_at` * 1000 WHERE `last_sign_in_at` IS NOT NULL;--> statement-breakpoint
UPDATE `users` SET `created_at` = `created_at` * 1000 WHERE `created_at` IS NOT NULL;--> statement-breakpoint
UPDATE `users` SET `updated_at` = `updated_at` * 1000 WHERE `updated_at` IS NOT NULL;
