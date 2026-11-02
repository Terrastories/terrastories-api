#!/usr/bin/env bash
#
# Regression test: the pinned TruffleHog version must detect a secret that
# was committed EARLY on a PR branch after advanced main was merged into
# that branch. TruffleHog 3.97.1 missed this case.
#
# Usage: scripts/secret-scan-merge-regression.sh <trufflehog-version>
# Example: scripts/secret-scan-merge-regression.sh 3.99.2

set -euo pipefail

usage() {
  echo "usage: $0 <trufflehog-version>   (e.g. 3.99.2)" >&2
}

if [[ $# -ne 1 ]]; then
  usage
  exit 1
fi

version=$1
if [[ ! $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  usage
  exit 1
fi

# --- Temporary workspace (removed on exit) ---------------------------------
tmp_root=${RUNNER_TEMP:-${TMPDIR:-/tmp}}
workdir=$(mktemp -d "${tmp_root%/}/secret-scan-regression.XXXXXX")
trap 'rm -rf "$workdir"' EXIT

repo=$workdir/repo
out=$workdir/trufflehog-output.jsonl

# --- Repository history ----------------------------------------------------
git init -q -b main "$repo"
git -C "$repo" config user.name "Regression Test"
git -C "$repo" config user.email "regression@example.invalid"

printf 'base\n' >"$repo/README.md"
git -C "$repo" add README.md
git -C "$repo" commit -q -m "base"

# Secret committed EARLY on the branch. Generated at runtime so this script
# never contains a literal secret and the repository's own secret scan does
# not flag it.
git -C "$repo" switch -q -c feature
key_id="AKIA$(LC_ALL=C tr -dc 'A-Z2-7' </dev/urandom | head -c 16 || true)"
secret="$(LC_ALL=C tr -dc 'A-Za-z0-9/+' </dev/urandom | head -c 40 || true)"
printf 'aws_access_key_id = %s\naws_secret_access_key = %s\n' \
  "$key_id" "$secret" >"$repo/leaked.txt"
git -C "$repo" add leaked.txt
git -C "$repo" commit -q -m "early branch commit"

# Unrelated follow-up commit on the branch.
printf 'branch follow-up\n' >"$repo/notes.txt"
git -C "$repo" add notes.txt
git -C "$repo" commit -q -m "branch follow-up"

# Advance main past the branch point, then record where main ended up.
git -C "$repo" switch -q main
for i in 1 2 3; do
  printf 'main change %d\n' "$i" >"$repo/main-change-$i.txt"
  git -C "$repo" add "main-change-$i.txt"
  git -C "$repo" commit -q -m "main change $i"
done
main_head=$(git -C "$repo" rev-parse HEAD)

# Merge advanced main into the branch.
git -C "$repo" switch -q feature
git -C "$repo" merge -q --no-ff main -m "Merge main into feature"
head=$(git -C "$repo" rev-parse HEAD)

echo "scanning ${main_head}..${head} with trufflehog ${version} (network disabled)"

# --- Scan -------------------------------------------------------------------
# Mirrors how trufflesecurity/trufflehog's GitHub Action scans a pull_request,
# but with networking disabled so verification cannot succeed and results come
# back "unknown". Capture stdout and the exit status without letting set -e
# abort the script.
status=0
docker run --rm --network none \
  -v "$repo:/tmp" -w /tmp \
  "ghcr.io/trufflesecurity/trufflehog:$version" \
  git file:///tmp/ \
  --since-commit "$main_head" \
  --branch "$head" \
  --fail --no-update --json --results=verified,unknown \
  >"$out" || status=$?

# --- Verdict ----------------------------------------------------------------
# Never print the output file or the generated credential values: the JSON
# contains the raw secret.
leaked_in_results=no
if grep -q "leaked.txt" "$out" 2>/dev/null; then
  leaked_in_results=yes
fi

if [[ $status -eq 183 && $leaked_in_results == yes ]]; then
  findings=$(grep -c "" "$out" || true)
  echo "PASS: trufflehog $version detected the early-branch secret after the main merge (exit status $status, $findings finding[s])"
  exit 0
fi

echo "FAIL: trufflehog $version did not detect the early-branch secret after the main merge (exit status $status, expected 183; leaked.txt in results: $leaked_in_results)" >&2
exit 1
