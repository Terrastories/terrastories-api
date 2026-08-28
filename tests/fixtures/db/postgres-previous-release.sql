CREATE TABLE communities (
  id serial PRIMARY KEY,
  name text NOT NULL,
  description text,
  slug text NOT NULL,
  public_stories boolean NOT NULL DEFAULT false,
  locale text NOT NULL DEFAULT 'en',
  cultural_settings text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp NOT NULL,
  updated_at timestamp NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX communities_slug_unique ON communities (slug);
--> statement-breakpoint
CREATE TABLE users (
  id serial PRIMARY KEY,
  email text NOT NULL,
  password_hash text NOT NULL,
  first_name text NOT NULL,
  last_name text NOT NULL,
  role text NOT NULL DEFAULT 'viewer',
  community_id integer NOT NULL REFERENCES communities(id),
  is_active boolean NOT NULL DEFAULT true,
  last_login_at timestamp DEFAULT now(),
  created_at timestamp NOT NULL,
  updated_at timestamp NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX users_email_community_unique ON users (email, community_id);
--> statement-breakpoint
CREATE TABLE places (
  id serial PRIMARY KEY,
  name text NOT NULL,
  description text,
  community_id integer NOT NULL REFERENCES communities(id),
  latitude real NOT NULL,
  longitude real NOT NULL,
  region text,
  media_urls jsonb DEFAULT '[]'::jsonb,
  photo_url text,
  cultural_significance text,
  is_restricted boolean NOT NULL DEFAULT false,
  created_at timestamp NOT NULL,
  updated_at timestamp NOT NULL
);
--> statement-breakpoint
CREATE INDEX places_community_id_idx ON places (community_id);
--> statement-breakpoint
CREATE INDEX places_photo_url_idx ON places (photo_url);
--> statement-breakpoint
CREATE TABLE speakers (
  id serial PRIMARY KEY,
  name text NOT NULL,
  bio text,
  community_id integer NOT NULL REFERENCES communities(id),
  photo_url text,
  bio_audio_url text,
  birth_year integer,
  elder_status boolean NOT NULL DEFAULT false,
  cultural_role text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp NOT NULL,
  updated_at timestamp NOT NULL
);
--> statement-breakpoint
CREATE INDEX speakers_community_id_idx ON speakers (community_id);
--> statement-breakpoint
CREATE INDEX speakers_bio_audio_url_idx ON speakers (bio_audio_url);
--> statement-breakpoint
CREATE INDEX speakers_elder_status_idx ON speakers (elder_status);
--> statement-breakpoint
CREATE INDEX speakers_cultural_role_idx ON speakers (cultural_role);
--> statement-breakpoint
CREATE INDEX speakers_is_active_idx ON speakers (is_active);
--> statement-breakpoint
CREATE TABLE stories (
  id serial PRIMARY KEY,
  title text NOT NULL,
  description text,
  slug text NOT NULL,
  community_id integer NOT NULL REFERENCES communities(id),
  created_by integer NOT NULL,
  is_restricted boolean NOT NULL DEFAULT false,
  privacy_level text NOT NULL DEFAULT 'public',
  media_urls jsonb DEFAULT '[]'::jsonb,
  image_url text,
  audio_url text,
  language text NOT NULL DEFAULT 'en',
  tags jsonb DEFAULT '[]'::jsonb,
  date_interviewed timestamp,
  interview_location_id integer REFERENCES places(id),
  interviewer_id integer REFERENCES speakers(id),
  created_at timestamp NOT NULL,
  updated_at timestamp NOT NULL
);
--> statement-breakpoint
CREATE INDEX stories_community_id_idx ON stories (community_id);
--> statement-breakpoint
CREATE INDEX stories_slug_idx ON stories (slug);
--> statement-breakpoint
CREATE INDEX stories_image_url_idx ON stories (image_url);
--> statement-breakpoint
CREATE INDEX stories_audio_url_idx ON stories (audio_url);
--> statement-breakpoint
CREATE INDEX stories_privacy_level_idx ON stories (privacy_level);
--> statement-breakpoint
CREATE TABLE files (
  id uuid PRIMARY KEY,
  filename text NOT NULL,
  original_name text NOT NULL,
  path text NOT NULL,
  url text NOT NULL,
  mime_type text NOT NULL,
  size bigint NOT NULL,
  community_id integer NOT NULL REFERENCES communities(id),
  uploaded_by integer NOT NULL REFERENCES users(id),
  metadata jsonb,
  cultural_restrictions jsonb,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp NOT NULL,
  updated_at timestamp NOT NULL
);
--> statement-breakpoint
CREATE INDEX files_community_idx ON files (community_id);
--> statement-breakpoint
CREATE INDEX files_user_idx ON files (uploaded_by);
--> statement-breakpoint
CREATE INDEX files_mime_type_idx ON files (mime_type);
--> statement-breakpoint
CREATE INDEX files_active_idx ON files (is_active);
--> statement-breakpoint
CREATE INDEX files_created_at_idx ON files (created_at);
--> statement-breakpoint
CREATE TABLE story_places (
  id serial PRIMARY KEY,
  story_id integer NOT NULL REFERENCES stories(id),
  place_id integer NOT NULL REFERENCES places(id),
  cultural_context text,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamp NOT NULL,
  updated_at timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE story_speakers (
  id serial PRIMARY KEY,
  story_id integer NOT NULL REFERENCES stories(id),
  speaker_id integer NOT NULL REFERENCES speakers(id),
  story_role text,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamp NOT NULL,
  updated_at timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE themes (
  id serial PRIMARY KEY,
  name text NOT NULL,
  description text,
  community_id integer NOT NULL,
  color text,
  created_at timestamp NOT NULL,
  updated_at timestamp NOT NULL
);
