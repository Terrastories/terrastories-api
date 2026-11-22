/**
 * Chapter: Ana's management day: people, map settings (Mapbox, #277),
 * branding, community settings, export, sovereignty, steward, audit; and
 * Adrian, a second admin who walks the recovery-code screens.
 */
import { randomBytes } from 'node:crypto';
import { PNG_BYTES } from '../client.js';
import { newVerifier, randomPassword } from '../kdf.js';
import {
  attach,
  deriveKey,
  field,
  guarded,
  num,
  signIn,
  str,
  upload,
  val,
  activate,
  playOf,
  type Ctx,
} from '../context.js';
import { dig } from '../walk.js';

export const PERSONA_ADMIN_LATE = 'Community admin';

const secretToken = (kind: 'pk' | 'sk') =>
  [kind, 'walkthrough', randomBytes(12).toString('hex')].join('.');

export async function adminLateChapter(ctx: Ctx): Promise<void> {
  const { w, s, cfg } = ctx;
  const ana = s.actors.ana;
  if (!ana) {
    w.chapter(PERSONA_ADMIN_LATE, 'Ana manages the community');
    w.narrate('Ana never signed in, so this chapter has nothing to walk.');
    return;
  }
  w.chapter(
    PERSONA_ADMIN_LATE,
    'Ana manages people, maps and sovereignty',
    'Everything here happens in the disposable play community. Settings Ana changes are saved first and put back in the cleanup chapter; the community is disabled at the end of the run.'
  );
  await guarded(ctx, 'admin-late', async () => {
    const vera = s.accounts.vera!;
    const zed = s.accounts.zed!;
    const samir = s.accounts.samir!;
    const mateo = s.accounts.mateo!;

    // ---- people -------------------------------------------------------
    w.skip(
      ['B07'],
      'Ana picks a language from the sidebar',
      'client-only i18n; no API call',
      'Ana'
    );
    w.skip(
      ['C01'],
      'Ana clicks "New" on the stories list',
      'opens a client-side form; no API call',
      'Ana'
    );
    await w.step({
      who: ana,
      say: `promotes ${zed.displayName} from viewer to editor`,
      method: 'PATCH',
      path: `/v2/users/${zed.id}`,
      json: { role: 'editor' },
      expect: 200,
      covers: ['D04'],
      show: (r) => [field('role badge', val(r, 'data', 'role'))],
    });
    const zedPassword = randomPassword();
    w.secret(zedPassword);
    const zedVerifier = await newVerifier(zedPassword);
    w.secret(zedVerifier.derivedKey);
    await w.step({
      who: ana,
      say: `resets ${zed.displayName}'s password: the new password is stretched in her browser; she never sees a credential`,
      method: 'POST',
      path: `/v2/users/${zed.id}/password-reset`,
      json: zedVerifier,
      expect: [200, 204],
      covers: ['D04'],
      show: 'Zed is told to use the new password; any old session of Zed ends',
    });
    zed.password = zedPassword;
    await w.step({
      who: ana,
      say: 'tries to reset her own password through the user form',
      method: 'POST',
      path: `/v2/users/${ana.userId}/password-reset`,
      json: await newVerifier(randomPassword()),
      expect: [400, 403, 404, 409],
      negative: true,
      covers: ['D04'],
      show: 'the reset field is hidden for the admin herself',
    });
    const zedActor = (s.actors.zed = w.actor('Zed', 'editor'));
    await signIn(ctx, zedActor, zed.username, zed.password);
    await w.step({
      who: ana,
      say: `disables ${zed.displayName} (there is no delete; the account is kept and cannot sign in)`,
      method: 'PATCH',
      path: `/v2/users/${zed.id}`,
      json: { status: 'disabled' },
      expect: 200,
      covers: ['D05', 'D04'],
      show: (r) => [field('status', val(r, 'data', 'status'))],
    });
    await w.step({
      who: zedActor,
      say: 'Zed tries to continue and is signed out',
      method: 'GET',
      path: '/v2/auth/me',
      expect: 401,
      negative: true,
      covers: ['D04'],
    });
    w.skip(
      ['D05'],
      'Ana looks for the "Delete user" button',
      'skipped by decision D12: users are disabled, not deleted',
      'Ana'
    );

    // ---- device sessions -------------------------------------------------
    const sessions = await w.step({
      who: ana,
      say: `opens ${vera.displayName}'s device sessions`,
      method: 'GET',
      path: `/v2/users/${vera.id}/sessions`,
      expect: 200,
      covers: ['V11'],
      check: (r) =>
        ((val(r, 'data') as unknown[]) ?? []).length >= 1
          ? undefined
          : 'expected at least one device session',
      show: (r) => [
        field('device sessions', ((val(r, 'data') as unknown[]) ?? []).length),
        'each row shows created, last seen and expiry; never a token',
      ],
    });
    const handle = str(sessions, 'data', 0, 'handle');
    await w.step({
      who: ana,
      say: 'revokes that device session',
      method: 'DELETE',
      path: `/v2/users/${vera.id}/sessions/${handle}`,
      expect: 204,
      covers: ['V11'],
    });
    await w.step({
      who: s.actors.veraPhone!,
      say: "Vera's phone is signed out",
      method: 'GET',
      path: '/v2/auth/me',
      expect: 401,
      negative: true,
      covers: ['V11'],
    });
    await w.step({
      who: ana,
      say: 'tries to revoke a session that does not exist',
      method: 'DELETE',
      path: `/v2/users/${vera.id}/sessions/AAAAAAAAAAAAAAAAAAAAAA`,
      expect: 404,
      negative: true,
      covers: ['V11'],
    });

    // ---- Adrian: second admin, recovery codes ------------------------------
    await adrianScenes(ctx);

    // ---- map settings and Mapbox (#277) ----------------------------------
    await mapSettings(ctx, mateo.id ?? 0);

    // ---- community settings ----------------------------------------------
    await w.step({
      who: ana,
      say: 'edits the community description and copies the public link',
      method: 'PATCH',
      path: '/v2/community',
      json: { description: `<p>${w.runId} walkthrough description</p>` },
      expect: 200,
      covers: ['D08'],
      show: (r) => [
        field('description', val(r, 'data', 'description')),
        field('public link', `/<locale>/c/${val(r, 'data', 'slug')}`),
      ],
    });
    await branding(ctx);

    // ---- export, sovereignty, audit ----------------------------------------
    await exportScenes(ctx);
    await sovereigntyScenes(ctx, samir.id!, mateo.id!);
    await discardThenExport(ctx);
    void cfg;
  });
}

async function adrianScenes(ctx: Ctx): Promise<void> {
  const { w, s } = ctx;
  const acct = s.accounts.adrian!;
  const adrian = (s.actors.adrian = w.actor('Adrian', 'community admin'));
  w.narrate(
    'Ana created Adrian as a second admin. He is new: he has no recovery codes yet, so the app gates him.'
  );
  await activate(ctx, adrian, acct, ['A06']);
  await w.step({
    who: adrian,
    say: 'tries to open the Users screen straight away',
    method: 'GET',
    path: '/v2/users',
    expect: 403,
    negative: true,
    covers: ['V08'],
    check: (r) =>
      val(r, 'code') === 'recovery_codes_required'
        ? undefined
        : 'expected the recovery_codes_required gate',
    show: 'every screen redirects to "save your recovery codes" (D24)',
  });
  await w.step({
    who: adrian,
    say: 'asks who he is; the profile says no codes are confirmed yet',
    method: 'GET',
    path: '/v2/auth/me',
    expect: 200,
    covers: ['V08'],
    check: (r) =>
      dig(r, 'user', 'recoveryCodesConfirmed') === false
        ? undefined
        : 'expected recoveryCodesConfirmed=false',
    show: (r) => [
      field('recovery codes saved', dig(r, 'user', 'recoveryCodesConfirmed')),
    ],
  });
  const first = await w.step({
    who: adrian,
    say: 'confirms with his password and receives ten recovery codes',
    method: 'POST',
    path: '/v2/auth/recovery-codes',
    json: {
      currentDerivedKey: await deriveKey(
        ctx,
        adrian,
        acct.username,
        acct.password!
      ),
    },
    expect: 201,
    covers: ['V07'],
    show: (r) => {
      for (const c of (val(r, 'data', 'codes') as string[]) ?? []) w.secret(c);
      return [
        'ten single-use codes, shown once; print / copy / download (values hidden here)',
      ];
    },
  });
  const firstCodes = (val(first, 'data', 'codes') as string[]) ?? [];
  await w.step({
    who: adrian,
    say: 'opens the Users screen; the gate is gone',
    method: 'GET',
    path: '/v2/users?limit=1',
    expect: 200,
    covers: ['V08'],
  });
  const second = await w.step({
    who: adrian,
    say: 'regenerates the codes; the first sheet stops working',
    method: 'POST',
    path: '/v2/auth/recovery-codes',
    json: {
      currentDerivedKey: await deriveKey(
        ctx,
        adrian,
        acct.username,
        acct.password!
      ),
    },
    expect: 201,
    covers: ['V07'],
    show: (r) => {
      for (const c of (val(r, 'data', 'codes') as string[]) ?? []) w.secret(c);
      return ['a new sheet of ten codes'];
    },
  });
  const secondCodes = (val(second, 'data', 'codes') as string[]) ?? [];
  await w.step({
    who: adrian,
    say: 'logs out',
    method: 'POST',
    path: '/v2/auth/logout',
    expect: 204,
    covers: ['B05'],
  });
  const stranger = w.actor('Adrian (forgot his password)', 'community admin');
  const lost = await newVerifier(randomPassword());
  w.secret(lost.derivedKey);
  await w.step({
    who: stranger,
    say: 'tries an old-sheet code on the "I lost my password" page',
    method: 'POST',
    path: '/v2/auth/recovery/redeem',
    json: { code: firstCodes[0], identifier: acct.username, password: lost },
    noCookie: true,
    expect: [400, 401],
    negative: true,
    authFailure: true,
    covers: ['V09'],
    show: 'the page says the code is not valid',
  });
  const next = randomPassword();
  w.secret(next);
  const nextVerifier = await newVerifier(next);
  w.secret(nextVerifier.derivedKey);
  const back = (s.actors.adrian = w.actor('Adrian', 'community admin'));
  await w.step({
    who: back,
    say: 'redeems a current recovery code on the "I lost my password" page and chooses a new password',
    method: 'POST',
    path: '/v2/auth/recovery/redeem',
    json: {
      code: secondCodes[0],
      identifier: acct.username,
      password: nextVerifier,
    },
    expect: 200,
    covers: ['V09'],
    show: (r) => [
      field('signed in as', val(r, 'user', 'displayName')),
      'that code is now spent',
    ],
  });
  acct.password = next;
  back.identifier = acct.username;
  back.password = next;
  await w.step({
    who: back,
    say: 'replays the same recovery code',
    method: 'POST',
    path: '/v2/auth/recovery/redeem',
    json: {
      code: secondCodes[0],
      identifier: acct.username,
      password: nextVerifier,
    },
    noCookie: true,
    expect: [400, 401],
    negative: true,
    authFailure: true,
    covers: ['V09'],
  });
}

async function mapSettings(ctx: Ctx, mateoId: number): Promise<void> {
  const { w, s } = ctx;
  const ana = s.actors.ana!;
  const mateo = s.actors.mateo;
  const pia = s.actors.pia ?? w.actor('Pia', 'anonymous visitor');
  const slug = playOf(ctx).slug;
  const style = `mapbox://styles/walkthrough/${w.runId.replace(/[^a-z0-9]/g, '')}`;
  const pk = secretToken('pk');
  w.secret(pk);
  const pkNow = pk;
  w.narrate(
    'Mapbox settings (#277): a community may use its own Mapbox style with a public pk token.'
  );

  if (s.snapshot && s.snapshot.visibility !== 'public') {
    await w.step({
      who: ana,
      say: 'makes the community public for this walkthrough (restored later)',
      method: 'PATCH',
      path: '/v2/community',
      json: { visibility: 'public' },
      expect: 200,
      covers: ['D08'],
    });
  }
  await w.step({
    who: ana,
    say: 'opens Map settings and saves centre, bounds, zoom, pitch, bearing and projection',
    method: 'PUT',
    path: '/v2/community/map-config',
    json: {
      centerLatitude: 6.8,
      centerLongitude: -58.15,
      southWestLatitude: 6.0,
      southWestLongitude: -59.0,
      northEastLatitude: 7.5,
      northEastLongitude: -57.0,
      zoom: 7.25,
      pitch: 30,
      bearing: 15,
      projection: 'mercator',
      threeDimensional: false,
    },
    expect: 200,
    covers: ['D06', 'M02'],
    show: (r) => [
      field(
        'centre',
        `${val(r, 'data', 'centerLatitude')}, ${val(r, 'data', 'centerLongitude')}`
      ),
      field('zoom', val(r, 'data', 'zoom')),
      field('pitch', val(r, 'data', 'pitch')),
      field('bearing', val(r, 'data', 'bearing')),
    ],
  });
  await w.step({
    who: ana,
    say: 'draws bounds that wrap across the antimeridian (west edge east of the east edge)',
    method: 'PUT',
    path: '/v2/community/map-config',
    json: {
      southWestLatitude: -10,
      southWestLongitude: 170,
      northEastLatitude: 10,
      northEastLongitude: -170,
      centerLatitude: 0,
      centerLongitude: 180,
      zoom: 3,
    },
    expect: 200,
    covers: ['D06'],
    show: 'the "unrestricted bounds" toggle stays off; wrapped bounds are accepted',
  });
  await w.step({
    who: ana,
    say: 'enters a south edge north of the north edge',
    method: 'PUT',
    path: '/v2/community/map-config',
    json: {
      southWestLatitude: 20,
      southWestLongitude: -59,
      northEastLatitude: 10,
      northEastLongitude: -57,
    },
    expect: 400,
    negative: true,
    covers: ['D06'],
    show: 'the form marks the south latitude',
  });
  await w.step({
    who: ana,
    say: 'enters a latitude without a longitude for the centre',
    method: 'PUT',
    path: '/v2/community/map-config',
    json: { centerLatitude: 5 },
    expect: 400,
    negative: true,
    covers: ['D06'],
  });
  await w.step({
    who: ana,
    say: 'pastes a Mapbox style and a public token, with "show to the public" off',
    method: 'PUT',
    path: '/v2/community/map-config',
    json: {
      centerLatitude: 6.8,
      centerLongitude: -58.15,
      zoom: 7.25,
      mapboxStyleUrl: style,
      mapboxAccessToken: pkNow,
      exposeMapboxCredentials: false,
      mapbox3d: true,
    },
    expect: 200,
    covers: ['D06', 'M02'],
    check: (r) =>
      dig(r, 'render', 'source') === 'community'
        ? undefined
        : 'expected render source community',
    show: (r) => [
      field('style', dig(r, 'data', 'mapboxStyleUrl')),
      'token: saved (shown masked)',
      field('3D terrain', dig(r, 'data', 'mapbox3d')),
      field('render source', dig(r, 'render', 'source')),
    ],
  });
  await w.step({
    who: ana,
    say: 'reopens Map settings: the form shows the stored values, never the instance token',
    method: 'GET',
    path: '/v2/community/map-config',
    expect: 200,
    covers: ['D06'],
    check: (r) =>
      dig(r, 'data', 'mapboxStyleUrl') === style
        ? undefined
        : 'the stored style was not returned',
    show: (r) => [
      field('style', dig(r, 'data', 'mapboxStyleUrl')),
      field('expose to public', dig(r, 'data', 'exposeMapboxCredentials')),
    ],
  });
  if (mateo) {
    await w.step({
      who: mateo,
      say: 'Mateo, a member, opens the map: the renderer block carries the style and token to use',
      method: 'GET',
      path: '/v2/community/map-config',
      expect: 200,
      covers: ['M02'],
      check: (r) =>
        dig(r, 'render', 'mapboxStyleUrl') === style
          ? undefined
          : 'the member does not see the render block',
      show: (r) => [
        field('render style', dig(r, 'render', 'mapboxStyleUrl')),
        field('render source', dig(r, 'render', 'source')),
        'token: present (masked)',
      ],
    });
    await w.step({
      who: mateo,
      say: 'Mateo also reads the community record, which carries the same renderer block',
      method: 'GET',
      path: '/v2/community',
      expect: 200,
      covers: ['M02'],
      check: (r) =>
        dig(r, 'data', 'mapRender', 'mapboxStyleUrl') === style
          ? undefined
          : 'mapRender missing on the community record',
    });
  }
  const publicMap = (r: { json: unknown }) =>
    ((r.json as { data?: { mapConfig?: Record<string, unknown> | null } })?.data
      ?.mapConfig ?? null) as Record<string, unknown> | null;
  await w.step({
    who: pia,
    say: 'Pia, anonymous, opens the public map: no Mapbox style or token is shared yet',
    method: 'GET',
    path: `/v2/public/communities/${slug}`,
    expect: 200,
    covers: ['M02', 'D06'],
    check: (r) => {
      const map = publicMap(r);
      return map && (map.mapboxStyleUrl || map.mapboxAccessToken)
        ? 'public read leaked the Mapbox settings'
        : undefined;
    },
    show: 'the public map falls back to the default OpenFreeMap style',
  });
  await w.step({
    who: ana,
    say: 'ticks "show my Mapbox style on the public map"',
    method: 'PUT',
    path: '/v2/community/map-config',
    json: { exposeMapboxCredentials: true },
    expect: 200,
    covers: ['D06'],
    check: (r) =>
      dig(r, 'data', 'mapboxStyleUrl') === style
        ? undefined
        : 'omitting the style must keep the stored value',
    show: (r) => [
      field('expose to public', dig(r, 'data', 'exposeMapboxCredentials')),
      'style and token were kept (omitted keys keep their stored values)',
    ],
  });
  await w.step({
    who: pia,
    say: 'Pia reloads the public map: the public community now shares its style and the public token',
    method: 'GET',
    path: `/v2/public/communities/${slug}`,
    expect: 200,
    covers: ['M02', 'D06'],
    check: (r) =>
      publicMap(r)?.mapboxStyleUrl === style
        ? undefined
        : 'the public map did not receive the exposed style',
    show: (r) => [
      field('style', publicMap(r)?.mapboxStyleUrl),
      'token: present (masked)',
    ],
  });
  await w.step({
    who: ana,
    say: 'switches the community to private',
    method: 'PATCH',
    path: '/v2/community',
    json: { visibility: 'private' },
    expect: 200,
    covers: ['D08'],
    show: (r) => [
      field('visibility', val(r, 'data', 'visibility')),
      'switching to private also turns "show on the public map" off',
    ],
  });
  await w.step({
    who: pia,
    say: 'Pia reloads: the private community is not found',
    method: 'GET',
    path: `/v2/public/communities/${slug}`,
    expect: 404,
    negative: true,
    covers: ['D08', 'D06'],
  });
  await w.step({
    who: ana,
    say: 'looks at Map settings: the public switch was reset',
    method: 'GET',
    path: '/v2/community/map-config',
    expect: 200,
    covers: ['D06'],
    check: (r) =>
      dig(r, 'data', 'exposeMapboxCredentials') === false
        ? undefined
        : 'making the community private must reset exposeMapboxCredentials',
    show: (r) => [
      field('expose to public', dig(r, 'data', 'exposeMapboxCredentials')),
    ],
  });
  await w.step({
    who: ana,
    say: 'makes the community public again',
    method: 'PATCH',
    path: '/v2/community',
    json: { visibility: 'public' },
    expect: 200,
    covers: ['D08'],
  });
  await w.step({
    who: pia,
    say: 'Pia reloads: public again, but the Mapbox settings stay private until Ana opts in again',
    method: 'GET',
    path: `/v2/public/communities/${slug}`,
    expect: 200,
    covers: ['D06', 'M02'],
    check: (r) => {
      const map = publicMap(r);
      return map && (map.mapboxStyleUrl || map.mapboxAccessToken)
        ? 'the reset did not hide the Mapbox settings'
        : undefined;
    },
  });
  await w.step({
    who: ana,
    say: 'pastes a secret (sk) token by mistake',
    method: 'PUT',
    path: '/v2/community/map-config',
    json: { mapboxStyleUrl: style, mapboxAccessToken: secretToken('sk') },
    expect: [400, 422],
    negative: true,
    covers: ['D06'],
    show: 'the form says only public tokens (pk) are accepted',
  });
  await w.step({
    who: ana,
    say: 'enters a style without a token',
    method: 'PUT',
    path: '/v2/community/map-config',
    json: { mapboxStyleUrl: null, mapboxAccessToken: pkNow },
    expect: [400, 422],
    negative: true,
    covers: ['D06'],
    show: 'the style and the token must both be set or both be blank',
  });
  await w.step({
    who: ana,
    say: 'clears the Mapbox style and token (explicit null clears both)',
    method: 'PUT',
    path: '/v2/community/map-config',
    json: { mapboxStyleUrl: null, mapboxAccessToken: null, mapbox3d: false },
    expect: 200,
    covers: ['D06'],
    check: (r) =>
      dig(r, 'data', 'mapboxStyleUrl') === null
        ? undefined
        : 'the style was not cleared',
    show: (r) => [
      field('style', dig(r, 'data', 'mapboxStyleUrl')),
      field('render source', dig(r, 'render', 'source')),
    ],
  });
  void mateoId;
}

async function branding(ctx: Ctx): Promise<void> {
  const { w, s } = ctx;
  const ana = s.actors.ana!;
  const community = await w.step({
    who: ana,
    say: 'opens Community settings to see the branding images',
    method: 'GET',
    path: '/v2/community',
    expect: 200,
    covers: ['D07'],
    show: (r) => [
      field(
        'background image',
        dig(r, 'data', 'branding', 'backgroundImage') ? 'set' : 'none'
      ),
      field(
        'sponsor logos',
        ((dig(r, 'data', 'branding', 'sponsorLogos') as unknown[]) ?? []).length
      ),
    ],
  });
  const communityId = num(community, 'data', 'id');
  s.ids.community = communityId;
  // the reorder must list every logo of the owner, so keep any that exist
  const existingLogos = (
    (dig(community, 'data', 'branding', 'sponsorLogos') as Array<
      Record<string, unknown>
    >) ?? []
  )
    .map((l) => l.attachmentId ?? l.id)
    .filter((id): id is number => typeof id === 'number');
  const logos: number[] = [];
  for (const n of [1, 2]) {
    const file = await upload(
      ctx,
      ana,
      `uploads sponsor logo ${n}`,
      { name: `${w.runId}-logo${n}.png`, type: 'image/png', bytes: PNG_BYTES },
      ['D07']
    );
    s.files[`logo${n}`] = file;
    logos.push(
      await attach(
        ctx,
        ana,
        `adds sponsor logo ${n} to the welcome page`,
        {
          fileId: file,
          ownerType: 'community',
          ownerId: communityId,
          role: 'sponsor_logo',
          ordinal: n - 1,
        },
        ['D07']
      )
    );
  }
  s.attachments.logo1 = logos[0]!;
  s.attachments.logo2 = logos[1]!;
  await w.step({
    who: ana,
    say: 'reorders the sponsor logos',
    method: 'PATCH',
    path: '/v2/attachments/reorder',
    json: {
      ownerType: 'community',
      ownerId: communityId,
      role: 'sponsor_logo',
      attachmentIds: [...existingLogos, logos[1], logos[0]],
    },
    expect: 200,
    covers: ['D07', 'V17'],
  });
  if (!dig(community, 'data', 'branding', 'backgroundImage')) {
    const file = await upload(
      ctx,
      ana,
      'uploads a welcome background image',
      { name: `${w.runId}-bg.png`, type: 'image/png', bytes: PNG_BYTES },
      ['D07']
    );
    s.files.background = file;
    s.attachments.background = await attach(
      ctx,
      ana,
      'sets it as the welcome background',
      {
        fileId: file,
        ownerType: 'community',
        ownerId: communityId,
        role: 'community_background_image',
        ordinal: 0,
      },
      ['D07']
    );
  } else {
    w.narrate(
      'The community already has a welcome background image, so the walkthrough leaves it alone.'
    );
  }
  await w.step({
    who: ana,
    say: 'removes sponsor logo 1 (AJAX remove)',
    method: 'DELETE',
    path: `/v2/attachments/${logos[0]}`,
    expect: 204,
    covers: ['D07'],
  });
}

async function exportScenes(ctx: Ctx): Promise<void> {
  const { w, s } = ctx;
  const ana = s.actors.ana!;
  const exp = await w.step({
    who: ana,
    say: 'clicks "Export my community"',
    method: 'POST',
    path: '/v2/community/export',
    json: {},
    expect: 201,
    covers: ['V01'],
    show: (r) => {
      for (const kind of ['manifest', 'mediaZip'])
        w.secret(String(dig(r, 'data', 'artifacts', kind, 'token') ?? ''));
      return [
        field(
          'manifest bytes',
          dig(r, 'data', 'artifacts', 'manifest', 'byteSize')
        ),
        field(
          'media archive files',
          dig(r, 'data', 'artifacts', 'mediaZip', 'fileCount')
        ),
        field('links expire', dig(r, 'data', 'expiresAt')),
        'two short-lived download buttons (15 minutes)',
      ];
    },
  });
  const manifestPath = str(
    exp,
    'data',
    'artifacts',
    'manifest',
    'downloadPath'
  );
  const zipPath = str(exp, 'data', 'artifacts', 'mediaZip', 'downloadPath');
  await w.step({
    who: ana,
    say: 'downloads the JSON manifest',
    method: 'GET',
    path: manifestPath,
    expect: 200,
    covers: ['V01'],
    check: (r) =>
      /passwordVerifier|derivedKey|passwordHash/.test(r.text)
        ? 'the export contains credential fields'
        : undefined,
    show: (r) => [
      field('content type', r.headers.get('content-type')),
      field('bytes', r.bytes.length),
      'the export carries no credentials, sessions or throttles',
    ],
  });
  await w.step({
    who: ana,
    say: 'downloads the media archive',
    method: 'GET',
    path: zipPath,
    expect: 200,
    covers: ['V01'],
    show: (r) => [
      field('content type', r.headers.get('content-type')),
      field('bytes', r.bytes.length),
    ],
  });
  await w.step({
    who: s.actors.elena!,
    say: "Elena tries to use Ana's download link",
    method: 'GET',
    path: manifestPath,
    expect: [403, 404],
    negative: true,
    covers: ['V01'],
    show: 'the link works only for the admin who asked for it',
  });
}

async function sovereigntyScenes(
  ctx: Ctx,
  samirId: number,
  mateoId: number
): Promise<void> {
  const { w, s } = ctx;
  const play = playOf(ctx);
  const ana = s.actors.ana!;
  await w.step({
    who: ana,
    say: 'opens the Sovereignty page',
    method: 'GET',
    path: '/v2/community/sovereignty',
    expect: 200,
    covers: ['V02'],
    show: (r) => [
      field('status', dig(r, 'data', 'status')),
      field('steward', dig(r, 'data', 'steward') ? 'designated' : 'none'),
      field(
        'notice period (days)',
        Number(dig(r, 'data', 'noticePeriodSeconds')) / 86400
      ),
      field(
        'pending requests',
        ((dig(r, 'data', 'pendingRequests') as unknown[]) ?? []).length
      ),
    ],
  });
  await w.step({
    who: ana,
    say: 'designates Samir as steward with a wrong password in the confirmation box',
    method: 'PUT',
    path: '/v2/community/steward',
    json: {
      stewardUserId: samirId,
      currentDerivedKey: (await newVerifier(randomPassword())).derivedKey,
    },
    expect: [401, 403],
    negative: true,
    authFailure: true,
    covers: ['V03'],
    show: 'the dialog says the password is not right',
  });
  const stewardBody = async (id: number | null) => ({
    stewardUserId: id,
    currentDerivedKey: await deriveKey(
      ctx,
      ana,
      play.adminIdentifier,
      play.adminPassword,
      play.slug
    ),
  });
  await w.step({
    who: ana,
    say: 'designates Samir as steward (password step-up)',
    method: 'PUT',
    path: '/v2/community/steward',
    json: await stewardBody(samirId),
    expect: 200,
    covers: ['V03'],
    check: (r) =>
      dig(r, 'data', 'steward', 'userId') === samirId
        ? undefined
        : 'the steward in the answer is not Samir',
    show: (r) => [
      field('steward user', dig(r, 'data', 'steward', 'userId')),
      field('role', dig(r, 'data', 'steward', 'role')),
    ],
  });
  await w.step({
    who: ana,
    say: 'reopens the Sovereignty page: Samir is shown as the steward',
    method: 'GET',
    path: '/v2/community/sovereignty',
    expect: 200,
    covers: ['V03'],
    check: (r) =>
      dig(r, 'data', 'steward', 'userId') === samirId
        ? undefined
        : 'the stored steward is not Samir',
  });
  await w.step({
    who: ana,
    say: 'replaces the steward with Mateo',
    method: 'PUT',
    path: '/v2/community/steward',
    json: await stewardBody(mateoId),
    expect: 200,
    covers: ['V03'],
    check: (r) =>
      dig(r, 'data', 'steward', 'userId') === mateoId
        ? undefined
        : 'the steward did not change to Mateo',
  });
  await w.step({
    who: ana,
    say: 'removes the steward again',
    method: 'PUT',
    path: '/v2/community/steward',
    json: await stewardBody(null),
    expect: 200,
    covers: ['V03'],
    check: (r) =>
      dig(r, 'data', 'steward') === null ||
      dig(r, 'data', 'steward') === undefined
        ? undefined
        : 'the steward was not removed',
    show: (r) => [field('steward', dig(r, 'data', 'steward') ?? 'none')],
  });

  const first = await w.step({
    who: ana,
    say: 'opens the audit log (newest first)',
    method: 'GET',
    path: '/v2/community/audit-entries?limit=10&offset=0',
    expect: 200,
    covers: ['V12'],
    check: (r) =>
      JSON.stringify(r.json).match(/derivedKey|passwordVerifier/)
        ? 'audit rows leaked credentials'
        : undefined,
    show: (r) => [
      field('entries', dig(r, 'meta', 'total')),
      ...((dig(r, 'data') as Array<{ action: string; outcome: string }>) ?? [])
        .slice(0, 3)
        .map((e) => `row: ${e.action} (${e.outcome})`),
      'rows hold actions and ids only, never cultural content or secrets',
    ],
  });
  const action = String(dig(first, 'data', 0, 'action') ?? '');
  if (action) {
    await w.step({
      who: ana,
      say: `filters the audit log by action "${action}"`,
      method: 'GET',
      path: `/v2/community/audit-entries?limit=10&action=${encodeURIComponent(action)}`,
      expect: 200,
      covers: ['V12'],
      check: (r) =>
        ((dig(r, 'data') as Array<{ action: string }>) ?? []).every(
          (e) => e.action === action
        )
          ? undefined
          : 'the filter returned other actions',
    });
  }
  await w.step({
    who: ana,
    say: 'asks for the second page',
    method: 'GET',
    path: '/v2/community/audit-entries?limit=5&offset=5',
    expect: 200,
    covers: ['V12'],
  });
}

/** Discarding an import preview must not break the next export. */
async function discardThenExport(ctx: Ctx): Promise<void> {
  const { w, s } = ctx;
  const ana = s.actors.ana!;
  const elena = s.actors.elena;
  const open = s.imports[s.imports.length - 1];
  if (!elena || open === undefined) return;
  await w.step({
    who: elena,
    say: 'discards an open import preview',
    method: 'DELETE',
    path: `/v2/imports/${open}`,
    expect: [200, 204],
    covers: ['C32'],
  });
  await w.step({
    who: ana,
    say: 'exports the community again after the discard (it must still work)',
    method: 'POST',
    path: '/v2/community/export',
    json: {},
    expect: 201,
    covers: ['V01'],
    show: (r) => {
      for (const kind of ['manifest', 'mediaZip'])
        w.secret(String(dig(r, 'data', 'artifacts', kind, 'token') ?? ''));
      return ['the export works after a discard'];
    },
  });
}
