-- =============================================================================
-- TERRASTORIES DATABASE INITIALIZATION
-- PostgreSQL database setup with PostGIS extension
-- =============================================================================

-- Create PostGIS extension for geographic data support
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS postgis_topology;

-- Create additional extensions for enhanced functionality
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE EXTENSION IF NOT EXISTS "btree_gist";

-- Set timezone
SET timezone = 'UTC';

-- Create schema for application tables (optional, using public by default)
-- CREATE SCHEMA IF NOT EXISTS terrastories;

-- Grant permissions to the application user
GRANT ALL PRIVILEGES ON DATABASE terrastories TO terrastories;
GRANT ALL ON SCHEMA public TO terrastories;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO terrastories;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO terrastories;

-- Set default privileges for future tables
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO terrastories;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO terrastories;

-- Enable row level security (RLS) for multi-tenancy support
-- This will be configured by the application migration scripts

-- Create a function to update the updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Log initialization completion
DO $$
BEGIN
    RAISE NOTICE 'Terrastories database initialization completed';
    RAISE NOTICE 'PostGIS version: %', PostGIS_version();
    RAISE NOTICE 'PostgreSQL version: %', version();
END $$;