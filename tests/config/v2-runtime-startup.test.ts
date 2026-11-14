import { it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * #150: the Node V2 entrypoint must fail fast at startup — exit non-zero,
 * message naming the setting, before any adapter or database is opened —
 * when production configuration is insecure or default.
 */
it('hono-server exits non-zero on missing production HONO_PUBLIC_ORIGIN', async () => {
  const cleanEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: 'production',
  };
  const failure = await run(
    process.execPath,
    ['node_modules/tsx/dist/cli.mjs', 'src/hono-server.ts'],
    { cwd: process.cwd(), env: cleanEnv }
  ).then(
    () => null,
    (error: NodeJS.ErrnoException & { stderr?: string }) => error
  );
  expect(failure, 'startup must fail closed').not.toBeNull();
  expect(failure!.code, 'non-zero exit code').not.toBe(0);
  expect(failure!.stderr ?? '').toContain(
    'V2 runtime configuration check failed'
  );
  expect(failure!.stderr ?? '').toContain('HONO_PUBLIC_ORIGIN');
  // The configured value is never echoed.
  expect(failure!.stderr ?? '').not.toContain('https://');
});
