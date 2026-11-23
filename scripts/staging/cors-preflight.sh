#!/usr/bin/env bash
# R2 CORS preflight: the browser's own check before a direct part PUT.
#
#   STAGING_FRONTEND_ORIGIN=https://app.example.org \
#   R2_ACCOUNT_ID=<32-hex account id> R2_BUCKET_NAME=terrastories-staging-media \
#     scripts/staging/cors-preflight.sh [--apply]
#
# Sends OPTIONS with Origin, Access-Control-Request-Method: PUT and
# Access-Control-Request-Headers: x-amz-content-sha256 to the bucket's S3
# endpoint and refuses unless the answer allows that origin, method and
# header (SPEC-V2 section 6.7). Dry run by default: prints the curl command
# only. Runs from smoke.sh; no wrangler call, no Cloudflare write. The bucket
# must be a terrastories-staging-* name and, when CLOUDFLARE_ACCOUNT_ID is
# set, the account it belongs to. Env values other than the origin are never
# printed.
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

PART_UPLOAD_HEADER="x-amz-content-sha256"
S3_HOST_SUFFIX=".r2.cloudflarestorage.com"

for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    # Print the whole comment header (line 2 up to the first non-comment line),
    # so growing the header never truncates --help.
    -h|--help) awk 'NR>1 {if (!/^#/) exit; print}' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) die "unknown argument: $arg" ;;
  esac
done
info "mode: $([ "$APPLY" = 1 ] && echo APPLY || echo DRY-RUN)"

if [ "$APPLY" != 1 ]; then
  echo "+ curl -sS -i -X OPTIONS https://\$R2_ACCOUNT_ID$S3_HOST_SUFFIX/\$R2_BUCKET_NAME -H \"Origin: \$STAGING_FRONTEND_ORIGIN\" -H \"Access-Control-Request-Method: PUT\" -H \"Access-Control-Request-Headers: $PART_UPLOAD_HEADER\""
  exit 0
fi

need_env STAGING_FRONTEND_ORIGIN R2_ACCOUNT_ID R2_BUCKET_NAME
guard origin "$STAGING_FRONTEND_ORIGIN"
guard name "$R2_BUCKET_NAME"
if [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] &&
  [ "${R2_ACCOUNT_ID,,}" != "${CLOUDFLARE_ACCOUNT_ID,,}" ]; then
  die "R2_ACCOUNT_ID does not match CLOUDFLARE_ACCOUNT_ID (wrong account)"
fi
[[ "$R2_ACCOUNT_ID" =~ ^[0-9a-fA-F]{32}$ ]] ||
  die "R2_ACCOUNT_ID must be the 32-hex Cloudflare account id"
endpoint="https://$R2_ACCOUNT_ID$S3_HOST_SUFFIX/$R2_BUCKET_NAME"
if ! answer="$(curl -sS -i -X OPTIONS "$endpoint" \
    -H "Origin: $STAGING_FRONTEND_ORIGIN" \
    -H "Access-Control-Request-Method: PUT" \
    -H "Access-Control-Request-Headers: $PART_UPLOAD_HEADER")"; then
  die "CORS preflight request to $endpoint failed"
fi
printf '%s' "$answer" | guard preflight "$STAGING_FRONTEND_ORIGIN"
info "CORS preflight allowed: PUT with $PART_UPLOAD_HEADER from $STAGING_FRONTEND_ORIGIN"
