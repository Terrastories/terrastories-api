# Shared helpers for scripts/staging/*.sh. Source, do not execute.
# shellcheck shell=bash

STAGING_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$STAGING_DIR/../.." && pwd)"
APPLY=0

die() { echo "ERROR: $*" >&2; exit 1; }
info() { echo "-- $*"; }

# guard_ok <subcommand> <args...>: run the TypeScript guard and return its
# verdict (0 ok, non-zero refused) instead of dying, so a script can branch on
# it — the idempotent "already there?" checks in provision.sh.
guard_ok() {
  (cd "$REPO_ROOT" && npx --no-install tsx scripts/staging/guards.ts "$@")
}

# guard <subcommand> <args...>: run the TypeScript guard, die with its message.
guard() {
  guard_ok "$@" || die "guard '$1' refused"
}

# has_name <name>: stdin is a wrangler list; exact-name match (exit 0 = present).
has_name() {
  (cd "$REPO_ROOT" && npx --no-install tsx scripts/staging/guards.ts has-name "$1")
}

# run <cmd...>: print the command; execute only with --apply.
run() {
  echo "+ $*"
  if [ "$APPLY" = 1 ]; then "$@"; fi
}

need_env() {
  local n
  for n in "$@"; do
    [ -n "${!n:-}" ] || die "environment variable $n is required"
  done
}

# Resolve WORKERS_PLAN (free|paid, default free; anything else dies).
WORKERS_PLAN_RESOLVED="free"
resolve_workers_plan() {
  local raw="${WORKERS_PLAN:-free}"
  case "$raw" in
    free|paid) WORKERS_PLAN_RESOLVED="$raw" ;;
    *) die "WORKERS_PLAN must be 'free' or 'paid' (got: '$raw')" ;;
  esac
}

# Free-tier / account precheck shared by every script that touches Cloudflare.
check_account() {
  need_env CLOUDFLARE_ACCOUNT_ID
  local who
  who="$(cd "$REPO_ROOT" && npx wrangler whoami 2>&1)" || die "wrangler whoami failed"
  printf '%s' "$who" | guard account "$CLOUDFLARE_ACCOUNT_ID"
  info "account check passed (id not printed)"
}
