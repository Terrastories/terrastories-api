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
 */

import { eq } from 'drizzle-orm';
import { tablesFor } from './dialect.js';
import { normalizeSearchText } from '../shared/utils/search-normalize.js';

export interface UserIdentityBackfillResult {
  scanned: number;
  updated: number;
}

export class IdentityNormalizationCollisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdentityNormalizationCollisionError';
  }
}

function buildDisplayName(firstName: string, lastName: string): string | null {
  const combined = [firstName.trim(), lastName.trim()]
    .filter((part) => part.length > 0)
    .join(' ');
  return combined.length > 0 ? combined : null;
}

/**
 * Idempotently populate missing `emailNormalized`, `usernameNormalized`, and
 * `displayName` values across all `users` rows using `normalizeSearchText`.
 * Detects normalized collisions before writing so cutover fails loudly instead
 * of hitting an unexplained constraint failure mid-batch.
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

  const pendingUpdates: Array<{
    id: number;
    emailNormalized?: string;
    usernameNormalized?: string;
    displayName?: string | null;
  }> = [];

  for (const row of rows) {
    const nextEmailNormalized =
      row.emailNormalized ?? normalizeSearchText(row.email);
    const nextUsernameNormalized =
      row.username !== null
        ? (row.usernameNormalized ?? normalizeSearchText(row.username))
        : null;
    const nextDisplayName =
      row.displayName ?? buildDisplayName(row.firstName, row.lastName);

    if (nextUsernameNormalized !== null) {
      const existingOwner = seenUsernames.get(nextUsernameNormalized);
      if (existingOwner !== undefined && existingOwner !== row.id) {
        throw new IdentityNormalizationCollisionError(
          `Normalized username collision between user ${existingOwner} and user ${row.id}`
        );
      }
      seenUsernames.set(nextUsernameNormalized, row.id);
    }

    if (row.communityId === null) {
      const existingOwner = seenNullCommunityEmails.get(nextEmailNormalized);
      if (existingOwner !== undefined && existingOwner !== row.id) {
        throw new IdentityNormalizationCollisionError(
          `Normalized null-community email collision between user ${existingOwner} and user ${row.id}`
        );
      }
      seenNullCommunityEmails.set(nextEmailNormalized, row.id);
    } else {
      const scopedKey = `${row.communityId}:${nextEmailNormalized}`;
      const existingOwner = seenScopedEmails.get(scopedKey);
      if (existingOwner !== undefined && existingOwner !== row.id) {
        throw new IdentityNormalizationCollisionError(
          `Normalized community email collision in community ${row.communityId} between user ${existingOwner} and user ${row.id}`
        );
      }
      seenScopedEmails.set(scopedKey, row.id);
    }

    const patch: {
      id: number;
      emailNormalized?: string;
      usernameNormalized?: string;
      displayName?: string | null;
    } = { id: row.id };
    let changed = false;

    if (row.emailNormalized !== nextEmailNormalized) {
      patch.emailNormalized = nextEmailNormalized;
      changed = true;
    }
    if (
      nextUsernameNormalized !== null &&
      row.usernameNormalized !== nextUsernameNormalized
    ) {
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

  for (const patch of pendingUpdates) {
    const { id, ...fields } = patch;
    await database.update(users).set(fields).where(eq(users.id, id));
  }

  return {
    scanned: rows.length,
    updated: pendingUpdates.length,
  };
}
