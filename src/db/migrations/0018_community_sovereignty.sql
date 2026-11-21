-- Slice 13b / #187: Community sovereignty tables (`community_stewards`,
-- `community_sovereignty_requests`, `community_archive_custody`) (SPEC-V2 §7).
--
-- Numbered 0018 after Slice 13a export jobs/tokens (`0017`).
-- No PRAGMA statements (D1-safe); millisecond Unix epoch integers (#192).

CREATE TABLE `community_stewards` (
	`community_id` integer PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`designated_by` integer,
	`designated_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `community_stewards_community_id_communities_id_fk` FOREIGN KEY (`community_id`) REFERENCES `communities`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `community_stewards_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `community_stewards_designated_by_users_id_fk` FOREIGN KEY (`designated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `community_stewards_user_idx` ON `community_stewards` (`user_id`);
--> statement-breakpoint
CREATE TABLE `community_sovereignty_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`community_id` integer NOT NULL,
	`kind` text NOT NULL,
	`state` text NOT NULL,
	`initiated_by` integer,
	`initiated_by_role` text NOT NULL,
	`requested_at` integer NOT NULL,
	`notice_ends_at` integer,
	`effective_at` integer,
	`cancelled_at` integer,
	`cancelled_by` integer,
	`completed_at` integer,
	`updated_at` integer NOT NULL,
	CONSTRAINT `community_sovereignty_requests_community_id_communities_id_fk` FOREIGN KEY (`community_id`) REFERENCES `communities`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `community_sovereignty_requests_initiated_by_users_id_fk` FOREIGN KEY (`initiated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT `community_sovereignty_requests_cancelled_by_users_id_fk` FOREIGN KEY (`cancelled_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT `community_sovereignty_requests_kind_check` CHECK (`kind` in ('withdrawal', 'erasure')),
	CONSTRAINT `community_sovereignty_requests_state_check` CHECK (`state` in ('requested', 'notice', 'cancelled', 'executing', 'completed')),
	CONSTRAINT `community_sovereignty_requests_role_check` CHECK (`initiated_by_role` in ('admin', 'steward')),
	CONSTRAINT `community_sovereignty_requests_notice_check` CHECK (`notice_ends_at` IS NULL OR `notice_ends_at` > `requested_at`),
	CONSTRAINT `community_sovereignty_requests_cancelled_check` CHECK ((`state` = 'cancelled' AND `cancelled_at` IS NOT NULL) OR (`state` <> 'cancelled' AND `cancelled_at` IS NULL)),
	CONSTRAINT `community_sovereignty_requests_completed_check` CHECK ((`state` = 'completed' AND `completed_at` IS NOT NULL) OR (`state` <> 'completed' AND `completed_at` IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `community_sovereignty_requests_active_erasure_unique` ON `community_sovereignty_requests` (`community_id`) WHERE `kind` = 'erasure' AND `state` in ('requested', 'executing', 'completed');
--> statement-breakpoint
CREATE UNIQUE INDEX `community_sovereignty_requests_pending_notice_unique` ON `community_sovereignty_requests` (`community_id`,`kind`) WHERE `state` = 'notice';
--> statement-breakpoint
CREATE INDEX `community_sovereignty_requests_community_created_idx` ON `community_sovereignty_requests` (`community_id`,`requested_at`,`id`);
--> statement-breakpoint
CREATE INDEX `community_sovereignty_requests_due_notice_idx` ON `community_sovereignty_requests` (`notice_ends_at`) WHERE `state` = 'notice';
--> statement-breakpoint
CREATE INDEX `community_sovereignty_requests_executing_idx` ON `community_sovereignty_requests` (`state`,`updated_at`) WHERE `state` in ('requested', 'executing');
--> statement-breakpoint
CREATE TABLE `community_archive_custody` (
	`community_id` integer PRIMARY KEY NOT NULL,
	`custodian_type` text NOT NULL,
	`custodian_user_id` integer,
	`status` text NOT NULL,
	`retention_until` integer NOT NULL,
	`destroyed_at` integer,
	`destruction_attestation_ref` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `community_archive_custody_community_id_communities_id_fk` FOREIGN KEY (`community_id`) REFERENCES `communities`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `community_archive_custody_custodian_user_id_users_id_fk` FOREIGN KEY (`custodian_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT `community_archive_custody_type_check` CHECK (`custodian_type` in ('community', 'steward')),
	CONSTRAINT `community_archive_custody_status_check` CHECK (`status` in ('held', 'destroyed')),
	CONSTRAINT `community_archive_custody_destroyed_check` CHECK ((`status` = 'destroyed' AND `destroyed_at` IS NOT NULL) OR (`status` = 'held' AND `destroyed_at` IS NULL))
);
--> statement-breakpoint
CREATE INDEX `community_archive_custody_custodian_idx` ON `community_archive_custody` (`custodian_user_id`);
