/**
 * Installation bootstrap data access (Slice 11b-B, #188; SPEC-V2 §4, §6.8,
 * §7 "Bootstrap and account lifecycle"; route registry §1).
 *
 * Atomically checks that installation bootstrap has never run and no
 * communities/users exist, writes the singleton `installation_bootstrap` row,
 * creates the initial community and administrator account, inserts 10 single-use
 * recovery codes, creates the initial session, and records a content-free
 * system-level AuditEntry (`communityId: null`).
 */
import { and, eq, sql } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import type { Database } from '../db/index.js';
import { dialectOf, tablesFor } from '../db/dialect.js';
import {
  communityFromPhysical,
  communityVisibilityToPhysical,
  type CommunityVisibility,
} from '../policy/canonical-state.js';
import type { SessionKind } from '../shared/auth-policy.js';
import {
  validateContentFreeAuditEntry,
  type ValidatedAuditEntryRecord,
} from '../shared/utils/audit-entry.js';
import { buildAuditEntryInsert } from './audit-entry.repository.js';
import type { VerifierWrite } from './hono-auth.repository.js';

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
      const canonical = communityFromPhysical({
        publicStories: isTrue(commRow.publicStories),
        isActive: isTrue(commRow.isActive),
      });
      return {
        outcome: 'bootstrapped',
        community: {
          id: Number(commRow.id),
          name: String(commRow.name),
          slug: String(commRow.slug),
          description:
            commRow.description === null ? null : String(commRow.description),
          locale: String(commRow.locale),
          country: commRow.country === null ? null : String(commRow.country),
          visibility: canonical.visibility,
          status: 'active',
          createdAt: toDate(commRow.createdAt as Date | number),
          updatedAt: toDate(commRow.updatedAt as Date | number),
        },
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
          const canonical = communityFromPhysical({
            publicStories: isTrue(commRow.publicStories),
            isActive: isTrue(commRow.isActive),
          });
          return {
            outcome: 'bootstrapped',
            community: {
              id: communityId,
              name: String(commRow.name),
              slug: String(commRow.slug),
              description:
                commRow.description === null
                  ? null
                  : String(commRow.description),
              locale: String(commRow.locale),
              country:
                commRow.country === null ? null : String(commRow.country),
              visibility: canonical.visibility,
              status: 'active',
              createdAt: toDate(commRow.createdAt as Date | number),
              updatedAt: toDate(commRow.updatedAt as Date | number),
            },
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
      const canonical = communityFromPhysical({
        publicStories: isTrue(commRow.publicStories),
        isActive: isTrue(commRow.isActive),
      });
      return {
        outcome: 'bootstrapped',
        community: {
          id: communityId,
          name: String(commRow.name),
          slug: String(commRow.slug),
          description:
            commRow.description === null ? null : String(commRow.description),
          locale: String(commRow.locale),
          country: commRow.country === null ? null : String(commRow.country),
          visibility: canonical.visibility,
          status: 'active',
          createdAt: toDate(commRow.createdAt as Date | number),
          updatedAt: toDate(commRow.updatedAt as Date | number),
        },
        userId,
      };
    });
  }
}
