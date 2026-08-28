CREATE TABLE IF NOT EXISTS communities (
  id serial PRIMARY KEY,
  name text NOT NULL,
  description text,
  slug text NOT NULL,
  public_stories boolean NOT NULL DEFAULT false,
  locale text NOT NULL DEFAULT 'en',
  cultural_settings text,
  is_active boolean NOT NULL DEFAULT true,
  country text,
  beta boolean NOT NULL DEFAULT false,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE communities ADD COLUMN IF NOT EXISTS locale text NOT NULL DEFAULT 'en';
--> statement-breakpoint
ALTER TABLE communities ADD COLUMN IF NOT EXISTS cultural_settings text;
--> statement-breakpoint
ALTER TABLE communities ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
--> statement-breakpoint
ALTER TABLE communities ADD COLUMN IF NOT EXISTS country text;
--> statement-breakpoint
ALTER TABLE communities ADD COLUMN IF NOT EXISTS beta boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE communities ALTER COLUMN created_at SET DEFAULT now();
--> statement-breakpoint
ALTER TABLE communities ALTER COLUMN updated_at SET DEFAULT now();
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS communities_slug_unique ON communities (slug);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS users (
  id serial PRIMARY KEY,
  email text NOT NULL,
  password_hash text NOT NULL,
  first_name text NOT NULL,
  last_name text NOT NULL,
  role text NOT NULL DEFAULT 'viewer',
  community_id integer NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  last_login_at timestamp,
  reset_password_token text,
  reset_password_sent_at timestamp,
  remember_created_at timestamp,
  sign_in_count integer NOT NULL DEFAULT 0,
  last_sign_in_at timestamp,
  current_sign_in_ip text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT users_community_id_fkey FOREIGN KEY (community_id) REFERENCES communities(id)
);
--> statement-breakpoint
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_password_token text;
--> statement-breakpoint
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_password_sent_at timestamp;
--> statement-breakpoint
ALTER TABLE users ADD COLUMN IF NOT EXISTS remember_created_at timestamp;
--> statement-breakpoint
ALTER TABLE users ADD COLUMN IF NOT EXISTS sign_in_count integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_sign_in_at timestamp;
--> statement-breakpoint
ALTER TABLE users ADD COLUMN IF NOT EXISTS current_sign_in_ip text;
--> statement-breakpoint
ALTER TABLE users ALTER COLUMN last_login_at DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE users ALTER COLUMN created_at SET DEFAULT now();
--> statement-breakpoint
ALTER TABLE users ALTER COLUMN updated_at SET DEFAULT now();
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS users_email_community_unique ON users (email, community_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_users_reset_password_token ON users (reset_password_token) WHERE reset_password_token IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_users_community_email ON users (community_id, email);
--> statement-breakpoint
DO $users_fk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_community_id_fkey') THEN
    ALTER TABLE users ADD CONSTRAINT users_community_id_fkey FOREIGN KEY (community_id) REFERENCES communities(id);
  END IF;
END $users_fk$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS places (
  id serial PRIMARY KEY,
  name text NOT NULL,
  description text,
  community_id integer NOT NULL,
  latitude real NOT NULL,
  longitude real NOT NULL,
  region text,
  media_urls jsonb DEFAULT '[]'::jsonb,
  photo_url text,
  cultural_significance text,
  is_restricted boolean NOT NULL DEFAULT false,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT places_community_id_fkey FOREIGN KEY (community_id) REFERENCES communities(id)
);
--> statement-breakpoint
ALTER TABLE places ADD COLUMN IF NOT EXISTS media_urls jsonb DEFAULT '[]'::jsonb;
--> statement-breakpoint
ALTER TABLE places ADD COLUMN IF NOT EXISTS photo_url text;
--> statement-breakpoint
ALTER TABLE places ADD COLUMN IF NOT EXISTS cultural_significance text;
--> statement-breakpoint
ALTER TABLE places ADD COLUMN IF NOT EXISTS is_restricted boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE places ALTER COLUMN created_at SET DEFAULT now();
--> statement-breakpoint
ALTER TABLE places ALTER COLUMN updated_at SET DEFAULT now();
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS places_community_id_idx ON places (community_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS places_photo_url_idx ON places (photo_url);
--> statement-breakpoint
DO $places_fk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'places_community_id_fkey') THEN
    ALTER TABLE places ADD CONSTRAINT places_community_id_fkey FOREIGN KEY (community_id) REFERENCES communities(id);
  END IF;
END $places_fk$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS speakers (
  id serial PRIMARY KEY,
  name text NOT NULL,
  bio text,
  community_id integer NOT NULL,
  photo_url text,
  bio_audio_url text,
  birth_year integer,
  elder_status boolean NOT NULL DEFAULT false,
  cultural_role text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT speakers_community_id_fkey FOREIGN KEY (community_id) REFERENCES communities(id)
);
--> statement-breakpoint
ALTER TABLE speakers ADD COLUMN IF NOT EXISTS bio_audio_url text;
--> statement-breakpoint
ALTER TABLE speakers ADD COLUMN IF NOT EXISTS cultural_role text;
--> statement-breakpoint
ALTER TABLE speakers ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
--> statement-breakpoint
ALTER TABLE speakers ALTER COLUMN created_at SET DEFAULT now();
--> statement-breakpoint
ALTER TABLE speakers ALTER COLUMN updated_at SET DEFAULT now();
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS speakers_community_id_idx ON speakers (community_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS speakers_bio_audio_url_idx ON speakers (bio_audio_url);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS speakers_elder_status_idx ON speakers (elder_status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS speakers_cultural_role_idx ON speakers (cultural_role);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS speakers_is_active_idx ON speakers (is_active);
--> statement-breakpoint
DO $speakers_fk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'speakers_community_id_fkey') THEN
    ALTER TABLE speakers ADD CONSTRAINT speakers_community_id_fkey FOREIGN KEY (community_id) REFERENCES communities(id);
  END IF;
END $speakers_fk$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS stories (
  id serial PRIMARY KEY,
  title text NOT NULL,
  description text,
  slug text NOT NULL,
  community_id integer NOT NULL,
  created_by integer NOT NULL,
  is_restricted boolean NOT NULL DEFAULT false,
  privacy_level text NOT NULL DEFAULT 'public',
  media_urls jsonb DEFAULT '[]'::jsonb,
  image_url text,
  audio_url text,
  language text NOT NULL DEFAULT 'en',
  tags jsonb DEFAULT '[]'::jsonb,
  date_interviewed timestamp,
  interview_location_id integer,
  interviewer_id integer,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT stories_community_id_fkey FOREIGN KEY (community_id) REFERENCES communities(id),
  CONSTRAINT stories_interview_location_id_fkey FOREIGN KEY (interview_location_id) REFERENCES places(id),
  CONSTRAINT stories_interviewer_id_fkey FOREIGN KEY (interviewer_id) REFERENCES speakers(id)
);
--> statement-breakpoint
ALTER TABLE stories ADD COLUMN IF NOT EXISTS privacy_level text NOT NULL DEFAULT 'public';
--> statement-breakpoint
ALTER TABLE stories ADD COLUMN IF NOT EXISTS media_urls jsonb DEFAULT '[]'::jsonb;
--> statement-breakpoint
ALTER TABLE stories ADD COLUMN IF NOT EXISTS image_url text;
--> statement-breakpoint
ALTER TABLE stories ADD COLUMN IF NOT EXISTS audio_url text;
--> statement-breakpoint
ALTER TABLE stories ADD COLUMN IF NOT EXISTS language text NOT NULL DEFAULT 'en';
--> statement-breakpoint
ALTER TABLE stories ADD COLUMN IF NOT EXISTS tags jsonb DEFAULT '[]'::jsonb;
--> statement-breakpoint
ALTER TABLE stories ADD COLUMN IF NOT EXISTS date_interviewed timestamp;
--> statement-breakpoint
ALTER TABLE stories ADD COLUMN IF NOT EXISTS interview_location_id integer;
--> statement-breakpoint
ALTER TABLE stories ADD COLUMN IF NOT EXISTS interviewer_id integer;
--> statement-breakpoint
ALTER TABLE stories ALTER COLUMN created_at SET DEFAULT now();
--> statement-breakpoint
ALTER TABLE stories ALTER COLUMN updated_at SET DEFAULT now();
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS stories_community_id_idx ON stories (community_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS stories_slug_idx ON stories (slug);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS stories_image_url_idx ON stories (image_url);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS stories_audio_url_idx ON stories (audio_url);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS stories_privacy_level_idx ON stories (privacy_level);
--> statement-breakpoint
DO $stories_fks$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stories_community_id_fkey') THEN
    ALTER TABLE stories ADD CONSTRAINT stories_community_id_fkey FOREIGN KEY (community_id) REFERENCES communities(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stories_interview_location_id_fkey') THEN
    ALTER TABLE stories ADD CONSTRAINT stories_interview_location_id_fkey FOREIGN KEY (interview_location_id) REFERENCES places(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stories_interviewer_id_fkey') THEN
    ALTER TABLE stories ADD CONSTRAINT stories_interviewer_id_fkey FOREIGN KEY (interviewer_id) REFERENCES speakers(id);
  END IF;
END $stories_fks$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filename text NOT NULL,
  original_name text NOT NULL,
  path text NOT NULL,
  url text NOT NULL,
  mime_type text NOT NULL,
  size bigint NOT NULL,
  community_id integer NOT NULL,
  uploaded_by integer NOT NULL,
  metadata jsonb,
  cultural_restrictions jsonb,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT files_community_id_fkey FOREIGN KEY (community_id) REFERENCES communities(id),
  CONSTRAINT files_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES users(id)
);
--> statement-breakpoint
ALTER TABLE files ALTER COLUMN id SET DEFAULT gen_random_uuid();
--> statement-breakpoint
ALTER TABLE files ALTER COLUMN created_at SET DEFAULT now();
--> statement-breakpoint
ALTER TABLE files ALTER COLUMN updated_at SET DEFAULT now();
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS files_community_idx ON files (community_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS files_user_idx ON files (uploaded_by);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS files_mime_type_idx ON files (mime_type);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS files_active_idx ON files (is_active);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS files_created_at_idx ON files (created_at);
--> statement-breakpoint
DO $files_fks$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'files_community_id_fkey') THEN
    ALTER TABLE files ADD CONSTRAINT files_community_id_fkey FOREIGN KEY (community_id) REFERENCES communities(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'files_uploaded_by_fkey') THEN
    ALTER TABLE files ADD CONSTRAINT files_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES users(id);
  END IF;
END $files_fks$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS story_places (
  id serial PRIMARY KEY,
  story_id integer NOT NULL,
  place_id integer NOT NULL,
  cultural_context text,
  sort_order integer DEFAULT 0,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT story_places_story_id_fkey FOREIGN KEY (story_id) REFERENCES stories(id) ON DELETE CASCADE,
  CONSTRAINT story_places_place_id_fkey FOREIGN KEY (place_id) REFERENCES places(id) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE story_places ADD COLUMN IF NOT EXISTS cultural_context text;
--> statement-breakpoint
ALTER TABLE story_places ADD COLUMN IF NOT EXISTS sort_order integer DEFAULT 0;
--> statement-breakpoint
ALTER TABLE story_places ALTER COLUMN created_at SET DEFAULT now();
--> statement-breakpoint
ALTER TABLE story_places ALTER COLUMN updated_at SET DEFAULT now();
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS story_place_unique ON story_places (story_id, place_id);
--> statement-breakpoint
DO $story_places_fks$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'story_places_story_id_fkey') THEN
    ALTER TABLE story_places ADD CONSTRAINT story_places_story_id_fkey FOREIGN KEY (story_id) REFERENCES stories(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'story_places_place_id_fkey') THEN
    ALTER TABLE story_places ADD CONSTRAINT story_places_place_id_fkey FOREIGN KEY (place_id) REFERENCES places(id) ON DELETE CASCADE;
  END IF;
END $story_places_fks$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS story_speakers (
  id serial PRIMARY KEY,
  story_id integer NOT NULL,
  speaker_id integer NOT NULL,
  story_role text,
  sort_order integer DEFAULT 0,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT story_speakers_story_id_fkey FOREIGN KEY (story_id) REFERENCES stories(id) ON DELETE CASCADE,
  CONSTRAINT story_speakers_speaker_id_fkey FOREIGN KEY (speaker_id) REFERENCES speakers(id) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE story_speakers ADD COLUMN IF NOT EXISTS story_role text;
--> statement-breakpoint
ALTER TABLE story_speakers ADD COLUMN IF NOT EXISTS sort_order integer DEFAULT 0;
--> statement-breakpoint
ALTER TABLE story_speakers ALTER COLUMN created_at SET DEFAULT now();
--> statement-breakpoint
ALTER TABLE story_speakers ALTER COLUMN updated_at SET DEFAULT now();
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS story_speaker_unique ON story_speakers (story_id, speaker_id);
--> statement-breakpoint
DO $story_speakers_fks$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'story_speakers_story_id_fkey') THEN
    ALTER TABLE story_speakers ADD CONSTRAINT story_speakers_story_id_fkey FOREIGN KEY (story_id) REFERENCES stories(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'story_speakers_speaker_id_fkey') THEN
    ALTER TABLE story_speakers ADD CONSTRAINT story_speakers_speaker_id_fkey FOREIGN KEY (speaker_id) REFERENCES speakers(id) ON DELETE CASCADE;
  END IF;
END $story_speakers_fks$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS themes (
  id serial PRIMARY KEY,
  name text NOT NULL,
  description text,
  mapbox_style_url text,
  mapbox_access_token text,
  center_lat numeric(10, 6),
  center_long numeric(10, 6),
  sw_boundary_lat numeric(10, 6),
  sw_boundary_long numeric(10, 6),
  ne_boundary_lat numeric(10, 6),
  ne_boundary_long numeric(10, 6),
  active boolean NOT NULL DEFAULT false,
  community_id bigint NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE themes ALTER COLUMN created_at SET DEFAULT now();
--> statement-breakpoint
ALTER TABLE themes ALTER COLUMN updated_at SET DEFAULT now();
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_themes_community_id ON themes (community_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_themes_active ON themes (active);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_themes_name ON themes (name);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_themes_community_active ON themes (community_id, active);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS attachments (
  id serial PRIMARY KEY,
  attachable_id integer NOT NULL,
  attachable_type text NOT NULL,
  url text NOT NULL,
  filename text NOT NULL,
  content_type text,
  file_size integer,
  created_at timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE attachments ALTER COLUMN created_at SET DEFAULT now();
