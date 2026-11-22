import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { beforeAll, describe, expect, it } from 'vitest';
import { captureRailsToBundle } from '../../src/migration/rails/capture.js';
import {
  transformRailsBundle,
  type TransformManifest,
} from '../../src/migration/v2/transform.js';
import {
  fixtureDir,
  loadFixtureSql,
  withIsolatedRailsDatabase,
} from './pg-test-helper.js';

const sourceUrl = process.env.RAILS_MIGRATION_TEST_DATABASE_URL;
const describeWithPostgres = sourceUrl ? describe : describe.skip;

// Provider-credential-shaped values are assembled at runtime so no
// credential-shaped literal is committed.
const publicToken = ['pk', 'fixture', 'public'].join('.');
const privateCommunityToken = ['pk', 'fixture', 'private'].join('.');
const secretToken = ['sk', 'fixture', 'secret'].join('.');
const halfPairToken = ['pk', 'fixture', 'half'].join('.');

describeWithPostgres('Stage-2 Mapbox/Protomaps map-config import', () => {
  let workDir: string;
  let out: string;
  let manifest: TransformManifest;

  const config = (communityId: number): Record<string, unknown> => {
    const db = new Database(join(out, 'v2.sqlite'), { readonly: true });
    const row = db
      .prepare('SELECT * FROM community_map_configs WHERE community_id = ?')
      .get(communityId) as Record<string, unknown>;
    db.close();
    return row;
  };
  const warnings = (themeId: string): string[] =>
    manifest.warnings
      .filter((w) => w.table === 'themes' && w.id === themeId)
      .map((w) => w.code);

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'rails-mapcfg-'));
    const bundle = join(workDir, 'bundle');
    await withIsolatedRailsDatabase(sourceUrl!, async (dbUrl, pool) => {
      await loadFixtureSql(pool, '2025');
      for (const id of [13, 14, 15]) {
        await pool.query(
          "INSERT INTO communities(id, name, locale, created_at, updated_at, public, slug) VALUES ($1, $2, 'en', '2020-01-01 00:00:00', '2020-01-01 00:00:00', true, $3)",
          [id, 'Map config community ' + id, 'mapcfg_' + id]
        );
      }
      // 10 (public): valid pair + expose + protomaps key
      await pool.query(
        'UPDATE themes SET mapbox_style_url = $1, mapbox_access_token = $2, expose_mapbox_credentials = true, protomaps_api_key = $3 WHERE id = 60',
        ['mapbox://styles/owner/styleid', publicToken, 'fixture-protomaps-key']
      );
      const insert = (
        id: number,
        community: number,
        style: string | null,
        token: string | null,
        expose: boolean
      ) =>
        pool.query(
          "INSERT INTO themes(id, active, created_at, updated_at, mapbox_style_url, mapbox_access_token, community_id, expose_mapbox_credentials) VALUES ($1, true, '2020-07-01 00:00:00', '2020-07-01 00:00:00', $2, $3, $4, $5)",
          [id, style, token, community, expose]
        );
      // 11 (private): expose=true must be reset
      await insert(
        61,
        11,
        'mapbox://styles/owner/private',
        privateCommunityToken,
        true
      );
      // 13: secret token rejected
      await insert(62, 13, 'mapbox://styles/owner/styleid', secretToken, false);
      // 14: token without style (half pair)
      await insert(63, 14, null, halfPairToken, false);
      // 15: insecure style URL with a valid token
      await insert(
        64,
        15,
        'http://example.test/style.json',
        publicToken,
        false
      );
      await captureRailsToBundle({
        sourceUrl: dbUrl,
        outputDir: bundle,
        blobRoot: join(fixtureDir, 'blobs'),
      });
    });
    out = join(workDir, 'out');
    manifest = await transformRailsBundle({
      bundleDir: bundle,
      outputDir: out,
      allowManual: true,
    });
  }, 120_000);

  it('imports a valid public pair, expose flag and protomaps key for a public community', () => {
    expect(config(10)).toMatchObject({
      mapbox_style_url: 'mapbox://styles/owner/styleid',
      mapbox_access_token: publicToken,
      expose_mapbox_credentials: 1,
      protomaps_api_key: 'fixture-protomaps-key',
      protomaps_basemap_style: '{"theme":"light"}',
      mapbox_3d: 1,
    });
    expect(warnings('60')).not.toContain('mapbox_pair_incomplete');
  });

  it('resets expose_mapbox_credentials for a private community and warns', () => {
    expect(config(11)).toMatchObject({
      mapbox_access_token: privateCommunityToken,
      expose_mapbox_credentials: 0,
    });
    expect(warnings('61')).toContain('expose_mapbox_credentials_reset_private');
  });

  it('rejects secret tokens: archive only, warning without the value', async () => {
    expect(config(13)).toMatchObject({
      mapbox_style_url: null,
      mapbox_access_token: null,
    });
    expect(warnings('62')).toEqual(
      expect.arrayContaining([
        'mapbox_token_not_public',
        'mapbox_pair_incomplete',
      ])
    );
    const bytes = await readFile(join(out, 'v2.sqlite'));
    expect(bytes.includes(Buffer.from(secretToken))).toBe(false);
    for (const file of [
      'manifest.json',
      'validation-summary.txt',
      'manual-review.json',
    ]) {
      expect(
        (await readFile(join(out, file), 'utf8')).includes(secretToken)
      ).toBe(false);
    }
    const archive = new Database(join(out, 'legacy-archive.sqlite'), {
      readonly: true,
    });
    const archived = archive
      .prepare(
        "SELECT value, disposition FROM archived_fields WHERE table_name = 'themes' AND source_id = '62' AND column_name = 'mapbox_access_token'"
      )
      .get();
    archive.close();
    expect(archived).toEqual({
      value: secretToken,
      disposition: 'ARCHIVE_RESTRICTED',
    });
  });

  it('imports neither half of an incomplete or invalid style/token pair', () => {
    for (const community of [14, 15]) {
      expect(config(community)).toMatchObject({
        mapbox_style_url: null,
        mapbox_access_token: null,
      });
    }
    expect(warnings('63')).toContain('mapbox_pair_incomplete');
    expect(warnings('64')).toEqual(
      expect.arrayContaining([
        'mapbox_style_url_invalid',
        'mapbox_pair_incomplete',
      ])
    );
  });
});
