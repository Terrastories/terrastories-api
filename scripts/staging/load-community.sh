#!/usr/bin/env bash
# Load a Stage-2 transform output into STAGING D1 + R2. Dry run by default.
#
#   scripts/staging/load-community.sh --transform-output DIR [--sql-out DIR]
#       [--apply] [--wipe-and-retry] [--allow-over-budget] [--skip-r2]
#       [--r2-via-wrangler]
#
# Flow (each step resumable; rerun the same command after a failure):
#   1. migrate:rails:load --target d1 --dry-run   (row budget check)
#   2. [apply] migrate:rails:load --target d1 --sql-out DIR (new dir; reused on rerun)
#   3. [apply] wrangler d1 export (backup) + time-travel info (bookmark)
#   4. [apply] wrangler d1 migrations apply --remote
#   5. [apply] execute SQL files in d1-import.json order, skipping files already
#      in the _rails_migration_load ledger
#   6. [apply] migrate:rails:load --target r2 (dry run, then real); or, with
#      --r2-via-wrangler (no R2_* S3 credentials), 'wrangler r2 object put
#      --remote --content-type' per r2-upload-manifest.json entry, each object
#      verified afterwards by 'wrangler r2 object get' (size and sha256). Reruns
#      skip objects already present and matching. An object is uploaded ONLY
#      when wrangler confirms the key is absent ("The specified key does not
#      exist."); any other read error, or an existing object whose size/sha256
#      does not match the manifest, aborts the load without overwriting. If
#      any object is over 300 MiB (wrangler limit) the whole path is refused
#      up front: the S3 loader needs x-amz-meta-sha256 on existing objects,
#      which wrangler cannot set, so do not mix the two paths in one bucket.
#   7. [apply] verify.sql
# Prints counts and step status only. Wrangler output goes to a mode-600 log
# under the --sql-out directory, never to the terminal.
# A file that fails midway is NOT retried automatically. After reading the log,
# rerun with --wipe-and-retry to run wipe-and-retry.sql (staging only) first.
# Resume safety: the SQL dump directory records the SHA-256 of the transform
# output's manifest.json (.transform-manifest.sha256); a directory made from a
# different transform output is refused, never reused.
# Env: CLOUDFLARE_ACCOUNT_ID (resource names are fixed); for r2 (S3 path):
#   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY (environment only).
#   A CLOUDFLARE_API_TOKEN exported for another account breaks wrangler: run
#   with 'env -u CLOUDFLARE_API_TOKEN' (the account guard checks whoami).
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

TRANSFORM="" SQL_OUT="" WIPE=0 OVER="" SKIP_R2=0 R2_WRANGLER=0
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --transform-output) TRANSFORM="${2:?}"; shift ;;
    --sql-out) SQL_OUT="${2:?}"; shift ;;
    --wipe-and-retry) WIPE=1 ;;
    --allow-over-budget) OVER="--allow-over-budget" ;;
    --skip-r2) SKIP_R2=1 ;;
    --r2-via-wrangler) R2_WRANGLER=1 ;;
    # Print the whole comment header (line 2 up to the first non-comment line),
    # so growing the header never truncates --help.
    -h|--help) awk 'NR>1 {if (!/^#/) exit; print}' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done
[ -n "$TRANSFORM" ] && [ -d "$TRANSFORM" ] || die "--transform-output DIR is required and must exist"
TRANSFORM="$(cd "$TRANSFORM" && pwd)"
SQL_OUT="${SQL_OUT:-$TRANSFORM.d1-sql}"

# Names are fixed and match wrangler.jsonc env.staging (see provision.sh).
D1_NAME="terrastories-staging-db"
BUCKET="terrastories-staging-media"
guard name "$D1_NAME" "$BUCKET"
guard config "$REPO_ROOT/wrangler.jsonc"
check_account
info "mode: $([ "$APPLY" = 1 ] && echo APPLY || echo DRY-RUN)"
cd "$REPO_ROOT"

load() { npm run --silent migrate:rails:load -- --transform-output "$TRANSFORM" "$@"; }

info "step 1: D1 budget dry run"
load --target d1 --dry-run ${OVER:+"$OVER"}
# wrangler-based R2 upload: get first, put only a confirmed-absent key, then
# verify size and sha256. Any other outcome aborts without overwriting.
r2_via_wrangler() {
  local manifest="$SQL_OUT/r2-upload-manifest.json" listing key size ct src tmp got log_start n=0 up=0 present=0 total
  [ -f "$manifest" ] || die "$manifest missing: run the D1 dump step first"
  # \x1f (unit separator) is not IFS whitespace, so empty fields (e.g. an empty
  # contentType) keep their position instead of collapsing into the next field.
  listing="$(node -e 'for (const o of JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).objects) console.log([o.key,o.size,o.contentType,o.sha256].join("\x1f"))' "$manifest")"
  total="$(printf '%s\n' "$listing" | grep -c . || true)"
  # Wrangler cannot set the x-amz-meta-sha256 the S3 loader requires on existing
  # objects, so the two paths must not be mixed: refuse before uploading anything.
  node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.exit(m.objects.some(o=>o.size>314572800)?1:0)' "$manifest" \
    || die "an object is over 300 MiB: --r2-via-wrangler cannot upload it, and objects it uploads lack the checksum metadata the S3 loader needs; use the S3 path for the whole load"
  tmp="$(mktemp)"; chmod 600 "$tmp"
  while IFS=$'\x1f' read -r key size ct sha; do
    [ -n "$key" ] || continue
    n=$((n+1))
    src="$TRANSFORM/v2-media/$key"
    [ -f "$src" ] || { rm -f "$tmp"; die "r2 object $n/$total: source file missing"; }
    # Read before writing: an existing object may carry S3 checksum metadata
    # this path cannot reproduce, so it must never be overwritten blindly.
    log_start="$(stat -c %s "$LOG")"
    if wr r2 object get "$BUCKET/$key" --remote --file "$tmp"; then
      got="$(stat -c %s "$tmp")"
      if [ "$got" = "$size" ] && [ "$(sha256sum "$tmp" | cut -d' ' -f1)" = "$sha" ]; then
        present=$((present+1)); continue
      fi
      rm -f "$tmp"
      die "r2 object $n/$total already exists but does not match the manifest (expected size $size, got $got, or sha256 differs): refusing to overwrite; see $LOG"
    fi
    # Upload ONLY on a confirmed not-found. wrangler answers a missing key with
    # the exact UserError "The specified key does not exist." (404 from the R2
    # API); permission, network and other API errors print different messages.
    # If that distinction is ever unavailable, fail closed: never PUT over an
    # object whose absence was not confirmed.
    if ! tail -c +"$((log_start + 1))" "$LOG" | grep -qF 'The specified key does not exist.'; then
      rm -f "$tmp"
      die "r2 get $n/$total failed without confirming the key is absent: refusing to upload (an existing object could be overwritten); read $LOG, fix the cause, rerun"
    fi
    wr r2 object put "$BUCKET/$key" --remote --file "$src" --content-type "$ct" || { rm -f "$tmp"; die "r2 put $n/$total failed; see $LOG"; }
    : > "$tmp"
    wr r2 object get "$BUCKET/$key" --remote --file "$tmp" || { rm -f "$tmp"; die "r2 verify get $n/$total failed; see $LOG"; }
    got="$(stat -c %s "$tmp")"
    [ "$got" = "$size" ] || { rm -f "$tmp"; die "r2 verify $n/$total: size mismatch (expected $size, got $got)"; }
    [ "$(sha256sum "$tmp" | cut -d' ' -f1)" = "$sha" ] || { rm -f "$tmp"; die "r2 verify $n/$total: sha256 mismatch"; }
    up=$((up+1))
  done <<< "$listing"
  rm -f "$tmp"
  info "r2 via wrangler: objects=$total uploaded=$up already_present=$present (all size-verified)"
}

if [ "$APPLY" != 1 ]; then
  info "dry run only. Planned: d1 sql dump -> backup+bookmark -> migrations -> SQL files -> r2 upload -> verify.sql"
  [ "$SKIP_R2" = 1 ] || { info "r2 dry run"; if [ "$R2_WRANGLER" = 1 ]; then info "--r2-via-wrangler: objects are put and size-verified with wrangler at apply time"; elif [ -n "${R2_ACCESS_KEY_ID:-}" ]; then load --target r2 --bucket "$BUCKET" --dry-run; else info "R2_* not set: skipping r2 dry run"; fi; }
  exit 0
fi

[ -f "$TRANSFORM/manifest.json" ] || die "$TRANSFORM/manifest.json missing: not a Stage-2 output"
MANIFEST_SHA="$(sha256sum "$TRANSFORM/manifest.json" | cut -d' ' -f1)"
STAMP_FILE="$SQL_OUT/.transform-manifest.sha256"
if [ -e "$SQL_OUT" ]; then
  [ -f "$STAMP_FILE" ] || die "$SQL_OUT exists without a transform stamp: refusing to reuse it; pass a new --sql-out"
  [ "$(cat "$STAMP_FILE")" = "$MANIFEST_SHA" ] || die "$SQL_OUT was built from a different transform output: refusing to resume; pass a new --sql-out"
  [ -f "$SQL_OUT/d1-import.json" ] || die "$SQL_OUT is incomplete (no d1-import.json): pass a new --sql-out"
  info "step 2: reusing existing SQL dump (resume; manifest sha matches)"
else
  info "step 2: writing D1 SQL dump"
  load --target d1 --sql-out "$SQL_OUT" ${OVER:+"$OVER"}
  printf '%s' "$MANIFEST_SHA" > "$STAMP_FILE"
fi
LOG="$SQL_OUT/wrangler.log"; : >> "$LOG"; chmod 600 "$LOG"
wr() { npx wrangler "$@" >>"$LOG" 2>&1; }

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
if [ ! -f "$SQL_OUT/.backup-done" ]; then
  info "step 3: pre-load backup and Time Travel bookmark (see log)"
  wr d1 export "$D1_NAME" --remote --env staging --output "$SQL_OUT/d1-backup-$STAMP.sql" || die "d1 export failed; see $LOG"
  chmod 600 "$SQL_OUT"/d1-backup-*.sql
  wr d1 time-travel info "$D1_NAME" --env staging || die "time-travel info failed; see $LOG"
  : > "$SQL_OUT/.backup-done"
fi

info "step 4: apply V2 migrations to remote D1"
wr d1 migrations apply "$D1_NAME" --remote --env staging || die "migrations failed; see $LOG"

if [ "$WIPE" = 1 ]; then
  info "wipe-and-retry requested: running wipe-and-retry.sql on STAGING"
  wr d1 execute "$D1_NAME" --remote --env staging --yes --file "$SQL_OUT/wipe-and-retry.sql" || die "wipe failed; see $LOG"
fi

applied_files() {
  npx wrangler d1 execute "$D1_NAME" --remote --env staging --json \
    --command "SELECT file FROM _rails_migration_load ORDER BY file" 2>>"$LOG" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const r=JSON.parse(s);for(const x of r[0].results)console.log(x.file)}catch{}})'
}
DONE_LIST="$(applied_files || true)"
mapfile -t FILES < <(node -e 'for (const f of JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).files) console.log(f)' "$SQL_OUT/d1-import.json")
total="${#FILES[@]}"; n=0; skipped=0
info "step 5: $total SQL files"
for f in "${FILES[@]}"; do
  n=$((n+1))
  if printf '%s\n' "$DONE_LIST" | grep -qxF "$f"; then skipped=$((skipped+1)); continue; fi
  if wr d1 execute "$D1_NAME" --remote --env staging --yes --file "$SQL_OUT/$f"; then
    echo "applied $n/$total"
  else
    die "file $n/$total failed (see $LOG). It may be partially applied: do not rerun it; rerun this script with --wipe-and-retry"
  fi
done
info "step 5 done: files=$total already_applied=$skipped"

if [ "$SKIP_R2" = 1 ]; then
  info "step 6 skipped (--skip-r2)"
elif [ "$R2_WRANGLER" = 1 ]; then
  info "step 6: R2 upload via wrangler (reruns skip size-verified objects)"
  r2_via_wrangler
else
  if [ -z "${R2_ACCESS_KEY_ID:-}" ] || [ -z "${R2_SECRET_ACCESS_KEY:-}" ] || [ -z "${R2_ACCOUNT_ID:-}" ]; then
    die "R2_* S3 credentials are not set: export them, or rerun with --r2-via-wrangler"
  fi
  info "step 6: R2 upload (reruns skip verified objects)"
  load --target r2 --bucket "$BUCKET" --dry-run
  load --target r2 --bucket "$BUCKET"
fi

info "step 7: verify.sql (fails on any count, sequence or ledger mismatch)"
wr d1 execute "$D1_NAME" --remote --env staging --yes --file "$SQL_OUT/verify.sql" || die "verify.sql FAILED; see $LOG"
info "load complete and verified"
