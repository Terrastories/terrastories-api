-- Issue #123 / #197 / Slice 12: ImportManifest table (SPEC-V2 §4, §6.9,
-- docs/V2-DOMAIN-BUILD-PLAN.md "Slice 12").
--
-- New table only; no existing table is rebuilt (D1-safe). Stores immutable
-- normalized CSV import previews, explicit mappings, row-level errors,
-- staged file IDs, and millisecond Unix timestamps.
-- Composite (community_id, source_file_id) FK enforces tenant scoping to files;
-- created_by uses ON DELETE SET NULL so user erasure is never blocked.

CREATE TABLE `import_manifests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`community_id` integer NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'previewed' NOT NULL,
	`created_by` integer,
	`source_file_name` text,
	`source_file_id` text NOT NULL,
	`mappings` text NOT NULL,
	`normalized_rows` text NOT NULL,
	`row_count` integer NOT NULL,
	`row_errors` text NOT NULL,
	`staged_file_ids` text NOT NULL,
	`result_summary` text,
	`committed_at` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT `import_manifests_community_id_communities_id_fk` FOREIGN KEY (`community_id`) REFERENCES `communities`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `import_manifests_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT `import_manifests_source_file_community_fk` FOREIGN KEY (`community_id`, `source_file_id`) REFERENCES `files`(`community_id`, `id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT `import_manifests_kind_check` CHECK (`kind` in ('places', 'speakers', 'stories')),
	CONSTRAINT `import_manifests_status_check` CHECK (`status` in ('previewed', 'committed', 'failed', 'discarded')),
	CONSTRAINT `import_manifests_row_count_check` CHECK (`row_count` >= 0),
	CONSTRAINT `import_manifests_committed_at_check` CHECK ((`status` = 'committed' AND `committed_at` IS NOT NULL) OR (`status` <> 'committed' AND `committed_at` IS NULL))
);
--> statement-breakpoint
CREATE INDEX `import_manifests_community_created_idx` ON `import_manifests` (`community_id`,`created_at`,`id`);
--> statement-breakpoint
CREATE INDEX `import_manifests_community_status_idx` ON `import_manifests` (`community_id`,`status`,`created_at`);
--> statement-breakpoint
CREATE INDEX `import_manifests_status_committed_at_idx` ON `import_manifests` (`status`,`committed_at`);
--> statement-breakpoint
CREATE INDEX `import_manifests_source_file_idx` ON `import_manifests` (`source_file_id`);
--> statement-breakpoint
CREATE INDEX `import_manifests_created_by_idx` ON `import_manifests` (`created_by`);
