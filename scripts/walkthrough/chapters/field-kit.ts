/**
 * Chapter: Kofi, a field-kit operator, sets up a fresh install: the bootstrap
 * screens. On an installation that already has a community the bootstrap is
 * closed, and the chapter shows that.
 */
import { newVerifier, randomPassword } from '../kdf.js';
import { field, guarded, num, str, type Ctx } from '../context.js';
import { dig } from '../walk.js';

export const PERSONA_FIELDKIT = 'Field-kit operator';

export async function fieldKitChapter(
  ctx: Ctx,
  when: 'first' | 'late'
): Promise<void> {
  const { w, s, cfg } = ctx;
  w.chapter(
    PERSONA_FIELDKIT,
    when === 'first'
      ? 'Kofi sets up a fresh install'
      : 'Kofi checks that setup is closed on this install',
    'A field kit runs on a laptop in a community. The first run creates the first community and its admin through the onboarding screens; afterwards setup stays closed.'
  );
  await guarded(ctx, 'field-kit', async () => {
    const kofi = (s.actors.kofi = w.actor('Kofi', 'field-kit operator'));
    const open = await w.step({
      who: kofi,
      say: 'opens the onboarding page: "Begin" is offered only while setup is open',
      method: 'GET',
      path: '/v2/bootstrap',
      expect: 200,
      covers: ['A07'],
      show: (r) => [field('setup open', dig(r, 'open'))],
    });
    if (when === 'first') {
      if (dig(open, 'open') !== true)
        throw new Error(
          '--setup-from-bootstrap needs a fresh install, but setup is closed'
        );
      if (!cfg.bootstrapSecret)
        throw new Error('set WT_BOOTSTRAP_SECRET for --setup-from-bootstrap');
      const slug = `${w.runId}-field`;
      const password = randomPassword();
      w.secret(password);
      const verifier = await newVerifier(password);
      w.secret(verifier.derivedKey);
      const username = `${w.runId}-kofi`;
      const created = await w.step({
        who: kofi,
        say: 'fills the admin account step (name, username, password) and the community step (name, country, locale) and submits',
        method: 'POST',
        path: '/v2/bootstrap',
        json: {
          community: {
            name: `Field kit ${w.runId}`,
            slug,
            locale: 'en',
            country: 'GY',
            visibility: 'public',
          },
          admin: {
            username,
            email: `${w.runId}-kofi@walkthrough.example.test`,
            displayName: `Kofi (${w.runId})`,
            password: verifier,
          },
          bootstrapSecret: cfg.bootstrapSecret,
        },
        expect: 201,
        covers: ['A08', 'A09'],
        show: (r) => {
          const codes = dig(r, 'data', 'recoveryCodes', 'codes');
          if (Array.isArray(codes)) for (const c of codes) w.secret(String(c));
          return [
            field('community', dig(r, 'data', 'community', 'name')),
            field('admin', dig(r, 'data', 'user', 'displayName')),
            field('recovery codes', Array.isArray(codes) ? codes.length : 0) +
              ' shown once',
          ];
        },
      });
      cfg.community = slug;
      cfg.adminIdentifier = username;
      cfg.adminPassword = password;
      void created;
      void num;
      void str;
    } else {
      await w.step({
        who: kofi,
        say: 'tries to run the setup again on this install',
        method: 'POST',
        path: '/v2/bootstrap',
        json: {
          community: { name: `Field kit ${w.runId}`, locale: 'en' },
          admin: {
            username: `${w.runId}-kofi`,
            email: `${w.runId}-kofi@walkthrough.example.test`,
            password: await newVerifier(randomPassword()),
          },
          bootstrapSecret: cfg.bootstrapSecret ?? 'not-the-secret-' + w.runId,
        },
        expect: [403, 404, 409],
        negative: true,
        covers: ['A08', 'A09'],
        show: 'the onboarding page is not offered; a second community cannot be created this way (the first-install path is walked with --setup-from-bootstrap)',
      });
    }
    await w.step({
      who: kofi,
      say: 'setup is closed once a community exists',
      method: 'GET',
      path: '/v2/bootstrap',
      expect: 200,
      covers: ['A07'],
      check: (r) =>
        dig(r, 'open') === false ? undefined : 'setup should be closed now',
      show: (r) => [field('setup open', dig(r, 'open'))],
    });
    w.skip(
      ['V21'],
      'Kofi checks the plain-HTTP LAN warning and the offline map tiles',
      'browser and offline proof is out of scope of the API (D31, #147, #185)',
      'Kofi'
    );
  });
}
