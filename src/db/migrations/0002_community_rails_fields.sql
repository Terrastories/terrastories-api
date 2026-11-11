ALTER TABLE `communities` ADD `country` text;
--> statement-breakpoint
ALTER TABLE `communities` ADD `beta` integer DEFAULT false NOT NULL;
