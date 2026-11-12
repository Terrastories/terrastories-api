# Workers Free spike (#194)

Throwaway measurement code. It is not part of the application, not built by the root
package, and not deployed by CI. Results and method: `docs/spikes/WORKERS-FREE-2026-11.md`.

Every Cloudflare resource is prefixed `ts-spike-`. Delete them after a run.

```bash
cd spikes/workers-free
npm ci
export CLOUDFLARE_ACCOUNT_ID=<free-plan account>
npm run fixtures                                   # src/fixtures.js (bcrypt $2a$ 10/11/12)
npx wrangler d1 create ts-spike-d1                 # put the id in wrangler.jsonc
npx wrangler r2 bucket create ts-spike-media

# 1. Server-side KDF CPU: one fresh Worker per scenario; raw tail stays in <raw-dir>.
export SUBDOMAIN=<your workers.dev subdomain>
scripts/run-kdf.sh <raw-dir> 200 4
SET=extra scripts/run-kdf.sh <raw-dir> 200 4       # SHA-256, PBKDF2 10k-210k, Durable Object

# 2. Client-stretching login gate (#184 design).
node scripts/make-auth-seed.mjs <tmp>/auth-seed.sql
npx wrangler d1 execute ts-spike-d1 --remote --yes --file <tmp>/auth-seed.sql
npx wrangler deploy --name ts-spike-auth
npx wrangler tail ts-spike-auth --format json > <raw-dir>/tail-auth.jsonl &   # stop it after the load
node scripts/load-auth.mjs https://ts-spike-auth.<subdomain>.workers.dev 1000 200 4 > results/auth-load.json
node scripts/summarize-tail.mjs <raw-dir>/tail-auth.jsonl > results/auth-cpu.json

# 3. D1 import (counts against the 100,000 rows-written daily quota).
node scripts/make-dataset.mjs large <tmp>/large.sql
npx wrangler d1 execute ts-spike-d1 --remote --yes --file <tmp>/large.sql

# 4. R2 and in-Worker D1 batch probes (SKIP_D1=1 skips the D1 writes).
npx wrangler deploy
node scripts/probe-d1-r2.mjs https://ts-spike-kdf.<subdomain>.workers.dev

# 5. Rails bcrypt byte-exact check (Docker) and the client-device bench.
docker run --rm -v "$PWD:/w" -w /w ruby:3.3-slim sh -c 'apt-get update -qq &&
  apt-get install -y -qq build-essential && gem install bcrypt -v 3.1.20 &&
  ruby scripts/rails-bcrypt-fixtures.rb' > results/rails-bcrypt-fixtures.json
node scripts/check-rails-fixtures.mjs > results/rails-bcrypt-check.json
python3 -m http.server 8787 --bind <lan-ip>        # open http://<lan-ip>:8787/client/bench.html
```

Raw `wrangler tail` output contains request headers and client IP addresses. Never commit
it; commit only `summarize-tail.mjs` output.
