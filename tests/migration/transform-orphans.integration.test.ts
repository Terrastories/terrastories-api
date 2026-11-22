import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  captureRailsToBundle,
  type RailsCaptureManifest,
} from '../../src/migration/rails/capture.js';
import { transformRailsBundle } from '../../src/migration/v2/transform.js';
import {
  fixtureDir,
  loadFixtureSql,
  withIsolatedRailsDatabase,
} from './pg-test-helper.js';

const sourceUrl = process.env.RAILS_MIGRATION_TEST_DATABASE_URL;
const describeWithPostgres = sourceUrl ? describe : describe.skip;

describeWithPostgres('Stage-2 orphan rows and media attribution', () => {
  let workDir: string;
  let fullBundle: string;
  let scopedBundle: string;
  let counter = 0;

  const run = (
    bundleDir: string,
    options: { communities?: string[]; allowManual?: boolean }
  ) =>
    transformRailsBundle({
      bundleDir,
      outputDir: join(workDir, 'out-' + counter++),
      allowManual: true,
      ...options,
    });
  const codes = (manual: Array<{ table: string; id: string; code: string }>) =>
    Object.fromEntries(manual.map((m) => [m.table + '#' + m.id, m.code]));

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'rails-orphans-'));
    fullBundle = join(workDir, 'full');
    scopedBundle = join(workDir, 'scoped');
    await withIsolatedRailsDatabase(sourceUrl!, async (dbUrl, pool) => {
      await loadFixtureSql(pool, '2024');
      await pool.query(
        await readFile(join(fixtureDir, 'orphan-data.sql'), 'utf8')
      );
      await captureRailsToBundle({
        sourceUrl: dbUrl,
        outputDir: fullBundle,
        blobRoot: join(fixtureDir, 'blobs'),
      });
      await captureRailsToBundle({
        sourceUrl: dbUrl,
        outputDir: scopedBundle,
        blobRoot: join(fixtureDir, 'blobs'),
        communities: ['rio_verde'],
      });
    });
  }, 120_000);

  it('full run: every orphan is MANUAL with a specific code', async () => {
    const { manual } = await run(fullBundle, {});
    const byId = codes(manual);
    for (const table of ['places_stories', 'speaker_stories']) {
      expect(byId[table + '#90']).toBe('story_missing');
      expect(byId[table + '#92']).toBe('orphan_edge');
      expect(byId[table + '#93']).toBe('story_missing');
    }
    expect(byId['places_stories#91']).toBe('place_missing');
    expect(byId['speaker_stories#91']).toBe('speaker_missing');
    expect(byId['media#72']).toBe('media_story_missing');
    expect(byId['media#73']).toBe('media_story_missing');
    expect(byId['active_storage_attachments#120']).toBe(
      'attachment_unattributable'
    );
    expect(byId['active_storage_attachments#121']).toBe(
      'attachment_unattributable'
    );
    await expect(
      transformRailsBundle({
        bundleDir: fullBundle,
        outputDir: join(workDir, 'out-' + counter++),
      })
    ).rejects.toThrow(/speaker_stories#91 speaker_missing/);
  });

  it('scoped run: orphans are MANUAL only when the surviving endpoint is selected', async () => {
    const result = await run(fullBundle, { communities: ['rio_verde'] });
    const byId = codes(result.manual);
    for (const table of ['places_stories', 'speaker_stories']) {
      expect(byId[table + '#90']).toBe('story_missing'); // survivor in community 10
      expect(byId[table + '#92']).toBeUndefined(); // both endpoints missing
      expect(byId[table + '#93']).toBeUndefined(); // survivor in community 11
    }
    expect(byId['places_stories#91']).toBe('place_missing');
    expect(byId['speaker_stories#91']).toBe('speaker_missing');
    expect(result.dispositions.speaker_stories).toMatchObject({
      not_selected: 3,
      manual: 2,
    });
    for (const id of [
      'media#72',
      'media#73',
      'active_storage_attachments#120',
      'active_storage_attachments#121',
    ]) {
      expect(byId[id], id).toBeUndefined();
    }

    const other = await run(fullBundle, { communities: ['sierra_alta'] });
    expect(codes(other.manual)['speaker_stories#93']).toBe('story_missing');
    expect(codes(other.manual)['speaker_stories#90']).toBeUndefined();
  });

  it('scoped run: pending media is limited to rows reachable from selected communities and reconciles with Stage 1', async () => {
    const result = await run(scopedBundle, { communities: ['rio_verde'] });
    const stage1 = JSON.parse(
      await readFile(join(scopedBundle, 'manifest.json'), 'utf8')
    ) as RailsCaptureManifest;
    const { blobs, attachments } = result.pendingMedia;
    expect(blobs.filter((b) => b.status === 'pending_media_slice').length).toBe(
      stage1.totals.blobsSelected
    );
    expect(blobs.filter((b) => b.status === 'not_selected').length).toBe(
      stage1.totals.blobsNotSelected
    );
    const pending = attachments.filter(
      (a) => a.status === 'pending_media_slice'
    );
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.every((a) => a.communityId === 10)).toBe(true);
    // Every pending attachment points at a blob Stage 1 actually captured.
    const captured = new Set(
      blobs.filter((b) => b.status === 'pending_media_slice').map((b) => b.id)
    );
    expect(pending.every((a) => captured.has(a.blobId))).toBe(true);
    // media: one row owned by community 10; community 11's and both orphans are not_selected
    expect(result.dispositions.media).toMatchObject({
      pending_media_slice: 1,
      not_selected: 3,
      manual: 0,
    });
    expect(result.dispositions.active_storage_attachments.manual).toBe(0);
    const total = (t: string) =>
      Object.values(result.dispositions[t]!).reduce((a, b) => a + b, 0);
    expect(total('media')).toBe(result.sourceCounts.media);
  });
});
