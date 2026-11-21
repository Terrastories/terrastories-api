-- Issue #188 / Slice 11b-A: one-shot fresh admin_issued step-up expiry on
-- sessions (SPEC-V2 §6.8, §6.10) and composite (user_id, purpose) index on
-- login_codes for GET /v2/auth/me recovery-code check and superseding.
-- Purely additive; metadata-only nullable column addition on PostgreSQL.

ALTER TABLE "sessions" ADD COLUMN "admin_code_step_up_expires_at" bigint;
--> statement-breakpoint
CREATE INDEX "login_codes_user_purpose_idx" ON "login_codes" USING btree ("user_id","purpose");
--> statement-breakpoint
CREATE TABLE "installation_bootstrap" (
	"id" integer PRIMARY KEY NOT NULL,
	"setup_id" text NOT NULL,
	"community_id" integer CONSTRAINT "installation_bootstrap_community_id_communities_id_fk" REFERENCES "communities"("id") ON DELETE set null ON UPDATE no action,
	"admin_user_id" integer CONSTRAINT "installation_bootstrap_admin_user_id_users_id_fk" REFERENCES "users"("id") ON DELETE set null ON UPDATE no action,
	"completed_at" bigint NOT NULL,
	CONSTRAINT "installation_bootstrap_singleton_check" CHECK ("id" = 1)
);
--> statement-breakpoint
ALTER TABLE "auth_throttle" DROP CONSTRAINT "auth_throttle_kind_check";
--> statement-breakpoint
ALTER TABLE "auth_throttle" DROP CONSTRAINT "auth_throttle_ip_community_check";
--> statement-breakpoint
ALTER TABLE "auth_throttle" ADD CONSTRAINT "auth_throttle_kind_check" CHECK ("kind" in ('account', 'ip', 'claim'));
--> statement-breakpoint
ALTER TABLE "auth_throttle" ADD CONSTRAINT "auth_throttle_ip_community_check" CHECK (("kind" = 'account') OR ("kind" = 'ip' AND "community_id" IS NULL) OR ("kind" = 'claim' AND "community_id" IS NOT NULL));
