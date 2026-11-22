import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  transformRailsBundle,
  type TransformRailsOptions,
} from '../src/migration/v2/transform.js';

export type ParsedTransformArgs =
  | { help: true }
  | ({ help: false } & TransformRailsOptions);

export function usage(): string {
  return `Rails migration transform (stage 2 of Rails -> V2 migration)

Usage:
  npm run migrate:rails:transform -- \
    --bundle <verified-stage-1-bundle> \
    --output <new-output-directory> \
    [--community <id|slug> ...] \
    [--include-system-users] \
    [--allow-manual]

Verifies the Stage-1 bundle (archive, row digests, blob checksums) and fails
closed, then writes to a new owner-only directory (never overwritten):
  v2.sqlite              canonical V2 SQLite database (migrations applied)
  legacy-archive.sqlite  rows/fields not represented canonically (restricted)
  manifest.json          counts, dispositions, id remaps, warnings, checksums
  manual-review.json     MANUAL ids and codes (with --allow-manual only)
  validation-summary.txt counts only; no contents or secrets

Options:
  --community <id|slug>   Repeatable. Import only selected communities; all
                          other rows get disposition not_selected.
  --include-system-users  Also import null-community super_admin users.
  --allow-manual          Exclude MANUAL items and list them instead of failing.

Media payloads are recorded as pending_media_slice; no files rows are created.
`;
}

export function parseArgs(argv: string[]): ParsedTransformArgs {
  let bundleDir: string | undefined;
  let outputDir: string | undefined;
  let includeSystemUsers = false;
  let allowManual = false;
  const communities: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') return { help: true };
    if (argument === '--include-system-users') {
      includeSystemUsers = true;
      continue;
    }
    if (argument === '--allow-manual') {
      allowManual = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error('Missing value for ' + (argument ?? 'argument'));
    }
    switch (argument) {
      case '--bundle':
        bundleDir = value;
        break;
      case '--output':
        outputDir = value;
        break;
      case '--community':
        communities.push(value);
        break;
      default:
        throw new Error('Unknown argument: ' + (argument ?? ''));
    }
    index += 1;
  }

  if (!bundleDir) throw new Error('--bundle is required');
  if (!outputDir) throw new Error('--output is required');
  return {
    help: false,
    bundleDir,
    outputDir,
    includeSystemUsers,
    allowManual,
    ...(communities.length > 0 ? { communities } : {}),
  };
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(usage());
    return;
  }
  const manifest = await transformRailsBundle(parsed);
  // Counts only: never print row contents, secrets, hashes or database URLs.
  const imported = Object.values(manifest.canonicalCounts).reduce(
    (sum, count) => sum + count,
    0
  );
  process.stdout.write(
    'Rails transform complete (' +
      manifest.input.contractProfile +
      '): ' +
      imported +
      ' canonical rows, ' +
      manifest.manual.length +
      ' MANUAL, ' +
      manifest.warnings.length +
      ' warnings.\n'
  );
  process.stdout.write('Output: ' + parsed.outputDir + '\n');
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error: unknown) => {
    const message =
      error instanceof Error ? error.message : 'Unknown migration error';
    process.stderr.write('Rails transform failed: ' + message + '\n');
    process.exitCode = 1;
  });
}
