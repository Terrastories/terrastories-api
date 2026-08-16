CREATE TABLE communities (
  id serial PRIMARY KEY,
  name text NOT NULL,
  description text,
  slug text NOT NULL,
  public_stories boolean NOT NULL DEFAULT false,
  country text,
  beta boolean NOT NULL DEFAULT false,
  created_at timestamp NOT NULL,
  updated_at timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE users (
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
  created_at timestamp NOT NULL,
  updated_at timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE places (
  id serial PRIMARY KEY,
  name text NOT NULL,
  description text,
  community_id integer NOT NULL,
  latitude real NOT NULL,
  longitude real NOT NULL,
  region text,
  is_restricted boolean NOT NULL DEFAULT false,
  created_at timestamp NOT NULL,
  updated_at timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE speakers (
  id serial PRIMARY KEY,
  name text NOT NULL,
  bio text,
  community_id integer NOT NULL,
  photo_url text,
  birth_year integer,
  elder_status boolean NOT NULL DEFAULT false,
  created_at timestamp NOT NULL,
  updated_at timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE stories (
  id serial PRIMARY KEY,
  title text NOT NULL,
  description text,
  slug text NOT NULL,
  community_id integer NOT NULL,
  created_by integer NOT NULL,
  is_restricted boolean NOT NULL DEFAULT false,
  created_at timestamp NOT NULL,
  updated_at timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE files (
  id uuid PRIMARY KEY,
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
  created_at timestamp NOT NULL,
  updated_at timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE story_places (
  id serial PRIMARY KEY,
  story_id integer NOT NULL,
  place_id integer NOT NULL,
  created_at timestamp NOT NULL,
  updated_at timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE story_speakers (
  id serial PRIMARY KEY,
  story_id integer NOT NULL,
  speaker_id integer NOT NULL,
  created_at timestamp NOT NULL,
  updated_at timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE themes (
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
  created_at timestamp NOT NULL,
  updated_at timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE attachments (
  id serial PRIMARY KEY,
  attachable_id integer NOT NULL,
  attachable_type text NOT NULL,
  url text NOT NULL,
  filename text NOT NULL,
  content_type text,
  file_size integer,
  created_at timestamp NOT NULL
);
