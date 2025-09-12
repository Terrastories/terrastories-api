-- Add database constraint for country code validation
-- PR #93 review feedback: Enforce uppercase country constraint at DB level

-- Add CHECK constraint to ensure country codes are uppercase ISO 3166-1 alpha-2
-- This provides database-level validation and ensures index effectiveness
ALTER TABLE communities ADD CONSTRAINT country_uppercase_iso 
  CHECK (country IS NULL OR (length(country) = 2 AND country = upper(country)));