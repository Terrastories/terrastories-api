-- Issue #188 / Slice 11: LoginCode and ClaimToken tables (SPEC-V2 §6.8,
-- docs/V2-DOMAIN-BUILD-PLAN.md "Slice 11").
--
-- New tables only; no existing table is rebuilt. code_hash and token_hash
-- store only the SHA-256 digest of single-use, >=100-bit material; the raw
-- value is returned once at issuance and never persisted, logged or audited.
-- Millisecond (Unix epoch) bigint timestamps throughout (#192), matching
-- sessions/auth_throttle. Tenancy: login_codes.community_id is the target
-- account's community (null only for a null-community account);
-- claim_tokens.community_id is required and names the one empty,
-- never-administered community the token may claim.

CREATE TABLE "login_codes" (
	"id" serial PRIMARY KEY NOT NULL,
	"community_id" integer CONSTRAINT "login_codes_community_id_communities_id_fk" REFERENCES "communities"("id") ON DELETE cascade ON UPDATE no action,
	"user_id" integer NOT NULL CONSTRAINT "login_codes_user_id_users_id_fk" REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action,
	"purpose" text NOT NULL,
	"code_hash" text NOT NULL,
	"created_by" integer CONSTRAINT "login_codes_created_by_users_id_fk" REFERENCES "users"("id") ON DELETE set null ON UPDATE no action,
	"created_at" bigint NOT NULL,
	"expires_at" bigint,
	"used_at" bigint,
	"superseded_at" bigint,
	CONSTRAINT "login_codes_purpose_check" CHECK ("purpose" in ('admin_issued', 'recovery')),
	CONSTRAINT "login_codes_purpose_expiry_check" CHECK (("purpose" = 'admin_issued' AND "expires_at" IS NOT NULL) OR ("purpose" = 'recovery' AND "expires_at" IS NULL)),
	CONSTRAINT "login_codes_expiry_check" CHECK ("expires_at" IS NULL OR "expires_at" > "created_at"),
	CONSTRAINT "login_codes_admin_ttl_check" CHECK ("purpose" <> 'admin_issued' OR ("expires_at" IS NOT NULL AND "expires_at" - "created_at" <= 259200000)),
	CONSTRAINT "login_codes_recovery_no_expiry_check" CHECK ("purpose" <> 'recovery' OR "expires_at" IS NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "login_codes_code_hash_unique" ON "login_codes" USING btree ("code_hash");
--> statement-breakpoint
CREATE INDEX "login_codes_user_idx" ON "login_codes" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "login_codes_community_idx" ON "login_codes" USING btree ("community_id");
--> statement-breakpoint
CREATE TABLE "claim_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"community_id" integer NOT NULL CONSTRAINT "claim_tokens_community_id_communities_id_fk" REFERENCES "communities"("id") ON DELETE cascade ON UPDATE no action,
	"token_hash" text NOT NULL,
	"issued_by" integer NOT NULL CONSTRAINT "claim_tokens_issued_by_users_id_fk" REFERENCES "users"("id") ON DELETE no action ON UPDATE no action,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"consumed_at" bigint,
	"consumed_by" integer CONSTRAINT "claim_tokens_consumed_by_users_id_fk" REFERENCES "users"("id") ON DELETE set null ON UPDATE no action,
	"superseded_at" bigint,
	CONSTRAINT "claim_tokens_expiry_check" CHECK ("expires_at" > "created_at"),
	CONSTRAINT "claim_tokens_consumed_check" CHECK (("consumed_at" IS NULL) = ("consumed_by" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "claim_tokens_token_hash_unique" ON "claim_tokens" USING btree ("token_hash");
--> statement-breakpoint
CREATE INDEX "claim_tokens_community_idx" ON "claim_tokens" USING btree ("community_id");
