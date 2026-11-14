-- Issue #186 phase 1: composite (community_id, id) tenant foreign keys.
--
-- Every community-owned child row must reference a parent row of the SAME
-- community: story_places/story_speakers gain a community_id column (backfilled
-- from the story) and composite FKs to stories(community_id, id) and
-- places/speakers(community_id, id); stories.interview_location_id and
-- stories.interviewer_id switch to composite FKs against
-- places/speakers(community_id, id); community_media switches its file FK to
-- (community_id, file_id) -> files(community_id, id). Parents gain the
-- required UNIQUE (community_id, id) keys.
--
-- FAIL-LOUD CONTRACT: if any existing row already violates the new tenancy
-- rule (a cross-community edge, a cross-community interview reference, a
-- cross-community community_media binding, or a join row whose story is
-- missing), the guard INSERT below aborts with
-- "CHECK constraint failed: cross_community_rows = 0" and the migration is
-- rolled back and NOT recorded. This migration never drops or repairs rows;
-- repair the data first, then re-run.
--
-- RUNNER ATOMICITY / CRASH SAFETY: some runners execute this file one
-- statement at a time without a wrapping transaction (wrangler d1 migrations
-- is such a runner; its cross-statement atomicity is NOT verified in this
-- repository). The file is re-entrant only UP TO THE GUARD, i.e. before any
-- destructive statement:
-- 1. The guard table is re-entrant: it is dropped (IF EXISTS) before being
--    created, so a re-run after an aborted attempt never dies on "table
--    already exists", and it is dropped again as soon as the check passes.
-- 2. The cross-community check runs BEFORE any RENAME/DROP of a real table
--    (the unique-index creations ahead of it are additive), so the expected
--    failure path leaves the production tables, rows, and their names
--    untouched; after repairing the data, re-running applies the migration
--    from the start.
-- Once the rebuild starts (`ALTER TABLE stories RENAME TO stories_old`),
-- safety REQUIRES an atomic runner: the Drizzle better-sqlite3 migrator
-- applies the whole file in one transaction, and a Miniflare D1 batch is
-- atomic per batch, so a failure anywhere leaves no partial rebuild behind.
-- Production `wrangler d1 migrations apply` is not known to be such a runner
-- (see above: this repository cannot verify its cross-statement atomicity),
-- so a run that dies mid-rebuild leaves residue tables, and this file ships
-- no hand-recovery procedure for that state. Prepare BEFORE applying with
-- any runner whose atomicity is not known:
-- 1. Take a backup to a new, timestamped file:
--      wrangler d1 export <database> --remote [--env <env>] --output <file>
-- 2. If the run fails after the guard, do not re-export. Restore into a NEW
--    database (wrangler d1 create, then wrangler d1 execute --remote
--    --file <backup>), rebind DB to it, repair the data, and re-apply from
--    the start. The export cannot be replayed over the failed database
--    because its tables still exist. The backup predates the apply, so the
--    migration bookkeeping is back at the pre-0005 state.
--
-- D1 note: this migration deliberately uses no PRAGMA statements (D1 only
-- supports PRAGMA defer_foreign_keys), so table rebuilds are ordered to keep
-- every statement valid under immediate foreign-key enforcement:
-- stories is renamed aside first (retargeting the legacy join-table FKs to
-- stories_old), the new stories table is created and repopulated, the join
-- tables and community_media are rebuilt against it, and only then is
-- stories_old dropped and the regular stories indexes recreated (their names
-- stay attached to stories_old until it is dropped).
--
-- Foreign keys inside the rebuilt tables carry the same CONSTRAINT names the
-- Drizzle schema and meta/0005_snapshot.json declare (SQLite keeps them in
-- sqlite_master even though PRAGMA foreign_key_list does not expose names),
-- so the applied database and the snapshot cannot drift apart on names.
DROP TABLE IF EXISTS `_186_cross_community_guard`;
--> statement-breakpoint
CREATE TABLE `_186_cross_community_guard` (
	`cross_community_rows` integer NOT NULL CHECK (`cross_community_rows` = 0)
);
--> statement-breakpoint
INSERT INTO `_186_cross_community_guard` (`cross_community_rows`)
SELECT
	(SELECT count(*) FROM `story_places`
		INNER JOIN `stories` ON `stories`.`id` = `story_places`.`story_id`
		INNER JOIN `places` ON `places`.`id` = `story_places`.`place_id`
		WHERE `stories`.`community_id` <> `places`.`community_id`)
	+ (SELECT count(*) FROM `story_speakers`
		INNER JOIN `stories` ON `stories`.`id` = `story_speakers`.`story_id`
		INNER JOIN `speakers` ON `speakers`.`id` = `story_speakers`.`speaker_id`
		WHERE `stories`.`community_id` <> `speakers`.`community_id`)
	+ (SELECT count(*) FROM `stories`
		INNER JOIN `places` ON `places`.`id` = `stories`.`interview_location_id`
		WHERE `stories`.`interview_location_id` IS NOT NULL
			AND `stories`.`community_id` <> `places`.`community_id`)
	+ (SELECT count(*) FROM `stories`
		INNER JOIN `speakers` ON `speakers`.`id` = `stories`.`interviewer_id`
		WHERE `stories`.`interviewer_id` IS NOT NULL
			AND `stories`.`community_id` <> `speakers`.`community_id`)
	+ (SELECT count(*) FROM `community_media`
		INNER JOIN `files` ON `files`.`id` = `community_media`.`file_id`
		WHERE `community_media`.`community_id` <> `files`.`community_id`)
	+ (SELECT count(*) FROM `story_places`
		WHERE NOT EXISTS (SELECT 1 FROM `stories` WHERE `stories`.`id` = `story_places`.`story_id`))
	+ (SELECT count(*) FROM `story_places`
		WHERE NOT EXISTS (SELECT 1 FROM `places` WHERE `places`.`id` = `story_places`.`place_id`))
	+ (SELECT count(*) FROM `story_speakers`
		WHERE NOT EXISTS (SELECT 1 FROM `stories` WHERE `stories`.`id` = `story_speakers`.`story_id`))
	+ (SELECT count(*) FROM `story_speakers`
		WHERE NOT EXISTS (SELECT 1 FROM `speakers` WHERE `speakers`.`id` = `story_speakers`.`speaker_id`));
--> statement-breakpoint
DROP TABLE `_186_cross_community_guard`;
--> statement-breakpoint
CREATE UNIQUE INDEX `places_community_id_id_unique` ON `places` (`community_id`,`id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `speakers_community_id_id_unique` ON `speakers` (`community_id`,`id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `files_community_id_id_unique` ON `files` (`community_id`,`id`);
--> statement-breakpoint
ALTER TABLE `stories` RENAME TO `stories_old`;
--> statement-breakpoint
CREATE TABLE `stories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`slug` text NOT NULL,
	`community_id` integer NOT NULL,
	`created_by` integer NOT NULL,
	`is_restricted` integer DEFAULT false NOT NULL,
	`privacy_level` text DEFAULT 'public' NOT NULL,
	`media_urls` text DEFAULT '[]',
	`image_url` text,
	`audio_url` text,
	`language` text DEFAULT 'en' NOT NULL,
	`tags` text DEFAULT '[]',
	`date_interviewed` integer,
	`interview_location_id` integer,
	`interviewer_id` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `stories_community_id_communities_id_fk` FOREIGN KEY (`community_id`) REFERENCES `communities`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT `stories_interview_location_community_fk` FOREIGN KEY (`community_id`,`interview_location_id`) REFERENCES `places`(`community_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT `stories_interviewer_community_fk` FOREIGN KEY (`community_id`,`interviewer_id`) REFERENCES `speakers`(`community_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `stories` (`id`,`title`,`description`,`slug`,`community_id`,`created_by`,`is_restricted`,`privacy_level`,`media_urls`,`image_url`,`audio_url`,`language`,`tags`,`date_interviewed`,`interview_location_id`,`interviewer_id`,`created_at`,`updated_at`)
SELECT `id`,`title`,`description`,`slug`,`community_id`,`created_by`,`is_restricted`,`privacy_level`,`media_urls`,`image_url`,`audio_url`,`language`,`tags`,`date_interviewed`,`interview_location_id`,`interviewer_id`,`created_at`,`updated_at` FROM `stories_old`;
--> statement-breakpoint
CREATE UNIQUE INDEX `stories_community_id_id_unique` ON `stories` (`community_id`,`id`);
--> statement-breakpoint
CREATE TABLE `story_places_new` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`community_id` integer NOT NULL,
	`story_id` integer NOT NULL,
	`place_id` integer NOT NULL,
	`cultural_context` text,
	`sort_order` integer DEFAULT 0,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `story_places_story_community_fk` FOREIGN KEY (`community_id`,`story_id`) REFERENCES `stories`(`community_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `story_places_place_community_fk` FOREIGN KEY (`community_id`,`place_id`) REFERENCES `places`(`community_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `story_places_new` (`id`,`community_id`,`story_id`,`place_id`,`cultural_context`,`sort_order`,`created_at`,`updated_at`)
SELECT `story_places`.`id`, `stories`.`community_id`, `story_places`.`story_id`, `story_places`.`place_id`, `story_places`.`cultural_context`, `story_places`.`sort_order`, `story_places`.`created_at`, `story_places`.`updated_at`
FROM `story_places`
INNER JOIN `stories` ON `stories`.`id` = `story_places`.`story_id`;
--> statement-breakpoint
DROP TABLE `story_places`;
--> statement-breakpoint
ALTER TABLE `story_places_new` RENAME TO `story_places`;
--> statement-breakpoint
CREATE UNIQUE INDEX `story_place_unique` ON `story_places` (`story_id`,`place_id`);
--> statement-breakpoint
CREATE TABLE `story_speakers_new` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`community_id` integer NOT NULL,
	`story_id` integer NOT NULL,
	`speaker_id` integer NOT NULL,
	`story_role` text,
	`sort_order` integer DEFAULT 0,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `story_speakers_story_community_fk` FOREIGN KEY (`community_id`,`story_id`) REFERENCES `stories`(`community_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `story_speakers_speaker_community_fk` FOREIGN KEY (`community_id`,`speaker_id`) REFERENCES `speakers`(`community_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `story_speakers_new` (`id`,`community_id`,`story_id`,`speaker_id`,`story_role`,`sort_order`,`created_at`,`updated_at`)
SELECT `story_speakers`.`id`, `stories`.`community_id`, `story_speakers`.`story_id`, `story_speakers`.`speaker_id`, `story_speakers`.`story_role`, `story_speakers`.`sort_order`, `story_speakers`.`created_at`, `story_speakers`.`updated_at`
FROM `story_speakers`
INNER JOIN `stories` ON `stories`.`id` = `story_speakers`.`story_id`;
--> statement-breakpoint
DROP TABLE `story_speakers`;
--> statement-breakpoint
ALTER TABLE `story_speakers_new` RENAME TO `story_speakers`;
--> statement-breakpoint
CREATE UNIQUE INDEX `story_speaker_unique` ON `story_speakers` (`story_id`,`speaker_id`);
--> statement-breakpoint
CREATE TABLE `community_media_new` (
	`file_id` text PRIMARY KEY NOT NULL,
	`community_id` integer NOT NULL,
	`kind` text NOT NULL,
	CONSTRAINT `community_media_community_id_communities_id_fk` FOREIGN KEY (`community_id`) REFERENCES `communities`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `community_media_file_community_fk` FOREIGN KEY (`community_id`,`file_id`) REFERENCES `files`(`community_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `community_media_kind_check` CHECK (`kind` = 'branding')
);
--> statement-breakpoint
INSERT INTO `community_media_new` (`file_id`,`community_id`,`kind`)
SELECT `file_id`,`community_id`,`kind` FROM `community_media`;
--> statement-breakpoint
DROP TABLE `community_media`;
--> statement-breakpoint
ALTER TABLE `community_media_new` RENAME TO `community_media`;
--> statement-breakpoint
DROP TABLE `stories_old`;
--> statement-breakpoint
CREATE INDEX `stories_community_id_idx` ON `stories` (`community_id`);
--> statement-breakpoint
CREATE INDEX `stories_slug_idx` ON `stories` (`slug`);
--> statement-breakpoint
CREATE INDEX `stories_image_url_idx` ON `stories` (`image_url`);
--> statement-breakpoint
CREATE INDEX `stories_audio_url_idx` ON `stories` (`audio_url`);
--> statement-breakpoint
CREATE INDEX `stories_privacy_level_idx` ON `stories` (`privacy_level`);
