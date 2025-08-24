-- Step 1: Add nullable slug column first
ALTER TABLE `stories` ADD `slug` text;--> statement-breakpoint
-- Step 2: Backfill existing stories with slugs based on title + unique suffix  
UPDATE `stories` SET `slug` = 
  CASE 
    WHEN `slug` IS NULL THEN 
      LOWER(
        REPLACE(
          REPLACE(
            REPLACE(
              REPLACE(title, ' ', '-'), 
              '''', ''), 
            '"', ''), 
          '.', '')
      ) || '-' || CAST(id AS TEXT)
    ELSE `slug`
  END;--> statement-breakpoint
-- Step 3: Create unique index on community + slug before making NOT NULL
CREATE UNIQUE INDEX `stories_community_slug_idx` ON `stories`(`community_id`, `slug`);--> statement-breakpoint
ALTER TABLE `story_places` ADD `cultural_context` text;--> statement-breakpoint
ALTER TABLE `story_places` ADD `sort_order` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `story_speakers` ADD `story_role` text;--> statement-breakpoint
ALTER TABLE `story_speakers` ADD `sort_order` integer DEFAULT 0;