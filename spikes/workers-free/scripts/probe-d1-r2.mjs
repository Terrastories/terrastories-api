// Probes in-Worker D1 batch limits and R2 put/get on the deployed spike Worker.
// Usage: node scripts/probe-d1-r2.mjs <base-url> > results/d1-r2-probe.json
const [base] = process.argv.slice(2);
if (!base) throw new Error('usage: probe-d1-r2.mjs <base-url>');

async function hit(path, opts) {
  const t0 = performance.now();
  const res = await fetch(`${base}/${path}`, opts);
  const buf = new Uint8Array(await res.arrayBuffer());
  const text = res.headers.get('content-type')?.includes('json')
    ? new TextDecoder().decode(buf)
    : null;
  let body = text;
  try {
    body = text && JSON.parse(text);
  } catch {}
  if (!text && res.status >= 400)
    body = new TextDecoder().decode(buf.slice(0, 80));
  return {
    path,
    status: res.status,
    clientMs: Math.round(performance.now() - t0),
    bytes: buf.length,
    body,
  };
}

const out = { d1Batch: [], r2: [] };
// 33 rows x 3 params = 99 bound params; 34 rows (102 params) must fail.
// These writes count against D1 Free's daily rows-written quota; set SKIP_D1=1 to skip.
const d1Cases = process.env.SKIP_D1
  ? []
  : [
      'stmts=10&rows=33',
      'stmts=100&rows=33',
      'stmts=300&rows=33',
      'stmts=1000&rows=33',
      'stmts=1&rows=34',
    ];
for (const q of d1Cases) {
  const r = await hit(`d1/batch?${q}`);
  out.d1Batch.push(r);
  console.error(q, r.status, r.clientMs, JSON.stringify(r.body).slice(0, 160));
}
for (const kb of [512, 10240, 51200]) {
  const put = await hit(`r2/put?kb=${kb}`);
  const get = put.body?.key
    ? await hit(`r2/get?key=${encodeURIComponent(put.body.key)}`)
    : null;
  out.r2.push({
    kb,
    put: { ...put },
    get: get && {
      status: get.status,
      clientMs: get.clientMs,
      bytes: get.bytes,
    },
  });
  console.error(
    'r2',
    kb,
    put.status,
    put.clientMs,
    get?.status,
    get?.bytes,
    get?.clientMs
  );
}
// Client upload: stream a request body through the Worker into R2.
for (const mb of [10, 50, 99, 101]) {
  const body = new Uint8Array(mb * 1024 * 1024);
  const put = await hit('r2/put', { method: 'PUT', body }).catch((e) => ({
    status: 'fetch-error',
    body: String(e),
  }));
  out.r2.push({ uploadMiB: mb, put });
  console.error(
    'upload',
    mb,
    put.status,
    put.clientMs,
    JSON.stringify(put.body).slice(0, 120)
  );
}
console.log(JSON.stringify(out, null, 2));
