/**
 * Chapter: Pia, an anonymous visitor, uses the public surface only.
 */
import { dig } from '../walk.js';
import { field, guarded, val, type Ctx } from '../context.js';

export const PERSONA_ANON = 'Anonymous visitor';

export async function anonymousChapter(ctx: Ctx): Promise<void> {
  const { w, s, cfg } = ctx;
  const slug = cfg.community;
  w.chapter(
    PERSONA_ANON,
    'Pia explores the public map without an account',
    'Pia has no account and no cookie. She can see only public communities and public stories.'
  );
  await guarded(ctx, 'anonymous', async () => {
    const pia = (s.actors.pia = w.actor('Pia', 'anonymous visitor'));
    await w.step({
      who: pia,
      say: 'opens the welcome page: background image, logo and sponsor logos come from the community branding',
      method: 'GET',
      path: `/v2/public/communities/${slug}`,
      expect: 200,
      covers: ['A01', 'A02', 'M01'],
      show: (r) => [
        field('community', val(r, 'data', 'name')),
        field(
          'background image',
          dig(r, 'data', 'branding', 'backgroundImage') ? 'yes' : 'none'
        ),
        field(
          'sponsor logos',
          ((dig(r, 'data', 'branding', 'sponsorLogos') as unknown[]) ?? [])
            .length
        ),
        field('public stories', val(r, 'data', 'storiesCount')),
        field(
          'filter categories',
          ((val(r, 'data', 'categories') as string[]) ?? []).join(', ')
        ),
      ],
    });
    w.skip(
      ['A03'],
      'Pia clicks "Enter Site"',
      'client-side navigation to the map; no API call'
    );
    await w.step({
      who: pia,
      say: 'searches for her community by name on the landing page',
      method: 'GET',
      path: `/v2/public/communities?search=${encodeURIComponent(slug.slice(0, 4))}`,
      expect: 200,
      covers: ['A04'],
      show: (r) => [
        field(
          'communities found',
          ((val(r, 'data') as unknown[]) ?? []).length
        ),
        '"Start Exploring" links out to explore.terrastories.app',
      ],
    });
    await w.step({
      who: pia,
      say: 'lists all public communities',
      method: 'GET',
      path: '/v2/public/communities',
      expect: 200,
      covers: ['A04'],
    });
    const list = await w.step({
      who: pia,
      say: 'the map loads public stories and markers',
      method: 'GET',
      path: `/v2/public/communities/${slug}/stories?limit=50`,
      expect: 200,
      covers: ['M01', 'M06'],
      show: (r) => [
        field('story cards', dig(r, 'meta', 'total')),
        field(
          'map markers',
          ((dig(r, 'data', 'points') as unknown[]) ?? []).length
        ),
      ],
    });
    void list;
    await w.step({
      who: pia,
      say: 'filters by region and speaker community',
      method: 'GET',
      path: `/v2/public/communities/${slug}/stories?region=North&place=${s.ids.place}&affiliation=${encodeURIComponent('Upriver village')}`,
      expect: 200,
      covers: ['M05'],
      show: (r) => [field('stories after filter', dig(r, 'meta', 'total'))],
    });
    await w.step({
      who: pia,
      say: 'sorts A-Z and Z-A',
      method: 'GET',
      path: `/v2/public/communities/${slug}/stories?sort=title_asc`,
      expect: 200,
      covers: ['M06'],
    });
    await w.step({
      who: pia,
      say: 'clicks the place marker',
      method: 'GET',
      path: `/v2/public/communities/${slug}/places/${s.ids.place}`,
      expect: 200,
      covers: ['M04'],
      show: (r) => [
        field('place', val(r, 'data', 'name')),
        field('type', val(r, 'data', 'typeOfPlace')),
      ],
    });
    const story = await w.step({
      who: pia,
      say: 'opens the public story card',
      method: 'GET',
      path: `/v2/public/communities/${slug}/stories/${s.ids.story}`,
      expect: 200,
      covers: ['M07', 'M08'],
      show: (r) => [
        field('title', val(r, 'data', 'title')),
        field(
          'speakers',
          ((val(r, 'data', 'speakers') as Array<{ name: string }>) ?? [])
            .map((x) => x.name)
            .join(', ')
        ),
        field(
          'media items',
          ((val(r, 'data', 'attachments') as unknown[]) ?? []).length
        ),
        field(
          'external links',
          ((val(r, 'data', 'externalMediaLinks') as unknown[]) ?? []).length
        ),
      ],
    });
    const media = ((dig(story, 'data', 'attachments') as Array<{
      url?: string;
      id?: number;
      fileId?: string;
    }>) ?? [])[0];
    if (media?.url) {
      await w.step({
        who: pia,
        say: 'plays the media; the browser asks for the first bytes',
        method: 'GET',
        path: media.url,
        headers: { range: 'bytes=0-7' },
        expect: [200, 206],
        covers: ['M09'],
        show: (r) => [
          field('status', r.status),
          field('content type', r.headers.get('content-type')),
        ],
      });
    }
    await w.step({
      who: pia,
      say: 'opens the speakers list and one speaker',
      method: 'GET',
      path: `/v2/public/communities/${slug}/speakers`,
      expect: 200,
      covers: ['B13'],
    });
    await w.step({
      who: pia,
      say: 'opens the public places list',
      method: 'GET',
      path: `/v2/public/communities/${slug}/places`,
      expect: 200,
      covers: ['B11'],
    });
    w.skip(
      ['M03'],
      'Pia clicks a cluster to zoom in',
      'cluster expansion is client-side; the marker data came from the story list above'
    );
    w.skip(['M10'], 'Pia closes the story tray', 'client-side card chrome');
    w.skip(
      ['M11'],
      'Pia closes the "What\'s a terrastory?" intro',
      'client-side popup'
    );
    w.skip(
      ['A02'],
      'Pia switches the language',
      'client-only i18n; the URL prefix is /<locale>/c/<slug>'
    );

    // refusals
    await w.step({
      who: pia,
      say: 'follows a link to the editors-only draft through the public route',
      method: 'GET',
      path: `/v2/public/communities/${slug}/stories/${s.ids.draft}`,
      expect: 404,
      negative: true,
      covers: ['M07'],
      show: 'the page says "not found"',
    });
    await w.step({
      who: pia,
      say: 'tries the signed-in story list without logging in',
      method: 'GET',
      path: '/v2/stories',
      expect: 401,
      negative: true,
      covers: ['A06'],
      show: 'the app shows the login page',
    });
    await w.step({
      who: pia,
      say: 'asks for a community that does not exist',
      method: 'GET',
      path: `/v2/public/communities/${w.runId}-nowhere`,
      expect: 404,
      negative: true,
      covers: ['A01'],
    });
    await w.step({
      who: pia,
      say: 'tries to log in with a name nobody has and a made-up key; the answer is the same as for a wrong password',
      method: 'POST',
      path: '/v2/auth/prelogin',
      json: { identifier: `${w.runId}-nobody` },
      noCookie: true,
      expect: 200,
      covers: ['A05'],
      show: 'prelogin answers with a believable salt, so nobody can tell whether an account exists',
    });
    await w.step({
      who: pia,
      say: 'the make-believe login is refused',
      method: 'POST',
      path: '/v2/auth/login',
      json: { identifier: `${w.runId}-nobody`, derivedKey: 'a'.repeat(64) },
      noCookie: true,
      expect: 401,
      negative: true,
      covers: ['A06'],
    });
    await w.step({
      who: pia,
      say: 'health and readiness probes (what an uptime monitor calls)',
      method: 'GET',
      path: '/health',
      expect: 200,
      covers: ['V20'],
    });
    await w.step({
      who: pia,
      say: 'the readiness probe',
      method: 'GET',
      path: '/ready',
      expect: 200,
      covers: ['V20'],
    });
    w.skip(
      ['V20'],
      'a user asks for a password-reset email',
      'optional adapter, not in launch scope; use a login code or recovery codes instead'
    );
  });
}
