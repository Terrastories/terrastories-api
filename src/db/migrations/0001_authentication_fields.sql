ALTER TABLE `users` ADD `reset_password_token` text;
--> statement-breakpoint
ALTER TABLE `users` ADD `reset_password_sent_at` integer;
--> statement-breakpoint
ALTER TABLE `users` ADD `remember_created_at` integer;
--> statement-breakpoint
ALTER TABLE `users` ADD `sign_in_count` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `users` ADD `last_sign_in_at` integer;
--> statement-breakpoint
ALTER TABLE `users` ADD `current_sign_in_ip` text;
--> statement-breakpoint
CREATE INDEX `idx_users_reset_password_token` ON `users` (`reset_password_token`) WHERE `reset_password_token` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `idx_users_community_email` ON `users` (`community_id`,`email`);
