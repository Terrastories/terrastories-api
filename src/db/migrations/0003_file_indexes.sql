CREATE INDEX `files_community_idx` ON `files` (`community_id`);
--> statement-breakpoint
CREATE INDEX `files_user_idx` ON `files` (`uploaded_by`);
--> statement-breakpoint
CREATE INDEX `files_mime_type_idx` ON `files` (`mime_type`);
--> statement-breakpoint
CREATE INDEX `files_active_idx` ON `files` (`is_active`);
--> statement-breakpoint
CREATE INDEX `files_created_at_idx` ON `files` (`created_at`);
