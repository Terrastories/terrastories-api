/**
 * Chapter: Vera, a viewer, reads the public stories, manages her own
 * account (profile, photo, password, sessions) and is refused everything
 * else.
 */
import { PNG_BYTES, multipart } from '../client.js';
import { newVerifier, randomPassword } from '../kdf.js';
import {
  activate,
  deriveKey,
  field,
  guarded,
  num,
  signIn,
  str,
  val,
  type Ctx,
} from '../context.js';
import { dig } from '../walk.js';
import { readerNegatives, readerTour } from './reader-tour.js';

export const PERSONA_VIEWER = 'Viewer';

export async function viewerChapter(ctx: Ctx): Promise<void> {
  const { w, s, cfg } = ctx;
  const acct = s.accounts.vera!;
  w.chapter(
    PERSONA_VIEWER,
    'Vera reads and looks after her own account',
    'Vera is a viewer. She sees only what is shared with everyone (Anonymous), manages her own profile and sessions, and is refused every management screen.'
  );
  await guarded(ctx, 'viewer', async () => {
    const vera = (s.actors.vera = w.actor('Vera', 'viewer'));
    await activate(ctx, vera, acct, ['A06']);
    await w.step({
      who: vera,
      say: 'opens the user menu: Profile, Change password, Logout, with her name',
      method: 'GET',
      path: '/v2/auth/me',
      expect: 200,
      covers: ['B01', 'B08', 'M12'],
      show: (r) => [
        field('name', val(r, 'user', 'displayName')),
        field('role badge', val(r, 'user', 'role')),
      ],
    });
    await readerTour(ctx, vera, {
      mustSee: ['How the river got its name', 'Imported open story'],
      mustNotSee: ['Editors-only draft', 'Imported members story'],
      hiddenStoryId: s.ids.draft,
    });

    // ---- profile ------------------------------------------------------
    await w.step({
      who: vera,
      say: 'edits her display name on the profile page',
      method: 'PATCH',
      path: '/v2/auth/me',
      json: { displayName: `Vera Reader (${w.runId})` },
      expect: 200,
      covers: ['B02'],
      show: (r) => [field('display name', val(r, 'user', 'displayName'))],
    });
    const wrongKey = (await newVerifier(randomPassword())).derivedKey;
    await w.step({
      who: vera,
      say: 'tries to change her username with a wrong password in the confirmation box',
      method: 'PATCH',
      path: '/v2/auth/me',
      json: { username: `${acct.username}-x`, currentDerivedKey: wrongKey },
      expect: 403,
      negative: true,
      authFailure: true,
      covers: ['B02'],
      show: 'the form says the password is not right (one uniform answer)',
    });
    const newName = `${acct.username}-v2`;
    const key = await deriveKey(ctx, vera, acct.username, acct.password!);
    await w.step({
      who: vera,
      say: 'changes her username after confirming her current password',
      method: 'PATCH',
      path: '/v2/auth/me',
      json: { username: newName, currentDerivedKey: key },
      expect: 200,
      covers: ['B02'],
      show: (r) => [field('username', val(r, 'user', 'username'))],
    });
    acct.username = newName;
    await w.step({
      who: vera,
      say: 'takes a username that another person already uses',
      method: 'PATCH',
      path: '/v2/auth/me',
      json: {
        username: s.accounts.mateo!.username,
        currentDerivedKey: await deriveKey(
          ctx,
          vera,
          acct.username,
          acct.password!
        ),
      },
      expect: 409,
      negative: true,
      covers: ['B02'],
      show: 'the form says the username is already taken',
    });
    const up = await w.step({
      who: vera,
      say: 'uploads a profile photo (png, under 5 MB); the file part follows the role part',
      method: 'POST',
      path: '/v2/media',
      form: multipart(
        { role: 'user_photo' },
        { name: `${w.runId}-vera.png`, type: 'image/png', bytes: PNG_BYTES }
      ),
      bodyNote: 'multipart: role=user_photo, then the png file',
      expect: 201,
      covers: ['B02'],
      check: (r) =>
        dig(r, 'data', 'attachment')
          ? undefined
          : 'the upload did not create the attachment',
      show: (r) => [
        field('attachment role', dig(r, 'data', 'attachment', 'role')),
        'the avatar in the top bar changes',
      ],
    });
    const photoFile = str(up, 'data', 'id');
    const photoAttachment = num(up, 'data', 'attachment', 'id');
    await w.step({
      who: vera,
      say: 'the browser loads her photo for the top bar',
      method: 'GET',
      path: `/v2/media/${photoFile}`,
      expect: 200,
      covers: ['B01'],
      show: (r) => [
        field('content type', r.headers.get('content-type')),
        field('bytes', r.bytes.length),
      ],
    });
    await w.step({
      who: vera,
      say: 'removes the photo (hover overlay, confirm); the default avatar returns',
      method: 'DELETE',
      path: `/v2/attachments/${photoAttachment}`,
      expect: 204,
      covers: ['B03'],
    });
    await w.step({
      who: vera,
      say: 'the old photo file is cleared out of storage',
      method: 'DELETE',
      path: `/v2/media/${photoFile}`,
      expect: [204, 404],
      covers: ['B03'],
    });

    // ---- password -------------------------------------------------------
    const nextPassword = randomPassword();
    w.secret(nextPassword);
    const material = await newVerifier(nextPassword);
    w.secret(material.derivedKey);
    await w.step({
      who: vera,
      say: 'changes her password: types the new one twice, the browser stretches both the current and the new password',
      method: 'POST',
      path: '/v2/auth/password',
      json: {
        currentDerivedKey: await deriveKey(
          ctx,
          vera,
          acct.username,
          acct.password!
        ),
        ...material,
      },
      expect: 200,
      covers: ['B04'],
      show: 'her other sessions end; this one stays signed in',
    });
    acct.password = nextPassword;
    // The old-password login probe is deliberately not sent: the server
    // allows 10 failed auth attempts per 15 minutes per IP, and the other
    // refusals already cover the generic "invalid credentials" login answer
    // (A06).
    w.narrate(
      'A login with the old password would be refused with the same generic message as any wrong login; it is not sent here to stay inside the failed-attempt budget of the shared server.'
    );

    // ---- sessions -------------------------------------------------------
    const cookieBefore = vera.jar.header();
    await w.step({
      who: vera,
      say: 'logs out from the user menu',
      method: 'POST',
      path: '/v2/auth/logout',
      expect: 204,
      covers: ['B05'],
    });
    await w.step({
      who: vera,
      say: 'the browser back button replays the old session cookie',
      method: 'GET',
      path: '/v2/auth/me',
      headers: cookieBefore ? { cookie: cookieBefore } : {},
      noCookie: true,
      expect: 401,
      negative: true,
      covers: ['B05'],
      show: 'the app shows the login page',
    });
    const phone = (s.actors.veraPhone = w.actor('Vera on her phone', 'viewer'));
    await signIn(ctx, phone, acct.username, acct.password, {
      deviceSession: true,
    });
    const laptop = (s.actors.vera = w.actor('Vera', 'viewer'));
    await signIn(ctx, laptop, acct.username, acct.password, {
      covers: ['B05'],
    });
    await w.step({
      who: laptop,
      say: 'taps "sign out everywhere"',
      method: 'POST',
      path: '/v2/auth/revoke',
      expect: 204,
      covers: ['B05', 'V11'],
    });
    await w.step({
      who: phone,
      say: 'the phone tries to continue and is signed out',
      method: 'GET',
      path: '/v2/auth/me',
      expect: 401,
      negative: true,
      covers: ['B05', 'V11'],
    });
    const again = (s.actors.veraPhone = w.actor('Vera on her phone', 'viewer'));
    await signIn(ctx, again, acct.username, acct.password, {
      deviceSession: true,
      covers: ['V11'],
    });
    w.narrate(
      'Vera stays signed in on her phone with "remember this device"; her admin will look at that session later.'
    );

    await readerNegatives(ctx, again, { content: ['C02'] });
    await w.step({
      who: again,
      say: 'tries to upload story media (only profile photos are open to viewers)',
      method: 'POST',
      path: '/v2/media',
      form: multipart(
        {},
        { name: `${w.runId}-no.png`, type: 'image/png', bytes: PNG_BYTES }
      ),
      expect: 403,
      negative: true,
      covers: ['C02'],
    });
    void cfg;
  });
}
