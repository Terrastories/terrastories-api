/**
 * Chapter: a read-only check of the real (migrated) community. Nothing here
 * writes: no recovery codes, steward, visibility, settings or passwords are
 * touched. The one exception is opt-in: with --login-real-admin the real
 * admin signs in, and a successful login of a migrated bcrypt account upgrades
 * the stored password verifier to Argon2id (expected product behaviour).
 */
import { field, guarded, signIn, val, type Ctx } from '../context.js';
import { dig } from '../walk.js';

export const PERSONA_TARGET = 'Migrated community check';

export async function targetCheckChapter(ctx: Ctx): Promise<void> {
  const { w, s, cfg } = ctx;
  const slug = cfg.community;
  w.chapter(
    PERSONA_TARGET,
    `Read-only check of the real community "${slug}"`,
    'This chapter only reads. It proves that a migrated community still serves its community record, stories, places, speakers, media and map settings, and records the counts. Every step that changes something runs in the disposable play community instead.'
  );
  await guarded(ctx, 'target-check', async () => {
    const visitor = w.actor('Observer', 'anonymous visitor');
    const detail = await w.step({
      who: visitor,
      say: 'opens the public community page',
      method: 'GET',
      path: `/v2/public/communities/${slug}`,
      expect: [200, 404],
      show: (r) =>
        r.status === 200
          ? [
              field('community', val(r, 'data', 'name')),
              field('public stories', val(r, 'data', 'storiesCount')),
              field(
                'map settings present',
                dig(r, 'data', 'mapConfig') === undefined ? 'no' : 'yes'
              ),
            ]
          : 'the community is private or disabled: anonymous visitors see "not found" (expected for a private community)',
    });
    if (detail.status === 200) {
      s.targetCounts.publicStories = Number(
        val(detail, 'data', 'storiesCount') ?? 0
      );
      const stories = await w.step({
        who: visitor,
        say: 'the map loads the public stories and markers',
        method: 'GET',
        path: `/v2/public/communities/${slug}/stories?limit=20`,
        expect: 200,
        show: (r) => [
          field('story cards', dig(r, 'meta', 'total')),
          field(
            'map markers',
            ((dig(r, 'data', 'points') as unknown[]) ?? []).length
          ),
        ],
      });
      s.targetCounts.publicStoryCards = Number(
        dig(stories, 'meta', 'total') ?? 0
      );
      for (const kind of ['places', 'speakers'] as const) {
        const list = await w.step({
          who: visitor,
          say: `opens the public ${kind} list`,
          method: 'GET',
          path: `/v2/public/communities/${slug}/${kind}`,
          expect: 200,
          show: (r) => [
            field(
              kind,
              dig(r, 'meta', 'total') ??
                ((val(r, 'data') as unknown[]) ?? []).length
            ),
          ],
        });
        s.targetCounts[`public_${kind}`] = Number(
          dig(list, 'meta', 'total') ??
            ((val(list, 'data') as unknown[]) ?? []).length
        );
      }
      const firstStory = ((dig(stories, 'data', 'stories') as Array<{
        id: number;
      }>) ?? [])[0];
      if (firstStory) {
        const story = await w.step({
          who: visitor,
          say: 'opens the first public story',
          method: 'GET',
          path: `/v2/public/communities/${slug}/stories/${firstStory.id}`,
          expect: 200,
          show: (r) => [field('title', val(r, 'data', 'title'))],
        });
        const media = (
          (dig(story, 'data', 'attachments') as Array<{ url?: string }>) ?? []
        ).find((a) => a.url);
        if (media?.url)
          await w.step({
            who: visitor,
            say: 'plays its media (first bytes only)',
            method: 'GET',
            path: media.url,
            headers: { range: 'bytes=0-7' },
            expect: [200, 206],
            show: (r) => [field('content type', r.headers.get('content-type'))],
          });
        else w.narrate('The first public story has no media to serve.');
      } else {
        w.narrate('The community has no public story to open.');
      }
    }

    if (!cfg.loginRealAdmin) {
      w.narrate(
        cfg.adminIdentifier
          ? 'Real admin credentials were supplied but not used: pass --login-real-admin to sign in as the real admin. A successful login of a migrated bcrypt account upgrades the stored password verifier to Argon2id.'
          : 'No real admin signed in (pass --admin-credentials-env and --login-real-admin to check the admin side).'
      );
      return;
    }
    if (!cfg.adminIdentifier || !cfg.adminPassword)
      throw new Error(
        '--login-real-admin needs the real admin credentials (--admin-credentials-env)'
      );
    const admin = w.actor('Real admin', 'community admin');
    const { upgraded } = await signIn(
      ctx,
      admin,
      cfg.adminIdentifier,
      cfg.adminPassword,
      { communitySlug: slug }
    );
    w.narrate(
      upgraded
        ? 'This was a migrated Rails password: the login upgraded the stored verifier to Argon2id (expected product behaviour).'
        : 'This account already used Argon2id.'
    );
    const me = await w.step({
      who: admin,
      say: 'the dashboard reads the admin profile',
      method: 'GET',
      path: '/v2/auth/me',
      expect: 200,
      show: (r) => [
        field('role', val(r, 'user', 'role')),
        field('recovery codes saved', val(r, 'user', 'recoveryCodesConfirmed')),
      ],
    });
    if (val(me, 'user', 'recoveryCodesConfirmed') === true) {
      await w.step({
        who: admin,
        say: 'opens the community record',
        method: 'GET',
        path: '/v2/community',
        expect: 200,
        show: (r) => [
          field('visibility', val(r, 'data', 'visibility')),
          field('stories', val(r, 'data', 'storiesCount')),
        ],
      });
      await w.step({
        who: admin,
        say: 'reads the map settings and the renderer block',
        method: 'GET',
        path: '/v2/community/map-config',
        expect: 200,
        check: (r) =>
          dig(r, 'render', 'source') === undefined
            ? 'the map-config answer has no render block'
            : undefined,
        show: (r) => [field('render source', dig(r, 'render', 'source'))],
      });
      for (const kind of ['stories', 'places', 'speakers']) {
        const list = await w.step({
          who: admin,
          say: `counts the ${kind} the admin can read`,
          method: 'GET',
          path: `/v2/${kind}?limit=1`,
          expect: 200,
          show: (r) => [field(kind, dig(r, 'meta', 'total'))],
        });
        s.targetCounts[`admin_${kind}`] = Number(
          dig(list, 'meta', 'total') ?? 0
        );
      }
    } else {
      w.narrate(
        'The real admin has not saved recovery codes, so the API gates every screen. The walkthrough does not generate recovery codes for a real account.'
      );
    }
    await w.step({
      who: admin,
      say: 'logs out',
      method: 'POST',
      path: '/v2/auth/logout',
      expect: 204,
    });
  });
  if (Object.keys(s.targetCounts).length)
    w.narrate(`Counts read: ${JSON.stringify(s.targetCounts)}`);
}
