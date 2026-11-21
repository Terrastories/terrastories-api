-- Slice 13a / #187: Community export job & single-artifact download token tables
-- plus community_id lookup indexes on story_places, story_speakers, and
-- community_media (SPEC-V2 §7).
--
-- Numbered 0016 (leaving 0015 for parallel Slice 12 import_manifests).
-- No PRAGMA statements (D1-safe); millisecond Unix epoch integers (#192).

CREATE TABLE `export_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`community_id` integer NOT NULL,
	`requested_by` integer,
	`status` text NOT NULL,
	`manifest_storage_key` text,
	`manifest_byte_size` integer,
	`manifest_checksum` text,
	`zip_storage_key` text,
	`zip_byte_size` integer,
	`zip_checksum` text,
	`zip_upload_id` text,
	`created_at` integer NOT NULL,
	`completed_at` integer,
	`expires_at` integer NOT NULL,
	`cleaned_up_at` integer,
	CONSTRAINT `export_jobs_community_id_communities_id_fk` FOREIGN KEY (`community_id`) REFERENCES `communities`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `export_jobs_requested_by_users_id_fk` FOREIGN KEY (`requested_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT `export_jobs_status_check` CHECK (`status` in ('generating', 'ready', 'failed', 'expired')),
	CONSTRAINT `export_jobs_expiry_check` CHECK (`expires_at` > `created_at`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `export_jobs_active_community_unique` ON `export_jobs` (`community_id`) WHERE `status` = 'generating';
--> statement-breakpoint
CREATE INDEX `export_jobs_community_created_idx` ON `export_jobs` (`community_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `export_jobs_requested_by_created_idx` ON `export_jobs` (`requested_by`,`created_at`);
--> statement-breakpoint
CREATE INDEX `export_jobs_cleanup_idx` ON `export_jobs` (`expires_at`) WHERE `cleaned_up_at` IS NULL;
--> statement-breakpoint
CREATE TABLE `export_tokens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` text NOT NULL,
	`community_id` integer NOT NULL,
	`requested_by` integer NOT NULL,
	`artifact` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`downloaded_at` integer,
	CONSTRAINT `export_tokens_job_id_export_jobs_id_fk` FOREIGN KEY (`job_id`) REFERENCES `export_jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `export_tokens_community_id_communities_id_fk` FOREIGN KEY (`community_id`) REFERENCES `communities`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `export_tokens_requested_by_users_id_fk` FOREIGN KEY (`requested_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `export_tokens_artifact_check` CHECK (`artifact` in ('manifest', 'media_zip')),
	CONSTRAINT `export_tokens_expiry_check` CHECK (`expires_at` > `created_at`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `export_tokens_token_hash_unique` ON `export_tokens` (`token_hash`);
--> statement-breakpoint
CREATE UNIQUE INDEX `export_tokens_job_artifact_unique` ON `export_tokens` (`job_id`,`artifact`);
--> statement-breakpoint
CREATE INDEX `export_tokens_community_idx` ON `export_tokens` (`community_id`);
--> statement-breakpoint
CREATE INDEX `export_tokens_expires_idx` ON `export_tokens` (`expires_at`);
--> statement-breakpoint
CREATE INDEX `story_places_community_id_idx` ON `story_places` (`community_id`);
--> statement-breakpoint
CREATE INDEX `story_speakers_community_id_idx` ON `story_speakers` (`community_id`);
--> statement-breakpoint
CREATE INDEX `community_media_community_id_idx` ON `community_media` (`community_id`);
