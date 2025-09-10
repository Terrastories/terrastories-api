-- Add direct file URL columns for dual-read capability (Issue #89)

-- Add columns to stories table
ALTER TABLE stories ADD COLUMN image_url text;
ALTER TABLE stories ADD COLUMN audio_url text;

-- Add column to places table  
ALTER TABLE places ADD COLUMN photo_url text;

-- Add column to speakers table
ALTER TABLE speakers ADD COLUMN bio_audio_url text;