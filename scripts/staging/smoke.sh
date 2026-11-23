#!/usr/bin/env bash
# Staging smoke: health, absent dev routes, walkthrough, R2 checksum probe, and
# the Worker CPU measurement procedure. Dry run by default.
#
#   STAGING_URL=https://terrastories-staging-api.<sub>.workers.dev \
#     scripts/staging/smoke.sh [--apply] [--community SLUG] [--cpu-procedure] [--local]
#       [--skip-walkthrough] [--skip-r2-probe]
#
# Refuses any STAGING_URL whose host is not a staging host (or a production
# host); STAGING_ALLOW_HOST=<exact host> overrides for a custom staging domain.
# --local: rehearsal against a local workerd (wrangler dev --local) at
# STAGING_URL=http://127.0.0.1:<port> (loopback http only; any other host is
# refused). The R2 S3 probe is skipped (no S3 endpoint locally). The
# walkthrough always gets --d1: staging and workerd both run on D1.
# --skip-walkthrough: skip the embedded walkthrough (use on a second run the same
# UTC day: D1 allows one committed import per UTC day for the whole database and
# the walkthrough commits one). Without the flag, smoke remembers the UTC day
# its last successful walkthrough COMMITTED the import (the commit step's
# server timestamp data.committedAt in results.json, else the client's; fallback
# only when results.json is missing or unreadable: the day the walkthrough
# started, never the end time; no passing commit step means no marker) per
# target URL (walkthrough-out/ or $STAGING_MARKER_DIR/
# .staging-import-utc-day-<hash of URL>, so local and remote runs do not share
# it) and prints 'walkthrough already ran today' instead of failing. A run from
# another machine is not seen; a walkthrough failure is never reclassified (it
# could hide a real failed check), it only prints a hint about the daily rule.
# GET /v2/imports is community-scoped, so it cannot show other runs' imports.
# --skip-r2-probe: skip the R2 part-checksum probe (e.g. no bucket-scoped S3
# credentials exist yet). Prints 'R2 probe skipped: not verified' and the final
# summary records the probe as NOT done, never a pass; the go/no-go probe item
# stays unchecked until the probe actually runs.
# --allow-destructive is passed to the walkthrough: it only creates and erases
# a disposable community, but it is a write run, so it stays staging-only.
# Env (names only, values never printed):
#   WT_SUPER_IDENTIFIER, WT_SUPER_PASSWORD      super admin for the walkthrough
#     (required only when the walkthrough will actually run)
#   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME  probe
#     (not required with --skip-r2-probe or --local)
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

COMMUNITY="barbara" CPU_ONLY=0 LOCAL=0 SKIP_WT=0 SKIP_R2_PROBE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --community) COMMUNITY="${2:?}"; shift ;;
    --cpu-procedure) CPU_ONLY=1 ;;
    --local) LOCAL=1 ;;
    --skip-walkthrough) SKIP_WT=1 ;;
    --skip-r2-probe) SKIP_R2_PROBE=1 ;;
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
 1. Terminal A: npx wrangler tail terrastories-staging-api --format json > cpu-tail.json
    (no --env: the worker name already includes "staging"; with an exported
    CLOUDFLARE_API_TOKEN for another account use env -u CLOUDFLARE_API_TOKEN.
    The tail output holds no secrets, but keep it out of git.)
 2. Terminal B, 90 MB raw upload (POST /v2/media, one request, under the 100 MB ceiling):
      (use a real 90 MB mp4/webm sample: the Worker sniffs the first 8 KiB, so random bytes are rejected)
      SHA=$(sha256sum sample90.mp4 | cut -d' ' -f1)
      (never put the session cookie on the curl command line: it shows in the process
      list and shell history. Keep it in a fresh mktemp header file (mode 600), read
      without echo, and remove it on exit, never a fixed name that may pre-exist or
      be a symlink:)
      f="$(mktemp)"; trap 'rm -f "$f"' EXIT
      read -rs -p 'ts_session value: ' TS; printf 'Cookie: ts_session=%s\n' "$TS" > "$f"
      curl -sS -X POST "$STAGING_URL/v2/media?filename=sample90.mp4" \
        -H "Content-Type: video/mp4" -H "x-content-sha256: $SHA" \
        -H @"$f" --data-binary @sample90.mp4 -o /dev/null -w '%{http_code}\n'
      rm -f "$f"; trap - EXIT   # explicit cleanup. (Or skip curl: upload-large.ts
      below signs in in memory, but it runs the multipart flow only.)
      Require 201. Role note: do NOT send a role param for this upload. POST /v2/media
      with raw bytes only accepts role=user_photo (binds the upload to a user); any
      other role is 400 "Direct upload binding only supports user_photo; use POST
      /v2/attachments". Omitting role stores an unbound media object.
 3. Terminal B, 300 MB direct multipart upload (/v2/media/uploads). The helper runs
    the whole flow, requires 2xx on every call, and never prints secrets
    (credentials come from the environment only):
      STAGING_URL=... WT_SUPER_IDENTIFIER=... WT_SUPER_PASSWORD=... \
        npx tsx scripts/staging/upload-large.ts --file sample300.mp4
    (--dry-run prints the plan with no network call and no credentials needed.
    Use a real ~300 MB mp4/webm sample: complete sniffs the first 8 KiB, so random
    bytes are rejected.) The flow it performs, also doable by hand with curl:
      a. POST $STAGING_URL/v2/media/uploads with the session cookie and JSON
         {filename, contentType, size, sha256, partSha256: [one hex SHA-256 per
         16 MiB part]} -> require 201 {data: {id, mode, partSize, partCount,
         parts: [{partNumber, method: PUT, url, headers, size}]}}. A 501 means the
         Workers profile lacks the bucket-scoped R2 S3 credentials (R2_ACCOUNT_ID,
         R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME).
      b. PUT each parts[] target with EXACTLY its returned headers and that slice's
         bytes; require 2xx for every part; collect each response ETag. Presigned
         R2 URLs are credential-free (headers empty, send no cookie); mode:api
         targets take the session cookie plus the returned x-amz-checksum-sha256.
         In presigned mode the parts bypass the Worker.
      c. POST $STAGING_URL/v2/media/uploads/<id>/complete with the session cookie
         and JSON {parts: [{partNumber, etag}]} -> require 201. The helper then
         DELETEs /v2/media/<fileId> (require 204) so staging keeps no measurement
         object.
 4. Stop the tail. wrangler pretty-prints each event over many lines, so the file
    is concatenated JSON objects, not JSON Lines (line-based jq fails). Parse it
    with the balanced-brace reader (prints method, url, outcome, cpuTime, wallTime):
      node scripts/staging/parse-tail.mjs cpu-tail.json
 5. Record in the go/no-go sheet: route, size, cpuTime (ms), wallTime (ms), outcome.
    Pass: every upload invocation — POST /v2/media (90 MB raw), POST /v2/media/uploads
    (create) AND POST .../complete (300 MB multipart) — stays under the Free 10 ms
    budget with no error 1102. Any 1102 is a NO-GO on Free (see runbook).
EOF
}

if [ "$CPU_ONLY" = 1 ]; then cpu_procedure; exit 0; fi

need_env STAGING_URL
if [ "$LOCAL" = 1 ]; then guard url "$STAGING_URL" --local; else guard url "$STAGING_URL"; fi
BASE="${STAGING_URL%/}"
info "mode: $([ "$APPLY" = 1 ] && echo APPLY || echo DRY-RUN) target host checked"

# code <curl args>: print the HTTP status; a curl failure is the function's
# exit status, so callers must check it before comparing the code.
code() { curl -sS -o /dev/null -w '%{http_code}' "$@"; }

if [ "$APPLY" = 1 ]; then
  HC="$(code "$BASE/health")" || die "curl failed on GET /health (exit $?)"
  [ "$HC" = 200 ] || die "GET /health is not 200"
  HC="$(code "$BASE/dev/seed")" || die "curl failed on GET /dev/seed (exit $?)"
  [ "$HC" = 404 ] || die "GET /dev/seed is not 404"
  HC="$(code -I "$BASE/dev/seed")" || die "curl failed on HEAD /dev/seed (exit $?)"
  [ "$HC" = 404 ] || die "HEAD /dev/seed is not 404"
  info "health ok; dev routes absent (GET and HEAD)"
else
  echo "+ curl GET $BASE/health (expect 200)"
  echo "+ curl GET and HEAD $BASE/dev/seed (expect 404)"
fi

# UTC day of the last successful import commit in a walkthrough results.json:
# the step's server commit timestamp (serverAt) when present, else its client
# `at`. Prints nothing when the file is missing/unreadable or is not valid
# JSON (the caller falls back to the walkthrough start day). Prints NONE when
# it parses but has the wrong shape (steps not an array, non-object entries)
# or has no passing commit step: no marker is written. A shape error never
# falls into the fallback.
import_commit_day() {
  node -e '
    let text;
    try { text = require("fs").readFileSync(process.argv[1], "utf8"); }
    catch { process.exit(0); }
    let r;
    try { r = JSON.parse(text); } catch { process.exit(0); }
    try {
      if (r === null || typeof r !== "object" || !Array.isArray(r.steps) ||
          r.steps.some((s) => s === null || typeof s !== "object" || Array.isArray(s))) {
        console.log("NONE"); process.exit(0);
      }
      const commits = r.steps.filter((s) =>
        s.outcome === "pass" && s.method === "POST" &&
        typeof s.path === "string" &&
        /^\/v2\/imports\/[^/]+\/commit$/.test(s.path) &&
        (s.status === 200 || s.status === 201));
      const days = commits.map((s) => {
        for (const v of [s.serverAt, s.at]) {
          const t = typeof v === "string" ? Date.parse(v) : NaN;
          if (!Number.isNaN(t)) return new Date(t).toISOString().slice(0, 10);
        }
        return "";
      }).filter(Boolean);
      console.log(days.length ? days[days.length - 1] : "NONE");
    } catch { console.log("NONE"); }
  ' "$1"
}

# STAGING_MARKER_DIR overrides where the marker and walkthrough output live (tests).
MARK_DIR="${STAGING_MARKER_DIR:-$REPO_ROOT/walkthrough-out}"
# Absolute once, before any cd: a relative override means the caller's cwd.
case "$MARK_DIR" in /*) ;; *) MARK_DIR="$PWD/$MARK_DIR" ;; esac
MARK="$MARK_DIR/.staging-import-utc-day-$(printf '%s' "$BASE" | sha256sum | cut -c1-12)"; TODAY="$(date -u +%F)"
WT_MSG="walkthrough already ran today (UTC $TODAY): D1 allows one committed import per UTC day. Rerun after 00:00 UTC, or use --skip-walkthrough."
WT_SUMMARY=""
wt_summary() { [ -z "$WT_SUMMARY" ] || info "summary: walkthrough NOT run ($WT_SUMMARY)"; }
if [ "$SKIP_WT" = 1 ]; then
  info "walkthrough skipped (--skip-walkthrough)"
  WT_SUMMARY="--skip-walkthrough; not verified, not a pass"
elif [ "$APPLY" = 1 ] && [ -f "$MARK" ] && [ "$(cat "$MARK")" = "$TODAY" ]; then
  info "$WT_MSG"
  WT_SUMMARY="already ran today per this machine's marker (UTC $TODAY); this run verified nothing"
else
  # Credentials are needed only here: the walkthrough actually runs.
  if [ "$APPLY" = 1 ]; then need_env WT_SUPER_IDENTIFIER WT_SUPER_PASSWORD; fi
  WT_OUT="$MARK_DIR/staging-$(date -u +%Y%m%dT%H%M%SZ)"
  # Captured just before the run: the marker's fallback day (see below).
  WT_START_DAY="$(date -u +%F)"
  WT_RC=0
  (cd "$REPO_ROOT" && run npm run walkthrough -- --base-url "$BASE" --community "$COMMUNITY" --d1 \
    --super-credentials-env --allow-destructive --out "$WT_OUT") || WT_RC=$?
  if [ "$WT_RC" != 0 ]; then
    info "hint: if another run already committed an import today (UTC $TODAY), the import steps fail by design; read summary.md, and rerun after 00:00 UTC or with --skip-walkthrough"
    die "walkthrough failed (exit $WT_RC)"
  else
    # The marker records the UTC day the import COMMITTED, never the end time:
    # a walkthrough that crosses midnight must not move the marker to the new
    # day when the commit happened before midnight. Prefer the commit step's
    # timestamp (server's, else the client's) from results.json. A parsed
    # results.json with the wrong shape or no passing commit writes NO marker;
    # the start day is the fallback only when results.json is missing,
    # unreadable or not valid JSON.
    if [ "$APPLY" = 1 ]; then
      mkdir -p "$MARK_DIR"
      IMPORT_DAY="$(import_commit_day "$WT_OUT/results.json")"
      if [ "$IMPORT_DAY" = NONE ]; then
        info "no passing import commit in results.json: daily-import marker not written"
      else
        printf '%s\n' "${IMPORT_DAY:-$WT_START_DAY}" > "$MARK"
      fi
    fi
    info "go/no-go needs summary.md to show PASS with every interaction row covered (89/89)"
  fi
fi

if [ "$LOCAL" = 1 ]; then
  wt_summary
  info "--local: R2 part-checksum probe and CPU procedure skipped (no S3 endpoint or Free-plan CPU limit on local workerd)"
  info "summary: R2 part-checksum probe NOT done (--local); not verified, not a pass"
  exit 0
fi

if [ "$SKIP_R2_PROBE" = 1 ]; then
  info "R2 probe skipped: not verified (--skip-r2-probe)"
  PROBE_SUMMARY="NOT done (--skip-r2-probe); not verified, not a pass: keep the go/no-go probe item unchecked"
else
  if [ "$APPLY" = 1 ]; then
    need_env R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET_NAME
    guard name "$R2_BUCKET_NAME"
  fi
  PROBE_RC=0
  (cd "$REPO_ROOT" && run npx tsx scripts/staging/verify-r2-part-checksum.ts) || PROBE_RC=$?
  # exit 2 = not enforced (documented outcome, record it); anything else fails.
  if [ "$PROBE_RC" = 2 ]; then
    info "probe: R2 does NOT enforce part checksums (recorded, not a failure)"
    PROBE_SUMMARY="done: NOT enforced (exit 2, recorded)"
  elif [ "$PROBE_RC" != 0 ]; then
    die "probe inconclusive (exit $PROBE_RC)"
  elif [ "$APPLY" = 1 ]; then
    PROBE_SUMMARY="done: enforced (exit 0)"
  else
    PROBE_SUMMARY="NOT done (dry run: command printed only)"
  fi
fi
echo
wt_summary
info "summary: R2 part-checksum probe $PROBE_SUMMARY"
cpu_procedure
