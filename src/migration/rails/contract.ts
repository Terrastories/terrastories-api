export const RAILS_SOURCE_PROFILE = 'rails-postgresql' as const;

export const LEGACY_RAILS_COMMIT_2024 =
  'f6f033a17bd4a4c600ffea8bc2e773d243f88f72' as const;
export const LEGACY_RAILS_COMMIT_2025 =
  '3983848d9ba483e8bf14dcb38d9bafda68685870' as const;

export const RAILS_SCHEMA_VERSION_2024 = '2024_04_10_210545' as const;
export const RAILS_SCHEMA_VERSION_2025 = '2025_11_20_170000' as const;

export const RAILS_MIGRATION_VERSION_2024 = '20240410210545' as const;
export const RAILS_MIGRATION_VERSION_2025 = '20251120170000' as const;

/**
 * Required columns from the audited 2024_04_10_210545 Rails schema. Capture
 * discovers and archives all public tables/columns dynamically; this allowlist
 * only makes known schema regressions fail closed.
 */
export const REQUIRED_RAILS_TABLES = {
  active_storage_attachments: [
    'id',
    'name',
    'record_type',
    'record_id',
    'blob_id',
    'created_at',
  ],
  active_storage_blobs: [
    'id',
    'key',
    'filename',
    'content_type',
    'metadata',
    'byte_size',
    'checksum',
    'created_at',
    'service_name',
  ],
  active_storage_variant_records: ['id', 'blob_id', 'variation_digest'],
  communities: [
    'id',
    'name',
    'locale',
    'country',
    'created_at',
    'updated_at',
    'beta',
    'public',
    'slug',
    'description',
  ],
  curriculum_stories: [
    'id',
    'curriculum_id',
    'story_id',
    'created_at',
    'updated_at',
    'display_order',
  ],
  curriculums: [
    'id',
    'title',
    'description',
    'user_id',
    'created_at',
    'updated_at',
  ],
  flipper_features: ['id', 'key', 'description', 'created_at', 'updated_at'],
  flipper_gates: [
    'id',
    'feature_key',
    'key',
    'value',
    'created_at',
    'updated_at',
  ],
  media: ['id', 'story_id', 'created_at', 'updated_at'],
  media_links: ['id', 'url', 'story_id', 'created_at', 'updated_at'],
  places: [
    'id',
    'name',
    'type_of_place',
    'created_at',
    'updated_at',
    'lat',
    'long',
    'region',
    'description',
    'community_id',
  ],
  places_stories: ['id', 'story_id', 'place_id'],
  speaker_stories: ['id', 'speaker_id', 'story_id'],
  speakers: [
    'id',
    'name',
    'created_at',
    'updated_at',
    'birthdate',
    'birthplace_id',
    'speaker_community',
    'community_id',
  ],
  stories: [
    'id',
    'title',
    'desc',
    'created_at',
    'updated_at',
    'permission_level',
    'date_interviewed',
    'language',
    'interview_location_id',
    'interviewer_id',
    'community_id',
    'topic',
  ],
  themes: [
    'id',
    'active',
    'created_at',
    'updated_at',
    'mapbox_style_url',
    'mapbox_access_token',
    'center_lat',
    'center_long',
    'sw_boundary_lat',
    'sw_boundary_long',
    'ne_boundary_lat',
    'ne_boundary_long',
    'zoom',
    'pitch',
    'bearing',
    'mapbox_3d',
    'map_projection',
    'community_id',
    'protomaps_api_key',
    'protomaps_basemap_style',
  ],
  users: [
    'id',
    'email',
    'encrypted_password',
    'reset_password_token',
    'reset_password_sent_at',
    'remember_created_at',
    'sign_in_count',
    'current_sign_in_at',
    'last_sign_in_at',
    'current_sign_in_ip',
    'last_sign_in_ip',
    'created_at',
    'updated_at',
    'role',
    'community_id',
    'super_admin',
    'username',
    'name',
  ],
} as const satisfies Record<string, readonly string[]>;

export const REQUIRED_RAILS_TABLES_2025 = {
  ...REQUIRED_RAILS_TABLES,
  themes: [...REQUIRED_RAILS_TABLES.themes, 'expose_mapbox_credentials'],
} as const satisfies Record<string, readonly string[]>;

export type RequiredRailsTableName = keyof typeof REQUIRED_RAILS_TABLES;

export type RailsContractProfile =
  | 'rails-2024_04_10_210545'
  | 'rails-2025_11_20_170000';

export interface RailsSourceContract {
  readonly profile: RailsContractProfile;
  readonly legacyCommit:
    | typeof LEGACY_RAILS_COMMIT_2024
    | typeof LEGACY_RAILS_COMMIT_2025;
  readonly railsSchemaVersion:
    | typeof RAILS_SCHEMA_VERSION_2024
    | typeof RAILS_SCHEMA_VERSION_2025;
  readonly migrationVersion:
    | typeof RAILS_MIGRATION_VERSION_2024
    | typeof RAILS_MIGRATION_VERSION_2025;
  readonly requiredTables: Readonly<Record<string, readonly string[]>>;
  readonly requiredColumnTypes: Readonly<
    Record<string, Readonly<Record<string, string>>>
  >;
}

export const SUPPORTED_RAILS_SOURCES: readonly RailsSourceContract[] = [
  {
    profile: 'rails-2024_04_10_210545',
    legacyCommit: LEGACY_RAILS_COMMIT_2024,
    railsSchemaVersion: RAILS_SCHEMA_VERSION_2024,
    migrationVersion: RAILS_MIGRATION_VERSION_2024,
    requiredTables: REQUIRED_RAILS_TABLES,
    requiredColumnTypes: {},
  },
  {
    profile: 'rails-2025_11_20_170000',
    legacyCommit: LEGACY_RAILS_COMMIT_2025,
    railsSchemaVersion: RAILS_SCHEMA_VERSION_2025,
    migrationVersion: RAILS_MIGRATION_VERSION_2025,
    requiredTables: REQUIRED_RAILS_TABLES_2025,
    requiredColumnTypes: {
      themes: {
        expose_mapbox_credentials: 'boolean',
      },
    },
  },
];

export function selectRailsSourceContract(
  observedSchemaVersion: string | null
): RailsSourceContract {
  const contract = SUPPORTED_RAILS_SOURCES.find(
    (entry) => entry.migrationVersion === observedSchemaVersion
  );
  if (!contract) {
    const supported = SUPPORTED_RAILS_SOURCES.map(
      (entry) => `${entry.migrationVersion} (${entry.railsSchemaVersion})`
    ).join(', ');
    throw new Error(
      `Unsupported Rails schema_migrations version: ${
        observedSchemaVersion || 'missing'
      }. Supported versions: ${supported}.`
    );
  }
  return contract;
}

export function validateRailsSourceSchema(
  tables: ReadonlyArray<{
    tableName: string;
    columns: ReadonlyArray<{ columnName: string; dataType: string }>;
  }>,
  contract: RailsSourceContract
): void {
  const byName = new Map(tables.map((table) => [table.tableName, table]));

  for (const [tableName, requiredColumns] of Object.entries(
    contract.requiredTables
  )) {
    const table = byName.get(tableName);
    if (!table) {
      throw new Error(`Required Rails table is missing: ${tableName}`);
    }

    const columnsByName = new Map(
      table.columns.map((column) => [column.columnName, column])
    );
    for (const columnName of requiredColumns) {
      if (!columnsByName.has(columnName)) {
        throw new Error(
          `Required Rails column is missing: ${tableName}.${columnName}`
        );
      }
    }

    const expectedTypes = contract.requiredColumnTypes[tableName];
    if (expectedTypes) {
      for (const [columnName, expectedType] of Object.entries(expectedTypes)) {
        const column = columnsByName.get(columnName);
        if (!column || column.dataType !== expectedType) {
          throw new Error(
            `Required Rails column type mismatch for ${tableName}.${columnName}: expected ${expectedType}, got ${
              column?.dataType ?? 'missing'
            }`
          );
        }
      }
    }
  }
}
