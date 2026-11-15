-- Slice 2: Canonical File, Attachment, ExternalMediaLink, and CommunityMapConfig schema
-- Rebuilds `files` (and dependent `community_media`) and `attachments` without PRAGMAs,
-- preserves `attachments` sqlite_sequence high-water mark before backfilling `community_media`,
-- and creates `community_map_configs` and `external_media_links`.

ALTER TABLE `files` RENAME TO `files_old`;
--> statement-breakpoint
CREATE TABLE `files` (
	`id` text PRIMARY KEY NOT NULL,
	`filename` text NOT NULL,
	`original_name` text NOT NULL,
	`path` text NOT NULL,
	`storage_key` text,
	`url` text NOT NULL,
	`mime_type` text NOT NULL,
	`size` integer NOT NULL,
	`byte_size` integer,
	`checksum` text,
	`community_id` integer,
	`uploaded_by` integer,
	`metadata` text,
	`cultural_restrictions` text,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `files_community_id_communities_id_fk` FOREIGN KEY (`community_id`) REFERENCES `communities`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT `files_uploaded_by_users_id_fk` FOREIGN KEY (`uploaded_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `files` (
	`id`,
	`filename`,
	`original_name`,
	`path`,
	`storage_key`,
	`url`,
	`mime_type`,
	`size`,
	`byte_size`,
	`checksum`,
	`community_id`,
	`uploaded_by`,
	`metadata`,
	`cultural_restrictions`,
	`is_active`,
	`created_at`,
	`updated_at`
)
SELECT
	`id`,
	`filename`,
	`original_name`,
	`path`,
	`path`,
	`url`,
	`mime_type`,
	`size`,
	`size`,
	NULL,
	`community_id`,
	`uploaded_by`,
	`metadata`,
	`cultural_restrictions`,
	`is_active`,
	`created_at`,
	`updated_at`
FROM `files_old`;
--> statement-breakpoint
CREATE UNIQUE INDEX `_140_files_community_id_id_unique` ON `files` (`community_id`,`id`);
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
INSERT INTO `community_media_new` (`file_id`, `community_id`, `kind`)
SELECT `file_id`, `community_id`, `kind`
FROM `community_media`;
--> statement-breakpoint
DROP TABLE `community_media`;
--> statement-breakpoint
ALTER TABLE `community_media_new` RENAME TO `community_media`;
--> statement-breakpoint
DROP TABLE `files_old`;
--> statement-breakpoint
CREATE UNIQUE INDEX `files_community_id_id_unique` ON `files` (`community_id`,`id`);
--> statement-breakpoint
DROP INDEX `_140_files_community_id_id_unique`;
--> statement-breakpoint
CREATE INDEX `files_community_idx` ON `files` (`community_id`);
--> statement-breakpoint
CREATE INDEX `files_user_idx` ON `files` (`uploaded_by`);
--> statement-breakpoint
CREATE INDEX `files_mime_type_idx` ON `files` (`mime_type`);
--> statement-breakpoint
CREATE INDEX `files_active_idx` ON `files` (`is_active`);
--> statement-breakpoint
CREATE INDEX `files_created_at_idx` ON `files` (`created_at`);
--> statement-breakpoint
ALTER TABLE `attachments` RENAME TO `attachments_old`;
--> statement-breakpoint
CREATE TABLE `attachments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`community_id` integer,
	`file_id` text,
	`owner_type` text,
	`owner_id` integer,
	`role` text,
	`ordinal` integer DEFAULT 0,
	`attachable_id` integer,
	`attachable_type` text,
	`url` text,
	`filename` text,
	`content_type` text,
	`file_size` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT `attachments_file_id_files_id_fk` FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `attachments_file_community_fk` FOREIGN KEY (`community_id`,`file_id`) REFERENCES `files`(`community_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `attachments` (
	`id`,
	`attachable_id`,
	`attachable_type`,
	`url`,
	`filename`,
	`content_type`,
	`file_size`,
	`created_at`
)
SELECT
	`id`,
	`attachable_id`,
	`attachable_type`,
	`url`,
	`filename`,
	`content_type`,
	`file_size`,
	`created_at`
FROM `attachments_old`;
--> statement-breakpoint
INSERT OR IGNORE INTO `sqlite_sequence` (`name`, `seq`)
SELECT 'attachments', `seq`
FROM `sqlite_sequence`
WHERE `name` = 'attachments_old';
--> statement-breakpoint
UPDATE `sqlite_sequence`
SET `seq` = MAX(
	`seq`,
	(SELECT `seq` FROM `sqlite_sequence` WHERE `name` = 'attachments_old')
)
WHERE `name` = 'attachments'
  AND EXISTS (SELECT 1 FROM `sqlite_sequence` WHERE `name` = 'attachments_old');
--> statement-breakpoint
DROP TABLE `attachments_old`;
--> statement-breakpoint
CREATE INDEX `attachments_owner_idx` ON `attachments` (`community_id`,`owner_type`,`owner_id`,`role`,`ordinal`);
--> statement-breakpoint
CREATE INDEX `attachments_file_idx` ON `attachments` (`file_id`);
--> statement-breakpoint
INSERT INTO `attachments` (
	`community_id`,
	`file_id`,
	`owner_type`,
	`owner_id`,
	`role`,
	`ordinal`,
	`created_at`
)
SELECT
	`cm`.`community_id`,
	`cm`.`file_id`,
	'community',
	`cm`.`community_id`,
	'community_display_image',
	ROW_NUMBER() OVER (
		PARTITION BY `cm`.`community_id`
		ORDER BY `cm`.`file_id`
	) - 1,
	`f`.`created_at`
FROM `community_media` AS `cm`
INNER JOIN `files` AS `f`
	ON `f`.`id` = `cm`.`file_id`
   AND `f`.`community_id` = `cm`.`community_id`
WHERE `cm`.`kind` = 'branding'
  AND NOT EXISTS (
	SELECT 1
	FROM `attachments` AS `a`
	WHERE `a`.`community_id` = `cm`.`community_id`
	  AND `a`.`file_id` = `cm`.`file_id`
	  AND `a`.`owner_type` = 'community'
	  AND `a`.`owner_id` = `cm`.`community_id`
	  AND `a`.`role` = 'community_display_image'
  )
ORDER BY `cm`.`community_id`, `cm`.`file_id`;
--> statement-breakpoint
CREATE TABLE `community_map_configs` (
	`community_id` integer PRIMARY KEY NOT NULL,
	`style_url` text,
	`basemap_style` text,
	`center_latitude` real,
	`center_longitude` real,
	`south_west_latitude` real,
	`south_west_longitude` real,
	`north_east_latitude` real,
	`north_east_longitude` real,
	`zoom` real,
	`pitch` real,
	`bearing` real,
	`three_dimensional` integer,
	`projection` text,
	`static_map_file_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `community_map_configs_community_id_communities_id_fk` FOREIGN KEY (`community_id`) REFERENCES `communities`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `community_map_configs_static_map_file_community_fk` FOREIGN KEY (`community_id`,`static_map_file_id`) REFERENCES `files`(`community_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `community_map_configs_static_map_file_idx` ON `community_map_configs` (`static_map_file_id`);
--> statement-breakpoint
CREATE TABLE `external_media_links` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`community_id` integer NOT NULL,
	`story_id` integer NOT NULL,
	`url` text NOT NULL,
	`ordinal` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `external_media_links_story_community_fk` FOREIGN KEY (`community_id`,`story_id`) REFERENCES `stories`(`community_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `external_media_links_story_idx` ON `external_media_links` (`community_id`,`story_id`,`ordinal`);
