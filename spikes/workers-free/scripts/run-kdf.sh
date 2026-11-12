#!/usr/bin/env bash
# Runs each KDF scenario against its own freshly deployed Worker (ts-spike-kdf-<id>) so
# isolate state and any CPU-limit enforcement from one scenario cannot affect another.
# Usage: CLOUDFLARE_ACCOUNT_ID=... scripts/run-kdf.sh <raw-dir> [n] [rps]
# Raw tail files (they contain request headers and client IPs) stay in <raw-dir>;
# only the summaries are written to results/.
set -euo pipefail
cd "$(dirname "$0")/.."
RAW=${1:?raw dir}
N=${2:-200}
RPS=${3:-4}
SUBDOMAIN=${SUBDOMAIN:?set SUBDOMAIN to your <name>.workers.dev account subdomain}
mkdir -p "$RAW" results

# Entries are id|path[|n]. SET=extra runs the second batch requested on 2026-11-11.
SCENARIOS=(
  "noop|noop"
  "bc10|bcrypt?cost=10"
  "bc11|bcrypt?cost=11"
  "bc12|bcrypt?cost=12"
  "pb100k|pbkdf2?iter=100000"
  "a2m19t2|argon2id?m=19456&t=2&p=1"
  "a2m12t3|argon2id?m=12288&t=3&p=1"
  "a2m7t5|argon2id?m=7168&t=5&p=1"
)
if [ "${SET:-base}" = extra ]; then
  SCENARIOS=(
    "sha256|sha256|1000"
    "pb10k|pbkdf2?iter=10000"
    "pb50k|pbkdf2?iter=50000"
    "pb100kx1000|pbkdf2?iter=100000|1000"
    "pb210k|pbkdf2?iter=210000"
    "dobc10|do/bcrypt?cost=10"
  )
fi

for entry in "${SCENARIOS[@]}"; do
  IFS='|' read -r id path n <<< "$entry"
  n=${n:-$N}
  name="ts-spike-kdf-$id"
  base="https://$name.$SUBDOMAIN.workers.dev"
  npx wrangler deploy --name "$name" > "$RAW/deploy-$id.log" 2>&1
  # A new workers.dev hostname answers 404/1042 until it propagates.
  ready=
  for _ in $(seq 1 30); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' "$base/noop")" = 200 ] && ready=1 && break
    sleep 3
  done
  [ -n "$ready" ] || { echo "$base never answered 200" >&2; exit 1; }
  npx wrangler tail "$name" --format json > "$RAW/tail-$id.jsonl" 2> "$RAW/tail-$id.err" &
  tail_pid=$!
  sleep 10
  kill -0 "$tail_pid" 2> /dev/null || { echo "wrangler tail exited for $name" >&2; exit 1; }
  node scripts/load.mjs "$base" "$path" "$n" "$RPS" | tee -a results/kdf-load.jsonl
  sleep 10
  pkill -f "[w]rangler tail $name " || true
  node scripts/summarize-tail.mjs "$RAW/tail-$id.jsonl" > "results/kdf-cpu-$id.json"
done
