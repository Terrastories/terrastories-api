-- Slice 13a / #187: Community export job & single-artifact download token tables
-- plus community_id lookup indexes on story_places, story_speakers, and
-- community_media (SPEC-V2 §7).
--
-- Numbered 0015 (leaving PG 0014 for parallel Slice 12 import_manifests).
-- Millisecond Unix epoch bigint timestamps throughout (#192).

CREATE TABLE "export_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"community_id" integer NOT NULL CONSTRAINT "export_jobs_community_id_communities_id_fk" REFERENCES "communities"("id") ON DELETE cascade ON UPDATE no action,
	"requested_by" integer CONSTRAINT "export_jobs_requested_by_users_id_fk" REFERENCES "users"("id") ON DELETE set null ON UPDATE no action,
	"status" text NOT NULL,
	"manifest_storage_key" text,
	"manifest_byte_size" bigint,
	"manifest_checksum" text,
	"zip_storage_key" text,
	"zip_byte_size" bigint,
	"zip_checksum" text,
	"zip_upload_id" text,
	"created_at" bigint NOT NULL,
	"completed_at" bigint,
	"expires_at" bigint NOT NULL,
	"cleaned_up_at" bigint,
	CONSTRAINT "export_jobs_status_check" CHECK ("status" in ('generating', 'ready', 'failed', 'expired')),
	CONSTRAINT "export_jobs_expiry_check" CHECK ("expires_at" > "created_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "export_jobs_active_community_unique" ON "export_jobs" USING btree ("community_id") WHERE ("status" = 'generating');
--> statement-breakpoint
CREATE INDEX "export_jobs_community_created_idx" ON "export_jobs" USING btree ("community_id","created_at");
--> statement-breakpoint
CREATE INDEX "export_jobs_requested_by_created_idx" ON "export_jobs" USING btree ("requested_by","created_at");
--> statement-breakpoint
CREATE INDEX "export_jobs_cleanup_idx" ON "export_jobs" USING btree ("expires_at") WHERE ("cleaned_up_at" IS NULL);
--> statement-breakpoint
CREATE TABLE "export_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL CONSTRAINT "export_tokens_job_id_export_jobs_id_fk" REFERENCES "export_jobs"("id") ON DELETE cascade ON UPDATE no action,
	"community_id" integer NOT NULL CONSTRAINT "export_tokens_community_id_communities_id_fk" REFERENCES "communities"("id") ON DELETE cascade ON UPDATE no action,
	"requested_by" integer NOT NULL CONSTRAINT "export_tokens_requested_by_users_id_fk" REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action,
	"artifact" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"downloaded_at" bigint,
	CONSTRAINT "export_tokens_artifact_check" CHECK ("artifact" in ('manifest', 'media_zip')),
	CONSTRAINT "export_tokens_expiry_check" CHECK ("expires_at" > "created_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "export_tokens_token_hash_unique" ON "export_tokens" USING btree ("token_hash");
--> statement-breakpoint
CREATE UNIQUE INDEX "export_tokens_job_artifact_unique" ON "export_tokens" USING btree ("job_id","artifact");
--> statement-breakpoint
CREATE INDEX "export_tokens_community_idx" ON "export_tokens" USING btree ("community_id");
--> statement-breakpoint
CREATE INDEX "export_tokens_expires_idx" ON "export_tokens" USING btree ("expires_at");
--> statement-breakpoint
CREATE INDEX "story_places_community_id_idx" ON "story_places" USING btree ("community_id");
--> statement-breakpoint
CREATE INDEX "story_speakers_community_id_idx" ON "story_speakers" USING btree ("community_id");
--> statement-breakpoint
CREATE INDEX "community_media_community_id_idx" ON "community_media" USING btree ("community_id");
