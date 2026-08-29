import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LEGACY_RAILS_COMMIT,
  RAILS_SCHEMA_VERSION,
  REQUIRED_RAILS_TABLES,
} from '../../src/migration/rails/contract.js';
import { resolveActiveStorageBlobPath } from '../../src/migration/rails/active-storage.js';

describe('legacy Rails migration contract', () => {
  it('is pinned to the audited legacy repository and schema version', () => {
    expect(LEGACY_RAILS_COMMIT).toBe(
      'f6f033a17bd4a4c600ffea8bc2e773d243f88f72'
    );
    expect(RAILS_SCHEMA_VERSION).toBe('2024_04_10_210545');
  });

  it('requires every data-bearing Rails domain and ActiveStorage table', () => {
    expect(Object.keys(REQUIRED_RAILS_TABLES).sort()).toEqual(
      [
        'active_storage_attachments',
        'active_storage_blobs',
        'active_storage_variant_records',
        'communities',
        'curriculum_stories',
        'curriculums',
        'flipper_features',
        'flipper_gates',
        'media',
        'media_links',
        'places',
        'places_stories',
        'speaker_stories',
        'speakers',
        'stories',
        'themes',
        'users',
      ].sort()
    );

    expect(REQUIRED_RAILS_TABLES.users).toContain('encrypted_password');
    expect(REQUIRED_RAILS_TABLES.users).toContain('super_admin');
    expect(REQUIRED_RAILS_TABLES.stories).toContain('permission_level');
    expect(REQUIRED_RAILS_TABLES.places).toContain('lat');
    expect(REQUIRED_RAILS_TABLES.places).toContain('long');
    expect(REQUIRED_RAILS_TABLES.themes).toContain('protomaps_basemap_style');
  });
});

describe('ActiveStorage blob resolution', () => {
  it('accepts a flat object-store export by ActiveStorage key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rails-flat-blobs-'));
    const expected = join(root, 'fixtureblob');
    await writeFile(expected, 'fixture');

    await expect(
      resolveActiveStorageBlobPath(root, 'fixtureblob')
    ).resolves.toBe(expected);
  });

  it('accepts Rails DiskService two-level key layout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rails-disk-blobs-'));
    const nested = join(root, 'fi', 'xt');
    await mkdir(nested, { recursive: true });
    const expected = join(nested, 'fixtureblob');
    await writeFile(expected, 'fixture');

    await expect(
      resolveActiveStorageBlobPath(root, 'fixtureblob')
    ).resolves.toBe(expected);
  });

  it('rejects unsafe blob keys before touching the filesystem', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rails-unsafe-blobs-'));
    await expect(
      resolveActiveStorageBlobPath(root, '../secret')
    ).rejects.toThrow(/unsafe ActiveStorage key/i);
  });

  it('rejects symlinks instead of following blob paths outside the trusted export', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rails-symlink-blobs-'));
    const outside = join(await mkdtemp(join(tmpdir(), 'rails-secret-')), 'secret');
    await writeFile(outside, 'not-an-exported-blob');
    await symlink(outside, join(root, 'fixtureblob'));

    await expect(
      resolveActiveStorageBlobPath(root, 'fixtureblob')
    ).rejects.toThrow(/symlink|missing ActiveStorage blob bytes/i);
  });
});
