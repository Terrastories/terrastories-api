// Generates a synthetic Terrastories community as SQLite SQL, shaped like the Rails
// source schema (rails/db/schema.rb tables that carry community data).
// Usage: node scripts/make-dataset.mjs <profile> <out.sql>   profile: medium | large
// Row counts are an assumption, stated in docs/spikes/WORKERS-FREE-2026-11.md.
import { writeFileSync } from 'node:fs';

const PROFILES = {
  medium: {
    users: 15,
    speakers: 80,
    places: 200,
    stories: 400,
    media: 500,
    links: 100,
  },
  large: {
    users: 50,
    speakers: 300,
    places: 800,
    stories: 2000,
    media: 2500,
    links: 500,
  },
};
const [profile = 'large', outFile = 'dataset.sql'] = process.argv.slice(2);
const p = PROFILES[profile];
if (!p) throw new Error(`unknown profile ${profile}`);

let seed = 42;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const words =
  'river forest elder story map village water song memory path stone fire'.split(
    ' '
  );
const text = (n) =>
  Array.from({ length: n }, () => words[Math.floor(rnd() * words.length)]).join(
    ' '
  );
const s = (v) => `'${String(v).replaceAll("'", "''")}'`;
const now = s('2024-01-01 00:00:00');

const ddl = `
CREATE TABLE communities (id INTEGER PRIMARY KEY, name TEXT, locale TEXT, country TEXT, slug TEXT UNIQUE, description TEXT, public INTEGER, beta INTEGER, created_at TEXT, updated_at TEXT);
CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT UNIQUE, username TEXT UNIQUE, name TEXT, encrypted_password TEXT, role INTEGER, super_admin INTEGER, community_id INTEGER REFERENCES communities(id), sign_in_count INTEGER, created_at TEXT, updated_at TEXT);
CREATE TABLE speakers (id INTEGER PRIMARY KEY, name TEXT, birthdate TEXT, birthplace_id INTEGER, speaker_community TEXT, community_id INTEGER REFERENCES communities(id), created_at TEXT, updated_at TEXT);
CREATE TABLE places (id INTEGER PRIMARY KEY, name TEXT, type_of_place TEXT, lat REAL, long REAL, region TEXT, description TEXT, community_id INTEGER REFERENCES communities(id), created_at TEXT, updated_at TEXT);
CREATE TABLE stories (id INTEGER PRIMARY KEY, title TEXT, "desc" TEXT, permission_level INTEGER, date_interviewed TEXT, language TEXT, topic TEXT, interview_location_id INTEGER, interviewer_id INTEGER, community_id INTEGER REFERENCES communities(id), created_at TEXT, updated_at TEXT);
CREATE TABLE places_stories (story_id INTEGER, place_id INTEGER);
CREATE TABLE speaker_stories (speaker_id INTEGER, story_id INTEGER);
CREATE TABLE media (id INTEGER PRIMARY KEY, story_id INTEGER, created_at TEXT, updated_at TEXT);
CREATE TABLE media_links (id INTEGER PRIMARY KEY, url TEXT, story_id INTEGER, created_at TEXT, updated_at TEXT);
CREATE TABLE active_storage_blobs (id INTEGER PRIMARY KEY, key TEXT UNIQUE, filename TEXT, content_type TEXT, metadata TEXT, byte_size INTEGER, checksum TEXT, service_name TEXT, created_at TEXT);
CREATE TABLE active_storage_attachments (id INTEGER PRIMARY KEY, name TEXT, record_type TEXT, record_id INTEGER, blob_id INTEGER, created_at TEXT);
CREATE TABLE themes (id INTEGER PRIMARY KEY, active INTEGER, community_id INTEGER, center_lat REAL, center_long REAL, zoom REAL, created_at TEXT, updated_at TEXT);
CREATE INDEX idx_stories_community ON stories(community_id);
CREATE INDEX idx_places_community ON places(community_id);
CREATE INDEX idx_speakers_community ON speakers(community_id);
CREATE INDEX idx_places_stories ON places_stories(story_id, place_id);
CREATE INDEX idx_speaker_stories ON speaker_stories(speaker_id, story_id);
CREATE INDEX idx_att_record ON active_storage_attachments(record_type, record_id);
`;

const rows = { communities: 1, themes: 1 };
const lines = [ddl];
const insert = (table, cols, values) => {
  // 50 rows per INSERT keeps every statement far below D1's 100 KB statement limit.
  for (let i = 0; i < values.length; i += 50) {
    const chunk = values.slice(i, i + 50).map((v) => `(${v.join(',')})`);
    lines.push(`INSERT INTO ${table} (${cols}) VALUES ${chunk.join(',')};`);
  }
  rows[table] = values.length;
};

lines.push(
  `INSERT INTO communities VALUES (1,'Spike Community','en','BR','spike',${s(text(40))},0,0,${now},${now});`,
  `INSERT INTO themes VALUES (1,1,1,-3.1,-60.0,6,${now},${now});`
);
const bcryptLike = '$2a$12$' + 'x'.repeat(53);
const range = (n) => Array.from({ length: n }, (_, i) => i + 1);
insert(
  'users',
  'id,email,username,name,encrypted_password,role,super_admin,community_id,sign_in_count,created_at,updated_at',
  range(p.users).map((i) => [
    i,
    s(`u${i}@example.org`),
    s(`user${i}`),
    s(text(2)),
    s(bcryptLike),
    i % 4,
    0,
    1,
    i,
    now,
    now,
  ])
);
insert(
  'speakers',
  'id,name,birthdate,birthplace_id,speaker_community,community_id,created_at,updated_at',
  range(p.speakers).map((i) => [
    i,
    s(text(2)),
    s('1950-01-01'),
    (i % p.places) + 1,
    s(text(1)),
    1,
    now,
    now,
  ])
);
insert(
  'places',
  'id,name,type_of_place,lat,long,region,description,community_id,created_at,updated_at',
  range(p.places).map((i) => [
    i,
    s(text(2)),
    s('village'),
    -3 - rnd(),
    -60 - rnd(),
    s(text(1)),
    s(text(60)),
    1,
    now,
    now,
  ])
);
insert(
  'stories',
  'id,title,"desc",permission_level,date_interviewed,language,topic,interview_location_id,interviewer_id,community_id,created_at,updated_at',
  // ~1.5 KB description per story.
  range(p.stories).map((i) => [
    i,
    s(text(6)),
    s(text(250)),
    i % 3,
    s('2019-05-01'),
    s('pt'),
    s(text(1)),
    (i % p.places) + 1,
    (i % p.speakers) + 1,
    1,
    now,
    now,
  ])
);
const pairs = (n, a, b) =>
  range(n).map((i) => [(i % a) + 1, (Math.floor(i / a) % b) + 1]);
insert(
  'places_stories',
  'story_id,place_id',
  pairs(Math.round(p.stories * 1.5), p.stories, p.places)
);
insert(
  'speaker_stories',
  'speaker_id,story_id',
  pairs(Math.round(p.stories * 1.25), p.speakers, p.stories)
);
insert(
  'media',
  'id,story_id,created_at,updated_at',
  range(p.media).map((i) => [i, (i % p.stories) + 1, now, now])
);
insert(
  'media_links',
  'id,url,story_id,created_at,updated_at',
  range(p.links).map((i) => [
    i,
    s(`https://example.org/v/${i}`),
    (i % p.stories) + 1,
    now,
    now,
  ])
);
insert(
  'active_storage_blobs',
  'id,key,filename,content_type,metadata,byte_size,checksum,service_name,created_at',
  range(p.media).map((i) => [
    i,
    s(`k${i}`),
    s(`f${i}.mp4`),
    s('video/mp4'),
    s('{"identified":true}'),
    50_000_000,
    s('abc=='),
    s('local'),
    now,
  ])
);
insert(
  'active_storage_attachments',
  'id,name,record_type,record_id,blob_id,created_at',
  range(p.media).map((i) => [i, s('media'), s('Media'), i, i, now])
);

writeFileSync(outFile, lines.join('\n') + '\n');
const total = Object.values(rows).reduce((a, b) => a + b, 0);
console.log(
  JSON.stringify(
    { profile, rows, totalRows: total, statements: lines.length - 1 },
    null,
    2
  )
);
