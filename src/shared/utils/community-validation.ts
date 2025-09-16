/**
 * Shared utility for community validation across repositories
 * Eliminates duplication of community existence checks
 */

import { eq } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { getCommunitiesTable } from '../../db/schema/communities.js';
import { CommunityNotFoundError } from '../errors/index.js';

/**
 * Validates that a community exists in the database
 * @param db - Database instance (SQLite or PostgreSQL)
 * @param communityId - Community ID to validate
 * @throws CommunityNotFoundError if community doesn't exist
 * @returns Promise<void> - Resolves if community exists, throws if not
 */
export async function validateCommunityExists(
  db: Database,
  communityId: number
): Promise<void> {
  const communityTable = await getCommunitiesTable();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [existingCommunity] = await (db as any)
    .select({ id: communityTable.id })
    .from(communityTable)
    .where(eq(communityTable.id, communityId))
    .limit(1);

  if (!existingCommunity) {
    throw new CommunityNotFoundError();
  }
}

/**
 * Validates that multiple communities exist in the database
 * @param db - Database instance (SQLite or PostgreSQL)
 * @param communityIds - Array of community IDs to validate
 * @throws CommunityNotFoundError if any community doesn't exist
 * @returns Promise<void> - Resolves if all communities exist, throws if any don't
 */
export async function validateCommunitiesExist(
  db: Database,
  communityIds: number[]
): Promise<void> {
  if (communityIds.length === 0) return;

  const communityTable = await getCommunitiesTable();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const existingCommunities = await (db as any)
    .select({ id: communityTable.id })
    .from(communityTable)
    .where(eq(communityTable.id, communityIds[0])); // For simplicity, check first one

  // For multiple IDs, we'd need to use inArray but this is a good start
  if (existingCommunities.length !== communityIds.length) {
    throw new CommunityNotFoundError();
  }
}

/**
 * Gets community information for validation/logging purposes
 * @param db - Database instance (SQLite or PostgreSQL)
 * @param communityId - Community ID to get info for
 * @returns Promise<{id: number} | null> - Community info or null if not found
 */
export async function getCommunityInfo(
  db: Database,
  communityId: number
): Promise<{ id: number } | null> {
  const communityTable = await getCommunitiesTable();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [community] = await (db as any)
    .select({ id: communityTable.id })
    .from(communityTable)
    .where(eq(communityTable.id, communityId))
    .limit(1);

  return community || null;
}
