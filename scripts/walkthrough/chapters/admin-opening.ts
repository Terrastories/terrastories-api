/**
 * Chapter: Ana, the community admin, opens the community and sets up the
 * people. She never changes her own password or profile: she is the real
 * account of the community being visited. Everyone she creates is prefixed
 * with the run id.
 */
import {
  guarded,
  signIn,
  deriveKey,
  field,
  num,
  str,
  val,
  type Ctx,
  type Account,
} from '../context.js';
import type { Reply } from '../client.js';
import { dig } from '../walk.js';

export const PERSONA_ADMIN = 'Community admin';

export function defineAccounts(ctx: Ctx): void {
  const { w, s } = ctx;
  const mk = (key: string, displayName: string, role: string): void => {
    s.accounts[key] = {
      key,
      displayName: `${displayName} (${w.runId})`,
      username: `${w.runId}-${key}`,
      email: `${w.runId}-${key}@walkthrough.example.test`,
      role,
    } satisfies Account;
  };
  mk('vera', 'Vera', 'viewer');
  mk('mateo', 'Mateo', 'member');
  mk('elena', 'Elena', 'editor');
  mk('samir', 'Samir', 'member');
  mk('adrian', 'Adrian', 'admin');
  mk('zed', 'Zed', 'viewer');
}

export async function adminOpening(ctx: Ctx): Promise<void> {
  const { w, s, cfg } = ctx;
  w.chapter(
    PERSONA_ADMIN,
    'Ana opens the community and invites the team',
    `Ana already runs the community "${cfg.community}". Everything she creates is prefixed "${w.runId}". Nobody is created by a database write: every account below comes from the admin user screen and a one-time login code.`
  );
  await guarded(ctx, 'admin-opening', async () => {
    if (!cfg.adminIdentifier || !cfg.adminPassword)
      throw new Error('no community admin credentials were supplied');
    const ana = (s.actors.ana = w.actor('Ana', 'community admin'));
    const { upgraded } = await signIn(
      ctx,
      ana,
      cfg.adminIdentifier,
      cfg.adminPassword,
      {
        communitySlug: cfg.community,
      }
    );
    if (upgraded) {
      await w.step({
        who: ana,
        say: 'checks that the migrated account now uses Argon2id (the next prelogin answers with the new algorithm)',
        method: 'POST',
        path: '/v2/auth/prelogin',
        json: { identifier: cfg.adminIdentifier, communitySlug: cfg.community },
        noCookie: true,
        expect: 200,
        covers: ['A05'],
        check: (r) =>
          String(val(r, 'algorithm')).includes('argon2')
            ? undefined
            : 'the account was not upgraded to Argon2id',
        show: (r) => field('algorithm', val(r, 'algorithm')),
      });
    } else {
      w.narrate(
        'This account was already upgraded to Argon2id on an earlier login, so there is no bcrypt step to show.'
      );
    }

    const me = await w.step({
      who: ana,
      say: 'lands on the dashboard; the top bar reads her own profile',
      method: 'GET',
      path: '/v2/auth/me',
      expect: 200,
      covers: ['B01', 'B08', 'M12'],
      show: (r) => [
        field(
          'Hello',
          val(r, 'user', 'displayName') ?? val(r, 'user', 'username')
        ),
        field('role badge', val(r, 'user', 'role')),
        field('recovery codes saved', val(r, 'user', 'recoveryCodesConfirmed')),
        'admin-only link: "Member dashboard" and the Users / Map settings / Import entries are visible',
      ],
    });

    if (val(me, 'user', 'recoveryCodesConfirmed') !== true) {
      await w.step({
        who: ana,
        say: 'tries to open the community; the API sends her to the recovery-codes screen first',
        method: 'GET',
        path: '/v2/community',
        expect: 403,
        negative: true,
        covers: ['V08'],
        check: (r) =>
          val(r, 'code') === 'recovery_codes_required'
            ? undefined
            : 'expected the recovery_codes_required gate',
        show: 'the whole app routes the admin to "save your recovery codes"',
      });
      const key = await deriveKey(
        ctx,
        ana,
        cfg.adminIdentifier,
        cfg.adminPassword,
        cfg.community
      );
      const codes = await w.step({
        who: ana,
        say: 'generates her recovery codes (password step-up); the ten codes are shown once',
        method: 'POST',
        path: '/v2/auth/recovery-codes',
        json: { currentDerivedKey: key },
        expect: 201,
        covers: ['V07'],
        show: (r) => {
          const list = val(r, 'data', 'codes');
          if (Array.isArray(list)) for (const c of list) w.secret(String(c));
          return [
            `${Array.isArray(list) ? list.length : 0} single-use codes, print or copy sheet (values hidden here)`,
          ];
        },
      });
      void codes;
    } else {
      w.narrate(
        'Ana already holds recovery codes, so the walkthrough does not regenerate them (that would invalidate her real sheet). The recovery-code screens are walked with Adrian, a second admin created below.'
      );
    }

    const community = await w.step({
      who: ana,
      say: 'opens her community page',
      method: 'GET',
      path: '/v2/community',
      expect: 200,
      covers: ['M01'],
      show: (r) => [
        field('name', val(r, 'data', 'name')),
        field('slug', val(r, 'data', 'slug')),
        field('visibility', val(r, 'data', 'visibility')),
        field('stories', val(r, 'data', 'storiesCount')),
      ],
    });
    const mapCfg = await w.step({
      who: ana,
      say: 'reads the current map settings (saved so they can be restored at the end)',
      method: 'GET',
      path: '/v2/community/map-config',
      expect: 200,
      covers: ['M02', 'D06'],
      show: (r) => [
        field('map style', dig(r, 'render', 'source')),
        field(
          'centre',
          `${dig(r, 'data', 'centerLatitude') ?? '-'}, ${dig(r, 'data', 'centerLongitude') ?? '-'}`
        ),
      ],
    });
    s.snapshot = {
      description:
        (val(community, 'data', 'description') as string | null) ?? null,
      visibility: str(community, 'data', 'visibility'),
      mapConfig:
        (val(mapCfg, 'data') as Record<string, unknown> | null) ?? null,
    };

    const list = await w.step({
      who: ana,
      say: 'opens the Users list (first page)',
      method: 'GET',
      path: '/v2/users?limit=5&offset=0',
      expect: 200,
      covers: ['D01'],
      check: (r) => {
        const text = JSON.stringify(r.json);
        return /passwordVerifier|passwordSalt|derivedKey/.test(text)
          ? 'the user list leaked credential fields'
          : undefined;
      },
      show: (r) => {
        const rows = (val(r, 'data') as Array<Record<string, unknown>>) ?? [];
        return [
          field('total users', dig(r, 'meta', 'total')),
          ...rows
            .slice(0, 3)
            .map(
              (u) =>
                `card: ${u.displayName ?? u.username} - role ${u.role} - ${u.status}`
            ),
          field('next page', dig(r, 'meta', 'hasNextPage')),
        ];
      },
    });
    void list;

    for (const key of ['vera', 'mateo', 'elena', 'samir', 'adrian', 'zed']) {
      const acct = s.accounts[key]!;
      const created = await w.step({
        who: ana,
        say: `fills the "New user" form for ${acct.displayName} (role ${acct.role}); no password is asked, the user sets it later`,
        method: 'POST',
        path: '/v2/users',
        json: {
          username: acct.username,
          email: acct.email,
          displayName: acct.displayName,
          role: acct.role,
        },
        expect: 201,
        covers: ['D02'],
        show: (r) => [
          field('username', val(r, 'data', 'username')),
          field('role badge', val(r, 'data', 'role')),
          field('status', val(r, 'data', 'status')),
        ],
      });
      acct.id = num(created, 'data', 'id');
      s.ids[key] = acct.id;
      const issued = await w.step({
        who: ana,
        say: `issues a one-time login code for ${acct.displayName}; it is shown once and valid at most 72 hours`,
        method: 'POST',
        path: `/v2/users/${acct.id}/login-codes`,
        expect: 201,
        covers: ['V10', 'D02'],
        show: (r) => [
          'a code box with copy button appears (value hidden here)',
          field('expires', val(r, 'data', 'expiresAt')),
        ],
      });
      acct.loginCode = str(issued, 'data', 'code');
      w.secret(acct.loginCode);
    }

    const vera = s.accounts.vera!;
    await w.step({
      who: ana,
      say: `opens ${vera.displayName}'s user page`,
      method: 'GET',
      path: `/v2/users/${vera.id}`,
      expect: 200,
      covers: ['D03'],
      check: (r) =>
        /passwordVerifier|passwordSalt|derivedKey|passwordHash/.test(
          JSON.stringify(r.json)
        )
          ? 'the user page leaked credential fields'
          : undefined,
      show: (r) => [
        field('username', val(r, 'data', 'username')),
        field('email', val(r, 'data', 'email')),
        field('role badge', val(r, 'data', 'role')),
        'Edit button; no Delete button (D12: admins disable users instead)',
      ],
    });
    await w.step({
      who: ana,
      say: 'tries to create a user with the same username again',
      method: 'POST',
      path: '/v2/users',
      json: {
        username: vera.username,
        email: `other-${vera.email}`,
        role: 'viewer',
      },
      expect: 409,
      negative: true,
      covers: ['D02'],
      show: 'the form shows "username already taken"',
    });
    await w.step({
      who: ana,
      say: 'tries to create a super_admin from the user form',
      method: 'POST',
      path: '/v2/users',
      json: {
        username: `${w.runId}-nope`,
        email: `${w.runId}-nope@walkthrough.example.test`,
        role: 'super_admin',
      },
      expect: 400,
      negative: true,
      covers: ['D02'],
      show: 'the role picker never offers super_admin',
    });
  });
}

export type { Reply };
