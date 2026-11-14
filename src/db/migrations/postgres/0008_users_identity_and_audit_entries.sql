-- Issue #137 / #187 Slice 3a:
-- Expand-contract users identity/verifier/nullability alignment and add
-- content-free audit_entries table (SPEC-V2 §6.2, §6.8, §7).
--
-- Fails loudly on ASCII case-variant email collisions before mutating users.
-- Non-ASCII emails leave email_normalized NULL for the idempotent app-level
-- backfill script (scripts/backfill-user-identity.ts using normalizeSearchText).

DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM "users"
		WHERE "community_id" IS NOT NULL
			AND octet_length("email") = char_length("email")
		GROUP BY "community_id", lower("email")
		HAVING count(*) > 1
	) OR EXISTS (
		SELECT 1
		FROM "users"
		WHERE "community_id" IS NULL
			AND octet_length("email") = char_length("email")
		GROUP BY lower("email")
		HAVING count(*) > 1
	) THEN
		RAISE EXCEPTION 'ASCII case-variant email collision detected in users; resolve collisions before migrating';
	END IF;
END
$$;
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "community_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "username" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "display_name" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_verifier" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_algorithm" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_salt" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_params" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "username_normalized" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_normalized" text;
--> statement-breakpoint
UPDATE "users"
SET
	"display_name" = NULLIF(trim(trim("first_name") || ' ' || trim("last_name")), ''),
	"email_normalized" = CASE
		WHEN octet_length("email") = char_length("email") THEN lower("email")
		ELSE NULL
	END;
--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_normalized_unique" ON "users" USING btree ("username_normalized");
--> statement-breakpoint
CREATE UNIQUE INDEX "users_community_email_normalized_unique" ON "users" USING btree ("community_id","email_normalized");
--> statement-breakpoint
CREATE UNIQUE INDEX "users_null_community_email_normalized_unique" ON "users" USING btree ("email_normalized") WHERE "users"."community_id" IS NULL;
--> statement-breakpoint
DROP TRIGGER IF EXISTS users_revoke_sessions ON users;
--> statement-breakpoint
CREATE TRIGGER users_revoke_sessions
AFTER UPDATE OF role, community_id, password_hash, password_verifier, is_active ON users
FOR EACH ROW WHEN (OLD.role IS DISTINCT FROM NEW.role
	OR OLD.community_id IS DISTINCT FROM NEW.community_id
	OR OLD.password_hash IS DISTINCT FROM NEW.password_hash
	OR OLD.password_verifier IS DISTINCT FROM NEW.password_verifier
	OR OLD.is_active IS DISTINCT FROM NEW.is_active)
EXECUTE FUNCTION revoke_changed_authority_sessions();
--> statement-breakpoint
CREATE TABLE "audit_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"community_id" integer CONSTRAINT "audit_entries_community_id_communities_id_fk" REFERENCES "communities"("id") ON DELETE SET NULL,
	"actor_id" integer CONSTRAINT "audit_entries_actor_id_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL,
	"action" text NOT NULL,
	"resource_type" text,
	"resource_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"outcome" text NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_audit_entries_community_created_at" ON "audit_entries" USING btree ("community_id","created_at");
--> statement-breakpoint
CREATE INDEX "idx_audit_entries_actor" ON "audit_entries" USING btree ("actor_id");
--> statement-breakpoint
CREATE INDEX "idx_audit_entries_network_scrub" ON "audit_entries" USING btree ("created_at") WHERE "audit_entries"."ip_address" IS NOT NULL OR "audit_entries"."user_agent" IS NOT NULL;
