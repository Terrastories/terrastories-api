# Shared helpers for scripts/staging/*.sh. Source, do not execute.
# shellcheck shell=bash

STAGING_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$STAGING_DIR/../.." && pwd)"
APPLY=0

die() { echo "ERROR: $*" >&2; exit 1; }
info() { echo "-- $*"; }

# guard <subcommand> <args...>: run the TypeScript guard, die with its message.
guard() {
  (cd "$REPO_ROOT" && npx --no-install tsx scripts/staging/guards.ts "$@") \
    || die "guard '$1' refused"
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

# Free-tier / account precheck shared by every script that touches Cloudflare.
check_account() {
  need_env CLOUDFLARE_ACCOUNT_ID
  local who
  who="$(cd "$REPO_ROOT" && npx wrangler whoami 2>&1)" || die "wrangler whoami failed"
  printf '%s' "$who" | guard account "$CLOUDFLARE_ACCOUNT_ID"
  info "account check passed (id not printed)"
}
