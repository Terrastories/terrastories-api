-- Add privacy_level column to stories table
ALTER TABLE stories ADD COLUMN privacy_level TEXT NOT NULL DEFAULT 'public';

-- Add check constraint to ensure valid privacy levels
-- ALTER TABLE stories ADD CONSTRAINT privacy_level_check 
-- CHECK (privacy_level IN ('public', 'members_only', 'restricted', 'private', 'elder_only'));