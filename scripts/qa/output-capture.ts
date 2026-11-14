import { format } from 'node:util';
import { runJourneys } from './runner.js';

/**
 * #191: run the persona journeys with every output channel captured, so the
 * wrapper's assertion can prove cultural content (seeded story titles,
 * descriptions, place and speaker names) never reaches log output. The Hono
 * app has no logging seam — `src/hono-app.ts` answers errors without logging
 * anything and the Explore adapter logs nothing — and this keeps that true
 * against both console calls and direct stream writes: standard Node/server
 * loggers (pino and friends) write to `process.stdout`/`process.stderr` and
 * bypass `console` entirely. Captured writes are not forwarded while the
 * journeys run (the window belongs to the assertion, not the terminal), and
 * every original — console methods and stream writes alike, restored with
 * their own-property vs prototype distinction intact — is put back in
 * `finally`. The Workers wrapper runs the app inside workerd, where output
 * is out of process and is not captured.
 */
export const runJourneysCapturingOutput = async (
  journeys: Parameters<typeof runJourneys>[0]
) => {
  const methods = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;
  const lines: string[] = [];
  const consoleOriginals = methods.map((method) => console[method]);
  const decoder = new TextDecoder();
  const decode = (chunk: unknown): string =>
    typeof chunk === 'string'
      ? chunk
      : chunk instanceof Uint8Array
        ? decoder.decode(chunk)
        : '';
  const streams: NodeJS.WriteStream[] = [process.stdout, process.stderr];
  const streamOriginals = streams.map((stream) => ({
    stream,
    original: stream.write,
    own: Object.prototype.hasOwnProperty.call(stream, 'write'),
  }));
  for (const method of methods)
    console[method] = (...args: unknown[]) => {
      lines.push(format(...args));
    };
  for (const { stream } of streamOriginals)
    stream.write = ((chunk: unknown, ...rest: unknown[]) => {
      lines.push(decode(chunk));
      // Complete the write from the caller's side: nothing is forwarded, but
      // a caller awaiting its callback must not hang on a drain that never
      // fires.
      const callback = rest[rest.length - 1];
      if (typeof callback === 'function') (callback as () => void)();
      return true;
    }) as unknown as NodeJS.WriteStream['write'];
  try {
    return { report: await runJourneys(journeys), lines };
  } finally {
    methods.forEach((method, index) => {
      console[method] = consoleOriginals[index];
    });
    for (const { stream, original, own } of streamOriginals) {
      if (own) stream.write = original;
      // When write was inherited from the prototype before capture, removing
      // the shadowing own property restores the original lookup exactly.
      else delete (stream as { write?: unknown }).write;
    }
  }
};
