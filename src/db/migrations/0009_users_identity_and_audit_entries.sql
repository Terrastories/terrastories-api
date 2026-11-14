-- Issue #137 / #187 Slice 3a:
-- Expand-contract users identity/verifier/nullability alignment and add
-- content-free audit_entries table (SPEC-V2 §6.2, §6.8, §7).
--
-- D1 note: uses no PRAGMA statements. Fails loudly on ASCII case-variant
-- email collisions before renaming any table. Non-ASCII emails leave
-- email_normalized NULL for the idempotent app-level backfill script
-- (scripts/backfill-user-identity.ts using normalizeSearchText).

DROP TABLE IF EXISTS `_137_email_collision_guard`;
--> statement-breakpoint
CREATE TABLE `_137_email_collision_guard` (
	`collision_groups` integer NOT NULL CHECK (`collision_groups` = 0)
);
--> statement-breakpoint
INSERT INTO `_137_email_collision_guard` (`collision_groups`)
SELECT
	(SELECT count(*) FROM (
		SELECT `community_id`, lower(`email`) AS `norm_email`
		FROM `users`
		WHERE `community_id` IS NOT NULL
			AND length(CAST(`email` AS BLOB)) = length(`email`)
		GROUP BY `community_id`, lower(`email`)
		HAVING count(*) > 1
	))
	+
	(SELECT count(*) FROM (
		SELECT lower(`email`) AS `norm_email`
		FROM `users`
		WHERE `community_id` IS NULL
			AND length(CAST(`email` AS BLOB)) = length(`email`)
		GROUP BY lower(`email`)
		HAVING count(*) > 1
	));
--> statement-breakpoint
DROP TABLE `_137_email_collision_guard`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `users_revoke_sessions`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `communities_revoke_sessions`;
--> statement-breakpoint
ALTER TABLE `users` RENAME TO `users_old`;
--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text NOT NULL,
	`username` text,
	`display_name` text,
	`password_hash` text NOT NULL,
	`password_verifier` text,
	`password_algorithm` text,
	`password_salt` text,
	`password_params` text,
	`username_normalized` text,
	`email_normalized` text,
	`first_name` text NOT NULL,
	`last_name` text NOT NULL,
	`role` text DEFAULT 'viewer' NOT NULL,
	`community_id` integer,
	`is_active` integer DEFAULT true NOT NULL,
	`last_login_at` integer,
	`reset_password_token` text,
	`reset_password_sent_at` integer,
	`remember_created_at` integer,
	`sign_in_count` integer DEFAULT 0 NOT NULL,
	`last_sign_in_at` integer,
	`current_sign_in_ip` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `users_community_id_communities_id_fk` FOREIGN KEY (`community_id`) REFERENCES `communities`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `users` (
	`id`,
	`email`,
	`username`,
	`display_name`,
	`password_hash`,
	`password_verifier`,
	`password_algorithm`,
	`password_salt`,
	`password_params`,
	`username_normalized`,
	`email_normalized`,
	`first_name`,
	`last_name`,
	`role`,
	`community_id`,
	`is_active`,
	`last_login_at`,
	`reset_password_token`,
	`reset_password_sent_at`,
	`remember_created_at`,
	`sign_in_count`,
	`last_sign_in_at`,
	`current_sign_in_ip`,
	`created_at`,
	`updated_at`
)
SELECT
	`id`,
	`email`,
	NULL,
	NULLIF(trim(trim(`first_name`) || ' ' || trim(`last_name`)), ''),
	`password_hash`,
	NULL,
	NULL,
	NULL,
	NULL,
	NULL,
	CASE
		WHEN length(CAST(`email` AS BLOB)) = length(`email`) THEN lower(`email`)
		ELSE NULL
	END,
	`first_name`,
	`last_name`,
	`role`,
	`community_id`,
	`is_active`,
	`last_login_at`,
	`reset_password_token`,
	`reset_password_sent_at`,
	`remember_created_at`,
	`sign_in_count`,
	`last_sign_in_at`,
	`current_sign_in_ip`,
	`created_at`,
	`updated_at`
FROM `users_old`;
--> statement-breakpoint
CREATE TABLE `sessions_new` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`user_id` integer NOT NULL,
	`expires_at` integer NOT NULL,
	CONSTRAINT `sessions_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `sessions_new` (`id`, `token_hash`, `user_id`, `expires_at`)
SELECT `id`, `token_hash`, `user_id`, `expires_at` FROM `sessions`;
--> statement-breakpoint
DROP TABLE `sessions`;
--> statement-breakpoint
ALTER TABLE `sessions_new` RENAME TO `sessions`;
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash_unique` ON `sessions` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);
--> statement-breakpoint
ALTER TABLE `files` RENAME TO `files_old`;
--> statement-breakpoint
CREATE TABLE `files` (
	`id` text PRIMARY KEY NOT NULL,
	`filename` text NOT NULL,
	`original_name` text NOT NULL,
	`path` text NOT NULL,
	`url` text NOT NULL,
	`mime_type` text NOT NULL,
	`size` integer NOT NULL,
	`community_id` integer NOT NULL,
	`uploaded_by` integer NOT NULL,
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
	`id`, `filename`, `original_name`, `path`, `url`, `mime_type`, `size`,
	`community_id`, `uploaded_by`, `metadata`, `cultural_restrictions`,
	`is_active`, `created_at`, `updated_at`
)
SELECT
	`id`, `filename`, `original_name`, `path`, `url`, `mime_type`, `size`,
	`community_id`, `uploaded_by`, `metadata`, `cultural_restrictions`,
	`is_active`, `created_at`, `updated_at`
FROM `files_old`;
--> statement-breakpoint
CREATE UNIQUE INDEX `_137_files_community_id_id_unique` ON `files` (`community_id`,`id`);
--> statement-breakpoint
CREATE TABLE `community_media_new` (
	`file_id` text PRIMARY KEY NOT NULL,
	`community_id` integer NOT NULL,
	`kind` text NOT NULL,
	CONSTRAINT `community_media_file_community_fk` FOREIGN KEY (`community_id`,`file_id`) REFERENCES `files`(`community_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `community_media_community_id_communities_id_fk` FOREIGN KEY (`community_id`) REFERENCES `communities`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `community_media_kind_check` CHECK (`kind` = 'branding')
);
--> statement-breakpoint
INSERT INTO `community_media_new` (`file_id`, `community_id`, `kind`)
SELECT `file_id`, `community_id`, `kind` FROM `community_media`;
--> statement-breakpoint
DROP TABLE `community_media`;
--> statement-breakpoint
ALTER TABLE `community_media_new` RENAME TO `community_media`;
--> statement-breakpoint
DROP TABLE `files_old`;
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
CREATE UNIQUE INDEX `files_community_id_id_unique` ON `files` (`community_id`,`id`);
--> statement-breakpoint
DROP INDEX `_137_files_community_id_id_unique`;
--> statement-breakpoint
DELETE FROM `sqlite_sequence` WHERE `name` = 'users';
--> statement-breakpoint
INSERT INTO `sqlite_sequence` (`name`, `seq`)
SELECT 'users', `seq` FROM `sqlite_sequence` WHERE `name` = 'users_old';
--> statement-breakpoint
DROP TABLE `users_old`;
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_community_unique` ON `users` (`email`,`community_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_normalized_unique` ON `users` (`username_normalized`);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_community_email_normalized_unique` ON `users` (`community_id`,`email_normalized`);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_null_community_email_normalized_unique` ON `users` (`email_normalized`) WHERE `users`.`community_id` IS NULL;
--> statement-breakpoint
CREATE INDEX `idx_users_reset_password_token` ON `users` (`reset_password_token`) WHERE `users`.`reset_password_token` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `idx_users_community_email` ON `users` (`community_id`,`email`);
--> statement-breakpoint
CREATE TRIGGER `users_revoke_sessions`
AFTER UPDATE OF `role`, `community_id`, `password_hash`, `password_verifier`, `is_active` ON `users`
WHEN OLD.role IS NOT NEW.role
	OR OLD.community_id IS NOT NEW.community_id
	OR OLD.password_hash IS NOT NEW.password_hash
	OR OLD.password_verifier IS NOT NEW.password_verifier
	OR OLD.is_active IS NOT NEW.is_active
BEGIN
	DELETE FROM `sessions` WHERE `user_id` = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER `communities_revoke_sessions`
AFTER UPDATE OF `is_active` ON `communities`
WHEN OLD.is_active IS NOT NEW.is_active
BEGIN
	DELETE FROM `sessions` WHERE `user_id` IN
		(SELECT `id` FROM `users` WHERE `community_id` = NEW.id);
END;
--> statement-breakpoint
CREATE TABLE `audit_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`community_id` integer,
	`actor_id` integer,
	`action` text NOT NULL,
	`resource_type` text,
	`resource_ids` text DEFAULT '[]' NOT NULL,
	`outcome` text NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `audit_entries_community_id_communities_id_fk` FOREIGN KEY (`community_id`) REFERENCES `communities`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT `audit_entries_actor_id_users_id_fk` FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_audit_entries_community_created_at` ON `audit_entries` (`community_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_audit_entries_actor` ON `audit_entries` (`actor_id`);
--> statement-breakpoint
CREATE INDEX `idx_audit_entries_network_scrub` ON `audit_entries` (`created_at`) WHERE `audit_entries`.`ip_address` IS NOT NULL OR `audit_entries`.`user_agent` IS NOT NULL;
