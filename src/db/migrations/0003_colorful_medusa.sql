ALTER TABLE `stories` ADD `slug` text NOT NULL;--> statement-breakpoint
ALTER TABLE `story_places` ADD `cultural_context` text;--> statement-breakpoint
ALTER TABLE `story_places` ADD `sort_order` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `story_speakers` ADD `story_role` text;--> statement-breakpoint
ALTER TABLE `story_speakers` ADD `sort_order` integer DEFAULT 0;