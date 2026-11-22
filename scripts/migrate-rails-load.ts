import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  loadTransformOutput,
  type LoadOptions,
  type LoadTarget,
} from '../src/migration/v2/load.js';

export type ParsedLoadArgs =
  | { help: true }
  | ({ help: false } & Omit<LoadOptions, 'env' | 'fetchImpl'>);

export function usage(): string {
  return [
    'Rails migration load (stage 3: transform output -> V2 target)',
    '',
    'Usage:',
    '  npm run migrate:rails:load -- \\',
    '    --transform-output <stage-2-output-directory> \\',
    '    --target <node-sqlite|d1|r2> [--dry-run] [target options]',
    '',
    'Every target first re-verifies the output (files table vs manifest ledger,',
    'and the size and SHA-256 of every media object) and fails closed.',
    '',
    'node-sqlite   --data-dir <dir> --storage-root <dir>',
    '              Copies v2-media into the storage root (objects first, each',
    '              SHA-256 verified; an identical existing object is kept, a',
    '              different one aborts) and then v2.sqlite into the data dir.',
    '              Never overwrites an existing database.',
    'd1            --sql-out <new-dir> [--max-file-bytes <n>]',
    '              Writes a data-only SQL dump in foreign-key order (statements',
    '              under the D1 100 KB limit, files chunked), a sequences file,',
    '              d1-import.json and r2-upload-manifest.json. Apply the V2',
    '              migrations to D1 first, then run each file with',
    '              "wrangler d1 execute <db> --remote --file <file>".',
    'r2            --bucket <name> [--endpoint <url>] [--concurrency <n>]',
    '              Uploads each object over the S3-compatible API and verifies',
    '              it by HEAD (size and SHA-256 metadata). Credentials come only',
    '              from R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ACCOUNT_ID.',
    '',
    '--dry-run prints counts only and writes or uploads nothing.',
    '',
  ].join('\n');
}

const VALUE_FLAGS = new Set([
  '--transform-output',
  '--target',
  '--data-dir',
  '--storage-root',
  '--sql-out',
  '--max-file-bytes',
  '--bucket',
  '--endpoint',
  '--concurrency',
]);

export function parseArgs(argv: string[]): ParsedLoadArgs {
  const values: Record<string, string> = {};
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? '';
    if (argument === '--help' || argument === '-h') return { help: true };
    if (argument === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (!VALUE_FLAGS.has(argument)) {
      throw new Error('Unknown argument: ' + argument);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error('Missing value for ' + argument);
    }
    values[argument] = value;
    index += 1;
  }
  const transformDir = values['--transform-output'];
  if (!transformDir) throw new Error('--transform-output is required');
  const target = values['--target'];
  if (target !== 'node-sqlite' && target !== 'd1' && target !== 'r2') {
    throw new Error('--target must be node-sqlite, d1 or r2');
  }
  const positive = (flag: string): number | undefined => {
    const raw = values[flag];
    if (raw === undefined) return undefined;
    if (!/^[1-9][0-9]*$/.test(raw)) {
      throw new Error(flag + ' must be a positive integer');
    }
    return Number(raw);
  };
  const result: Omit<LoadOptions, 'env' | 'fetchImpl'> = {
    transformDir,
    target: target as LoadTarget,
    dryRun,
  };
  if (values['--data-dir'] !== undefined) result.dataDir = values['--data-dir'];
  if (values['--storage-root'] !== undefined) {
    result.storageRoot = values['--storage-root'];
  }
  if (values['--sql-out'] !== undefined) result.sqlOut = values['--sql-out'];
  if (values['--bucket'] !== undefined) result.bucket = values['--bucket'];
  if (values['--endpoint'] !== undefined)
    result.endpoint = values['--endpoint'];
  const maxFileBytes = positive('--max-file-bytes');
  if (maxFileBytes !== undefined) result.maxFileBytes = maxFileBytes;
  const concurrency = positive('--concurrency');
  if (concurrency !== undefined) result.concurrency = concurrency;
  return { help: false, ...result };
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(usage());
    return;
  }
  const { help: _help, ...options } = parsed;
  void _help;
  const report = await loadTransformOutput(options);
  // Counts only: never print keys, credentials, endpoints or row contents.
  const counts = Object.entries(report)
    .filter(([, value]) => typeof value === 'number')
    .map(([key, value]) => key + '=' + String(value))
    .join(' ');
  process.stdout.write(
    'Rails load ' +
      (report.dryRun ? '(dry run) ' : '') +
      'complete (' +
      report.target +
      '): ' +
      counts +
      '\n'
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error: unknown) => {
    const message =
      error instanceof Error ? error.message : 'Unknown migration error';
    process.stderr.write('Rails load failed: ' + message + '\n');
    process.exitCode = 1;
  });
}
