BEGIN;

ALTER TABLE themes
  ADD COLUMN expose_mapbox_credentials boolean DEFAULT false NOT NULL;

INSERT INTO schema_migrations(version) VALUES ('20251120170000');

COMMIT;
