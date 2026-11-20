-- Issue #188 / Slice 11b-A: one-shot fresh admin_issued step-up expiry on
-- sessions (SPEC-V2 §6.8, §6.10) and composite (user_id, purpose) index on
-- login_codes for GET /v2/auth/me recovery-code check and superseding.
-- Purely additive; no table rebuild, no PRAGMA (D1-safe).

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
