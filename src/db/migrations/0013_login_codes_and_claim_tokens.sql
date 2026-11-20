-- Issue #188 / Slice 11: LoginCode and ClaimToken tables (SPEC-V2 §6.8,
-- docs/V2-DOMAIN-BUILD-PLAN.md "Slice 11").
--
-- New tables only; no existing table is rebuilt. `code_hash`/`token_hash`
-- store only the SHA-256 digest of single-use, >=100-bit material; the raw
-- value is returned once at issuance and never persisted, logged or audited.
-- Millisecond Unix timestamps throughout (#192), matching sessions/auth_throttle.
-- Tenancy: login_codes.community_id is the target account's community (null
-- only for a null-community account); claim_tokens.community_id is required
-- and names the one empty, never-administered community the token may claim.
-- Erasure: claim_tokens.issued_by is nullable with ON DELETE SET NULL so an
-- issuer erasure is never blocked; login_codes.user_id cascades with the
-- account and login_codes.created_by is SET NULL.

CREATE TABLE `login_codes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`community_id` integer,
	`user_id` integer NOT NULL,
	`purpose` text NOT NULL,
	`code_hash` text NOT NULL,
	`created_by` integer,
	`created_at` integer NOT NULL,
	`expires_at` integer,
	`used_at` integer,
	`superseded_at` integer,
	CONSTRAINT `login_codes_community_id_communities_id_fk` FOREIGN KEY (`community_id`) REFERENCES `communities`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `login_codes_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `login_codes_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT `login_codes_purpose_check` CHECK (`purpose` in ('admin_issued', 'recovery')),
	CONSTRAINT `login_codes_purpose_expiry_check` CHECK ((`purpose` = 'admin_issued' AND `expires_at` IS NOT NULL) OR (`purpose` = 'recovery' AND `expires_at` IS NULL)),
	CONSTRAINT `login_codes_expiry_check` CHECK (`expires_at` IS NULL OR `expires_at` > `created_at`),
	CONSTRAINT `login_codes_admin_ttl_check` CHECK (`purpose` <> 'admin_issued' OR (`expires_at` IS NOT NULL AND `expires_at` - `created_at` <= 259200000)),
	CONSTRAINT `login_codes_recovery_no_expiry_check` CHECK (`purpose` <> 'recovery' OR `expires_at` IS NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `login_codes_code_hash_unique` ON `login_codes` (`code_hash`);
--> statement-breakpoint
CREATE INDEX `login_codes_user_idx` ON `login_codes` (`user_id`);
--> statement-breakpoint
CREATE INDEX `login_codes_community_idx` ON `login_codes` (`community_id`);
--> statement-breakpoint
CREATE TABLE `claim_tokens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`community_id` integer NOT NULL,
	`token_hash` text NOT NULL,
	`issued_by` integer,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`consumed_by` integer,
	`superseded_at` integer,
	CONSTRAINT `claim_tokens_community_id_communities_id_fk` FOREIGN KEY (`community_id`) REFERENCES `communities`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `claim_tokens_issued_by_users_id_fk` FOREIGN KEY (`issued_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT `claim_tokens_consumed_by_users_id_fk` FOREIGN KEY (`consumed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT `claim_tokens_expiry_check` CHECK (`expires_at` > `created_at`),
	CONSTRAINT `claim_tokens_consumed_check` CHECK ((`consumed_by` IS NULL) OR (`consumed_at` IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `claim_tokens_token_hash_unique` ON `claim_tokens` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `claim_tokens_community_idx` ON `claim_tokens` (`community_id`);
