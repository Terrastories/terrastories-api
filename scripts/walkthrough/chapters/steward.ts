/**
 * Chapter: Samir, a community steward, and the sovereignty flows
 * (withdrawal, erasure). Destructive: it only ever touches the disposable
 * "lab" community the super admin chapter created, and only with
 * --allow-destructive.
 */
import { newVerifier, randomPassword } from '../kdf.js';
import {
  activate,
  offsetOfMatch,
  deriveKey,
  field,
  guarded,
  num,
  str,
  val,
  signIn,
  type Ctx,
} from '../context.js';
import { dig } from '../walk.js';

export const PERSONA_STEWARD = 'Steward';

export async function stewardChapter(ctx: Ctx): Promise<void> {
  const { w, s, cfg } = ctx;
  w.chapter(
    PERSONA_STEWARD,
    'Samir keeps the community safe: steward, withdrawal, erasure',
    'These flows are destructive. They run only on the disposable community the script created, and only with --allow-destructive.'
  );
  const lab = s.lab;
  if (!lab) {
    w.narrate(
      'No disposable community exists (the super admin chapter did not finish), so nothing destructive was walked.'
    );
    return;
  }
  const covers = ['V04', 'V05', 'V06'];
  if (!cfg.allowDestructive) {
    w.skip(
      covers,
      'withdrawal, erasure and steward notices on a disposable community',
      'needs --allow-destructive; they run only on the community the script created',
      'Samir',
      true
    );
    return;
  }
  await guarded(ctx, 'steward', async () => {
    // Guards: never the target community, always the run-prefixed one.
    if (
      lab.slug === cfg.community ||
      lab.slug === s.play?.slug ||
      !lab.slug.startsWith(w.runId)
    )
      throw new Error(
        'refusing destructive steps: the community is not the disposable one'
      );
    const lucia = s.actors.lucia!;
    const luciaAcct = s.accounts.lucia!;
    await signIn(ctx, lucia, luciaAcct.username, luciaAcct.password!, {
      communitySlug: lab.slug,
    });
    await w.step({
      who: lucia,
      say: 'confirms she holds recovery codes (the claim gave them to her)',
      method: 'GET',
      path: '/v2/auth/me',
      expect: 200,
      covers: ['V08'],
      check: (r) =>
        dig(r, 'user', 'recoveryCodesConfirmed') === true
          ? undefined
          : 'expected recovery codes to be confirmed after a claim',
      show: (r) => [
        field('recovery codes saved', dig(r, 'user', 'recoveryCodesConfirmed')),
      ],
    });
    // Samir
    const samir = {
      key: 'labsamir',
      displayName: `Samir (${w.runId})`,
      username: `${w.runId}-labsamir`,
      email: `${w.runId}-labsamir@walkthrough.example.test`,
      role: 'member',
      id: 0,
      password: undefined as string | undefined,
      loginCode: undefined as string | undefined,
    };
    const made = await w.step({
      who: lucia,
      say: 'Lucia creates Samir as a member of the lab community',
      method: 'POST',
      path: '/v2/users',
      json: {
        username: samir.username,
        email: samir.email,
        displayName: samir.displayName,
        role: 'member',
      },
      expect: 201,
      covers: ['D02'],
    });
    samir.id = num(made, 'data', 'id');
    const code = await w.step({
      who: lucia,
      say: 'issues him a login code',
      method: 'POST',
      path: `/v2/users/${samir.id}/login-codes`,
      expect: 201,
      covers: ['V10'],
      show: (r) => {
        w.secret(String(dig(r, 'data', 'code') ?? ''));
        return ['code shown once (hidden here)'];
      },
    });
    samir.loginCode = str(code, 'data', 'code');
    const samirActor = (s.actors.samir = w.actor('Samir', 'steward'));
    s.accounts.labsamir = samir;
    await activate(ctx, samirActor, samir, ['A06']);
    const luciaKey = () =>
      deriveKey(ctx, lucia, luciaAcct.username, luciaAcct.password!, lab.slug);
    await w.step({
      who: lucia,
      say: 'designates Samir as the steward of the community (password step-up)',
      method: 'PUT',
      path: '/v2/community/steward',
      json: { stewardUserId: samir.id, currentDerivedKey: await luciaKey() },
      expect: 200,
      covers: ['V03'],
      check: (r) =>
        dig(r, 'data', 'steward', 'userId') === samir.id
          ? undefined
          : 'the steward in the answer is not Samir',
    });
    await w.step({
      who: samirActor,
      say: 'Samir opens the sovereignty page; a steward cannot read community status',
      method: 'GET',
      path: '/v2/community/sovereignty',
      expect: 403,
      negative: true,
      covers: ['V02'],
      show: 'the steward UI only offers "request withdrawal" and "request erasure"',
    });
    const samirKey = () =>
      deriveKey(ctx, samirActor, samir.username, samir.password!, lab.slug);
    const wd = await w.step({
      who: samirActor,
      say: 'Samir asks for withdrawal: for a steward this starts a notice period, nothing happens yet',
      method: 'POST',
      path: '/v2/community/withdrawal',
      json: { currentDerivedKey: await samirKey() },
      expect: [200, 201, 202],
      covers: ['V04'],
      check: (r) =>
        dig(r, 'data', 'status') === 'active'
          ? undefined
          : 'a steward request must not disable the community yet',
      show: (r) => [
        field('community status', dig(r, 'data', 'status')),
        field('request state', dig(r, 'data', 'request', 'state')),
        field('notice ends', dig(r, 'data', 'request', 'noticeEndsAt')),
      ],
    });
    void wd;
    const pending = await w.step({
      who: lucia,
      say: 'Lucia sees the pending request and its notice deadline',
      method: 'GET',
      path: '/v2/community/sovereignty',
      expect: 200,
      covers: ['V02', 'V06'],
      check: (r) =>
        ((dig(r, 'data', 'pendingRequests') as unknown[]) ?? []).length === 1
          ? undefined
          : 'expected one pending request',
      show: (r) => [
        field('steward', dig(r, 'data', 'steward', 'userId')),
        field(
          'pending requests',
          ((dig(r, 'data', 'pendingRequests') as unknown[]) ?? []).length
        ),
        field(
          'notice period (days)',
          Number(dig(r, 'data', 'noticePeriodSeconds')) / 86400
        ),
        'a countdown and a "Cancel request" button',
      ],
    });
    await w.step({
      who: lucia,
      say: 'cancels the steward request during the notice period',
      method: 'POST',
      path: '/v2/community/sovereignty/cancel',
      json: {
        requestId: str(pending, 'data', 'pendingRequests', 0, 'id'),
        currentDerivedKey: await luciaKey(),
      },
      expect: [200, 204],
      covers: ['V06'],
    });
    await w.step({
      who: samirActor,
      say: 'Samir asks for erasure instead: finality ticked, notice period starts',
      method: 'POST',
      path: '/v2/community/erasure',
      json: { confirmFinality: true, currentDerivedKey: await samirKey() },
      expect: [200, 201, 202],
      covers: ['V05'],
      check: (r) =>
        dig(r, 'data', 'status') === 'active'
          ? undefined
          : 'a steward request must not disable the community yet',
      show: (r) => [
        field('community status', dig(r, 'data', 'status')),
        field('notice', dig(r, 'data', 'finalityNotice')),
      ],
    });
    const pending2 = await w.step({
      who: lucia,
      say: 'Lucia sees the erasure request and cancels it',
      method: 'GET',
      path: '/v2/community/sovereignty',
      expect: 200,
      covers: ['V06'],
      check: (r) =>
        ((dig(r, 'data', 'pendingRequests') as unknown[]) ?? []).length === 1
          ? undefined
          : 'expected exactly the erasure request (the withdrawal request was cancelled)',
    });
    await w.step({
      who: lucia,
      say: 'cancels it',
      method: 'POST',
      path: '/v2/community/sovereignty/cancel',
      json: {
        requestId: str(pending2, 'data', 'pendingRequests', 0, 'id'),
        currentDerivedKey: await luciaKey(),
      },
      expect: [200, 204],
      covers: ['V06'],
    });
    await w.step({
      who: lucia,
      say: 'the sovereignty page shows no pending request any more',
      method: 'GET',
      path: '/v2/community/sovereignty',
      expect: 200,
      covers: ['V06'],
      check: (r) =>
        ((dig(r, 'data', 'pendingRequests') as unknown[]) ?? []).length === 0
          ? undefined
          : 'the cancelled request is still pending',
      show: (r) => [
        field(
          'pending requests',
          ((dig(r, 'data', 'pendingRequests') as unknown[]) ?? []).length
        ),
      ],
    });
    await w.step({
      who: samirActor,
      say: 'Samir tries erasure without ticking the finality box',
      method: 'POST',
      path: '/v2/community/erasure',
      json: { currentDerivedKey: await samirKey() },
      expect: 400,
      negative: true,
      covers: ['V05'],
      show: 'the form keeps the button disabled until the box is ticked',
    });

    // Lucia herself
    await w.step({
      who: lucia,
      say: 'Lucia, the admin, withdraws the community: this takes effect at once, all sessions end',
      method: 'POST',
      path: '/v2/community/withdrawal',
      json: { currentDerivedKey: await luciaKey() },
      expect: [200, 201],
      covers: ['V04'],
      check: (r) =>
        dig(r, 'data', 'status') === 'disabled'
          ? undefined
          : 'expected the community to be disabled',
      show: (r) => [
        field('community status', dig(r, 'data', 'status')),
        'a destructive-feel confirmation was shown first; there is no undo in the UI',
      ],
    });
    await w.step({
      who: samirActor,
      say: 'Samir tries to continue: his session ended with the withdrawal',
      method: 'GET',
      path: '/v2/auth/me',
      expect: 401,
      negative: true,
      covers: ['V04'],
    });
    await w.step({
      who: s.actors.pia ?? w.actor('Pia', 'anonymous visitor'),
      say: 'the public map of the lab community is gone',
      method: 'GET',
      path: `/v2/public/communities/${lab.slug}`,
      expect: 404,
      negative: true,
      covers: ['V04'],
    });
    const relucia = (s.actors.lucia = w.actor('Lucia', 'community admin'));
    await signIn(ctx, relucia, luciaAcct.username, luciaAcct.password!, {
      communitySlug: lab.slug,
    });
    await w.step({
      who: relucia,
      say: 'Lucia signs in again: content is closed, but the sovereignty page stays reachable',
      method: 'GET',
      path: '/v2/community/sovereignty',
      expect: 200,
      covers: ['V02'],
      show: (r) => [field('status', dig(r, 'data', 'status'))],
    });
    await w.step({
      who: relucia,
      say: 'content screens are closed',
      method: 'GET',
      path: '/v2/stories',
      expect: [403, 404],
      negative: true,
      covers: ['V04'],
    });
    await w.step({
      who: relucia,
      say: 'she exports what is left before erasing it',
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
        ];
      },
    });
    await w.step({
      who: relucia,
      say: 'requests erasure: she ticks the finality box and reads the archive-custody notice',
      method: 'POST',
      path: '/v2/community/erasure',
      json: {
        confirmFinality: true,
        currentDerivedKey: await deriveKey(
          ctx,
          relucia,
          luciaAcct.username,
          luciaAcct.password!,
          lab.slug
        ),
      },
      expect: [200, 201, 202],
      covers: ['V05'],
      show: (r) => [
        field('notice', dig(r, 'data', 'finalityNotice')),
        field(
          'request',
          dig(r, 'data', 'request', 'kind') +
            ' ' +
            dig(r, 'data', 'request', 'state')
        ),
      ],
    });
    const sam = s.actors.sam!;
    await w.step({
      who: sam,
      say: 'Sam sees the erasure in the erasure records',
      method: 'GET',
      path: '/v2/admin/erasures',
      expect: 200,
      covers: ['V14'],
      show: (r) => [
        field('records', ((dig(r, 'data') as unknown[]) ?? []).length),
        'content-free: ids, dates and outcome only',
      ],
    });
    await w.step({
      who: sam,
      say: 'sees the lab community as disabled in the communities list',
      method: 'GET',
      path: `/v2/admin/communities?limit=100&offset=${await offsetOfMatch(
        sam,
        '/v2/admin/communities',
        (r) => (dig(r, 'data') as Array<{ slug: string }>) ?? [],
        (c) => c.slug === lab.slug
      )}`,
      expect: 200,
      covers: ['S04'],
      check: (r) => {
        const row = (
          (dig(r, 'data') as Array<{ slug: string; status: string }>) ?? []
        ).find((c) => c.slug === lab.slug);
        return row?.status === 'disabled'
          ? undefined
          : 'expected the lab community to be disabled';
      },
    });
    void val;
    void num;
    void newVerifier;
    void randomPassword;
  });
}
