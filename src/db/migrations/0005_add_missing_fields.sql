ALTER TABLE users ADD COLUMN last_login_at INTEGER;--> statement-breakpoint
ALTER TABLE stories ADD COLUMN privacy_level TEXT NOT NULL DEFAULT 'public';--> statement-breakpoint
ALTER TABLE stories ADD COLUMN slug TEXT;--> statement-breakpoint
ALTER TABLE users ADD COLUMN reset_password_token TEXT;--> statement-breakpoint
ALTER TABLE users ADD COLUMN reset_password_sent_at INTEGER;--> statement-breakpoint
ALTER TABLE users ADD COLUMN remember_created_at INTEGER;--> statement-breakpoint
ALTER TABLE users ADD COLUMN sign_in_count INTEGER DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE users ADD COLUMN last_sign_in_at INTEGER;--> statement-breakpoint
ALTER TABLE users ADD COLUMN current_sign_in_ip TEXT;--> statement-breakpoint
ALTER TABLE stories ADD COLUMN date_interviewed INTEGER;--> statement-breakpoint
ALTER TABLE stories ADD COLUMN interview_location_id INTEGER REFERENCES places(id);--> statement-breakpoint
ALTER TABLE stories ADD COLUMN interviewer_id INTEGER REFERENCES speakers(id);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_users_reset_password_token ON users(reset_password_token) WHERE reset_password_token IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_users_community_email ON users(community_id, email);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_stories_slug ON stories(slug) WHERE slug IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_stories_privacy_level ON stories(privacy_level);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_stories_interview_location ON stories(interview_location_id) WHERE interview_location_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_stories_interviewer ON stories(interviewer_id) WHERE interviewer_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_stories_date_interviewed ON stories(date_interviewed) WHERE date_interviewed IS NOT NULL;