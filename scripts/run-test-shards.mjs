import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const waves = [
  ['test:ci:contracts'],
  ['test:ci:core'],
  ['test:ci:routes'],
  ['test:ci:services'],
  ['test:ci:production'],
  ['test:ci:comparison'],
];

export const DEFAULT_SHARD_TIMEOUT_MS = 4 * 60 * 1000;

function positiveTimeout(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid test shard timeout: ${value}`);
  }
  return parsed;
}

function forceKillProcessTree(child) {
  if (!child.pid) {
    return;
  }

  if (process.platform !== 'win32') {
    try {
      // The child is started as its own process-group leader, so a negative PID
      // kills npm plus any shell/Vitest descendants in the same group.
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch (error) {
      if (error?.code !== 'ESRCH') {
        throw error;
      }
      return;
    }
  }

  child.kill('SIGKILL');
}

export function runCommand(
  command,
  args,
  {
    label = command,
    timeoutMs = DEFAULT_SHARD_TIMEOUT_MS,
    env = process.env,
    stdio = 'inherit',
  } = {}
) {
  const deadline = positiveTimeout(timeoutMs);

  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(command, args, {
      stdio,
      env,
      shell: process.platform === 'win32',
      detached: process.platform !== 'win32',
    });

    const finish = (callback) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(deadlineTimer);
      callback();
    };

    const deadlineTimer = setTimeout(() => {
      try {
        forceKillProcessTree(child);
      } catch (error) {
        finish(() => reject(error));
        return;
      }

      // Reject immediately after the uncatchable kill signal so validation is
      // bounded even if the OS delays emitting the child's exit event.
      finish(() =>
        reject(new Error(`${label} exceeded ${deadline}ms and was terminated`))
      );
    }, deadline);

    child.on('error', (error) => {
      finish(() => reject(error));
    });

    child.on('exit', (code, signal) => {
      finish(() => {
        if (code === 0) {
          resolve();
          return;
        }

        reject(
          new Error(
            `${label} failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}`
          )
        );
      });
    });
  });
}

export function runScript(script, options = {}) {
  return runCommand('npm', ['run', script], {
    label: script,
    timeoutMs:
      options.timeoutMs ??
      positiveTimeout(
        process.env.TEST_SHARD_TIMEOUT_MS ?? DEFAULT_SHARD_TIMEOUT_MS
      ),
    env: options.env ?? process.env,
    stdio: options.stdio ?? 'inherit',
  });
}

export async function main() {
  for (const wave of waves) {
    console.log(`\nRunning test wave: ${wave.join(', ')}`);
    await Promise.all(wave.map((script) => runScript(script)));
  }

  console.log('\nAll deterministic test shards passed.');
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
