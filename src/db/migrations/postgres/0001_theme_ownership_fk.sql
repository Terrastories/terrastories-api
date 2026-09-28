DO $theme_ownership_fk$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.themes'::regclass
      AND conname = 'themes_community_id_communities_id_fk'
  ) THEN
    ALTER TABLE themes
      ADD CONSTRAINT themes_community_id_communities_id_fk
      FOREIGN KEY (community_id) REFERENCES communities(id)
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM themes
    LEFT JOIN communities ON communities.id = themes.community_id
    WHERE communities.id IS NULL
  ) THEN
    ALTER TABLE themes
      VALIDATE CONSTRAINT themes_community_id_communities_id_fk;
  END IF;
END $theme_ownership_fk$;
