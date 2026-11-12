// Sends N paced sequential requests to one scenario and records the HTTP status timeline.
// CPU time comes from `wrangler tail --format json` (see summarize-tail.mjs), not from here:
// performance.now() does not advance during Worker execution.
// Usage: node scripts/load.mjs <base-url> <scenario-path> [n=200] [rps=4]
const [base, scenario, nArg = '200', rpsArg = '4'] = process.argv.slice(2);
if (!base || !scenario)
  throw new Error('usage: load.mjs <base-url> <scenario> [n] [rps]');
const n = Number(nArg);
const gap = 1000 / Number(rpsArg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function hit(path) {
  const t0 = performance.now();
  const res = await fetch(`${base}/${path}`);
  const body = (await res.text()).slice(0, 120);
  return { status: res.status, ms: performance.now() - t0, body };
}

const statuses = [];
const wall = [];
const bodies = {};
for (let i = 0; i < n; i++) {
  const started = Date.now();
  const r = await hit(scenario);
  statuses.push(r.status);
  wall.push(r.ms);
  bodies[r.status] ??=
    r.status >= 500 && r.body.startsWith('<!DOCTYPE')
      ? 'Cloudflare HTML error page'
      : r.body;
  await sleep(Math.max(0, gap - (Date.now() - started)));
}
// Collateral check: does a trivial route on the same Worker still work afterwards?
const after = [];
for (let i = 0; i < 10; i++) after.push((await hit('noop')).status);

// Run-length encode the status timeline, e.g. "200x61 503x139".
const timeline = [];
for (const s of statuses) {
  const last = timeline.at(-1);
  if (last && last[0] === s) last[1]++;
  else timeline.push([s, 1]);
}
wall.sort((a, b) => a - b);
const q = (p) =>
  Math.round(wall[Math.min(wall.length - 1, Math.floor(p * wall.length))]);
const counts = {};
for (const s of statuses) counts[s] = (counts[s] ?? 0) + 1;
console.log(
  JSON.stringify({
    scenario,
    n,
    rps: Number(rpsArg),
    counts,
    timeline: timeline.map(([s, c]) => `${s}x${c}`).join(' '),
    noopAfter: after.join(','),
    clientWallMs: { p50: q(0.5), p99: q(0.99) },
    bodies,
  })
);
