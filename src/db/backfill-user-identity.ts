/**
 * Idempotent app-level backfill for user normalized identity columns and
 * display_name using the shared application normaliser (`normalizeSearchText`).
 *
 * SQL migrations (SQLite 0009, PostgreSQL 0008) intentionally backfill
 * `email_normalized` ONLY for pure ASCII emails using SQL `lower()`, leaving
 * non-ASCII emails NULL because SQLite `lower()` and PostgreSQL `lower()`
 * diverge from `normalizeSearchText` (Unicode NFC + lowercase + final sigma).
 * Run `scripts/backfill-user-identity.ts` after deploying the schema migration
 * so non-ASCII accounts are populated deterministically under the single app
 * contract (SPEC-V2 §6.2).
 *
 * Always recomputes `emailNormalized` and `usernameNormalized` from raw
 * `email`/`username` rather than trusting existing normalized values, reports
 * any drifted rows, and checks all SPEC-V2 §6.2 collision rules before writing.
 */

import { eq } from 'drizzle-orm';
import { tablesFor } from './dialect.js';
import { normalizeSearchText } from '../shared/utils/search-normalize.js';

export type IdentityCollisionKind =
  | 'duplicate_username'
  | 'duplicate_null_community_email'
  | 'duplicate_community_email'
  | 'null_and_community_email_share'
  | 'username_matches_other_email';

export interface IdentityCollision {
  kind: IdentityCollisionKind;
  userIds: number[];
  communityId?: number | null;
  message: string;
}

export interface UserIdentityBackfillResult {
  scanned: number;
  updated: number;
  drifted: number;
  driftedUserIds: number[];
}

export class IdentityNormalizationCollisionError extends Error {
  readonly collisions: IdentityCollision[];

  constructor(message: string, collisions: IdentityCollision[] = []) {
    super(message);
    this.name = 'IdentityNormalizationCollisionError';
    this.collisions = collisions;
  }
}

function buildDisplayName(firstName: string, lastName: string): string | null {
  const combined = [firstName.trim(), lastName.trim()]
    .filter((part) => part.length > 0)
    .join(' ');
  return combined.length > 0 ? combined : null;
}

/**
 * Idempotently recompute `emailNormalized`, `usernameNormalized`, and missing
 * `displayName` values across all `users` rows using `normalizeSearchText`.
 * Detects SPEC-V2 §6.2 normalized collisions before writing so cutover fails
 * loudly instead of hitting an unexplained constraint failure mid-batch.
 */
export async function backfillUserIdentity(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  database: any
): Promise<UserIdentityBackfillResult> {
  const { users } = tablesFor(database);

  const rows = (await database
    .select({
      id: users.id,
      email: users.email,
      emailNormalized: users.emailNormalized,
      username: users.username,
      usernameNormalized: users.usernameNormalized,
      firstName: users.firstName,
      lastName: users.lastName,
      displayName: users.displayName,
      communityId: users.communityId,
    })
    .from(users)) as Array<{
    id: number;
    email: string;
    emailNormalized: string | null;
    username: string | null;
    usernameNormalized: string | null;
    firstName: string;
    lastName: string;
    displayName: string | null;
    communityId: number | null;
  }>;

  const seenUsernames = new Map<string, number>();
  const seenScopedEmails = new Map<string, number>();
  const seenNullCommunityEmails = new Map<string, number>();
  const emailOwnersByNormalized = new Map<string, number[]>();
  const communityEmailOwnersByNormalized = new Map<
    string,
    Array<{ id: number; communityId: number }>
  >();

  const collisions: IdentityCollision[] = [];
  const driftedUserIds: number[] = [];
  const driftedClears: Array<{
    id: number;
    emailNormalized?: null;
    usernameNormalized?: null;
  }> = [];

  const pendingUpdates: Array<{
    id: number;
    emailNormalized?: string;
    usernameNormalized?: string | null;
    displayName?: string | null;
  }> = [];

  for (const row of rows) {
    const nextEmailNormalized = normalizeSearchText(row.email);
    const nextUsernameNormalized =
      row.username !== null ? normalizeSearchText(row.username) : null;
    const nextDisplayName =
      row.displayName ?? buildDisplayName(row.firstName, row.lastName);

    const emailOwners = emailOwnersByNormalized.get(nextEmailNormalized) ?? [];
    emailOwners.push(row.id);
    emailOwnersByNormalized.set(nextEmailNormalized, emailOwners);

    if (nextUsernameNormalized !== null) {
      const existingOwner = seenUsernames.get(nextUsernameNormalized);
      if (existingOwner !== undefined && existingOwner !== row.id) {
        collisions.push({
          kind: 'duplicate_username',
          userIds: [existingOwner, row.id],
          message: `Normalized username collision between user ${existingOwner} and user ${row.id}`,
        });
      } else {
        seenUsernames.set(nextUsernameNormalized, row.id);
      }
    }

    if (row.communityId === null) {
      const existingOwner = seenNullCommunityEmails.get(nextEmailNormalized);
      if (existingOwner !== undefined && existingOwner !== row.id) {
        collisions.push({
          kind: 'duplicate_null_community_email',
          userIds: [existingOwner, row.id],
          communityId: null,
          message: `Normalized null-community email collision between user ${existingOwner} and user ${row.id}`,
        });
      } else {
        seenNullCommunityEmails.set(nextEmailNormalized, row.id);
      }
    } else {
      const scopedKey = `${row.communityId}:${nextEmailNormalized}`;
      const existingOwner = seenScopedEmails.get(scopedKey);
      if (existingOwner !== undefined && existingOwner !== row.id) {
        collisions.push({
          kind: 'duplicate_community_email',
          userIds: [existingOwner, row.id],
          communityId: row.communityId,
          message: `Normalized community email collision in community ${row.communityId} between user ${existingOwner} and user ${row.id}`,
        });
      } else {
        seenScopedEmails.set(scopedKey, row.id);
      }

      const commOwners =
        communityEmailOwnersByNormalized.get(nextEmailNormalized) ?? [];
      commOwners.push({ id: row.id, communityId: row.communityId });
      communityEmailOwnersByNormalized.set(nextEmailNormalized, commOwners);
    }

    const emailDrifted =
      row.emailNormalized !== null &&
      row.emailNormalized !== nextEmailNormalized;
    const usernameDrifted =
      row.usernameNormalized !== null &&
      row.usernameNormalized !== nextUsernameNormalized;

    if (emailDrifted || usernameDrifted) {
      driftedUserIds.push(row.id);
      driftedClears.push({
        id: row.id,
        ...(emailDrifted ? { emailNormalized: null } : {}),
        ...(usernameDrifted ? { usernameNormalized: null } : {}),
      });
    }

    const patch: {
      id: number;
      emailNormalized?: string;
      usernameNormalized?: string | null;
      displayName?: string | null;
    } = { id: row.id };
    let changed = false;

    if (row.emailNormalized !== nextEmailNormalized) {
      patch.emailNormalized = nextEmailNormalized;
      changed = true;
    }
    if (row.usernameNormalized !== nextUsernameNormalized) {
      patch.usernameNormalized = nextUsernameNormalized;
      changed = true;
    }
    if (row.displayName === null && nextDisplayName !== null) {
      patch.displayName = nextDisplayName;
      changed = true;
    }

    if (changed) {
      pendingUpdates.push(patch);
    }
  }

  // SPEC-V2 §6.2: email shared between a null-community account and any
  // community account is unresolvable (super_admin signs in without slug).
  for (const [emailNorm, nullUserId] of seenNullCommunityEmails) {
    const commOwners = communityEmailOwnersByNormalized.get(emailNorm) ?? [];
    for (const commOwner of commOwners) {
      collisions.push({
        kind: 'null_and_community_email_share',
        userIds: [nullUserId, commOwner.id],
        communityId: commOwner.communityId,
        message: `Normalized email shared between null-community user ${nullUserId} and community user ${commOwner.id} (community ${commOwner.communityId})`,
      });
    }
  }

  // SPEC-V2 §6.2: normalized username equal to another account's normalized email.
  for (const [usernameNorm, usernameUserId] of seenUsernames) {
    const emailOwners = emailOwnersByNormalized.get(usernameNorm) ?? [];
    for (const emailUserId of emailOwners) {
      if (emailUserId !== usernameUserId) {
        collisions.push({
          kind: 'username_matches_other_email',
          userIds: [usernameUserId, emailUserId],
          message: `Normalized username on user ${usernameUserId} matches normalized email on user ${emailUserId}`,
        });
      }
    }
  }

  if (collisions.length > 0) {
    throw new IdentityNormalizationCollisionError(
      collisions.map((collision) => collision.message).join('; '),
      collisions
    );
  }

  for (const clear of driftedClears) {
    const { id, ...fields } = clear;
    await database.update(users).set(fields).where(eq(users.id, id));
  }

  for (const patch of pendingUpdates) {
    const { id, ...fields } = patch;
    await database.update(users).set(fields).where(eq(users.id, id));
  }

  return {
    scanned: rows.length,
    updated: pendingUpdates.length,
    drifted: driftedUserIds.length,
    driftedUserIds,
  };
}
