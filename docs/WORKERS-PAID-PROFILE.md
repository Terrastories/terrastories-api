# Workers Paid profile (approved option, not active)

**Status (2026-11-23, #295):** the hosted profile stays on Workers Free (SPEC-V2 Section 5, #184). Staging measurements on 2026-11-23, recorded in issue [#295](https://github.com/Terrastories/terrastories-api/issues/295), show CPU above the 10 ms Free budget on several routes (`POST /v2/media` up to 92 ms, `POST /v2/community/export` 87 ms, `/v2/community/erasure` 63 ms, `POST /v2/stories` 56 ms, others 14 to 25 ms), all with outcome ok and no error 1102 yet (per the issue). This file is the plan for switching to Workers Paid if Free stops holding. Nothing here is applied. Switching needs a spec change, an owner decision and a payment method: **REQUIRES HUMAN APPROVAL**.

**Decided (2026-11-24, [#187](https://github.com/Terrastories/terrastories-api/issues/187)):** a Workers Paid production profile is allowed; Workers Free stays a supported profile and the staging profile; the Paid erasure bound is accepted at 31 days worst case. SPEC-V2 is amended accordingly. The payment method (step 2) still needs human approval.

Prices and limits below were read on 2026-11-23. Recheck them before acting.

## 1. When to switch

Switch only when one of these holds and the Free-path fixes (#295, codex diagnosis steps 1 to 3) cannot remove it:

- **CPU errors.** Any `exceededCpu` outcome in `wrangler tail` or analytics, or any client error 1102 ("Worker exceeded resource limits") confirmed as `exceededCpu`. Error 1102 also covers memory, and Paid keeps the same 128 MB isolate limit, so a memory 1102 is not a reason to switch. Workers applies the limit with some flexibility for occasional overruns, then terminates a Worker that keeps exceeding it ([limits](https://developers.cloudflare.com/workers/platform/limits/)). The current overruns are therefore a risk, not yet a failure.
- **CPU trend.** p99 CPU of a user-facing route stays above 10 ms on production traffic, aggregated per route from production `wrangler tail` output or Workers analytics. The staging CPU procedure (`scripts/staging/smoke.sh --cpu-procedure`, `node scripts/staging/parse-tail.mjs`) covers upload routes on staging and prints single events, so it gives samples, not a production p99.
- **Export or erasure size.** A real community exceeds the Workers export caps in `src/shared/export-policy.ts` (10,000 rows, 30 files, 50 MiB media, 64 MiB archive) and the self-hosted alternative is not acceptable to that community. Or erasure of a real community cannot finish inside 24 hours with the Free limits: 50 subrequests per invocation, 1,000 subrequests to internal services, 50 D1 queries per invocation ([limits](https://developers.cloudflare.com/workers/platform/limits/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)). The app budgets (`WORKER_ERASURE_STORAGE_BUDGET = 15`, `WORKER_SWEEP_SUBREQUEST_BUDGET = 40`) are conservative choices below those limits, not the limits themselves.
- **D1 quotas.** D1 Free gives 5 million rows read and 100,000 rows written per day, 500 MB per database and 5 GB per account; at the daily limit queries fail ([D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)). The app also allows one committed import per UTC day on D1 (`d1_daily_import_limit`, `src/services/imports.service.ts`). That rule is app policy derived from the write budget, not a Cloudflare limit. Switch if real imports or traffic keep reaching these limits.
- **Account limits.** More than 5 cron triggers are needed in the account (staging 3 plus production 3 is 6; see `docs/CUTOVER-RUNBOOK.md` section 6), or more than 100,000 requests per day ([limits](https://developers.cloudflare.com/workers/platform/limits/)).
- **R2.** R2 storage above 10 GB-month is billed on any Workers plan ([R2 pricing](https://developers.cloudflare.com/r2/pricing/)). It is decision A in the runbook and is not by itself a reason to buy Workers Paid.

## 2. What changes on Paid

| Limit                      | Workers Free                                                      | Workers Paid                                                                                                                               | Source                                                                                                                                                     |
| -------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CPU per HTTP request       | 10 ms                                                             | default 30 s, configurable up to 5 min (300,000 ms) with `limits.cpu_ms`                                                                   | [limits](https://developers.cloudflare.com/workers/platform/limits/), [wrangler config](https://developers.cloudflare.com/workers/wrangler/configuration/) |
| CPU per cron invocation    | 10 ms                                                             | default 30 s, max 5 min (intervals under 1 hour); 15 min for intervals of 1 hour or more                                                   | [limits](https://developers.cloudflare.com/workers/platform/limits/)                                                                                       |
| Subrequests per invocation | 50; 1,000 to internal services (D1, R2, KV)                       | default 10,000, configurable up to 10 million (`limits.subrequests`); internal services follow the configured limit                        | [limits](https://developers.cloudflare.com/workers/platform/limits/), [wrangler config](https://developers.cloudflare.com/workers/wrangler/configuration/) |
| Cron triggers per account  | 5                                                                 | 1,000                                                                                                                                      | [limits](https://developers.cloudflare.com/workers/platform/limits/)                                                                                       |
| Requests                   | 100,000 per day                                                   | 10 million per month included, then USD 0.30 per million                                                                                   | [limits](https://developers.cloudflare.com/workers/platform/limits/), [pricing](https://developers.cloudflare.com/workers/platform/pricing/)               |
| CPU billing                | none                                                              | 30 million CPU ms per month included, then USD 0.02 per million CPU ms                                                                     | [pricing](https://developers.cloudflare.com/workers/platform/pricing/)                                                                                     |
| Base price                 | USD 0                                                             | minimum USD 5 per month per account                                                                                                        | [pricing](https://developers.cloudflare.com/workers/platform/pricing/)                                                                                     |
| Memory per isolate         | 128 MB                                                            | 128 MB (unchanged)                                                                                                                         | [limits](https://developers.cloudflare.com/workers/platform/limits/)                                                                                       |
| Request body size          | 100 MB (Free/Pro zone)                                            | same: set by the zone plan, not the Workers plan                                                                                           | [limits](https://developers.cloudflare.com/workers/platform/limits/)                                                                                       |
| D1 rows read               | 5 million per day                                                 | 25 billion per month included, then USD 0.001 per million                                                                                  | [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)                                                                                       |
| D1 rows written            | 100,000 per day                                                   | 50 million per month included, then USD 1.00 per million                                                                                   | [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)                                                                                       |
| D1 storage                 | 500 MB per database, 5 GB per account                             | 10 GB per database, 1 TB per account; 5 GB included, then USD 0.75 per GB-month                                                            | [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)                   |
| D1 queries per invocation  | 50                                                                | 1,000                                                                                                                                      | [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)                                                                                         |
| D1 Time Travel             | 7 days                                                            | 30 days, always on                                                                                                                         | [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)                                                                                 |
| R2 Standard storage        | 10 GB-month, 1 million Class A, 10 million Class B per month free | same free tier on any Workers plan; then USD 0.015 per GB-month, USD 4.50 per million Class A, USD 0.36 per million Class B, no egress fee | [R2 pricing](https://developers.cloudflare.com/r2/pricing/)                                                                                                |
| Queues                     | 10,000 operations per day                                         | 1 million operations per month included, then USD 0.40 per million                                                                         | [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/)                                                                               |
| Workflows                  | available; 10 ms CPU per invocation, 3,000 steps per day          | CPU raised with `limits.cpu_ms`                                                                                                            | [Workflows pricing](https://developers.cloudflare.com/workflows/reference/pricing/)                                                                        |

### Erasure bound: decided (#187)

SPEC-V2 Section 7 (Backups) stated the Paid bound as an open question until the 2026-11-24 decision below. On Paid, Time Travel keeps 30 days, counted from when each DELETE lands. Live deletion completes at C, at most T + 24 hours after the request T. A deleted row then stays in Time Travel history until C + 30 days: up to 31 days after the request, not 30. Section 7 still forbids using it: operator tooling refuses every restore while an erasure is pending, refuses any point before completion, and reconciles erasures after an allowed restore before serving. The bound is about how long a copy exists, not about a permitted restore. The owner had to choose one of these before Paid serves real communities:

1. **Accept 31 days.** Amend the 30-day request-anchored promise for the Paid profile (Sections 4, 6.7, 7, 12, 14) and tell communities.
2. **Keep 30 days.** Use a shorter Time Travel or backup policy on Paid. The Time Travel page does not say retention can be shortened (see Open Questions), so this option may not exist on D1.

This gate is closed by the decision below; it no longer blocks go-live. Neither the walkthrough nor smoke could have passed it.

**Decided 2026-11-24 ([#187](https://github.com/Terrastories/terrastories-api/issues/187)):** option 1. The 31-day worst case is accepted for Workers Paid; Workers Free and the self-hosted/field-kit profiles keep 30 days from the request; the restore refusal and reconciliation rules are unchanged. SPEC-V2 Sections 4, 6.7 to 6.9, 7, 12 and 14 state it. Communities hosted on Paid must be told the bound.

## 3. Implementation checklist (in order)

Snapshot every changed file under `backups/` first. Each step lands as its own reviewed PR.

1. **Decide and amend the spec** (section 5 below), including #187. No config change before the spec allows a paid profile. **Decided 2026-11-24** ([#187](https://github.com/Terrastories/terrastories-api/issues/187)); SPEC-V2 amended. Staging stays on Workers Free (section 4).
2. **Subscribe** the target account to Workers Paid in the dashboard. **REQUIRES HUMAN APPROVAL** (payment method). The plan is per account, and staging stays on Workers Free (decided 2026-11-24): subscribe only the production account, which must be separate from the staging account (section 4).
3. **`wrangler.jsonc`.** Add a CPU cap. `limits` is inheritable: a top-level block also applies to `env.staging` unless that environment overrides it ([wrangler config](https://developers.cloudflare.com/workers/wrangler/configuration/)). Production deploys from the top-level block today. Staging stays on a Free account, so do not put `limits` at the top level: add an `env.production` block holding it and deploy production with `--env production`. An `env.production` block inherits almost nothing that matters here: bindings, `vars` and secrets are non-inheritable and must be set per environment ([environments](https://developers.cloudflare.com/workers/wrangler/environments/#non-inheritable-keys-and-environments)). Repeat in it the production `name`, `d1_databases` (`DB`), `r2_buckets` (`MEDIA`, `ERASURE_RECORDS`), `vars` (`PUBLIC_ORIGIN`, `CORS_ORIGINS`, `R2_BUCKET_NAME`) and `triggers.crons`, as `env.staging` does, and set every secret with `wrangler secret put ... --env production` (`AUTH_SERVER_SECRET`, `BOOTSTRAP_SECRET`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`; optional `MAPBOX_ACCESS_TOKEN`). Check with `npx wrangler deploy --env production --dry-run`. Put `limits` only in the environment deployed to the Paid account:

   ```jsonc
   // Workers Paid only (docs/WORKERS-PAID-PROFILE.md). Caps cost of a runaway
   // invocation; tighten to about 5x the measured p99 of the slowest route.
   "limits": { "cpu_ms": 30000 },
   ```

   Start at 30,000 ms, the Paid default, written out so the budget is explicit. Lower it after the step 8 measurement. Leave `limits.subrequests` unset (default 10,000). Keep all three `triggers.crons` strings unchanged: `src/worker.ts` matches them exactly.

4. **`scripts/staging/guards.ts`.** It hard-codes Free limits:
   - `FREE_CRON_LIMIT_PER_ACCOUNT = 5` in `assertCronBudget`: take the plan as input (for example `WORKERS_PLAN=paid`, limit 1,000), default Free.
   - `D1_FREE_MAX_BYTES` (500 MB, 90 percent headroom) in `assertD1Size`: use 10 GB on Paid.
   - `assertStagingConfig`: check the effective configuration per Wrangler's per-key rules: inheritable keys such as `limits` fall back to the top level when the environment omits them; non-inheritable keys (bindings, `vars`) come only from the environment block. On Paid, require `limits.cpu_ms` to be present and at most 300,000. On Free, refuse an inherited or explicit `limits` (see Open Questions).
   - Update the guard tests for both plans.
5. **`scripts/staging/provision.sh`.** Lines 23 to 24 document `OTHER_CRON_TRIGGERS` against the Free limit of 5. Line 56 runs `guard crons ... "${OTHER_CRON_TRIGGERS:-0}"`. Pass the plan to that guard. `provision.sh` does not call `guard d1-size` today (the command exists in `guards.ts`): wire it to the size from `wrangler d1 info`, with the plan. Print the plan in the dry run.
   **`scripts/staging/smoke.sh`.** `cpu_procedure` states the Free 10 ms budget and "Any 1102 is a NO-GO on Free". Add the Paid pass rule: zero `exceededCpu`, p99 per route under half of `limits.cpu_ms`. Keep the Free rule as the default.
6. **Free-only constants in code** (later profile-switched PRs; read the plan from one config value, never fork the code):
   - `src/services/media-cleanup.service.ts` `WORKER_SWEEP_SUBREQUEST_BUDGET = 40` (sized under Free 50).
   - `src/shared/export-policy.ts` `WORKERS_EXPORT_MAX_*` and `WORKER_EXPORT_SWEEP_BATCH_LIMIT = 5`.
   - `src/services/community-erasure.service.ts` `WORKER_ERASURE_STORAGE_BUDGET = 15`.
   - `src/migration/v2/load.ts` `D1_FREE_DAILY_ROWS_WRITTEN` and the one-import-per-UTC-day rule in `src/services/imports.service.ts`.
   - If the import rule becomes plan-dependent, make the walkthrough plan-aware too. `scripts/walkthrough/run.ts --d1` (chapter `scripts/walkthrough/chapters/editor.ts`) commits one import and asserts `429 d1_daily_import_limit` for the second, so on Paid it would fail on correct behavior. Add a plan option to the walkthrough and have `smoke.sh` pass it.

   What simplifies: with 30 s CPU and 10,000 subrequests, export and erasure can stay synchronous as built. Codex diagnosis steps 4 and 5 (bounded erasure hand-off, capped synchronous export) become optional. Moving export generation to Queues or Workflows is not needed. It would also change the Section 7 Delivery contract (generation on request returns the download tokens) and the Section 9 API contract, so do it only with a spec amendment. Erasure already retries on the `*/1 * * * *` cron and stays there. The client-side password KDF stays: it is a protocol decision (Section 7, Section 14), not only a Free workaround.

7. **Verify on staging (Workers Free only)** before production. Staging stays on Free, so it checks the Free behavior and the plan-aware code paths with the Free plan selected:
   - `provision.sh` dry run, then `--apply`; `wrangler d1 info` shows `version: production`.
   - `scripts/staging/smoke.sh --apply`: health, walkthrough 89/89 with `--d1` and the Free plan option from step 6 (it uses the day's single import), CORS preflight, R2 part-checksum probe.
   - Free CPU procedure (`smoke.sh --cpu-procedure`, `parse-tail.mjs`) with the Free rule.
8. **Production go/no-go (the only Paid account)**, plan active, before the Paid deployment serves real communities:
   - The staging CPU procedure (`smoke.sh --cpu-procedure`, `parse-tail.mjs`) targets the staging Worker only and exercises only the upload routes. Before go-live, `docs/CUTOVER-RUNBOOK.md` section 5 (the go/no-go checklist, updated in step 9) must define a production-targeted procedure: `wrangler tail <production worker>`, plus a scripted pass over every route in #295 (login, claim, story write, media upload, direct upload create and complete, export) and one erasure in a throwaway production community, each with real credentials kept out of the repo. Measure with the Paid rule (zero `exceededCpu`, p99 per route under half of `limits.cpu_ms`). Record p50, p99, wall time and outcome in the go/no-go sheet.
   - Erasure live deletion finishes within 24 hours. Restore tooling refuses a restore while an erasure is pending and to a point before completion, and reconciles erasures after an allowed restore before serving (Section 7).
   - Then lower `limits.cpu_ms` (step 3) and rerun the CPU procedure.
9. **Production.** Update `docs/CUTOVER-RUNBOOK.md` sections 4 B, 5 and 6: the 6-of-5 cron workaround and the Free CPU and D1 checks become Paid checks. Deploy with the same `limits` block. Record the change in the same PR.
10. **Rollback to Free.** Preconditions: every D1 database under 500 MB, all D1 storage in the account under 5 GB, at most 10 D1 databases in the account ([D1 limits](https://developers.cloudflare.com/d1/platform/limits/)), total crons in the account at most 5, export and sweep budgets back to the Free values, and the Free-path CPU fixes from #295 landed (otherwise the 1102 risk returns). Then remove `limits`, set the guard plan back to Free, redeploy, and downgrade the plan last. Time Travel depth drops to 7 days (see Open Questions on history already kept).

## 4. Cost estimate

Assumptions: one production Worker plus one staging Worker; the R2 free tier (10 GB-month) applies once per account, as SPEC-V2 Section 5 states (the R2 pricing page does not say "per account": inferred); production about 1 million requests per month at 20 ms average CPU (20 million CPU ms); each Worker runs 2 minute crons and 1 hourly cron (about 87,000 invocations per month each, about 174,000 for both, counted as requests as in the [pricing page's cron example](https://developers.cloudflare.com/workers/platform/pricing/)) at an assumed 10 ms average CPU (about 2 million CPU ms); R2 Standard storage class; D1 under 5 GB in total; R2 holds about 30 GB of production media and about 10 GB on staging; R2 operations stay inside the free tier.

| Item                            | Quantity                                     | Monthly cost (USD) |
| ------------------------------- | -------------------------------------------- | ------------------ |
| Workers Paid base (one account) | 1                                            | 5.00               |
| Requests                        | about 1.2 million of 10 million included     | 0.00               |
| CPU                             | about 22 million ms of 30 million included   | 0.00               |
| D1                              | under 5 GB, rows inside the included amounts | 0.00               |
| R2 storage                      | 40 GB minus 10 GB free = 30 GB at 0.015      | 0.45               |
| **Total, one account**          |                                              | **about 5.45**     |

Split accounts (staging on its own account, each with its own 10 GB R2 allowance):

| Case                         | Production account                 | Staging account                     | Total (USD) |
| ---------------------------- | ---------------------------------- | ----------------------------------- | ----------- |
| Both Paid (not chosen)       | 5.00 + (30 - 10) GB x 0.015 = 5.30 | 5.00 + 0 (10 GB inside free) = 5.00 | about 10.30 |
| Staging stays Free (decided) | 5.30                               | 0.00                                | about 5.30  |

Sources: [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [R2 pricing](https://developers.cloudflare.com/r2/pricing/). Staging stays on a Free account (decided 2026-11-24), so production and staging are separate accounts, the one-account table above does not apply, and staging cannot rehearse the Paid caps (step 8). Sensitivity: the 8 million CPU ms of headroom is about 46 ms more per cron invocation, or 8 ms more per HTTP request, before overage; every further 10 million CPU ms costs USD 0.20; every further 1 million requests costs USD 0.30. The R2 line is due on Free too once media passes 10 GB (runbook decision A).

## 5. Spec changes needed

Amend in `docs/SPEC-V2.md` before go-live:

- **Section 5:** the launch profile table (hosted runtime "Cloudflare Workers (Free plan)"), the cost envelope ("Free hosting is a requirement. Funding a paid plan is not an option for launch.") and its quota notes; add a Paid row.
- **Section 7, Export:** the "Workers Free limits" paragraph; state per-plan caps.
- **Section 7, Backups** and its open item: resolve #187 (accept 31 days, or a shorter policy).
- **Sections 4, 6.7, 6.8, 6.9:** the "within 30 days" erasure promises, if option 1 is chosen.
- **Section 12:** per-profile release gates (Paid CPU, export and erasure assertions).
- **Section 14:** the "Launch profiles?" and "Hosting cost?" rows.
- **Section 15:** change log entry.

Also update `docs/CUTOVER-RUNBOOK.md` (sections 4 B, 5, 6, 10) and the status line of `docs/CLOUDFLARE-STAGING.md`.

## Open Questions

- Can `limits.cpu_ms` sit in the config of a Free account without the deploy failing or being ignored? The docs describe it only for Paid ([limits](https://developers.cloudflare.com/workers/platform/limits/)). Inferred: Free refuses it, so keep it out of any environment deployed to a Free account.
- Can D1 Time Travel retention be shortened on Paid? The Time Travel page says it is always on and gives no setting ([Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)). Inferred: it cannot, which leaves only option 1 of #187 for D1.
- On downgrade, what happens to Time Travel history older than 7 days and to a D1 database above 500 MB? Inferred: history is cut to 7 days and an oversized database blocks writes or the downgrade. Verify with Cloudflare before relying on rollback.
- Do cron invocations count toward billed requests? The pricing page's hourly-cron example counts 720 requests per month ([pricing](https://developers.cloudflare.com/workers/platform/pricing/)). Inferred: yes.
- At what production traffic does the Free CPU flexibility end and 1102 start? No 1102 has been seen on staging. Inferred: no published threshold exists, so only production tail logs can tell.
