CREATE TABLE `places` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`location` text,
	`boundary` text,
	`community_id` integer NOT NULL,
	`created_at` text,
	`updated_at` text
);
