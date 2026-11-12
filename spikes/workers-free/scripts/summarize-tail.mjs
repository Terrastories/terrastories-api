// Reduces raw `wrangler tail --format json` output to per-scenario CPU/wall quantiles and
// outcomes. Only path, outcome, cpuTime and wallTime are read; headers and client IPs
// in the raw tail are never written out.
// Usage: node scripts/summarize-tail.mjs <raw-tail-file> > results/cpu.json
import { readFileSync } from 'node:fs';

const raw = readFileSync(process.argv[2], 'utf8');
const events = [];
// wrangler prints pretty-printed JSON objects back to back, not one per line.
let depth = 0;
let start = -1;
let inStr = false;
for (let i = 0; i < raw.length; i++) {
  const c = raw[i];
  if (inStr) {
    if (c === '\\') i++;
    else if (c === '"') inStr = false;
    continue;
  }
  if (c === '"') inStr = true;
  else if (c === '{' && depth++ === 0) start = i;
  else if (c === '}' && --depth === 0)
    events.push(JSON.parse(raw.slice(start, i + 1)));
}

if (events.length === 0) {
  console.error(`no tail events in ${process.argv[2]}; CPU evidence missing`);
  process.exit(1);
}

const by = {};
for (const e of events) {
  const url = e.event?.request?.url;
  if (!url) continue;
  const u = new URL(url);
  const key = u.pathname.slice(1) + u.search;
  (by[key] ??= []).push(e);
}

const q = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(p * arr.length))];
const out = {};
for (const [key, list] of Object.entries(by).sort()) {
  const cpu = list.map((e) => e.cpuTime).sort((a, b) => a - b);
  const wall = list.map((e) => e.wallTime).sort((a, b) => a - b);
  const outcomes = {};
  for (const e of list) outcomes[e.outcome] = (outcomes[e.outcome] ?? 0) + 1;
  out[key] = {
    n: list.length,
    outcomes,
    cpuMs: {
      p50: q(cpu, 0.5),
      p95: q(cpu, 0.95),
      p99: q(cpu, 0.99),
      max: cpu.at(-1),
    },
    wallMs: { p50: q(wall, 0.5), p99: q(wall, 0.99) },
  };
}
console.log(JSON.stringify(out, null, 2));
