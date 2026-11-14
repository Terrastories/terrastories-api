-- Issue #189 Slice 1:
-- 1. Drop story_place_unique and story_speaker_unique constraints so story edges
--    retain source multiplicity at the table level, replacing them with
--    non-unique lookup indexes on (story_id, place_id) and (story_id, speaker_id).
-- 2. Add additive SPEC-V2 §6.5 Speaker columns: birth_date, birthplace_id,
--    affiliation, with a composite (community_id, birthplace_id) tenant FK to
--    places(community_id, id).
ALTER TABLE "story_places" DROP CONSTRAINT IF EXISTS "story_place_unique";--> statement-breakpoint
DROP INDEX IF EXISTS "story_place_unique";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "story_places_story_place_idx" ON "story_places" USING btree ("story_id","place_id");--> statement-breakpoint
ALTER TABLE "story_speakers" DROP CONSTRAINT IF EXISTS "story_speaker_unique";--> statement-breakpoint
DROP INDEX IF EXISTS "story_speaker_unique";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "story_speakers_story_speaker_idx" ON "story_speakers" USING btree ("story_id","speaker_id");--> statement-breakpoint
ALTER TABLE "speakers" ADD COLUMN "birth_date" text;--> statement-breakpoint
ALTER TABLE "speakers" ADD COLUMN "birthplace_id" integer;--> statement-breakpoint
ALTER TABLE "speakers" ADD COLUMN "affiliation" text;--> statement-breakpoint
ALTER TABLE "speakers" ADD CONSTRAINT "speakers_birthplace_community_fk" FOREIGN KEY ("community_id","birthplace_id") REFERENCES "public"."places"("community_id","id") ON DELETE no action ON UPDATE no action;
