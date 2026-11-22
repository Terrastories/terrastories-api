/**
 * Chapter: closing the day. Ana removes what the walkthrough created and puts
 * back what it changed. Users cannot be deleted (D12), so they are disabled;
 * audit rows stay by design.
 */
import { field, guarded, signIn, type Ctx } from '../context.js';
import { dig } from '../walk.js';

export const PERSONA_CLEANUP = 'Community admin';

const MAP_CONFIG_KEYS = [
  'styleUrl',
  'basemapStyle',
  'mapboxStyleUrl',
  'mapboxAccessToken',
  'exposeMapboxCredentials',
  'mapbox3d',
  'protomapsApiKey',
  'protomapsBasemapStyle',
  'centerLatitude',
  'centerLongitude',
  'southWestLatitude',
  'southWestLongitude',
  'northEastLatitude',
  'northEastLongitude',
  'zoom',
  'pitch',
  'bearing',
  'threeDimensional',
  'projection',
  'staticMapFileId',
];

export async function cleanupChapter(ctx: Ctx): Promise<void> {
  const { w, s, cfg } = ctx;
  w.chapter(
    PERSONA_CLEANUP,
    'Ana tidies up',
    `Ana removes everything prefixed "${w.runId}" and restores the settings she changed. People cannot be deleted (D12): their accounts are disabled. Audit rows stay.`
  );
  if (!s.actors.ana || !cfg.adminIdentifier || !cfg.adminPassword) {
    w.narrate('Ana never signed in, so there is nothing to tidy.');
    return;
  }
  await guarded(ctx, 'cleanup', async () => {
    let ana = s.actors.ana!;
    const alive = await ana.call('GET', '/v2/auth/me');
    if (alive.status !== 200) {
      ana = s.actors.ana = w.actor('Ana', 'community admin');
      await signIn(ctx, ana, cfg.adminIdentifier!, cfg.adminPassword!, { communitySlug: cfg.community });
    }

    // open import previews
    for (const id of s.imports) {
      const manifest = await ana.call('GET', `/v2/imports/${id}`);
      if (manifest.status === 200 && dig(manifest, 'data', 'status') === 'previewed') {
        await w.step({
          who: ana,
          say: `discards the open import preview ${id}`,
          method: 'DELETE',
          path: `/v2/imports/${id}`,
          expect: [200, 204],
          covers: ['C32'],
        });
      }
    }
    // stories, places and speakers by run prefix
    const stories = await ana.call('GET', `/v2/stories?search=${encodeURIComponent(w.runId)}&limit=100`);
    const storyIds = new Set<number>(s.stories);
    for (const row of ((dig(stories, 'data', 'stories') as Array<{ id: number; title: string }>) ?? []))
      if (row.title.startsWith(w.runId)) storyIds.add(row.id);
    for (const id of storyIds)
      await w.step({ who: ana, say: `deletes the story ${id}`, method: 'DELETE', path: `/v2/stories/${id}`, expect: [204, 404] });
    for (const kind of ['speakers', 'places'] as const) {
      const ids = new Set<number>(kind === 'places' ? s.places : s.speakers);
      for (let offset = 0; offset < 1000; offset += 100) {
        const page = await ana.call('GET', `/v2/${kind}?limit=100&offset=${offset}`);
        const rows = (dig(page, 'data') as Array<{ id: number; name: string }>) ?? [];
        for (const row of rows) if (row.name.startsWith(w.runId)) ids.add(row.id);
        if (dig(page, 'meta', 'hasNextPage') !== true) break;
      }
      for (const id of ids)
        await w.step({ who: ana, say: `deletes the ${kind === 'places' ? 'place' : 'speaker'} ${id}`, method: 'DELETE', path: `/v2/${kind}/${id}`, expect: [204, 404] });
    }
    // branding
    for (const key of ['logo2', 'background']) {
      const attachment = s.attachments[key];
      if (attachment)
        await w.step({ who: ana, say: `removes the branding image ${key}`, method: 'DELETE', path: `/v2/attachments/${attachment}`, expect: [204, 404], covers: ['D07'] });
    }
    for (const key of ['logo1', 'logo2', 'background']) {
      const file = s.files[key];
      if (file)
        await w.step({ who: ana, say: `clears the file of ${key} out of storage`, method: 'DELETE', path: `/v2/media/${file}`, expect: [204, 404], covers: ['V18'] });
    }
    // settings
    if (s.snapshot) {
      const stored = s.snapshot.mapConfig;
      const body: Record<string, unknown> = {};
      for (const key of MAP_CONFIG_KEYS) body[key] = stored && key in stored ? stored[key] : key === 'exposeMapboxCredentials' || key === 'mapbox3d' ? false : null;
      delete body.staticMapUrl;
      await w.step({ who: ana, say: 'puts the map settings back as they were', method: 'PUT', path: '/v2/community/map-config', json: body, expect: 200, covers: ['D06'], show: (r) => [field('render source', dig(r, 'render', 'source'))] });
      await w.step({
        who: ana,
        say: 'puts the description and the visibility back',
        method: 'PATCH',
        path: '/v2/community',
        json: { description: s.snapshot.description, visibility: s.snapshot.visibility },
        expect: 200,
        covers: ['D08'],
        show: (r) => [field('visibility', dig(r, 'data', 'visibility'))],
      });
    }
    // people
    for (const acct of Object.values(s.accounts)) {
      if (acct.key === 'lucia' || acct.key === 'labsamir' || !acct.id) continue;
      await w.step({
        who: ana,
        say: `disables ${acct.displayName}`,
        method: 'PATCH',
        path: `/v2/users/${acct.id}`,
        json: { status: 'disabled' },
        expect: 200,
        covers: ['D05'],
      });
    }
    await w.step({ who: ana, say: 'logs out', method: 'POST', path: '/v2/auth/logout', expect: 204, covers: ['B05'] });
    const sam = s.actors.sam;
    if (sam?.jar.signedIn)
      await w.step({ who: sam, say: 'Sam logs out', method: 'POST', path: '/v2/auth/logout', expect: 204, covers: ['B05'] });
    w.narrate(`Left behind on purpose: audit rows, disabled accounts prefixed ${w.runId}, and the erased disposable community's content-free erasure record.`);
  });
}
