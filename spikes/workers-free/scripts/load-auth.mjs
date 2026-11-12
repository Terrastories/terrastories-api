// Drives the auth scenarios against a deployed spike Worker, paced sequentially:
//   1. LOGINS successful logins rotating over the seeded users;
//   2. one session check per issued token;
//   3. FAILED wrong-key logins spread so no account reaches the backoff threshold;
//   4. a backoff probe: 8 wrong keys on one account (5 counted, then 429 with 0 writes).
// Error 1102 surfaces to the client as HTTP 503 with a Cloudflare HTML page.
// Usage: node scripts/load-auth.mjs <base-url> [logins=1000] [failed=200] [rps=4]
import {
  COMMUNITY_ID,
  USERS,
  b64url,
  derivedKey,
  identifier,
} from './auth-keys.mjs';

const [base, loginsArg = '1000', failedArg = '200', rpsArg = '4'] =
  process.argv.slice(2);
if (!base)
  throw new Error('usage: load-auth.mjs <base-url> [logins] [failed] [rps]');
const gap = 1000 / Number(rpsArg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function paced(fn) {
  const t0 = Date.now();
  const r = await fn();
  await sleep(Math.max(0, gap - (Date.now() - t0)));
  return r;
}

const login = (i, key) =>
  fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-spike-scenario': 'login',
    },
    body: JSON.stringify({
      communityId: COMMUNITY_ID,
      identifier: identifier(i),
      derivedKey: b64url(key),
    }),
  });

function tally(name, results) {
  const counts = {};
  const writes = {};
  for (const r of results) {
    counts[r.status] = (counts[r.status] ?? 0) + 1;
    writes[r.rowsWritten] = (writes[r.rowsWritten] ?? 0) + 1;
  }
  const summary = {
    scenario: name,
    n: results.length,
    counts,
    rowsWrittenHistogram: writes,
  };
  console.error(JSON.stringify(summary));
  return summary;
}

async function call(fn) {
  const res = await fn();
  await res.text();
  return {
    status: res.status,
    rowsWritten: res.headers.get('x-spike-rows-written'),
    cookie: res.headers.get('set-cookie'),
  };
}

const out = [];
const tokens = [];
const logins = [];
for (let n = 0; n < Number(loginsArg); n++) {
  const i = (n % USERS) + 1;
  const r = await paced(() => call(() => login(i, derivedKey(i))));
  logins.push(r);
  const tok = /ts_session=([^;]+)/.exec(r.cookie ?? '')?.[1];
  if (tok) tokens.push(tok);
}
out.push(tally('login-success', logins));

const checks = [];
for (const tok of tokens) {
  checks.push(
    await paced(() =>
      call(() =>
        fetch(`${base}/auth/session`, {
          headers: {
            cookie: `ts_session=${tok}`,
            'x-spike-scenario': 'session',
          },
        })
      )
    )
  );
}
out.push(tally('session-check', checks));

const failed = [];
for (let n = 0; n < Number(failedArg); n++) {
  const i = (n % USERS) + 1;
  failed.push(await paced(() => call(() => login(i, Buffer.alloc(32, 7)))));
}
out.push(tally('login-failed', failed));

// Unknown identifier: must also cost exactly one write and return the same status.
const unknown = [];
for (let n = 0; n < 20; n++) {
  unknown.push(
    await paced(() =>
      call(() =>
        fetch(`${base}/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            communityId: COMMUNITY_ID,
            identifier: `nobody${n}`,
            derivedKey: b64url(Buffer.alloc(32, 1)),
          }),
        })
      )
    )
  );
}
out.push(tally('login-unknown-identifier', unknown));

// Backoff: user 1 already has failures from step 3; push it past the threshold.
const backoff = [];
for (let n = 0; n < 8; n++)
  backoff.push(await paced(() => call(() => login(1, Buffer.alloc(32, 9)))));
out.push({
  ...tally('login-backoff', backoff),
  sequence: backoff.map((r) => `${r.status}/${r.rowsWritten}`).join(' '),
});

console.log(JSON.stringify(out, null, 2));
