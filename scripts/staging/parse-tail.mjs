#!/usr/bin/env node
// Parse `wrangler tail --format json` output. Wrangler pretty-prints each event
// over many lines, so the stream is a run of concatenated JSON objects, not
// JSON Lines. This reader splits on balanced braces (string-aware) and prints
// one TSV row per invocation: method, url (no query), outcome, cpuTime, wallTime.
//
//   node scripts/staging/parse-tail.mjs cpu-tail.jsonl
//   node scripts/staging/parse-tail.mjs < cpu-tail.jsonl
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function splitJsonObjects(text) {
  const out = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0) {
        try {
          out.push(JSON.parse(text.slice(start, i + 1)));
        } catch {
          // skip a malformed fragment
        }
      }
    }
  }
  return out;
}

export function tailRows(text) {
  const rows = [];
  for (const ev of splitJsonObjects(text)) {
    const req = ev.event && ev.event.request;
    if (!req || req.url == null) continue;
    rows.push([
      req.method ?? '',
      String(req.url).split('?')[0],
      ev.outcome ?? '',
      ev.cpuTime ?? '',
      ev.wallTime ?? '',
    ]);
  }
  return rows;
}

// pathToFileURL resolves relative paths and encodes spaces/unicode correctly;
// 'file://' + argv[1] breaks for relative invocations and special characters.
const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const text = readFileSync(process.argv[2] ?? 0, 'utf8');
  console.log(
    ['method', 'url', 'outcome', 'cpuTime_ms', 'wallTime_ms'].join('\t')
  );
  for (const r of tailRows(text)) console.log(r.join('\t'));
}
