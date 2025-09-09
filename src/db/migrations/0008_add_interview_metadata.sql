-- Add interview metadata fields to stories table
-- Issue #81: Add story interview metadata fields

-- Add interview metadata fields for Indigenous storytelling context
-- Use INTEGER for timestamp (compatible with both PostgreSQL and SQLite)
ALTER TABLE stories ADD COLUMN date_interviewed INTEGER;
ALTER TABLE stories ADD COLUMN interview_location_id INTEGER REFERENCES places(id);
ALTER TABLE stories ADD COLUMN interviewer_id INTEGER REFERENCES speakers(id);

-- Add indexes for performance optimization
-- Frequently queried fields for interview metadata and community scoping
CREATE INDEX IF NOT EXISTS idx_stories_interview_location ON stories(interview_location_id) WHERE interview_location_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_stories_interviewer ON stories(interviewer_id) WHERE interviewer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_stories_date_interviewed ON stories(date_interviewed) WHERE date_interviewed IS NOT NULL;

-- Add compound index for cultural protocol queries (community + interview metadata)
CREATE INDEX IF NOT EXISTS idx_stories_community_interview ON stories(community_id, interview_location_id, interviewer_id);