CREATE TABLE "sessions" (
  "id" text PRIMARY KEY NOT NULL,
  "token_hash" text NOT NULL,
  "user_id" integer NOT NULL CONSTRAINT "sessions_user_id_users_id_fk" REFERENCES "users" ("id") ON DELETE CASCADE,
  "expires_at" bigint NOT NULL,
  CONSTRAINT "sessions_token_hash_unique" UNIQUE ("token_hash")
);
--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" ("user_id");
--> statement-breakpoint
CREATE TABLE "community_media" (
  "file_id" uuid PRIMARY KEY NOT NULL CONSTRAINT "community_media_file_id_files_id_fk" REFERENCES "files" ("id") ON DELETE CASCADE,
  "community_id" integer NOT NULL CONSTRAINT "community_media_community_id_communities_id_fk" REFERENCES "communities" ("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  CONSTRAINT "community_media_kind_check" CHECK ("kind" = 'branding')
);
--> statement-breakpoint
CREATE FUNCTION revoke_changed_authority_sessions() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'users' THEN
    DELETE FROM sessions WHERE user_id = NEW.id;
  ELSE
    DELETE FROM sessions WHERE user_id IN
      (SELECT id FROM users WHERE community_id = NEW.id);
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER users_revoke_sessions
AFTER UPDATE OF role, community_id, password_hash, is_active ON users
FOR EACH ROW WHEN (OLD.role IS DISTINCT FROM NEW.role
  OR OLD.community_id IS DISTINCT FROM NEW.community_id
  OR OLD.password_hash IS DISTINCT FROM NEW.password_hash
  OR OLD.is_active IS DISTINCT FROM NEW.is_active)
EXECUTE FUNCTION revoke_changed_authority_sessions();
--> statement-breakpoint
CREATE TRIGGER communities_revoke_sessions
AFTER UPDATE OF is_active ON communities
FOR EACH ROW WHEN (OLD.is_active IS DISTINCT FROM NEW.is_active)
EXECUTE FUNCTION revoke_changed_authority_sessions();
