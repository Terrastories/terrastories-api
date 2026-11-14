-- Issue #189 Slice 1b:
-- Remaining Slice 1 content columns and nullability alignment (SPEC-V2 §6.1,
-- §6.3, §6.4, §6.9):
-- 1. communities: add nullable description_plain.
-- 2. places: make latitude/longitude nullable; add nullable description_plain
--    and type_of_place.
-- 3. stories: make created_by nullable; add nullable description_plain, topic,
--    and topic_normalized.
--
-- D1 note: no PRAGMA statements are used; every table referencing places or
-- stories (speakers, stories, story_places, story_speakers) is rebuilt in
-- dependency order under immediate foreign-key enforcement.
ALTER TABLE `communities` ADD COLUMN `description_plain` text;
--> statement-breakpoint
ALTER TABLE `places` RENAME TO `places_old`;
--> statement-breakpoint
CREATE TABLE `places` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`description_plain` text,
	`community_id` integer NOT NULL,
	`latitude` real,
	`longitude` real,
	`type_of_place` text,
	`region` text,
	`media_urls` text DEFAULT '[]',
	`photo_url` text,
	`cultural_significance` text,
	`is_restricted` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `places_community_id_communities_id_fk` FOREIGN KEY (`community_id`) REFERENCES `communities`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `places` (`id`,`name`,`description`,`description_plain`,`community_id`,`latitude`,`longitude`,`type_of_place`,`region`,`media_urls`,`photo_url`,`cultural_significance`,`is_restricted`,`created_at`,`updated_at`)
SELECT `id`,`name`,`description`,NULL,`community_id`,`latitude`,`longitude`,NULL,`region`,`media_urls`,`photo_url`,`cultural_significance`,`is_restricted`,`created_at`,`updated_at` FROM `places_old`;
--> statement-breakpoint
CREATE UNIQUE INDEX `_189_places_community_id_id_unique` ON `places` (`community_id`,`id`);
--> statement-breakpoint
ALTER TABLE `speakers` RENAME TO `speakers_old`;
--> statement-breakpoint
CREATE TABLE `speakers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`bio` text,
	`community_id` integer NOT NULL,
	`photo_url` text,
	`bio_audio_url` text,
	`birth_year` integer,
	`birth_date` text,
	`birthplace_id` integer,
	`affiliation` text,
	`elder_status` integer DEFAULT false NOT NULL,
	`cultural_role` text,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `speakers_community_id_communities_id_fk` FOREIGN KEY (`community_id`) REFERENCES `communities`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT `speakers_birthplace_community_fk` FOREIGN KEY (`community_id`,`birthplace_id`) REFERENCES `places`(`community_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `speakers` (`id`,`name`,`bio`,`community_id`,`photo_url`,`bio_audio_url`,`birth_year`,`birth_date`,`birthplace_id`,`affiliation`,`elder_status`,`cultural_role`,`is_active`,`created_at`,`updated_at`)
SELECT `id`,`name`,`bio`,`community_id`,`photo_url`,`bio_audio_url`,`birth_year`,`birth_date`,`birthplace_id`,`affiliation`,`elder_status`,`cultural_role`,`is_active`,`created_at`,`updated_at` FROM `speakers_old`;
--> statement-breakpoint
CREATE UNIQUE INDEX `_189_speakers_community_id_id_unique` ON `speakers` (`community_id`,`id`);
--> statement-breakpoint
ALTER TABLE `stories` RENAME TO `stories_old`;
--> statement-breakpoint
CREATE TABLE `stories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`description_plain` text,
	`slug` text NOT NULL,
	`community_id` integer NOT NULL,
	`created_by` integer,
	`is_restricted` integer DEFAULT false NOT NULL,
	`privacy_level` text DEFAULT 'public' NOT NULL,
	`topic` text,
	`topic_normalized` text,
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
INSERT INTO `stories` (`id`,`title`,`description`,`description_plain`,`slug`,`community_id`,`created_by`,`is_restricted`,`privacy_level`,`topic`,`topic_normalized`,`media_urls`,`image_url`,`audio_url`,`language`,`tags`,`date_interviewed`,`interview_location_id`,`interviewer_id`,`created_at`,`updated_at`)
SELECT `id`,`title`,`description`,NULL,`slug`,`community_id`,`created_by`,`is_restricted`,`privacy_level`,NULL,NULL,`media_urls`,`image_url`,`audio_url`,`language`,`tags`,`date_interviewed`,`interview_location_id`,`interviewer_id`,`created_at`,`updated_at` FROM `stories_old`;
--> statement-breakpoint
CREATE UNIQUE INDEX `_189_stories_community_id_id_unique` ON `stories` (`community_id`,`id`);
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
SELECT `id`,`community_id`,`story_id`,`place_id`,`cultural_context`,`sort_order`,`created_at`,`updated_at` FROM `story_places`;
--> statement-breakpoint
DROP TABLE `story_places`;
--> statement-breakpoint
ALTER TABLE `story_places_new` RENAME TO `story_places`;
--> statement-breakpoint
CREATE INDEX `story_places_story_place_idx` ON `story_places` (`story_id`,`place_id`);
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
SELECT `id`,`community_id`,`story_id`,`speaker_id`,`story_role`,`sort_order`,`created_at`,`updated_at` FROM `story_speakers`;
--> statement-breakpoint
DROP TABLE `story_speakers`;
--> statement-breakpoint
ALTER TABLE `story_speakers_new` RENAME TO `story_speakers`;
--> statement-breakpoint
CREATE INDEX `story_speakers_story_speaker_idx` ON `story_speakers` (`story_id`,`speaker_id`);
--> statement-breakpoint
DROP TABLE `stories_old`;
--> statement-breakpoint
DROP TABLE `speakers_old`;
--> statement-breakpoint
DROP TABLE `places_old`;
--> statement-breakpoint
CREATE UNIQUE INDEX `places_community_id_id_unique` ON `places` (`community_id`,`id`);
--> statement-breakpoint
DROP INDEX `_189_places_community_id_id_unique`;
--> statement-breakpoint
CREATE INDEX `places_community_id_idx` ON `places` (`community_id`);
--> statement-breakpoint
CREATE INDEX `places_photo_url_idx` ON `places` (`photo_url`);
--> statement-breakpoint
CREATE UNIQUE INDEX `speakers_community_id_id_unique` ON `speakers` (`community_id`,`id`);
--> statement-breakpoint
DROP INDEX `_189_speakers_community_id_id_unique`;
--> statement-breakpoint
CREATE INDEX `speakers_community_id_idx` ON `speakers` (`community_id`);
--> statement-breakpoint
CREATE INDEX `speakers_bio_audio_url_idx` ON `speakers` (`bio_audio_url`);
--> statement-breakpoint
CREATE INDEX `speakers_elder_status_idx` ON `speakers` (`elder_status`);
--> statement-breakpoint
CREATE INDEX `speakers_cultural_role_idx` ON `speakers` (`cultural_role`);
--> statement-breakpoint
CREATE INDEX `speakers_is_active_idx` ON `speakers` (`is_active`);
--> statement-breakpoint
CREATE UNIQUE INDEX `stories_community_id_id_unique` ON `stories` (`community_id`,`id`);
--> statement-breakpoint
DROP INDEX `_189_stories_community_id_id_unique`;
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
