#!/usr/bin/env bash
# Provision the Terrastories staging resources on Cloudflare.
#
#   scripts/staging/provision.sh            # dry run: prints what it would do
#   scripts/staging/provision.sh --apply    # creates missing resources
#
# Creates ONLY resources named terrastories-staging-*: a D1 database, an R2
# bucket, and (once wrangler.jsonc has the real database_id) the Worker.
# Never deletes anything. Requires:
#   CLOUDFLARE_ACCOUNT_ID  the expected work-account id; must appear in
#                          `npx wrangler whoami` or the script refuses
#   CLOUDFLARE_API_TOKEN   (or an interactive wrangler login)
# Optional name overrides (must keep the prefix):
#   STAGING_D1_NAME (terrastories-staging-db)
#   STAGING_R2_BUCKET (terrastories-staging-media)
#   STAGING_WORKER_NAME (terrastories-staging-api)
#   OTHER_CRON_TRIGGERS (3: crons already used by the production template)
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    -h|--help) sed -n '2,19p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) die "unknown argument: $arg" ;;
  esac
done

D1_NAME="${STAGING_D1_NAME:-terrastories-staging-db}"
BUCKET="${STAGING_R2_BUCKET:-terrastories-staging-media}"
WORKER="${STAGING_WORKER_NAME:-terrastories-staging-api}"

guard name "$D1_NAME" "$BUCKET" "$WORKER"
check_account
guard crons "$REPO_ROOT/wrangler.jsonc" staging "${OTHER_CRON_TRIGGERS:-3}"
info "mode: $([ "$APPLY" = 1 ] && echo APPLY || echo DRY-RUN)"

cd "$REPO_ROOT"

# Existing resources (read-only listings; failures mean "unknown", create anyway
# would fail loudly, so treat as hard errors).
d1_list="$(npx wrangler d1 list --json 2>/dev/null)" || die "wrangler d1 list failed"
r2_list="$(npx wrangler r2 bucket list 2>/dev/null)" || die "wrangler r2 bucket list failed"

if printf '%s' "$d1_list" | grep -q "\"$D1_NAME\""; then
  info "D1 $D1_NAME exists: skipping create"
else
  run npx wrangler d1 create "$D1_NAME"
  info "paste the printed database_id into wrangler.jsonc env.staging.d1_databases[0]"
fi

if printf '%s' "$r2_list" | grep -q "$BUCKET"; then
  info "R2 bucket $BUCKET exists: skipping create"
else
  run npx wrangler r2 bucket create "$BUCKET"
fi

info "R2 lifecycle (abort incomplete multipart after 1 day) and CORS (PUT, x-amz-checksum-sha256, content-type; expose ETag; MaxAge >= 3600) are set per docs/CUTOVER-RUNBOOK.md section 3"

if grep -q 'REPLACE-WITH-STAGING-D1-ID' wrangler.jsonc; then
  info "wrangler.jsonc still has the placeholder staging database_id: not deploying the Worker"
  info "after pasting the id and PUBLIC_ORIGIN, rerun: run deploy dry-run below"
  echo "+ npx wrangler deploy --env staging --dry-run"
else
  run npx wrangler deploy --env staging --dry-run
  run npx wrangler deploy --env staging
fi
info "secrets are set by hand, never by this script: npx wrangler secret put <NAME> --env staging"
info "done ($WORKER)"
