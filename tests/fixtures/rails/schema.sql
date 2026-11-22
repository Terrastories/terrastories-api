BEGIN;

DROP SCHEMA public CASCADE;
CREATE SCHEMA public;

CREATE TABLE schema_migrations (
  version varchar PRIMARY KEY
);

CREATE TABLE ar_internal_metadata (
  key varchar PRIMARY KEY,
  value varchar,
  created_at timestamp without time zone NOT NULL,
  updated_at timestamp without time zone NOT NULL
);

CREATE TABLE active_storage_blobs (
  id bigserial PRIMARY KEY,
  key varchar NOT NULL,
  filename varchar NOT NULL,
  content_type varchar,
  metadata text,
  byte_size bigint NOT NULL,
  checksum varchar,
  created_at timestamp without time zone NOT NULL,
  service_name varchar NOT NULL
);
CREATE UNIQUE INDEX index_active_storage_blobs_on_key ON active_storage_blobs(key);

CREATE TABLE active_storage_attachments (
  id bigserial PRIMARY KEY,
  name varchar NOT NULL,
  record_type varchar NOT NULL,
  record_id bigint NOT NULL,
  blob_id bigint NOT NULL,
  created_at timestamp without time zone NOT NULL
);
CREATE INDEX index_active_storage_attachments_on_blob_id ON active_storage_attachments(blob_id);
CREATE UNIQUE INDEX index_active_storage_attachments_uniqueness
  ON active_storage_attachments(record_type, record_id, name, blob_id);

CREATE TABLE active_storage_variant_records (
  id bigserial PRIMARY KEY,
  blob_id bigint NOT NULL,
  variation_digest varchar NOT NULL
);
CREATE UNIQUE INDEX index_active_storage_variant_records_uniqueness
  ON active_storage_variant_records(blob_id, variation_digest);

CREATE TABLE communities (
  id bigserial PRIMARY KEY,
  name varchar,
  locale varchar,
  country varchar,
  created_at timestamp without time zone NOT NULL,
  updated_at timestamp without time zone NOT NULL,
  beta boolean DEFAULT false,
  public boolean DEFAULT false NOT NULL,
  slug varchar,
  description text
);
CREATE INDEX index_communities_on_public ON communities(public);
CREATE INDEX index_communities_on_slug ON communities(slug);

CREATE TABLE curriculums (
  id bigserial PRIMARY KEY,
  title varchar,
  description text,
  user_id bigint NOT NULL,
  created_at timestamp without time zone NOT NULL,
  updated_at timestamp without time zone NOT NULL
);
CREATE INDEX index_curriculums_on_user_id ON curriculums(user_id);

CREATE TABLE curriculum_stories (
  id bigserial PRIMARY KEY,
  curriculum_id bigint NOT NULL,
  story_id bigint NOT NULL,
  created_at timestamp without time zone NOT NULL,
  updated_at timestamp without time zone NOT NULL,
  display_order integer
);
CREATE INDEX index_curriculum_stories_on_curriculum_id ON curriculum_stories(curriculum_id);
CREATE INDEX index_curriculum_stories_on_story_id ON curriculum_stories(story_id);

CREATE TABLE flipper_features (
  id bigserial PRIMARY KEY,
  key varchar NOT NULL,
  description text,
  created_at timestamp(6) without time zone NOT NULL,
  updated_at timestamp(6) without time zone NOT NULL
);
CREATE UNIQUE INDEX index_flipper_features_on_key ON flipper_features(key);

CREATE TABLE flipper_gates (
  id bigserial PRIMARY KEY,
  feature_key varchar NOT NULL,
  key varchar NOT NULL,
  value varchar,
  created_at timestamp(6) without time zone NOT NULL,
  updated_at timestamp(6) without time zone NOT NULL
);
CREATE UNIQUE INDEX index_flipper_gates_on_feature_key_and_key_and_value
  ON flipper_gates(feature_key, key, value);

CREATE TABLE media (
  id bigserial PRIMARY KEY,
  story_id bigint,
  created_at timestamp(6) without time zone NOT NULL,
  updated_at timestamp(6) without time zone NOT NULL
);
CREATE INDEX index_media_on_story_id ON media(story_id);

CREATE TABLE media_links (
  id bigserial PRIMARY KEY,
  url varchar,
  story_id bigint,
  created_at timestamp without time zone NOT NULL,
  updated_at timestamp without time zone NOT NULL
);
CREATE INDEX index_media_links_on_story_id ON media_links(story_id);

CREATE TABLE places (
  id bigserial PRIMARY KEY,
  name varchar,
  type_of_place varchar,
  created_at timestamp without time zone NOT NULL,
  updated_at timestamp without time zone NOT NULL,
  lat numeric(10,6),
  long numeric(10,6),
  region varchar,
  description varchar,
  community_id integer
);

CREATE TABLE places_stories (
  id bigserial PRIMARY KEY,
  story_id bigint NOT NULL,
  place_id bigint NOT NULL
);
CREATE INDEX index_places_stories_on_story_id_and_place_id ON places_stories(story_id, place_id);

CREATE TABLE speaker_stories (
  id bigserial PRIMARY KEY,
  speaker_id bigint NOT NULL,
  story_id bigint NOT NULL
);

CREATE TABLE speakers (
  id bigserial PRIMARY KEY,
  name varchar,
  created_at timestamp without time zone NOT NULL,
  updated_at timestamp without time zone NOT NULL,
  birthdate timestamp without time zone,
  birthplace_id integer,
  speaker_community varchar,
  community_id integer
);
CREATE INDEX index_speakers_on_birthplace_id ON speakers(birthplace_id);

CREATE TABLE stories (
  id bigserial PRIMARY KEY,
  title varchar,
  "desc" text,
  created_at timestamp without time zone NOT NULL,
  updated_at timestamp without time zone NOT NULL,
  permission_level integer,
  date_interviewed timestamp without time zone,
  language varchar,
  interview_location_id integer,
  interviewer_id integer,
  community_id integer,
  topic varchar
);

CREATE TABLE themes (
  id bigserial PRIMARY KEY,
  active boolean DEFAULT false NOT NULL,
  created_at timestamp without time zone NOT NULL,
  updated_at timestamp without time zone NOT NULL,
  mapbox_style_url varchar,
  mapbox_access_token varchar,
  center_lat numeric(10,6),
  center_long numeric(10,6),
  sw_boundary_lat numeric(10,6),
  sw_boundary_long numeric(10,6),
  ne_boundary_lat numeric(10,6),
  ne_boundary_long numeric(10,6),
  zoom numeric(10,6),
  pitch numeric(10,6),
  bearing numeric(10,6),
  mapbox_3d boolean DEFAULT false,
  map_projection integer DEFAULT 0,
  community_id bigint NOT NULL,
  protomaps_api_key text,
  protomaps_basemap_style text
);

CREATE TABLE users (
  id bigserial PRIMARY KEY,
  email varchar,
  encrypted_password varchar DEFAULT '' NOT NULL,
  reset_password_token varchar,
  reset_password_sent_at timestamp without time zone,
  remember_created_at timestamp without time zone,
  sign_in_count integer DEFAULT 0 NOT NULL,
  current_sign_in_at timestamp without time zone,
  last_sign_in_at timestamp without time zone,
  current_sign_in_ip varchar,
  last_sign_in_ip varchar,
  created_at timestamp without time zone NOT NULL,
  updated_at timestamp without time zone NOT NULL,
  role integer,
  community_id integer,
  super_admin boolean DEFAULT false NOT NULL,
  username varchar DEFAULT '' NOT NULL,
  name varchar
);
CREATE INDEX index_users_on_email ON users(email);
CREATE UNIQUE INDEX index_users_on_reset_password_token ON users(reset_password_token);
CREATE UNIQUE INDEX index_users_on_username ON users(username);

ALTER TABLE active_storage_attachments
  ADD CONSTRAINT fk_active_storage_attachments_blob
  FOREIGN KEY (blob_id) REFERENCES active_storage_blobs(id);
ALTER TABLE active_storage_variant_records
  ADD CONSTRAINT fk_active_storage_variant_blob
  FOREIGN KEY (blob_id) REFERENCES active_storage_blobs(id);
ALTER TABLE curriculum_stories
  ADD CONSTRAINT fk_curriculum_stories_curriculum
  FOREIGN KEY (curriculum_id) REFERENCES curriculums(id);
ALTER TABLE curriculum_stories
  ADD CONSTRAINT fk_curriculum_stories_story
  FOREIGN KEY (story_id) REFERENCES stories(id);
ALTER TABLE curriculums
  ADD CONSTRAINT fk_curriculums_user
  FOREIGN KEY (user_id) REFERENCES users(id);

COMMIT;
