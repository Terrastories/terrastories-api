-- Issue #186 phase 1: composite (community_id, id) tenant foreign keys.
--
-- Every community-owned child row must reference a parent row of the SAME
-- community: story_places/story_speakers gain a community_id column (backfilled
-- from the story) and composite FKs to stories(community_id, id) and
-- places/speakers(community_id, id); stories.interview_location_id and
-- stories.interviewer_id switch to composite FKs against
-- places/speakers(community_id, id); community_media switches its file FK to
-- (community_id, file_id) -> files(community_id, id). Parents gain the
-- required UNIQUE (community_id, id) constraints.
--
-- FAIL-LOUD CONTRACT: if any existing row already violates the new tenancy
-- rule (a cross-community edge, a cross-community interview reference, a
-- cross-community community_media binding, or a join row whose story is
-- missing), the guard block below raises an exception naming the affected
-- relation and row count, and the migration is rolled back and NOT recorded.
-- This migration never drops or repairs rows; repair the data first, then
-- re-run.
DO $composite_tenant_fks_guard$
DECLARE
  cross_community_story_places integer;
  cross_community_story_speakers integer;
  cross_community_interview_locations integer;
  cross_community_interviewers integer;
  cross_community_media integer;
  orphaned_story_places integer;
  orphaned_story_speakers integer;
BEGIN
  SELECT count(*) INTO cross_community_story_places
  FROM story_places sp
  JOIN stories st ON st.id = sp.story_id
  JOIN places pl ON pl.id = sp.place_id
  WHERE st.community_id <> pl.community_id;

  SELECT count(*) INTO cross_community_story_speakers
  FROM story_speakers ss
  JOIN stories st ON st.id = ss.story_id
  JOIN speakers sk ON sk.id = ss.speaker_id
  WHERE st.community_id <> sk.community_id;

  SELECT count(*) INTO cross_community_interview_locations
  FROM stories s
  JOIN places pl ON pl.id = s.interview_location_id
  WHERE s.interview_location_id IS NOT NULL
    AND s.community_id <> pl.community_id;

  SELECT count(*) INTO cross_community_interviewers
  FROM stories s
  JOIN speakers sk ON sk.id = s.interviewer_id
  WHERE s.interviewer_id IS NOT NULL
    AND s.community_id <> sk.community_id;

  SELECT count(*) INTO cross_community_media
  FROM community_media cm
  JOIN files f ON f.id = cm.file_id
  WHERE cm.community_id <> f.community_id;

  SELECT count(*) INTO orphaned_story_places
  FROM story_places sp
  WHERE NOT EXISTS (SELECT 1 FROM stories st WHERE st.id = sp.story_id);

  SELECT count(*) INTO orphaned_story_speakers
  FROM story_speakers ss
  WHERE NOT EXISTS (SELECT 1 FROM stories st WHERE st.id = ss.story_id);

  IF cross_community_story_places > 0 THEN
    RAISE EXCEPTION
      'migration 0004_composite_tenant_fks aborted: % story_places rows link a story and a place of different communities (issue #186). Repair or remove these cross-community rows before migrating; the migration never drops rows.',
      cross_community_story_places;
  END IF;
  IF cross_community_story_speakers > 0 THEN
    RAISE EXCEPTION
      'migration 0004_composite_tenant_fks aborted: % story_speakers rows link a story and a speaker of different communities (issue #186). Repair or remove these cross-community rows before migrating; the migration never drops rows.',
      cross_community_story_speakers;
  END IF;
  IF cross_community_interview_locations > 0 THEN
    RAISE EXCEPTION
      'migration 0004_composite_tenant_fks aborted: % stories rows reference an interview_location_id of another community (issue #186). Repair or remove these cross-community rows before migrating; the migration never drops rows.',
      cross_community_interview_locations;
  END IF;
  IF cross_community_interviewers > 0 THEN
    RAISE EXCEPTION
      'migration 0004_composite_tenant_fks aborted: % stories rows reference an interviewer_id of another community (issue #186). Repair or remove these cross-community rows before migrating; the migration never drops rows.',
      cross_community_interviewers;
  END IF;
  IF cross_community_media > 0 THEN
    RAISE EXCEPTION
      'migration 0004_composite_tenant_fks aborted: % community_media rows bind a file of another community (issue #186). Repair or remove these cross-community rows before migrating; the migration never drops rows.',
      cross_community_media;
  END IF;
  IF orphaned_story_places > 0 OR orphaned_story_speakers > 0 THEN
    RAISE EXCEPTION
      'migration 0004_composite_tenant_fks aborted: % story_places / % story_speakers rows reference a missing story (issue #186); the community_id backfill would leave them NULL. Repair or remove these rows before migrating; the migration never drops rows.',
      orphaned_story_places, orphaned_story_speakers;
  END IF;
END $composite_tenant_fks_guard$;
--> statement-breakpoint
ALTER TABLE "places" ADD CONSTRAINT "places_community_id_id_unique" UNIQUE ("community_id", "id");
--> statement-breakpoint
ALTER TABLE "speakers" ADD CONSTRAINT "speakers_community_id_id_unique" UNIQUE ("community_id", "id");
--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_community_id_id_unique" UNIQUE ("community_id", "id");
--> statement-breakpoint
ALTER TABLE "stories" ADD CONSTRAINT "stories_community_id_id_unique" UNIQUE ("community_id", "id");
--> statement-breakpoint
ALTER TABLE "story_places" ADD COLUMN "community_id" integer;
--> statement-breakpoint
UPDATE "story_places" SET "community_id" = st."community_id" FROM "stories" st WHERE st."id" = "story_places"."story_id";
--> statement-breakpoint
ALTER TABLE "story_places" ALTER COLUMN "community_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "story_places" DROP CONSTRAINT "story_places_story_id_stories_id_fk";
--> statement-breakpoint
ALTER TABLE "story_places" DROP CONSTRAINT "story_places_place_id_places_id_fk";
--> statement-breakpoint
ALTER TABLE "story_places" ADD CONSTRAINT "story_places_community_id_story_id_stories_community_id_id_fk" FOREIGN KEY ("community_id","story_id") REFERENCES "stories"("community_id","id") ON UPDATE no action ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "story_places" ADD CONSTRAINT "story_places_community_id_place_id_places_community_id_id_fk" FOREIGN KEY ("community_id","place_id") REFERENCES "places"("community_id","id") ON UPDATE no action ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "story_speakers" ADD COLUMN "community_id" integer;
--> statement-breakpoint
UPDATE "story_speakers" SET "community_id" = st."community_id" FROM "stories" st WHERE st."id" = "story_speakers"."story_id";
--> statement-breakpoint
ALTER TABLE "story_speakers" ALTER COLUMN "community_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "story_speakers" DROP CONSTRAINT "story_speakers_story_id_stories_id_fk";
--> statement-breakpoint
ALTER TABLE "story_speakers" DROP CONSTRAINT "story_speakers_speaker_id_speakers_id_fk";
--> statement-breakpoint
ALTER TABLE "story_speakers" ADD CONSTRAINT "story_speakers_community_id_story_id_stories_community_id_id_fk" FOREIGN KEY ("community_id","story_id") REFERENCES "stories"("community_id","id") ON UPDATE no action ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "story_speakers" ADD CONSTRAINT "story_speakers_community_id_speaker_id_speakers_community_id_id_fk" FOREIGN KEY ("community_id","speaker_id") REFERENCES "speakers"("community_id","id") ON UPDATE no action ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "stories" DROP CONSTRAINT "stories_interview_location_id_places_id_fk";
--> statement-breakpoint
ALTER TABLE "stories" DROP CONSTRAINT "stories_interviewer_id_speakers_id_fk";
--> statement-breakpoint
ALTER TABLE "stories" ADD CONSTRAINT "stories_community_id_interview_location_id_places_community_id_id_fk" FOREIGN KEY ("community_id","interview_location_id") REFERENCES "places"("community_id","id") ON UPDATE no action ON DELETE no action;
--> statement-breakpoint
ALTER TABLE "stories" ADD CONSTRAINT "stories_community_id_interviewer_id_speakers_community_id_id_fk" FOREIGN KEY ("community_id","interviewer_id") REFERENCES "speakers"("community_id","id") ON UPDATE no action ON DELETE no action;
--> statement-breakpoint
ALTER TABLE "community_media" DROP CONSTRAINT "community_media_file_id_files_id_fk";
--> statement-breakpoint
ALTER TABLE "community_media" ADD CONSTRAINT "community_media_community_id_file_id_files_community_id_id_fk" FOREIGN KEY ("community_id","file_id") REFERENCES "files"("community_id","id") ON UPDATE no action ON DELETE cascade;
