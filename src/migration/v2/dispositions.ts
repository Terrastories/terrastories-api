/**
 * Field disposition registry for the Rails -> V2 Stage-2 transform (PLAN §3).
 *
 * Every column of every pinned Rails table has an entry. A test fails when a
 * pinned column is missing here, so a new Rails column can never be silently
 * dropped. Values are `DISPOSITION` or `DISPOSITION+DISPOSITION` with an
 * optional `>target` describing where the value lands.
 */

export const FIELD_DISPOSITIONS = [
  'PRESERVE',
  'TRANSFORM',
  'DERIVED',
  'ARCHIVE',
  'ARCHIVE_RESTRICTED',
  'IMPROVE',
  'PENDING_MEDIA_SLICE',
] as const;
export type FieldDisposition = (typeof FIELD_DISPOSITIONS)[number];

type TableDispositions = Record<string, string>;

export const COLUMN_DISPOSITIONS: Record<string, TableDispositions> = {
  communities: {
    id: 'PRESERVE>communities.id',
    name: 'PRESERVE>communities.name',
    locale: 'TRANSFORM>communities.locale',
    country: 'PRESERVE>communities.country',
    created_at: 'TRANSFORM>communities.created_at',
    updated_at: 'TRANSFORM>communities.updated_at',
    beta: 'PRESERVE>communities.beta',
    public: 'TRANSFORM>communities.public_stories',
    slug: 'PRESERVE>communities.slug',
    description:
      'TRANSFORM>communities.description,communities.description_plain',
  },
  users: {
    id: 'PRESERVE>users.id',
    email: 'TRANSFORM>users.email,users.email_normalized',
    encrypted_password:
      'TRANSFORM+ARCHIVE_RESTRICTED>users.password_verifier,users.password_algorithm,users.password_salt,users.password_params',
    reset_password_token: 'ARCHIVE_RESTRICTED',
    reset_password_sent_at: 'ARCHIVE',
    remember_created_at: 'ARCHIVE',
    sign_in_count: 'ARCHIVE',
    current_sign_in_at: 'ARCHIVE',
    last_sign_in_at: 'ARCHIVE',
    current_sign_in_ip: 'ARCHIVE_RESTRICTED',
    last_sign_in_ip: 'ARCHIVE_RESTRICTED',
    created_at: 'TRANSFORM>users.created_at',
    updated_at: 'TRANSFORM>users.updated_at',
    role: 'TRANSFORM+ARCHIVE>users.role',
    community_id: 'PRESERVE>users.community_id',
    super_admin: 'TRANSFORM+ARCHIVE>users.role',
    username: 'TRANSFORM>users.username,users.username_normalized',
    name: 'TRANSFORM>users.display_name',
  },
  stories: {
    id: 'PRESERVE>stories.id',
    title: 'TRANSFORM>stories.title',
    desc: 'TRANSFORM>stories.description,stories.description_plain',
    created_at: 'TRANSFORM>stories.created_at',
    updated_at: 'TRANSFORM>stories.updated_at',
    permission_level: 'TRANSFORM>stories.privacy_level',
    date_interviewed: 'TRANSFORM>stories.date_interviewed',
    language: 'TRANSFORM>stories.language',
    interview_location_id: 'PRESERVE>stories.interview_location_id',
    interviewer_id: 'PRESERVE>stories.interviewer_id',
    community_id: 'PRESERVE>stories.community_id',
    topic: 'PRESERVE>stories.topic,stories.topic_normalized',
  },
  places: {
    id: 'PRESERVE>places.id',
    name: 'TRANSFORM>places.name',
    type_of_place: 'PRESERVE>places.type_of_place',
    created_at: 'TRANSFORM>places.created_at',
    updated_at: 'TRANSFORM>places.updated_at',
    lat: 'TRANSFORM>places.latitude',
    long: 'TRANSFORM>places.longitude',
    region: 'PRESERVE>places.region',
    description: 'TRANSFORM>places.description,places.description_plain',
    community_id: 'PRESERVE>places.community_id',
  },
  speakers: {
    id: 'PRESERVE>speakers.id',
    name: 'TRANSFORM>speakers.name',
    created_at: 'TRANSFORM>speakers.created_at',
    updated_at: 'TRANSFORM>speakers.updated_at',
    birthdate: 'TRANSFORM+ARCHIVE>speakers.birth_date',
    birthplace_id: 'PRESERVE>speakers.birthplace_id',
    speaker_community: 'PRESERVE>speakers.affiliation',
    community_id: 'PRESERVE>speakers.community_id',
  },
  places_stories: {
    id: 'PRESERVE>story_places.id',
    story_id: 'PRESERVE>story_places.story_id',
    place_id: 'PRESERVE>story_places.place_id',
  },
  speaker_stories: {
    id: 'PRESERVE>story_speakers.id',
    speaker_id: 'PRESERVE>story_speakers.speaker_id',
    story_id: 'PRESERVE>story_speakers.story_id',
  },
  media_links: {
    id: 'PRESERVE>external_media_links.id',
    url: 'PRESERVE>external_media_links.url',
    story_id: 'PRESERVE>external_media_links.story_id',
    created_at: 'TRANSFORM>external_media_links.created_at',
    updated_at: 'ARCHIVE',
  },
  themes: {
    id: 'ARCHIVE',
    active: 'ARCHIVE',
    created_at: 'TRANSFORM>community_map_configs.created_at',
    updated_at: 'TRANSFORM>community_map_configs.updated_at',
    mapbox_style_url: 'PRESERVE>community_map_configs.style_url',
    mapbox_access_token: 'ARCHIVE_RESTRICTED',
    center_lat: 'TRANSFORM>community_map_configs.center_latitude',
    center_long: 'TRANSFORM>community_map_configs.center_longitude',
    sw_boundary_lat: 'TRANSFORM>community_map_configs.south_west_latitude',
    sw_boundary_long: 'TRANSFORM>community_map_configs.south_west_longitude',
    ne_boundary_lat: 'TRANSFORM>community_map_configs.north_east_latitude',
    ne_boundary_long: 'TRANSFORM>community_map_configs.north_east_longitude',
    zoom: 'TRANSFORM>community_map_configs.zoom',
    pitch: 'TRANSFORM>community_map_configs.pitch',
    bearing: 'TRANSFORM>community_map_configs.bearing',
    mapbox_3d: 'PRESERVE>community_map_configs.three_dimensional',
    map_projection: 'TRANSFORM>community_map_configs.projection',
    community_id: 'PRESERVE>community_map_configs.community_id',
    protomaps_api_key: 'ARCHIVE_RESTRICTED',
    protomaps_basemap_style: 'PRESERVE>community_map_configs.basemap_style',
    expose_mapbox_credentials: 'ARCHIVE',
  },
  curriculums: {
    id: 'ARCHIVE',
    title: 'ARCHIVE',
    description: 'ARCHIVE',
    user_id: 'ARCHIVE',
    created_at: 'ARCHIVE',
    updated_at: 'ARCHIVE',
  },
  curriculum_stories: {
    id: 'ARCHIVE',
    curriculum_id: 'ARCHIVE',
    story_id: 'ARCHIVE',
    created_at: 'ARCHIVE',
    updated_at: 'ARCHIVE',
    display_order: 'ARCHIVE',
  },
  flipper_features: {
    id: 'ARCHIVE',
    key: 'ARCHIVE',
    description: 'ARCHIVE',
    created_at: 'ARCHIVE',
    updated_at: 'ARCHIVE',
  },
  flipper_gates: {
    id: 'ARCHIVE',
    feature_key: 'ARCHIVE',
    key: 'ARCHIVE',
    value: 'ARCHIVE',
    created_at: 'ARCHIVE',
    updated_at: 'ARCHIVE',
  },
  schema_migrations: { version: 'ARCHIVE' },
  ar_internal_metadata: {
    key: 'ARCHIVE',
    value: 'ARCHIVE',
    created_at: 'ARCHIVE',
    updated_at: 'ARCHIVE',
  },
  media: {
    id: 'PENDING_MEDIA_SLICE',
    story_id: 'PENDING_MEDIA_SLICE',
    created_at: 'PENDING_MEDIA_SLICE',
    updated_at: 'PENDING_MEDIA_SLICE',
  },
  active_storage_blobs: {
    id: 'PENDING_MEDIA_SLICE',
    key: 'PENDING_MEDIA_SLICE',
    filename: 'PENDING_MEDIA_SLICE',
    content_type: 'PENDING_MEDIA_SLICE',
    metadata: 'PENDING_MEDIA_SLICE',
    byte_size: 'PENDING_MEDIA_SLICE',
    checksum: 'PENDING_MEDIA_SLICE',
    created_at: 'PENDING_MEDIA_SLICE',
    service_name: 'PENDING_MEDIA_SLICE',
  },
  active_storage_attachments: {
    id: 'PENDING_MEDIA_SLICE',
    name: 'PENDING_MEDIA_SLICE',
    record_type: 'PENDING_MEDIA_SLICE',
    record_id: 'PENDING_MEDIA_SLICE',
    blob_id: 'PENDING_MEDIA_SLICE',
    created_at: 'PENDING_MEDIA_SLICE',
  },
  active_storage_variant_records: {
    id: 'PENDING_MEDIA_SLICE',
    blob_id: 'PENDING_MEDIA_SLICE',
    variation_digest: 'PENDING_MEDIA_SLICE',
  },
};

/** Tables whose rows are never written to the canonical V2 schema. */
export const ARCHIVE_ONLY_TABLES: readonly string[] = [
  'curriculums',
  'curriculum_stories',
  'flipper_features',
  'flipper_gates',
  'schema_migrations',
  'ar_internal_metadata',
];

/** Tables handled by the (next) media slice; recorded as pending only. */
export const PENDING_MEDIA_TABLES: readonly string[] = [
  'media',
  'active_storage_blobs',
  'active_storage_attachments',
  'active_storage_variant_records',
];

/** Flipper keys whose effect is canonical in V2 (SPEC-V2 §2). */
export const KNOWN_FLIPPER_KEYS: readonly string[] = [
  'public_communities',
  'split_settings',
];

/** Rails `Theme.map_projection` enum order (theme.rb). */
export const RAILS_MAP_PROJECTIONS: readonly string[] = [
  'mercator',
  'albers',
  'equalEarth',
  'equirectangular',
  'lambertConformalConic',
  'naturalEarth',
  'winkelTripel',
  'globe',
];

export function parseDisposition(value: string): {
  dispositions: FieldDisposition[];
  target: string | null;
} {
  const [head = '', target] = value.split('>');
  return {
    dispositions: head.split('+') as FieldDisposition[],
    target: target ?? null,
  };
}

/** Columns discovered in `discovered` that have no registry entry. */
export function findUnregisteredColumns(
  discovered: Record<string, readonly string[]>
): string[] {
  const missing: string[] = [];
  for (const [table, columns] of Object.entries(discovered)) {
    const registry = COLUMN_DISPOSITIONS[table];
    if (!registry) continue;
    for (const column of columns) {
      if (!(column in registry)) missing.push(`${table}.${column}`);
    }
  }
  return missing.sort();
}
