import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  captureRailsToBundle,
  type CaptureRailsOptions,
} from '../src/migration/rails/capture.js';

export type ParsedCliArgs =
  | { help: true }
  | ({ help: false } & CaptureRailsOptions);

export function usage(): string {
  return `Rails migration capture (stage 1 of Rails -> V2 migration)

Usage:
  npm run migrate:rails:capture -- \\
    --source <postgres-url> \\
    --output <bundle-directory> \\
    [--blob-source <disk|s3>] \\
    [--blob-root <active-storage-export>] \\
    [--s3-bucket <bucket> --s3-region <region> [--s3-prefix <prefix>]] \\
    [--blob-concurrency <1..32>] \\
    [--community <id|slug> ...]

The command creates a lossless migration bundle containing:
  legacy.sqlite          typed source schema + every source row
  blobs/                 verified ActiveStorage bytes by blob key
  manifest.json          counts, schema/row/blob digests and provenance
  validation-summary.txt secret-safe human-readable capture summary

Blob sources:
  disk (default)         --blob-root accepts flat exports or DiskService layout
  s3                     --s3-bucket and --s3-region; reads AWS_ACCESS_KEY_ID and
                         AWS_SECRET_ACCESS_KEY (plus optional AWS_SESSION_TOKEN)
                         from environment variables only (never flags)

Community allowlist:
  --community <id|slug>  Repeatable. Captures all relational rows, and limits
                         blob downloads to reachable blobs (+ variants and
                         preview_image) for the selected communities; others
                         are recorded as disposition "not_selected".

The command never overwrites an existing output directory and removes temporary
output on failure.
`;
}

export function parseArgs(argv: string[]): ParsedCliArgs {
  let sourceUrl: string | undefined;
  let outputDir: string | undefined;
  let blobSourceKind: 'disk' | 's3' = 'disk';
  let blobRoot: string | undefined;
  let s3Bucket: string | undefined;
  let s3Region: string | undefined;
  let s3Prefix: string | undefined;
  let blobConcurrency: number | undefined;
  const communities: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      return { help: true };
    }

    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${argument ?? 'argument'}`);
    }

    switch (argument) {
      case '--source':
        sourceUrl = value;
        break;
      case '--output':
        outputDir = value;
        break;
      case '--blob-source':
        if (value !== 'disk' && value !== 's3') {
          throw new Error(
            `Unsupported --blob-source: ${value}. Expected 'disk' or 's3'.`
          );
        }
        blobSourceKind = value;
        break;
      case '--blob-root':
        blobRoot = value;
        break;
      case '--s3-bucket':
        s3Bucket = value;
        break;
      case '--s3-region':
        s3Region = value;
        break;
      case '--s3-prefix':
        s3Prefix = value;
        break;
      case '--blob-concurrency': {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 32) {
          throw new Error(
            `Invalid --blob-concurrency: ${value}. Must be an integer between 1 and 32.`
          );
        }
        blobConcurrency = parsed;
        break;
      }
      case '--community':
        communities.push(value);
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
    index += 1;
  }

  if (!sourceUrl) throw new Error('--source is required');
  if (!outputDir) throw new Error('--output is required');

  if (blobSourceKind === 's3') {
    if (blobRoot !== undefined) {
      throw new Error('--blob-root cannot be combined with --blob-source s3');
    }
    if (!s3Bucket)
      throw new Error('--s3-bucket is required with --blob-source s3');
    if (!s3Region)
      throw new Error('--s3-region is required with --blob-source s3');

    return {
      help: false,
      sourceUrl,
      outputDir,
      blobSource: {
        kind: 's3',
        bucket: s3Bucket,
        region: s3Region,
        prefix: s3Prefix,
      },
      ...(communities.length > 0 ? { communities } : {}),
      ...(blobConcurrency !== undefined ? { blobConcurrency } : {}),
    };
  }

  if (
    s3Bucket !== undefined ||
    s3Region !== undefined ||
    s3Prefix !== undefined
  ) {
    throw new Error('--s3-* options require --blob-source s3');
  }

  return {
    help: false,
    sourceUrl,
    outputDir,
    blobSource: { kind: 'disk', blobRoot },
    ...(communities.length > 0 ? { communities } : {}),
    ...(blobConcurrency !== undefined ? { blobConcurrency } : {}),
  };
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(usage());
    return;
  }

  const manifest = await captureRailsToBundle(parsed);

  // Never print source rows, secrets, database URLs, hashes, or filenames here.
  process.stdout.write(
    `Rails capture complete (${manifest.source.contractProfile}, ${manifest.storage.kind}): ` +
      `${manifest.totals.tables} tables, ${manifest.totals.rows} rows, ` +
      `${manifest.totals.blobsSelected}/${manifest.totals.blobs} blobs selected` +
      (manifest.totals.blobsNotSelected > 0
        ? ` (${manifest.totals.blobsNotSelected} not_selected).`
        : '.') +
      '\n'
  );
  process.stdout.write(`Bundle: ${parsed.outputDir}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error: unknown) => {
    const message =
      error instanceof Error ? error.message : 'Unknown migration error';
    process.stderr.write(`Rails capture failed: ${message}\n`);
    process.exitCode = 1;
  });
}
