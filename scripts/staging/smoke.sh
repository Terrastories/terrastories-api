#!/usr/bin/env bash
# Staging smoke: health, absent dev routes, walkthrough, R2 CORS preflight,
# R2 checksum probe, and the Worker CPU measurement procedure. Dry run by
# default.
#
#   STAGING_URL=https://terrastories-staging-api.<sub>.workers.dev \
#     scripts/staging/smoke.sh [--apply] [--community SLUG] [--cpu-procedure] [--local]
#
# Refuses any STAGING_URL whose host is not a staging host (or a production
# host); STAGING_ALLOW_HOST=<exact host> overrides for a custom staging domain.
# --local: rehearsal against a local workerd (wrangler dev --local) at
# STAGING_URL=http://127.0.0.1:<port> (loopback http only; any other host is
# refused). The R2 S3 probe is skipped (no S3 endpoint locally). The
# walkthrough always gets --d1: staging and workerd both run on D1.
# --allow-destructive is passed to the walkthrough: it only creates and erases
# a disposable community, but it is a write run, so it stays staging-only.
# Env (names only, values never printed):
#   WT_SUPER_IDENTIFIER, WT_SUPER_PASSWORD      super admin for the walkthrough
#   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME  probe
#   STAGING_FRONTEND_ORIGIN                     origin of the R2 CORS preflight
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

COMMUNITY="barbara" CPU_ONLY=0 LOCAL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --community) COMMUNITY="${2:?}"; shift ;;
    --cpu-procedure) CPU_ONLY=1 ;;
    --local) LOCAL=1 ;;
    # Print the whole comment header (line 2 up to the first non-comment line),
    # so growing the header never truncates --help.
    -h|--help) awk 'NR>1 {if (!/^#/) exit; print}' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done

cpu_procedure() {
  cat <<'EOF'
Worker CPU measurement (manual; Workers Free budget is about 10 ms per invocation)
 1. Terminal A: npx wrangler tail terrastories-staging-api --env staging --format json > cpu-tail.jsonl
    (the tail output holds no secrets, but keep it out of git)
 2. Terminal B, 90 MB raw upload (POST /v2/media, one request, under the 100 MB ceiling):
      (use a real 90 MB mp4/webm sample: the Worker sniffs the first 8 KiB, so random bytes are rejected)
      SHA=$(sha256sum sample90.mp4 | cut -d' ' -f1)
      curl -sS -X POST "$STAGING_URL/v2/media?filename=sample90.mp4&role=story_media" \
        -H "Content-Type: video/mp4" -H "x-content-sha256: $SHA" \
        -H "Cookie: <staging session cookie>" --data-binary @sample90.mp4 -o /dev/null -w '%{http_code}\n'
 3. Terminal B, 300 MB multipart (/v2/media/uploads): create the session, PUT each
    presigned part directly to R2, then POST .../complete. The walkthrough media
    chapter or the frontend uploader does this; record the complete call only,
    parts bypass the Worker.
 4. Stop the tail. Read cpuTime per invocation:
      jq -r 'select(.event.request.url!=null) | [.event.request.method, (.event.request.url|split("?")[0]), .cpuTime, .wallTime] | @tsv' cpu-tail.jsonl
 5. Record in the go/no-go sheet: route, size, cpuTime (ms), outcome. Pass: every
    upload invocation (POST /v2/media, /uploads, /complete) stays under the Free
    10 ms budget with no error 1102. Any 1102 is a NO-GO on Free (see runbook).
EOF
}

if [ "$CPU_ONLY" = 1 ]; then cpu_procedure; exit 0; fi

need_env STAGING_URL
if [ "$LOCAL" = 1 ]; then guard url "$STAGING_URL" --local; else guard url "$STAGING_URL"; fi
BASE="${STAGING_URL%/}"
info "mode: $([ "$APPLY" = 1 ] && echo APPLY || echo DRY-RUN) target host checked"

code() { curl -sS -o /dev/null -w '%{http_code}' "$@"; }

if [ "$APPLY" = 1 ]; then
  [ "$(code "$BASE/health")" = 200 ] || die "GET /health is not 200"
  [ "$(code "$BASE/dev/seed")" = 404 ] || die "GET /dev/seed is not 404"
  [ "$(code -I "$BASE/dev/seed")" = 404 ] || die "HEAD /dev/seed is not 404"
  info "health ok; dev routes absent (GET and HEAD)"
else
  echo "+ curl GET $BASE/health (expect 200)"
  echo "+ curl GET and HEAD $BASE/dev/seed (expect 404)"
fi

if [ "$APPLY" = 1 ]; then need_env WT_SUPER_IDENTIFIER WT_SUPER_PASSWORD; fi
(cd "$REPO_ROOT" && run npm run walkthrough -- --base-url "$BASE" --community "$COMMUNITY" --d1 \
  --super-credentials-env --allow-destructive --out "walkthrough-out/staging-$(date -u +%Y%m%dT%H%M%SZ)")
info "go/no-go needs summary.md to show PASS with every interaction row covered (89/89)"

if [ "$LOCAL" = 1 ]; then
  info "--local: R2 CORS preflight, part-checksum probe and CPU procedure skipped (no S3 endpoint or Free-plan CPU limit on local workerd)"
  exit 0
fi

if [ "$APPLY" = 1 ]; then
  need_env R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET_NAME
  guard name "$R2_BUCKET_NAME"
fi
# Browser preflight for a direct part PUT: the bucket's CORS policy only
# counts if the frontend origin is allowed to send it (SPEC-V2 section 6.7).
if [ "$APPLY" = 1 ]; then
  "$STAGING_DIR/cors-preflight.sh" --apply
else
  "$STAGING_DIR/cors-preflight.sh"
fi
(cd "$REPO_ROOT" && run npx tsx scripts/staging/verify-r2-part-checksum.ts) || {
  rc=$?
  die "R2 payload hash probe failed (exit $rc)"
}
echo
cpu_procedure
