CREATE TABLE `sessions` (
  `id` text PRIMARY KEY NOT NULL,
  `token_hash` text NOT NULL,
  `user_id` integer NOT NULL REFERENCES `users` (`id`) ON DELETE CASCADE,
  `expires_at` integer NOT NULL,
  CONSTRAINT `sessions_token_hash_unique` UNIQUE (`token_hash`)
);
--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);
--> statement-breakpoint
CREATE TABLE `community_media` (
  `file_id` text PRIMARY KEY NOT NULL REFERENCES `files` (`id`) ON DELETE CASCADE,
  `community_id` integer NOT NULL REFERENCES `communities` (`id`) ON DELETE CASCADE,
  `kind` text NOT NULL,
  CONSTRAINT `community_media_kind_check` CHECK (`kind` = 'branding')
);
--> statement-breakpoint
CREATE TRIGGER `users_revoke_sessions`
AFTER UPDATE OF `role`, `community_id`, `password_hash`, `is_active` ON `users`
WHEN OLD.role IS NOT NEW.role OR OLD.community_id IS NOT NEW.community_id
  OR OLD.password_hash IS NOT NEW.password_hash OR OLD.is_active IS NOT NEW.is_active
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
