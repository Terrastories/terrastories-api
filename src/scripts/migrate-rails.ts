import { captureRailsToBundle } from '../migration/rails/capture.js';

interface CliOptions {
  sourceUrl: string;
  outputDir: string;
  blobRoot?: string;
}

function usage(): string {
  return `Rails migration capture (stage 1 of Rails -> V2 migration)

Usage:
  npx tsx src/scripts/migrate-rails.ts \\
    --source <postgres-url> \\
    --output <bundle-directory> \\
    [--blob-root <active-storage-export>]

The command creates a lossless migration bundle containing:
  legacy.sqlite   typed source schema + every source row
  blobs/          verified ActiveStorage bytes by blob key
  manifest.json   counts, schema/row/blob digests and provenance

If ActiveStorage blob rows exist, --blob-root is mandatory. The root may be a
flat object-store export keyed by ActiveStorage key or a Rails DiskService root.
The command never overwrites an existing output directory and removes temporary
output on failure.
`;
}

function parseArgs(argv: string[]): CliOptions {
  let sourceUrl: string | undefined;
  let outputDir: string | undefined;
  let blobRoot: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      process.stdout.write(usage());
      process.exit(0);
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
      case '--blob-root':
        blobRoot = value;
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
    index += 1;
  }

  if (!sourceUrl) throw new Error('--source is required');
  if (!outputDir) throw new Error('--output is required');
  return { sourceUrl, outputDir, blobRoot };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const manifest = await captureRailsToBundle(options);

  // Never print source rows, secrets, database URLs, hashes, or filenames here.
  process.stdout.write(
    `Rails capture complete: ${manifest.totals.tables} tables, ${manifest.totals.rows} rows, ${manifest.totals.blobs} blobs.\n`
  );
  process.stdout.write(`Bundle: ${options.outputDir}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown migration error';
  process.stderr.write(`Rails capture failed: ${message}\n`);
  process.exitCode = 1;
});
