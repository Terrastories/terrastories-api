#!/usr/bin/env bash
# Staging smoke: health, absent dev routes, walkthrough, R2 checksum probe, and
# the Worker CPU measurement procedure. Dry run by default.
#
#   STAGING_URL=https://terrastories-staging-api.<sub>.workers.dev \
#     scripts/staging/smoke.sh [--apply] [--community SLUG] [--cpu-procedure]
#
# Refuses any STAGING_URL whose host is not a staging host (or a production
# host); STAGING_ALLOW_HOST=<exact host> overrides for a custom staging domain.
# --allow-destructive is passed to the walkthrough: it only creates and erases
# a disposable community, but it is a write run, so it stays staging-only.
# Env (names only, values never printed):
#   WT_SUPER_IDENTIFIER, WT_SUPER_PASSWORD      super admin for the walkthrough
#   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME  probe
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

COMMUNITY="barbara" CPU_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --community) COMMUNITY="${2:?}"; shift ;;
    --cpu-procedure) CPU_ONLY=1 ;;
    -h|--help) sed -n '2,14p' "${BASH_SOURCE[0]}"; exit 0 ;;
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
guard url "$STAGING_URL"
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
(cd "$REPO_ROOT" && run npm run walkthrough -- --base-url "$BASE" --community "$COMMUNITY" \
  --super-credentials-env --allow-destructive --out "walkthrough-out/staging-$(date -u +%Y%m%dT%H%M%SZ)")
info "go/no-go needs summary.md to show PASS with every interaction row covered (89/89)"

if [ "$APPLY" = 1 ]; then
  need_env R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET_NAME
  guard name "$R2_BUCKET_NAME"
fi
(cd "$REPO_ROOT" && run npx tsx scripts/staging/verify-r2-part-checksum.ts) || {
  rc=$?
  # exit 2 = not enforced (documented outcome, record it); anything else fails.
  [ "$rc" = 2 ] && info "probe: R2 does NOT enforce part checksums (recorded, not a failure)" || die "probe inconclusive (exit $rc)"
}
echo
cpu_procedure
