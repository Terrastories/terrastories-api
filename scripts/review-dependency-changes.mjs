import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

function dependencyName(lockPath) {
  const marker = 'node_modules/';
  const index = lockPath.lastIndexOf(marker);
  return index === -1 ? lockPath : lockPath.slice(index + marker.length);
}

export function summarizeDependencyChanges(baseLock, currentLock) {
  const basePackages = baseLock?.packages || {};
  const currentPackages = currentLock?.packages || {};
  const paths = new Set([
    ...Object.keys(basePackages),
    ...Object.keys(currentPackages),
  ]);
  const changes = [];

  for (const lockPath of paths) {
    if (!lockPath.includes('node_modules/')) continue;

    const before = basePackages[lockPath]?.version ?? null;
    const after = currentPackages[lockPath]?.version ?? null;
    if (before === after) continue;

    changes.push({
      name: dependencyName(lockPath),
      before,
      after,
      type:
        before === null ? 'added' : after === null ? 'removed' : 'changed',
    });
  }

  return changes.sort(
    (left, right) =>
      left.name.localeCompare(right.name) ||
      String(left.before).localeCompare(String(right.before)) ||
      String(left.after).localeCompare(String(right.after))
  );
}

function runGit(args) {
  const result = spawnSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.error) {
    throw new Error(`Could not execute git: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed: ${result.stderr || result.stdout || `exit ${result.status}`}`
    );
  }

  return result.stdout;
}

export async function main() {
  const baseSha = process.env.BASE_SHA || process.argv[2];
  if (!baseSha || !/^[0-9a-f]{40}$/i.test(baseSha)) {
    throw new Error('BASE_SHA must be a full 40-character commit SHA');
  }

  const changedManifests = runGit([
    'diff',
    '--name-only',
    baseSha,
    'HEAD',
    '--',
    'package.json',
    'package-lock.json',
  ])
    .split('\n')
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (changedManifests.length === 0) {
    console.log('Dependency review: no package manifest or lockfile changes.');
    return;
  }

  const baseLock = JSON.parse(
    runGit(['show', `${baseSha}:package-lock.json`])
  );
  const currentLock = JSON.parse(await readFile('package-lock.json', 'utf8'));
  const changes = summarizeDependencyChanges(baseLock, currentLock);

  console.log(
    `Dependency review: ${changedManifests.join(', ')} changed; ${changes.length} locked dependency changes detected.`
  );
  for (const change of changes) {
    console.log(
      `- ${change.type}: ${change.name} ${change.before ?? 'none'} -> ${change.after ?? 'none'}`
    );
  }

  const audit = spawnSync('npm', ['run', 'audit:baseline'], {
    stdio: 'inherit',
  });
  if (audit.error) {
    throw new Error(
      `Could not execute dependency audit: ${audit.error.message}`
    );
  }
  if (audit.status !== 0) {
    throw new Error(
      `Dependency audit rejected this PR with exit code ${audit.status}`
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exit(1);
  });
}
