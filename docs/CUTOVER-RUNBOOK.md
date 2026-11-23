# Cutover runbook: Rails on Heroku to Terrastories V2

Status: draft for review. Offline authoring: no Cloudflare or Heroku call was made to write it, and none of the numbers below were re-measured here. Contract: [SPEC-V2 §10](./SPEC-V2.md) and §13 step 9, maintenance-window cutover only (#197). Migration mechanics: [RAILS-MIGRATION.md](./RAILS-MIGRATION.md). Staging background: [CLOUDFLARE-STAGING.md](./CLOUDFLARE-STAGING.md).

Source: Heroku app `terrastories`, Heroku Postgres essential-1 (PG17), ActiveStorage on S3 `us-east-2`, about 30 GB media, 89 communities, 289 users.
Target: Cloudflare Workers Free + D1 + R2.

**Markers.** Every step that is destructive, outward-facing (users see it), spends money, or touches production is tagged **REQUIRES HUMAN APPROVAL**. An agent or script must stop at that tag and ask a person. Nothing in this runbook authorises it by itself.

## 0. Read this first: Heroku shutdown is blocked on the frontend

V2 ships an API only. The V2 frontend is not built ([V2-FRONTEND-HANDOFF.md](./V2-FRONTEND-HANDOFF.md)). Communities use the Rails UI today, so **the Rails app cannot be retired, and sections 7 and 8 (traffic switch and Heroku shutdown) cannot run, until a V2 frontend has shipped and been accepted** (SPEC-V2 §13 step 9, Slice 15 in [V2-DOMAIN-BUILD-PLAN.md](./V2-DOMAIN-BUILD-PLAN.md)). Sections 1 to 6 (prerequisites, staging rehearsal, go/no-go) can proceed now. Do not point `our.terrastories.app` at an API with no UI.

## 1. Where everything lives

| Artifact                                                                   | Location                                                                                                                                            |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------ |
| Spec and contracts                                                         | `docs/SPEC-V2.md` (§10 migration, §13 phases), `docs/RAILS-MIGRATION.md`                                                                            |
| Capture / transform / load tools                                           | `scripts/migrate-rails.ts`, `scripts/migrate-rails-transform.ts`, `scripts/migrate-rails-load.ts` (`npm run migrate:rails:capture                   | transform | load`) |
| Staging kit                                                                | `scripts/staging/`: `provision.sh`, `load-community.sh`, `smoke.sh`, `cors-preflight.sh`, `guards.ts`, `r2-cors.json`, `verify-r2-part-checksum.ts` |
| Staging env template                                                       | `wrangler.jsonc` `env.staging` (placeholders)                                                                                                       |
| Walkthrough                                                                | `npm run walkthrough` (`scripts/walkthrough/`, `docs/WALKTHROUGHS.md`)                                                                              |
| Stage-1 bundle, Stage-2 output, legacy archive                             | Trusted migration host only, owner-only permissions, encrypted when moved (SPEC-V2 §10.3, §10.4). Never in git, CI or public storage.               |
| D1 SQL dump, `verify.sql`, `wipe-and-retry.sql`, `r2-upload-manifest.json` | Beside the Stage-2 output on the same host (`--sql-out`)                                                                                            |
| Go/no-go evidence (walkthrough `summary.md`, CPU table, counts)            | Operator-private evidence folder; summaries hold counts only                                                                                        |
| Heroku backup (`.dump`)                                                    | Same restricted store as the archive; part of archive custody                                                                                       |
| Restore and orphan-sweep hold procedure                                    | `docs/CLOUDFLARE-STAGING.md`, `docs/OPERATIONS-GOVERNANCE.md` §6.4                                                                                  |

## 2. Prerequisites (owner: operator unless noted)

1. **Cloudflare work account access.** Operator can log in to the work account; its 32-hex account id is exported as `CLOUDFLARE_ACCOUNT_ID` (kit scripts refuse to run if `wrangler whoami` does not show it). Account-level settings changes: **REQUIRES HUMAN APPROVAL**.
2. **R2 API token** scoped to the media bucket only, object read/write only. Create one for staging and a separate one for production. Creating tokens: **REQUIRES HUMAN APPROVAL**. Keep values in the environment, never in files: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`.
3. **Worker secrets**, per environment, set by hand with `npx wrangler secret put NAME --env <env>` (omit `--env` for production):
   - `AUTH_SERVER_SECRET`: prelogin HMAC key, at least 32 characters, unique.
   - `BOOTSTRAP_SECRET`: installation bootstrap secret, unique, length per `BOOTSTRAP_SECRET_MIN_LENGTH`.
   - `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`: for `/v2/media/uploads`; without all of them plus the var `R2_BUCKET_NAME` the route answers `501`.
   - Binding `ERASURE_RECORDS`: dedicated R2 bucket (staging `terrastories-staging-erasure-records`, created by `provision.sh`). Never restored, rotated or copied with D1/MEDIA; excluded from backups; no lifecycle expiration. Var `R2_BUCKET_NAME` names the media bucket; `ENVIRONMENT` stays unset; `ORPHAN_SWEEP_PAUSED` is set only during a restore.
   - `MAPBOX_ACCESS_TOKEN`: optional instance default (a public `pk.*` token; `sk.*` is rejected with `422`). Unset falls back to OpenFreeMap.
   - Verify presence without printing: `npx wrangler secret list --env staging`.
4. **Bucket configuration** (staging and production): CORS for the frontend origin (allow `PUT`; headers `x-amz-content-sha256`, `content-type`; expose `ETag`; MaxAge at least 3600) and a lifecycle rule aborting incomplete multipart uploads after 1 day. Staging gets both from `scripts/staging/provision.sh --apply`, which renders `scripts/staging/r2-cors.json` with `STAGING_FRONTEND_ORIGIN`, applies it, adds the lifecycle rule only when it is missing, and then reads both back (`wrangler r2 bucket cors list`, `wrangler r2 bucket lifecycle list`) and refuses unless `PUT` with `x-amz-content-sha256` is allowed. Production is configured by hand with the same values.
5. **Community approvals and steward designations.** Each community (or its named steward) approves the maintenance window and designates the archive custodian (SPEC-V2 §10.4 item 5). Record custodian and retention (30 days after acceptance unless the community sets another) per community. Sending approval requests to communities: **REQUIRES HUMAN APPROVAL**.
6. **Mapbox notice.** Communities with Mapbox styles/tokens are told that tokens migrate as public `pk.*` values only and that they remain responsible for their Mapbox usage; field kits fall back to local PMTiles. Sending the notice: **REQUIRES HUMAN APPROVAL**.
7. **Heroku access.** Operator can run `heroku` against app `terrastories` (backups, maintenance, scale) and holds read-only AWS credentials for the ActiveStorage bucket in the environment. Using the production Heroku or AWS credentials: **REQUIRES HUMAN APPROVAL** each time.
8. **Trusted migration host** with disk for about three copies of the media at peak (Stage-1 bundle, Stage-2 output, loaded copy), so plan for roughly 90 GB of free disk for 30 GB of media.
9. Repo on the release commit; `npm ci`; `npm run validate` green.

## 3. Staging rehearsal

Staging uses only `terrastories-staging-*` resources, a workers.dev URL, no DNS changes, and an isolated D1 and R2 bucket. See [CLOUDFLARE-STAGING.md](./CLOUDFLARE-STAGING.md) for the platform rules.

1. **Provision (dry run first).**
   ```bash
   export CLOUDFLARE_ACCOUNT_ID=<expected account id>
   export STAGING_FRONTEND_ORIGIN=https://<frontend origin>   # may PUT parts to R2
   scripts/staging/provision.sh            # prints the plan
   scripts/staging/provision.sh --apply    # creates D1 + two R2 buckets (media, erasure records), then applies and verifies the media bucket's CORS and lifecycle rule
   ```
   Creating Cloudflare resources: **REQUIRES HUMAN APPROVAL** (free tier, create-only; the script never deletes). If the shell exports a `CLOUDFLARE_API_TOKEN` for a different account, run the kit as `env -u CLOUDFLARE_API_TOKEN scripts/staging/<script>.sh ...`: the account guard refuses a mismatch, but unset the variable first. Paste the printed `database_id` and your workers.dev subdomain into `wrangler.jsonc` `env.staging` (do not commit real ids if the repo is public; keep the edit local or commit only if the owner agrees). Set secrets (section 2.3), then rerun `provision.sh --apply` to deploy the Worker. The bucket's CORS and lifecycle rule are part of that same `--apply`: `STAGING_FRONTEND_ORIGIN` is required, the rendered file is checked before wrangler sees it, the rule is added only when the read-back does not already show it, and a dry run prints those commands without running any of them. Time Travel needs `wrangler d1 info` to show `version: production`.
2. **Capture, barbara first.** Use a real source capture only on the trusted host. The pilot community `barbara` goes first:
   ```bash
   npm run migrate:rails:capture -- --source '<postgres url from env>' --blob-source s3 \
     --s3-bucket <bucket> --s3-region us-east-2 --community barbara --output <new bundle dir>
   npm run migrate:rails:transform -- <flags per RAILS-MIGRATION.md> --community barbara
   ```
   Heroku read access for capture: **REQUIRES HUMAN APPROVAL** (reads production data).
3. **Load into staging.**
   ```bash
   scripts/staging/load-community.sh --transform-output <stage-2 dir>            # dry run + budget check
   scripts/staging/load-community.sh --transform-output <stage-2 dir> --apply
   ```
   It runs the D1 budget dry run, a pre-load export and Time Travel bookmark, applies migrations, executes the SQL files in order through the `_rails_migration_load` ledger (reruns skip applied files), uploads to R2 with environment-only credentials, then runs `verify.sql`. It prints counts and step status only; wrangler output goes to a mode-600 log. Run `load-community.sh` by one operator at a time per bucket: the `--r2-via-wrangler` path checks absence before an unconditional put (wrangler has no create-only write). A file that fails midway is never rerun by itself: read the log, then rerun with `--wipe-and-retry`.
4. **Smoke.**
   ```bash
   export STAGING_URL=https://terrastories-staging-api.<subdomain>.workers.dev
   export STAGING_FRONTEND_ORIGIN=...     # the origin set in step 1 (section 2.4)
   export WT_SUPER_IDENTIFIER=... WT_SUPER_PASSWORD=...     # staging super admin, env only
   scripts/staging/smoke.sh --community barbara --apply
   ```
   Checks `/health` is 200, `/dev/seed` is 404 for GET and HEAD, runs `npm run walkthrough` with `--d1 --super-credentials-env --allow-destructive` (disposable community only), sends the browser's `OPTIONS` preflight for a part `PUT` with `x-amz-content-sha256` to `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com/<bucket>` and fails unless that origin, method and header are allowed (`scripts/staging/cors-preflight.sh`), runs the R2 part-checksum probe, and prints the CPU measurement procedure (`scripts/staging/smoke.sh --cpu-procedure`). `WT_SUPER_IDENTIFIER`/`WT_SUPER_PASSWORD` are required only when the walkthrough will actually run (not with `--skip-walkthrough`, and not when smoke's own marker shows a run today).
   Without bucket-scoped S3 credentials, add `--skip-r2-probe`: it skips both the CORS preflight and the probe, prints `R2 probe skipped: not verified`, and the final summary records the probe as NOT done, never a pass; the go/no-go probe and CORS items stay unchecked until they actually run.
   For a rehearsal on `wrangler dev --local` use `scripts/staging/smoke.sh --local` with `STAGING_URL=http://127.0.0.1:<port>` (loopback only; the R2 CORS preflight and probe are skipped and the summary records the probe as NOT done).
5. **All communities in staging.** Only if the R2 budget allows (decision A below) or a paid plan is approved. Free R2 holds 10 GB, so 30 GB cannot be staged on Free. If not possible, rehearse the rest as D1-only (`--skip-r2` on `load-community.sh`), accept that media-dependent checks are covered by `barbara` only, and record that in the go/no-go sheet. Rehearse the real full capture timing at least once: its duration is the maintenance-window length.
6. **Rollback rehearsal on staging**: restore from a Time Travel bookmark (section 9) at least once, with the orphan-sweep hold set first.

### First real staging run (2026-11-23)

Account `<account-id>`, worker URL `https://terrastories-staging-api.<subdomain>.workers.dev` (placeholders; real values stay out of the repo). Workers Free plan.

| Item                    | Result                                                                                                                                                |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Load, `barbara`         | D1 via SQL dump: 12 files applied, `verify.sql` passed. R2: 7 objects uploaded with `wrangler r2 object put` (`--r2-via-wrangler`) and size-verified. |
| Walkthrough             | PASS 89/89 (336 steps, 0 failed) on Workers Free                                                                                                      |
| CPU `POST /v2/media`    | 90 MB raw upload: 9 ms CPU, 5.8 s wall (under the 10 ms Free budget)                                                                                  |
| CPU auth                | login 6 to 7 ms, prelogin 3 to 5 ms                                                                                                                   |
| CPU `DELETE /v2/media`  | 18 ms: over 10 ms but the outcome was ok (no 1102). **Track**: re-measure and decide before production.                                               |
| R2 part-checksum probe  | NOT run: needs a bucket-scoped R2 API token (S3 credentials)                                                                                          |
| 300 MB multipart upload | NOT run: same token requirement                                                                                                                       |

Both open items stay unchecked in section 5 until the token exists and they are run.

Operator notes from the run:

- The shell may export a `CLOUDFLARE_API_TOKEN` that belongs to another account. Always run wrangler and the kit as `env -u CLOUDFLARE_API_TOKEN scripts/staging/<script>.sh ...` and confirm the account id in `npx wrangler whoami`. The kit's account guard refuses a mismatch, but unset the variable first.
- Without S3 credentials use `scripts/staging/load-community.sh ... --apply --r2-via-wrangler` (objects over 300 MiB need the S3 path).
- `wrangler tail <worker> --format json` takes no `--env` (the worker name already includes `staging`) and prints pretty-printed multi-line JSON. Parse it with `node scripts/staging/parse-tail.mjs`.
- `POST /v2/media` with raw bytes accepts only `role=user_photo`; send no role for the CPU measurement.
- D1 allows one committed import per UTC day, so a second walkthrough on the same UTC day fails. Use `smoke.sh --skip-walkthrough`, or rerun after 00:00 UTC (smoke prints "walkthrough already ran today" when its own marker for that target shows a run today; a run from another machine is not seen, so use the flag). The marker records the UTC day the import COMMITTED (the server's `data.committedAt` from the commit step in the walkthrough's `results.json`, else the client's response time; fallback only when `results.json` is missing or unreadable: the day the walkthrough started, never the end time; a readable `results.json` with no passing commit writes no marker; `STAGING_MARKER_DIR` overrides the marker directory), so a walkthrough that crosses midnight does not move the marker to the new day when the commit happened before midnight.
- For the 300 MB multipart CPU measurement, `npx tsx scripts/staging/upload-large.ts --file sample300.mp4` (`WT_SUPER_IDENTIFIER`/`WT_SUPER_PASSWORD`, env only) signs in as the super admin, creates a throwaway community `stg-upload-<random>` and a throwaway community admin (random password, memory only), signs in as that admin (direct upload authorizes by community role; the super admin alone gets 403), runs create -> parts -> complete -> delete media, and disables the community afterwards (always on normal exit and on SIGINT/SIGTERM; a SIGKILL leaves the community active, so disable `stg-upload-<slug>` by hand; a claimed community cannot be deleted, so it stays behind disabled). It requires 2xx on every call, attaches the session cookie only to the validated staging origin (never to R2), refuses redirects, never prints secrets, and prints the community slug, bytes, part count, file id, per-phase HTTP status and the cleanup outcome. `--dry-run` prints the plan without a network call. It needs the bucket-scoped R2 S3 credentials on the Worker (create answers 501 otherwise). See `smoke.sh --cpu-procedure`.
- No bucket-scoped R2 API token yet: run smoke with `--skip-r2-probe`. It prints "R2 probe skipped: not verified" and its summary says the probe is NOT done; that is not a pass and not a recorded result, so the section 5 probe item stays unchecked until the probe runs with real credentials.

## 4. Decisions to resolve before production

### A. R2 Free (10 GB) versus 30 GB media (must be resolved before production cutover)

R2 Free includes 10 GB-month storage per account; the media is about 30 GB. Options:

| Option                                                                      | Cost                                                                                                                       | Note                                                                                                        |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Paid R2 (pay-as-you-go storage)                                             | about USD 0.30 per month for 30 GB at the published storage rate (estimate: recompute from current pricing; no egress fee) | R2 charges for storage above the free tier even on Workers Free; this needs a payment method on the account |
| Reduce what is migrated (archive non-canonical media, per-community quotas) | USD 0                                                                                                                      | Needs a product decision; media dropped from canonical storage stays in the legacy archive, not served      |
| Keep part of the media in S3                                                | AWS cost continues                                                                                                         | Conflicts with the Heroku/AWS retirement and the zero-cost goal; not recommended                            |

Owner decision and any payment method change: **REQUIRES HUMAN APPROVAL**. Record the decision and date here: **\_\_**.

### B. Workers Free CPU

Upload routes must stay within the Free CPU budget (about 10 ms per invocation). If section 5 measurements fail, the options are Workers Paid or a design change; either needs approval.

## 5. Go/no-go checklist

All must be true on the final rehearsal, with evidence attached. A single NO is a NO-GO.

- [ ] Staging walkthrough PASS **89/89** interaction rows (`summary.md`), run with `--d1`. D1 allows one committed import per UTC day for the whole database, so the walkthrough commits one import and asserts the `429 d1_daily_import_limit` for the second (a covered negative step, not a failure). Do not run it twice on the same UTC day, and not on a day a real import is planned: it uses the day's single import. Rehearse with `--login-real-admin` too; if the real admin is **GATED** (no recovery codes saved) the authenticated-media check did not run: a person must save the codes first, then rerun. A GATED result is not a PASS for that check.
- [ ] Local workerd rehearsal (optional, before staging): `npm run walkthrough:workers` passes 89/89.
- [ ] `verify.sql` passed on staging D1 (rows, applied-file count, sequence floors).
- [ ] Row and object counts reconcile with the Stage-2 manifests (source, bundle, target, archive; `validation-summary.txt` has no unexplained difference).
- [ ] R2 part-checksum probe confirms payload hash enforcement (exit 0). Exit 2 means corrupted bytes were accepted. Exit 1 is inconclusive. Both block cutover. A `--skip-r2-probe` smoke run is NOT a result: its summary says the probe is NOT done and this box stays unchecked.
- [ ] R2 CORS preflight allowed from the frontend origin: `PUT` with `x-amz-content-sha256` (run by `scripts/staging/smoke.sh --apply`, or `scripts/staging/cors-preflight.sh --apply` by hand).
- [ ] CPU measurements recorded and under budget: 90 MB raw upload and 300 MB multipart upload, no error 1102 (`scripts/staging/smoke.sh --cpu-procedure`).
- [ ] Manual-review list resolved and signed off:
  - 92 users with null community: 89 are `role_requires_community` and 3 are `super_admin` contradictions; each has a recorded disposition.
  - 58 videos over 100 MiB are present in R2 (they use the multipart path) and readable.
  - MANUAL items in the transform output: **zero**.
- [ ] Decision A (R2 storage) resolved and any paid plan active.
- [ ] D1 free limits hold: database under 500 MB with headroom, row-write estimate under the 100,000 per day budget (or a split load across days, or a paid decision). `load-community.sh` fails on over-budget unless `--allow-over-budget` is chosen by a person.
- [ ] Cron triggers within 5 per account: staging (3) crons removed before production (3) is deployed (section 6).
- [ ] V2 frontend accepted (section 0), custom domain access confirmed, community approvals and custodians recorded, Mapbox notice sent.
- [ ] Rollback rehearsed (section 9) and the Heroku DB and S3 confirmed intact.

## 6. Production resources (create-only; before the window)

Production D1 and R2 names do not use the staging prefix, so the staging scripts will not touch them. Create them by hand after the go decision, including a **production `ERASURE_RECORDS` R2 bucket** (a dedicated bucket, no lifecycle expiration rule, excluded from backups, never restored or copied with D1/MEDIA; without it erasure answers 503): **REQUIRES HUMAN APPROVAL**. **Cron limit:** Workers Free allows 5 cron triggers per account. The Worker dispatches 3 exact crons (`0 * * * *`, `* * * * *`, `*/1 * * * *`), staging holds 3, production needs 3, so 6 > 5. Before deploying production, redeploy staging with its `triggers.crons` emptied (or delete the staging Worker after the rehearsal is closed; deletion **REQUIRES HUMAN APPROVAL**), or take a paid decision. Never run production without all three crons: the `*/1` entry is the erasure retry. Use the top-level `wrangler.jsonc` block with real ids, set production secrets (section 2.3), configure bucket CORS and lifecycle by hand with the same values as section 2.4 (the kit only ever touches `terrastories-staging-*`), and deploy the Worker without a route. Confirm that `PUBLIC_ORIGIN` is the final custom origin, not `https://example.org` (the Worker returns `503 config-refused` otherwise). Run the production dry-run: `npx wrangler deploy --dry-run`.

## 7. Maintenance window (blocked on frontend, section 0)

Estimate the length from the full-capture rehearsal. Run from the trusted host. Times are recorded in the evidence folder.

1. **Announce.** Notify communities and stewards of the window. **REQUIRES HUMAN APPROVAL.**
2. **Heroku maintenance mode on:** `heroku maintenance:on -a terrastories`. **REQUIRES HUMAN APPROVAL.** The source writer boundary must cover relational writes, background jobs, attachments and stored-object uploads.
3. **Record the dyno formation, then drain and freeze writers.** First `heroku ps -a terrastories` and `heroku ps:type -a terrastories`; save the exact formation (every process type, quantity and size: web, worker, any scheduler or release process) in the evidence folder. Then scale every listed type to 0, for example `heroku ps:scale web=0 worker=0 -a terrastories`, and verify with `heroku ps` that nothing runs. Heroku Scheduler jobs are add-on triggers: record and disable them too. The legacy source is now read-only. **REQUIRES HUMAN APPROVAL.**
4. **Final Heroku backup:** `heroku pg:backups:capture -a terrastories`, then `heroku pg:backups:download` to the restricted store; record the backup id and checksum. **REQUIRES HUMAN APPROVAL** (production data copy).
5. **Final S3 capture, full** (do not pass `--community`), from the quiescent source into a new bundle directory, with read-only AWS credentials from the environment. Verify per RAILS-MIGRATION.md ("Required verification before accepting Stage 1"). **REQUIRES HUMAN APPROVAL.**
6. **Transform, full**, then review `validation-summary.txt` and confirm MANUAL items are zero and the manifest counts equal the rehearsal counts.
7. **Load production D1 + R2.** Take a D1 export and record a Time Travel bookmark first. Use the same flow as staging against the production names (the staging wrapper refuses them, so run the underlying commands by hand: `migrate:rails:load --target d1 --dry-run`, then `--target d1 --sql-out`, `wrangler d1 migrations apply <db> --remote`, each SQL file via `wrangler d1 execute <db> --remote --file` in `d1-import.json` order, `migrate:rails:load --target r2 --bucket <bucket>`, `verify.sql`). **REQUIRES HUMAN APPROVAL** before the first remote write.
8. **Traffic switch.** Attach the custom domain `our.terrastories.app` to the Worker (or the frontend that calls it) and make `terrastories.herokuapp.com` redirect to it. DNS or route changes: **REQUIRES HUMAN APPROVAL.** Note the previous DNS records first (rollback needs them) and lower the TTL beforehand.
9. **Production smoke.** Health 200, `/dev/seed` 404 (GET and HEAD) via curl. Then `npm run walkthrough -- --base-url https://our.terrastories.app --d1 --super-credentials-env` **without** `--allow-destructive` (the destructive walk creates and erases a disposable community; do not run it on production unless the owner decides). Capture summary.
10. **Community acceptance.** Each steward confirms their community; record acceptance date and custodian. Acceptance starts the 30-day retention clock.
11. **Close the window**, announce completion. **REQUIRES HUMAN APPROVAL.**

Abort criteria before step 8: any failed verify, any count mismatch, any MANUAL item. Abort means: leave Heroku untouched, restore the recorded formation (`heroku ps:scale web=<n> worker=<n> ...` for every type, then re-enable Scheduler jobs), `heroku maintenance:off`, and wipe nothing on Heroku or S3.

## 8. Post-cutover and Heroku shutdown

1. **Archive custody (SPEC-V2 §10.4).** The Stage-2 legacy archive, the Heroku backup and the Stage-1 bundle stay encrypted in the restricted store, with the custodian and retention window recorded per community. The runtime never reads the archive. The Stage-1 bundle may be deleted only after every payload has exactly one checksum-verified manifest disposition (§10.4).
2. **Retention: 30 days** after each community accepts (unless it sets another window). Keep the Heroku database and S3 bucket read-only for that window as the rollback source.
3. **Destruction attestation** at window end: the custodian attests deletion of the archive and retained copies; record who, when, and what. Destroying archive copies: **REQUIRES HUMAN APPROVAL** (irreversible).
4. **Heroku shutdown and add-on removal, only after acceptance and the retention window,** and only after the V2 frontend is live (section 0): scale to zero is already done; `heroku addons:destroy` for Postgres, deleting the app, emptying the S3 bucket and removing AWS credentials are all irreversible. **REQUIRES HUMAN APPROVAL** for each, from the project owner, in writing. No script or agent does this automatically.
5. Re-enable normal operation: keep `ORPHAN_SWEEP_PAUSED` off, confirm hourly cron runs, and schedule Slice 15 cleanup.

## 9. Rollback

Before DNS switch (steps 1 to 7): nothing user-facing changed. Leave Heroku as is (abort criteria above). Production D1/R2 may be wiped with the ledger-guarded `wipe-and-retry.sql` (**REQUIRES HUMAN APPROVAL**).

After DNS switch, within the retention window:

1. Restore the previous DNS records (recorded in step 8) or detach the custom domain from the Worker. **REQUIRES HUMAN APPROVAL.**
2. Restore Heroku to the **recorded formation** from window step 3: scale every process type (web, worker, scheduler and any other) back to its recorded quantity and size, re-enable Heroku Scheduler jobs, check with `heroku ps`, then `heroku maintenance:off`. Scaling only web leaves background jobs (mail, ActiveStorage processing) stopped. The Heroku DB and S3 were read-only and untouched, so Rails serves the pre-window state. Writes made on V2 after cutover are not carried back; export them first if the community needs them (community export API).
3. D1 problems that do not need a full rollback: use Time Travel, but a restore can resurrect a community that was erased after the bookmark, so the erasure procedure comes first. Record the bookmark before every load (`wrangler d1 time-travel info <db>`). Then, per [OPERATIONS-GOVERNANCE.md §6.4](./OPERATIONS-GOVERNANCE.md#64-restore-hold-for-the-orphan-sweeper) and [src/services/ERASURE-OPERATIONS.md](../src/services/ERASURE-OPERATIONS.md):
   1. Quiesce the deployment (no traffic) and set the orphan-sweep hold (`ORPHAN_SWEEP_PAUSED=true` or the `system/orphan-sweep-hold` object).
   2. Run `CommunityErasureService.verifyRestorePoint(targetTimestamp, now)` against the live database and the `ERASURE_RECORDS` bucket. It refuses the restore while an erasure is pending or when the target is before any recorded erasure completion; in that case do not restore, forward-fix instead.
   3. `wrangler d1 time-travel restore <db> --bookmark=<id>` (destructive, overwrites the database).
   4. Before serving: `CommunityErasureService.reconcileRestore(targetTimestamp, now)` re-applies every retained erasure (objects, multipart uploads, rows, sessions). A failure keeps the deployment closed.
   5. Verify D1 and R2 agree, then lift the hold and reopen.
      The `ERASURE_RECORDS` bucket is never restored, rotated or copied with D1 or MEDIA. Time Travel keeps 7 days on Free. **REQUIRES HUMAN APPROVAL.**
4. A Worker code rollback does not undo database writes (CLOUDFLARE-STAGING.md, "Teardown and rollback").

## 10. Known gaps

- **V2 frontend not built.** The Rails UI cannot be retired and Heroku shutdown is blocked until the frontend ships and is accepted (section 0).
- **#282: CSV import media on Workers.** The bounded CSV import is a multi-file multipart bundle; its media handling on Workers is open. Do not promise bulk import with media on Free until #282 closes.
- **Per-community storage quota** is open (SPEC-V2 open question 15).
- **R2 multipart integrity.** R2 verifies each part against the signed SHA-256 payload hash and length. The API checks the assembled size and sniffs the media type. `File.checksum` is null for multipart uploads on Workers.
- **R2 Free 10 GB** versus 30 GB media (decision A).
- **Time Travel on Free** keeps 7 days; the retention window is 30 days, so archive custody, not D1, is the long-term rollback source.
- The staging kit was authored offline; its first real run (2026-11-23, section 3) found and fixed the issues listed there. Expect further wrangler flag drift on later runs (`d1 execute` flags, `d1 list --json` shape).
