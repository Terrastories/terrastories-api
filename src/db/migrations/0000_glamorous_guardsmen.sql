CREATE TABLE `attachments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`attachable_id` integer NOT NULL,
	`attachable_type` text NOT NULL,
	`url` text NOT NULL,
	`filename` text NOT NULL,
	`content_type` text,
	`file_size` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `communities` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`slug` text NOT NULL,
	`public_stories` integer DEFAULT false NOT NULL,
	`locale` text DEFAULT 'en' NOT NULL,
	`cultural_settings` text,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `communities_slug_unique` ON `communities` (`slug`);--> statement-breakpoint
CREATE TABLE `files` (
	`id` text PRIMARY KEY NOT NULL,
	`filename` text NOT NULL,
	`original_name` text NOT NULL,
	`path` text NOT NULL,
	`url` text NOT NULL,
	`mime_type` text NOT NULL,
	`size` integer NOT NULL,
	`community_id` integer NOT NULL,
	`uploaded_by` integer NOT NULL,
	`metadata` text,
	`cultural_restrictions` text,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`community_id`) REFERENCES `communities`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`uploaded_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `places` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`community_id` integer NOT NULL,
	`latitude` real NOT NULL,
	`longitude` real NOT NULL,
	`region` text,
	`media_urls` text DEFAULT '[]',
	`photo_url` text,
	`cultural_significance` text,
	`is_restricted` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`community_id`) REFERENCES `communities`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `places_community_id_idx` ON `places` (`community_id`);--> statement-breakpoint
CREATE INDEX `places_photo_url_idx` ON `places` (`photo_url`);--> statement-breakpoint
CREATE TABLE `speakers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`bio` text,
	`community_id` integer NOT NULL,
	`photo_url` text,
	`bio_audio_url` text,
	`birth_year` integer,
	`elder_status` integer DEFAULT false NOT NULL,
	`cultural_role` text,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`community_id`) REFERENCES `communities`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `speakers_community_id_idx` ON `speakers` (`community_id`);--> statement-breakpoint
CREATE INDEX `speakers_bio_audio_url_idx` ON `speakers` (`bio_audio_url`);--> statement-breakpoint
CREATE INDEX `speakers_elder_status_idx` ON `speakers` (`elder_status`);--> statement-breakpoint
CREATE INDEX `speakers_cultural_role_idx` ON `speakers` (`cultural_role`);--> statement-breakpoint
CREATE INDEX `speakers_is_active_idx` ON `speakers` (`is_active`);--> statement-breakpoint
CREATE TABLE `stories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`slug` text NOT NULL,
	`community_id` integer NOT NULL,
	`created_by` integer NOT NULL,
	`is_restricted` integer DEFAULT false NOT NULL,
	`privacy_level` text DEFAULT 'public' NOT NULL,
	`media_urls` text DEFAULT '[]',
	`image_url` text,
	`audio_url` text,
	`language` text DEFAULT 'en' NOT NULL,
	`tags` text DEFAULT '[]',
	`date_interviewed` integer,
	`interview_location_id` integer,
	`interviewer_id` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`community_id`) REFERENCES `communities`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`interview_location_id`) REFERENCES `places`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`interviewer_id`) REFERENCES `speakers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `stories_community_id_idx` ON `stories` (`community_id`);--> statement-breakpoint
CREATE INDEX `stories_slug_idx` ON `stories` (`slug`);--> statement-breakpoint
CREATE INDEX `stories_image_url_idx` ON `stories` (`image_url`);--> statement-breakpoint
CREATE INDEX `stories_audio_url_idx` ON `stories` (`audio_url`);--> statement-breakpoint
CREATE INDEX `stories_privacy_level_idx` ON `stories` (`privacy_level`);--> statement-breakpoint
CREATE TABLE `story_places` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`story_id` integer NOT NULL,
	`place_id` integer NOT NULL,
	`cultural_context` text,
	`sort_order` integer DEFAULT 0,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`story_id`) REFERENCES `stories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`place_id`) REFERENCES `places`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `story_place_unique` ON `story_places` (`story_id`,`place_id`);--> statement-breakpoint
CREATE TABLE `story_speakers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`story_id` integer NOT NULL,
	`speaker_id` integer NOT NULL,
	`story_role` text,
	`sort_order` integer DEFAULT 0,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`story_id`) REFERENCES `stories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`speaker_id`) REFERENCES `speakers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `story_speaker_unique` ON `story_speakers` (`story_id`,`speaker_id`);--> statement-breakpoint
CREATE TABLE `themes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`mapbox_style_url` text,
	`mapbox_access_token` text,
	`center_lat` real,
	`center_long` real,
	`sw_boundary_lat` real,
	`sw_boundary_long` real,
	`ne_boundary_lat` real,
	`ne_boundary_long` real,
	`active` integer DEFAULT false NOT NULL,
	`community_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`community_id`) REFERENCES `communities`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text NOT NULL,
	`password_hash` text NOT NULL,
	`first_name` text NOT NULL,
	`last_name` text NOT NULL,
	`role` text DEFAULT 'viewer' NOT NULL,
	`community_id` integer NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`last_login_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`community_id`) REFERENCES `communities`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_community_unique` ON `users` (`email`,`community_id`);