-- =============================================================================
-- TERRASTORIES DATABASE INITIALIZATION
-- Plain PostgreSQL setup. V2 spatial behavior is application-level and requires
-- no database-specific spatial extension.
-- =============================================================================

SET timezone = 'UTC';

GRANT ALL PRIVILEGES ON DATABASE terrastories TO terrastories;
GRANT ALL ON SCHEMA public TO terrastories;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO terrastories;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO terrastories;

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO terrastories;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO terrastories;

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

DO $$
BEGIN
    RAISE NOTICE 'Terrastories database initialization completed';
    RAISE NOTICE 'PostgreSQL version: %', version();
END $$;
