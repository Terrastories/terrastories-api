#!/usr/bin/env bash
# Load a Stage-2 transform output into STAGING D1 + R2. Dry run by default.
#
#   scripts/staging/load-community.sh --transform-output DIR [--sql-out DIR]
#       [--apply] [--wipe-and-retry] [--allow-over-budget] [--skip-r2]
#
# Flow (each step resumable; rerun the same command after a failure):
#   1. migrate:rails:load --target d1 --dry-run   (row budget check)
#   2. [apply] migrate:rails:load --target d1 --sql-out DIR (new dir; reused on rerun)
#   3. [apply] wrangler d1 export (backup) + time-travel info (bookmark)
#   4. [apply] wrangler d1 migrations apply --remote
#   5. [apply] execute SQL files in d1-import.json order, skipping files already
#      in the _rails_migration_load ledger
#   6. [apply] migrate:rails:load --target r2 (dry run, then real)
#   7. [apply] verify.sql
# Prints counts and step status only. Wrangler output goes to a mode-600 log
# under the --sql-out directory, never to the terminal.
# A file that fails midway is NOT retried automatically. After reading the log,
# rerun with --wipe-and-retry to run wipe-and-retry.sql (staging only) first.
# Env: CLOUDFLARE_ACCOUNT_ID, STAGING_D1_NAME, STAGING_R2_BUCKET; for r2:
#   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY (environment only).
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

TRANSFORM="" SQL_OUT="" WIPE=0 OVER="" SKIP_R2=0
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --transform-output) TRANSFORM="${2:?}"; shift ;;
    --sql-out) SQL_OUT="${2:?}"; shift ;;
    --wipe-and-retry) WIPE=1 ;;
    --allow-over-budget) OVER="--allow-over-budget" ;;
    --skip-r2) SKIP_R2=1 ;;
    -h|--help) sed -n '2,22p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done
[ -n "$TRANSFORM" ] && [ -d "$TRANSFORM" ] || die "--transform-output DIR is required and must exist"
TRANSFORM="$(cd "$TRANSFORM" && pwd)"
SQL_OUT="${SQL_OUT:-$TRANSFORM.d1-sql}"

D1_NAME="${STAGING_D1_NAME:-terrastories-staging-db}"
BUCKET="${STAGING_R2_BUCKET:-terrastories-staging-media}"
guard name "$D1_NAME" "$BUCKET"
check_account
info "mode: $([ "$APPLY" = 1 ] && echo APPLY || echo DRY-RUN)"
cd "$REPO_ROOT"

load() { npm run --silent migrate:rails:load -- --transform-output "$TRANSFORM" "$@"; }

info "step 1: D1 budget dry run"
load --target d1 --dry-run ${OVER:+"$OVER"}
if [ "$APPLY" != 1 ]; then
  info "dry run only. Planned: d1 sql dump -> backup+bookmark -> migrations -> SQL files -> r2 upload -> verify.sql"
  [ "$SKIP_R2" = 1 ] || { info "r2 dry run"; if [ -n "${R2_ACCESS_KEY_ID:-}" ]; then load --target r2 --bucket "$BUCKET" --dry-run; else info "R2_* not set: skipping r2 dry run"; fi; }
  exit 0
fi

if [ -d "$SQL_OUT" ] && [ -f "$SQL_OUT/d1-import.json" ]; then
  info "step 2: reusing existing SQL dump (resume)"
else
  info "step 2: writing D1 SQL dump"
  load --target d1 --sql-out "$SQL_OUT" ${OVER:+"$OVER"}
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
else
  need_env R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY
  info "step 6: R2 upload (reruns skip verified objects)"
  load --target r2 --bucket "$BUCKET" --dry-run
  load --target r2 --bucket "$BUCKET"
fi

info "step 7: verify.sql (fails on any count, sequence or ledger mismatch)"
wr d1 execute "$D1_NAME" --remote --env staging --yes --file "$SQL_OUT/verify.sql" || die "verify.sql FAILED; see $LOG"
info "load complete and verified"
