/**
 * Installation bootstrap and hosted community claim data access (Slice 11b-B
 * and 11b-C, #188; SPEC-V2 §4, §6.2, §6.8, §7 "Bootstrap and account
 * lifecycle"; route registry §1).
 */
import { and, eq, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import type { Database } from '../db/index.js';
import { dialectOf, tablesFor } from '../db/dialect.js';
import {
  communityFromPhysical,
  communityVisibilityToPhysical,
  type CommunityVisibility,
} from '../policy/canonical-state.js';
import {
  CLAIM_TOKEN_MAX_TTL_MS,
  type SessionKind,
} from '../shared/auth-policy.js';
import { constantTimeEqual } from '../shared/auth-crypto.js';
import {
  validateContentFreeAuditEntry,
  type ValidatedAuditEntryRecord,
} from '../shared/utils/audit-entry.js';
import { buildAuditEntryInsert } from './audit-entry.repository.js';
import type { VerifierWrite } from './hono-auth.repository.js';
import { isUniqueConstraintError } from './user-management.repository.js';

export interface BootstrapCommunityCreated {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  locale: string;
  country: string | null;
  visibility: CommunityVisibility;
  status: 'active';
  createdAt: Date;
  updatedAt: Date;
}

export interface BootstrapExecutionInput {
  community: {
    name: string;
    slug: string;
    description: string | null;
    descriptionPlain: string | null;
    locale: string;
    country: string | null;
    visibility: CommunityVisibility;
  };
  admin: {
    username: string;
    usernameNormalized: string;
    email: string;
    emailNormalized: string;
    displayName: string | null;
    passwordHash: string;
    verifier: VerifierWrite;
  };
  recoveryCodeHashes: string[];
  session: {
    tokenHash: string;
    kind: SessionKind;
    idleExpiresAtMs: number;
    absoluteExpiresAtMs: number;
  };
  now: Date;
}

export type CompleteBootstrapResult =
  | {
      outcome: 'bootstrapped';
      community: BootstrapCommunityCreated;
      userId: number;
    }
  | { outcome: 'already_closed' };

export interface ClaimTokenLookup {
  id: number;
  communityId: number;
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
  consumedAt: number | null;
  supersededAt: number | null;
  communityIsActive: boolean;
  communityName: string;
  communitySlug: string;
  communityDescription: string | null;
  communityLocale: string;
  communityCountry: string | null;
  communityPublicStories: boolean;
  communityCreatedAt: Date;
  communityUpdatedAt: Date;
}

export interface ClaimExecutionInput {
  claimTokenId: number;
  tokenHash: string;
  communityId: number;
  /** Optional pre-read community snapshot used to avoid a post-commit read. */
  community?: {
    id: number;
    name: string;
    slug: string;
    description: string | null;
    locale: string;
    country: string | null;
    publicStories: boolean;
    isActive: boolean;
    createdAt: Date | number | string;
    updatedAt: Date | number | string;
  };
  admin: {
    username: string;
    usernameNormalized: string;
    email: string;
    emailNormalized: string;
    displayName: string | null;
    passwordHash: string;
    verifier: VerifierWrite;
  };
  recoveryCodeHashes: string[];
  session: {
    tokenHash: string;
    kind: SessionKind;
    idleExpiresAtMs: number;
    absoluteExpiresAtMs: number;
    previousHash?: string;
  };
  now: Date;
}

export type ClaimExecutionResult =
  | {
      outcome: 'claimed';
      community: BootstrapCommunityCreated;
      userId: number;
    }
  | { outcome: 'invalid_token' }
  | { outcome: 'identity_conflict' };

export interface BootstrapAuditMeta {
  ipAddress: string | null;
  userAgent: string | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Executor = any;

const isTrue = (value: unknown): boolean => value === true || value === 1;

const toDate = (value: Date | number | string): Date =>
  value instanceof Date ? value : new Date(Number(value));

export class BootstrapRepository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: any;
  private readonly tables;

  constructor(readonly connection: Database | DrizzleD1Database) {
    this.db = connection;
    this.tables = tablesFor(connection);
  }

  /**
   * True iff no `installation_bootstrap` marker row, no `communities` row, and
   * no `users` row exist. Three `LIMIT 1` lookups; fails closed on DB errors.
   */
  async isBootstrapOpen(): Promise<boolean> {
    const { installationBootstrap, communities, users } = this.tables;
    const [bootRows, commRows, userRows] = await Promise.all([
      this.db
        .select({ id: installationBootstrap.id })
        .from(installationBootstrap)
        .limit(1),
      this.db.select({ id: communities.id }).from(communities).limit(1),
      this.db.select({ id: users.id }).from(users).limit(1),
    ]);
    return (
      bootRows.length === 0 && commRows.length === 0 && userRows.length === 0
    );
  }

  /** Lookup a ClaimToken and its owning community by SHA-256 digest. */
  async findClaimTokenByHash(
    tokenHash: string
  ): Promise<ClaimTokenLookup | null> {
    const { claimTokens, communities } = this.tables;
    const rows = await this.db
      .select({
        id: claimTokens.id,
        communityId: claimTokens.communityId,
        tokenHash: claimTokens.tokenHash,
        createdAt: claimTokens.createdAt,
        expiresAt: claimTokens.expiresAt,
        consumedAt: claimTokens.consumedAt,
        supersededAt: claimTokens.supersededAt,
        communityIsActive: communities.isActive,
        communityName: communities.name,
        communitySlug: communities.slug,
        communityDescription: communities.description,
        communityLocale: communities.locale,
        communityCountry: communities.country,
        communityPublicStories: communities.publicStories,
        communityCreatedAt: communities.createdAt,
        communityUpdatedAt: communities.updatedAt,
      })
      .from(claimTokens)
      .innerJoin(communities, eq(claimTokens.communityId, communities.id))
      .where(eq(claimTokens.tokenHash, tokenHash))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      id: Number(row.id),
      communityId: Number(row.communityId),
      tokenHash: String(row.tokenHash),
      createdAt: Number(row.createdAt),
      expiresAt: Number(row.expiresAt),
      consumedAt: row.consumedAt === null ? null : Number(row.consumedAt),
      supersededAt: row.supersededAt === null ? null : Number(row.supersededAt),
      communityIsActive: isTrue(row.communityIsActive),
      communityName: String(row.communityName),
      communitySlug: String(row.communitySlug),
      communityDescription:
        row.communityDescription === null
          ? null
          : String(row.communityDescription),
      communityLocale: String(row.communityLocale),
      communityCountry:
        row.communityCountry === null ? null : String(row.communityCountry),
      communityPublicStories: isTrue(row.communityPublicStories),
      communityCreatedAt: toDate(row.communityCreatedAt as Date | number),
      communityUpdatedAt: toDate(row.communityUpdatedAt as Date | number),
    };
  }

  private async hasClaimIdentityCollision(
    input: {
      communityId: number;
      usernameNormalized: string;
      emailNormalized: string;
    },
    database: Executor = this.db
  ): Promise<boolean> {
    const { users } = this.tables;
    const rows = await database
      .select({ id: users.id })
      .from(users)
      .where(
        or(
          eq(users.usernameNormalized, input.usernameNormalized),
          eq(users.emailNormalized, input.usernameNormalized),
          and(
            eq(users.communityId, input.communityId),
            eq(users.emailNormalized, input.emailNormalized)
          ),
          and(
            isNull(users.communityId),
            eq(users.emailNormalized, input.emailNormalized)
          ),
          eq(users.usernameNormalized, input.emailNormalized)
        )
      )
      .limit(1);
    return rows.length > 0;
  }

  private hasClaimIdentityCollisionSync(
    tx: Executor,
    input: {
      communityId: number;
      usernameNormalized: string;
      emailNormalized: string;
    }
  ): boolean {
    const { users } = this.tables;
    const rows = tx
      .select({ id: users.id })
      .from(users)
      .where(
        or(
          eq(users.usernameNormalized, input.usernameNormalized),
          eq(users.emailNormalized, input.usernameNormalized),
          and(
            eq(users.communityId, input.communityId),
            eq(users.emailNormalized, input.emailNormalized)
          ),
          and(
            isNull(users.communityId),
            eq(users.emailNormalized, input.emailNormalized)
          ),
          eq(users.usernameNormalized, input.emailNormalized)
        )
      )
      .limit(1)
      .all();
    return rows.length > 0;
  }

  private async isCommunityClaimable(
    communityId: number,
    database: Executor = this.db
  ): Promise<boolean> {
    const {
      users,
      claimTokens,
      stories,
      places,
      speakers,
      files,
      attachments,
      externalMediaLinks,
      communityMapConfigs,
    } = this.tables;
    const results = await Promise.all([
      database
        .select({ id: users.id })
        .from(users)
        .where(eq(users.communityId, communityId))
        .limit(1),
      database
        .select({ id: claimTokens.id })
        .from(claimTokens)
        .where(
          and(
            eq(claimTokens.communityId, communityId),
            isNotNull(claimTokens.consumedAt)
          )
        )
        .limit(1),
      database
        .select({ id: stories.id })
        .from(stories)
        .where(eq(stories.communityId, communityId))
        .limit(1),
      database
        .select({ id: places.id })
        .from(places)
        .where(eq(places.communityId, communityId))
        .limit(1),
      database
        .select({ id: speakers.id })
        .from(speakers)
        .where(eq(speakers.communityId, communityId))
        .limit(1),
      database
        .select({ id: files.id })
        .from(files)
        .where(eq(files.communityId, communityId))
        .limit(1),
      database
        .select({ id: attachments.id })
        .from(attachments)
        .where(eq(attachments.communityId, communityId))
        .limit(1),
      database
        .select({ id: externalMediaLinks.id })
        .from(externalMediaLinks)
        .where(eq(externalMediaLinks.communityId, communityId))
        .limit(1),
      database
        .select({ communityId: communityMapConfigs.communityId })
        .from(communityMapConfigs)
        .where(eq(communityMapConfigs.communityId, communityId))
        .limit(1),
    ]);
    return results.every((rows) => rows.length === 0);
  }

  private isCommunityClaimableSync(tx: Executor, communityId: number): boolean {
    const {
      users,
      claimTokens,
      stories,
      places,
      speakers,
      files,
      attachments,
      externalMediaLinks,
      communityMapConfigs,
    } = this.tables;
    const checks = [
      tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.communityId, communityId))
        .limit(1)
        .all(),
      tx
        .select({ id: claimTokens.id })
        .from(claimTokens)
        .where(
          and(
            eq(claimTokens.communityId, communityId),
            isNotNull(claimTokens.consumedAt)
          )
        )
        .limit(1)
        .all(),
      tx
        .select({ id: stories.id })
        .from(stories)
        .where(eq(stories.communityId, communityId))
        .limit(1)
        .all(),
      tx
        .select({ id: places.id })
        .from(places)
        .where(eq(places.communityId, communityId))
        .limit(1)
        .all(),
      tx
        .select({ id: speakers.id })
        .from(speakers)
        .where(eq(speakers.communityId, communityId))
        .limit(1)
        .all(),
      tx
        .select({ id: files.id })
        .from(files)
        .where(eq(files.communityId, communityId))
        .limit(1)
        .all(),
      tx
        .select({ id: attachments.id })
        .from(attachments)
        .where(eq(attachments.communityId, communityId))
        .limit(1)
        .all(),
      tx
        .select({ id: externalMediaLinks.id })
        .from(externalMediaLinks)
        .where(eq(externalMediaLinks.communityId, communityId))
        .limit(1)
        .all(),
      tx
        .select({ communityId: communityMapConfigs.communityId })
        .from(communityMapConfigs)
        .where(eq(communityMapConfigs.communityId, communityId))
        .limit(1)
        .all(),
    ];
    return checks.every((rows) => rows.length === 0);
  }

  private toCommunityProjection(row: {
    id: number | string;
    name: string;
    slug: string;
    description: string | null;
    locale: string;
    country: string | null;
    publicStories: unknown;
    isActive: unknown;
    createdAt: Date | number | string;
    updatedAt: Date | number | string;
  }): BootstrapCommunityCreated {
    const canonical = communityFromPhysical({
      publicStories: isTrue(row.publicStories),
      isActive: isTrue(row.isActive),
    });
    return {
      id: Number(row.id),
      name: String(row.name),
      slug: String(row.slug),
      description: row.description === null ? null : String(row.description),
      locale: String(row.locale),
      country: row.country === null ? null : String(row.country),
      visibility: canonical.visibility,
      status: 'active',
      createdAt: toDate(row.createdAt),
      updatedAt: toDate(row.updatedAt),
    };
  }

  async completeInstallationBootstrapAtomically(
    input: BootstrapExecutionInput,
    auditMeta: BootstrapAuditMeta
  ): Promise<CompleteBootstrapResult> {
    // Validate the content-free audit shape synchronously before touching SQL.
    const auditTemplate: ValidatedAuditEntryRecord =
      validateContentFreeAuditEntry({
        communityId: null,
        actorId: 1,
        action: 'bootstrap.complete',
        resourceType: 'bootstrap',
        resourceIds: [1, 1],
        outcome: 'success',
        ipAddress: auditMeta.ipAddress,
        userAgent: auditMeta.userAgent,
      });

    const db = this.db;
    const {
      installationBootstrap,
      communities,
      users,
      loginCodes,
      sessions,
      auditEntries,
    } = this.tables;
    const setupId = crypto.randomUUID();
    const nowMs = input.now.getTime();
    const publicStories = communityVisibilityToPhysical(
      input.community.visibility
    );

    if (typeof db.batch === 'function') {
      const publicStoriesInt = publicStories ? 1 : 0;
      const wonGate = sql`exists (select 1 from installation_bootstrap ib where ib.id = 1 and ib.setup_id = ${setupId})`;

      const claimSingletonStmt = db
        .insert(installationBootstrap)
        .select(
          sql`select 1, ${setupId}, ${null}, ${null}, ${nowMs}
            where not exists (select 1 from installation_bootstrap)
              and not exists (select 1 from communities)
              and not exists (select 1 from users)`
        )
        .returning({ id: installationBootstrap.id });

      const insertCommunityStmt = db
        .insert(communities)
        .select(
          sql`select
            ${null}, ${input.community.name}, ${input.community.description},
            ${input.community.descriptionPlain}, ${input.community.slug},
            ${publicStoriesInt}, ${input.community.locale}, ${null}, 1,
            ${input.community.country}, 0, ${nowMs}, ${nowMs}
          where ${wonGate}`
        )
        .returning({
          id: communities.id,
          name: communities.name,
          slug: communities.slug,
          description: communities.description,
          locale: communities.locale,
          country: communities.country,
          publicStories: communities.publicStories,
          isActive: communities.isActive,
          createdAt: communities.createdAt,
          updatedAt: communities.updatedAt,
        });

      const insertAdminStmt = db
        .insert(users)
        .select(
          sql`select
            ${null}, ${input.admin.email}, ${input.admin.username},
            ${input.admin.displayName}, ${input.admin.passwordHash},
            ${input.admin.verifier.passwordVerifier},
            ${input.admin.verifier.passwordAlgorithm},
            ${input.admin.verifier.passwordSalt},
            ${input.admin.verifier.passwordParams},
            ${input.admin.usernameNormalized}, ${input.admin.emailNormalized},
            ${''}, ${''}, ${'admin'}, c.id, 1,
            ${null}, ${null}, ${null}, ${null}, 0, ${null}, ${null},
            ${nowMs}, ${nowMs}
          from communities c
          where c.slug = ${input.community.slug}
            and ${wonGate}`
        )
        .returning({ id: users.id, communityId: users.communityId });

      const updateSingletonStmt = db
        .update(installationBootstrap)
        .set({
          communityId: sql`(select id from communities where slug = ${input.community.slug})`,
          adminUserId: sql`(select id from users where username_normalized = ${input.admin.usernameNormalized} and password_hash = ${input.admin.passwordHash})`,
        })
        .where(
          and(
            eq(installationBootstrap.id, 1),
            eq(installationBootstrap.setupId, setupId)
          )
        );

      const recoveryCodeStmts = input.recoveryCodeHashes.map((codeHash) =>
        db.insert(loginCodes).select(
          sql`select
            ${null}, u.community_id, u.id, ${'recovery'}, ${codeHash}, u.id,
            ${nowMs}, ${null}, ${null}, ${null}
          from users u
          where u.username_normalized = ${input.admin.usernameNormalized}
            and u.password_hash = ${input.admin.passwordHash}
            and ${wonGate}`
        )
      );

      const insertSessionStmt = db.insert(sessions).select(
        sql`select
          ${input.session.tokenHash}, ${input.session.tokenHash}, u.id,
          ${input.session.idleExpiresAtMs}, ${input.session.kind},
          ${nowMs}, ${nowMs}, ${input.session.idleExpiresAtMs},
          ${input.session.absoluteExpiresAtMs}, ${null}, ${null}, ${null}
        from users u
        where u.username_normalized = ${input.admin.usernameNormalized}
          and u.password_hash = ${input.admin.passwordHash}
          and ${wonGate}`
      );

      const insertAuditStmt = db.insert(auditEntries).select(
        sql`select
          ${null}, ${null}, u.id, ${auditTemplate.action},
          ${auditTemplate.resourceType},
          '[' || u.community_id || ',' || u.id || ']',
          ${auditTemplate.outcome}, ${auditTemplate.ipAddress},
          ${auditTemplate.userAgent}, ${nowMs}
        from users u
        where u.username_normalized = ${input.admin.usernameNormalized}
          and u.password_hash = ${input.admin.passwordHash}
          and ${wonGate}`
      );

      const results = (await db.batch([
        claimSingletonStmt,
        insertCommunityStmt,
        insertAdminStmt,
        updateSingletonStmt,
        ...recoveryCodeStmts,
        insertSessionStmt,
        insertAuditStmt,
      ])) as Array<Array<Record<string, unknown>>>;

      const singletonRows = results[0] ?? [];
      const commRow = results[1]?.[0];
      const userRow = results[2]?.[0];
      if (singletonRows.length === 0 || !commRow || !userRow) {
        return { outcome: 'already_closed' };
      }
      return {
        outcome: 'bootstrapped',
        community: this.toCommunityProjection(
          commRow as Parameters<BootstrapRepository['toCommunityProjection']>[0]
        ),
        userId: Number(userRow.id),
      };
    }

    const communityValues = {
      name: input.community.name,
      description: input.community.description,
      descriptionPlain: input.community.descriptionPlain,
      slug: input.community.slug,
      publicStories,
      locale: input.community.locale,
      isActive: true,
      country: input.community.country,
      beta: false,
      createdAt: input.now,
      updatedAt: input.now,
    };

    const makeAdminValues = (communityId: number) => ({
      email: input.admin.email,
      username: input.admin.username,
      displayName: input.admin.displayName,
      emailNormalized: input.admin.emailNormalized,
      usernameNormalized: input.admin.usernameNormalized,
      passwordHash: input.admin.passwordHash,
      passwordVerifier: input.admin.verifier.passwordVerifier,
      passwordAlgorithm: input.admin.verifier.passwordAlgorithm,
      passwordSalt: input.admin.verifier.passwordSalt,
      passwordParams: input.admin.verifier.passwordParams,
      firstName: '',
      lastName: '',
      role: 'admin' as const,
      communityId,
      isActive: true,
      createdAt: input.now,
      updatedAt: input.now,
    });

    const makeRecoveryRows = (communityId: number, userId: number) =>
      input.recoveryCodeHashes.map((codeHash) => ({
        communityId,
        userId,
        purpose: 'recovery' as const,
        codeHash,
        createdBy: userId,
        createdAt: nowMs,
        expiresAt: null,
        usedAt: null,
        supersededAt: null,
      }));

    const makeSessionValues = (userId: number) => ({
      id: input.session.tokenHash,
      tokenHash: input.session.tokenHash,
      userId,
      expiresAt: input.session.idleExpiresAtMs,
      kind: input.session.kind,
      createdAt: nowMs,
      lastSeenAt: nowMs,
      idleExpiresAt: input.session.idleExpiresAtMs,
      absoluteExpiresAt: input.session.absoluteExpiresAtMs,
      revokedAt: null,
      revokedBy: null,
      adminCodeStepUpExpiresAt: null,
    });

    if (dialectOf(db) === 'postgresql') {
      return db.transaction(
        async (tx: Executor): Promise<CompleteBootstrapResult> => {
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtext('installation:bootstrap'))`
          );
          const [existingBoot, existingComm, existingUser] = await Promise.all([
            tx
              .select({ id: installationBootstrap.id })
              .from(installationBootstrap)
              .limit(1),
            tx.select({ id: communities.id }).from(communities).limit(1),
            tx.select({ id: users.id }).from(users).limit(1),
          ]);
          if (
            existingBoot.length > 0 ||
            existingComm.length > 0 ||
            existingUser.length > 0
          ) {
            return { outcome: 'already_closed' };
          }
          await tx.insert(installationBootstrap).values({
            id: 1,
            setupId,
            communityId: null,
            adminUserId: null,
            completedAt: nowMs,
          });
          const [commRow] = await tx
            .insert(communities)
            .values(communityValues)
            .returning();
          const communityId = Number(commRow.id);
          const [userRow] = await tx
            .insert(users)
            .values(makeAdminValues(communityId))
            .returning({ id: users.id });
          const userId = Number(userRow.id);
          await tx
            .update(installationBootstrap)
            .set({ communityId, adminUserId: userId })
            .where(eq(installationBootstrap.id, 1));
          await tx
            .insert(loginCodes)
            .values(makeRecoveryRows(communityId, userId));
          await tx.insert(sessions).values(makeSessionValues(userId));
          await buildAuditEntryInsert(tx, {
            communityId: null,
            actorId: userId,
            action: 'bootstrap.complete',
            resourceType: 'bootstrap',
            resourceIds: [communityId, userId],
            outcome: 'success',
            ipAddress: auditMeta.ipAddress,
            userAgent: auditMeta.userAgent,
          });
          return {
            outcome: 'bootstrapped',
            community: this.toCommunityProjection(commRow),
            userId,
          };
        }
      );
    }

    // better-sqlite3 synchronous transaction: callback MUST NOT return a Promise.
    return db.transaction((tx: Executor): CompleteBootstrapResult => {
      const existingBoot = tx
        .select({ id: installationBootstrap.id })
        .from(installationBootstrap)
        .limit(1)
        .all();
      const existingComm = tx
        .select({ id: communities.id })
        .from(communities)
        .limit(1)
        .all();
      const existingUser = tx
        .select({ id: users.id })
        .from(users)
        .limit(1)
        .all();
      if (
        existingBoot.length > 0 ||
        existingComm.length > 0 ||
        existingUser.length > 0
      ) {
        return { outcome: 'already_closed' };
      }
      tx.insert(installationBootstrap)
        .values({
          id: 1,
          setupId,
          communityId: null,
          adminUserId: null,
          completedAt: nowMs,
        })
        .run();
      const [commRow] = tx
        .insert(communities)
        .values(communityValues)
        .returning()
        .all();
      const communityId = Number(commRow.id);
      const [userRow] = tx
        .insert(users)
        .values(makeAdminValues(communityId))
        .returning({ id: users.id })
        .all();
      const userId = Number(userRow.id);
      tx.update(installationBootstrap)
        .set({ communityId, adminUserId: userId })
        .where(eq(installationBootstrap.id, 1))
        .run();
      tx.insert(loginCodes).values(makeRecoveryRows(communityId, userId)).run();
      tx.insert(sessions).values(makeSessionValues(userId)).run();
      buildAuditEntryInsert(tx, {
        communityId: null,
        actorId: userId,
        action: 'bootstrap.complete',
        resourceType: 'bootstrap',
        resourceIds: [communityId, userId],
        outcome: 'success',
        ipAddress: auditMeta.ipAddress,
        userAgent: auditMeta.userAgent,
      }).run();
      return {
        outcome: 'bootstrapped',
        community: this.toCommunityProjection(commRow),
        userId,
      };
    });
  }

  /**
   * Atomically claim an empty, never-administered hosted community using a
   * single-use `ClaimToken`, creating the first community administrator,
   * consuming the token (`consumed_at`, `consumed_by`), superseding sibling
   * tokens, inserting 10 recovery codes, issuing `ts_session` (revoking any
   * presented cross-user cookie), and writing a content-free community audit
   * row (`claim_token.consume`).
   */
  async claimCommunityAtomically(
    input: ClaimExecutionInput,
    auditMeta: BootstrapAuditMeta
  ): Promise<ClaimExecutionResult> {
    const auditTemplate: ValidatedAuditEntryRecord =
      validateContentFreeAuditEntry({
        communityId: input.communityId,
        actorId: 1,
        action: 'claim_token.consume',
        resourceType: 'claim_token',
        resourceIds: [input.claimTokenId, 1],
        outcome: 'success',
        ipAddress: auditMeta.ipAddress,
        userAgent: auditMeta.userAgent,
      });

    const db = this.db;
    const {
      communities,
      users,
      claimTokens,
      loginCodes,
      sessions,
      auditEntries,
    } = this.tables;
    const nowMs = input.now.getTime();

    if (typeof db.batch === 'function') {
      const claimUserCreatedGate = sql`exists (
        select 1 from users u
        where u.username_normalized = ${input.admin.usernameNormalized}
          and u.community_id = ${input.communityId}
          and u.password_hash = ${input.admin.passwordHash}
      )`;

      const insertAdminStmt = db
        .insert(users)
        .select(
          sql`select
            ${null}, ${input.admin.email}, ${input.admin.username},
            ${input.admin.displayName}, ${input.admin.passwordHash},
            ${input.admin.verifier.passwordVerifier},
            ${input.admin.verifier.passwordAlgorithm},
            ${input.admin.verifier.passwordSalt},
            ${input.admin.verifier.passwordParams},
            ${input.admin.usernameNormalized}, ${input.admin.emailNormalized},
            ${''}, ${''}, ${'admin'}, ${input.communityId}, 1,
            ${null}, ${null}, ${null}, ${null}, 0, ${null}, ${null},
            ${nowMs}, ${nowMs}
          where exists (
            select 1 from claim_tokens ct
            inner join communities c on c.id = ct.community_id
            where ct.id = ${input.claimTokenId}
              and ct.token_hash = ${input.tokenHash}
              and ct.community_id = ${input.communityId}
              and ct.consumed_at is null
              and ct.superseded_at is null
              and ct.expires_at > ${nowMs}
              and (ct.expires_at - ct.created_at) <= ${CLAIM_TOKEN_MAX_TTL_MS}
              and c.is_active = 1
          )
          and not exists (select 1 from users cu where cu.community_id = ${input.communityId})
          and not exists (select 1 from claim_tokens cct where cct.community_id = ${input.communityId} and cct.consumed_at is not null)
          and not exists (select 1 from stories s where s.community_id = ${input.communityId})
          and not exists (select 1 from places p where p.community_id = ${input.communityId})
          and not exists (select 1 from speakers sp where sp.community_id = ${input.communityId})
          and not exists (select 1 from files f where f.community_id = ${input.communityId})
          and not exists (select 1 from attachments a where a.community_id = ${input.communityId})
          and not exists (select 1 from external_media_links eml where eml.community_id = ${input.communityId})
          and not exists (select 1 from community_map_configs cmc where cmc.community_id = ${input.communityId})
          and not exists (
            select 1 from users x
            where x.username_normalized = ${input.admin.usernameNormalized}
              or x.email_normalized = ${input.admin.usernameNormalized}
              or (x.community_id = ${input.communityId} and x.email_normalized = ${input.admin.emailNormalized})
              or (x.community_id is null and x.email_normalized = ${input.admin.emailNormalized})
              or x.username_normalized = ${input.admin.emailNormalized}
          )`
        )
        .returning({ id: users.id });

      const consumeTokenStmt = db
        .update(claimTokens)
        .set({
          consumedAt: nowMs,
          consumedBy: sql`(select u.id from users u where u.username_normalized = ${input.admin.usernameNormalized} and u.community_id = ${input.communityId} and u.password_hash = ${input.admin.passwordHash})`,
        })
        .where(
          and(
            eq(claimTokens.id, input.claimTokenId),
            eq(claimTokens.tokenHash, input.tokenHash),
            eq(claimTokens.communityId, input.communityId),
            isNull(claimTokens.consumedAt),
            isNull(claimTokens.supersededAt),
            sql`${claimTokens.expiresAt} > ${nowMs}`,
            claimUserCreatedGate
          )
        )
        .returning({
          id: claimTokens.id,
          consumedBy: claimTokens.consumedBy,
        });

      const supersedeSiblingsStmt = db
        .update(claimTokens)
        .set({ supersededAt: nowMs })
        .where(
          and(
            eq(claimTokens.communityId, input.communityId),
            ne(claimTokens.id, input.claimTokenId),
            isNull(claimTokens.consumedAt),
            isNull(claimTokens.supersededAt),
            claimUserCreatedGate
          )
        );

      const recoveryCodeStmts = input.recoveryCodeHashes.map((codeHash) =>
        db.insert(loginCodes).select(
          sql`select
            ${null}, ${input.communityId}, u.id, ${'recovery'}, ${codeHash}, u.id,
            ${nowMs}, ${null}, ${null}, ${null}
          from users u
          where u.username_normalized = ${input.admin.usernameNormalized}
            and u.community_id = ${input.communityId}
            and u.password_hash = ${input.admin.passwordHash}`
        )
      );

      const insertSessionStmt = db.insert(sessions).select(
        sql`select
          ${input.session.tokenHash}, ${input.session.tokenHash}, u.id,
          ${input.session.idleExpiresAtMs}, ${input.session.kind},
          ${nowMs}, ${nowMs}, ${input.session.idleExpiresAtMs},
          ${input.session.absoluteExpiresAtMs}, ${null}, ${null}, ${null}
        from users u
        where u.username_normalized = ${input.admin.usernameNormalized}
          and u.community_id = ${input.communityId}
          and u.password_hash = ${input.admin.passwordHash}`
      );

      const statements: unknown[] = [
        insertAdminStmt,
        consumeTokenStmt,
        supersedeSiblingsStmt,
        ...recoveryCodeStmts,
        insertSessionStmt,
      ];

      if (input.session.previousHash !== undefined) {
        statements.push(
          db
            .delete(sessions)
            .where(
              and(
                eq(sessions.tokenHash, input.session.previousHash),
                sql`${sessions.userId} <> (select u.id from users u where u.username_normalized = ${input.admin.usernameNormalized} and u.community_id = ${input.communityId} and u.password_hash = ${input.admin.passwordHash})`,
                claimUserCreatedGate
              )
            )
        );
      }

      statements.push(
        db.insert(auditEntries).select(
          sql`select
            ${null}, ${input.communityId}, u.id, ${auditTemplate.action},
            ${auditTemplate.resourceType},
            '[' || ${input.claimTokenId} || ',' || u.id || ']',
            ${auditTemplate.outcome}, ${auditTemplate.ipAddress},
            ${auditTemplate.userAgent}, ${nowMs}
          from users u
          where u.username_normalized = ${input.admin.usernameNormalized}
            and u.community_id = ${input.communityId}
            and u.password_hash = ${input.admin.passwordHash}`
        )
      );

      let results: Array<Array<Record<string, unknown>>>;
      try {
        results = (await db.batch(statements)) as Array<
          Array<Record<string, unknown>>
        >;
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          return { outcome: 'identity_conflict' };
        }
        throw error;
      }

      const insertedUsers = results[0] ?? [];
      const consumedRows = results[1] ?? [];
      if (insertedUsers.length === 0 || consumedRows.length === 0) {
        const latest = await this.findClaimTokenByHash(input.tokenHash);
        const tokenValid =
          latest !== null &&
          latest.id === input.claimTokenId &&
          latest.communityId === input.communityId &&
          latest.consumedAt === null &&
          latest.supersededAt === null &&
          latest.expiresAt > nowMs &&
          latest.expiresAt - latest.createdAt <= CLAIM_TOKEN_MAX_TTL_MS &&
          latest.communityIsActive;
        if (
          tokenValid &&
          (await this.isCommunityClaimable(input.communityId)) &&
          (await this.hasClaimIdentityCollision({
            communityId: input.communityId,
            usernameNormalized: input.admin.usernameNormalized,
            emailNormalized: input.admin.emailNormalized,
          }))
        ) {
          return { outcome: 'identity_conflict' };
        }
        return { outcome: 'invalid_token' };
      }

      // Do not re-read the community after db.batch has committed: a read
      // failure there would discard the one-time recovery sheet. Prefer the
      // caller-supplied snapshot; otherwise read defensively and fall back to a
      // projection built from the input so a read failure is non-fatal.
      let commRow: Parameters<BootstrapRepository['toCommunityProjection']>[0];
      if (input.community !== undefined) {
        commRow = input.community as Parameters<
          BootstrapRepository['toCommunityProjection']
        >[0];
      } else {
        try {
          const [row] = await db
            .select({
              id: communities.id,
              name: communities.name,
              slug: communities.slug,
              description: communities.description,
              locale: communities.locale,
              country: communities.country,
              publicStories: communities.publicStories,
              isActive: communities.isActive,
              createdAt: communities.createdAt,
              updatedAt: communities.updatedAt,
            })
            .from(communities)
            .where(eq(communities.id, input.communityId))
            .limit(1);
          commRow = row as Parameters<
            BootstrapRepository['toCommunityProjection']
          >[0];
        } catch {
          commRow = {
            id: input.communityId,
            name: '',
            slug: '',
            description: null,
            locale: '',
            country: null,
            publicStories: 1,
            isActive: 1,
            createdAt: nowMs,
            updatedAt: nowMs,
          } as Parameters<BootstrapRepository['toCommunityProjection']>[0];
        }
      }
      if (commRow === undefined) {
        commRow = {
          id: input.communityId,
          name: '',
          slug: '',
          description: null,
          locale: '',
          country: null,
          publicStories: 1,
          isActive: 1,
          createdAt: nowMs,
          updatedAt: nowMs,
        } as Parameters<BootstrapRepository['toCommunityProjection']>[0];
      }

      return {
        outcome: 'claimed',
        community: this.toCommunityProjection(commRow),
        userId: Number(insertedUsers[0]!.id),
      };
    }

    const adminValues = {
      email: input.admin.email,
      username: input.admin.username,
      displayName: input.admin.displayName,
      emailNormalized: input.admin.emailNormalized,
      usernameNormalized: input.admin.usernameNormalized,
      passwordHash: input.admin.passwordHash,
      passwordVerifier: input.admin.verifier.passwordVerifier,
      passwordAlgorithm: input.admin.verifier.passwordAlgorithm,
      passwordSalt: input.admin.verifier.passwordSalt,
      passwordParams: input.admin.verifier.passwordParams,
      firstName: '',
      lastName: '',
      role: 'admin' as const,
      communityId: input.communityId,
      isActive: true,
      createdAt: input.now,
      updatedAt: input.now,
    };

    const makeRecoveryRows = (userId: number) =>
      input.recoveryCodeHashes.map((codeHash) => ({
        communityId: input.communityId,
        userId,
        purpose: 'recovery' as const,
        codeHash,
        createdBy: userId,
        createdAt: nowMs,
        expiresAt: null,
        usedAt: null,
        supersededAt: null,
      }));

    const makeSessionValues = (userId: number) => ({
      id: input.session.tokenHash,
      tokenHash: input.session.tokenHash,
      userId,
      expiresAt: input.session.idleExpiresAtMs,
      kind: input.session.kind,
      createdAt: nowMs,
      lastSeenAt: nowMs,
      idleExpiresAt: input.session.idleExpiresAtMs,
      absoluteExpiresAt: input.session.absoluteExpiresAtMs,
      revokedAt: null,
      revokedBy: null,
      adminCodeStepUpExpiresAt: null,
    });

    if (dialectOf(db) === 'postgresql') {
      try {
        return await db.transaction(
          async (tx: Executor): Promise<ClaimExecutionResult> => {
            // Lock order: communities (FOR UPDATE) -> identity advisory locks -> claim_tokens (FOR UPDATE).
            const [commRow] = await tx
              .select()
              .from(communities)
              .where(eq(communities.id, input.communityId))
              .for('update')
              .limit(1);
            if (!commRow || !isTrue(commRow.isActive)) {
              return { outcome: 'invalid_token' };
            }
            const advisoryIds = [
              ...new Set([
                input.admin.emailNormalized,
                input.admin.usernameNormalized,
              ]),
            ].sort();
            for (const identifier of advisoryIds) {
              await tx.execute(
                sql`select pg_advisory_xact_lock(hashtext('identity:' || ${identifier}))`
              );
            }
            const [tokenRow] = await tx
              .select()
              .from(claimTokens)
              .where(eq(claimTokens.id, input.claimTokenId))
              .for('update')
              .limit(1);
            if (
              !tokenRow ||
              // The row was selected by id and locked, so its digest is
              // re-verified in constant time before it is trusted (§6.8).
              !constantTimeEqual(String(tokenRow.tokenHash), input.tokenHash) ||
              Number(tokenRow.communityId) !== input.communityId ||
              tokenRow.consumedAt !== null ||
              tokenRow.supersededAt !== null ||
              Number(tokenRow.expiresAt) <= nowMs ||
              Number(tokenRow.expiresAt) - Number(tokenRow.createdAt) >
                CLAIM_TOKEN_MAX_TTL_MS
            ) {
              return { outcome: 'invalid_token' };
            }
            if (!(await this.isCommunityClaimable(input.communityId, tx))) {
              return { outcome: 'invalid_token' };
            }
            if (
              await this.hasClaimIdentityCollision(
                {
                  communityId: input.communityId,
                  usernameNormalized: input.admin.usernameNormalized,
                  emailNormalized: input.admin.emailNormalized,
                },
                tx
              )
            ) {
              return { outcome: 'identity_conflict' };
            }
            const [userRow] = await tx
              .insert(users)
              .values(adminValues)
              .returning({ id: users.id });
            const userId = Number(userRow.id);
            const consumed = await tx
              .update(claimTokens)
              .set({ consumedAt: nowMs, consumedBy: userId })
              .where(
                and(
                  eq(claimTokens.id, input.claimTokenId),
                  isNull(claimTokens.consumedAt),
                  isNull(claimTokens.supersededAt),
                  sql`${claimTokens.expiresAt} > ${nowMs}`
                )
              )
              .returning({ id: claimTokens.id });
            if (consumed.length === 0) {
              throw new Error('Concurrent claim token consumption');
            }
            await tx
              .update(claimTokens)
              .set({ supersededAt: nowMs })
              .where(
                and(
                  eq(claimTokens.communityId, input.communityId),
                  ne(claimTokens.id, input.claimTokenId),
                  isNull(claimTokens.consumedAt),
                  isNull(claimTokens.supersededAt)
                )
              );
            await tx.insert(loginCodes).values(makeRecoveryRows(userId));
            await tx.insert(sessions).values(makeSessionValues(userId));
            if (input.session.previousHash !== undefined) {
              await tx
                .delete(sessions)
                .where(
                  and(
                    eq(sessions.tokenHash, input.session.previousHash),
                    ne(sessions.userId, userId)
                  )
                );
            }
            await buildAuditEntryInsert(tx, {
              communityId: input.communityId,
              actorId: userId,
              action: 'claim_token.consume',
              resourceType: 'claim_token',
              resourceIds: [input.claimTokenId, userId],
              outcome: 'success',
              ipAddress: auditMeta.ipAddress,
              userAgent: auditMeta.userAgent,
            });
            return {
              outcome: 'claimed',
              community: this.toCommunityProjection(commRow),
              userId,
            };
          }
        );
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          return { outcome: 'identity_conflict' };
        }
        throw error;
      }
    }

    // better-sqlite3 synchronous transaction: callback MUST NOT return a Promise.
    try {
      return db.transaction((tx: Executor): ClaimExecutionResult => {
        const commRow = tx
          .select()
          .from(communities)
          .where(eq(communities.id, input.communityId))
          .limit(1)
          .all()[0];
        if (!commRow || !isTrue(commRow.isActive)) {
          return { outcome: 'invalid_token' };
        }
        const tokenRow = tx
          .select()
          .from(claimTokens)
          .where(eq(claimTokens.id, input.claimTokenId))
          .limit(1)
          .all()[0];
        if (
          !tokenRow ||
          // Re-verified in constant time after the id lookup (§6.8).
          !constantTimeEqual(String(tokenRow.tokenHash), input.tokenHash) ||
          Number(tokenRow.communityId) !== input.communityId ||
          tokenRow.consumedAt !== null ||
          tokenRow.supersededAt !== null ||
          Number(tokenRow.expiresAt) <= nowMs ||
          Number(tokenRow.expiresAt) - Number(tokenRow.createdAt) >
            CLAIM_TOKEN_MAX_TTL_MS
        ) {
          return { outcome: 'invalid_token' };
        }
        if (!this.isCommunityClaimableSync(tx, input.communityId)) {
          return { outcome: 'invalid_token' };
        }
        if (
          this.hasClaimIdentityCollisionSync(tx, {
            communityId: input.communityId,
            usernameNormalized: input.admin.usernameNormalized,
            emailNormalized: input.admin.emailNormalized,
          })
        ) {
          return { outcome: 'identity_conflict' };
        }
        const [userRow] = tx
          .insert(users)
          .values(adminValues)
          .returning({ id: users.id })
          .all();
        const userId = Number(userRow.id);
        const consumed = tx
          .update(claimTokens)
          .set({ consumedAt: nowMs, consumedBy: userId })
          .where(
            and(
              eq(claimTokens.id, input.claimTokenId),
              isNull(claimTokens.consumedAt),
              isNull(claimTokens.supersededAt),
              sql`${claimTokens.expiresAt} > ${nowMs}`
            )
          )
          .returning({ id: claimTokens.id })
          .all();
        if (consumed.length === 0) {
          return { outcome: 'invalid_token' };
        }
        tx.update(claimTokens)
          .set({ supersededAt: nowMs })
          .where(
            and(
              eq(claimTokens.communityId, input.communityId),
              ne(claimTokens.id, input.claimTokenId),
              isNull(claimTokens.consumedAt),
              isNull(claimTokens.supersededAt)
            )
          )
          .run();
        tx.insert(loginCodes).values(makeRecoveryRows(userId)).run();
        tx.insert(sessions).values(makeSessionValues(userId)).run();
        if (input.session.previousHash !== undefined) {
          tx.delete(sessions)
            .where(
              and(
                eq(sessions.tokenHash, input.session.previousHash),
                ne(sessions.userId, userId)
              )
            )
            .run();
        }
        buildAuditEntryInsert(tx, {
          communityId: input.communityId,
          actorId: userId,
          action: 'claim_token.consume',
          resourceType: 'claim_token',
          resourceIds: [input.claimTokenId, userId],
          outcome: 'success',
          ipAddress: auditMeta.ipAddress,
          userAgent: auditMeta.userAgent,
        }).run();
        return {
          outcome: 'claimed',
          community: this.toCommunityProjection(commRow),
          userId,
        };
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        return { outcome: 'identity_conflict' };
      }
      throw error;
    }
  }
}
