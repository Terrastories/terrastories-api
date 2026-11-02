import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MAX_MANIFEST_BYTES } from './trusted-audit-baseline.mjs';

// `git show` of a lockfile must fit the same cap the trusted checker applies,
// instead of Node's 1 MiB spawnSync default.
const GIT_OUTPUT_MAX_BYTES = MAX_MANIFEST_BYTES;

// Same-version lock fields a reviewer must see: install source, install
// scripts, executables, and the flags that decide production inclusion.
const REVIEWED_LOCK_FIELDS = [
  'resolved',
  'integrity',
  'hasInstallScript',
  'bin',
  'link',
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
  'dev',
  'devOptional',
  'optional',
  'peer',
];

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

    const beforePackage = basePackages[lockPath] ?? null;
    const afterPackage = currentPackages[lockPath] ?? null;
    const before = beforePackage?.version ?? null;
    const after = afterPackage?.version ?? null;

    if (before === after && beforePackage && afterPackage) {
      const changedFields = REVIEWED_LOCK_FIELDS.filter(
        (field) =>
          JSON.stringify(beforePackage[field]) !==
          JSON.stringify(afterPackage[field])
      );
      if (changedFields.length === 0) continue;

      changes.push({
        name: dependencyName(lockPath),
        before,
        after,
        type: 'changed',
        changedFields,
      });
      continue;
    }

    if (before === after) continue;

    changes.push({
      name: dependencyName(lockPath),
      before,
      after,
      type: before === null ? 'added' : after === null ? 'removed' : 'changed',
    });
  }

  return changes.sort(
    (left, right) =>
      left.name.localeCompare(right.name) ||
      String(left.before).localeCompare(String(right.before)) ||
      String(left.after).localeCompare(String(right.after))
  );
}

function runGit(args, cwd) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: GIT_OUTPUT_MAX_BYTES,
  });

  if (result.error) {
    if (result.error.code === 'ENOBUFS') {
      throw new Error(
        `git ${args.join(' ')} output exceeds the ${GIT_OUTPUT_MAX_BYTES}-byte limit`
      );
    }
    throw new Error(`Could not execute git: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed: ${result.stderr || result.stdout || `exit ${result.status}`}`
    );
  }

  return result.stdout;
}

export async function main(options = {}) {
  const cwd = options.cwd || process.cwd();
  const baseSha = options.baseSha || process.env.BASE_SHA || process.argv[2];
  const auditCommand = options.auditCommand || [
    process.execPath,
    fileURLToPath(new URL('./trusted-audit-baseline.mjs', import.meta.url)),
    '--data-dir',
    options.dataDir || process.env.AUDIT_DATA_DIR || cwd,
  ];

  if (!baseSha || !/^[0-9a-f]{40}$/i.test(baseSha)) {
    throw new Error('BASE_SHA must be a full 40-character commit SHA');
  }

  const changedManifests = runGit(
    [
      'diff',
      '--name-only',
      baseSha,
      'HEAD',
      '--',
      'package.json',
      'package-lock.json',
      'npm-shrinkwrap.json',
    ],
    cwd
  )
    .split('\n')
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (changedManifests.includes('npm-shrinkwrap.json')) {
    console.log(
      'Dependency review: npm-shrinkwrap.json changed; npm ci installs from it ahead of package-lock.json, so the trusted audit rejects it.'
    );
  }

  if (changedManifests.length === 0) {
    console.log('Dependency review: no package manifest or lockfile changes.');
  } else {
    const baseLock = JSON.parse(
      runGit(['show', `${baseSha}:package-lock.json`], cwd)
    );
    const lockMode = runGit(
      ['ls-tree', 'HEAD', '--', 'package-lock.json'],
      cwd
    ).split(' ')[0];
    if (lockMode !== '100644' && lockMode !== '100755') {
      throw new Error('The committed package-lock.json must be a regular file');
    }
    const currentLock = JSON.parse(
      runGit(['show', 'HEAD:package-lock.json'], cwd)
    );
    const changes = summarizeDependencyChanges(baseLock, currentLock);

    console.log(
      `Dependency review: ${changedManifests.join(', ')} changed; ${changes.length} locked dependency changes detected.`
    );
    for (const change of changes) {
      const changedFields = change.changedFields?.length
        ? ` [${change.changedFields.join(', ')}]`
        : '';
      console.log(
        `- ${change.type}: ${change.name} ${change.before ?? 'none'} -> ${change.after ?? 'none'}${changedFields}`
      );
    }
  }

  const [auditExecutable, ...auditArgs] = auditCommand;
  const audit = spawnSync(auditExecutable, auditArgs, {
    cwd,
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
