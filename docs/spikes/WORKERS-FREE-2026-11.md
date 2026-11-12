# Workers Free feasibility spike (November 2026)

Refs #194, #144, #184, #195. Measured on 2026-11-11 on a real Cloudflare account on the
Workers **Free** plan. The spike code is in `spikes/workers-free/`. It is not wired into the
application. Raw summaries are in `spikes/workers-free/results/`.

## Verdict

| Question                                                                  | Result                                                                        |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Server-side Rails bcrypt verification (cost 10, 11 or 12) on Workers Free | **FAIL**: killed with error 1102 after a short burst                          |
| Server-side Argon2id (WASM) at OWASP parameters on Workers Free           | **FAIL**: killed with error 1102 after a short burst                          |
| Server-side PBKDF2-SHA256 at OWASP 600,000 iterations                     | **UNVERIFIED**: rejection observed once, not retained                         |
| Server-side PBKDF2-SHA256 at 100,000 iterations                           | **FAIL**: 855 of 1,000 requests killed with error 1102                        |
| Client-stretching login (Fable 5.2 design, #184) on Workers Free          | **PASS**: login p99 CPU 4 ms, session check p99 1 ms, 0 kills in 1,000 logins |
| D1 Free import of a large community                                       | **PASS with limits**: one import uses about 30% of the daily write quota      |
| R2 media read and upload (authorization not exercised)                    | **PASS** up to 100 MB per request                                             |

## Method

- **Plan check.** A deploy with `limits.cpu_ms` set was rejected with
  `CPU limits are not supported for the Free plan` (code 100328). That confirms the account
  is on Workers Free.
- **CPU time.** Each scenario ran on its own freshly deployed Worker (`ts-spike-kdf-<id>`),
  so isolate state and CPU-limit enforcement from one scenario could not leak into another.
  A sequential client sent paced requests at 4 per second. CPU and wall time come from
  `wrangler tail --format json` (`cpuTime`, `wallTime`, `outcome`). Tail sampled about 30%
  of requests, so CPU quantiles use that sample (`n` in the tables). Kill counts come from
  every client response: error 1102 arrives as HTTP 503 with a Cloudflare HTML page, and
  the tail outcome is `exceededCpu`. `performance.now()` does not advance during Worker
  execution, so in-Worker timing is unusable.
- **Libraries.** bcrypt: `bcryptjs` 3.0.3 (pure JS). Argon2id: `@phi-ag/argon2` 0.6.2
  (WASM SIMD, imported as a Workers WASM module). PBKDF2 and SHA-256: native WebCrypto.
- **Rails fixtures.** Terrastories Rails uses `has_secure_password` with bcrypt-ruby
  3.1.20 (`rails/Gemfile.lock`, `rails/app/models/user.rb`), so there is no Devise pepper.
  bcrypt-ruby writes `$2a$` hashes. Its default cost has been 12 since 3.1.13 (May 2019),
  and was 10 before that ([bcrypt-ruby CHANGELOG](https://github.com/bcrypt-ruby/bcrypt-ruby/blob/master/CHANGELOG)),
  so real data holds cost 10 and cost 12 hashes. Cost 11 was measured as well.

## 1. Server-side KDF CPU (evidence only)

Each scenario sent 200 requests at 4 requests per second to its own fresh Worker.

| Scenario                           | Kill rate (1102) | Status timeline               | CPU p50 / p99 (ms, sampled; killed requests show 10) | Tail n |
| ---------------------------------- | ---------------- | ----------------------------- | ---------------------------------------------------- | ------ |
| noop                               | 0/200            | 200×200                       | 0 / 0                                                | 61     |
| SHA-256 token verify (1,000 req)   | 0/1,000          | 200×1000                      | 0 / 0 (max 1)                                        | 258    |
| PBKDF2-SHA256 10k                  | 0/200            | 200×200                       | 3 / 4                                                | 52     |
| PBKDF2-SHA256 50k                  | 0/200            | 200×200                       | 12 / 18                                              | 54     |
| PBKDF2-SHA256 100k                 | 0/200            | 200×200                       | 16 / 22                                              | 58     |
| PBKDF2-SHA256 100k (1,000 req)     | **855/1,000**    | 200×145 503×855               | 10 / 25                                              | 253    |
| PBKDF2-SHA256 210k                 | not run          | —                             | —                                                    | —      |
| PBKDF2-SHA256 600k                 | unverified ¹     | observed once, not retained ¹ | —                                                    | —      |
| bcrypt cost 10                     | **183/200**      | 200×17 503×183                | 10 / 149                                             | 57     |
| bcrypt cost 11                     | **176/200**      | 200×12 503×1 200×12 503×175   | 10 / 262                                             | 57     |
| bcrypt cost 12                     | **194/200**      | 200×6 503×194                 | 10 / 345                                             | 51     |
| Argon2id m=19456 t=2 p=1           | **170/200**      | 200×30 503×170                | 10 / 98                                              | 57     |
| Argon2id m=12288 t=3 p=1           | **133/200**      | 200×67 503×133                | 10 / 67                                              | 50     |
| Argon2id m=7168 t=5 p=1            | **111/200**      | 200×89 503×111                | 25 / 54                                              | 58     |
| bcrypt cost 10 in a Durable Object | not run          | —                             | —                                                    | —      |

Notes:

- **Burst tolerance.** Workers Free does not kill the first over-limit requests. Each fresh
  Worker served 6–89 heavy requests (50–345 ms CPU each), then killed nearly every later
  one at 10 ms. Killed requests show `cpuTime` 10 in tail. A trivial route on the same
  Worker still answered 10/10 after each kill streak, so the kills do not spread to other
  routes. The burst allowance is undocumented, and the design must not rely on it.
- **PBKDF2 above 100,000 iterations** (¹): rejection at 600k was observed once,
  not retained. The runtime ceiling remains unverified; see Open questions.
- **Argon2id instance reuse.** Reusing one WASM instance across parameter sets failed with
  `Memory allocation error`. The spike creates one instance per request.

**PBKDF2 is counted against the CPU limit, and it gets killed.** Native WebCrypto time
shows up in `cpuTime`: 3 ms at 10k, 12–18 ms at 50k, 16–25 ms at 100k. At 100k, 200
requests all passed, but a 1,000-request run passed 145 and then lost 855 to error 1102.
The 200-request runs at 10k and 50k had no kills. 50k (p99 18 ms) is over the 10 ms limit,
so its clean run probably sat inside the burst allowance (inferred). Only about 10k
(p99 4 ms) has headroom, and that is far below any OWASP PBKDF2 recommendation. The 210k
scenario did not run; neither a 210k rejection nor a SHA-512 ceiling was measured.
The unretained 600k observation does not establish either result.

## 2. Client-stretching login (Fable 5.2 auth design, #184)

The Worker implements only the server half of the design (`spikes/workers-free/src/auth.js`).
The client sends a stretched `derivedKey`. The server does one D1 read (account plus
throttle row), SHA-256 of the key, a constant-time compare, and one D1 write (session
insert on success, counter upsert on failure). The session check is one D1 read
(session joined to user) plus SHA-256 of the cookie token. The seed has 50 accounts.

The auth gate ran alongside the extra KDF scenarios on other Workers, so the numbers are
conservative. The tail sample has 314 login and 258 session events. Error 1102 counts come
from every response.

| Measurement (#184 "What #194 must measure")         | Threshold      | Measured                                                              | Result   |
| --------------------------------------------------- | -------------- | --------------------------------------------------------------------- | -------- |
| Login: D1 read + SHA-256 + compare + session insert | p99 CPU ≤ 5 ms | p50 1 ms, p95 3 ms, **p99 4 ms**, max 6 ms (wall p99 71 ms)           | **PASS** |
| Error 1102 over 1,000 logins                        | 0              | **0** (1,000/1,000 HTTP 200; tail outcome `ok` for all)               | **PASS** |
| Session check per authenticated request             | p99 ≤ 2 ms     | p50 0 ms, **p99 1 ms**, max 2 ms (1,000/1,000 HTTP 200)               | **PASS** |
| D1 writes per failed login (known account)          | ≤ 1            | **1** for all 200 (counter upsert)                                    | **PASS** |
| D1 writes per failed login (unknown identifier)     | ≤ 1            | **1** for all 20, same 401 status                                     | **PASS** |
| D1 writes per successful login                      | (not set)      | 1 (session insert); 2 when it also clears failures                    | info     |
| Backoff after 5 failures                            | (not set)      | `401/1 429/0 429/0 429/0 429/0 401/1 429/0 429/0`: 429 costs 0 writes | info     |
| Requests per login, including upgrade               | ≤ 2            | not measured (protocol-level; prelogin is a design choice)            | open     |

Login CPU covers successful and failed logins together (same route). Tables use
`WITHOUT ROWID` primary keys so a session insert writes one row. A secondary index on
`auth_sessions.user_id` (for "revoke all sessions") would add one written row per login.

## 3. D1 Free import

**Assumed representative community ("large").** No real Rails export was available to
this spike, so row counts are an assumption sized above what a single-community
Terrastories deployment typically holds. The profile has 1 community, 50 users,
300 speakers, 800 places, 2,000 stories (each with a description of about 1.5 KB),
3,000 place–story links, 2,500 speaker–story links, 2,500 media rows with
2,500 ActiveStorage blobs and attachments, 500 media links, and 1 theme. That is
16,652 rows in 12 tables shaped like `rails/db/schema.rb`, with 6 explicit secondary indexes plus 4 implicit UNIQUE indexes (`users.email`,
`users.username`, `communities.slug`, `active_storage_blobs.key`). Those indexes add about
13,700 index entries, which accounts for the measured 30,387 rows written (within 0.2%).
`scripts/make-dataset.mjs` generates it.

| Measurement                                                     | Value                                             |
| --------------------------------------------------------------- | ------------------------------------------------- |
| `wrangler d1 execute --remote --file` (335 INSERTs, 4.3 MB SQL) | 8.7 s wall, 604 ms SQL, 1 attempt                 |
| Rows written as counted by D1                                   | **30,387** for 16,652 logical rows (1.82×)        |
| Database size after import                                      | 5.36 MB of the 500 MB Free database limit         |
| In-Worker `batch()` of 1,000 statements × 33 rows               | 33,000 rows in one invocation, 657 ms client time |
| 34 rows × 3 parameters (102 bound parameters) in one statement  | `D1_ERROR: too many SQL variables`                |

Limits hit or close:

- **Daily writes.** D1 Free allows 100,000 rows written per day, and every index entry
  counts as a written row ([D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)).
  One large import used about 30% of that quota. A community above about 55,000 logical
  rows (with this index ratio) cannot import in one UTC day. The import tool must be
  resumable and idempotent across days, and imports compete with login writes for the
  same account-wide quota. The spike stopped writing at about 77,000 rows in one day so
  it would not block D1 writes for the whole account.
- **Per-statement limits.** 100 bound parameters and 100 KB per statement
  ([D1 limits](https://developers.cloudflare.com/d1/platform/limits/)). Multi-row INSERTs
  must chunk to stay within 100 parameters.
- **Per-invocation queries.** Free allows 50 queries per Worker invocation, but one
  `batch()` counts as one query (D1 limits), so a batch import inside a Worker works.

## 4. R2

R2 was already enabled on this account (other buckets exist), so no card question came
up. The spike created its own bucket.

| Measurement                                                           | Result                                      |
| --------------------------------------------------------------------- | ------------------------------------------- |
| Worker-generated object put + get (no auth), 512 KiB, n=1             | put 200, get 200                            |
| Same, 10 MiB and 50 MiB, n=1 each                                     | put 200, get 200; get streamed in 5–8 s     |
| Client upload streamed through the Worker, 10 / 50 / 99 MiB, n=1 each | HTTP 200 each (7 s, 29 s, 52 s client time) |
| Client upload, 101 MiB, n=1                                           | **HTTP 413 Payload Too Large**              |

The read route streams the object without an authorization check. Authorization cost is
the same D1 session read measured in section 2 (p99 1 ms), but the combined path was not
measured.

Limits: request bodies are capped at 100 MB on a free zone
([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)), so larger
media needs multipart or presigned direct-to-R2 upload. The R2 free tier is 10 GB-month of
storage, 1 million Class A and 10 million Class B operations per month
([R2 pricing](https://developers.cloudflare.com/r2/pricing/)). Video-heavy communities
will exceed 10 GB, which is a #184 cost-envelope input. Streaming bytes uses wall time,
not CPU, so media serving fits the CPU limit.

## 5. Client-device KDF

No real low-end phone was available, so the reference-device rows of #184 remain a
**manual procedure**. What was measured:

| Check                                                                                                                                                                                                      | Result                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Byte-exact Rails match: bcryptjs recomputes 12 real bcrypt-ruby 3.1.20 hashes (`$2a$`, cost 10 and 12; ASCII, Unicode, 72 bytes, 72+ bytes, 80-byte Unicode password (cutoff between code points), spaces) | **12/12 exact**, 72-byte truncation parity holds (`results/rails-bcrypt-check.json`)               |
| Page served over `http://192.168.68.106:8787` (LAN, not localhost), headless Chrome                                                                                                                        | `isSecureContext` false, `crypto.subtle` **unavailable**; both WASM Argon2id and bcryptjs **work** |
| Desktop (8 cores), no throttle, 5 runs                                                                                                                                                                     | Argon2id m=19456 t=2 p95 72 ms; bcrypt cost 12 p95 504 ms                                          |
| Same desktop, CDP CPU throttle 6× (rough low-end proxy)                                                                                                                                                    | Argon2id p95 403 ms; bcrypt cost 12 p95 2,891 ms                                                   |

The 6× throttle does not model a 2 GB phone's memory limits or thermal throttling. It is
a proxy only.

Manual procedure on the reference device (2 GB RAM Android, stock Chrome):

1. On a laptop on the same LAN, run `npm ci` and then
   `python3 -m http.server 8787 --bind <lan-ip>` in `spikes/workers-free`.
2. On the phone, open `http://<lan-ip>:8787/client/bench.html?runs=20` and press **Run**.
   Keep the screen on and the phone off the charger.
3. Record `argon2idP95Ms`, `bcrypt12P95Ms`, `errors`, `isSecureContext` and
   `cryptoSubtleAvailable` from the page in #144.
4. Pass: Argon2id p95 ≤ 3,000 ms with no out-of-memory error; bcrypt cost 12
   p95 ≤ 5,000 ms; both work over `http://`.

## Proposed SPEC §7 thresholds

Proposed wording for the §7 "benchmarked before release" clause. The SPEC change belongs
in the #195 / §7 PR, not here.

- **No server-side password KDF on Workers Free.** Any per-request CPU cost above 10 ms
  fails, even when a short run passes, because Free kills sustained overuse (PBKDF2 100k:
  145 passed, then 855 killed).
- **Workers gate:** sustained runs of at least 1,000 requests at 4 or more requests per
  second on a fresh Worker, which is longer than the observed burst allowance. Login p99
  CPU ≤ 5 ms, session check p99 ≤ 2 ms, zero error-1102 responses.
- **D1 budget:** at most 1 write per failed login and at most 2 per successful login.
  The import must be resumable across UTC days within the 100,000 rows-written daily quota.
- **Client KDF** (new passwords Argon2id m=19456 KiB, t=2, p=1; legacy Rails bcrypt
  recomputed in the client): p95 ≤ 3 s for Argon2id and ≤ 5 s for bcrypt cost 12 on the
  reference 2 GB Android device. Both must work over plain `http://` LAN, and bcrypt must
  match the Rails fixture set byte for byte (100%).
- **Media:** single request bodies ≤ 100 MB through the Worker; larger files need multipart
  or presigned upload.

## Resources created and deleted

All resources were created on 2026-11-11 and deleted on 2026-11-12. Nothing with the
`ts-spike-` prefix remains (checked with `wrangler d1 list`, `wrangler r2 bucket list`,
and a delete probe that returned code 10090).

- Workers (15 created, 15 deleted): `ts-spike-kdf`, `ts-spike-auth`, and
  `ts-spike-kdf-{noop,bc10,bc11,bc12,pb100k,a2m19t2,a2m12t3,a2m7t5,sha256,pb10k,pb50k,pb100kx1000,pb210k}`.
  `ts-spike-kdf-dobc10` was never deployed.
- D1: `ts-spike-d1` (deleted).
- R2: bucket `ts-spike-media` with 9 objects under `spike/` (objects deleted first, then
  the bucket).

## Open questions

- **Unverified PBKDF2 ceiling.** A 600k rejection was observed once, not retained:
  the exploratory run output was discarded because scenarios interfered. No committed
  results capture that rejection. The 210k scenario was not run, and any SHA-512
  rejection is an inference, not a measurement. A retained capture is needed to establish
  a ceiling; the measured 100k sustained-load failure stands independently.

- The spike Workers were public on `workers.dev` while the runs lasted. Anyone could call
  the write routes. All of them have been deleted. A rerun should add a shared-secret
  header before deploying.
- Design risk (inferred): anonymous failed logins each cost 1 D1 write, so a login flood
  can use up the account-wide 100,000 rows-written daily quota. That also blocks imports
  and new sessions. Successful logins insert session rows without bound until an expiry
  sweep runs. The #184 design needs a write-free throttle in front of D1, such as the
  Workers rate-limiting binding (Free availability unverified), and a session-expiry
  cleanup job.

- Inferred: the Free burst allowance (6–89 heavy requests per fresh Worker) is
  undocumented and may change. Only the 10 ms limit is documented.
- Not measured: the CPU cap in a Durable Object or a Queue consumer. The Durable Object probe is in the code but was not run.
- Not measured: a real reference low-end Android phone (2 GB RAM). See section 5.
- Not measured: a real Rails production export. Row counts are the stated assumption.
