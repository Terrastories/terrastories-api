-- Slice 13b / #187: Community sovereignty tables (community_stewards,
-- community_sovereignty_requests, community_archive_custody) (SPEC-V2 §7).
--
-- Numbered 0017 after Slice 13a export jobs/tokens (0016).
-- Millisecond Unix epoch bigint timestamps throughout (#192).

CREATE TABLE "community_stewards" (
	"community_id" integer PRIMARY KEY NOT NULL CONSTRAINT "community_stewards_community_id_communities_id_fk" REFERENCES "communities"("id") ON DELETE cascade ON UPDATE no action,
	"user_id" integer NOT NULL CONSTRAINT "community_stewards_user_id_users_id_fk" REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action,
	"designated_by" integer CONSTRAINT "community_stewards_designated_by_users_id_fk" REFERENCES "users"("id") ON DELETE set null ON UPDATE no action,
	"designated_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "community_stewards_user_idx" ON "community_stewards" USING btree ("user_id");
--> statement-breakpoint
CREATE TABLE "community_sovereignty_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"community_id" integer NOT NULL CONSTRAINT "community_sovereignty_requests_community_id_communities_id_fk" REFERENCES "communities"("id") ON DELETE cascade ON UPDATE no action,
	"kind" text NOT NULL,
	"state" text NOT NULL,
	"initiated_by" integer CONSTRAINT "community_sovereignty_requests_initiated_by_users_id_fk" REFERENCES "users"("id") ON DELETE set null ON UPDATE no action,
	"initiated_by_role" text NOT NULL,
	"requested_at" bigint NOT NULL,
	"notice_ends_at" bigint,
	"effective_at" bigint,
	"cancelled_at" bigint,
	"cancelled_by" integer CONSTRAINT "community_sovereignty_requests_cancelled_by_users_id_fk" REFERENCES "users"("id") ON DELETE set null ON UPDATE no action,
	"completed_at" bigint,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "community_sovereignty_requests_kind_check" CHECK ("kind" in ('withdrawal', 'erasure')),
	CONSTRAINT "community_sovereignty_requests_state_check" CHECK ("state" in ('requested', 'notice', 'cancelled', 'executing', 'completed')),
	CONSTRAINT "community_sovereignty_requests_role_check" CHECK ("initiated_by_role" in ('admin', 'steward')),
	CONSTRAINT "community_sovereignty_requests_notice_check" CHECK ("notice_ends_at" IS NULL OR "notice_ends_at" > "requested_at"),
	CONSTRAINT "community_sovereignty_requests_cancelled_check" CHECK (("state" = 'cancelled' AND "cancelled_at" IS NOT NULL) OR ("state" <> 'cancelled' AND "cancelled_at" IS NULL)),
	CONSTRAINT "community_sovereignty_requests_completed_check" CHECK (("state" = 'completed' AND "completed_at" IS NOT NULL) OR ("state" <> 'completed' AND "completed_at" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "community_sovereignty_requests_active_erasure_unique" ON "community_sovereignty_requests" USING btree ("community_id") WHERE ("kind" = 'erasure' AND "state" in ('requested', 'executing', 'completed'));
--> statement-breakpoint
CREATE UNIQUE INDEX "community_sovereignty_requests_pending_notice_unique" ON "community_sovereignty_requests" USING btree ("community_id","kind") WHERE ("state" = 'notice');
--> statement-breakpoint
CREATE INDEX "community_sovereignty_requests_community_created_idx" ON "community_sovereignty_requests" USING btree ("community_id","requested_at","id");
--> statement-breakpoint
CREATE INDEX "community_sovereignty_requests_due_notice_idx" ON "community_sovereignty_requests" USING btree ("notice_ends_at") WHERE ("state" = 'notice');
--> statement-breakpoint
CREATE INDEX "community_sovereignty_requests_executing_idx" ON "community_sovereignty_requests" USING btree ("state","updated_at") WHERE ("state" in ('requested', 'executing'));
--> statement-breakpoint
CREATE TABLE "community_archive_custody" (
	"community_id" integer PRIMARY KEY NOT NULL CONSTRAINT "community_archive_custody_community_id_communities_id_fk" REFERENCES "communities"("id") ON DELETE cascade ON UPDATE no action,
	"custodian_type" text NOT NULL,
	"custodian_user_id" integer CONSTRAINT "community_archive_custody_custodian_user_id_users_id_fk" REFERENCES "users"("id") ON DELETE set null ON UPDATE no action,
	"status" text NOT NULL,
	"retention_until" bigint NOT NULL,
	"destroyed_at" bigint,
	"destruction_attestation_ref" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "community_archive_custody_type_check" CHECK ("custodian_type" in ('community', 'steward')),
	CONSTRAINT "community_archive_custody_status_check" CHECK ("status" in ('held', 'destroyed')),
	CONSTRAINT "community_archive_custody_destroyed_check" CHECK (("status" = 'destroyed' AND "destroyed_at" IS NOT NULL) OR ("status" = 'held' AND "destroyed_at" IS NULL))
);
--> statement-breakpoint
CREATE INDEX "community_archive_custody_custodian_idx" ON "community_archive_custody" USING btree ("custodian_user_id");
