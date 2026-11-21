# Community erasure and restore operations

This implements SPEC-V2 §7's live deletion and restore hooks. An effective erasure disables the community and blocks export immediately. Storage deletion retries from persisted requests and out-of-band records; rows are removed only after a pass verifies that the community prefix is empty and recorded multipart uploads are aborted. R2 and local filesystem adapters do not retain object versions. Additional adapters must provide equivalent permanent deletion semantics.

## Configure the record store

On Node, set `ERASURE_RECORDS_ROOT` to a dedicated service-owned directory outside the database, media and whole-state backup roots. Explicitly exclude this directory from every backup and restore operation. Do not put it inside `HONO_STORAGE_ROOT` or a database volume. Files use mode `0600`; the directory uses `0700` on creation.

On Workers, bind `ERASURE_RECORDS` to a dedicated R2 bucket. Never restore, rotate or copy this bucket with D1 or `MEDIA`. It is independent of D1 Time Travel. Do not apply a lifecycle expiration rule to erasure records. If the binding/path is absent, erasure and system erasure reads return `503`.

Request and completion records are separate so an interrupted pending write cannot roll back a completed record. The actor identifier is removed after 30 days from completion by maintenance or an administrator read. Records contain identifiers, timestamps and outcome only.

## Restore hooks

Before invoking any database, Time Travel or whole-state restore, quiesce the deployment and call `CommunityErasureService.verifyRestorePoint(targetTimestamp, now)` against the authoritative current database and live, excluded record store. The database check closes the crash gap between persisting a request and writing its external record; an unavailable source database refuses the restore. The record-only `verifyErasureRestorePoint` primitive is not sufficient for operator restore authorization. It rejects invalid timestamps, every restore while an erasure is pending, and any target earlier than any recorded completion. Do not restore first and attempt to reconcile an earlier point.

After an allowed restore, before opening the deployment to traffic, call `CommunityErasureService.reconcileRestore(targetTimestamp, now)`. It re-applies every retained erasure, removes objects, aborts recorded multipart uploads and removes rows/sessions/throttles, then writes a content-free system reconciliation audit entry. A hook failure must leave the deployment closed. These hooks do not themselves invoke provider restore commands.

Operators own backup destruction/rotation: self-hosted/field-kit backups captured before live completion must be destroyed at completion; retained D1 export copies must meet the profile's bound. Legacy archives in external steward custody require their separately recorded destruction attestation. Live-deletion completion is not evidence that an external backup or custodian destroyed its copy.

## Maintenance

Workers' minute cron retries pending erasures; Node's export-expiry timer retries each minute (with an hourly maintenance fallback). Monitor `maintenance: community erasure sweep failed` and the content-free records for pending work approaching 24 hours. An outage, provider quota or failed storage deletion must remain pending rather than recording success. Keep the minute cron enabled on Workers. The storage budget bounds each pass, so operators must size the deployment for its community object count and the 24-hour live deletion requirement.
