-- Issue #137 / Slice 10: client-stretching auth, AuthThrottle, and the
-- session lifetime split (SPEC-V2 §6.8, §7 "Sessions").
--
-- PostgreSQL adds the columns and constraints in place (no table rebuild).
-- Existing rows keep their absolute expires_at; the backfill derives the new
-- idle expiry from it and renews absolute = created_at + the standard absolute
-- lifetime (DEVICE_SESSION_ABSOLUTE_MS), never earlier than idle, so active
-- legacy sessions are not signed out at the legacy deadline. The kind column must be backfilled for every row
-- before SET NOT NULL, so the UPDATE is unconditional: it never writes the
-- user_id key column, and PostgreSQL only re-checks a foreign key when its key
-- columns change, so a legacy row whose user_id names no user (the orphan shape
-- the regression gate keeps under a NOT VALID FK) is not re-validated or
-- silently dropped here.
--
-- kind defaults to standard and is backfilled explicitly so an added column
-- with a non-null default is visible in the audit trail.

DROP TRIGGER IF EXISTS users_revoke_sessions ON users;
--> statement-breakpoint
DROP TRIGGER IF EXISTS communities_revoke_sessions ON communities;
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "kind" text;
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "created_at" bigint;
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "last_seen_at" bigint;
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "idle_expires_at" bigint;
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "absolute_expires_at" bigint;
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "revoked_at" bigint;
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "revoked_by" integer;
--> statement-breakpoint
UPDATE "sessions"
SET
	"kind" = 'standard',
	"created_at" = GREATEST("expires_at" - 43200000, 0),
	"last_seen_at" = GREATEST("expires_at" - 43200000, 0),
	"idle_expires_at" = "expires_at",
	-- absolute_expires_at = created_at + DEVICE_SESSION_ABSOLUTE_MS from
	-- src/shared/auth-policy.ts (5184000000 ms); migration files carry the
	-- literal because they cannot import the constant. Never earlier than
	-- idle_expires_at (= expires_at for legacy rows).
	"absolute_expires_at" = GREATEST(GREATEST("expires_at" - 43200000, 0) + 5184000000, "expires_at"),
	"revoked_at" = NULL,
	"revoked_by" = NULL
WHERE "kind" IS NULL;
--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "kind" SET DEFAULT 'standard';
--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "kind" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_kind_check" CHECK ("kind" in ('standard', 'device'));
--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_revoked_by_check" CHECK (("revoked_at" IS NULL) = ("revoked_by" IS NULL));
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
CREATE TRIGGER communities_revoke_sessions
AFTER UPDATE OF is_active ON communities
FOR EACH ROW WHEN (OLD.is_active IS DISTINCT FROM NEW.is_active)
EXECUTE FUNCTION revoke_changed_authority_sessions();
--> statement-breakpoint
CREATE TABLE "auth_throttle" (
	"key" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"community_id" integer CONSTRAINT "auth_throttle_community_id_communities_id_fk" REFERENCES "communities"("id") ON DELETE cascade ON UPDATE no action,
	"failures" integer DEFAULT 0 NOT NULL,
	"window_started_at" bigint DEFAULT 0 NOT NULL,
	"blocked_until" bigint,
	CONSTRAINT "auth_throttle_kind_check" CHECK ("kind" in ('account', 'ip')),
	CONSTRAINT "auth_throttle_ip_community_check" CHECK ("kind" = 'account' OR "community_id" IS NULL)
);
--> statement-breakpoint
CREATE INDEX "auth_throttle_community_idx" ON "auth_throttle" USING btree ("community_id");