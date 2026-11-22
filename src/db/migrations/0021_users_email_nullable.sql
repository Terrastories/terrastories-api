-- D1 (migrator S2): users.email becomes nullable.
-- Rails allows users without an email; SPEC-V2 §6.2 declares `email?`. The
-- unique indexes (email, community_id) and (community_id, email_normalized)
-- already tolerate NULL (SQL NULLs are distinct), so no identity rule changes.
--
-- SQLite cannot drop NOT NULL in place, and rebuilding `users` would cascade
-- through sixteen child tables. Instead: add a nullable replacement column,
-- copy, drop the two email indexes and the old column, rename the new column.
-- Uses no PRAGMA statements (D1 compatible). The session-revocation trigger
-- does not list `email`, so the copy does not revoke sessions.
ALTER TABLE `users` ADD COLUMN `email_nullable` text;
--> statement-breakpoint
UPDATE `users` SET `email_nullable` = `email`;
--> statement-breakpoint
DROP INDEX `users_email_community_unique`;
--> statement-breakpoint
DROP INDEX `idx_users_community_email`;
--> statement-breakpoint
ALTER TABLE `users` DROP COLUMN `email`;
--> statement-breakpoint
ALTER TABLE `users` RENAME COLUMN `email_nullable` TO `email`;
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_community_unique` ON `users` (`email`,`community_id`);
--> statement-breakpoint
CREATE INDEX `idx_users_community_email` ON `users` (`community_id`,`email`);
