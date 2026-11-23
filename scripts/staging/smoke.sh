#!/usr/bin/env bash
# Staging smoke: health, absent dev routes, walkthrough, R2 checksum probe, and
# the Worker CPU measurement procedure. Dry run by default.
#
#   STAGING_URL=https://terrastories-staging-api.<sub>.workers.dev \
#     scripts/staging/smoke.sh [--apply] [--community SLUG] [--cpu-procedure] [--local]
#       [--skip-walkthrough]
#
# Refuses any STAGING_URL whose host is not a staging host (or a production
# host); STAGING_ALLOW_HOST=<exact host> overrides for a custom staging domain.
# --local: rehearsal against a local workerd (wrangler dev --local) at
# STAGING_URL=http://127.0.0.1:<port> (loopback http only; any other host is
# refused). The R2 S3 probe is skipped (no S3 endpoint locally). The
# walkthrough always gets --d1: staging and workerd both run on D1.
# --skip-walkthrough: skip the embedded walkthrough (use on a second run the same
# UTC day: D1 allows one committed import per UTC day for the whole database and
# the walkthrough commits one). Without the flag, smoke remembers the UTC day of
# its last successful walkthrough per target URL (walkthrough-out/
# .staging-import-utc-day-<hash of URL>, so local and remote runs do not share
# it) and prints 'walkthrough already ran today' instead of failing. A run from
# another machine is not seen; a walkthrough failure is never reclassified (it
# could hide a real failed check), it only prints a hint about the daily rule.
# GET /v2/imports is community-scoped, so it cannot show other runs' imports.
# --allow-destructive is passed to the walkthrough: it only creates and erases
# a disposable community, but it is a write run, so it stays staging-only.
# Env (names only, values never printed):
#   WT_SUPER_IDENTIFIER, WT_SUPER_PASSWORD      super admin for the walkthrough
#   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME  probe
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

COMMUNITY="barbara" CPU_ONLY=0 LOCAL=0 SKIP_WT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --community) COMMUNITY="${2:?}"; shift ;;
    --cpu-procedure) CPU_ONLY=1 ;;
    --local) LOCAL=1 ;;
    --skip-walkthrough) SKIP_WT=1 ;;
    -h|--help) sed -n '2,28p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done

cpu_procedure() {
  cat <<'EOF'
Worker CPU measurement (manual; Workers Free budget is about 10 ms per invocation)
 1. Terminal A: npx wrangler tail terrastories-staging-api --format json > cpu-tail.json
    (no --env: the worker name already includes "staging"; with an exported
    CLOUDFLARE_API_TOKEN for another account use env -u CLOUDFLARE_API_TOKEN.
    The tail output holds no secrets, but keep it out of git.)
 2. Terminal B, 90 MB raw upload (POST /v2/media, one request, under the 100 MB ceiling):
      (use a real 90 MB mp4/webm sample: the Worker sniffs the first 8 KiB, so random bytes are rejected)
      SHA=$(sha256sum sample90.mp4 | cut -d' ' -f1)
      curl -sS -X POST "$STAGING_URL/v2/media?filename=sample90.mp4" \
        -H "Content-Type: video/mp4" -H "x-content-sha256: $SHA" \
        -H "Cookie: <staging session cookie>" --data-binary @sample90.mp4 -o /dev/null -w '%{http_code}\n'
 3. Role note: do NOT send a role param for this upload. POST /v2/media with raw
    bytes only accepts role=user_photo (binds the upload to a user); any other
    role is 400 "Direct upload binding only supports user_photo; use POST
    /v2/attachments". Omitting role stores an unbound media object.
 4. Terminal B, 300 MB multipart (/v2/media/uploads): create the session, PUT each
    presigned part directly to R2, then POST .../complete. The walkthrough media
    chapter or the frontend uploader does this; record the complete call only,
    parts bypass the Worker.
 5. Stop the tail. wrangler pretty-prints each event over many lines, so the file
    is concatenated JSON objects, not JSON Lines (line-based jq fails). Parse it
    with the balanced-brace reader (prints method, url, outcome, cpuTime, wallTime):
      node scripts/staging/parse-tail.mjs cpu-tail.json
 6. Record in the go/no-go sheet: route, size, cpuTime (ms), outcome. Pass: every
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
MARK_DIR="$REPO_ROOT/walkthrough-out"; MARK="$MARK_DIR/.staging-import-utc-day-$(printf '%s' "$BASE" | sha256sum | cut -c1-12)"; TODAY="$(date -u +%F)"
WT_MSG="walkthrough already ran today (UTC $TODAY): D1 allows one committed import per UTC day. Rerun after 00:00 UTC, or use --skip-walkthrough."
if [ "$SKIP_WT" = 1 ]; then
  info "walkthrough skipped (--skip-walkthrough)"
elif [ "$APPLY" = 1 ] && [ -f "$MARK" ] && [ "$(cat "$MARK")" = "$TODAY" ]; then
  info "$WT_MSG"
else
  WT_RC=0
  (cd "$REPO_ROOT" && run npm run walkthrough -- --base-url "$BASE" --community "$COMMUNITY" --d1 \
    --super-credentials-env --allow-destructive --out "walkthrough-out/staging-$(date -u +%Y%m%dT%H%M%SZ)") || WT_RC=$?
  if [ "$WT_RC" != 0 ]; then
    info "hint: if another run already committed an import today (UTC $TODAY), the import steps fail by design; read summary.md, and rerun after 00:00 UTC or with --skip-walkthrough"
    die "walkthrough failed (exit $WT_RC)"
  else
    if [ "$APPLY" = 1 ]; then mkdir -p "$MARK_DIR"; echo "$TODAY" > "$MARK"; fi
    info "go/no-go needs summary.md to show PASS with every interaction row covered (89/89)"
  fi
fi

if [ "$LOCAL" = 1 ]; then
  info "--local: R2 part-checksum probe and CPU procedure skipped (no S3 endpoint or Free-plan CPU limit on local workerd)"
  exit 0
fi

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
