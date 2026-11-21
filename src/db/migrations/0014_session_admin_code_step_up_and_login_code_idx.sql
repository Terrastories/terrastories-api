-- Issue #188 / Slice 11b-A: one-shot fresh admin_issued step-up expiry on
-- sessions (SPEC-V2 §6.8, §6.10) and composite (user_id, purpose) index on
-- login_codes for GET /v2/auth/me recovery-code check and superseding.
-- Includes a table rebuild of auth_throttle to add the 'claim' kind and the
-- community-scoped constraint; no PRAGMA (D1-safe).

ALTER TABLE `sessions` ADD `admin_code_step_up_expires_at` integer;
--> statement-breakpoint
CREATE INDEX `login_codes_user_purpose_idx` ON `login_codes` (`user_id`,`purpose`);
--> statement-breakpoint
CREATE TABLE `installation_bootstrap` (
	`id` integer PRIMARY KEY NOT NULL,
	`setup_id` text NOT NULL,
	`community_id` integer,
	`admin_user_id` integer,
	`completed_at` integer NOT NULL,
	CONSTRAINT `installation_bootstrap_community_id_communities_id_fk` FOREIGN KEY (`community_id`) REFERENCES `communities`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT `installation_bootstrap_admin_user_id_users_id_fk` FOREIGN KEY (`admin_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT `installation_bootstrap_singleton_check` CHECK (`id` = 1)
);
--> statement-breakpoint
ALTER TABLE `auth_throttle` RENAME TO `auth_throttle_old`;
--> statement-breakpoint
CREATE TABLE `auth_throttle` (
	`key` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`community_id` integer,
	`failures` integer DEFAULT 0 NOT NULL,
	`window_started_at` integer DEFAULT 0 NOT NULL,
	`blocked_until` integer,
	CONSTRAINT `auth_throttle_community_id_communities_id_fk` FOREIGN KEY (`community_id`) REFERENCES `communities`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `auth_throttle_kind_check` CHECK (`kind` in ('account', 'ip', 'claim')),
	CONSTRAINT `auth_throttle_ip_community_check` CHECK ((`kind` = 'account') OR (`kind` = 'ip' AND `community_id` IS NULL) OR (`kind` = 'claim' AND `community_id` IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO `auth_throttle` (`key`, `kind`, `community_id`, `failures`, `window_started_at`, `blocked_until`)
SELECT `key`, `kind`, `community_id`, `failures`, `window_started_at`, `blocked_until` FROM `auth_throttle_old`;
--> statement-breakpoint
DROP TABLE `auth_throttle_old`;
--> statement-breakpoint
CREATE INDEX `auth_throttle_community_idx` ON `auth_throttle` (`community_id`);
