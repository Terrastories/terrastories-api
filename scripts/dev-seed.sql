-- =============================================================================
-- TERRASTORIES DEVELOPMENT SEED DATA
-- Sample data for development and testing purposes only
-- =============================================================================

-- This file provides sample data for development
-- Real data will be created through the application's seeding process

DO $$
BEGIN
    -- Only run if this is a development environment
    IF current_setting('server_version_num')::int >= 100000 THEN
        RAISE NOTICE 'Development seed data can be loaded here';
        RAISE NOTICE 'This will be replaced by application-specific seed data';
    END IF;
END $$;

-- Sample spatial reference systems commonly used for Indigenous territories
-- These will be replaced by the actual migration scripts

-- Create a simple test to verify PostGIS is working
DO $$
DECLARE
    test_point geometry;
BEGIN
    -- Create a test point to verify PostGIS functionality
    test_point := ST_MakePoint(-123.1207, 49.2827);  -- Vancouver, BC coordinates
    
    IF ST_X(test_point) = -123.1207 AND ST_Y(test_point) = 49.2827 THEN
        RAISE NOTICE 'PostGIS geometry functions working correctly';
    ELSE
        RAISE EXCEPTION 'PostGIS geometry functions not working properly';
    END IF;
END $$;