// Runs client/bench.html in headless Chrome over CDP with optional CPU throttling.
// This is a desktop proxy, not a substitute for the reference low-end Android device.
// Usage: node scripts/client-bench-cdp.mjs <page-url> <throttle-rate> <user-data-dir>
import { spawn } from 'node:child_process';

const [url, rate = '1', userDataDir] = process.argv.slice(2);
if (!url || !userDataDir)
  throw new Error('usage: client-bench-cdp.mjs <url> <rate> <user-data-dir>');
const port = 9333;
const chrome = spawn(
  'google-chrome',
  [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    'about:blank',
  ],
  { stdio: 'ignore' }
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(200);
    target = await fetch(`http://127.0.0.1:${port}/json/list`)
      .then((r) => r.json())
      .then((l) => l.find((t) => t.type === 'page'))
      .catch(() => undefined);
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    pending.get(msg.id)?.(msg);
  };
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      pending.set(++id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  await send('Emulation.setCPUThrottlingRate', { rate: Number(rate) });
  await send('Page.navigate', { url });
  let result;
  for (let i = 0; i < 600 && !result; i++) {
    await sleep(1000);
    const r = await send('Runtime.evaluate', {
      expression:
        'window.benchResult ? JSON.stringify(window.benchResult) : ""',
      returnByValue: true,
    });
    if (r.result?.result?.value) result = JSON.parse(r.result.result.value);
  }
  delete result.userAgent;
  console.log(
    JSON.stringify({ cpuThrottleRate: Number(rate), url, ...result })
  );
  ws.close();
} finally {
  chrome.kill();
}
