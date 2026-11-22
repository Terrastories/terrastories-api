/**
 * Chapter: Sam, the super admin, runs the hosted installation: provisions
 * communities, issues claim tokens, reads the system audit. Sam never reads
 * community content. The disposable community made here ("lab") is the only
 * place where withdrawal and erasure are ever walked.
 */
import { newVerifier, randomPassword } from '../kdf.js';
import {
  field,
  guarded,
  num,
  signIn,
  str,
  val,
  offsetOfMatch,
  registerCommunity,
  type Ctx,
} from '../context.js';
import { dig } from '../walk.js';

export const PERSONA_SUPER = 'Super admin';

/** Sam signs in once; later chapters reuse the session. */
async function samSession(ctx: Ctx) {
  const { w, s, cfg } = ctx;
  const sam = (s.actors.sam ??= w.actor('Sam', 'super admin'));
  if (!sam.jar.signedIn)
    await signIn(ctx, sam, cfg.superIdentifier!, cfg.superPassword!);
  return sam;
}

/**
 * Sam creates and claims the disposable "play" community. Every mutating
 * chapter runs there, with a script-created admin ("Ana"); the real
 * community is never written to.
 */
export async function provisionPlay(ctx: Ctx): Promise<void> {
  const { w, s } = ctx;
  w.chapter(
    PERSONA_SUPER,
    'Sam prepares a disposable play community',
    'The walkthrough never writes to the real community. Sam creates "' +
      w.runId +
      '-play", issues a claim token, and the future admin (Ana) claims it. Everything else runs there; it is disabled at the end.'
  );
  await guarded(ctx, 'play-provisioning', async () => {
    const sam = await samSession(ctx);
    const slug = `${w.runId}-play`;
    const made = await w.step({
      who: sam,
      say: `creates the play community "${slug}" (empty, unclaimed)`,
      method: 'POST',
      path: '/v2/admin/communities',
      json: { slug },
      expect: 201,
      covers: ['S03', 'V15'],
      show: (r) => [
        field('slug', dig(r, 'data', 'slug')),
        field('claim status', dig(r, 'data', 'claimStatus')),
      ],
    });
    const id = num(made, 'data', 'id');
    registerCommunity(ctx, id, slug);
    // recorded at once so cleanup disables it even if a later step fails
    s.play = {
      slug,
      id,
      adminIdentifier: `${w.runId}-ana`,
      adminPassword: '',
      source: 'provisioned',
    };
    const token = await w.step({
      who: sam,
      say: 'issues a one-time claim token for the play community admin',
      method: 'POST',
      path: `/v2/admin/communities/${id}/claim-tokens`,
      json: { ttlSeconds: 3600 },
      expect: 201,
      covers: ['S03', 'V15'],
      show: (r) => {
        w.secret(String(dig(r, 'data', 'token') ?? ''));
        return ['a token box with copy button (value hidden here)'];
      },
    });
    const ana = (s.actors.ana = w.actor('Ana', 'community admin'));
    const password = randomPassword();
    w.secret(password);
    const verifier = await newVerifier(password);
    w.secret(verifier.derivedKey);
    const claim = await w.step({
      who: ana,
      say: 'Ana opens the claim page, pastes the token, and chooses her identity and password',
      method: 'POST',
      path: '/v2/bootstrap/claim',
      json: {
        token: str(token, 'data', 'token'),
        username: s.play.adminIdentifier,
        email: `${w.runId}-ana@walkthrough.example.test`,
        displayName: `Ana (${w.runId})`,
        password: verifier,
      },
      expect: [200, 201],
      covers: ['V15', 'S03'],
      show: (r) => {
        const codes = dig(r, 'data', 'recoveryCodes', 'codes');
        if (Array.isArray(codes)) for (const c of codes) w.secret(String(c));
        return [
          field('admin', dig(r, 'data', 'user', 'displayName')),
          'recovery codes are shown once',
        ];
      },
    });
    s.play.adminPassword = password;
    void claim;
  });
}

export async function superAdminChapter(ctx: Ctx): Promise<void> {
  const { w, s, cfg } = ctx;
  w.chapter(
    PERSONA_SUPER,
    'Sam runs the installation',
    'Sam is the super admin of the hosted installation. He sees operational records only: never stories, places or speakers. Everything he creates is prefixed with the run id.'
  );
  await guarded(ctx, 'super-admin', async () => {
    const sam = await samSession(ctx);
    await w.step({
      who: sam,
      say: 'opens the dashboard; the sidebar shows Communities only',
      method: 'GET',
      path: '/v2/auth/me',
      expect: 200,
      covers: ['B01', 'S08'],
      check: (r) =>
        val(r, 'user', 'role') === 'super_admin'
          ? undefined
          : 'not a super admin',
      show: (r) => [
        field('Hello', val(r, 'user', 'displayName')),
        field('role badge', val(r, 'user', 'role')),
      ],
    });
    w.skip(
      ['S01'],
      'Sam looks for the Metrics page',
      'skipped by decision D14: counts of content are not a super admin matter',
      'Sam'
    );
    w.skip(
      ['S07'],
      'Sam looks for the Features page',
      'skipped by decision D15: feature flags are dropped',
      'Sam'
    );
    await w.step({
      who: sam,
      say: 'opens the Communities list',
      method: 'GET',
      path: '/v2/admin/communities?limit=10&offset=0',
      expect: 200,
      covers: ['S02', 'S04'],
      check: (r) =>
        /description|name"/.test(JSON.stringify(dig(r, 'data') ?? []))
          ? 'the list carries descriptive fields'
          : undefined,
      show: (r) => [
        field('communities', dig(r, 'meta', 'total')),
        ...(
          (dig(r, 'data') as Array<{
            slug: string;
            status: string;
            claimStatus: string;
          }>) ?? []
        )
          .slice(0, 3)
          .map((c) => `row: ${c.slug} - ${c.status} - ${c.claimStatus}`),
        'operational fields only: slug, status, claim status, dates (no counts, no flags, D14/D15)',
      ],
    });
    await w.step({
      who: sam,
      say: 'filters the list to active communities',
      method: 'GET',
      path: '/v2/admin/communities?status=active&limit=5',
      expect: 200,
      covers: ['S02'],
    });
    w.skip(
      ['S05'],
      'Sam looks for "Edit community"',
      'skipped by decision D16: super admin cannot edit community content or settings (the API refusal is shown below)',
      'Sam'
    );

    // ---- the disposable community -------------------------------------
    const slug = `${w.runId}-lab`;
    const lab = await w.step({
      who: sam,
      say: `creates a disposable community "${slug}" (empty, unclaimed)`,
      method: 'POST',
      path: '/v2/admin/communities',
      json: { slug },
      expect: 201,
      covers: ['S03', 'V15'],
      show: (r) => [
        field('slug', dig(r, 'data', 'slug')),
        field('claim status', dig(r, 'data', 'claimStatus')),
      ],
    });
    const labId = num(lab, 'data', 'id');
    registerCommunity(ctx, labId, slug);
    s.lab = { id: labId, slug, name: slug };
    const token = await w.step({
      who: sam,
      say: 'issues a one-time claim token for the first admin (shown once, valid at most 72 hours)',
      method: 'POST',
      path: `/v2/admin/communities/${labId}/claim-tokens`,
      json: { ttlSeconds: 3600 },
      expect: 201,
      covers: ['S03', 'V15'],
      show: (r) => {
        w.secret(String(dig(r, 'data', 'token') ?? ''));
        return [
          'a token box with copy button (value hidden here)',
          field('expires', dig(r, 'data', 'expiresAt')),
        ];
      },
    });
    const claimToken = str(token, 'data', 'token');
    const lucia = (s.actors.lucia = w.actor('Lucia', 'community admin'));
    const luciaPassword = randomPassword();
    w.secret(luciaPassword);
    const verifier = await newVerifier(luciaPassword);
    w.secret(verifier.derivedKey);
    const email = `${w.runId}-lucia@walkthrough.example.test`;
    const claim = await w.step({
      who: lucia,
      say: 'Lucia, the future admin, opens the claim page, pastes the token, and chooses her identity and password',
      method: 'POST',
      path: '/v2/bootstrap/claim',
      json: {
        token: claimToken,
        username: `${w.runId}-lucia`,
        email,
        displayName: `Lucia (${w.runId})`,
        password: verifier,
      },
      expect: [200, 201],
      covers: ['V15', 'S03'],
      show: (r) => {
        const codes = dig(r, 'data', 'recoveryCodes', 'codes');
        if (Array.isArray(codes)) for (const c of codes) w.secret(String(c));
        return [
          field('admin', dig(r, 'data', 'user', 'displayName')),
          field('recovery codes', Array.isArray(codes) ? codes.length : 0) +
            ' shown once, then the "save your codes" screen',
        ];
      },
    });
    s.accounts.lucia = {
      key: 'lucia',
      displayName: `Lucia (${w.runId})`,
      username: `${w.runId}-lucia`,
      email,
      role: 'admin',
      id: num(claim, 'data', 'user', 'id'),
      password: luciaPassword,
    };
    const luciaId = num(claim, 'data', 'user', 'id');
    void luciaId;
    await w.step({
      who: lucia,
      say: 'tries to use the same claim token again',
      method: 'POST',
      path: '/v2/bootstrap/claim',
      json: {
        token: claimToken,
        username: `${w.runId}-lucia2`,
        email: `${w.runId}-lucia2@walkthrough.example.test`,
        password: await newVerifier(randomPassword()),
      },
      noCookie: true,
      expect: [400, 401, 403, 404, 409],
      negative: true,
      covers: ['V15'],
      show: 'the claim page says the token is not valid',
    });
    type Row = { slug: string; claimStatus: string };
    const claimedAt = await offsetOfMatch(
      sam,
      '/v2/admin/communities',
      (r) => (dig(r, 'data') as Row[]) ?? [],
      (c) => c.slug === slug
    );
    await w.step({
      who: sam,
      say: 'sees the community as claimed',
      method: 'GET',
      path: `/v2/admin/communities?limit=100&offset=${claimedAt}`,
      expect: 200,
      covers: ['S04'],
      check: (r) => {
        const row = (
          (dig(r, 'data') as Array<{ slug: string; claimStatus: string }>) ?? []
        ).find((c) => c.slug === slug);
        return row?.claimStatus === 'claimed'
          ? undefined
          : 'expected claimStatus claimed';
      },
    });

    // ---- a second community that is deprovisioned ---------------------
    const goneSlug = `${w.runId}-gone`;
    const gone = await w.step({
      who: sam,
      say: `creates a second disposable community "${goneSlug}" that nobody will claim`,
      method: 'POST',
      path: '/v2/admin/communities',
      json: { slug: goneSlug },
      expect: 201,
      covers: ['S03', 'V15'],
    });
    const goneId = num(gone, 'data', 'id');
    registerCommunity(ctx, goneId, goneSlug);
    await w.step({
      who: sam,
      say: 'disables it, then enables it again (sessions end; old claim tokens never come back)',
      method: 'PATCH',
      path: `/v2/admin/communities/${goneId}/status`,
      json: { status: 'disabled' },
      expect: 200,
      covers: ['S06', 'V15'],
      show: (r) => [field('status', dig(r, 'data', 'status'))],
    });
    await w.step({
      who: sam,
      say: 'enables it again',
      method: 'PATCH',
      path: `/v2/admin/communities/${goneId}/status`,
      json: { status: 'active' },
      expect: 200,
      covers: ['S06', 'V15'],
    });
    await w.step({
      who: sam,
      say: 'deletes it (confirm dialog): an unclaimed empty community is deprovisioned and its slug freed',
      method: 'DELETE',
      path: `/v2/admin/communities/${goneId}`,
      expect: [200, 204],
      covers: ['S06', 'V15'],
    });
    await w.step({
      who: sam,
      say: 'deletes it a second time',
      method: 'DELETE',
      path: `/v2/admin/communities/${goneId}`,
      expect: 409,
      negative: true,
      covers: ['S06'],
    });
    await w.step({
      who: sam,
      say: 'tries to delete the claimed disposable community this way (only unclaimed empty ones can be deprovisioned)',
      method: 'DELETE',
      path: `/v2/admin/communities/${labId}`,
      expect: [400, 403, 409],
      negative: true,
      covers: ['S06'],
      show: 'a claimed community leaves through its own admin: withdrawal and erasure',
    });

    // ---- audit and refusals --------------------------------------------
    const audit = await w.step({
      who: sam,
      say: 'opens the system audit log',
      method: 'GET',
      path: '/v2/admin/audit-entries?limit=10',
      expect: 200,
      covers: ['V13'],
      check: (r) =>
        /derivedKey|passwordVerifier/.test(JSON.stringify(r.json))
          ? 'audit leaked credentials'
          : undefined,
      show: (r) => [
        field('entries', dig(r, 'meta', 'total')),
        ...((dig(r, 'data') as Array<{ action: string }>) ?? [])
          .slice(0, 3)
          .map((e) => `row: ${e.action}`),
      ],
    });
    const action = String(dig(audit, 'data', 0, 'action') ?? '');
    if (action)
      await w.step({
        who: sam,
        say: `filters the system audit by action "${action}"`,
        method: 'GET',
        path: `/v2/admin/audit-entries?limit=10&action=${encodeURIComponent(action)}`,
        expect: 200,
        covers: ['V13'],
      });
    await w.step({
      who: sam,
      say: 'opens the erasure records',
      method: 'GET',
      path: '/v2/admin/erasures',
      expect: 200,
      covers: ['V14'],
      show: (r) => [
        field('records', ((dig(r, 'data') as unknown[]) ?? []).length),
      ],
    });
    await w.step({
      who: sam,
      say: 'tries to open the community map (stories)',
      method: 'GET',
      path: '/v2/stories',
      expect: 403,
      negative: true,
      covers: ['S08'],
      show: 'a super admin never reads community content (the Pundit-style denial)',
    });
    await w.step({
      who: sam,
      say: 'tries to open a community record',
      method: 'GET',
      path: '/v2/community',
      expect: 403,
      negative: true,
      covers: ['S08', 'S05'],
    });
    await w.step({
      who: sam,
      say: 'tries to edit a community',
      method: 'PATCH',
      path: '/v2/community',
      json: { name: 'nope' },
      expect: 403,
      negative: true,
      covers: ['S05'],
    });
    await w.step({
      who: sam,
      say: 'tries to write a story',
      method: 'POST',
      path: '/v2/stories',
      json: { title: 'nope' },
      expect: 403,
      negative: true,
      covers: ['S08'],
    });
    if (s.actors.ana?.jar.signedIn)
      await w.step({
        who: s.actors.ana,
        say: 'Ana tries the super admin communities list',
        method: 'GET',
        path: '/v2/admin/communities',
        expect: 403,
        negative: true,
        covers: ['S02'],
      });
  });
}
