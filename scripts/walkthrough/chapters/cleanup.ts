/**
 * Chapter: closing the day. Ana removes what the walkthrough created in the
 * play community and puts back what she changed (settings first); Sam then
 * disables the play and lab communities. Users cannot be deleted (D12), so
 * they are disabled; audit rows stay by design. Every task is its own
 * try/catch: one failure never stops the rest. Safe to call from a signal
 * handler (it runs at most once).
 */
import { attempt, field, listAll, signIn, type Ctx } from '../context.js';
import { dig } from '../walk.js';

const SECRET_KEYS = new Set(['mapboxAccessToken', 'protomapsApiKey']);

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
  if (s.cleanedUp) return;
  s.cleanedUp = true;
  w.chapter(
    PERSONA_CLEANUP,
    'Ana and Sam tidy up',
    `Ana restores the play community settings and removes everything prefixed "${w.runId}"; Sam then disables the play and lab communities. People cannot be deleted (D12): their accounts are disabled. Audit rows stay. The real community is not part of this chapter.`
  );
  const play = s.play;
  if (play && s.actors.ana && play.adminPassword) {
    let ana = s.actors.ana;
    await attempt(ctx, 'Ana session', async () => {
      const alive = await ana.call('GET', '/v2/auth/me');
      if (alive.status !== 200) {
        ana = s.actors.ana = w.actor('Ana', 'community admin');
        await signIn(ctx, ana, play.adminIdentifier, play.adminPassword, {
          communitySlug: play.slug,
        });
      }
    });

    // 1. settings first, so a later failure cannot leave them changed
    if (s.snapshot) {
      const snap = s.snapshot;
      if (!snap.mapConfig)
        w.narrate(
          'The play community had no map configuration at the start and the API has no endpoint to remove one, so it is not "restored" with a blank row; the play community is disabled below.'
        );
      else
        await attempt(ctx, 'restore map settings', async () => {
          const stored = snap.mapConfig;
          const body: Record<string, unknown> = {};
          for (const key of MAP_CONFIG_KEYS) {
            const value = stored && key in stored ? stored[key] : undefined;
            // a stored secret is masked in the admin read: it cannot be sent back
            if (SECRET_KEYS.has(key) && typeof value === 'string') continue;
            body[key] =
              value !== undefined
                ? value
                : key === 'exposeMapboxCredentials' || key === 'mapbox3d'
                  ? false
                  : null;
          }
          await w.step({
            who: ana,
            say: 'puts the map settings back as they were',
            method: 'PUT',
            path: '/v2/community/map-config',
            json: body,
            expect: 200,
            covers: ['D06'],
            show: (r) => [field('render source', dig(r, 'render', 'source'))],
          });
        });
      await attempt(ctx, 'restore community settings', async () => {
        await w.step({
          who: ana,
          say: 'puts the description and the visibility back',
          method: 'PATCH',
          path: '/v2/community',
          json: { description: snap.description, visibility: snap.visibility },
          expect: 200,
          covers: ['D08'],
          show: (r) => [field('visibility', dig(r, 'data', 'visibility'))],
        });
      });
    }

    // 2. open import previews
    for (const id of s.imports)
      await attempt(ctx, `import preview ${id}`, async () => {
        const manifest = await ana.call('GET', `/v2/imports/${id}`);
        if (
          manifest.status === 200 &&
          dig(manifest, 'data', 'status') === 'previewed'
        )
          await w.step({
            who: ana,
            say: `discards the open import preview ${id}`,
            method: 'DELETE',
            path: `/v2/imports/${id}`,
            expect: [200, 204],
            covers: ['C32'],
          });
      });

    // 3. stories, places and speakers by run prefix
    const storyIds = new Set<number>(s.stories);
    await attempt(ctx, 'find stories', async () => {
      const rows = await listAll(
        ana,
        `/v2/stories?search=${encodeURIComponent(w.runId)}`,
        (r) =>
          (dig(r, 'data', 'stories') as Array<{ id: number; title: string }>) ??
          []
      );
      for (const row of rows)
        if (row.title.startsWith(w.runId)) storyIds.add(row.id);
    });
    for (const id of storyIds)
      await attempt(ctx, `story ${id}`, async () => {
        await w.step({
          who: ana,
          say: `deletes the story ${id}`,
          method: 'DELETE',
          path: `/v2/stories/${id}`,
          expect: [204, 404],
        });
      });
    for (const kind of ['speakers', 'places'] as const) {
      const ids = new Set<number>(kind === 'places' ? s.places : s.speakers);
      await attempt(ctx, `find ${kind}`, async () => {
        const rows = await listAll(
          ana,
          `/v2/${kind}`,
          (r) => (dig(r, 'data') as Array<{ id: number; name: string }>) ?? []
        );
        for (const row of rows)
          if (row.name.startsWith(w.runId)) ids.add(row.id);
      });
      for (const id of ids)
        await attempt(ctx, `${kind} ${id}`, async () => {
          await w.step({
            who: ana,
            say: `deletes the ${kind === 'places' ? 'place' : 'speaker'} ${id}`,
            method: 'DELETE',
            path: `/v2/${kind}/${id}`,
            expect: [204, 404],
          });
        });
    }

    // 4. branding: remove every attachment the run added, then the files
    for (const key of ['logo1', 'logo2', 'background']) {
      const attachment = s.attachments[key];
      if (attachment)
        await attempt(ctx, `branding image ${key}`, async () => {
          await w.step({
            who: ana,
            say: `removes the branding image ${key}`,
            method: 'DELETE',
            path: `/v2/attachments/${attachment}`,
            expect: [204, 404],
            covers: ['D07'],
          });
        });
    }
    // every uploaded file the run made (also a stray one left by a failed step)
    for (const file of new Set(s.uploaded))
      await attempt(ctx, `file ${file}`, async () => {
        await w.step({
          who: ana,
          say: `clears the uploaded file ${file} out of storage`,
          method: 'DELETE',
          path: `/v2/media/${file}`,
          expect: [204, 404],
        });
      });

    // 5. people
    for (const acct of Object.values(s.accounts)) {
      if (acct.key === 'lucia' || acct.key === 'labsamir' || !acct.id) continue;
      await attempt(ctx, `disable ${acct.key}`, async () => {
        await w.step({
          who: ana,
          say: `disables ${acct.displayName}`,
          method: 'PATCH',
          path: `/v2/users/${acct.id}`,
          json: { status: 'disabled' },
          expect: 200,
          covers: ['D05'],
        });
      });
    }
    await attempt(ctx, 'Ana logout', async () => {
      await w.step({
        who: ana,
        say: 'logs out',
        method: 'POST',
        path: '/v2/auth/logout',
        expect: 204,
        covers: ['B05'],
      });
    });
  } else if (!play) {
    w.narrate('No play community was created, so there is nothing to tidy.');
  }

  // 6. Sam disables the play and lab communities (they are never left active)
  const targets: Array<{ id: number; slug: string }> = [];
  // every community the run created (play, lab, the unclaimed one), by registry
  for (const known of s.communities) targets.push(known);
  if (play?.id !== undefined && !targets.some((t) => t.id === play.id))
    targets.push({ id: play.id, slug: play.slug });
  if (s.lab && !targets.some((t) => t.id === s.lab!.id))
    targets.push({ id: s.lab.id, slug: s.lab.slug });
  if (targets.length) {
    if (!cfg.superIdentifier || !cfg.superPassword) {
      w.narrate(
        'No super admin credentials: the communities cannot be disabled.'
      );
    } else {
      let sam = s.actors.sam;
      await attempt(ctx, 'Sam session', async () => {
        if (!sam || (await sam.call('GET', '/v2/auth/me')).status !== 200) {
          sam = s.actors.sam = w.actor('Sam', 'super admin');
          await signIn(ctx, sam, cfg.superIdentifier!, cfg.superPassword!);
        }
      });
      for (const c of targets)
        await attempt(ctx, `disable ${c.slug}`, async () => {
          if (!c.slug.startsWith(w.runId) || c.slug === cfg.community)
            throw new Error(
              'refusing to disable a community this run did not create'
            );
          await w.step({
            who: sam!,
            say: `disables the disposable community "${c.slug}" (sessions end; nothing is left active)`,
            method: 'PATCH',
            path: `/v2/admin/communities/${c.id}/status`,
            json: { status: 'disabled' },
            // an erased or withdrawn community may already be closed
            expect: [200, 404, 409],
            covers: ['S06'],
          });
        });
      await attempt(ctx, 'Sam logout', async () => {
        if (sam?.jar.signedIn)
          await w.step({
            who: sam,
            say: 'Sam logs out',
            method: 'POST',
            path: '/v2/auth/logout',
            expect: 204,
            covers: ['B05'],
          });
      });
    }
  }
  w.narrate(
    `Left behind on purpose: audit rows, disabled accounts prefixed ${w.runId}, and the disabled disposable communities${s.lab ? ' (with the content-free erasure record when the lab was erased)' : ''}. The real community "${cfg.community}" was only read.`
  );
}
