import { and, eq, exists, isNull, ne, notExists, or, sql } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import type { Database } from '../db/index.js';
import { dialectOf, tablesFor } from '../db/dialect.js';
import {
  communityFromPhysical,
  communityVisibilityToPhysical,
  type CommunityVisibility,
} from '../policy/canonical-state.js';
import type { PublicMapConfigRow } from './public-communities.repository.js';
import { validateContentFreeAuditEntry } from '../shared/utils/audit-entry.js';
import { buildAuditEntryInsert } from './audit-entry.repository.js';
import {
  buildOwnerUnreferencedFilesDelete,
  buildUnreferencedFilesDelete,
  lockFileRowsForCleanup,
  toFileByteCleanups,
  type FileByteCleanup,
} from '../services/media-cleanup.service.js';

export interface CommunitySettingsUpdateInput {
  name?: string;
  description?: string | null;
  descriptionPlain?: string | null;
  locale?: string;
  country?: string | null;
  visibility?: CommunityVisibility;
}

export interface MapConfigUpsertInput {
  styleUrl: string | null;
  basemapStyle: string | null;
  /**
   * Provider fields (Mapbox/Protomaps): `undefined` keeps the stored value
   * atomically (omitted from the conflict SET); `null`/value overwrites.
   * `exposeMapboxCredentials: true` is coerced to false in SQL when the
   * community is private. A merged style/token pair mismatch makes the
   * conflict update a no-op (returns null).
   */
  mapboxStyleUrl?: string | null;
  mapboxAccessToken?: string | null;
  exposeMapboxCredentials?: boolean;
  mapbox3d?: boolean;
  protomapsApiKey?: string | null;
  protomapsBasemapStyle?: string | null;
  centerLatitude: number | null;
  centerLongitude: number | null;
  southWestLatitude: number | null;
  southWestLongitude: number | null;
  northEastLatitude: number | null;
  northEastLongitude: number | null;
  zoom: number | null;
  pitch: number | null;
  bearing: number | null;
  threeDimensional: boolean | null;
  projection: string | null;
  staticMapFileId: string | null;
}

function buildVisibilityAuditEntry(
  communityId: number,
  actorId: number,
  nextVisibility: CommunityVisibility
) {
  return validateContentFreeAuditEntry({
    communityId,
    actorId,
    action:
      nextVisibility === 'public'
        ? 'community.visibility.public'
        : 'community.visibility.private',
    resourceType: 'community',
    resourceIds: [communityId],
    outcome: 'success',
    ipAddress: null,
    userAgent: null,
  });
}

export interface PlaceCreateInput {
  name: string;
  description: string | null;
  descriptionPlain: string | null;
  typeOfPlace: string | null;
  region: string | null;
  latitude: number | null;
  longitude: number | null;
}

export interface PlaceUpdateInput {
  name?: string;
  description?: string | null;
  descriptionPlain?: string | null;
  typeOfPlace?: string | null;
  region?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}

export type PlaceDeleteOutcome = 'deleted' | 'not_found' | 'conflict';

export interface SpeakerCreateInput {
  name: string;
  birthDate: string | null;
  birthplaceId: number | null;
  affiliation: string | null;
}

export interface SpeakerUpdateInput {
  name?: string;
  birthDate?: string | null;
  birthplaceId?: number | null;
  affiliation?: string | null;
}

export type SpeakerDeleteOutcome = 'deleted' | 'not_found' | 'conflict';

export function isNotNullConstraintError(
  err: unknown,
  seen: Set<unknown> = new Set()
): boolean {
  if (!err || typeof err !== 'object' || seen.has(err)) return false;
  seen.add(err);
  const { code, message, cause } = err as {
    code?: unknown;
    message?: unknown;
    cause?: unknown;
  };
  if (code === '23502' || code === 'SQLITE_CONSTRAINT_NOTNULL') {
    return true;
  }
  if (
    typeof message === 'string' &&
    message.includes('NOT NULL constraint failed')
  ) {
    return true;
  }
  return cause ? isNotNullConstraintError(cause, seen) : false;
}

export function isForeignKeyConstraintError(
  err: unknown,
  seen: Set<unknown> = new Set()
): boolean {
  if (!err || typeof err !== 'object' || seen.has(err)) return false;
  seen.add(err);
  const { code, message, cause } = err as {
    code?: unknown;
    message?: unknown;
    cause?: unknown;
  };
  if (code === '23503' || code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
    return true;
  }
  if (
    typeof message === 'string' &&
    message.includes('FOREIGN KEY constraint failed')
  ) {
    return true;
  }
  return cause ? isForeignKeyConstraintError(cause, seen) : false;
}

export class CommunityWritesRepository {
  // Drizzle PG / better-sqlite3 / D1 share runtime methods with union-incompatible TS overloads.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: any;
  private readonly tables;

  constructor(readonly connection: Database | DrizzleD1Database) {
    this.db = connection;
    this.tables = tablesFor(connection);
  }

  private hasD1Batch(): boolean {
    return typeof this.db.batch === 'function';
  }

  async activeCommunityExists(communityId: number): Promise<boolean> {
    const rows = await this.db
      .select({ id: this.tables.communities.id })
      .from(this.tables.communities)
      .where(
        and(
          eq(this.tables.communities.id, communityId),
          eq(this.tables.communities.isActive, true)
        )
      )
      .limit(1);
    return rows.length > 0;
  }

  async updateCommunitySettings(
    communityId: number,
    actorId: number,
    input: CommunitySettingsUpdateInput,
    now: Date = new Date()
  ): Promise<{ updated: boolean }> {
    const buildSetPayload = () => {
      const values: Record<string, unknown> = {
        updatedAt: now,
      };
      if (input.name !== undefined) {
        values.name = input.name;
      }
      if (input.description !== undefined) {
        values.description = input.description;
        values.descriptionPlain = input.descriptionPlain ?? null;
      }
      if (input.locale !== undefined) {
        values.locale = input.locale;
      }
      if (input.country !== undefined) {
        values.country = input.country;
      }
      if (input.visibility !== undefined) {
        values.publicStories = communityVisibilityToPhysical(input.visibility);
      }
      return values;
    };

    const buildConditionalAuditInsert = (
      executor: typeof this.db,
      nextVisibility: CommunityVisibility
    ) => {
      const audit = buildVisibilityAuditEntry(
        communityId,
        actorId,
        nextVisibility
      );
      const nextPublicStories = communityVisibilityToPhysical(nextVisibility);
      return executor.insert(this.tables.auditEntries).select(
        executor
          .select({
            id: sql`NULL`.as('id'),
            communityId: this.tables.communities.id,
            actorId: sql`${audit.actorId}`.as('actor_id'),
            action: sql`${audit.action}`.as('action'),
            resourceType: sql`${audit.resourceType}`.as('resource_type'),
            resourceIds: sql`${JSON.stringify(audit.resourceIds)}`.as(
              'resource_ids'
            ),
            outcome: sql`${audit.outcome}`.as('outcome'),
            ipAddress: sql`NULL`.as('ip_address'),
            userAgent: sql`NULL`.as('user_agent'),
            createdAt: sql`${now.getTime()}`.as('created_at'),
          })
          .from(this.tables.communities)
          .where(
            and(
              eq(this.tables.communities.id, communityId),
              eq(this.tables.communities.isActive, true),
              ne(this.tables.communities.publicStories, nextPublicStories)
            )
          )
      );
    };

    const buildResetExposeMapboxQuery = (executor: typeof this.db) =>
      executor
        .update(this.tables.communityMapConfigs)
        .set({
          exposeMapboxCredentials: false,
          updatedAt: now,
        })
        .where(
          and(
            eq(this.tables.communityMapConfigs.communityId, communityId),
            eq(this.tables.communityMapConfigs.exposeMapboxCredentials, true),
            exists(
              executor
                .select({ one: sql`1` })
                .from(this.tables.communities)
                .where(
                  and(
                    eq(this.tables.communities.id, communityId),
                    eq(this.tables.communities.isActive, true)
                  )
                )
            )
          )
        );

    if (this.hasD1Batch()) {
      const updateQuery = this.db
        .update(this.tables.communities)
        .set(buildSetPayload())
        .where(
          and(
            eq(this.tables.communities.id, communityId),
            eq(this.tables.communities.isActive, true)
          )
        )
        .returning({ id: this.tables.communities.id });

      if (input.visibility !== undefined) {
        // Insert the audit entry BEFORE the update changes public_stories,
        // guarded in SQL on active + effective visibility transition so D1's
        // single atomic batch never emits a stale, duplicate, or 0-row audit.
        // Making a community private also resets expose_mapbox_credentials
        // inside the same atomic batch.
        const auditQuery = buildConditionalAuditInsert(
          this.db,
          input.visibility
        );
        const batchStatements =
          input.visibility === 'private'
            ? [auditQuery, updateQuery, buildResetExposeMapboxQuery(this.db)]
            : [auditQuery, updateQuery];
        const [, updatedRows] = await this.db.batch(batchStatements);
        return {
          updated: Array.isArray(updatedRows) && updatedRows.length > 0,
        };
      }

      const [updatedRows] = await this.db.batch([updateQuery]);
      return { updated: Array.isArray(updatedRows) && updatedRows.length > 0 };
    }

    if (dialectOf(this.connection) === 'postgresql') {
      return this.db.transaction(async (tx: typeof this.db) => {
        const existingRows = await tx
          .select({
            id: this.tables.communities.id,
            publicStories: this.tables.communities.publicStories,
            isActive: this.tables.communities.isActive,
          })
          .from(this.tables.communities)
          .where(
            and(
              eq(this.tables.communities.id, communityId),
              eq(this.tables.communities.isActive, true)
            )
          )
          .limit(1)
          .for('update');
        const existing = existingRows[0];
        if (!existing) {
          return { updated: false };
        }

        const previousVisibility = communityFromPhysical(existing).visibility;
        const nextVisibility = input.visibility ?? previousVisibility;

        const updatedRows = await tx
          .update(this.tables.communities)
          .set(buildSetPayload())
          .where(
            and(
              eq(this.tables.communities.id, communityId),
              eq(this.tables.communities.isActive, true)
            )
          )
          .returning({ id: this.tables.communities.id });

        if (updatedRows.length === 0) {
          return { updated: false };
        }

        if (input.visibility === 'private') {
          await tx
            .update(this.tables.communityMapConfigs)
            .set({
              exposeMapboxCredentials: false,
              updatedAt: now,
            })
            .where(
              and(
                eq(this.tables.communityMapConfigs.communityId, communityId),
                eq(
                  this.tables.communityMapConfigs.exposeMapboxCredentials,
                  true
                )
              )
            );
        }

        if (nextVisibility !== previousVisibility) {
          const audit = buildVisibilityAuditEntry(
            communityId,
            actorId,
            nextVisibility
          );
          await tx.insert(this.tables.auditEntries).values({
            ...audit,
            createdAt: now,
          });
        }

        return { updated: true };
      });
    }

    // better-sqlite3 transactions are synchronous
    return this.db.transaction((tx: typeof this.db) => {
      if (input.visibility !== undefined) {
        buildConditionalAuditInsert(tx, input.visibility).run();
      }

      const updated = tx
        .update(this.tables.communities)
        .set(buildSetPayload())
        .where(
          and(
            eq(this.tables.communities.id, communityId),
            eq(this.tables.communities.isActive, true)
          )
        )
        .returning({ id: this.tables.communities.id })
        .all();

      if (updated.length > 0 && input.visibility === 'private') {
        tx.update(this.tables.communityMapConfigs)
          .set({
            exposeMapboxCredentials: false,
            updatedAt: now,
          })
          .where(
            and(
              eq(this.tables.communityMapConfigs.communityId, communityId),
              eq(this.tables.communityMapConfigs.exposeMapboxCredentials, true)
            )
          )
          .run();
      }

      return { updated: updated.length > 0 };
    });
  }

  async findCommunityFile(
    communityId: number,
    fileId: string
  ): Promise<{ id: string } | null> {
    const rows = await this.db
      .select({ id: this.tables.files.id })
      .from(this.tables.files)
      .where(
        and(
          eq(this.tables.files.id, fileId),
          eq(this.tables.files.communityId, communityId),
          eq(this.tables.files.isActive, true),
          isNull(this.tables.files.culturalRestrictions)
        )
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** Stored Mapbox/Protomaps fields, used to preserve omitted keys on PUT. */
  async findCommunityMapConfigProviderFields(communityId: number): Promise<{
    mapboxStyleUrl: string | null;
    mapboxAccessToken: string | null;
    exposeMapboxCredentials: boolean;
    mapbox3d: boolean;
    protomapsApiKey: string | null;
    protomapsBasemapStyle: string | null;
  } | null> {
    const rows = await this.db
      .select({
        mapboxStyleUrl: this.tables.communityMapConfigs.mapboxStyleUrl,
        mapboxAccessToken: this.tables.communityMapConfigs.mapboxAccessToken,
        exposeMapboxCredentials:
          this.tables.communityMapConfigs.exposeMapboxCredentials,
        mapbox3d: this.tables.communityMapConfigs.mapbox3d,
        protomapsApiKey: this.tables.communityMapConfigs.protomapsApiKey,
        protomapsBasemapStyle:
          this.tables.communityMapConfigs.protomapsBasemapStyle,
      })
      .from(this.tables.communityMapConfigs)
      .where(eq(this.tables.communityMapConfigs.communityId, communityId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      ...row,
      exposeMapboxCredentials: Boolean(row.exposeMapboxCredentials),
      mapbox3d: Boolean(row.mapbox3d),
    };
  }

  async upsertCommunityMapConfig(
    communityId: number,
    actorId: number,
    input: MapConfigUpsertInput,
    updatedFieldNames: readonly string[],
    now: Date = new Date()
  ): Promise<PublicMapConfigRow | null> {
    const { communityMapConfigs, communities } = this.tables;
    // Private community => false, evaluated in the same statement as the write.
    // The subquery yields the physical public flag in the column's own encoding.
    const exposeValue = (input.exposeMapboxCredentials === true
      ? sql`(select ${communities.publicStories} from ${communities} where ${communities.id} = ${communityId})`
      : false) as unknown as boolean;
    // Merged (stored + incoming) style/token must be both set or both null.
    const nullTest = (
      value: string | null | undefined,
      column:
        | typeof communityMapConfigs.mapboxStyleUrl
        | typeof communityMapConfigs.mapboxAccessToken
    ) =>
      value === undefined
        ? sql`(${column} is null)`
        : value === null
          ? sql`(1 = 1)`
          : sql`(1 = 0)`;
    const pairGuard = sql`(${nullTest(input.mapboxStyleUrl, communityMapConfigs.mapboxStyleUrl)} = ${nullTest(input.mapboxAccessToken, communityMapConfigs.mapboxAccessToken)})`;
    const buildUpsertQuery = (executor: typeof this.db) =>
      executor
        .insert(this.tables.communityMapConfigs)
        .values({
          communityId,
          styleUrl: input.styleUrl,
          basemapStyle: input.basemapStyle,
          mapboxStyleUrl: input.mapboxStyleUrl ?? null,
          mapboxAccessToken: input.mapboxAccessToken ?? null,
          exposeMapboxCredentials: exposeValue,
          mapbox3d: input.mapbox3d ?? false,
          protomapsApiKey: input.protomapsApiKey ?? null,
          protomapsBasemapStyle: input.protomapsBasemapStyle ?? null,
          centerLatitude: input.centerLatitude,
          centerLongitude: input.centerLongitude,
          southWestLatitude: input.southWestLatitude,
          southWestLongitude: input.southWestLongitude,
          northEastLatitude: input.northEastLatitude,
          northEastLongitude: input.northEastLongitude,
          zoom: input.zoom,
          pitch: input.pitch,
          bearing: input.bearing,
          threeDimensional: input.threeDimensional,
          projection: input.projection,
          staticMapFileId: input.staticMapFileId,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: this.tables.communityMapConfigs.communityId,
          setWhere: pairGuard,
          set: {
            styleUrl: input.styleUrl,
            basemapStyle: input.basemapStyle,
            ...(input.mapboxStyleUrl !== undefined && {
              mapboxStyleUrl: input.mapboxStyleUrl,
            }),
            ...(input.mapboxAccessToken !== undefined && {
              mapboxAccessToken: input.mapboxAccessToken,
            }),
            ...(input.exposeMapboxCredentials !== undefined && {
              exposeMapboxCredentials: exposeValue,
            }),
            ...(input.mapbox3d !== undefined && { mapbox3d: input.mapbox3d }),
            ...(input.protomapsApiKey !== undefined && {
              protomapsApiKey: input.protomapsApiKey,
            }),
            ...(input.protomapsBasemapStyle !== undefined && {
              protomapsBasemapStyle: input.protomapsBasemapStyle,
            }),
            centerLatitude: input.centerLatitude,
            centerLongitude: input.centerLongitude,
            southWestLatitude: input.southWestLatitude,
            southWestLongitude: input.southWestLongitude,
            northEastLatitude: input.northEastLatitude,
            northEastLongitude: input.northEastLongitude,
            zoom: input.zoom,
            pitch: input.pitch,
            bearing: input.bearing,
            threeDimensional: input.threeDimensional,
            projection: input.projection,
            staticMapFileId: input.staticMapFileId,
            updatedAt: now,
          },
        })
        .returning({
          communityId: this.tables.communityMapConfigs.communityId,
          styleUrl: this.tables.communityMapConfigs.styleUrl,
          basemapStyle: this.tables.communityMapConfigs.basemapStyle,
          mapboxStyleUrl: this.tables.communityMapConfigs.mapboxStyleUrl,
          mapboxAccessToken: this.tables.communityMapConfigs.mapboxAccessToken,
          exposeMapboxCredentials:
            this.tables.communityMapConfigs.exposeMapboxCredentials,
          mapbox3d: this.tables.communityMapConfigs.mapbox3d,
          protomapsApiKey: this.tables.communityMapConfigs.protomapsApiKey,
          protomapsBasemapStyle:
            this.tables.communityMapConfigs.protomapsBasemapStyle,
          centerLatitude: this.tables.communityMapConfigs.centerLatitude,
          centerLongitude: this.tables.communityMapConfigs.centerLongitude,
          southWestLatitude: this.tables.communityMapConfigs.southWestLatitude,
          southWestLongitude:
            this.tables.communityMapConfigs.southWestLongitude,
          northEastLatitude: this.tables.communityMapConfigs.northEastLatitude,
          northEastLongitude:
            this.tables.communityMapConfigs.northEastLongitude,
          zoom: this.tables.communityMapConfigs.zoom,
          pitch: this.tables.communityMapConfigs.pitch,
          bearing: this.tables.communityMapConfigs.bearing,
          threeDimensional: this.tables.communityMapConfigs.threeDimensional,
          projection: this.tables.communityMapConfigs.projection,
          staticMapFileId: this.tables.communityMapConfigs.staticMapFileId,
          createdAt: this.tables.communityMapConfigs.createdAt,
          updatedAt: this.tables.communityMapConfigs.updatedAt,
        });

    const auditInput = {
      communityId,
      actorId,
      action: 'community.map_config.update',
      resourceType: 'map_config',
      // Content-free: community id followed only by opaque schema field names.
      resourceIds: [communityId, ...updatedFieldNames],
      outcome: 'success',
      ipAddress: null,
      userAgent: null,
    };

    const normalizeRow = (
      row: PublicMapConfigRow | undefined
    ): PublicMapConfigRow | null => {
      if (!row) return null;
      return {
        ...row,
        exposeMapboxCredentials: Boolean(row.exposeMapboxCredentials),
        mapbox3d: Boolean(row.mapbox3d),
      };
    };

    if (this.hasD1Batch()) {
      // Audit only when the upsert will write. The audit INSERT ... SELECT runs
      // BEFORE the upsert in the same atomic batch and evaluates the same
      // condition as the upsert's setWhere against the pre-write state: no row
      // yet (plain insert) or the merged style/token pair guard holds. A
      // guard-rejected save therefore writes no success audit row.
      const audit = validateContentFreeAuditEntry(auditInput);
      const existingConfig = this.db
        .select({ one: sql`1` })
        .from(communityMapConfigs)
        .where(eq(communityMapConfigs.communityId, communityId));
      const guardedConfig = this.db
        .select({ one: sql`1` })
        .from(communityMapConfigs)
        .where(
          and(eq(communityMapConfigs.communityId, communityId), pairGuard)
        );
      const insertAudit = this.db.insert(this.tables.auditEntries).select(
        this.db
          .select({
            id: sql`NULL`.as('id'),
            communityId: sql`${audit.communityId}`.as('community_id'),
            actorId: sql`${audit.actorId}`.as('actor_id'),
            action: sql`${audit.action}`.as('action'),
            resourceType: sql`${audit.resourceType}`.as('resource_type'),
            resourceIds: sql`${JSON.stringify(audit.resourceIds)}`.as(
              'resource_ids'
            ),
            outcome: sql`${audit.outcome}`.as('outcome'),
            ipAddress: sql`NULL`.as('ip_address'),
            userAgent: sql`NULL`.as('user_agent'),
            createdAt: sql`${now.getTime()}`.as('created_at'),
          })
          .from(communities)
          .where(
            and(
              eq(communities.id, communityId),
              or(notExists(existingConfig), exists(guardedConfig))
            )
          )
      );
      const [, upsertedRows] = await this.db.batch([
        insertAudit,
        buildUpsertQuery(this.db),
      ]);
      const rows = Array.isArray(upsertedRows)
        ? (upsertedRows as PublicMapConfigRow[])
        : [];
      return normalizeRow(rows[0]);
    }

    if (dialectOf(this.connection) === 'postgresql') {
      return this.db.transaction(async (tx: typeof this.db) => {
        const rows = (await buildUpsertQuery(tx)) as PublicMapConfigRow[];
        const saved = normalizeRow(rows[0]);
        if (saved) {
          await buildAuditEntryInsert(tx, auditInput, now);
        }
        return saved;
      });
    }

    // better-sqlite3 transactions are synchronous
    return this.db.transaction((tx: typeof this.db) => {
      const rows = buildUpsertQuery(tx).all() as PublicMapConfigRow[];
      const saved = normalizeRow(rows[0]);
      if (saved) {
        buildAuditEntryInsert(tx, auditInput, now).run();
      }
      return saved;
    });
  }

  async createPlace(
    communityId: number,
    input: PlaceCreateInput,
    now: Date = new Date()
  ): Promise<{ id: number } | null> {
    const rows = await this.db
      .insert(this.tables.places)
      .values({
        communityId,
        name: input.name,
        description: input.description,
        descriptionPlain: input.descriptionPlain,
        typeOfPlace: input.typeOfPlace,
        region: input.region,
        latitude: input.latitude,
        longitude: input.longitude,
        isRestricted: false,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: this.tables.places.id });
    return rows[0] ?? null;
  }

  async updatePlace(
    communityId: number,
    placeId: number,
    input: PlaceUpdateInput,
    now: Date = new Date()
  ): Promise<boolean> {
    const setPayload: Record<string, unknown> = {
      updatedAt: now,
    };
    if (input.name !== undefined) {
      setPayload.name = input.name;
    }
    if (input.description !== undefined) {
      setPayload.description = input.description;
      setPayload.descriptionPlain = input.descriptionPlain ?? null;
    }
    if (input.typeOfPlace !== undefined) {
      setPayload.typeOfPlace = input.typeOfPlace;
    }
    if (input.region !== undefined) {
      setPayload.region = input.region;
    }
    if (input.latitude !== undefined && input.longitude !== undefined) {
      setPayload.latitude = input.latitude;
      setPayload.longitude = input.longitude;
    }

    const rows = await this.db
      .update(this.tables.places)
      .set(setPayload)
      .where(
        and(
          eq(this.tables.places.id, placeId),
          eq(this.tables.places.communityId, communityId),
          eq(this.tables.places.isRestricted, false)
        )
      )
      .returning({ id: this.tables.places.id });
    return rows.length > 0;
  }

  private deleteOwnerAttachmentsQuery(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    executor: any,
    communityId: number,
    ownerType: 'place' | 'speaker',
    ownerId: number,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ownerGoneGuard?: any
  ) {
    const base = and(
      eq(this.tables.attachments.communityId, communityId),
      eq(this.tables.attachments.ownerType, ownerType),
      eq(this.tables.attachments.ownerId, ownerId)
    );
    return executor
      .delete(this.tables.attachments)
      .where(ownerGoneGuard ? and(base, ownerGoneGuard) : base);
  }

  private placeReferenceGuards(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    executor: any,
    communityId: number,
    placeId: number
  ) {
    return [
      notExists(
        executor
          .select({ one: sql`1` })
          .from(this.tables.storyPlaces)
          .where(
            and(
              eq(this.tables.storyPlaces.communityId, communityId),
              eq(this.tables.storyPlaces.placeId, placeId)
            )
          )
      ),
      notExists(
        executor
          .select({ one: sql`1` })
          .from(this.tables.stories)
          .where(
            and(
              eq(this.tables.stories.communityId, communityId),
              eq(this.tables.stories.interviewLocationId, placeId)
            )
          )
      ),
      notExists(
        executor
          .select({ one: sql`1` })
          .from(this.tables.speakers)
          .where(
            and(
              eq(this.tables.speakers.communityId, communityId),
              eq(this.tables.speakers.birthplaceId, placeId)
            )
          )
      ),
    ];
  }

  private speakerReferenceGuards(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    executor: any,
    communityId: number,
    speakerId: number
  ) {
    return [
      notExists(
        executor
          .select({ one: sql`1` })
          .from(this.tables.storySpeakers)
          .where(
            and(
              eq(this.tables.storySpeakers.communityId, communityId),
              eq(this.tables.storySpeakers.speakerId, speakerId)
            )
          )
      ),
      notExists(
        executor
          .select({ one: sql`1` })
          .from(this.tables.stories)
          .where(
            and(
              eq(this.tables.stories.communityId, communityId),
              eq(this.tables.stories.interviewerId, speakerId)
            )
          )
      ),
    ];
  }

  private async deleteGuardedOwner(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    table: any,
    ownerType: 'place' | 'speaker',
    communityId: number,
    ownerId: number,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    readableScope: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    physicalOwnerScope: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    referenceGuards: (executor: any) => any[],
    removedFiles?: FileByteCleanup[]
  ): Promise<PlaceDeleteOutcome> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const collectFiles = (rows: any) => {
      if (removedFiles) removedFiles.push(...toFileByteCleanups(rows));
    };
    // Candidates for byte cleanup are the attachments actually deleted in
    // this transaction/batch (DELETE ... RETURNING file_id), so a relation
    // inserted and cascaded away within this very operation is included.
    // Row keys arrive drizzle-mapped in production drivers; the D1-like
    // batch harness returns raw column names, so accept both spellings.
    const fileIdsOf = (rows: unknown): string[] =>
      (Array.isArray(rows)
        ? (rows as Array<{
            fileId?: string | null;
            file_id?: string | null;
          }>)
        : []
      )
        .map((row) => row.fileId ?? row.file_id ?? null)
        .filter((id): id is string => typeof id === 'string');
    try {
      if (this.hasD1Batch()) {
        // The files purge gates on the exact DELETE predicate, so the purge
        // never frees files in a batch whose owner delete will match nothing.
        // It runs inside the same batch, before the relation rows go, so a
        // crash can never leave rows behind for the owner (or a claim of
        // garbage bytes that were never released).
        const ownerDeleteScope = and(
          readableScope,
          ...referenceGuards(this.db)
        );
        const ownerDeleteGuard = exists(
          this.db
            .select({ one: sql`1` })
            .from(table)
            .where(ownerDeleteScope)
        );
        const deleteOwner = this.db
          .delete(table)
          .where(ownerDeleteScope)
          .returning({ id: table.id });

        const ownerGoneGuard = notExists(
          this.db
            .select({ one: sql`1` })
            .from(table)
            .where(physicalOwnerScope)
        );
        const deleteAttachments = this.deleteOwnerAttachmentsQuery(
          this.db,
          communityId,
          ownerType,
          ownerId,
          ownerGoneGuard
        ).returning({ fileId: this.tables.attachments.fileId });

        const existingOwnerCheck = this.db
          .select({ id: table.id })
          .from(table)
          .where(readableScope)
          .limit(1);

        // One atomic batch: files purge first (the still-present attachments
        // are the evidence), then owner and attachments, then an owner-existence
        // check for the conflict verdict.
        const [purgeRows, deletedRows, , existingRows] = await this.db.batch([
          ...buildOwnerUnreferencedFilesDelete(
            this.db,
            this.connection,
            { communityId, ownerType, ownerId },
            ownerDeleteGuard
          ),
          deleteOwner,
          deleteAttachments,
          existingOwnerCheck,
        ]);

        if (!Array.isArray(deletedRows) || deletedRows.length === 0) {
          return Array.isArray(existingRows) && existingRows.length > 0
            ? 'conflict'
            : 'not_found';
        }
        collectFiles(Array.isArray(purgeRows) ? (purgeRows as never) : []);
        return 'deleted';
      }

      if (dialectOf(this.connection) === 'postgresql') {
        return await this.db.transaction(async (tx: typeof this.db) => {
          const existingRows = await tx
            .select({ id: table.id })
            .from(table)
            .where(readableScope)
            .limit(1)
            .for('update');
          if (existingRows.length === 0) {
            return 'not_found';
          }

          const deleted = await tx
            .delete(table)
            .where(and(readableScope, ...referenceGuards(tx)))
            .returning({ id: table.id });

          if (deleted.length === 0) {
            return 'conflict';
          }

          const deletedAttachments = await this.deleteOwnerAttachmentsQuery(
            tx,
            communityId,
            ownerType,
            ownerId
          ).returning({ fileId: this.tables.attachments.fileId });
          const fileIds = fileIdsOf(deletedAttachments);
          // Lock the candidate rows before the guarded delete so an attach that
          // is still uncommitted cannot have its relation cascaded away (see
          // lockFileRowsForCleanup).
          const lockedFileIds = await lockFileRowsForCleanup(
            tx,
            this.connection,
            fileIds
          );
          collectFiles(
            (
              await Promise.all(
                buildUnreferencedFilesDelete(tx, this.connection, lockedFileIds)
              )
            ).flat()
          );
          return 'deleted';
        });
      }

      // better-sqlite3 synchronous transaction
      return this.db.transaction((tx: typeof this.db) => {
        const deleted = tx
          .delete(table)
          .where(and(readableScope, ...referenceGuards(tx)))
          .returning({ id: table.id })
          .all();

        if (deleted.length > 0) {
          const deletedAttachments = this.deleteOwnerAttachmentsQuery(
            tx,
            communityId,
            ownerType,
            ownerId
          )
            .returning({ fileId: this.tables.attachments.fileId })
            .all();
          const fileIds = fileIdsOf(deletedAttachments);
          collectFiles(
            buildUnreferencedFilesDelete(tx, this.connection, fileIds).flatMap(
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (statement: any) => statement.returning().all()
            )
          );
          return 'deleted';
        }

        const existing = tx
          .select({ id: table.id })
          .from(table)
          .where(readableScope)
          .limit(1)
          .get();

        return existing ? 'conflict' : 'not_found';
      });
    } catch (err) {
      if (isForeignKeyConstraintError(err)) {
        return 'conflict';
      }
      throw err;
    }
  }

  async deletePlace(
    communityId: number,
    placeId: number,
    removedFiles?: FileByteCleanup[]
  ): Promise<PlaceDeleteOutcome> {
    const physicalScope = and(
      eq(this.tables.places.id, placeId),
      eq(this.tables.places.communityId, communityId)
    );
    const readableScope = and(
      physicalScope,
      eq(this.tables.places.isRestricted, false)
    );
    return this.deleteGuardedOwner(
      this.tables.places,
      'place',
      communityId,
      placeId,
      readableScope,
      physicalScope,
      (executor) => this.placeReferenceGuards(executor, communityId, placeId),
      removedFiles
    );
  }

  async findCommunityUnrestrictedPlace(
    communityId: number,
    placeId: number
  ): Promise<{ id: number } | null> {
    const rows = await this.db
      .select({ id: this.tables.places.id })
      .from(this.tables.places)
      .where(
        and(
          eq(this.tables.places.id, placeId),
          eq(this.tables.places.communityId, communityId),
          eq(this.tables.places.isRestricted, false)
        )
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async createSpeaker(
    communityId: number,
    input: SpeakerCreateInput,
    now: Date = new Date()
  ): Promise<{ id: number } | null> {
    const rows = await this.db
      .insert(this.tables.speakers)
      .values({
        communityId,
        name: input.name,
        birthDate: input.birthDate,
        birthplaceId: input.birthplaceId,
        affiliation: input.affiliation,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: this.tables.speakers.id });
    return rows[0] ?? null;
  }

  async updateSpeaker(
    communityId: number,
    speakerId: number,
    input: SpeakerUpdateInput,
    now: Date = new Date()
  ): Promise<boolean> {
    const setPayload: Record<string, unknown> = {
      updatedAt: now,
    };
    if (input.name !== undefined) {
      setPayload.name = input.name;
    }
    if (input.birthDate !== undefined) {
      setPayload.birthDate = input.birthDate;
    }
    if (input.birthplaceId !== undefined) {
      setPayload.birthplaceId = input.birthplaceId;
    }
    if (input.affiliation !== undefined) {
      setPayload.affiliation = input.affiliation;
    }

    const rows = await this.db
      .update(this.tables.speakers)
      .set(setPayload)
      .where(
        and(
          eq(this.tables.speakers.id, speakerId),
          eq(this.tables.speakers.communityId, communityId)
        )
      )
      .returning({ id: this.tables.speakers.id });
    return rows.length > 0;
  }

  async deleteSpeaker(
    communityId: number,
    speakerId: number,
    removedFiles?: FileByteCleanup[]
  ): Promise<SpeakerDeleteOutcome> {
    const scope = and(
      eq(this.tables.speakers.id, speakerId),
      eq(this.tables.speakers.communityId, communityId)
    );
    return this.deleteGuardedOwner(
      this.tables.speakers,
      'speaker',
      communityId,
      speakerId,
      scope,
      scope,
      (executor) =>
        this.speakerReferenceGuards(executor, communityId, speakerId),
      removedFiles
    );
  }
}
