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
