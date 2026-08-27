DO $theme_ownership_fk$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'themes_community_id_fkey'
  ) THEN
    ALTER TABLE themes
      ADD CONSTRAINT themes_community_id_fkey
      FOREIGN KEY (community_id) REFERENCES communities(id);
  END IF;
END $theme_ownership_fk$;
