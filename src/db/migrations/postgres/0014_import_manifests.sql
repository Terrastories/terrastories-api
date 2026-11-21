-- Issue #123 / #197 / Slice 12: ImportManifest table (SPEC-V2 §4, §6.9,
-- docs/V2-DOMAIN-BUILD-PLAN.md "Slice 12").
--
-- New table only; purely additive on PostgreSQL. Stores immutable normalized
-- CSV import previews, explicit mappings, row-level errors, staged file IDs,
-- and millisecond Unix epoch bigint timestamps.
-- Composite (community_id, source_file_id) FK enforces tenant scoping to files;
-- created_by uses ON DELETE SET NULL so user erasure is never blocked.

CREATE TABLE "import_manifests" (
	"id" serial PRIMARY KEY NOT NULL,
	"community_id" integer NOT NULL CONSTRAINT "import_manifests_community_id_communities_id_fk" REFERENCES "communities"("id") ON DELETE cascade ON UPDATE no action,
	"kind" text NOT NULL,
	"status" text DEFAULT 'previewed' NOT NULL,
	"created_by" integer CONSTRAINT "import_manifests_created_by_users_id_fk" REFERENCES "users"("id") ON DELETE set null ON UPDATE no action,
	"source_file_name" text,
	"source_file_id" uuid NOT NULL,
	"mappings" jsonb NOT NULL,
	"normalized_rows" jsonb NOT NULL,
	"row_count" integer NOT NULL,
	"row_errors" jsonb NOT NULL,
	"staged_file_ids" jsonb NOT NULL,
	"result_summary" jsonb,
	"committed_at" bigint,
	"created_at" bigint NOT NULL,
	CONSTRAINT "import_manifests_source_file_community_fk" FOREIGN KEY ("community_id","source_file_id") REFERENCES "public"."files"("community_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "import_manifests_kind_check" CHECK ("kind" in ('places', 'speakers', 'stories')),
	CONSTRAINT "import_manifests_status_check" CHECK ("status" in ('previewed', 'committed', 'failed', 'discarded')),
	CONSTRAINT "import_manifests_row_count_check" CHECK ("row_count" >= 0),
	CONSTRAINT "import_manifests_committed_at_check" CHECK (("status" = 'committed' AND "committed_at" IS NOT NULL) OR ("status" <> 'committed' AND "committed_at" IS NULL))
);
--> statement-breakpoint
CREATE INDEX "import_manifests_community_created_idx" ON "import_manifests" USING btree ("community_id","created_at","id");
--> statement-breakpoint
CREATE INDEX "import_manifests_community_status_idx" ON "import_manifests" USING btree ("community_id","status","created_at");
--> statement-breakpoint
CREATE INDEX "import_manifests_status_committed_at_idx" ON "import_manifests" USING btree ("status","committed_at");
--> statement-breakpoint
CREATE INDEX "import_manifests_source_file_idx" ON "import_manifests" USING btree ("source_file_id");
--> statement-breakpoint
CREATE INDEX "import_manifests_created_by_idx" ON "import_manifests" USING btree ("created_by");
