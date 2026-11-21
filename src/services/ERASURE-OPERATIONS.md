# Community erasure and restore operations

The sovereignty, retention, backup destruction and archive custody requirements are defined in [SPEC-V2 §7](../../docs/SPEC-V2.md#7-authentication-sessions-and-sovereignty). This document describes deployment configuration and operator hooks.

## Configure the record store

On Node, set `ERASURE_RECORDS_ROOT` to a dedicated service-owned directory outside the database, media and whole-state backup roots. Explicitly exclude this directory from every backup and restore operation. Do not put it inside `HONO_STORAGE_ROOT` or a database volume. Files use mode `0600`; the directory uses `0700` on creation.

On Workers, bind `ERASURE_RECORDS` to a dedicated R2 bucket. Never restore, rotate or copy this bucket with D1 or `MEDIA`. It is independent of D1 Time Travel. Do not apply a lifecycle expiration rule to erasure records. If the binding/path is absent, erasure and system erasure reads return `503`.

Request and completion records are separate so an interrupted pending write cannot roll back a completed record. Maintenance and administrator reads scrub actor identifiers according to SPEC-V2 §7. The record also retains content-free archive custody evidence before the database cascade. Committed requested/executing sovereignty rows are the durable queue for retrying failed external record writes; a record-store failure leaves deletion pending.

## Restore hooks

Before invoking any database, Time Travel or whole-state restore, quiesce the deployment and call `CommunityErasureService.verifyRestorePoint(targetTimestamp, now)` against the authoritative current database and live, excluded record store. The database check closes the crash gap between persisting a request and writing its external record; an unavailable source database refuses the restore. The record-only `verifyErasureRestorePoint` primitive is not sufficient for operator restore authorization. It rejects invalid timestamps, every restore while an erasure is pending, and any target earlier than any recorded completion. Do not restore first and attempt to reconcile an earlier point.

After an allowed restore, before opening the deployment to traffic, call `CommunityErasureService.reconcileRestore(targetTimestamp, now)`. It re-applies every retained erasure, removes objects, aborts recorded multipart uploads and removes rows/sessions/throttles, then writes a content-free system reconciliation audit entry. A hook failure must leave the deployment closed. These hooks do not themselves invoke provider restore commands.

Apply the backup and external-custodian duties in [SPEC-V2 §7](../../docs/SPEC-V2.md#7-authentication-sessions-and-sovereignty) when operating these hooks.

## Maintenance

Workers' minute cron retries pending erasures; Node's export-expiry timer retries each minute (with an hourly maintenance fallback). Monitor `maintenance: community erasure sweep failed` and the content-free records for pending work approaching the SPEC-V2 §7 live-deletion bound. An outage, provider quota or failed storage deletion must remain pending rather than recording success. Keep the minute cron enabled on Workers. The storage budget bounds each pass, so operators must size the deployment for its community object count and the SPEC-V2 §7 live-deletion bound.

Workers erasure has its own `*/1 * * * *` invocation, separate from minute export expiry (`* * * * *`) and hourly maintenance. Each pass budgets 15 MEDIA operations and processes at most two communities, reserving the rest of the Free 50-subrequest limit for D1 and the record store (including completion writes). R2 listings and bulk deletions contain at most 1,000 keys. An ordinary page costs three MEDIA operations (fence, list, bulk delete); multipart journals additionally cost one read and one abort each, allowing six journal aborts plus one bulk delete within 15 operations. A stable pending set rotates its starting community every minute, including across restarts; completed records do not participate in rotation. Database discovery also rotates its five-request window, so later requests enter scheduling while earlier ones remain pending.

Size the minute-sweep capacity for the deployment's community object count and competing pending communities, including multipart journals and record-store listing pages. Compare the measured worst-case completion time, with margin for outages and quota limits, against SPEC-V2 §7 before admitting a larger backlog.
