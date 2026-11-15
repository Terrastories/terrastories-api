import { and, eq, isNull } from 'drizzle-orm';
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

function isForeignKeyConstraintError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  if (
    code === '23503' ||
    code === 'SQLITE_CONSTRAINT_FOREIGNKEY' ||
    code === 'SQLITE_CONSTRAINT'
  ) {
    return true;
  }
  const cause = (err as { cause?: unknown }).cause;
  return cause ? isForeignKeyConstraintError(cause) : false;
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

    if (this.hasD1Batch()) {
      const existingRows = await this.db
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
        .limit(1);
      const existing = existingRows[0];
      if (!existing) {
        return { updated: false };
      }

      const previousVisibility = communityFromPhysical(existing).visibility;
      const nextVisibility = input.visibility ?? previousVisibility;
      const setPayload = buildSetPayload();

      const updateQuery = this.db
        .update(this.tables.communities)
        .set(setPayload)
        .where(
          and(
            eq(this.tables.communities.id, communityId),
            eq(this.tables.communities.isActive, true)
          )
        )
        .returning({ id: this.tables.communities.id });

      if (nextVisibility !== previousVisibility) {
        const audit = buildVisibilityAuditEntry(
          communityId,
          actorId,
          nextVisibility
        );
        const auditQuery = this.db.insert(this.tables.auditEntries).values({
          ...audit,
          createdAt: now,
        });
        const [updatedRows] = await this.db.batch([updateQuery, auditQuery]);
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
          .limit(1);
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
      const existing = tx
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
        .get();
      if (!existing) {
        return { updated: false };
      }

      const previousVisibility = communityFromPhysical(existing).visibility;
      const nextVisibility = input.visibility ?? previousVisibility;

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

      if (updated.length === 0) {
        return { updated: false };
      }

      if (nextVisibility !== previousVisibility) {
        const audit = buildVisibilityAuditEntry(
          communityId,
          actorId,
          nextVisibility
        );
        tx.insert(this.tables.auditEntries)
          .values({
            ...audit,
            createdAt: now,
          })
          .run();
      }

      return { updated: true };
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

  async upsertCommunityMapConfig(
    communityId: number,
    input: MapConfigUpsertInput,
    now: Date = new Date()
  ): Promise<PublicMapConfigRow | null> {
    const rows = await this.db
      .insert(this.tables.communityMapConfigs)
      .values({
        communityId,
        styleUrl: input.styleUrl,
        basemapStyle: input.basemapStyle,
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
        set: {
          styleUrl: input.styleUrl,
          basemapStyle: input.basemapStyle,
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
        centerLatitude: this.tables.communityMapConfigs.centerLatitude,
        centerLongitude: this.tables.communityMapConfigs.centerLongitude,
        southWestLatitude: this.tables.communityMapConfigs.southWestLatitude,
        southWestLongitude: this.tables.communityMapConfigs.southWestLongitude,
        northEastLatitude: this.tables.communityMapConfigs.northEastLatitude,
        northEastLongitude: this.tables.communityMapConfigs.northEastLongitude,
        zoom: this.tables.communityMapConfigs.zoom,
        pitch: this.tables.communityMapConfigs.pitch,
        bearing: this.tables.communityMapConfigs.bearing,
        threeDimensional: this.tables.communityMapConfigs.threeDimensional,
        projection: this.tables.communityMapConfigs.projection,
        staticMapFileId: this.tables.communityMapConfigs.staticMapFileId,
        createdAt: this.tables.communityMapConfigs.createdAt,
        updatedAt: this.tables.communityMapConfigs.updatedAt,
      });

    return rows[0] ?? null;
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

  async deletePlace(
    communityId: number,
    placeId: number
  ): Promise<PlaceDeleteOutcome> {
    try {
      if (this.hasD1Batch()) {
        const existingRows = await this.db
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
        if (existingRows.length === 0) {
          return 'not_found';
        }

        const [storyPlaceRef, interviewRef, birthplaceRef] = await Promise.all([
          this.db
            .select({ id: this.tables.storyPlaces.id })
            .from(this.tables.storyPlaces)
            .where(
              and(
                eq(this.tables.storyPlaces.communityId, communityId),
                eq(this.tables.storyPlaces.placeId, placeId)
              )
            )
            .limit(1),
          this.db
            .select({ id: this.tables.stories.id })
            .from(this.tables.stories)
            .where(
              and(
                eq(this.tables.stories.communityId, communityId),
                eq(this.tables.stories.interviewLocationId, placeId)
              )
            )
            .limit(1),
          this.db
            .select({ id: this.tables.speakers.id })
            .from(this.tables.speakers)
            .where(
              and(
                eq(this.tables.speakers.communityId, communityId),
                eq(this.tables.speakers.birthplaceId, placeId)
              )
            )
            .limit(1),
        ]);

        if (
          storyPlaceRef.length > 0 ||
          interviewRef.length > 0 ||
          birthplaceRef.length > 0
        ) {
          return 'conflict';
        }

        const deleteAttachments = this.db
          .delete(this.tables.attachments)
          .where(
            and(
              eq(this.tables.attachments.communityId, communityId),
              eq(this.tables.attachments.ownerType, 'place'),
              eq(this.tables.attachments.ownerId, placeId)
            )
          );
        const deletePlace = this.db
          .delete(this.tables.places)
          .where(
            and(
              eq(this.tables.places.id, placeId),
              eq(this.tables.places.communityId, communityId),
              eq(this.tables.places.isRestricted, false)
            )
          )
          .returning({ id: this.tables.places.id });

        const [, deletedRows] = await this.db.batch([
          deleteAttachments,
          deletePlace,
        ]);
        return Array.isArray(deletedRows) && deletedRows.length > 0
          ? 'deleted'
          : 'not_found';
      }

      if (dialectOf(this.connection) === 'postgresql') {
        return await this.db.transaction(async (tx: typeof this.db) => {
          const existingRows = await tx
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
          if (existingRows.length === 0) {
            return 'not_found';
          }

          const [storyPlaceRef, interviewRef, birthplaceRef] =
            await Promise.all([
              tx
                .select({ id: this.tables.storyPlaces.id })
                .from(this.tables.storyPlaces)
                .where(
                  and(
                    eq(this.tables.storyPlaces.communityId, communityId),
                    eq(this.tables.storyPlaces.placeId, placeId)
                  )
                )
                .limit(1),
              tx
                .select({ id: this.tables.stories.id })
                .from(this.tables.stories)
                .where(
                  and(
                    eq(this.tables.stories.communityId, communityId),
                    eq(this.tables.stories.interviewLocationId, placeId)
                  )
                )
                .limit(1),
              tx
                .select({ id: this.tables.speakers.id })
                .from(this.tables.speakers)
                .where(
                  and(
                    eq(this.tables.speakers.communityId, communityId),
                    eq(this.tables.speakers.birthplaceId, placeId)
                  )
                )
                .limit(1),
            ]);

          if (
            storyPlaceRef.length > 0 ||
            interviewRef.length > 0 ||
            birthplaceRef.length > 0
          ) {
            return 'conflict';
          }

          await tx
            .delete(this.tables.attachments)
            .where(
              and(
                eq(this.tables.attachments.communityId, communityId),
                eq(this.tables.attachments.ownerType, 'place'),
                eq(this.tables.attachments.ownerId, placeId)
              )
            );
          const deleted = await tx
            .delete(this.tables.places)
            .where(
              and(
                eq(this.tables.places.id, placeId),
                eq(this.tables.places.communityId, communityId),
                eq(this.tables.places.isRestricted, false)
              )
            )
            .returning({ id: this.tables.places.id });

          return deleted.length > 0 ? 'deleted' : 'not_found';
        });
      }

      // better-sqlite3 synchronous transaction
      return this.db.transaction((tx: typeof this.db) => {
        const existing = tx
          .select({ id: this.tables.places.id })
          .from(this.tables.places)
          .where(
            and(
              eq(this.tables.places.id, placeId),
              eq(this.tables.places.communityId, communityId),
              eq(this.tables.places.isRestricted, false)
            )
          )
          .limit(1)
          .get();
        if (!existing) {
          return 'not_found';
        }

        const storyPlaceRef = tx
          .select({ id: this.tables.storyPlaces.id })
          .from(this.tables.storyPlaces)
          .where(
            and(
              eq(this.tables.storyPlaces.communityId, communityId),
              eq(this.tables.storyPlaces.placeId, placeId)
            )
          )
          .limit(1)
          .get();
        const interviewRef = tx
          .select({ id: this.tables.stories.id })
          .from(this.tables.stories)
          .where(
            and(
              eq(this.tables.stories.communityId, communityId),
              eq(this.tables.stories.interviewLocationId, placeId)
            )
          )
          .limit(1)
          .get();
        const birthplaceRef = tx
          .select({ id: this.tables.speakers.id })
          .from(this.tables.speakers)
          .where(
            and(
              eq(this.tables.speakers.communityId, communityId),
              eq(this.tables.speakers.birthplaceId, placeId)
            )
          )
          .limit(1)
          .get();

        if (storyPlaceRef || interviewRef || birthplaceRef) {
          return 'conflict';
        }

        tx.delete(this.tables.attachments)
          .where(
            and(
              eq(this.tables.attachments.communityId, communityId),
              eq(this.tables.attachments.ownerType, 'place'),
              eq(this.tables.attachments.ownerId, placeId)
            )
          )
          .run();
        const deleted = tx
          .delete(this.tables.places)
          .where(
            and(
              eq(this.tables.places.id, placeId),
              eq(this.tables.places.communityId, communityId),
              eq(this.tables.places.isRestricted, false)
            )
          )
          .returning({ id: this.tables.places.id })
          .all();

        return deleted.length > 0 ? 'deleted' : 'not_found';
      });
    } catch (err) {
      if (isForeignKeyConstraintError(err)) {
        return 'conflict';
      }
      throw err;
    }
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
    speakerId: number
  ): Promise<SpeakerDeleteOutcome> {
    try {
      if (this.hasD1Batch()) {
        const existingRows = await this.db
          .select({ id: this.tables.speakers.id })
          .from(this.tables.speakers)
          .where(
            and(
              eq(this.tables.speakers.id, speakerId),
              eq(this.tables.speakers.communityId, communityId)
            )
          )
          .limit(1);
        if (existingRows.length === 0) {
          return 'not_found';
        }

        const [storySpeakerRef, interviewerRef] = await Promise.all([
          this.db
            .select({ id: this.tables.storySpeakers.id })
            .from(this.tables.storySpeakers)
            .where(
              and(
                eq(this.tables.storySpeakers.communityId, communityId),
                eq(this.tables.storySpeakers.speakerId, speakerId)
              )
            )
            .limit(1),
          this.db
            .select({ id: this.tables.stories.id })
            .from(this.tables.stories)
            .where(
              and(
                eq(this.tables.stories.communityId, communityId),
                eq(this.tables.stories.interviewerId, speakerId)
              )
            )
            .limit(1),
        ]);

        if (storySpeakerRef.length > 0 || interviewerRef.length > 0) {
          return 'conflict';
        }

        const deleteAttachments = this.db
          .delete(this.tables.attachments)
          .where(
            and(
              eq(this.tables.attachments.communityId, communityId),
              eq(this.tables.attachments.ownerType, 'speaker'),
              eq(this.tables.attachments.ownerId, speakerId)
            )
          );
        const deleteSpeaker = this.db
          .delete(this.tables.speakers)
          .where(
            and(
              eq(this.tables.speakers.id, speakerId),
              eq(this.tables.speakers.communityId, communityId)
            )
          )
          .returning({ id: this.tables.speakers.id });

        const [, deletedRows] = await this.db.batch([
          deleteAttachments,
          deleteSpeaker,
        ]);
        return Array.isArray(deletedRows) && deletedRows.length > 0
          ? 'deleted'
          : 'not_found';
      }

      if (dialectOf(this.connection) === 'postgresql') {
        return await this.db.transaction(async (tx: typeof this.db) => {
          const existingRows = await tx
            .select({ id: this.tables.speakers.id })
            .from(this.tables.speakers)
            .where(
              and(
                eq(this.tables.speakers.id, speakerId),
                eq(this.tables.speakers.communityId, communityId)
              )
            )
            .limit(1);
          if (existingRows.length === 0) {
            return 'not_found';
          }

          const [storySpeakerRef, interviewerRef] = await Promise.all([
            tx
              .select({ id: this.tables.storySpeakers.id })
              .from(this.tables.storySpeakers)
              .where(
                and(
                  eq(this.tables.storySpeakers.communityId, communityId),
                  eq(this.tables.storySpeakers.speakerId, speakerId)
                )
              )
              .limit(1),
            tx
              .select({ id: this.tables.stories.id })
              .from(this.tables.stories)
              .where(
                and(
                  eq(this.tables.stories.communityId, communityId),
                  eq(this.tables.stories.interviewerId, speakerId)
                )
              )
              .limit(1),
          ]);

          if (storySpeakerRef.length > 0 || interviewerRef.length > 0) {
            return 'conflict';
          }

          await tx
            .delete(this.tables.attachments)
            .where(
              and(
                eq(this.tables.attachments.communityId, communityId),
                eq(this.tables.attachments.ownerType, 'speaker'),
                eq(this.tables.attachments.ownerId, speakerId)
              )
            );
          const deleted = await tx
            .delete(this.tables.speakers)
            .where(
              and(
                eq(this.tables.speakers.id, speakerId),
                eq(this.tables.speakers.communityId, communityId)
              )
            )
            .returning({ id: this.tables.speakers.id });

          return deleted.length > 0 ? 'deleted' : 'not_found';
        });
      }

      // better-sqlite3 synchronous transaction
      return this.db.transaction((tx: typeof this.db) => {
        const existing = tx
          .select({ id: this.tables.speakers.id })
          .from(this.tables.speakers)
          .where(
            and(
              eq(this.tables.speakers.id, speakerId),
              eq(this.tables.speakers.communityId, communityId)
            )
          )
          .limit(1)
          .get();
        if (!existing) {
          return 'not_found';
        }

        const storySpeakerRef = tx
          .select({ id: this.tables.storySpeakers.id })
          .from(this.tables.storySpeakers)
          .where(
            and(
              eq(this.tables.storySpeakers.communityId, communityId),
              eq(this.tables.storySpeakers.speakerId, speakerId)
            )
          )
          .limit(1)
          .get();
        const interviewerRef = tx
          .select({ id: this.tables.stories.id })
          .from(this.tables.stories)
          .where(
            and(
              eq(this.tables.stories.communityId, communityId),
              eq(this.tables.stories.interviewerId, speakerId)
            )
          )
          .limit(1)
          .get();

        if (storySpeakerRef || interviewerRef) {
          return 'conflict';
        }

        tx.delete(this.tables.attachments)
          .where(
            and(
              eq(this.tables.attachments.communityId, communityId),
              eq(this.tables.attachments.ownerType, 'speaker'),
              eq(this.tables.attachments.ownerId, speakerId)
            )
          )
          .run();
        const deleted = tx
          .delete(this.tables.speakers)
          .where(
            and(
              eq(this.tables.speakers.id, speakerId),
              eq(this.tables.speakers.communityId, communityId)
            )
          )
          .returning({ id: this.tables.speakers.id })
          .all();

        return deleted.length > 0 ? 'deleted' : 'not_found';
      });
    } catch (err) {
      if (isForeignKeyConstraintError(err)) {
        return 'conflict';
      }
      throw err;
    }
  }
}
