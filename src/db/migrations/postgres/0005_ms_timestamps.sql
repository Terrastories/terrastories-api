-- Issue #192 phase 1: one timestamp precision on every backend. Narrow every
-- timestamp column from microsecond (default) to millisecond precision so
-- PostgreSQL stores exactly the instants SQLite/D1 stores (Unix milliseconds)
-- and newest-first ordering cannot drift between backends. Narrowing rounds
-- each stored value to the nearest millisecond; whole-second and millisecond
-- rows keep their instants exactly. Defaults are unchanged (the SET DEFAULT
-- statements re-state the existing now() defaults; they alter no value).
ALTER TABLE "attachments" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3);--> statement-breakpoint
ALTER TABLE "attachments" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "communities" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3);--> statement-breakpoint
ALTER TABLE "communities" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "communities" ALTER COLUMN "updated_at" SET DATA TYPE timestamp (3);--> statement-breakpoint
ALTER TABLE "communities" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "files" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3);--> statement-breakpoint
ALTER TABLE "files" ALTER COLUMN "updated_at" SET DATA TYPE timestamp (3);--> statement-breakpoint
ALTER TABLE "places" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3);--> statement-breakpoint
ALTER TABLE "places" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "places" ALTER COLUMN "updated_at" SET DATA TYPE timestamp (3);--> statement-breakpoint
ALTER TABLE "places" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "speakers" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3);--> statement-breakpoint
ALTER TABLE "speakers" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "speakers" ALTER COLUMN "updated_at" SET DATA TYPE timestamp (3);--> statement-breakpoint
ALTER TABLE "speakers" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "stories" ALTER COLUMN "date_interviewed" SET DATA TYPE timestamp (3);--> statement-breakpoint
ALTER TABLE "stories" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3);--> statement-breakpoint
ALTER TABLE "stories" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "stories" ALTER COLUMN "updated_at" SET DATA TYPE timestamp (3);--> statement-breakpoint
ALTER TABLE "stories" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "story_places" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3);--> statement-breakpoint
ALTER TABLE "story_places" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "story_places" ALTER COLUMN "updated_at" SET DATA TYPE timestamp (3);--> statement-breakpoint
ALTER TABLE "story_places" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "story_speakers" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3);--> statement-breakpoint
ALTER TABLE "story_speakers" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "story_speakers" ALTER COLUMN "updated_at" SET DATA TYPE timestamp (3);--> statement-breakpoint
ALTER TABLE "story_speakers" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "themes" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3);--> statement-breakpoint
ALTER TABLE "themes" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "themes" ALTER COLUMN "updated_at" SET DATA TYPE timestamp (3);--> statement-breakpoint
ALTER TABLE "themes" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "last_login_at" SET DATA TYPE timestamp (3);--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "reset_password_sent_at" SET DATA TYPE timestamp (3);--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "remember_created_at" SET DATA TYPE timestamp (3);--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "last_sign_in_at" SET DATA TYPE timestamp (3);--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3);--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "updated_at" SET DATA TYPE timestamp (3);--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "updated_at" SET DEFAULT now();