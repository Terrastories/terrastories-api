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
#   STAGING_FRONTEND_ORIGIN the frontend origin allowed to PUT parts straight
#                          to R2; rendered into scripts/staging/r2-cors.json
# Names are fixed (terrastories-staging-api / -db / -media / -erasure-records)
# and checked against wrangler.jsonc env.staging, so the deployed config and
# the created resources cannot diverge. Under --apply it also applies the
# media bucket's CORS policy and its abort-incomplete-multipart lifecycle
# rule, then reads both back and refuses if they are not in effect
# (SPEC-V2 section 6.7), and before deploying verifies that wrangler.jsonc
# env.staging DB database_id equals terrastories-staging-db's UUID in the
# guarded account; a dry run prints those commands only. Optional:
#   WORKERS_PLAN        (free) target Workers plan: 'free' or 'paid' (default
#                       free; anything else refuses). Governs config limits
#                       validation, cron budget (5 on Free, 1000 on Paid), and
#                       D1 size headroom (90% of 500 MB on Free, 10 GB on Paid).
#   OTHER_CRON_TRIGGERS (0) cron triggers already used by other Workers in the
#                       account (production uses 3; limit is 5 on Free, 1000 on
#                       Paid)
# A CLOUDFLARE_API_TOKEN exported for another account breaks wrangler: run
# with 'env -u CLOUDFLARE_API_TOKEN' (the account guard checks whoami).
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    # Print the whole comment header (line 2 up to the first non-comment line),
    # so growing the header never truncates --help.
    -h|--help) awk 'NR>1 {if (!/^#/) exit; print}' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) die "unknown argument: $arg" ;;
  esac
done

resolve_workers_plan
PLAN="$WORKERS_PLAN_RESOLVED"

D1_NAME="terrastories-staging-db"
BUCKET="terrastories-staging-media"
ERASURE_BUCKET="terrastories-staging-erasure-records"
WORKER="terrastories-staging-api"
# Media-bucket CORS (rendered from the committed template) and lifecycle.
CORS_TEMPLATE="$STAGING_DIR/r2-cors.json"
CORS_FILE="$STAGING_DIR/.r2-cors.json" # rendered with the origin; gitignored
CORS_ORIGIN_PLACEHOLDER="__STAGING_FRONTEND_ORIGIN__"
PART_UPLOAD_HEADER="x-amz-content-sha256"
LIFECYCLE_RULE="terrastories-staging-abort-incomplete-multipart"
LIFECYCLE_DAYS=1

WRANGLER_CONFIG="$REPO_ROOT/wrangler.jsonc"
WRANGLER_REDIRECT="$REPO_ROOT/.wrangler/deploy/config.json"
if [ -e "$WRANGLER_REDIRECT" ] || [ -L "$WRANGLER_REDIRECT" ]; then
  die "Wrangler deploy config redirect exists: $WRANGLER_REDIRECT"
fi

guard name "$D1_NAME" "$BUCKET" "$ERASURE_BUCKET" "$WORKER" "$LIFECYCLE_RULE"
guard config "$WRANGLER_CONFIG" "$PLAN"
check_account
guard crons "$WRANGLER_CONFIG" staging "${OTHER_CRON_TRIGGERS:-0}" "$PLAN"
need_env STAGING_FRONTEND_ORIGIN
guard origin "$STAGING_FRONTEND_ORIGIN"
info "mode: $([ "$APPLY" = 1 ] && echo APPLY || echo DRY-RUN) plan: $PLAN"

cd "$REPO_ROOT"

# Existing resources (read-only listings; failures mean "unknown", create anyway
# would fail loudly, so treat as hard errors).
d1_list="$(npx wrangler d1 list --json --config "$WRANGLER_CONFIG" 2>/dev/null)" || die "wrangler d1 list failed"
r2_list="$(npx wrangler r2 bucket list 2>/dev/null)" || die "wrangler r2 bucket list failed"

if printf '%s' "$d1_list" | has_name "$D1_NAME"; then
  info "D1 $D1_NAME exists: skipping create"
  if [ "$APPLY" = 1 ]; then
    d1_info="$(npx wrangler d1 info "$D1_NAME" --json --config "$WRANGLER_CONFIG" 2>/dev/null)" \
      || die "wrangler d1 info failed"
    printf '%s' "$d1_info" | guard d1-size --json "$PLAN"
    info "D1 size verified within $PLAN plan headroom"
  else
    echo "+ npx wrangler d1 info $D1_NAME --json --config \"$WRANGLER_CONFIG\"   (verify D1 size within $PLAN plan headroom)"
  fi
else
  run npx wrangler d1 create "$D1_NAME"
  info "paste the printed database_id into wrangler.jsonc env.staging.d1_databases[0]"
fi

if printf '%s' "$r2_list" | has_name "$BUCKET"; then
  info "R2 bucket $BUCKET exists: skipping create"
else
  run npx wrangler r2 bucket create "$BUCKET"
fi

if printf '%s' "$r2_list" | has_name "$ERASURE_BUCKET"; then
  info "R2 bucket $ERASURE_BUCKET exists: skipping create"
else
  run npx wrangler r2 bucket create "$ERASURE_BUCKET"
fi
info "erasure-records bucket: no lifecycle expiration, never restored/copied with D1 or MEDIA, excluded from backups (src/services/ERASURE-OPERATIONS.md)"

# Media-bucket CORS and lifecycle (SPEC-V2 section 6.7): applied under
# --apply, then read back and refused if they are not in effect. A dry run
# renders the same file and prints the wrangler commands, running none of
# them. The erasure-records bucket is never touched by the frontend, so it
# gets neither rule.
render_cors() {
  # Literal substitution, not a regex, so any origin the origin guard accepts
  # lands in the file unchanged. The rename keeps a concurrent reader from
  # seeing a half-written file.
  local tmp="$CORS_FILE.tmp.$$"
  node -e 'const fs=require("node:fs");const [src,dst,origin,token]=process.argv.slice(1);fs.writeFileSync(dst,fs.readFileSync(src,"utf8").split(token).join(origin));' \
    "$CORS_TEMPLATE" "$tmp" "$STAGING_FRONTEND_ORIGIN" \
    "$CORS_ORIGIN_PLACEHOLDER"
  mv -f "$tmp" "$CORS_FILE"
}
render_cors
guard cors-file "$CORS_FILE" "$STAGING_FRONTEND_ORIGIN"

run npx wrangler r2 bucket cors set "$BUCKET" --file "$CORS_FILE" -y
if [ "$APPLY" = 1 ]; then
  cors_list="$(npx wrangler r2 bucket cors list "$BUCKET" 2>/dev/null)" \
    || die "wrangler r2 bucket cors list failed"
  printf '%s' "$cors_list" | guard cors-policy "$STAGING_FRONTEND_ORIGIN"
  info "R2 CORS verified on $BUCKET: only $STAGING_FRONTEND_ORIGIN, PUT with $PART_UPLOAD_HEADER, ETag exposed, max age >= 3600"
else
  echo "+ npx wrangler r2 bucket cors list $BUCKET   (verify: PUT and $PART_UPLOAD_HEADER)"
fi

# The lifecycle rule is idempotent: it is added only when the read-back does
# not already show it, and an added rule is read back before this passes.
# A dry run reads nothing from the account: it prints the add command only.
life_list=""
if [ "$APPLY" = 1 ]; then
  life_list="$(npx wrangler r2 bucket lifecycle list "$BUCKET" 2>/dev/null)" \
    || die "wrangler r2 bucket lifecycle list failed"
fi
if [ "$APPLY" = 1 ] && guard_ok lifecycle "$LIFECYCLE_DAYS" <<<"$life_list"; then
  info "R2 lifecycle verified on $BUCKET: abort incomplete multipart uploads after $LIFECYCLE_DAYS day(s)"
else
  run npx wrangler r2 bucket lifecycle add "$BUCKET" "$LIFECYCLE_RULE" \
    --abort-multipart-days "$LIFECYCLE_DAYS" -y
  if [ "$APPLY" = 1 ]; then
    life_list="$(npx wrangler r2 bucket lifecycle list "$BUCKET" 2>/dev/null)" \
      || die "wrangler r2 bucket lifecycle list failed"
    printf '%s' "$life_list" | guard lifecycle "$LIFECYCLE_DAYS"
    info "R2 lifecycle rule $LIFECYCLE_RULE added and verified on $BUCKET"
  else
    echo "+ npx wrangler r2 bucket lifecycle list $BUCKET   (verify the rule above)"
  fi
fi

if grep -q 'REPLACE-WITH-STAGING-D1-ID' "$WRANGLER_CONFIG"; then
  info "wrangler.jsonc still has the placeholder staging database_id: not deploying the Worker"
  info "after pasting the id and PUBLIC_ORIGIN, rerun: run deploy dry-run below"
  echo "+ npx wrangler deploy --env staging --config \"$WRANGLER_CONFIG\" --dry-run"
else
  if [ "$APPLY" = 1 ]; then
    d1_check_list="$(npx wrangler d1 list --json --config "$WRANGLER_CONFIG" 2>/dev/null)" \
      || die "wrangler d1 list failed"
    printf '%s' "$d1_check_list" | guard d1-id "$WRANGLER_CONFIG"
    info "D1 database_id verified: wrangler.jsonc env.staging DB matches $D1_NAME in account"
  else
    echo "+ npx wrangler d1 list --json --config \"$WRANGLER_CONFIG\"   (verify env.staging DB database_id matches $D1_NAME)"
  fi
  run npx wrangler deploy --env staging --config "$WRANGLER_CONFIG" --dry-run
  run npx wrangler deploy --env staging --config "$WRANGLER_CONFIG"
fi
info "secrets by hand, never by this script (npx wrangler secret put <NAME> --env staging): AUTH_SERVER_SECRET BOOTSTRAP_SECRET R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY, optional MAPBOX_ACCESS_TOKEN"
info "done ($WORKER)"
