-- =============================================================================
-- TERRASTORIES DEVELOPMENT SEED DATA
-- Sample data for development and testing purposes only
-- =============================================================================

-- Development seed data intentionally stays database-portable. Geographic
-- behavior is implemented and tested in the application layer, so a plain
-- PostgreSQL installation must be able to initialize this file.

DO $$
BEGIN
    IF current_setting('server_version_num')::int >= 100000 THEN
        RAISE NOTICE 'Development seed data can be loaded here';
        RAISE NOTICE 'Portable spatial behavior is verified by application-level tests';
    END IF;
END $$;
