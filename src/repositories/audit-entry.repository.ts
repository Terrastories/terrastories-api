/**
 * Content-free AuditEntry repository helpers (SPEC-V2 §6.8 and §7).
 *
 * Enforces append-only, content-free writes and provides only the single
 * scheduled scrub mutation that nullifies `ip_address` and `user_agent`
 * older than the configured retention deadline (max 90 days).
 */

import { and, inArray, isNotNull, lte, or } from 'drizzle-orm';
import { tablesFor } from '../db/dialect.js';
import { MAINTENANCE_SWEEP_ROW_LIMIT } from '../shared/maintenance-sweep.js';
import type { AuditEntry } from '../db/schema/audit_entries.js';
import {
  auditNetworkMetadataCutoff,
  validateContentFreeAuditEntry,
  type ContentFreeAuditEntryInput,
} from '../shared/utils/audit-entry.js';

/**
 * Build (but do not await) the audit-insert statement for a coupled write.
 * Validation runs synchronously — a content-free violation throws before any
 * statement is built — so the caller can drop the insert into the same unit
 * as the write it records.
 */
export function buildAuditEntryInsert(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  database: any,
  input: ContentFreeAuditEntryInput,
  createdAt: Date = new Date()
) {
  const validated = validateContentFreeAuditEntry(input);
  const { auditEntries } = tablesFor(database);

  return database.insert(auditEntries).values({
    communityId: validated.communityId,
    actorId: validated.actorId,
    action: validated.action,
    resourceType: validated.resourceType,
    resourceIds: validated.resourceIds,
    outcome: validated.outcome,
    ipAddress: validated.ipAddress,
    userAgent: validated.userAgent,
    createdAt,
  });
}

export async function writeAuditEntry(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  database: any,
  input: ContentFreeAuditEntryInput,
  createdAt: Date = new Date()
): Promise<AuditEntry> {
  const [inserted] = await buildAuditEntryInsert(
    database,
    input,
    createdAt
  ).returning();

  return inserted as AuditEntry;
}

export interface ScrubAuditNetworkMetadataResult {
  cutoff: Date;
  scrubbedCount: number;
}

/**
 * Scrub `ip_address` and `user_agent` on audit entries created at or before
 * the retention cutoff (default 90 days). Never modifies any other column
 * and never deletes rows. Bounded to MAINTENANCE_SWEEP_ROW_LIMIT rows in one
 * statement per call so a scheduled invocation stays within its budget; rows
 * beyond the cap are scrubbed on the next tick.
 */
export async function scrubExpiredAuditNetworkMetadata(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  database: any,
  options: { now?: Date; retentionDays?: number; limit?: number } = {}
): Promise<ScrubAuditNetworkMetadataResult> {
  const cutoff = auditNetworkMetadataCutoff(options.now, options.retentionDays);
  const limit = options.limit ?? MAINTENANCE_SWEEP_ROW_LIMIT;
  const { auditEntries } = tablesFor(database);

  const eligible = and(
    lte(auditEntries.createdAt, cutoff),
    or(isNotNull(auditEntries.ipAddress), isNotNull(auditEntries.userAgent))
  );
  const updated = await database
    .update(auditEntries)
    .set({
      ipAddress: null,
      userAgent: null,
    })
    .where(
      inArray(
        auditEntries.id,
        database
          .select({ id: auditEntries.id })
          .from(auditEntries)
          .where(eligible)
          .limit(limit)
      )
    )
    .returning({ id: auditEntries.id });

  return {
    cutoff,
    scrubbedCount: updated.length,
  };
}
