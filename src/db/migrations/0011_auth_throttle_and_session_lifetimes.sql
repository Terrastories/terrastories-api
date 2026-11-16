-- Issue #137 / Slice 10: client-stretching auth, AuthThrottle, and the
-- session lifetime split (SPEC-V2 §6.8, §7 "Sessions").
--
-- `sessions` is rebuilt because SQLite cannot add a CHECK constraint in place:
-- the tombstone columns get `revoked_at`/`revoked_by` (both or neither) and
-- `kind` gets its enum check. `revoked_by` stays a plain nullable integer with
-- no foreign key: a revoked session row may outlive the revoking account, and
-- the both-or-neither CHECK is the only invariant that must hold.
-- Existing rows are backfilled so the new idle/absolute columns keep a live
-- session renewing: idle = the legacy expires_at, and absolute = created_at +
-- the standard absolute lifetime (DEVICE_SESSION_ABSOLUTE_MS), never earlier
-- than idle — so an active legacy session is not signed out at its old
-- deadline once renewal slides the idle expiry. a live row is a
-- `standard` session created and last seen no earlier than the row's own
-- expiry minus one idle window.
-- No PRAGMA statements (D1 forbids them); `sqlite_sequence` is not touched
-- because `sessions.id` is a text primary key, never AUTOINCREMENT.

DROP TRIGGER IF EXISTS `users_revoke_sessions`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `communities_revoke_sessions`;
--> statement-breakpoint
ALTER TABLE `sessions` RENAME TO `sessions_old`;
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`user_id` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`kind` text DEFAULT 'standard' NOT NULL,
	`created_at` integer,
	`last_seen_at` integer,
	`idle_expires_at` integer,
	`absolute_expires_at` integer,
	`revoked_at` integer,
	`revoked_by` integer,
	CONSTRAINT `sessions_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `sessions_kind_check` CHECK (`kind` in ('standard', 'device')),
	CONSTRAINT `sessions_revoked_by_check` CHECK ((`revoked_at` IS NULL) = (`revoked_by` IS NULL))
);
--> statement-breakpoint
INSERT INTO `sessions` (
	`id`,
	`token_hash`,
	`user_id`,
	`expires_at`,
	`kind`,
	`created_at`,
	`last_seen_at`,
	`idle_expires_at`,
	`absolute_expires_at`,
	`revoked_at`,
	`revoked_by`
)
SELECT
	`id`,
	`token_hash`,
	`user_id`,
	`expires_at`,
	'standard',
	MAX(`expires_at` - 43200000, 0),
	MAX(`expires_at` - 43200000, 0),
	`expires_at`,
	-- absolute_expires_at = created_at + DEVICE_SESSION_ABSOLUTE_MS from
	-- src/shared/auth-policy.ts (5184000000 ms); migration files carry the
	-- literal because they cannot import the constant. Never earlier than
	-- idle_expires_at (= expires_at for legacy rows).
	MAX(MAX(`expires_at` - 43200000, 0) + 5184000000, `expires_at`),
	NULL,
	NULL
FROM `sessions_old`;
--> statement-breakpoint
DROP TABLE `sessions_old`;
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash_unique` ON `sessions` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);
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
CREATE TABLE `auth_throttle` (
	`key` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`community_id` integer,
	`failures` integer DEFAULT 0 NOT NULL,
	`window_started_at` integer DEFAULT 0 NOT NULL,
	`blocked_until` integer,
	CONSTRAINT `auth_throttle_community_id_communities_id_fk` FOREIGN KEY (`community_id`) REFERENCES `communities`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `auth_throttle_kind_check` CHECK (`kind` in ('account', 'ip')),
	CONSTRAINT `auth_throttle_ip_community_check` CHECK (`kind` = 'account' OR `community_id` IS NULL)
);
--> statement-breakpoint
CREATE INDEX `auth_throttle_community_idx` ON `auth_throttle` (`community_id`);