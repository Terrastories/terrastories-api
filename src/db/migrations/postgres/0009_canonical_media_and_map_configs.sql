-- Slice 2: Canonical File, Attachment, ExternalMediaLink, and CommunityMapConfig schema
-- PostgreSQL expand-contract migration preserving legacy V1 compatibility and
-- skipping any legacy orphan rows when running in-migration UPDATE backfills.

ALTER TABLE "files" ALTER COLUMN "community_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "files" ALTER COLUMN "uploaded_by" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "storage_key" text;
--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "byte_size" bigint;
--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "checksum" text;
--> statement-breakpoint
UPDATE "files"
SET
	"storage_key" = COALESCE("storage_key", "path"),
	"byte_size" = COALESCE("byte_size", "size")
WHERE ("storage_key" IS NULL OR "byte_size" IS NULL)
  AND (
	"community_id" IS NULL
	OR EXISTS (
		SELECT 1
		FROM "communities" AS "c"
		WHERE "c"."id" = "files"."community_id"
	)
  )
  AND (
	"uploaded_by" IS NULL
	OR EXISTS (
		SELECT 1
		FROM "users" AS "u"
		WHERE "u"."id" = "files"."uploaded_by"
	)
  );
--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "community_id" integer;
--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "file_id" uuid;
--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "owner_type" text;
--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "owner_id" integer;
--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "role" text;
--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "ordinal" integer DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "attachments" ALTER COLUMN "attachable_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "attachments" ALTER COLUMN "attachable_type" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "attachments" ALTER COLUMN "url" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "attachments" ALTER COLUMN "filename" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_file_community_fk" FOREIGN KEY ("community_id","file_id") REFERENCES "public"."files"("community_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "attachments_owner_idx" ON "attachments" USING btree ("community_id","owner_type","owner_id","role","ordinal");
--> statement-breakpoint
CREATE INDEX "attachments_file_idx" ON "attachments" USING btree ("file_id");
--> statement-breakpoint
INSERT INTO "attachments" (
	"community_id",
	"file_id",
	"owner_type",
	"owner_id",
	"role",
	"ordinal",
	"created_at"
)
SELECT
	"cm"."community_id",
	"cm"."file_id",
	'community',
	"cm"."community_id",
	'community_display_image',
	ROW_NUMBER() OVER (
		PARTITION BY "cm"."community_id"
		ORDER BY "cm"."file_id"
	) - 1,
	"f"."created_at"
FROM "community_media" AS "cm"
INNER JOIN "files" AS "f"
	ON "f"."id" = "cm"."file_id"
   AND "f"."community_id" = "cm"."community_id"
WHERE "cm"."kind" = 'branding'
  AND NOT EXISTS (
	SELECT 1
	FROM "attachments" AS "a"
	WHERE "a"."community_id" = "cm"."community_id"
	  AND "a"."file_id" = "cm"."file_id"
	  AND "a"."owner_type" = 'community'
	  AND "a"."owner_id" = "cm"."community_id"
	  AND "a"."role" = 'community_display_image'
  )
ORDER BY "cm"."community_id", "cm"."file_id";
--> statement-breakpoint
CREATE TABLE "community_map_configs" (
	"community_id" integer PRIMARY KEY NOT NULL CONSTRAINT "community_map_configs_community_id_communities_id_fk" REFERENCES "public"."communities"("id") ON DELETE cascade ON UPDATE no action,
	"style_url" text,
	"basemap_style" text,
	"center_latitude" double precision,
	"center_longitude" double precision,
	"south_west_latitude" double precision,
	"south_west_longitude" double precision,
	"north_east_latitude" double precision,
	"north_east_longitude" double precision,
	"zoom" double precision,
	"pitch" double precision,
	"bearing" double precision,
	"three_dimensional" boolean,
	"projection" text,
	"static_map_file_id" uuid,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) DEFAULT now() NOT NULL,
	CONSTRAINT "community_map_configs_static_map_file_community_fk" FOREIGN KEY ("community_id","static_map_file_id") REFERENCES "public"."files"("community_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "community_map_configs_static_map_file_idx" ON "community_map_configs" USING btree ("static_map_file_id");
--> statement-breakpoint
CREATE TABLE "external_media_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"community_id" integer NOT NULL,
	"story_id" integer NOT NULL,
	"url" text NOT NULL,
	"ordinal" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	CONSTRAINT "external_media_links_story_community_fk" FOREIGN KEY ("community_id","story_id") REFERENCES "public"."stories"("community_id","id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "external_media_links_story_idx" ON "external_media_links" USING btree ("community_id","story_id","ordinal");
