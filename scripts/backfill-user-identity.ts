/**
 * Idempotent CLI wrapper to backfill normalized user identities
 * (`email_normalized`, `username_normalized`, `display_name`) for rows left
 * NULL by SQL migrations (notably non-ASCII email addresses).
 *
 * Usage:
 *   npx tsx scripts/backfill-user-identity.ts
 */

import { initializeDatabase } from '../src/db/index.js';
import { backfillUserIdentity } from '../src/db/backfill-user-identity.js';

async function main(): Promise<void> {
  const db = await initializeDatabase();
  const result = await backfillUserIdentity(db);
  console.log(
    `Backfilled user identities: scanned=${result.scanned}, updated=${result.updated}`
  );
}

main().catch((error) => {
  console.error('Failed to backfill user identities:', error);
  process.exitCode = 1;
});
