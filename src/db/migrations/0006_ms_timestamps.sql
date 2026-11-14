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
-- sessions.expires_at already stores epoch milliseconds and is not touched
-- (the SQLite migration gate cross-checks the exact column set below against
-- the Drizzle schema's timestamp columns).
--
-- RE-ENTRANCY / UNIT GUARD: every statement multiplies only values that are
-- PLAINLY SECONDS — `abs(value) < 100000000000`. Unix seconds stay below 1e11
-- until year 5138, while Unix milliseconds for dates after 1973-03-03 (or
-- before 1966-10-24) are >= 1e11 in magnitude, so an already-converted value
-- is skipped. The file is therefore safe to re-run on a fully or partially
-- converted database: it converts exactly the not-yet-converted rows and
-- changes nothing else. AMBIGUOUS WINDOW: a millisecond instant inside
-- 1966-10-24..1973-03-03 is < 1e11 in magnitude and would be multiplied
-- again; Terrastories data starts decades after that window, and the
-- migration gate proves the re-run changes nothing for realistic dates.
--
-- ATOMICITY / CRASH SAFETY: each statement is independent and re-entrant per
-- the guard above, but one run is NOT a single transaction on every runner.
-- The Drizzle better-sqlite3 migrator applies the whole file in one
-- transaction and a Miniflare D1 batch is atomic per batch. `wrangler d1
-- migrations apply` cross-statement atomicity is NOT verified in this
-- repository (see the 0005_composite_tenant_fks.sql header for the same
-- caveat). Because the statements are guarded, a stepwise runner dying
-- mid-file leaves a partially converted database whose remaining tables still
-- hold seconds, and the repair is to re-run this file from the start — no
-- restore is required for dates outside the ambiguous window above. A D1
-- export + Time Travel bookmark (version: production) before applying, as
-- 0005 documents, remains the belt-and-braces backup for the window case.
UPDATE `attachments` SET `created_at` = `created_at` * 1000 WHERE `created_at` IS NOT NULL AND abs(`created_at`) < 100000000000;--> statement-breakpoint
UPDATE `communities` SET `created_at` = `created_at` * 1000 WHERE `created_at` IS NOT NULL AND abs(`created_at`) < 100000000000;--> statement-breakpoint
UPDATE `communities` SET `updated_at` = `updated_at` * 1000 WHERE `updated_at` IS NOT NULL AND abs(`updated_at`) < 100000000000;--> statement-breakpoint
UPDATE `files` SET `created_at` = `created_at` * 1000 WHERE `created_at` IS NOT NULL AND abs(`created_at`) < 100000000000;--> statement-breakpoint
UPDATE `files` SET `updated_at` = `updated_at` * 1000 WHERE `updated_at` IS NOT NULL AND abs(`updated_at`) < 100000000000;--> statement-breakpoint
UPDATE `places` SET `created_at` = `created_at` * 1000 WHERE `created_at` IS NOT NULL AND abs(`created_at`) < 100000000000;--> statement-breakpoint
UPDATE `places` SET `updated_at` = `updated_at` * 1000 WHERE `updated_at` IS NOT NULL AND abs(`updated_at`) < 100000000000;--> statement-breakpoint
UPDATE `speakers` SET `created_at` = `created_at` * 1000 WHERE `created_at` IS NOT NULL AND abs(`created_at`) < 100000000000;--> statement-breakpoint
UPDATE `speakers` SET `updated_at` = `updated_at` * 1000 WHERE `updated_at` IS NOT NULL AND abs(`updated_at`) < 100000000000;--> statement-breakpoint
UPDATE `stories` SET `date_interviewed` = `date_interviewed` * 1000 WHERE `date_interviewed` IS NOT NULL AND abs(`date_interviewed`) < 100000000000;--> statement-breakpoint
UPDATE `stories` SET `created_at` = `created_at` * 1000 WHERE `created_at` IS NOT NULL AND abs(`created_at`) < 100000000000;--> statement-breakpoint
UPDATE `stories` SET `updated_at` = `updated_at` * 1000 WHERE `updated_at` IS NOT NULL AND abs(`updated_at`) < 100000000000;--> statement-breakpoint
UPDATE `story_places` SET `created_at` = `created_at` * 1000 WHERE `created_at` IS NOT NULL AND abs(`created_at`) < 100000000000;--> statement-breakpoint
UPDATE `story_places` SET `updated_at` = `updated_at` * 1000 WHERE `updated_at` IS NOT NULL AND abs(`updated_at`) < 100000000000;--> statement-breakpoint
UPDATE `story_speakers` SET `created_at` = `created_at` * 1000 WHERE `created_at` IS NOT NULL AND abs(`created_at`) < 100000000000;--> statement-breakpoint
UPDATE `story_speakers` SET `updated_at` = `updated_at` * 1000 WHERE `updated_at` IS NOT NULL AND abs(`updated_at`) < 100000000000;--> statement-breakpoint
UPDATE `themes` SET `created_at` = `created_at` * 1000 WHERE `created_at` IS NOT NULL AND abs(`created_at`) < 100000000000;--> statement-breakpoint
UPDATE `themes` SET `updated_at` = `updated_at` * 1000 WHERE `updated_at` IS NOT NULL AND abs(`updated_at`) < 100000000000;--> statement-breakpoint
UPDATE `users` SET `last_login_at` = `last_login_at` * 1000 WHERE `last_login_at` IS NOT NULL AND abs(`last_login_at`) < 100000000000;--> statement-breakpoint
UPDATE `users` SET `reset_password_sent_at` = `reset_password_sent_at` * 1000 WHERE `reset_password_sent_at` IS NOT NULL AND abs(`reset_password_sent_at`) < 100000000000;--> statement-breakpoint
UPDATE `users` SET `remember_created_at` = `remember_created_at` * 1000 WHERE `remember_created_at` IS NOT NULL AND abs(`remember_created_at`) < 100000000000;--> statement-breakpoint
UPDATE `users` SET `last_sign_in_at` = `last_sign_in_at` * 1000 WHERE `last_sign_in_at` IS NOT NULL AND abs(`last_sign_in_at`) < 100000000000;--> statement-breakpoint
UPDATE `users` SET `created_at` = `created_at` * 1000 WHERE `created_at` IS NOT NULL AND abs(`created_at`) < 100000000000;--> statement-breakpoint
UPDATE `users` SET `updated_at` = `updated_at` * 1000 WHERE `updated_at` IS NOT NULL AND abs(`updated_at`) < 100000000000;
