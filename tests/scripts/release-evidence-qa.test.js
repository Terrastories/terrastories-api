import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const readRepo = (path) => readFileSync(join(repoRoot, path), 'utf8');

describe('release artifact reproducibility', () => {
  it('prunes production dependencies without an omitted-dev reinstall', () => {
    const dockerfile = readRepo('Dockerfile');

    expect(dockerfile).not.toContain('npm ci --omit=dev');
    expect(dockerfile).toContain('npm prune --omit=dev --ignore-scripts');
  });

  it('retains the Buildx-exported image and binds an archive checksum into evidence', () => {
    const workflow = readRepo('.github/workflows/supply-chain.yml');

    expect(workflow).toContain('outputs: type=docker,dest=release-image.tar');
    expect(workflow).toContain('docker load --input release-image.tar');
    expect(workflow).not.toContain('docker save');
    expect(workflow).toContain('sha256sum release-image.tar');
    expect(workflow).toContain('image_archive_sha256');
  });

  it('attests the retained release archive rather than an unpublished image subject', () => {
    const workflow = readRepo('.github/workflows/supply-chain.yml');

    expect(workflow).toContain(
      'image_archive_sha256: ${{ steps.evidence.outputs.archive_sha256 }}',
    );
    expect(workflow).toContain('subject-name: release-image.tar');
    expect(workflow).toContain(
      'subject-digest: ${{ needs.production_image.outputs.image_archive_sha256 }}',
    );
    expect(workflow).not.toContain(
      'subject-digest: ${{ needs.production_image.outputs.image_digest }}',
    );
  });

  it('keeps PostgreSQL production startup fail closed until migration parity lands', () => {
    const productionCompose = readRepo('docker-compose.prod.yml');
    const migrationRunner = readRepo('src/db/migrate.ts');

    expect(productionCompose).toContain('node dist/db/migrate.js');
    expect(productionCompose).toContain('exec node dist/server.js');
    expect(migrationRunner).toContain(
      'PostgreSQL migration history is not present. Refusing to run the SQLite/D1 migration set against PostgreSQL.',
    );
    expect(migrationRunner).toContain(
      'PostgreSQL migration parity is tracked by #135.',
    );
  });
});
