import { spawn } from 'node:child_process';

const waves = [
  ['test:ci:core'],
  ['test:ci:routes'],
  ['test:ci:services'],
  ['test:ci:production'],
  ['test:ci:comparison'],
];

function runScript(script) {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', ['run', script], {
      stdio: 'inherit',
      env: process.env,
      shell: process.platform === 'win32',
    });

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          `${script} failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}`
        )
      );
    });
  });
}

for (const wave of waves) {
  console.log(`\nRunning test wave: ${wave.join(', ')}`);
  try {
    await Promise.all(wave.map(runScript));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

console.log('\nAll deterministic test shards passed.');
