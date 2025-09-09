-- Add authentication fields to users table
-- Issue #80: Add missing user authentication fields

-- Add authentication fields for password reset and session management
ALTER TABLE users ADD COLUMN reset_password_token TEXT;
ALTER TABLE users ADD COLUMN reset_password_sent_at INTEGER;
ALTER TABLE users ADD COLUMN remember_created_at INTEGER;
ALTER TABLE users ADD COLUMN sign_in_count INTEGER DEFAULT 0 NOT NULL;
ALTER TABLE users ADD COLUMN last_sign_in_at INTEGER;
ALTER TABLE users ADD COLUMN current_sign_in_ip TEXT;

-- Add indexes for performance optimization
-- Frequently queried fields for password reset and authentication
CREATE INDEX IF NOT EXISTS idx_users_reset_password_token ON users(reset_password_token) WHERE reset_password_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_community_email ON users(community_id, email);