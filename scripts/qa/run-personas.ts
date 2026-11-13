import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import {
  runJourneys,
  validateBaseUrl,
  validateRequestTimeout,
} from './runner.js';

export { runJourneys as runPersonas } from './runner.js';

export async function main(args: string[]): Promise<number> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (
      !['--base-url', '--fixture', '--report', '--request-timeout-ms'].includes(
        name
      ) ||
      !value ||
      values.has(name)
    ) {
      throw new Error(
        'Usage: qa:personas --fixture MODULE [--base-url URL] [--report FILE] [--request-timeout-ms MS]'
      );
    }
    values.set(name, value);
  }
  const timeoutValue = values.get('--request-timeout-ms');
  const requestTimeoutMs =
    timeoutValue === undefined
      ? 30_000
      : validateRequestTimeout(
          timeoutValue.trim() ? Number(timeoutValue) : NaN
        );
  const base = values.get('--base-url');
  const url = base ? validateBaseUrl(base) : undefined;
  const fixture = values.get('--fixture');
  if (!fixture)
    throw new Error(
      '--fixture is required to seed isolated QA data and discover routes'
    );
  const module = await import(pathToFileURL(resolve(fixture)).href);
  if (typeof module.createFixture !== 'function')
    throw new Error('Fixture must export createFixture');
  const context = await module.createFixture({ baseUrl: url?.href });
  try {
    const handler = url
      ? async (request: Request) =>
          fetch(
            new URL(
              new URL(request.url).pathname + new URL(request.url).search,
              url
            ),
            {
              method: request.method,
              headers: request.headers,
              body: ['GET', 'HEAD'].includes(request.method)
                ? undefined
                : await request.arrayBuffer(),
              redirect: 'manual',
              signal: request.signal,
            }
          )
      : context.handler;
    const report = await runJourneys({ ...context, handler, requestTimeoutMs });
    await writeFile(
      values.get('--report') ?? 'qa-report.json',
      JSON.stringify(report, null, 2) + '\n'
    );
    return report.pass ? 0 : 1;
  } finally {
    await context.close?.();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(
        error instanceof Error ? error.message : 'Persona QA failed'
      );
      process.exitCode = 1;
    });
}
