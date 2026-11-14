-- Issue #189 Slice 1b:
-- Remaining Slice 1 content columns and nullability alignment across
-- communities, stories, and places (SPEC-V2 §6.1, §6.3, §6.4, §6.9).
ALTER TABLE "communities" ADD COLUMN "description_plain" text;--> statement-breakpoint
ALTER TABLE "stories" ALTER COLUMN "created_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "description_plain" text;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "topic" text;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "topic_normalized" text;--> statement-breakpoint
ALTER TABLE "places" ALTER COLUMN "latitude" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "places" ALTER COLUMN "longitude" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "places" ADD COLUMN "description_plain" text;--> statement-breakpoint
ALTER TABLE "places" ADD COLUMN "type_of_place" text;
