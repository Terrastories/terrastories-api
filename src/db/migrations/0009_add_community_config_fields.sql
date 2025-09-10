-- Add community configuration fields for Rails compatibility
-- Issue #88: Add country and beta fields to communities table

-- Add Rails compatibility fields for community configuration
-- country: ISO 3166-1 alpha-2 country code (optional)
-- beta: Boolean flag for beta/testing communities (default false)
ALTER TABLE communities ADD COLUMN country TEXT;
ALTER TABLE communities ADD COLUMN beta INTEGER DEFAULT 0 NOT NULL;

-- Add indexes for performance optimization on frequently filtered fields
CREATE INDEX IF NOT EXISTS idx_communities_country ON communities(country) WHERE country IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_communities_beta ON communities(beta);

-- Add compound index for deployment queries (beta status by country)
CREATE INDEX IF NOT EXISTS idx_communities_country_beta ON communities(country, beta);