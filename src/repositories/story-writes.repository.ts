import { and, asc, eq, exists, inArray, ne, notExists, sql } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import type { Database } from '../db/index.js';
import { dialectOf, tablesFor } from '../db/dialect.js';
import {
  storyVisibilityFromPhysical,
  storyVisibilityToPhysical,
  type StoryVisibility,
} from '../policy/canonical-state.js';
import { validateContentFreeAuditEntry } from '../shared/utils/audit-entry.js';
import {
  buildUnreferencedFilesDelete,
  lockFileRowsForCleanup,
  toFileByteCleanups,
  type FileByteCleanup,
} from '../services/media-cleanup.service.js';

/**
 * Maximum IDs passed to a single SQLite/D1 `IN (...)` target validation query,
 * staying below D1's 100-bound-parameter-per-statement limit alongside tenant
 * filter predicates.
 */
const D1_IN_CLAUSE_CHUNK_SIZE = 90;

/**
 * Maximum `(sort_order, target_id)` edge pairs inserted per SQLite/D1
 * `INSERT ... SELECT ... UNION ALL` batch statement (`<= 34` bound parameters).
 */
const D1_EDGE_INSERT_CHUNK_SIZE = 15;

const READABLE_PRIVACY_LEVELS = ['public', 'members_only', 'editors'] as const;

export interface StoryCreateInput {
  title: string;
  description: string | null;
  descriptionPlain: string | null;
  visibility: StoryVisibility;
  topic: string | null;
  topicNormalized: string | null;
  language: string;
  dateInterviewed: Date | null;
  interviewLocationId: number | null;
  interviewerId: number | null;
  placeIds: number[];
  speakerIds: number[];
}

export interface StoryUpdateInput {
  title?: string;
  description?: string | null;
  descriptionPlain?: string | null;
  visibility?: StoryVisibility;
  topic?: string | null;
  topicNormalized?: string | null;
  language?: string;
  dateInterviewed?: Date | null;
  interviewLocationId?: number | null;
  interviewerId?: number | null;
}

export type StoryCreateOutcome =
  | { status: 'created'; id: number }
  | { status: 'invalid_reference' };

export type StoryUpdateOutcome = 'updated' | 'not_found' | 'invalid_reference';

export interface ExternalMediaLinkRow {
  id: number;
  url: string;
  ordinal: number;
  createdAt: Date;
}

export type AddExternalLinkOutcome =
  | { status: 'created'; link: ExternalMediaLinkRow }
  | { status: 'not_found' }
  | { status: 'limit_exceeded' };

export type ReorderExternalLinksOutcome =
  | { status: 'reordered'; links: ExternalMediaLinkRow[] }
  | { status: 'not_found' }
  | { status: 'conflict' };

function buildUniqueStorySlug(title: string): string {
  const base = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  const suffix = globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  return base.length > 0 ? `${base}-${suffix}` : `story-${suffix}`;
}

function buildStoryVisibilityAuditEntry(
  communityId: number,
  actorId: number,
  storyId: number,
  nextVisibility: StoryVisibility
) {
  return validateContentFreeAuditEntry({
    communityId,
    actorId,
    action: `story.visibility.${nextVisibility}`,
    resourceType: 'story',
    resourceIds: [storyId],
    outcome: 'success',
    ipAddress: null,
    userAgent: null,
  });
}

function chunkArray<T>(items: ReadonlyArray<T>, size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export class StoryWritesRepository {
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

  async findReadableStory(
    communityId: number,
    storyId: number
  ): Promise<{ id: number } | null> {
    const rows = await this.db
      .select({ id: this.tables.stories.id })
      .from(this.tables.stories)
      .where(this.readableStoryScope(communityId, storyId))
      .limit(1);
    return rows[0] ?? null;
  }

  private readableStoryScope(communityId: number, storyId: number) {
    return and(
      eq(this.tables.stories.id, storyId),
      eq(this.tables.stories.communityId, communityId),
      eq(this.tables.stories.isRestricted, false),
      inArray(this.tables.stories.privacyLevel, [...READABLE_PRIVACY_LEVELS])
    );
  }

  private physicalStoryScope(communityId: number, storyId: number) {
    return and(
      eq(this.tables.stories.id, storyId),
      eq(this.tables.stories.communityId, communityId)
    );
  }

  private unrestrictedPlaceExistsGuard(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    executor: any,
    communityId: number,
    placeId: number
  ) {
    return exists(
      executor
        .select({ one: sql`1` })
        .from(this.tables.places)
        .where(
          and(
            eq(this.tables.places.id, placeId),
            eq(this.tables.places.communityId, communityId),
            eq(this.tables.places.isRestricted, false)
          )
        )
    );
  }

  private communitySpeakerExistsGuard(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    executor: any,
    communityId: number,
    speakerId: number
  ) {
    return exists(
      executor
        .select({ one: sql`1` })
        .from(this.tables.speakers)
        .where(
          and(
            eq(this.tables.speakers.id, speakerId),
            eq(this.tables.speakers.communityId, communityId)
          )
        )
    );
  }

  async findCommunityUnrestrictedPlace(
    communityId: number,
    placeId: number,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    executor: any = this.db,
    lockShare = false
  ): Promise<{ id: number } | null> {
    const query = executor
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
    const rows =
      lockShare && dialectOf(this.connection) === 'postgresql'
        ? await query.for('share')
        : await query;
    return rows[0] ?? null;
  }

  async findCommunitySpeaker(
    communityId: number,
    speakerId: number,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    executor: any = this.db,
    lockShare = false
  ): Promise<{ id: number } | null> {
    const query = executor
      .select({ id: this.tables.speakers.id })
      .from(this.tables.speakers)
      .where(
        and(
          eq(this.tables.speakers.id, speakerId),
          eq(this.tables.speakers.communityId, communityId)
        )
      )
      .limit(1);
    const rows =
      lockShare && dialectOf(this.connection) === 'postgresql'
        ? await query.for('share')
        : await query;
    return rows[0] ?? null;
  }

  async findExistingUnrestrictedPlaceIds(
    communityId: number,
    placeIds: ReadonlyArray<number>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    executor: any = this.db,
    lockShare = false
  ): Promise<Set<number>> {
    const uniqueIds = Array.from(new Set(placeIds));
    const found = new Set<number>();
    const useLockShare =
      lockShare && dialectOf(this.connection) === 'postgresql';
    for (const chunk of chunkArray(uniqueIds, D1_IN_CLAUSE_CHUNK_SIZE)) {
      const query = executor
        .select({ id: this.tables.places.id })
        .from(this.tables.places)
        .where(
          and(
            eq(this.tables.places.communityId, communityId),
            eq(this.tables.places.isRestricted, false),
            inArray(this.tables.places.id, chunk)
          )
        );
      const rows = useLockShare ? await query.for('share') : await query;
      for (const row of rows as Array<{ id: number }>) {
        found.add(row.id);
      }
    }
    return found;
  }

  async findExistingSpeakerIds(
    communityId: number,
    speakerIds: ReadonlyArray<number>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    executor: any = this.db,
    lockShare = false
  ): Promise<Set<number>> {
    const uniqueIds = Array.from(new Set(speakerIds));
    const found = new Set<number>();
    const useLockShare =
      lockShare && dialectOf(this.connection) === 'postgresql';
    for (const chunk of chunkArray(uniqueIds, D1_IN_CLAUSE_CHUNK_SIZE)) {
      const query = executor
        .select({ id: this.tables.speakers.id })
        .from(this.tables.speakers)
        .where(
          and(
            eq(this.tables.speakers.communityId, communityId),
            inArray(this.tables.speakers.id, chunk)
          )
        );
      const rows = useLockShare ? await query.for('share') : await query;
      for (const row of rows as Array<{ id: number }>) {
        found.add(row.id);
      }
    }
    return found;
  }

  async createStory(
    communityId: number,
    actorId: number,
    input: StoryCreateInput,
    now: Date = new Date()
  ): Promise<StoryCreateOutcome> {
    const physical = storyVisibilityToPhysical(input.visibility);
    const slug = buildUniqueStorySlug(input.title);

    if (this.hasD1Batch()) {
      const storyWhere = [
        eq(this.tables.communities.id, communityId),
        eq(this.tables.communities.isActive, true),
      ];
      if (input.interviewLocationId !== null) {
        storyWhere.push(
          this.unrestrictedPlaceExistsGuard(
            this.db,
            communityId,
            input.interviewLocationId
          )
        );
      }
      if (input.interviewerId !== null) {
        storyWhere.push(
          this.communitySpeakerExistsGuard(
            this.db,
            communityId,
            input.interviewerId
          )
        );
      }

      const nowMs = now.getTime();
      const dateInterviewedMs = input.dateInterviewed
        ? input.dateInterviewed.getTime()
        : null;

      // Conditional INSERT ... SELECT guards community active status and optional
      // interview metadata inside Statement 1; subsequent statements match by the
      // unique (community_id, slug) and enforce NOT NULL on LEFT JOIN target IDs
      // so any concurrent restriction/cross-community target rolls back the batch.
      const insertStory = this.db
        .insert(this.tables.stories)
        .select(
          this.db
            .select({
              id: sql`NULL`.as('id'),
              title: sql`${input.title}`.as('title'),
              description: sql`${input.description}`.as('description'),
              descriptionPlain: sql`${input.descriptionPlain}`.as(
                'description_plain'
              ),
              slug: sql`${slug}`.as('slug'),
              communityId: this.tables.communities.id,
              createdBy: sql`${actorId}`.as('created_by'),
              isRestricted: sql`${physical.isRestricted ? 1 : 0}`.as(
                'is_restricted'
              ),
              privacyLevel: sql`${physical.privacyLevel}`.as('privacy_level'),
              topic: sql`${input.topic}`.as('topic'),
              topicNormalized: sql`${input.topicNormalized}`.as(
                'topic_normalized'
              ),
              mediaUrls: sql`'[]'`.as('media_urls'),
              imageUrl: sql`NULL`.as('image_url'),
              audioUrl: sql`NULL`.as('audio_url'),
              language: sql`${input.language}`.as('language'),
              tags: sql`'[]'`.as('tags'),
              dateInterviewed: sql`${dateInterviewedMs}`.as('date_interviewed'),
              interviewLocationId: sql`${input.interviewLocationId}`.as(
                'interview_location_id'
              ),
              interviewerId: sql`${input.interviewerId}`.as('interviewer_id'),
              createdAt: sql`${nowMs}`.as('created_at'),
              updatedAt: sql`${nowMs}`.as('updated_at'),
            })
            .from(this.tables.communities)
            .where(and(...storyWhere))
        )
        .returning({ id: this.tables.stories.id });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const statements: any[] = [
        insertStory,
        ...this.buildD1EdgeInsertStatements(
          'places',
          communityId,
          { slug, createdBy: actorId, createdAtMs: nowMs },
          input.placeIds,
          nowMs
        ),
        ...this.buildD1EdgeInsertStatements(
          'speakers',
          communityId,
          { slug, createdBy: actorId, createdAtMs: nowMs },
          input.speakerIds,
          nowMs
        ),
      ];

      if (input.visibility !== 'editors') {
        const auditAction = `story.visibility.${input.visibility}`;
        statements.push(
          this.db.insert(this.tables.auditEntries).select(
            this.db
              .select({
                id: sql`NULL`.as('id'),
                communityId: this.tables.stories.communityId,
                actorId: sql`${actorId}`.as('actor_id'),
                action: sql`${auditAction}`.as('action'),
                resourceType: sql`${'story'}`.as('resource_type'),
                resourceIds: sql`'[' || ${this.tables.stories.id} || ']'`.as(
                  'resource_ids'
                ),
                outcome: sql`${'success'}`.as('outcome'),
                ipAddress: sql`NULL`.as('ip_address'),
                userAgent: sql`NULL`.as('user_agent'),
                createdAt: sql`${nowMs}`.as('created_at'),
              })
              .from(this.tables.stories)
              .where(
                and(
                  eq(this.tables.stories.communityId, communityId),
                  eq(this.tables.stories.slug, slug),
                  eq(this.tables.stories.createdBy, actorId),
                  eq(this.tables.stories.createdAt, now)
                )
              )
          )
        );
      }

      const [insertedRows] = await this.db.batch(statements);
      const created = Array.isArray(insertedRows) ? insertedRows[0] : undefined;
      if (!created) {
        return { status: 'invalid_reference' };
      }
      return { status: 'created', id: created.id };
    }

    const validateReferencesInTx = (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tx: any,
      isSync: boolean
    ): boolean | Promise<boolean> => {
      if (isSync) {
        if (input.interviewLocationId !== null) {
          const place = tx
            .select({ id: this.tables.places.id })
            .from(this.tables.places)
            .where(
              and(
                eq(this.tables.places.id, input.interviewLocationId),
                eq(this.tables.places.communityId, communityId),
                eq(this.tables.places.isRestricted, false)
              )
            )
            .get();
          if (!place) return false;
        }
        if (input.interviewerId !== null) {
          const speaker = tx
            .select({ id: this.tables.speakers.id })
            .from(this.tables.speakers)
            .where(
              and(
                eq(this.tables.speakers.id, input.interviewerId),
                eq(this.tables.speakers.communityId, communityId)
              )
            )
            .get();
          if (!speaker) return false;
        }
        return true;
      }

      const lockShare = dialectOf(this.connection) === 'postgresql';
      return (async () => {
        if (input.interviewLocationId !== null) {
          const place = await this.findCommunityUnrestrictedPlace(
            communityId,
            input.interviewLocationId,
            tx,
            lockShare
          );
          if (!place) return false;
        }
        if (input.interviewerId !== null) {
          const speaker = await this.findCommunitySpeaker(
            communityId,
            input.interviewerId,
            tx,
            lockShare
          );
          if (!speaker) return false;
        }
        return true;
      })();
    };

    if (dialectOf(this.connection) === 'postgresql') {
      return this.db.transaction(async (tx: typeof this.db) => {
        const refsValid = await validateReferencesInTx(tx, false);
        if (!refsValid) {
          return { status: 'invalid_reference' };
        }
        if (input.placeIds.length > 0) {
          const foundPlaces = await this.findExistingUnrestrictedPlaceIds(
            communityId,
            input.placeIds,
            tx,
            true
          );
          if (input.placeIds.some((id) => !foundPlaces.has(id))) {
            return { status: 'invalid_reference' };
          }
        }
        if (input.speakerIds.length > 0) {
          const foundSpeakers = await this.findExistingSpeakerIds(
            communityId,
            input.speakerIds,
            tx,
            true
          );
          if (input.speakerIds.some((id) => !foundSpeakers.has(id))) {
            return { status: 'invalid_reference' };
          }
        }

        const inserted = await tx
          .insert(this.tables.stories)
          .values({
            title: input.title,
            description: input.description,
            descriptionPlain: input.descriptionPlain,
            slug,
            communityId,
            createdBy: actorId,
            isRestricted: physical.isRestricted,
            privacyLevel: physical.privacyLevel,
            topic: input.topic,
            topicNormalized: input.topicNormalized,
            language: input.language,
            dateInterviewed: input.dateInterviewed,
            interviewLocationId: input.interviewLocationId,
            interviewerId: input.interviewerId,
            createdAt: now,
            updatedAt: now,
          })
          .returning({ id: this.tables.stories.id });

        const created = inserted[0];
        if (!created) {
          return { status: 'invalid_reference' };
        }

        if (input.placeIds.length > 0) {
          await tx.insert(this.tables.storyPlaces).values(
            input.placeIds.map((placeId, sortOrder) => ({
              communityId,
              storyId: created.id,
              placeId,
              sortOrder,
              createdAt: now,
              updatedAt: now,
            }))
          );
        }

        if (input.speakerIds.length > 0) {
          await tx.insert(this.tables.storySpeakers).values(
            input.speakerIds.map((speakerId, sortOrder) => ({
              communityId,
              storyId: created.id,
              speakerId,
              sortOrder,
              createdAt: now,
              updatedAt: now,
            }))
          );
        }

        if (input.visibility !== 'editors') {
          const audit = buildStoryVisibilityAuditEntry(
            communityId,
            actorId,
            created.id,
            input.visibility
          );
          await tx.insert(this.tables.auditEntries).values({
            ...audit,
            createdAt: now,
          });
        }

        return { status: 'created', id: created.id };
      });
    }

    // better-sqlite3 transactions are synchronous
    return this.db.transaction((tx: typeof this.db) => {
      if (!validateReferencesInTx(tx, true)) {
        return { status: 'invalid_reference' };
      }

      if (input.placeIds.length > 0) {
        const uniquePlaces = Array.from(new Set(input.placeIds));
        const found = new Set<number>();
        for (const chunk of chunkArray(uniquePlaces, D1_IN_CLAUSE_CHUNK_SIZE)) {
          const rows = tx
            .select({ id: this.tables.places.id })
            .from(this.tables.places)
            .where(
              and(
                eq(this.tables.places.communityId, communityId),
                eq(this.tables.places.isRestricted, false),
                inArray(this.tables.places.id, chunk)
              )
            )
            .all() as Array<{ id: number }>;
          for (const row of rows) {
            found.add(row.id);
          }
        }
        if (uniquePlaces.some((id) => !found.has(id))) {
          return { status: 'invalid_reference' };
        }
      }

      if (input.speakerIds.length > 0) {
        const uniqueSpeakers = Array.from(new Set(input.speakerIds));
        const found = new Set<number>();
        for (const chunk of chunkArray(
          uniqueSpeakers,
          D1_IN_CLAUSE_CHUNK_SIZE
        )) {
          const rows = tx
            .select({ id: this.tables.speakers.id })
            .from(this.tables.speakers)
            .where(
              and(
                eq(this.tables.speakers.communityId, communityId),
                inArray(this.tables.speakers.id, chunk)
              )
            )
            .all() as Array<{ id: number }>;
          for (const row of rows) {
            found.add(row.id);
          }
        }
        if (uniqueSpeakers.some((id) => !found.has(id))) {
          return { status: 'invalid_reference' };
        }
      }

      const created = tx
        .insert(this.tables.stories)
        .values({
          title: input.title,
          description: input.description,
          descriptionPlain: input.descriptionPlain,
          slug,
          communityId,
          createdBy: actorId,
          isRestricted: physical.isRestricted,
          privacyLevel: physical.privacyLevel,
          topic: input.topic,
          topicNormalized: input.topicNormalized,
          language: input.language,
          dateInterviewed: input.dateInterviewed,
          interviewLocationId: input.interviewLocationId,
          interviewerId: input.interviewerId,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: this.tables.stories.id })
        .get() as { id: number } | undefined;

      if (!created) {
        return { status: 'invalid_reference' };
      }

      if (input.placeIds.length > 0) {
        tx.insert(this.tables.storyPlaces)
          .values(
            input.placeIds.map((placeId, sortOrder) => ({
              communityId,
              storyId: created.id,
              placeId,
              sortOrder,
              createdAt: now,
              updatedAt: now,
            }))
          )
          .run();
      }

      if (input.speakerIds.length > 0) {
        tx.insert(this.tables.storySpeakers)
          .values(
            input.speakerIds.map((speakerId, sortOrder) => ({
              communityId,
              storyId: created.id,
              speakerId,
              sortOrder,
              createdAt: now,
              updatedAt: now,
            }))
          )
          .run();
      }

      if (input.visibility !== 'editors') {
        const audit = buildStoryVisibilityAuditEntry(
          communityId,
          actorId,
          created.id,
          input.visibility
        );
        tx.insert(this.tables.auditEntries)
          .values({
            ...audit,
            createdAt: now,
          })
          .run();
      }

      return { status: 'created', id: created.id };
    });
  }

  async updateStory(
    communityId: number,
    actorId: number,
    storyId: number,
    input: StoryUpdateInput,
    now: Date = new Date()
  ): Promise<StoryUpdateOutcome> {
    const buildSetPayload = () => {
      const values: Record<string, unknown> = {
        updatedAt: now,
      };
      if (input.title !== undefined) {
        values.title = input.title;
      }
      if (input.description !== undefined) {
        values.description = input.description;
        values.descriptionPlain = input.descriptionPlain ?? null;
      }
      if (input.visibility !== undefined) {
        const physical = storyVisibilityToPhysical(input.visibility);
        values.privacyLevel = physical.privacyLevel;
        values.isRestricted = physical.isRestricted;
      }
      if (input.topic !== undefined) {
        values.topic = input.topic;
        values.topicNormalized = input.topicNormalized ?? null;
      }
      if (input.language !== undefined) {
        values.language = input.language;
      }
      if (input.dateInterviewed !== undefined) {
        values.dateInterviewed = input.dateInterviewed;
      }
      if (input.interviewLocationId !== undefined) {
        values.interviewLocationId = input.interviewLocationId;
      }
      if (input.interviewerId !== undefined) {
        values.interviewerId = input.interviewerId;
      }
      return values;
    };

    const buildGuards = (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      executor: any
    ) => {
      const guards = [this.readableStoryScope(communityId, storyId)!];
      if (
        input.interviewLocationId !== undefined &&
        input.interviewLocationId !== null
      ) {
        guards.push(
          this.unrestrictedPlaceExistsGuard(
            executor,
            communityId,
            input.interviewLocationId
          )
        );
      }
      if (input.interviewerId !== undefined && input.interviewerId !== null) {
        guards.push(
          this.communitySpeakerExistsGuard(
            executor,
            communityId,
            input.interviewerId
          )
        );
      }
      return and(...guards);
    };

    const buildConditionalAuditInsert = (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      executor: any,
      nextVisibility: StoryVisibility
    ) => {
      const audit = buildStoryVisibilityAuditEntry(
        communityId,
        actorId,
        storyId,
        nextVisibility
      );
      const nextPhysical = storyVisibilityToPhysical(nextVisibility);
      return executor.insert(this.tables.auditEntries).select(
        executor
          .select({
            id: sql`NULL`.as('id'),
            communityId: this.tables.stories.communityId,
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
          .from(this.tables.stories)
          .where(
            and(
              buildGuards(executor),
              ne(this.tables.stories.privacyLevel, nextPhysical.privacyLevel)
            )
          )
      );
    };

    if (this.hasD1Batch()) {
      const updateQuery = this.db
        .update(this.tables.stories)
        .set(buildSetPayload())
        .where(buildGuards(this.db))
        .returning({ id: this.tables.stories.id });

      const readableCheck = this.db
        .select({ id: this.tables.stories.id })
        .from(this.tables.stories)
        .where(this.readableStoryScope(communityId, storyId))
        .limit(1);

      if (input.visibility !== undefined) {
        const auditQuery = buildConditionalAuditInsert(
          this.db,
          input.visibility
        );
        const [, updatedRows, readableRows] = await this.db.batch([
          auditQuery,
          updateQuery,
          readableCheck,
        ]);
        if (Array.isArray(updatedRows) && updatedRows.length > 0) {
          return 'updated';
        }
        return Array.isArray(readableRows) && readableRows.length > 0
          ? 'invalid_reference'
          : 'not_found';
      }

      const [updatedRows, readableRows] = await this.db.batch([
        updateQuery,
        readableCheck,
      ]);
      if (Array.isArray(updatedRows) && updatedRows.length > 0) {
        return 'updated';
      }
      return Array.isArray(readableRows) && readableRows.length > 0
        ? 'invalid_reference'
        : 'not_found';
    }

    if (dialectOf(this.connection) === 'postgresql') {
      return this.db.transaction(async (tx: typeof this.db) => {
        const existingRows = await tx
          .select({
            id: this.tables.stories.id,
            privacyLevel: this.tables.stories.privacyLevel,
            isRestricted: this.tables.stories.isRestricted,
          })
          .from(this.tables.stories)
          .where(this.readableStoryScope(communityId, storyId))
          .limit(1)
          .for('update');
        const existing = existingRows[0];
        if (!existing) {
          return 'not_found';
        }

        if (
          input.interviewLocationId !== undefined &&
          input.interviewLocationId !== null
        ) {
          const place = await this.findCommunityUnrestrictedPlace(
            communityId,
            input.interviewLocationId,
            tx,
            true
          );
          if (!place) {
            return 'invalid_reference';
          }
        }
        if (input.interviewerId !== undefined && input.interviewerId !== null) {
          const speaker = await this.findCommunitySpeaker(
            communityId,
            input.interviewerId,
            tx,
            true
          );
          if (!speaker) {
            return 'invalid_reference';
          }
        }

        const previousVisibility = storyVisibilityFromPhysical(
          existing.privacyLevel,
          existing.isRestricted
        );

        const updatedRows = await tx
          .update(this.tables.stories)
          .set(buildSetPayload())
          .where(this.readableStoryScope(communityId, storyId))
          .returning({ id: this.tables.stories.id });

        if (updatedRows.length === 0) {
          return 'not_found';
        }

        if (
          input.visibility !== undefined &&
          input.visibility !== previousVisibility
        ) {
          const audit = buildStoryVisibilityAuditEntry(
            communityId,
            actorId,
            storyId,
            input.visibility
          );
          await tx.insert(this.tables.auditEntries).values({
            ...audit,
            createdAt: now,
          });
        }

        return 'updated';
      });
    }

    // better-sqlite3 transactions are synchronous
    return this.db.transaction((tx: typeof this.db) => {
      const existing = tx
        .select({ id: this.tables.stories.id })
        .from(this.tables.stories)
        .where(this.readableStoryScope(communityId, storyId))
        .limit(1)
        .get() as { id: number } | undefined;
      if (!existing) {
        return 'not_found';
      }

      if (
        input.interviewLocationId !== undefined &&
        input.interviewLocationId !== null
      ) {
        const place = tx
          .select({ id: this.tables.places.id })
          .from(this.tables.places)
          .where(
            and(
              eq(this.tables.places.id, input.interviewLocationId),
              eq(this.tables.places.communityId, communityId),
              eq(this.tables.places.isRestricted, false)
            )
          )
          .get();
        if (!place) {
          return 'invalid_reference';
        }
      }
      if (input.interviewerId !== undefined && input.interviewerId !== null) {
        const speaker = tx
          .select({ id: this.tables.speakers.id })
          .from(this.tables.speakers)
          .where(
            and(
              eq(this.tables.speakers.id, input.interviewerId),
              eq(this.tables.speakers.communityId, communityId)
            )
          )
          .get();
        if (!speaker) {
          return 'invalid_reference';
        }
      }

      if (input.visibility !== undefined) {
        buildConditionalAuditInsert(tx, input.visibility).run();
      }

      const updated = tx
        .update(this.tables.stories)
        .set(buildSetPayload())
        .where(this.readableStoryScope(communityId, storyId))
        .returning({ id: this.tables.stories.id })
        .all();

      return updated.length > 0 ? 'updated' : 'not_found';
    });
  }

  async deleteStory(
    communityId: number,
    storyId: number,
    removedFiles?: FileByteCleanup[]
  ): Promise<boolean> {
    const readableScope = this.readableStoryScope(communityId, storyId);
    const physicalScope = this.physicalStoryScope(communityId, storyId);

    const collectFiles = (rows: unknown) => {
      if (removedFiles) removedFiles.push(...toFileByteCleanups(rows as never));
    };

    // Candidates for byte cleanup are the attachments actually deleted in
    // this transaction/batch (DELETE ... RETURNING file_id), so a relation
    // inserted and cascaded away within this very operation is included.

    const buildDeleteAttachments = (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      executor: any
    ) =>
      executor
        .delete(this.tables.attachments)
        .where(
          and(
            eq(this.tables.attachments.communityId, communityId),
            eq(this.tables.attachments.ownerType, 'story'),
            eq(this.tables.attachments.ownerId, storyId),
            notExists(
              executor
                .select({ one: sql`1` })
                .from(this.tables.stories)
                .where(physicalScope)
            )
          )
        )
        .returning({ fileId: this.tables.attachments.fileId });

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

    if (this.hasD1Batch()) {
      const deleteStoryQuery = this.db
        .delete(this.tables.stories)
        .where(readableScope)
        .returning({ id: this.tables.stories.id });
      const deleteAttachmentsQuery = buildDeleteAttachments(this.db);

      // One atomic batch for the relational delete: owner, attachments with
      // RETURNING (so the file-cleanup candidates come from the rows actually
      // deleted, including any racer cascaded away here), then the files purge
      // in a follow-up batch keyed off those RETURNING ids.
      const [deletedRows, deletedAttachments] = await this.db.batch([
        deleteStoryQuery,
        deleteAttachmentsQuery,
      ]);
      if (!Array.isArray(deletedRows) || deletedRows.length === 0) {
        return false;
      }
      const fileIds = fileIdsOf(deletedAttachments);
      if (fileIds.length === 0) {
        return true;
      }
      const fileResults = await this.db.batch(
        buildUnreferencedFilesDelete(this.db, this.connection, fileIds)
      );
      collectFiles(
        fileResults.flatMap((rows: unknown) =>
          Array.isArray(rows) ? rows : []
        )
      );
      return true;
    }

    if (dialectOf(this.connection) === 'postgresql') {
      return this.db.transaction(async (tx: typeof this.db) => {
        const deleted = await tx
          .delete(this.tables.stories)
          .where(readableScope)
          .returning({ id: this.tables.stories.id });
        if (deleted.length === 0) {
          return false;
        }
        const deletedAttachments = await buildDeleteAttachments(tx);
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
        return true;
      });
    }

    // better-sqlite3 transactions are synchronous
    return this.db.transaction((tx: typeof this.db) => {
      const deleted = tx
        .delete(this.tables.stories)
        .where(readableScope)
        .returning({ id: this.tables.stories.id })
        .all();
      if (deleted.length === 0) {
        return false;
      }
      const deletedAttachments = buildDeleteAttachments(tx).all();
      const fileIds = fileIdsOf(deletedAttachments);
      collectFiles(
        buildUnreferencedFilesDelete(tx, this.connection, fileIds).flatMap(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (statement: any) => statement.returning().all()
        )
      );
      return true;
    });
  }

  private buildD1EdgeInsertStatements(
    edgeKind: 'places' | 'speakers',
    communityId: number,
    storyRef:
      | { slug: string; createdBy: number; createdAtMs: number }
      | { storyId: number },
    targetIds: ReadonlyArray<number>,
    nowMs: number
  ) {
    if (targetIds.length === 0) {
      return [];
    }
    const entries = targetIds.map((targetId, sortOrder) => ({
      sortOrder,
      targetId,
    }));
    const storyFilter =
      'slug' in storyRef
        ? sql`s.community_id = ${communityId} AND s.slug = ${storyRef.slug} AND s.created_by = ${storyRef.createdBy} AND s.created_at = ${storyRef.createdAtMs} AND s.is_restricted = 0 AND s.privacy_level IN ('public', 'members_only', 'editors')`
        : sql`s.id = ${storyRef.storyId} AND s.community_id = ${communityId} AND s.is_restricted = 0 AND s.privacy_level IN ('public', 'members_only', 'editors')`;

    return chunkArray(entries, D1_EDGE_INSERT_CHUNK_SIZE).map((chunk) => {
      const unionValues = sql.join(
        chunk.map(
          (entry) =>
            sql`SELECT ${entry.sortOrder} AS sort_order, ${entry.targetId} AS target_id`
        ),
        sql` UNION ALL `
      );
      if (edgeKind === 'places') {
        return this.db.insert(this.tables.storyPlaces).select(sql`
          SELECT NULL, s.community_id, s.id, p.id, NULL, v.sort_order, ${nowMs}, ${nowMs}
          FROM (${unionValues}) AS v
          JOIN stories s ON ${storyFilter}
          LEFT JOIN places p ON p.community_id = s.community_id AND p.id = v.target_id AND p.is_restricted = 0
        `);
      }
      return this.db.insert(this.tables.storySpeakers).select(sql`
        SELECT NULL, s.community_id, s.id, sp.id, NULL, v.sort_order, ${nowMs}, ${nowMs}
        FROM (${unionValues}) AS v
        JOIN stories s ON ${storyFilter}
        LEFT JOIN speakers sp ON sp.community_id = s.community_id AND sp.id = v.target_id
      `);
    });
  }

  private async replaceStoryEdges(
    edgeKind: 'places' | 'speakers',
    communityId: number,
    storyId: number,
    targetIds: ReadonlyArray<number>,
    now: Date = new Date()
  ): Promise<StoryUpdateOutcome> {
    const readableScope = this.readableStoryScope(communityId, storyId);
    const edgeTable =
      edgeKind === 'places'
        ? this.tables.storyPlaces
        : this.tables.storySpeakers;
    const targetColumnName = edgeKind === 'places' ? 'placeId' : 'speakerId';

    if (this.hasD1Batch()) {
      const nowMs = now.getTime();
      const deleteExisting = this.db.delete(edgeTable).where(
        and(
          eq(edgeTable.communityId, communityId),
          eq(edgeTable.storyId, storyId),
          exists(
            this.db
              .select({ one: sql`1` })
              .from(this.tables.stories)
              .where(readableScope)
          )
        )
      );
      const insertStatements = this.buildD1EdgeInsertStatements(
        edgeKind,
        communityId,
        { storyId },
        targetIds,
        nowMs
      );
      const touchStory = this.db
        .update(this.tables.stories)
        .set({ updatedAt: now })
        .where(readableScope)
        .returning({ id: this.tables.stories.id });

      const results = await this.db.batch([
        deleteExisting,
        ...insertStatements,
        touchStory,
      ]);
      const updatedRows = results[results.length - 1];
      return Array.isArray(updatedRows) && updatedRows.length > 0
        ? 'updated'
        : 'not_found';
    }

    const buildEdgeRows = () =>
      targetIds.map((targetId, sortOrder) => ({
        communityId,
        storyId,
        [targetColumnName]: targetId,
        sortOrder,
        createdAt: now,
        updatedAt: now,
      }));

    if (dialectOf(this.connection) === 'postgresql') {
      return this.db.transaction(async (tx: typeof this.db) => {
        const existingRows = await tx
          .select({ id: this.tables.stories.id })
          .from(this.tables.stories)
          .where(readableScope)
          .limit(1)
          .for('update');
        if (existingRows.length === 0) {
          return 'not_found';
        }

        if (targetIds.length > 0) {
          const found =
            edgeKind === 'places'
              ? await this.findExistingUnrestrictedPlaceIds(
                  communityId,
                  targetIds,
                  tx,
                  true
                )
              : await this.findExistingSpeakerIds(
                  communityId,
                  targetIds,
                  tx,
                  true
                );
          if (targetIds.some((id) => !found.has(id))) {
            return 'invalid_reference';
          }
        }

        await tx
          .delete(edgeTable)
          .where(
            and(
              eq(edgeTable.communityId, communityId),
              eq(edgeTable.storyId, storyId)
            )
          );

        if (targetIds.length > 0) {
          await tx.insert(edgeTable).values(buildEdgeRows());
        }

        await tx
          .update(this.tables.stories)
          .set({ updatedAt: now })
          .where(readableScope);

        return 'updated';
      });
    }

    // better-sqlite3 transactions are synchronous
    return this.db.transaction((tx: typeof this.db) => {
      const existing = tx
        .select({ id: this.tables.stories.id })
        .from(this.tables.stories)
        .where(readableScope)
        .limit(1)
        .get() as { id: number } | undefined;
      if (!existing) {
        return 'not_found';
      }

      if (targetIds.length > 0) {
        const uniqueTargets = Array.from(new Set(targetIds));
        const found = new Set<number>();
        for (const chunk of chunkArray(
          uniqueTargets,
          D1_IN_CLAUSE_CHUNK_SIZE
        )) {
          const rows =
            edgeKind === 'places'
              ? (tx
                  .select({ id: this.tables.places.id })
                  .from(this.tables.places)
                  .where(
                    and(
                      eq(this.tables.places.communityId, communityId),
                      eq(this.tables.places.isRestricted, false),
                      inArray(this.tables.places.id, chunk)
                    )
                  )
                  .all() as Array<{ id: number }>)
              : (tx
                  .select({ id: this.tables.speakers.id })
                  .from(this.tables.speakers)
                  .where(
                    and(
                      eq(this.tables.speakers.communityId, communityId),
                      inArray(this.tables.speakers.id, chunk)
                    )
                  )
                  .all() as Array<{ id: number }>);
          for (const row of rows) {
            found.add(row.id);
          }
        }
        if (uniqueTargets.some((id) => !found.has(id))) {
          return 'invalid_reference';
        }
      }

      tx.delete(edgeTable)
        .where(
          and(
            eq(edgeTable.communityId, communityId),
            eq(edgeTable.storyId, storyId)
          )
        )
        .run();

      if (targetIds.length > 0) {
        tx.insert(edgeTable).values(buildEdgeRows()).run();
      }

      tx.update(this.tables.stories)
        .set({ updatedAt: now })
        .where(readableScope)
        .run();

      return 'updated';
    });
  }

  replaceStoryPlaces(
    communityId: number,
    storyId: number,
    placeIds: ReadonlyArray<number>,
    now: Date = new Date()
  ): Promise<StoryUpdateOutcome> {
    return this.replaceStoryEdges(
      'places',
      communityId,
      storyId,
      placeIds,
      now
    );
  }

  replaceStorySpeakers(
    communityId: number,
    storyId: number,
    speakerIds: ReadonlyArray<number>,
    now: Date = new Date()
  ): Promise<StoryUpdateOutcome> {
    return this.replaceStoryEdges(
      'speakers',
      communityId,
      storyId,
      speakerIds,
      now
    );
  }

  private async listStoryExternalLinks(
    communityId: number,
    storyId: number,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    executor: any = this.db
  ): Promise<ExternalMediaLinkRow[]> {
    return executor
      .select({
        id: this.tables.externalMediaLinks.id,
        url: this.tables.externalMediaLinks.url,
        ordinal: this.tables.externalMediaLinks.ordinal,
        createdAt: this.tables.externalMediaLinks.createdAt,
      })
      .from(this.tables.externalMediaLinks)
      .where(
        and(
          eq(this.tables.externalMediaLinks.communityId, communityId),
          eq(this.tables.externalMediaLinks.storyId, storyId)
        )
      )
      .orderBy(
        asc(this.tables.externalMediaLinks.ordinal),
        asc(this.tables.externalMediaLinks.id)
      );
  }

  async findStoryExternalLinkIds(
    communityId: number,
    storyId: number
  ): Promise<number[]> {
    const rows = await this.db
      .select({ id: this.tables.externalMediaLinks.id })
      .from(this.tables.externalMediaLinks)
      .where(
        and(
          eq(this.tables.externalMediaLinks.communityId, communityId),
          eq(this.tables.externalMediaLinks.storyId, storyId)
        )
      )
      .orderBy(
        asc(this.tables.externalMediaLinks.ordinal),
        asc(this.tables.externalMediaLinks.id)
      );
    return (rows as Array<{ id: number }>).map((r) => r.id);
  }

  async addExternalLink(
    communityId: number,
    storyId: number,
    input: { url: string; ordinal?: number },
    maxLinks: number,
    now: Date = new Date()
  ): Promise<AddExternalLinkOutcome> {
    const readableScope = this.readableStoryScope(communityId, storyId);

    if (this.hasD1Batch()) {
      const nowMs = now.getTime();
      const ordinalExpr =
        input.ordinal !== undefined
          ? sql`${input.ordinal}`
          : sql`(SELECT COALESCE(MAX(eml.ordinal), -1) + 1 FROM external_media_links AS eml WHERE eml.community_id = ${communityId} AND eml.story_id = ${storyId})`;

      const insertLink = this.db
        .insert(this.tables.externalMediaLinks)
        .select(
          this.db
            .select({
              id: sql`NULL`.as('id'),
              communityId: this.tables.stories.communityId,
              storyId: this.tables.stories.id,
              url: sql`${input.url}`.as('url'),
              ordinal: ordinalExpr.as('ordinal'),
              createdAt: sql`${nowMs}`.as('created_at'),
            })
            .from(this.tables.stories)
            .where(
              and(
                readableScope,
                sql`(SELECT COUNT(*) FROM external_media_links AS eml WHERE eml.community_id = ${communityId} AND eml.story_id = ${storyId}) < ${maxLinks}`
              )
            )
        )
        .returning({
          id: this.tables.externalMediaLinks.id,
          url: this.tables.externalMediaLinks.url,
          ordinal: this.tables.externalMediaLinks.ordinal,
          createdAt: this.tables.externalMediaLinks.createdAt,
        });

      const touchStory = this.db
        .update(this.tables.stories)
        .set({ updatedAt: now })
        .where(readableScope);

      const readableCheck = this.db
        .select({ id: this.tables.stories.id })
        .from(this.tables.stories)
        .where(readableScope)
        .limit(1);

      const [insertedRows, , readableRows] = await this.db.batch([
        insertLink,
        touchStory,
        readableCheck,
      ]);

      const created = Array.isArray(insertedRows) ? insertedRows[0] : undefined;
      if (created) {
        return { status: 'created', link: created as ExternalMediaLinkRow };
      }
      return Array.isArray(readableRows) && readableRows.length > 0
        ? { status: 'limit_exceeded' }
        : { status: 'not_found' };
    }

    if (dialectOf(this.connection) === 'postgresql') {
      return this.db.transaction(async (tx: typeof this.db) => {
        const existingStory = await tx
          .select({ id: this.tables.stories.id })
          .from(this.tables.stories)
          .where(readableScope)
          .limit(1)
          .for('update');
        if (existingStory.length === 0) {
          return { status: 'not_found' };
        }

        const currentLinks = await tx
          .select({ ordinal: this.tables.externalMediaLinks.ordinal })
          .from(this.tables.externalMediaLinks)
          .where(
            and(
              eq(this.tables.externalMediaLinks.communityId, communityId),
              eq(this.tables.externalMediaLinks.storyId, storyId)
            )
          );
        if (currentLinks.length >= maxLinks) {
          return { status: 'limit_exceeded' };
        }

        const nextOrdinal =
          input.ordinal ??
          currentLinks.reduce(
            (maxVal: number, row: { ordinal: number }) =>
              Math.max(maxVal, row.ordinal),
            -1
          ) + 1;

        const inserted = await tx
          .insert(this.tables.externalMediaLinks)
          .values({
            communityId,
            storyId,
            url: input.url,
            ordinal: nextOrdinal,
            createdAt: now,
          })
          .returning({
            id: this.tables.externalMediaLinks.id,
            url: this.tables.externalMediaLinks.url,
            ordinal: this.tables.externalMediaLinks.ordinal,
            createdAt: this.tables.externalMediaLinks.createdAt,
          });

        await tx
          .update(this.tables.stories)
          .set({ updatedAt: now })
          .where(readableScope);

        return {
          status: 'created',
          link: inserted[0] as ExternalMediaLinkRow,
        };
      });
    }

    // better-sqlite3 transactions are synchronous
    return this.db.transaction((tx: typeof this.db) => {
      const existingStory = tx
        .select({ id: this.tables.stories.id })
        .from(this.tables.stories)
        .where(readableScope)
        .limit(1)
        .get() as { id: number } | undefined;
      if (!existingStory) {
        return { status: 'not_found' };
      }

      const currentLinks = tx
        .select({ ordinal: this.tables.externalMediaLinks.ordinal })
        .from(this.tables.externalMediaLinks)
        .where(
          and(
            eq(this.tables.externalMediaLinks.communityId, communityId),
            eq(this.tables.externalMediaLinks.storyId, storyId)
          )
        )
        .all() as Array<{ ordinal: number }>;
      if (currentLinks.length >= maxLinks) {
        return { status: 'limit_exceeded' };
      }

      const nextOrdinal =
        input.ordinal ??
        currentLinks.reduce(
          (maxVal, row) => Math.max(maxVal, row.ordinal),
          -1
        ) + 1;

      const created = tx
        .insert(this.tables.externalMediaLinks)
        .values({
          communityId,
          storyId,
          url: input.url,
          ordinal: nextOrdinal,
          createdAt: now,
        })
        .returning({
          id: this.tables.externalMediaLinks.id,
          url: this.tables.externalMediaLinks.url,
          ordinal: this.tables.externalMediaLinks.ordinal,
          createdAt: this.tables.externalMediaLinks.createdAt,
        })
        .get() as ExternalMediaLinkRow;

      tx.update(this.tables.stories)
        .set({ updatedAt: now })
        .where(readableScope)
        .run();

      return { status: 'created', link: created };
    });
  }

  async reorderExternalLinks(
    communityId: number,
    storyId: number,
    linkIds: ReadonlyArray<number>,
    now: Date = new Date()
  ): Promise<ReorderExternalLinksOutcome> {
    const readableScope = this.readableStoryScope(communityId, storyId);

    if (this.hasD1Batch()) {
      const permutationGuard =
        linkIds.length === 0
          ? sql`(SELECT COUNT(*) FROM external_media_links WHERE community_id = ${communityId} AND story_id = ${storyId}) = 0`
          : and(
              sql`(SELECT COUNT(*) FROM external_media_links WHERE community_id = ${communityId} AND story_id = ${storyId}) = ${linkIds.length}`,
              sql`(SELECT COUNT(*) FROM external_media_links WHERE community_id = ${communityId} AND story_id = ${storyId} AND id IN (${sql.join(
                linkIds.map((id) => sql`${id}`),
                sql`, `
              )})) = ${linkIds.length}`
            );

      const updateQueries = linkIds.map((linkId, ordinal) =>
        this.db
          .update(this.tables.externalMediaLinks)
          .set({ ordinal })
          .where(
            and(
              eq(this.tables.externalMediaLinks.id, linkId),
              eq(this.tables.externalMediaLinks.communityId, communityId),
              eq(this.tables.externalMediaLinks.storyId, storyId),
              exists(
                this.db
                  .select({ one: sql`1` })
                  .from(this.tables.stories)
                  .where(readableScope)
              ),
              permutationGuard
            )
          )
          .returning({ id: this.tables.externalMediaLinks.id })
      );

      const touchStory = this.db
        .update(this.tables.stories)
        .set({ updatedAt: now })
        .where(and(readableScope, permutationGuard))
        .returning({ id: this.tables.stories.id });

      const fetchLinks = this.db
        .select({
          id: this.tables.externalMediaLinks.id,
          url: this.tables.externalMediaLinks.url,
          ordinal: this.tables.externalMediaLinks.ordinal,
          createdAt: this.tables.externalMediaLinks.createdAt,
        })
        .from(this.tables.externalMediaLinks)
        .where(
          and(
            eq(this.tables.externalMediaLinks.communityId, communityId),
            eq(this.tables.externalMediaLinks.storyId, storyId)
          )
        )
        .orderBy(
          asc(this.tables.externalMediaLinks.ordinal),
          asc(this.tables.externalMediaLinks.id)
        );

      const readableCheck = this.db
        .select({ id: this.tables.stories.id })
        .from(this.tables.stories)
        .where(readableScope)
        .limit(1);

      const results = await this.db.batch([
        ...updateQueries,
        touchStory,
        fetchLinks,
        readableCheck,
      ]);

      const touchRows = results[updateQueries.length];
      const links = results[updateQueries.length + 1];
      const readableRows = results[updateQueries.length + 2];

      if (!Array.isArray(readableRows) || readableRows.length === 0) {
        return { status: 'not_found' };
      }
      if (!Array.isArray(touchRows) || touchRows.length === 0) {
        return { status: 'conflict' };
      }
      return {
        status: 'reordered',
        links: Array.isArray(links) ? (links as ExternalMediaLinkRow[]) : [],
      };
    }

    const isPermutationMatch = (existingIds: number[]): boolean => {
      if (existingIds.length !== linkIds.length) {
        return false;
      }
      const provided = new Set(linkIds);
      return existingIds.every((id) => provided.has(id));
    };

    if (dialectOf(this.connection) === 'postgresql') {
      return this.db.transaction(async (tx: typeof this.db) => {
        const existingStory = await tx
          .select({ id: this.tables.stories.id })
          .from(this.tables.stories)
          .where(readableScope)
          .limit(1)
          .for('update');
        if (existingStory.length === 0) {
          return { status: 'not_found' };
        }

        const existingLinks = await this.listStoryExternalLinks(
          communityId,
          storyId,
          tx
        );
        if (!isPermutationMatch(existingLinks.map((l) => l.id))) {
          return { status: 'conflict' };
        }

        for (let ordinal = 0; ordinal < linkIds.length; ordinal += 1) {
          await tx
            .update(this.tables.externalMediaLinks)
            .set({ ordinal })
            .where(
              and(
                eq(this.tables.externalMediaLinks.id, linkIds[ordinal]!),
                eq(this.tables.externalMediaLinks.communityId, communityId),
                eq(this.tables.externalMediaLinks.storyId, storyId)
              )
            );
        }

        await tx
          .update(this.tables.stories)
          .set({ updatedAt: now })
          .where(readableScope);

        const updatedLinks = await this.listStoryExternalLinks(
          communityId,
          storyId,
          tx
        );
        return { status: 'reordered', links: updatedLinks };
      });
    }

    // better-sqlite3 transactions are synchronous
    return this.db.transaction((tx: typeof this.db) => {
      const existingStory = tx
        .select({ id: this.tables.stories.id })
        .from(this.tables.stories)
        .where(readableScope)
        .limit(1)
        .get() as { id: number } | undefined;
      if (!existingStory) {
        return { status: 'not_found' };
      }

      const existingRows = tx
        .select({ id: this.tables.externalMediaLinks.id })
        .from(this.tables.externalMediaLinks)
        .where(
          and(
            eq(this.tables.externalMediaLinks.communityId, communityId),
            eq(this.tables.externalMediaLinks.storyId, storyId)
          )
        )
        .all() as Array<{ id: number }>;

      if (!isPermutationMatch(existingRows.map((r) => r.id))) {
        return { status: 'conflict' };
      }

      for (let ordinal = 0; ordinal < linkIds.length; ordinal += 1) {
        tx.update(this.tables.externalMediaLinks)
          .set({ ordinal })
          .where(
            and(
              eq(this.tables.externalMediaLinks.id, linkIds[ordinal]!),
              eq(this.tables.externalMediaLinks.communityId, communityId),
              eq(this.tables.externalMediaLinks.storyId, storyId)
            )
          )
          .run();
      }

      tx.update(this.tables.stories)
        .set({ updatedAt: now })
        .where(readableScope)
        .run();

      const updatedLinks = tx
        .select({
          id: this.tables.externalMediaLinks.id,
          url: this.tables.externalMediaLinks.url,
          ordinal: this.tables.externalMediaLinks.ordinal,
          createdAt: this.tables.externalMediaLinks.createdAt,
        })
        .from(this.tables.externalMediaLinks)
        .where(
          and(
            eq(this.tables.externalMediaLinks.communityId, communityId),
            eq(this.tables.externalMediaLinks.storyId, storyId)
          )
        )
        .orderBy(
          asc(this.tables.externalMediaLinks.ordinal),
          asc(this.tables.externalMediaLinks.id)
        )
        .all() as ExternalMediaLinkRow[];

      return { status: 'reordered', links: updatedLinks };
    });
  }

  async deleteExternalLink(
    communityId: number,
    storyId: number,
    linkId: number,
    now: Date = new Date()
  ): Promise<boolean> {
    const readableScope = this.readableStoryScope(communityId, storyId);
    const linkScope = and(
      eq(this.tables.externalMediaLinks.id, linkId),
      eq(this.tables.externalMediaLinks.communityId, communityId),
      eq(this.tables.externalMediaLinks.storyId, storyId)
    );

    if (this.hasD1Batch()) {
      const touchStory = this.db
        .update(this.tables.stories)
        .set({ updatedAt: now })
        .where(
          and(
            readableScope,
            exists(
              this.db
                .select({ one: sql`1` })
                .from(this.tables.externalMediaLinks)
                .where(linkScope)
            )
          )
        );
      const deleteLink = this.db
        .delete(this.tables.externalMediaLinks)
        .where(
          and(
            linkScope,
            exists(
              this.db
                .select({ one: sql`1` })
                .from(this.tables.stories)
                .where(readableScope)
            )
          )
        )
        .returning({ id: this.tables.externalMediaLinks.id });

      const [, deletedRows] = await this.db.batch([touchStory, deleteLink]);
      return Array.isArray(deletedRows) && deletedRows.length > 0;
    }

    if (dialectOf(this.connection) === 'postgresql') {
      return this.db.transaction(async (tx: typeof this.db) => {
        const deleted = await tx
          .delete(this.tables.externalMediaLinks)
          .where(
            and(
              linkScope,
              exists(
                tx
                  .select({ one: sql`1` })
                  .from(this.tables.stories)
                  .where(readableScope)
              )
            )
          )
          .returning({ id: this.tables.externalMediaLinks.id });
        if (deleted.length === 0) {
          return false;
        }
        await tx
          .update(this.tables.stories)
          .set({ updatedAt: now })
          .where(readableScope);
        return true;
      });
    }

    // better-sqlite3 transactions are synchronous
    return this.db.transaction((tx: typeof this.db) => {
      const deleted = tx
        .delete(this.tables.externalMediaLinks)
        .where(
          and(
            linkScope,
            exists(
              tx
                .select({ one: sql`1` })
                .from(this.tables.stories)
                .where(readableScope)
            )
          )
        )
        .returning({ id: this.tables.externalMediaLinks.id })
        .all();
      if (deleted.length === 0) {
        return false;
      }
      tx.update(this.tables.stories)
        .set({ updatedAt: now })
        .where(readableScope)
        .run();
      return true;
    });
  }
}
